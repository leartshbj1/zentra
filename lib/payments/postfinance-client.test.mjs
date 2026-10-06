import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  PostFinanceCheckoutClient,
  CheckoutUnavailable,
  bearerToken,
  verifyWebhookSignature,
  acceptWebhook,
  derToP1363,
} from './postfinance-client.ts';

const fixture = JSON.parse(
  await readFile(
    new URL('./postfinance-fixtures.json', import.meta.url),
    'utf8',
  ),
);
const encoded = new TextEncoder();
const bytes = encoded.encode(fixture.body);
const header = `algorithm=SHA256withECDSA, keyId=${fixture.keyId}, signature=${fixture.signatureDerBase64}`;
const resolveFixture = async () => fixture.publicKeySpkiBase64;
const fixedNow = Date.parse('2026-10-06T12:00:00Z');

// Test-only in-memory implementation. Production requires atomic durable storage.
class TestLedger {
  rows = new Map();
  async claim(scope, fingerprint) {
    const row = this.rows.get(scope);
    if (row && row.fingerprint !== fingerprint) return { kind: 'conflict' };
    if (row?.json !== undefined) return { kind: 'completed', json: row.json };
    if (row) return { kind: 'uncertain' };
    this.rows.set(scope, { fingerprint });
    return { kind: 'claimed' };
  }
  async complete(scope, json) {
    this.rows.get(scope).json = json;
  }
  async markUncertain(scope) {
    this.rows.get(scope).uncertain = true;
  }
}

function configuration(extra = {}) {
  return {
    enabled: true,
    applicationUserId: '512',
    spaceId: 405,
    authenticationKeyBase64: Buffer.alloc(32, 7).toString('base64'),
    returnOrigin: 'https://zentraapp.ch',
    merchantApproved: true,
    subscriptionFeatureEnabled: true,
    chargeFlowEnabled: true,
    postfinancePayTokenEnabled: true,
    twintUserOnFileEnabled: true,
    products: {
      gestion: {
        productId: 2,
        currency: 'CHF',
        billingPeriod: 'P1M',
        priceChfMinor: 5000,
        methods: ['postfinance_pay', 'twint'],
      },
    },
    ...extra,
  };
}

function fixtureClient(
  config = configuration(),
  ledger = new TestLedger(),
  handler,
) {
  const requests = [];
  const fetcher = async (url, init) => {
    requests.push({ url, ...init });
    if (handler) return handler(url, init);
    if (url.endsWith('/payment-page-url'))
      return new Response(
        'https://checkout.postfinance.ch/s/405/payment-page/123',
      );
    const path = new URL(url).pathname;
    if (init.method === 'GET' && path === '/api/v2.0/payment/transactions/123')
      return Response.json({
        id: 123,
        linkedSpaceId: config.spaceId,
        state: 'FULFILL',
      });
    if (
      init.method === 'GET' &&
      path === '/api/v2.0/payment/transactions/invoices/41'
    )
      return Response.json({
        id: 41,
        linkedSpaceId: config.spaceId,
        linkedTransaction: 123,
        state: 'PAID',
      });
    const body = url.endsWith('/initialize-subscriber-present')
      ? { transaction: { id: 123 } }
      : url.endsWith('/subscribers')
        ? { id: 11 }
        : init.method === 'POST'
          ? { id: 99, subscription: { id: 71 }, billingCurrency: 'CHF' }
          : { id: 71, state: 'ACTIVE' };
    return Response.json(body);
  };
  return {
    requests,
    client: new PostFinanceCheckoutClient(config, {
      ledger,
      fetch: fetcher,
      now: () => fixedNow,
    }),
  };
}

const createInput = {
  productKey: 'gestion',
  subscriberId: 11,
  reference: 'zentra-order-1',
  version: 1,
};

test('validates the independent official SDK DER fixture and rejects changed raw bytes', async () => {
  await verifyWebhookSignature(bytes, header, resolveFixture);
  await assert.rejects(
    verifyWebhookSignature(
      encoded.encode(fixture.body.replace('"entityId":11', '"entityId":12')),
      header,
      resolveFixture,
    ),
    /Invalid webhook signature/,
  );
  await assert.rejects(
    verifyWebhookSignature(
      encoded.encode(`${fixture.body}\n`),
      header,
      resolveFixture,
    ),
    /Invalid webhook signature/,
  );
});

test('verifies P1363 signatures generated independently by WebCrypto', async () => {
  const keys = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const publicKey = Buffer.from(
    await crypto.subtle.exportKey('spki', keys.publicKey),
  ).toString('base64');
  const signature = Buffer.from(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      keys.privateKey,
      bytes,
    ),
  ).toString('base64');
  await verifyWebhookSignature(
    bytes,
    `algorithm=SHA256withECDSA, keyId=p1363-key, signature=${signature}`,
    async () => publicKey,
  );
});

test('rejects unsupported algorithms, malformed DER, and trailing DER bytes', async () => {
  let resolutions = 0;
  await assert.rejects(
    verifyWebhookSignature(
      bytes,
      header.replace('SHA256withECDSA', 'none'),
      async () => {
        resolutions++;
        return fixture.publicKeySpkiBase64;
      },
    ),
    /unsupported/,
  );
  assert.equal(resolutions, 0);
  assert.equal(
    derToP1363(
      new Uint8Array(Buffer.from(fixture.signatureDerBase64, 'base64')),
    ).length,
    64,
  );
  assert.throws(
    () => derToP1363(new Uint8Array([0x30, 6, 2, 1, 0x80, 2, 1, 1])),
    /Negative/,
  );
  const original = Buffer.from(fixture.signatureDerBase64, 'base64');
  assert.throws(
    () =>
      derToP1363(new Uint8Array(Buffer.concat([original, Buffer.from([0])]))),
    /Invalid/,
  );
});

