import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { D1PrepaidPeriods, type PrepaidPeriod } from './prepaid-periods';
import { D1PrepaidReconciliationStore } from './prepaid-reconciliation-store';
import { PostFinanceCheckoutClient } from './postfinance-client';
import { prepareInitialPrepaidPurchase } from './prepaid-purchase-preparation';
import { D1PrepaidProvisioning } from './prepaid-provisioning';
import { D1PurchaseIntents } from './purchase-intents';
import { D1PostFinanceWebhookInbox } from './postfinance-store';
import { prepaidProduct } from './prepaid-catalog';
import { LEGAL_VERSION } from '@/lib/legal';
import {
  D1PrepaidTokens,
  verifyFreshTokenBinding,
  verifyPrepaidTokenBinding,
  type ExpectedPrepaidTokenBinding,
  type PrepaidTokenEvidence,
} from './prepaid-token';

vi.mock('@/lib/runtime', () => ({
  database: () => {
    throw Error('Use injected database.');
  },
  runtimeValue: () => '',
  stripeConfiguration: () => ({
    secretKey: '',
    testMode: '',
    priceIds: {},
    signingKey: '',
  }),
}));

const origin = 'https://checkout.postfinance.ch';
const anchor = Date.parse('2026-10-06T10:11:12Z') / 1000;
const contract = {
  contractId: 'pfp_11111111-1111-4111-8111-111111111111',
  ownerId: 'token-owner',
  organizationId: 'token-company',
  workspaceId: null,
  apiOrigin: origin,
  spaceId: 405,
  environment: 'PRODUCTION' as const,
  productKey: 'gestion:start',
};
let sql: DatabaseSync,
  now: number,
  expected: ExpectedPrepaidTokenBinding,
  period: PrepaidPeriod;