test('durable inbox scope suppresses replay and rejects the wrong space/listener', async () => {
  const rows = new Map();
  let workCount = 0;
  const options = {
    keyResolver: resolveFixture,
    apiOrigin: 'https://checkout.postfinance.ch',
    spaceId: 1,
    allowedListenerIds: [2],
    now: () => Date.parse('2023-12-19T13:43:35+0000'),
    inbox: {
      async acceptOnce(scope, event) {
        if (rows.has(scope)) return false;
        rows.set(scope, event);
        workCount++;
        return true;
      },
    },
  };
  assert.equal((await acceptWebhook(bytes, header, options)).duplicate, false);
  assert.equal((await acceptWebhook(bytes, header, options)).duplicate, true);
  assert.equal(workCount, 1);
  await assert.rejects(
    acceptWebhook(bytes, header, { ...options, spaceId: 405 }),
    /another configured/,
  );
  await assert.rejects(
    acceptWebhook(bytes, header, { ...options, allowedListenerIds: [99] }),
    /another configured/,
  );
  assert.equal(workCount, 1);
  await assert.rejects(
    acceptWebhook(bytes, header, {
      ...options,
      now: () => fixedNow,
      maxEventAgeMs: 86_400_000,
    }),
    /event-age/,
  );
});

test('produces the official JWT header and binds method/path using independent HMAC', async () => {
  const config = configuration();
  const token = await bearerToken(
    config.applicationUserId,
    config.authenticationKeyBase64,
    'GET',
    '/api/v2.0/subscriptions/71',
    1791288000,
  );
  const [h, p, s] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), {
    alg: 'HS256',
    typ: 'JWT',
    ver: 1,
  });
  assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url')), {
    sub: '512',
    iat: 1791288000,
    requestPath: '/api/v2.0/subscriptions/71',
    requestMethod: 'GET',
  });
  assert.equal(
    createHmac('sha256', Buffer.from(config.authenticationKeyBase64, 'base64'))
      .update(`${h}.${p}`)
      .digest('base64url'),
    s,
  );
});

test('uses exact API v2 paths, Space header, scalar relations and the returned transaction ID', async () => {
  const { client, requests } = fixtureClient();
  await client.createSubscriber(
    {
      externalId: 'customer-1',
      reference: 'customer-1',
      emailAddress: 'fixture@example.invalid',
      language: 'fr-CH',
    },
    'postfinance_pay',
  );
  const created = await client.createSubscription(
    createInput,
    'postfinance_pay',
    'purchase-1',
  );
  assert.equal(created.subscription.id, 71); // created.id=99 is a VERSION ID.
  const initialized = await client.initializeSubscriberPresent(
    created.subscription.id,
    'postfinance_pay',
    {
      successUrl: 'https://zentraapp.ch/compte',
      failureUrl: 'https://zentraapp.ch/tarifs',
    },
    'purchase-1',
  );
  await client.readSubscription(71);
  await client.paymentPageUrl(initialized.transaction.id);
  assert.deepEqual(
    requests.map((r) => new URL(r.url).pathname),
    [
      '/api/v2.0/subscriptions/subscribers',
      '/api/v2.0/subscriptions',
      '/api/v2.0/subscriptions/71/initialize-subscriber-present',
      '/api/v2.0/subscriptions/71',
      '/api/v2.0/payment/transactions/123/payment-page-url',
    ],
  );
  assert.deepEqual(JSON.parse(requests[1].body), {
    product: 2,
    currency: 'CHF',
    subscription: { subscriber: 11, reference: 'zentra-order-1', version: 1 },
  });
  for (const request of requests) {
    assert.equal(request.headers.Space, '405');
    assert.equal(new URL(request.url).search, '');
    assert.equal(request.headers['Idempotency-Key'], undefined);
    assert.equal(request.redirect, 'error');
    const token = request.headers.Authorization.slice(7).split('.');
    const claims = JSON.parse(Buffer.from(token[1], 'base64url'));
    assert.equal(claims.requestPath, new URL(request.url).pathname);
    assert.equal(claims.requestMethod, request.method);
  }
});

test('idempotence reuses a persisted result, rejects a changed body, and isolates spaces', async () => {
  const ledger = new TestLedger();
  const first = fixtureClient(configuration(), ledger);
  await first.client.createSubscription(
    createInput,
    'postfinance_pay',
    'purchase-1',
  );
  await first.client.createSubscription(
    createInput,
    'postfinance_pay',
    'purchase-1',
  );
  assert.equal(first.requests.length, 1);
  await assert.rejects(
    first.client.createSubscription(
      { ...createInput, subscriberId: 12 },
      'postfinance_pay',
      'purchase-1',
    ),
    /different request body/,
  );
  assert.equal(first.requests.length, 1);
  const second = fixtureClient(configuration({ spaceId: 406 }), ledger);
  await second.client.createSubscription(
    createInput,
    'postfinance_pay',
    'purchase-1',
  );
  assert.equal(second.requests.length, 1);
});

test('a journal failure after a provider success cannot trigger a second creation', async () => {
  const ledger = new TestLedger();
  ledger.complete = async () => {
    throw new Error('database completion unavailable');
  };
  const { client, requests } = fixtureClient(configuration(), ledger);
  await assert.rejects(
    client.createSubscription(
      createInput,
      'postfinance_pay',
      'journal-failure',
    ),
    /completion unavailable/,
  );
  await assert.rejects(
    client.createSubscription(
      createInput,
      'postfinance_pay',
      'journal-failure',
    ),
    /Reconcile/,
  );
  assert.equal(requests.length, 1);
});

test('resolves the authenticated webhook key using the exact non-space-scoped SDK endpoint', async () => {
  const { client, requests } = fixtureClient(
    configuration(),
    new TestLedger(),
    async () => Response.json(fixture.publicKeySpkiBase64),
  );
  await verifyWebhookSignature(bytes, header, (keyId) =>
    client.webhookPublicKey(keyId),
  );
  assert.equal(
    new URL(requests[0].url).pathname,
    `/api/v2.0/webhooks/encryption-keys/${fixture.keyId}`,
  );
  assert.equal(requests[0].headers.Space, undefined);
  assert.match(requests[0].headers.Authorization, /^Bearer /);
});

test('a timed-out or concurrent mutation cannot produce an automatic second charge', async () => {
  let release;
  const { client, requests } = fixtureClient(
    configuration(),
    new TestLedger(),
    async () =>
      new Promise((resolve) => {
        release = () => resolve(Response.json({ subscription: { id: 71 } }));
      }),
  );
  const first = client.createSubscription(
    createInput,
    'postfinance_pay',
    'concurrent-1',
  );
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    client.createSubscription(createInput, 'postfinance_pay', 'concurrent-1'),
    /Reconcile/,
  );
  release();
  await first;
  assert.equal(requests.length, 1);
  const failed = fixtureClient(configuration(), new TestLedger(), async () => {
    throw new Error('network timeout');
  });
  await assert.rejects(
    failed.client.createSubscription(
      createInput,
      'postfinance_pay',
      'timeout-1',
    ),
    /network timeout/,
  );
  await assert.rejects(
    failed.client.createSubscription(
      createInput,
      'postfinance_pay',
      'timeout-1',
    ),
    /Reconcile/,
  );
  assert.equal(failed.requests.length, 1);
});

test('missing credentials, ledger, merchant approval, or recurring options cause zero API calls', async () => {
  for (const change of [
    { enabled: false },
    { authenticationKeyBase64: undefined },
    { merchantApproved: false },
    { subscriptionFeatureEnabled: false },
    { chargeFlowEnabled: false },
    { postfinancePayTokenEnabled: false },
  ]) {
    const { client, requests } = fixtureClient(configuration(change));
    await assert.rejects(
      client.createSubscription(createInput, 'postfinance_pay', 'blocked-1'),
      CheckoutUnavailable,
    );
    assert.equal(requests.length, 0);
  }
  let called = false;
  const noLedger = new PostFinanceCheckoutClient(configuration(), {
    fetch: async () => {
      called = true;
      return Response.json({});
    },
  });
  await assert.rejects(
    noLedger.createSubscription(createInput, 'postfinance_pay', 'blocked-1'),
    CheckoutUnavailable,
  );
  assert.equal(called, false);
  const onlyPf = fixtureClient(
    configuration({ twintUserOnFileEnabled: false }),
  );
  await onlyPf.client.createSubscription(
    createInput,
    'postfinance_pay',
    'pf-1',
  );
  await assert.rejects(
    onlyPf.client.createSubscription(createInput, 'twint', 'twint-1'),
    CheckoutUnavailable,
  );
  assert.equal(onlyPf.requests.length, 1);
});

test('rejects non-monthly/non-CHF products, unsafe returns, and external payment pages', async () => {
  for (const product of [
    { currency: 'USD' },
    { billingPeriod: 'P1Y' },
    { priceChfMinor: 0 },
    { methods: ['twint'] },
  ]) {
    const config = configuration();
    Object.assign(config.products.gestion, product);
    const { client, requests } = fixtureClient(config);
    await assert.rejects(
      client.createSubscription(
        createInput,
        'postfinance_pay',
        'invalid-product',
      ),
      CheckoutUnavailable,
    );
    assert.equal(requests.length, 0);
  }
  const { client, requests } = fixtureClient();
  await assert.rejects(
    client.initializeSubscriberPresent(
      71,
      'postfinance_pay',
      {
        successUrl: 'https://attacker.invalid',
        failureUrl: 'https://zentraapp.ch/tarifs',
      },
      'bad-return',
    ),
    /return URL/,
  );
  assert.equal(requests.length, 0);
  const external = fixtureClient(
    configuration(),
    new TestLedger(),
    async () => new Response('https://attacker.invalid/pay'),
  );
  await assert.rejects(
    external.client.paymentPageUrl(123),
    /Unapproved payment-page/,
  );
});