let beforeInsert: (() => void) | undefined;
function d1() {
  return {
    prepare(query: string) {
      let values: SQLInputValue[] = [];
      const statement = {
        bind(...args: SQLInputValue[]) {
          values = args;
          return statement;
        },
        async first() {
          return sql.prepare(query).get(...values) ?? null;
        },
        async all() {
          return { results: sql.prepare(query).all(...values) };
        },
        execute() {
          if (query.startsWith('INSERT INTO prepaid_tokens')) {
            const action = beforeInsert;
            beforeInsert = undefined;
            action?.();
          }
          return { success: true, meta: sql.prepare(query).run(...values) };
        },
        async run() {
          return statement.execute();
        },
      };
      return statement;
    },
    async batch(statements: { execute(): unknown }[]) {
      sql.exec('BEGIN');
      try {
        const result = statements.map((s) => s.execute());
        sql.exec('COMMIT');
        return result;
      } catch (error) {
        sql.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as Pick<D1Database, 'prepare' | 'batch'>;
}
const store = () => new D1PrepaidTokens(d1(), () => now);
function connector() {
  return {
    id: 92,
    linkedSpaceId: 405,
    state: 'ACTIVE',
    paymentMethodConfiguration: {
      id: 91,
      linkedSpaceId: 405,
      state: 'ACTIVE',
      paymentMethod: { id: 93 },
    },
  };
}
function evidence(): PrepaidTokenEvidence {
  return {
    apiOrigin: origin,
    spaceId: 405,
    environment: 'PRODUCTION',
    observedAt: now,
    transaction: {
      id: expected.initialTransactionId,
      linkedSpaceId: 405,
      version: 2,
      state: 'FULFILL',
      environment: 'LIVE',
      authorizationEnvironment: 'PRODUCTION',
      currency: 'CHF',
      totalSettledAmount: expected.priceChfMinor / 100,
      refundedAmount: 0,
      customerId: expected.customerReference,
      merchantReference: period.periodId,
      metaData: {
        zentra_period_id: period.periodId,
        zentra_plan_version: period.catalogVersion,
      },
      tokenizationMode: 'FORCE_CREATION',
      customersPresence: 'VIRTUAL_PRESENT',
      token: { id: 101 },
      paymentConnectorConfiguration: connector(),
    },
    token: {
      id: 101,
      linkedSpaceId: 405,
      version: 0,
      state: 'ACTIVE',
      customerId: expected.customerReference,
    },
    activeVersion: {
      id: 102,
      linkedSpaceId: 405,
      version: 0,
      state: 'ACTIVE',
      environment: 'PRODUCTION',
      token: { id: 101 },
      paymentConnectorConfiguration: connector(),
      paymentMethod: { id: 93 },
      processorToken: 'do-not-store-this-provider-secret',
      billingAddress: { emailAddress: 'do-not-store@example.test' },
    },
  };
}
type Fixture = ReturnType<typeof evidence>;
function changed(path: string, value: unknown): Fixture {
  const data = structuredClone(evidence()) as unknown as Record<
    string,
    unknown
  >;
  const keys = path.split('.');
  let cursor = data;
  for (const key of keys.slice(0, -1))
    cursor = cursor[key] as Record<string, unknown>;
  if (value === undefined) delete cursor[keys.at(-1)!];
  else cursor[keys.at(-1)!] = value;
  return data as unknown as Fixture;
}
function client(
  data = evidence(),
  options: {
    second?: PrepaidTokenEvidence;
    outage?: boolean;
    onRead?: (n: number) => void;
    apiOrigin?: 'https://checkout.postfinance.ch' | 'https://app-wallee.com';
    spaceId?: number;
  } = {},
) {
  const requests: {
    url: string;
    method: string;
    space: string | null;
    jwt: Record<string, unknown>;
  }[] = [];
  const transport = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        headers = new Headers(init?.headers);
      const token = headers.get('Authorization')!.slice('Bearer '.length);
      const jwt = JSON.parse(
        Buffer.from(token.split('.')[1], 'base64url').toString(),
      ) as Record<string, unknown>;
      requests.push({
        url,
        method: init?.method ?? '',
        space: headers.get('Space'),
        jwt,
      });
      options.onRead?.(requests.length);
      if (options.outage)
        return new Response('{}', {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      const current =
        requests.length > 3 && options.second ? options.second : data;
      const resource = url.includes('/active-version')
        ? current.activeVersion
        : url.includes('/tokens/')
          ? current.token
          : current.transaction;
      return new Response(JSON.stringify(resource), {
        headers: { 'content-type': 'application/json' },
      });
    },
  );
  return {
    adapter: new PostFinanceCheckoutClient(
      {
        enabled: true,
        apiOrigin: options.apiOrigin ?? origin,
        applicationUserId: '512',
        authenticationKeyBase64: Buffer.alloc(32, 0x5a).toString('base64'),
        spaceId: options.spaceId ?? 405,
      },
      { fetch: transport, now: () => now * 1000 },
    ),
    transport,
    requests,
  };
}
async function paid() {
  await new D1PrepaidPeriods(d1(), () => now).recordReconciledSettlement({
    periodId: period.periodId,
    transactionId: 71,
    invoiceId: 81,
    apiOrigin: origin,
    spaceId: 405,
    environment: 'PRODUCTION',
    ownerId: contract.ownerId,
    organizationId: contract.organizationId,
    workspaceId: null,
    startsAt: period.startsAt,
    endsAt: period.endsAt,
    currency: 'CHF',
    priceChfMinor: 5900,
    catalogVersion: period.catalogVersion,
    evidenceFingerprint: 'a'.repeat(64),
  });
}
async function tokenWork() {
  const inbox = new D1PostFinanceWebhookInbox(
    d1(),
    {
      apiOrigin: origin,
      spaceId: 405,
      listeners: [{ id: 10, entityId: 20, technicalName: 'Transaction' }],
    },
    () => now,
  );
  await inbox.acceptOnce(`${origin}|405|10|31`, {
    eventId: 31,
    entityId: expected.initialTransactionId,
    spaceId: 405,
    webhookListenerId: 10,
    listenerEntityId: 20,
    listenerEntityTechnicalName: 'Transaction',
    timestamp: new Date(now * 1000).toISOString(),
  });
  return (await inbox.claimNext())!;
}
async function preparedNewFlow() {
  const company = 'new-token-company';
  sql
    .prepare(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,updated_at)
    VALUES('old-token-trial','old-token-trial','local','canceled',0,?)`)
    .run(now);
  sql
    .prepare('INSERT INTO organizations VALUES(?,?,?,?,?,?)')
    .run(
      company,
      'Existing company',
      'old-token-trial',
      contract.ownerId,
      now,
      now,
    );
  sql
    .prepare(`INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at)
    VALUES('new-owner-token',?,?,?,'owner',?)`)
    .run(company, contract.ownerId, 'owner@example.test', now);
  const product = prepaidProduct('gestion:start')!;
  const result = await prepareInitialPrepaidPurchase(
    {
      enabled: true,
      settlementEvidenceVerified: true,
      connectorConfigurations: { postfinance_pay: 92 },
      connection: {
        enabled: true,
        merchantApproved: true,
        prepaidFeatureEnabled: true,
        chargeFlowEnabled: true,
        postfinancePayTokenEnabled: true,
        prepaidEnvironment: 'PRODUCTION',
        apiOrigin: origin,
        spaceId: 405,
        applicationUserId: '512',
        authenticationKeyBase64: Buffer.alloc(32, 0x5a).toString('base64'),
        returnOrigin: 'https://zentra.example.test',
        prepaidProducts: {
          'gestion:start': {
            currency: 'CHF',
            billingPeriod: 'P1M',
            priceChfMinor: 5900,
            reference: product.catalogVersion,
            name: product.name,
            methodConfigurations: { postfinance_pay: 91 },
          },
        },
      },
    },
    {
      user: {
        userId: contract.ownerId,
        email: 'owner@example.test',
        emailConfirmed: true,
      },
      requestId: '22222222-2222-4222-8222-222222222222',
      productKey: 'gestion:start',
      organizationId: company,
      method: 'postfinance_pay',
      acceptTerms: true,
      legalVersion: LEGAL_VERSION,
    },
    { database: () => d1(), now: () => now },
  );
  if (result.state !== 'prepared')
    throw Error('Expected actual prepared fixture.');
  await new D1PurchaseIntents(d1(), () => now).markDispatched(result.intent);
  period = result.period;
  await new D1PrepaidPeriods(d1(), () => now).bindTransaction(
    period.periodId,
    72,
  );
  await new D1PurchaseIntents(d1(), () => now).bindProviderReference(
    result.intent,
    '72',
  );
  expected = {
    ...result.contract,
    initialPeriodId: period.periodId,
    initialTransactionId: 72,
    initialInvoiceId: 82,
    settlementFingerprint: 'a'.repeat(64),
    customerReference: result.expectation.customerReference,
    method: 'postfinance_pay',
    paymentMethodConfigurationId: 91,
    connectorConfigurationId: 92,
    catalogVersion: period.catalogVersion,
    priceChfMinor: 5900,
  };
  const inbox = new D1PostFinanceWebhookInbox(
    d1(),
    {
      apiOrigin: origin,
      spaceId: 405,
      listeners: [{ id: 10, entityId: 20, technicalName: 'Transaction' }],
    },
    () => now,
  );
  await inbox.acceptOnce(`${origin}|405|10|19`, {
    eventId: 19,
    entityId: 72,
    spaceId: 405,
    webhookListenerId: 10,
    listenerEntityId: 20,
    listenerEntityTechnicalName: 'Transaction',
    timestamp: new Date(now * 1000).toISOString(),
  });
  const work = (await inbox.claimNext())!;
  const proof = {
    periodId: period.periodId,
    transactionId: 72,
    invoiceId: 82,
    apiOrigin: origin,
    spaceId: 405,
    environment: 'PRODUCTION' as const,
    ownerId: expected.ownerId,
    organizationId: expected.organizationId,
    workspaceId: expected.workspaceId,
    startsAt: period.startsAt,
    endsAt: period.endsAt,
    currency: 'CHF' as const,
    priceChfMinor: 5900,
    catalogVersion: period.catalogVersion,
    evidenceFingerprint: 'a'.repeat(64),
  };
  return { prepared: result, proof, work };
}
async function anotherPaidContract(
  productKey: string,
  ownerId = contract.ownerId,
) {
  const id = 'pfp_33333333-3333-4333-8333-333333333333';
  const product = prepaidProduct(productKey)!;
  const org =
    product.productKind === 'support' ? null : 'another-token-company';
  const workspace = product.support ? 'another-token-workspace' : null;
  if (org) {
    sql
      .prepare(
        `INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,updated_at) VALUES(?,?,'local','incomplete',0,?)`,
      )
      .run(id, id, now);
    sql
      .prepare('INSERT INTO organizations VALUES(?,?,?,?,?,?)')
      .run(org, 'Another company', id, ownerId, now, now);
    sql
      .prepare(
        `INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES('another-token-owner',?,?,?,'owner',?)`,
      )
      .run(org, ownerId, 'another@example.test', now);
  }
  if (workspace)
    sql
      .prepare(
        'INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at) VALUES(?,?,?,?,?)',
      )
      .run(workspace, ownerId, 'Another workspace', now, now);
  if (org && workspace)
    sql
      .prepare(
        'INSERT INTO support_gestion_links(workspace_id,organization_id,enabled,auto_post,connected_by,created_at) VALUES(?,?,1,0,?,?)',
      )
      .run(workspace, org, ownerId, now);
  const input = {
    ...contract,
    contractId: id,
    ownerId,
    organizationId: org,
    workspaceId: workspace,
    productKey,
  };
  const periods = new D1PrepaidPeriods(d1(), () => now);
  await periods.createContract(input);
  period = await periods.reservePeriod(id, 0);
  const reference = 'pfpayer_another';
  await new D1PrepaidReconciliationStore(d1(), () => now).freezeExpectation(
    period.periodId,
    {
      customerReference: reference,
      planReference: period.catalogVersion,
      paymentMethodConfigurationId: 91,
      connectorConfigurationId: 92,
    },
  );
  await periods.bindTransaction(period.periodId, 73);
  await periods.recordReconciledSettlement({
    periodId: period.periodId,
    transactionId: 73,
    invoiceId: 83,
    apiOrigin: origin,
    spaceId: 405,
    environment: 'PRODUCTION',
    ownerId,
    organizationId: org,
    workspaceId: workspace,
    startsAt: period.startsAt,
    endsAt: period.endsAt,
    currency: 'CHF',
    priceChfMinor: product.priceChfMinor,
    catalogVersion: period.catalogVersion,
    evidenceFingerprint: 'a'.repeat(64),
  });
  expected = {
    ...input,
    initialPeriodId: period.periodId,
    initialTransactionId: 73,
    initialInvoiceId: 83,
    settlementFingerprint: 'a'.repeat(64),
    customerReference: reference,
    method: 'postfinance_pay',
    paymentMethodConfigurationId: 91,
    connectorConfigurationId: 92,
    catalogVersion: period.catalogVersion,
    priceChfMinor: product.priceChfMinor,
  };
}
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  now = anchor;
  vi.setSystemTime(now * 1000);
  beforeInsert = undefined;
  sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  sql.function('unixepoch', () => now);
  for (const file of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((x) => x.endsWith('.sql'))
    .sort())
    sql.exec(
      readFileSync(new URL(`../../drizzle/${file}`, import.meta.url), 'utf8'),
    );
  sql
    .prepare(
      `INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,updated_at) VALUES(?,?,'local','incomplete',0,?)`,
    )
    .run(contract.contractId, contract.contractId, now);
  sql
    .prepare('INSERT INTO organizations VALUES(?,?,?,?,?,?)')
    .run(
      contract.organizationId,
      'Token company',
      contract.contractId,
      contract.ownerId,
      now,
      now,
    );
  sql
    .prepare(
      `INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES('owner-token',?,?,?,'owner',?)`,
    )
    .run(contract.organizationId, contract.ownerId, 'owner@example.test', now);
  const periods = new D1PrepaidPeriods(d1(), () => now);
  await periods.createContract(contract);
  period = await periods.reservePeriod(contract.contractId, 0);
  await new D1PrepaidReconciliationStore(d1(), () => now).freezeExpectation(
    period.periodId,
    {
      customerReference: 'pfpayer_synthetic',
      planReference: period.catalogVersion,
      paymentMethodConfigurationId: 91,
      connectorConfigurationId: 92,
    },
  );
  await periods.bindTransaction(period.periodId, 71);
  expected = {
    ...contract,
    initialPeriodId: period.periodId,
    initialTransactionId: 71,
    initialInvoiceId: 81,
    settlementFingerprint: 'a'.repeat(64),
    customerReference: 'pfpayer_synthetic',
    method: 'postfinance_pay',
    paymentMethodConfigurationId: 91,
    connectorConfigurationId: 92,
    catalogVersion: period.catalogVersion,
    priceChfMinor: 5900,
  };
});
afterEach(() => {
  sql.close();
  vi.useRealTimers();
});

describe('pure initial token validation against exact official model fields', () => {
  it('accepts ACTIVE version zero and separates token ID from active token-version ID', () => {
    expect(verifyPrepaidTokenBinding(expected, evidence(), now)).toMatchObject({
      tokenId: 101,
      tokenVersionId: 102,
      tokenObjectVersion: 0,
      tokenVersionObjectVersion: 0,
      paymentMethodId: 93,
    });
  });
  it.each([
    ['apiOrigin', 'https://app-wallee.com'],
    ['spaceId', 406],
    ['environment', 'TEST'],
    ['observedAt', anchor + 1],
    ['observedAt', anchor - 61],
    ['transaction.id', 102],
    ['transaction.linkedSpaceId', 406],
    ['transaction.version', -1],
    ['transaction.state', 'COMPLETED'],
    ['transaction.environment', 'PREVIEW'],
    ['transaction.authorizationEnvironment', 'TEST'],
    ['transaction.totalSettledAmount', 58.99],
    ['transaction.totalSettledAmount', '59'],
    ['transaction.currency', 'EUR'],
    ['transaction.refundedAmount', 0.01],
    ['transaction.customerId', 'foreign'],
    ['transaction.merchantReference', 'foreign'],
    ['transaction.metaData.zentra_period_id', 'foreign'],
    ['transaction.metaData.zentra_plan_version', 'foreign'],
    ['transaction.tokenizationMode', 'ALLOW_ONE_CLICK_PAYMENT'],
    ['transaction.customersPresence', 'NOT_PRESENT'],
    ['transaction.token.id', 102],
    ['transaction.token.linkedSpaceId', 406],
    ['token.id', 102],
    ['token.linkedSpaceId', 406],
    ['token.state', 'INACTIVE'],
    ['token.customerId', 'foreign'],
    ['token.version', -1],
    ['token.version', '0'],
    ['activeVersion.id', 0],
    ['activeVersion.version', -1],
    ['activeVersion.state', 'OBSOLETE'],
    ['activeVersion.state', 'UNINITIALIZED'],
    ['activeVersion.linkedSpaceId', 406],
    ['activeVersion.environment', 'TEST'],
    ['activeVersion.token.id', 102],
    ['activeVersion.token.linkedSpaceId', 406],
    ['activeVersion.token.customerId', 'foreign'],
    ['activeVersion.token.state', 'DELETED'],
    ['activeVersion.token.version', 1],
    ['activeVersion.obsoletedOn', '2026-10-05T00:00:00Z'],
    ['activeVersion.expiresOn', '2026-10-06T10:11:12Z'],
    ['activeVersion.expiresOn', 'malformed'],
    ['activeVersion.activatedOn', '2027-01-01T00:00:00Z'],
    ['activeVersion.retryStrategy', 'NO_RETRY'],
    ['activeVersion.retryStrategy', 'RETRY_LATER'],
    ['activeVersion.retryStrategy', 'REFRESH_TOKEN'],
    ['activeVersion.retryStrategy', 'unknown'],
    ['activeVersion.paymentConnectorConfiguration.id', 99],
    ['activeVersion.paymentConnectorConfiguration.linkedSpaceId', 406],
    ['activeVersion.paymentConnectorConfiguration.state', 'INACTIVE'],
    [
      'activeVersion.paymentConnectorConfiguration.applicableForTransactionProcessing',
      false,
    ],
    [
      'activeVersion.paymentConnectorConfiguration.paymentMethodConfiguration.id',
      99,
    ],
    [
      'activeVersion.paymentConnectorConfiguration.paymentMethodConfiguration.linkedSpaceId',
      406,
    ],
    ['activeVersion.paymentMethod.id', 94],
    ['activeVersion.paymentConnectorConfiguration', 92],
    ['token.customerId', undefined],
    ['activeVersion.paymentMethod', undefined],
  ])('refuses mismatched or ambiguous %s', (path, value) =>
    expect(() =>
      verifyPrepaidTokenBinding(expected, changed(path as string, value), now),
    ).toThrow('binding'),
  );
  it.each([
    { contractId: 'pfp_bad' },
    { ownerId: '' },
    { workspaceId: '' },
    { spaceId: 0 },
    { method: 'card' },
    { tokenId: 102 },
    { tokenVersionId: 103 },
    { tokenObjectVersion: 1 },
    { tokenVersionObjectVersion: 1 },
    { paymentMethodId: 94 },
    { settlementFingerprint: 'bad' },
    { priceChfMinor: 5901 },
  ])('refuses malformed or pinned expected binding %j', (patch) => {
    expect(() =>
      verifyPrepaidTokenBinding(
        { ...expected, ...patch } as ExpectedPrepaidTokenBinding,
        evidence(),
        now,
      ),
    ).toThrow('binding');
  });
  it('accepts optional future expiry and independently scoped TEST evidence without claiming production payment', () => {
    const e = changed('activeVersion.expiresOn', '2026-11-06T00:00:00Z');
    expect(verifyPrepaidTokenBinding(expected, e, now).tokenId).toBe(101);
    const data = structuredClone(evidence());
    (data.transaction as Record<string, unknown>).authorizationEnvironment =
      'TEST';
    (data.transaction as Record<string, unknown>).environment = 'PREVIEW';
    (data.activeVersion as Record<string, unknown>).environment = 'TEST';
    expect(
      verifyPrepaidTokenBinding(
        { ...expected, environment: 'TEST' },
        { ...data, environment: 'TEST' },
        now,
      ).environment,
    ).toBe('TEST');
  });
});

describe('stable GET observation with the real signed client and a fictitious transport', () => {
  it.each([{ apiOrigin: 'https://app-wallee.com' as const }, { spaceId: 406 }])(
    'checks real client scope %j before issuing any GET',
    async (scope) => {
      const c = client(evidence(), scope);
      await expect(
        verifyFreshTokenBinding(c.adapter, expected, now),
      ).rejects.toThrow('binding');
      expect(c.transport).not.toHaveBeenCalled();
    },
  );
  it('refuses slow observations and a clock moving backwards', async () => {
    for (const offset of [61, -1]) {
      now = anchor;
      vi.setSystemTime(now * 1000);
      const c = client(evidence(), {
        onRead: (n) => {
          if (n === 6) {
            now += offset;
            vi.setSystemTime(now * 1000);
          }
        },
      });
      await expect(
        verifyFreshTokenBinding(c.adapter, expected, anchor, () => now),
      ).rejects.toThrow('unstable');
    }
  });
  it('uses six GETs, signs exact paths/query, and never calls a financial POST', async () => {
    const c = client();
    await verifyFreshTokenBinding(c.adapter, expected, now);
    expect(c.requests).toHaveLength(6);
    expect(
      c.requests.map((r) => new URL(r.url).pathname + new URL(r.url).search),
    ).toEqual(
      Array(2)
        .fill([
          '/api/v2.0/payment/transactions/71?expand=paymentConnectorConfiguration.paymentMethodConfiguration',
          '/api/v2.0/payment/tokens/101',
          '/api/v2.0/payment/tokens/101/active-version',
        ])
        .flat(),
    );
    for (const r of c.requests) {
      expect(r.method).toBe('GET');
      expect(r.space).toBe('405');
      expect(r.jwt.requestPath).toBe(
        new URL(r.url).pathname + new URL(r.url).search,
      );
    }
  });
  it.each([
    ['transaction.version', 3],
    ['token.version', 1],
    ['activeVersion.version', 1],
    ['activeVersion.id', 103],
  ])('refuses a concurrent change of %s', async (path, value) => {
    const c = client(evidence(), { second: changed(path as string, value) });
    await expect(
      verifyFreshTokenBinding(c.adapter, expected, now),
    ).rejects.toThrow('unstable');
  });
  it('refuses a refund appearing in the last transaction reread', async () => {
    const c = client(evidence(), {
      second: changed('transaction.refundedAmount', 59),
    });
    await expect(
      verifyFreshTokenBinding(c.adapter, expected, now),
    ).rejects.toThrow('binding');
  });
  it('fails closed on provider outage without token storage or entitlement writes', async () => {
    const c = client(evidence(), { outage: true });
    await expect(store().bindInitial(c.adapter, expected)).rejects.toThrow(
      'HTTP 503',
    );
    expect(sql.prepare('SELECT COUNT(*) n FROM prepaid_tokens').get()?.n).toBe(
      0,
    );
  });
});

describe('immutable initial paid token binding on all real migrations', () => {
  it('fences a successful binding and an exact replay with the actual inbox lease', async () => {
    await paid();
    const work = await tokenWork(),
      c = client();
    const binding = await store().bindInitial(c.adapter, expected, work);
    expect(await store().bindInitial(c.adapter, expected, work)).toEqual(
      binding,
    );
    expect(c.requests).toHaveLength(12);
    expect(c.requests.every((r) => r.method === 'GET')).toBe(true);
  });
  it.each(['scope', 'space', 'event', 'lease', 'expiry'] as const)(
    'rejects forged or expired %s work before any provider GET',
    async (mode) => {
      await paid();
      let work = await tokenWork();
      const c = client();
      if (mode === 'scope') work = { ...work, scopeHash: 'b'.repeat(64) };
      if (mode === 'space')
        work = { ...work, event: { ...work.event, spaceId: 406 } };
      if (mode === 'event')
        work = { ...work, event: { ...work.event, entityId: 999 } };
      if (mode === 'lease')
        work = { ...work, lease: '11111111-1111-4111-8111-111111111111' };
      if (mode === 'expiry') {
        now = work.leaseUntil;
        vi.setSystemTime(now * 1000);
      }
      await expect(
        store().bindInitial(c.adapter, expected, work),
      ).rejects.toThrow();
      expect(c.transport).not.toHaveBeenCalled();
      expect(
        sql.prepare('SELECT COUNT(*) n FROM prepaid_tokens').get()?.n,
      ).toBe(0);
    },
  );
  it.each([false, true])(
    'lost lease before atomic INSERT cannot write or acknowledge a stored replay (%s)',
    async (replay) => {
      await paid();
      const work = await tokenWork();
      if (replay) await store().bindInitial(client().adapter, expected, work);
      beforeInsert = () =>
        sql
          .prepare(
            "UPDATE postfinance_webhook_inbox SET state='pending',lease=NULL,lease_until=0 WHERE scope_hash=?",
          )
          .run(work.scopeHash);
      await expect(
        store().bindInitial(client().adapter, expected, work),
      ).rejects.toThrow();
      expect(
        sql.prepare('SELECT COUNT(*) n FROM prepaid_tokens').get()?.n,
      ).toBe(replay ? 1 : 0);
    },
  );
  it('does not bind an already-observed token to another owner, including direct SQL admission', async () => {
    await paid();
    await store().bindInitial(client().adapter, expected);
    const original = sql.prepare('SELECT * FROM prepaid_tokens').get()!;
    await anotherPaidContract('gestion:start', 'foreign-owner');
    await expect(
      store().bindInitial(client().adapter, expected),
    ).rejects.toThrow('conflict');
    const other = {
      ...original,
      contract_id: expected.contractId,
      initial_period_id: expected.initialPeriodId,
      initial_transaction_id: 73,
      initial_invoice_id: 83,
      owner_id: expected.ownerId,
      organization_id: expected.organizationId,
      customer_reference: expected.customerReference,
    };
    const keys = Object.keys(other);
    expect(() =>
      sql
        .prepare(
          `INSERT INTO prepaid_tokens(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`,
        )
        .run(
          ...keys.map((k) => other[k as keyof typeof other] as SQLInputValue),
        ),
    ).toThrow('prepaid_token_owner');
    expect(sql.prepare('SELECT COUNT(*) n FROM prepaid_tokens').get()?.n).toBe(
      1,
    );
  });
  it.each(['support:starter', 'complet:team'])(
    'keeps %s workspace ownership and its company link scoped',
    async (productKey) => {
      await anotherPaidContract(productKey);
      await store().bindInitial(client().adapter, expected);
      expect(await store().load(expected.contractId)).not.toBeNull();
      sql
        .prepare(
          "UPDATE support_workspaces SET owner_id='foreign-owner' WHERE id=?",
        )
        .run(expected.workspaceId!);
      expect(await store().load(expected.contractId)).toBeNull();
      expect(
        sql.prepare('SELECT COUNT(*) n FROM prepaid_tokens').get()?.n,
      ).toBe(1);
    },
  );
  it('new flow requires its real paid handoff closure and frozen initial method', async () => {
    const setup = await preparedNewFlow();
    await new D1PrepaidPeriods(d1(), () => now).recordReconciledSettlement(
      setup.proof,
      setup.work,
    );
    expect(
      await store().initialContext(expected.contractId, 'postfinance_pay'),
    ).toBeNull();
    await expect(
      store().bindInitial(client().adapter, expected),
    ).rejects.toThrow('conflict');
    await new D1PrepaidProvisioning(d1(), () => now).provision(
      setup.proof,
      setup.work,
    );
    expect(
      await store().initialContext(expected.contractId, 'postfinance_pay'),
    ).toEqual(
      expect.objectContaining({
        method: 'postfinance_pay',
        initialTransactionId: 72,
      }),
    );
    expect(
      await store().initialContext(expected.contractId, 'twint'),
    ).toBeNull();
    await expect(
      store().bindInitial(client().adapter, { ...expected, method: 'twint' }),
    ).rejects.toThrow('conflict');
    const binding = await store().bindInitial(client().adapter, expected);
    now = period.endsAt + 1;
    vi.setSystemTime(now * 1000);
    expect(await store().load(expected.contractId)).toMatchObject({
      tokenId: binding.tokenId,
      method: 'postfinance_pay',
    });
    expect(
      sql
        .prepare(
          'SELECT closed_at FROM prepaid_purchase_projections WHERE contract_id=?',
        )
        .get(expected.contractId)?.closed_at,
    ).toBe(anchor);
  });
  it('without a paid proof has no initial context and cannot bind', async () => {
    expect(
      await store().initialContext(contract.contractId, 'postfinance_pay'),
    ).toBeNull();
    await expect(
      store().bindInitial(client().adapter, expected),
    ).rejects.toThrow('conflict');
    expect(sql.prepare('SELECT COUNT(*) n FROM prepaid_tokens').get()?.n).toBe(
      0,
    );
  });
  it('persists only identifiers and keeps all existing rights/projections unchanged', async () => {
    await paid();
    const before = sql.prepare('SELECT * FROM subscriptions').all();
    const b = await store().bindInitial(client().adapter, expected);
    expect(await store().load(contract.contractId)).toEqual(b);
    expect(b).toMatchObject({
      initialTransactionId: 71,
      initialInvoiceId: 81,
      tokenId: 101,
      tokenVersionId: 102,
    });
    expect(sql.prepare('SELECT * FROM subscriptions').all()).toEqual(before);
    expect(
      JSON.stringify(sql.prepare('SELECT * FROM prepaid_tokens').get()),
    ).not.toMatch(/do-not-store|processorToken|billingAddress/);
    expect(
      sql.prepare('SELECT COUNT(*) n FROM license_activations').get()?.n,
    ).toBe(0);
  });
  it('concurrent initial binding is idempotent and stable even after first-month expiry', async () => {
    await paid();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        store().bindInitial(client().adapter, expected),
      ),
    );
    expect(new Set(results.map((x) => x.evidenceFingerprint)).size).toBe(1);
    expect(sql.prepare('SELECT COUNT(*) n FROM prepaid_tokens').get()?.n).toBe(
      1,
    );
    now = period.endsAt + 86400;
    vi.setSystemTime(now * 1000);
    const stored = await store().load(contract.contractId);
    expect(stored).not.toBeNull();
    expect(
      (await verifyFreshTokenBinding(client().adapter, stored!, now)).tokenId,
    ).toBe(101);
  });
  it('does not replace a pinned token or active version on rebind or renewal', async () => {
    await paid();
    const b = await store().bindInitial(client().adapter, expected);
    await expect(
      store().bindInitial(
        client(changed('activeVersion.id', 103)).adapter,
        expected,
      ),
    ).rejects.toThrow('conflict');
    await expect(
      verifyFreshTokenBinding(
        client(changed('activeVersion.id', 103)).adapter,
        b,
        now,
      ),
    ).rejects.toThrow('binding');
    expect((await store().load(contract.contractId))?.tokenVersionId).toBe(102);
  });
  it.each([
    'owner',
    'membership',
    'projection',
    'deleted',
    'cancelled',
    'refunded',
  ] as const)(
    'refuses %s changes between verification and atomic admission',
    async (mode) => {
      await paid();
      beforeInsert = () => {
        if (mode === 'owner')
          sql
            .prepare(
              "UPDATE organizations SET created_by_user_id='foreign' WHERE organization_id=?",
            )
            .run(contract.organizationId);
        if (mode === 'membership')
          sql
            .prepare(
              "UPDATE organization_members SET revoked_at=? WHERE membership_id='owner-token'",
            )
            .run(now);
        if (mode === 'projection') {
          sql
            .prepare(
              `INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,updated_at) VALUES('foreign','foreign','x','canceled',0,?)`,
            )
            .run(now);
          sql
            .prepare(
              "UPDATE organizations SET subscription_id='foreign' WHERE organization_id=?",
            )
            .run(contract.organizationId);
        }
        if (mode === 'deleted')
          sql
            .prepare(
              'INSERT INTO account_session_policy(user_id,deleted_at) VALUES(?,?)',
            )
            .run(contract.ownerId, now);
        if (mode === 'cancelled')
          sql
            .prepare(
              'UPDATE prepaid_contracts SET cancelled_at=? WHERE contract_id=?',
            )
            .run(now, contract.contractId);
        if (mode === 'refunded')
          sql
            .prepare('INSERT INTO prepaid_provider_reversals VALUES(?,?,?)')
            .run(period.periodId, 'b'.repeat(64), now);
      };
      await expect(
        store().bindInitial(client().adapter, expected),
      ).rejects.toThrow();
      expect(
        sql.prepare('SELECT COUNT(*) n FROM prepaid_tokens').get()?.n,
      ).toBe(0);
    },
  );
  it.each(['cancelled', 'refunded', 'membership'] as const)(
    'stored initial history survives %s but load refuses it',
    async (mode) => {
      await paid();
      await store().bindInitial(client().adapter, expected);
      if (mode === 'cancelled')
        sql
          .prepare(
            'UPDATE prepaid_contracts SET cancelled_at=? WHERE contract_id=?',
          )
          .run(now, contract.contractId);
      if (mode === 'refunded')
        sql
          .prepare('INSERT INTO prepaid_provider_reversals VALUES(?,?,?)')
          .run(period.periodId, 'b'.repeat(64), now);
      if (mode === 'membership')
        sql
          .prepare(
            "UPDATE organization_members SET revoked_at=? WHERE membership_id='owner-token'",
          )
          .run(now);
      expect(await store().load(contract.contractId)).toBeNull();
      expect(
        sql.prepare('SELECT COUNT(*) n FROM prepaid_tokens').get()?.n,
      ).toBe(1);
    },
  );
  it('database guards reject modification/deletion and cross-context direct insert', async () => {
    await paid();
    await store().bindInitial(client().adapter, expected);
    expect(() =>
      sql.prepare('UPDATE prepaid_tokens SET token_id=999').run(),
    ).toThrow('prepaid_token_immutable');
    expect(() => sql.prepare('DELETE FROM prepaid_tokens').run()).toThrow(
      'prepaid_token_immutable',
    );
    const row = sql.prepare('SELECT * FROM prepaid_tokens').get()!;
    const keys = Object.keys(row);
    expect(() =>
      sql
        .prepare(
          `INSERT INTO prepaid_tokens(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`,
        )
        .run(
          ...keys.map((k) =>
            k === 'owner_id' ? 'foreign' : (row[k] as SQLInputValue),
          ),
        ),
    ).toThrow('prepaid_token_binding');
  });
  it('does not accept a different local owner/target/proof/method configuration', async () => {
    await paid();
    for (const patch of [
      { ownerId: 'foreign' },
      { organizationId: 'foreign' },
      { initialInvoiceId: 82 },
      { settlementFingerprint: 'b'.repeat(64) },
    ]) {
      await expect(
        store().bindInitial(client().adapter, { ...expected, ...patch }),
      ).rejects.toThrow('conflict');
    }
    expect(sql.prepare('SELECT COUNT(*) n FROM prepaid_tokens').get()?.n).toBe(
      0,
    );
  });
});