test('bounds key responses in bytes during streaming, cancels overflow, and never consumes declared oversized bodies', async () => {
  let pulled = 0,
    cancelled = false;
  const streamed = fixtureClient(
    configuration(),
    new TestLedger(),
    async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            pulled++;
            controller.enqueue(encoded.encode('é'.repeat(600)));
            if (pulled === 20) controller.close();
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  await assert.rejects(
    streamed.client.webhookPublicKey('bounded-key'),
    /Oversized/,
  );
  assert.equal(cancelled, true);
  assert.ok(pulled < 20);
  let bodyCancelled = false;
  const declared = fixtureClient(
    configuration(),
    new TestLedger(),
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            bodyCancelled = true;
          },
        }),
        { headers: { 'Content-Length': '4097' } },
      ),
  );
  await assert.rejects(
    declared.client.webhookPublicKey('bounded-key'),
    /Oversized/,
  );
  assert.equal(bodyCancelled, true);
});

function prepaidConfiguration(extra = {}) {
  return configuration({
    prepaidFeatureEnabled: true,
    prepaidEnvironment: 'TEST',
    subscriptionFeatureEnabled: false, // Charge Flow does not use native Subscriptions.
    prepaidProducts: {
      gestion: {
        currency: 'CHF',
        billingPeriod: 'P1M',
        priceChfMinor: 4900,
        reference: 'gestion-solo-v1',
        name: 'Zentra Gestion Solo',
        methodConfigurations: { postfinance_pay: 91 },
      },
    },
    ...extra,
  });
}
const prepaidInput = {
  productKey: 'gestion',
  periodId: 'period-1',
  customerReference: 'payer-1',
  emailAddress: 'fixture@example.invalid',
  urls: {
    successUrl: 'https://zentraapp.ch/compte',
    failureUrl: 'https://zentraapp.ch/pricing',
  },
};

test('initial prepaid order uses the frozen CHF price, approved method and token creation without a native subscription', async () => {
  const { client, requests } = fixtureClient(prepaidConfiguration());
  await client.createPrepaidTransaction(
    prepaidInput,
    'postfinance_pay',
    'create-period-1',
  );
  const body = JSON.parse(requests[0].body);
  assert.equal(
    new URL(requests[0].url).pathname,
    '/api/v2.0/payment/transactions',
  );
  assert.equal(body.currency, 'CHF');
  assert.equal(body.environment, undefined);
  assert.equal(body.environmentSelectionStrategy, 'FORCE_TEST_ENVIRONMENT');
  assert.equal(body.lineItems[0].amountIncludingTax, 49);
  assert.equal(body.lineItems[0].uniqueId, 'period-1');
  assert.equal(body.lineItems[0].sku, 'gestion-solo-v1');
  assert.equal(body.merchantReference, 'period-1');
  assert.equal(body.invoiceMerchantReference, 'period-1');
  assert.equal(body.metaData.zentra_period_id, 'period-1');
  assert.deepEqual(body.allowedPaymentMethodConfigurations, [91]);
  assert.equal(body.tokenizationMode, 'FORCE_CREATION');
  assert.equal(body.customersPresence, 'VIRTUAL_PRESENT');
  assert.equal(body.autoConfirmationEnabled, false);
  assert.equal(body.completionBehavior, 'COMPLETE_IMMEDIATELY');
  assert.equal(body.failedUrl, prepaidInput.urls.failureUrl);
  assert.equal(body.token, undefined);
  assert.equal(body.product, undefined);
  assert.equal(body.externalId, undefined);
});

test('renewal reuses its token and sends the bodyless Charge Flow operation once, without confirm', async () => {
  const { client, requests } = fixtureClient(prepaidConfiguration());
  await client.createPrepaidTransaction(
    { ...prepaidInput, periodId: 'period-2', tokenId: 52 },
    'postfinance_pay',
    'create-period-2',
  );
  const body = JSON.parse(requests[0].body);
  assert.equal(body.token, 52);
  assert.equal(body.customersPresence, 'NOT_PRESENT');
  assert.equal(body.tokenizationMode, undefined);
  await client.applyPrepaidChargeFlow(
    123,
    'postfinance_pay',
    'charge-period-2',
  );
  await client.applyPrepaidChargeFlow(
    123,
    'postfinance_pay',
    'charge-period-2',
  );
  assert.equal(requests.length, 2);
  assert.equal(requests[1].body, undefined);
  assert.equal(requests[1].headers['Content-Type'], undefined);
  assert.equal(
    new URL(requests[1].url).pathname,
    '/api/v2.0/payment/transactions/123/charge-flow/apply',
  );
  assert.equal(
    requests.some((request) => request.url.endsWith('/confirm')),
    false,
  );
});

test('production uses the explicit production selection strategy rather than a charge-attempt enum', async () => {
  const { client, requests } = fixtureClient(
    prepaidConfiguration({ prepaidEnvironment: 'PRODUCTION' }),
  );
  await client.createPrepaidTransaction(
    prepaidInput,
    'postfinance_pay',
    'production-period-1',
  );
  const body = JSON.parse(requests[0].body);
  assert.equal(
    body.environmentSelectionStrategy,
    'FORCE_PRODUCTION_ENVIRONMENT',
  );
  assert.equal(body.environment, undefined);
});

test('prepaid operations preserve optimistic versions and exact read/cancel contracts', async () => {
  const { client, requests } = fixtureClient(prepaidConfiguration());
  await client.confirmPrepaidTransaction(
    123,
    7,
    'postfinance_pay',
    'confirm-period-1',
  );
  await client.confirmPrepaidTransaction(
    123,
    7,
    'postfinance_pay',
    'confirm-period-1',
  );
  assert.deepEqual(JSON.parse(requests[0].body), { version: 7 });
  await client.readTransaction(123);
  await client.readTransactionInvoice(41);
  await client.readToken(52);
  await client.readActiveTokenVersion(52);
  await client.cancelPrepaidChargeFlow(
    123,
    'postfinance_pay',
    'cancel-period-1',
  );
  assert.deepEqual(
    requests.map((request) => new URL(request.url).pathname),
    [
      '/api/v2.0/payment/transactions/123/confirm',
      '/api/v2.0/payment/transactions/123',
      '/api/v2.0/payment/transactions/invoices/41',
      '/api/v2.0/payment/tokens/52',
      '/api/v2.0/payment/tokens/52/active-version',
      '/api/v2.0/payment/transactions/123/charge-flow/cancel',
    ],
  );
  assert.equal(requests.at(-1).body, undefined);
  for (const request of requests) {
    assert.equal(request.headers.Space, '405');
    const claims = JSON.parse(
      Buffer.from(
        request.headers.Authorization.slice(7).split('.')[1],
        'base64url',
      ),
    );
    assert.equal(
      claims.requestPath,
      new URL(request.url).pathname + new URL(request.url).search,
    );
    assert.equal(claims.requestMethod, request.method);
  }
});

test('prepaid catalogue, merchant and return errors cause no provider operation', async () => {
  for (const change of [
    { prepaidFeatureEnabled: false },
    { prepaidEnvironment: undefined },
    { merchantApproved: false },
    { chargeFlowEnabled: false },
    { postfinancePayTokenEnabled: false },
    { enabled: false },
  ]) {
    const { client, requests } = fixtureClient(prepaidConfiguration(change));
    await assert.rejects(
      client.createPrepaidTransaction(
        prepaidInput,
        'postfinance_pay',
        'blocked-period',
      ),
      CheckoutUnavailable,
    );
    assert.equal(requests.length, 0);
  }
  const { client, requests } = fixtureClient(prepaidConfiguration());
  await assert.rejects(
    client.createPrepaidTransaction(
      {
        ...prepaidInput,
        urls: { ...prepaidInput.urls, successUrl: 'https://attacker.invalid' },
      },
      'postfinance_pay',
      'bad-return',
    ),
    /return URL/,
  );
  await assert.rejects(
    client.createPrepaidTransaction(
      { ...prepaidInput, tokenId: 0 },
      'postfinance_pay',
      'bad-token',
    ),
    /token ID/,
  );
  await assert.rejects(
    client.createPrepaidTransaction(
      { ...prepaidInput, productKey: 'other' },
      'postfinance_pay',
      'bad-price',
    ),
    CheckoutUnavailable,
  );
  assert.equal(requests.length, 0);
});

test('a lost renewal response cannot send a second financial POST', async () => {
  const { client, requests } = fixtureClient(
    prepaidConfiguration(),
    new TestLedger(),
    async () => {
      throw new Error('network timeout');
    },
  );
  await assert.rejects(
    client.applyPrepaidChargeFlow(123, 'postfinance_pay', 'uncertain-period-2'),
    /network timeout/,
  );
  await assert.rejects(
    client.applyPrepaidChargeFlow(123, 'postfinance_pay', 'uncertain-period-2'),
    /Reconcile/,
  );
  assert.equal(requests.length, 1);
});

const invoiceFixture = (extra = {}) => ({
  id: 41,
  linkedSpaceId: 405,
  linkedTransaction: 123,
  state: 'PAID',
  amount: 49,
  outstandingAmount: 0,
  environment: 'LIVE',
  ...extra,
});
const refundFixture = (refundId, extra = {}) => ({
  id: refundId,
  linkedSpaceId: 405,
  transaction: { id: 123, linkedSpaceId: 405 },
  state: 'SUCCESSFUL',
  amount: 1,
  environment: 'LIVE',
  type: 'CUSTOMER_INITIATED_AUTOMATIC',
  ...extra,
});
const searchResponse = (data, offset = 0, hasMore = false, extra = {}) =>
  Response.json({ data, offset, hasMore, limit: 10, ...extra });

test('discovers the unique invoice by linkedTransaction, re-reads its own ID and signs the exact encoded query', async () => {
  const config = configuration();
  const { client, requests } = fixtureClient(
    config,
    new TestLedger(),
    async (url) =>
      new URL(url).pathname.endsWith('/search')
        ? searchResponse([invoiceFixture()])
        : Response.json(invoiceFixture()),
  );
  const invoice = await client.findTransactionInvoice(123);
  assert.deepEqual(invoice, invoiceFixture());
  assert.deepEqual(
    requests.map((request) => new URL(request.url).pathname),
    [
      '/api/v2.0/payment/transactions/invoices/search',
      '/api/v2.0/payment/transactions/invoices/41',
      '/api/v2.0/payment/transactions/invoices/search',
    ],
  );
  const expectedPath =
    '/api/v2.0/payment/transactions/invoices/search?limit=10&offset=0&order=id%3AASC&query=linkedTransaction%3A123';
  assert.equal(
    requests[0].url,
    'https://checkout.postfinance.ch' + expectedPath,
  );
  for (const request of requests) {
    assert.equal(request.method, 'GET');
    assert.equal(request.body, undefined);
    assert.equal(request.headers.Space, '405');
    const [h, p, signature] = request.headers.Authorization.slice(7).split('.');
    const claims = JSON.parse(Buffer.from(p, 'base64url'));
    assert.equal(claims.requestMethod, 'GET');
    assert.equal(
      claims.requestPath,
      new URL(request.url).pathname + new URL(request.url).search,
    );
    assert.equal(
      signature,
      createHmac(
        'sha256',
        Buffer.from(config.authenticationKeyBase64, 'base64'),
      )
        .update(`${h}.${p}`)
        .digest('base64url'),
    );
  }
  const [h, p, signature] =
    requests[0].headers.Authorization.slice(7).split('.');
  const changed = JSON.parse(Buffer.from(p, 'base64url'));
  changed.requestPath = expectedPath.replace('123', '124');
  const changedPayload = Buffer.from(JSON.stringify(changed)).toString(
    'base64url',
  );
  assert.notEqual(
    signature,
    createHmac('sha256', Buffer.from(config.authenticationKeyBase64, 'base64'))
      .update(`${h}.${changedPayload}`)
      .digest('base64url'),
  );
});

test('invoice absence returns null and multiple invoices never select the first', async () => {
  const absent = fixtureClient(configuration(), new TestLedger(), async () =>
    searchResponse([]),
  );
  assert.equal(await absent.client.findTransactionInvoice(123), null);
  assert.equal(absent.requests.length, 1);
  const ambiguous = fixtureClient(configuration(), new TestLedger(), async () =>
    searchResponse([invoiceFixture(), invoiceFixture({ id: 42 })]),
  );
  await assert.rejects(
    ambiguous.client.findTransactionInvoice(123),
    /Ambiguous/,
  );
  assert.equal(ambiguous.requests.length, 1);
});

test('transaction and invoice reads enforce their own ID/Space and retain raw financial fields', async () => {
  const transaction = {
    id: 123,
    linkedSpaceId: 405,
    state: 'FUTURE_PROVIDER_STATE',
    authorizationEnvironment: 'TEST',
    completedAmount: 49,
    totalSettledAmount: 0,
    refundedAmount: 0,
    paymentConnectorConfiguration: {
      id: 81,
      linkedSpaceId: 405,
      paymentMethodConfiguration: { id: 91, linkedSpaceId: 405 },
    },
  };
  const accepted = fixtureClient(configuration(), new TestLedger(), async () =>
    Response.json(transaction),
  );
  assert.deepEqual(await accepted.client.readTransaction(123), transaction);
  assert.equal(
    new URL(accepted.requests[0].url).search,
    '?expand=token%2CpaymentConnectorConfiguration.paymentMethodConfiguration.paymentMethod',
  );
  for (const response of [
    { ...transaction, id: 124 },
    { ...transaction, linkedSpaceId: 406 },
    { ...transaction, linkedSpaceId: undefined },
    { ...transaction, id: '123' },
    [],
  ]) {
    const fixture = fixtureClient(configuration(), new TestLedger(), async () =>
      Response.json(response),
    );
    await assert.rejects(fixture.client.readTransaction(123));
  }
  for (const response of [
    invoiceFixture({ id: 123 }),
    invoiceFixture({ linkedSpaceId: 406 }),
    invoiceFixture({ linkedTransaction: 124 }),
    invoiceFixture({ linkedTransaction: undefined }),
  ]) {
    const fixture = fixtureClient(configuration(), new TestLedger(), async () =>
      Response.json(response),
    );
    await assert.rejects(fixture.client.readTransactionInvoice(41, 123));
  }
});

test('invoice search refuses foreign Space, transaction, malformed identity and unordered results', async () => {
  for (const data of [
    [invoiceFixture({ linkedSpaceId: 406 })],
    [invoiceFixture({ linkedTransaction: 124 })],
    [invoiceFixture({ linkedTransaction: { id: 123 } })],
    [invoiceFixture({ id: 0 })],
    [invoiceFixture(), invoiceFixture()],
    [invoiceFixture(), invoiceFixture({ id: 40 })],
  ]) {
    const fixture = fixtureClient(configuration(), new TestLedger(), async () =>
      searchResponse(data),
    );
    await assert.rejects(fixture.client.findTransactionInvoice(123));
    assert.equal(fixture.requests.length, 1);
  }
});

test('invoice re-read must preserve the link and a second complete search must preserve its unique ID', async () => {
  for (const kind of ['link-changed', 'invoice-removed', 'invoice-replaced']) {
    let searches = 0;
    const fixture = fixtureClient(
      configuration(),
      new TestLedger(),
      async (url) => {
        if (new URL(url).pathname.endsWith('/search')) {
          searches++;
          return searchResponse(
            searches === 1
              ? [invoiceFixture()]
              : kind === 'invoice-removed'
                ? []
                : [invoiceFixture({ id: 42 })],
          );
        }
        return Response.json(
          invoiceFixture(
            kind === 'link-changed' ? { linkedTransaction: 124 } : {},
          ),
        );
      },
    );
    await assert.rejects(
      fixture.client.findTransactionInvoice(123),
      /another transaction|changed/,
    );
  }
});

test('refund search paginates with real offsets, re-reads every refund and rechecks the complete ID set', async () => {
  const refunds = Array.from({ length: 12 }, (_, index) =>
    refundFixture(100 + index),
  );
  const fixture = fixtureClient(
    configuration(),
    new TestLedger(),
    async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/search')) {
        const offset = Number(parsed.searchParams.get('offset'));
        return searchResponse(
          refunds.slice(offset, offset + 10),
          offset,
          offset === 0,
        );
      }
      return Response.json(
        refunds.find((refund) => parsed.pathname.endsWith('/' + refund.id)),
      );
    },
  );
  assert.deepEqual(await fixture.client.listTransactionRefunds(123), refunds);
  const searches = fixture.requests.filter((request) =>
    new URL(request.url).pathname.endsWith('/search'),
  );
  assert.deepEqual(
    searches.map((request) => new URL(request.url).searchParams.get('offset')),
    ['0', '10', '0', '10'],
  );
  assert.equal(
    searches[0].url,
    'https://checkout.postfinance.ch/api/v2.0/payment/refunds/search?expand=transaction&limit=10&offset=0&order=id%3AASC&query=transaction.id%3A123',
  );
  assert.equal(
    fixture.requests.filter(
      (request) => !new URL(request.url).pathname.endsWith('/search'),
    ).length,
    12,
  );
  for (const request of fixture.requests) {
    assert.equal(request.method, 'GET');
    assert.equal(request.body, undefined);
    const claims = JSON.parse(
      Buffer.from(
        request.headers.Authorization.slice(7).split('.')[1],
        'base64url',
      ),
    );
    assert.equal(
      claims.requestPath,
      new URL(request.url).pathname + new URL(request.url).search,
    );
    assert.equal(request.headers.Space, '405');
  }
});

test('empty refund searches are complete only after a stable recheck and do not invent a refund', async () => {
  const empty = fixtureClient(configuration(), new TestLedger(), async () =>
    searchResponse([]),
  );
  assert.deepEqual(await empty.client.listTransactionRefunds(123), []);
  assert.equal(empty.requests.length, 2);
  let searches = 0;
  const changed = fixtureClient(configuration(), new TestLedger(), async () =>
    searchResponse(++searches === 1 ? [] : [refundFixture(100)]),
  );
  await assert.rejects(changed.client.listTransactionRefunds(123), /changed/);
  assert.equal(changed.requests.length, 2);
});

test('refund reads reject changed IDs, foreign Space, unexpanded or wrong linked transactions', async () => {
  for (const refund of [
    refundFixture(101),
    refundFixture(100, { linkedSpaceId: 406 }),
    refundFixture(100, { transaction: 123 }),
    refundFixture(100, { transaction: { id: 124, linkedSpaceId: 405 } }),
    refundFixture(100, { transaction: { id: 123, linkedSpaceId: 406 } }),
    refundFixture(100, { transaction: undefined }),
  ]) {
    const fixture = fixtureClient(configuration(), new TestLedger(), async () =>
      Response.json(refund),
    );
    await assert.rejects(fixture.client.readRefund(100, 123));
    assert.equal(
      new URL(fixture.requests[0].url).pathname,
      '/api/v2.0/payment/refunds/100',
    );
    assert.equal(
      new URL(fixture.requests[0].url).search,
      '?expand=transaction',
    );
  }
  const raw = refundFixture(100, { state: 'UNKNOWN', type: 'UNKNOWN' });
  const fixture = fixtureClient(configuration(), new TestLedger(), async () =>
    Response.json(raw),
  );
  assert.deepEqual(await fixture.client.readRefund(100, 123), raw);
});

test('a refund changed during its re-read prevents the list from returning complete evidence', async () => {
  const fixture = fixtureClient(
    configuration(),
    new TestLedger(),
    async (url) =>
      new URL(url).pathname.endsWith('/search')
        ? searchResponse([refundFixture(100)])
        : Response.json(
            refundFixture(100, {
              transaction: { id: 124, linkedSpaceId: 405 },
            }),
          ),
  );
  await assert.rejects(
    fixture.client.listTransactionRefunds(123),
    /another transaction/,
  );
  assert.equal(fixture.requests.length, 2);
});

test('refund search rejects foreign objects and detects an added refund after the original set was re-read', async () => {
  for (const refund of [
    refundFixture(100, { linkedSpaceId: 406 }),
    refundFixture(100, { transaction: { id: 124, linkedSpaceId: 405 } }),
    refundFixture(100, { transaction: { id: 123, linkedSpaceId: 406 } }),
  ]) {
    const fixture = fixtureClient(configuration(), new TestLedger(), async () =>
      searchResponse([refund]),
    );
    await assert.rejects(fixture.client.listTransactionRefunds(123));
    assert.equal(fixture.requests.length, 1);
  }
  let searches = 0;
  const fixture = fixtureClient(
    configuration(),
    new TestLedger(),
    async (url) => {
      if (new URL(url).pathname.endsWith('/search'))
        return searchResponse(
          ++searches === 1
            ? [refundFixture(100)]
            : [refundFixture(100), refundFixture(101)],
        );
      return Response.json(refundFixture(100));
    },
  );
  await assert.rejects(fixture.client.listTransactionRefunds(123), /changed/);
  assert.equal(fixture.requests.length, 3);
});

test('missing or unknown search metadata and pages without progress fail closed', async () => {
  for (const response of [
    { data: [], offset: 0, limit: 10 },
    { data: [], offset: 0, limit: 10, hasMore: 'false' },
    { data: [], offset: 0, hasMore: false },
    { data: [], offset: 1, limit: 10, hasMore: false },
    { data: [], offset: 0, limit: 0, hasMore: false },
    { data: [], offset: 0, limit: 11, hasMore: false },
    { data: {}, offset: 0, limit: 10, hasMore: false },
    { data: [], offset: 0, limit: 10, hasMore: true },
    {
      data: [invoiceFixture(), invoiceFixture({ id: 42 })],
      offset: 0,
      limit: 1,
      hasMore: false,
    },
  ]) {
    const fixture = fixtureClient(configuration(), new TestLedger(), async () =>
      Response.json(response),
    );
    await assert.rejects(
      fixture.client.findTransactionInvoice(123),
      /search response/,
    );
    assert.equal(fixture.requests.length, 1);
  }
  for (const kind of ['empty-next-page', 'repeated-id', 'wrong-offset']) {
    let page = 0;
    const fixture = fixtureClient(
      configuration(),
      new TestLedger(),
      async () => {
        page++;
        if (page === 1) return searchResponse([refundFixture(100)], 0, true);
        return kind === 'empty-next-page'
          ? searchResponse([], 1)
          : kind === 'wrong-offset'
            ? searchResponse([refundFixture(101)], 0)
            : searchResponse([refundFixture(100)], 1);
      },
    );
    await assert.rejects(
      fixture.client.listTransactionRefunds(123),
      /progressing|Repeated/,
    );
    assert.equal(fixture.requests.length, 2);
  }
});

test('search page budget stops before reading any refund from a truncated set', async () => {
  const fixture = fixtureClient(
    configuration(),
    new TestLedger(),
    async (url) => {
      const offset = Number(new URL(url).searchParams.get('offset'));
      return searchResponse(
        Array.from({ length: 10 }, (_, index) =>
          refundFixture(100 + offset + index),
        ),
        offset,
        true,
      );
    },
  );
  await assert.rejects(
    fixture.client.listTransactionRefunds(123),
    /pagination bound/,
  );
  assert.equal(fixture.requests.length, 3);
  assert.ok(
    fixture.requests.every((request) =>
      new URL(request.url).pathname.endsWith('/search'),
    ),
  );
});

test('search and refund reads bound response bytes and preserve upstream HTTP failures', async () => {
  let cancelled = false;
  const oversized = fixtureClient(
    configuration(),
    new TestLedger(),
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        {
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': '262145',
          },
        },
      ),
  );
  await assert.rejects(
    oversized.client.findTransactionInvoice(123),
    /Oversized/,
  );
  assert.equal(cancelled, true);
  const failed = fixtureClient(
    configuration(),
    new TestLedger(),
    async () => new Response('unavailable', { status: 503 }),
  );
  await assert.rejects(
    failed.client.listTransactionRefunds(123),
    (error) => error.status === 503,
  );
  assert.equal(failed.requests.length, 1);
  const oversizedRefund = fixtureClient(
    configuration(),
    new TestLedger(),
    async () =>
      Response.json(refundFixture(100, { unknown: 'x'.repeat(262144) })),
  );
  await assert.rejects(
    oversizedRefund.client.readRefund(100, 123),
    /Oversized/,
  );
});

test('individual bounded refunds cannot accumulate beyond the combined evidence byte budget', async () => {
  const fixture = fixtureClient(
    configuration(),
    new TestLedger(),
    async (url) => {
      const path = new URL(url).pathname;
      return path.endsWith('/search')
        ? searchResponse(
            Array.from({ length: 10 }, (_, index) =>
              refundFixture(100 + index),
            ),
          )
        : Response.json(
            refundFixture(Number(path.split('/').at(-1)), {
              providerExtra: 'x'.repeat(200000),
            }),
          );
    },
  );
  await assert.rejects(
    fixture.client.listTransactionRefunds(123),
    /combined refund response/,
  );
  assert.ok(fixture.requests.length < 12);
});

test('read-only reconciliation needs no mutation ledger and cannot escape frozen configuration or accept unsafe IDs', async () => {
  const config = configuration({
    apiOrigin: 'https://app-wallee.com',
    spaceId: 406,
  });
  const requests = [];
  const ledger = {
    claim() {
      throw Error('Financial mutation was attempted');
    },
  };
  const client = new PostFinanceCheckoutClient(config, {
    ledger,
    now: () => fixedNow,
    fetch: async (url, init) => {
      requests.push({ url, ...init });
      return new URL(url).pathname.endsWith('/search')
        ? searchResponse([invoiceFixture({ linkedSpaceId: 406 })])
        : Response.json(invoiceFixture({ linkedSpaceId: 406 }));
    },
  });
  config.apiOrigin = 'https://attacker.invalid';
  config.spaceId = 999;
  assert.equal((await client.findTransactionInvoice(123)).id, 41);
  assert.ok(
    requests.every(
      (request) =>
        request.url.startsWith('https://app-wallee.com/') &&
        request.headers.Space === '406',
    ),
  );
  for (const badId of [0, -1, 1.5, '123', Number.MAX_SAFE_INTEGER + 1]) {
    const before = requests.length;
    await assert.rejects(client.findTransactionInvoice(badId));
    await assert.rejects(client.listTransactionRefunds(badId));
    await assert.rejects(client.readRefund(badId));
    assert.equal(requests.length, before);
  }
  const disabled = fixtureClient(configuration({ enabled: false }));
  await assert.rejects(
    disabled.client.findTransactionInvoice(123),
    CheckoutUnavailable,
  );
  assert.equal(disabled.requests.length, 0);
  const noLedger = new PostFinanceCheckoutClient(configuration(), {
    now: () => fixedNow,
    fetch: async (url) =>
      new URL(url).pathname.endsWith('/search')
        ? searchResponse([invoiceFixture()])
        : Response.json(invoiceFixture()),
  });
  assert.equal((await noLedger.findTransactionInvoice(123)).id, 41);
});
