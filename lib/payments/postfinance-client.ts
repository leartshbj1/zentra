/** Bounded PostFinance Checkout API v2 adapter. Server/Cloudflare only; no SDK. */
export type SwissMethod = 'postfinance_pay' | 'twint';
export type JsonObject = Record<string, unknown>;

export interface MonthlyProduct {
  productId: number;
  currency: 'CHF';
  billingPeriod: 'P1M';
  priceChfMinor: number;
  methods: SwissMethod[];
  componentConfigurations?: {
    productComponentReferenceId: number;
    quantity: number;
  }[];
}

/** Zentra-owned prepaid catalogue. No native PostFinance SubscriptionProduct
 * is necessary when Zentra schedules charges for already-defined periods. */
export interface PrepaidMonthlyProduct {
  currency: 'CHF';
  billingPeriod: 'P1M';
  priceChfMinor: number;
  reference: string;
  name: string;
  methodConfigurations: Partial<Record<SwissMethod, number>>;
}

export interface CheckoutConfiguration {
  enabled: boolean;
  apiOrigin?: 'https://checkout.postfinance.ch' | 'https://app-wallee.com';
  applicationUserId?: string;
  authenticationKeyBase64?: string;
  spaceId?: number;
  returnOrigin?: string;
  merchantApproved?: boolean;
  subscriptionFeatureEnabled?: boolean;
  chargeFlowEnabled?: boolean;
  postfinancePayTokenEnabled?: boolean;
  twintUserOnFileEnabled?: boolean;
  products?: Record<string, MonthlyProduct>;
  prepaidFeatureEnabled?: boolean;
  prepaidEnvironment?: 'PRODUCTION' | 'TEST';
  prepaidProducts?: Record<string, PrepaidMonthlyProduct>;
}

export type Claim =
  | { kind: 'claimed' }
  | { kind: 'completed'; json: string }
  | { kind: 'conflict' }
  | { kind: 'uncertain' };

/** Implement using an atomic, durable database row. Never implement with KV get+put. */
export interface MutationLedger {
  claim(scope: string, fingerprint: string): Promise<Claim>;
  complete(scope: string, json: string): Promise<void>;
  markUncertain(scope: string): Promise<void>;
}

export interface WebhookInbox {
  /** Atomically insert this event and its queued work; false means already accepted. */
  acceptOnce(scope: string, event: CheckoutWebhook): Promise<boolean>;
}

export interface CheckoutWebhook {
  eventId: number;
  entityId: number;
  spaceId: number;
  webhookListenerId: number;
  listenerEntityId: number;
  listenerEntityTechnicalName?: string;
  timestamp: string;
  state?: string;
}

export class CheckoutUnavailable extends Error {}
export class CheckoutApiError extends Error {
  status: number;
  constructor(status: number) {
    super(`PostFinance Checkout API returned HTTP ${status}.`);
    this.status = status;
  }
}

const encoder = new TextEncoder();
const approvedOrigins = new Set([
  'https://checkout.postfinance.ch',
  'https://app-wallee.com',
]);
const apiPrefix = '/api/v2.0';
const searchPageSize = 10;
const maximumSearchPages = 3;
const maximumSearchResponseBytes = 262_144;

/** Same scalar encoding/order as the pinned SDK runtime.querystring. The
 * identical path, including its query, is sent to fetch and signed in JWT. */
function queryPath(
  path: string,
  parameters: Record<string, string | number>,
): string {
  const query = Object.entries(parameters)
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
    )
    .join('&')
    .replace(/'/g, '%27');
  return `${path}?${query}`;
}

function bytesBase64(value: string): Uint8Array {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new Error('Invalid Base64.');
  }
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function base64Url(bytes: Uint8Array): string {
  let result = '';
  for (const byte of bytes) result += String.fromCharCode(byte);
  return btoa(result).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function bufferSource(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

function id(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new Error(`Invalid ${label}.`);
}

function object(value: unknown): asserts value is JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected JSON object.');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as JsonObject)[key])}`,
      )
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Non-JSON request data.');
  return encoded;
}

async function fingerprint(body: unknown): Promise<string> {
  // Preserve existing JSON fingerprints. This sentinel cannot be valid JSON.
  const digest = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(
      body === undefined ? 'zentra:absent-body:v1' : canonical(body),
    ),
  );
  return base64Url(new Uint8Array(digest));
}

/** Bound bytes while receiving. response.text() followed by a size check is
 * too late to protect a Worker from an oversized upstream response. */
async function responseText(
  response: Response,
  maximum: number,
): Promise<string> {
  const declared = response.headers.get('Content-Length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('Oversized API response.');
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let count = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > maximum) {
        await reader.cancel().catch(() => undefined);
        throw new Error('Oversized API response.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(count);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** Auth protocol verified against pfpayments/typescript-sdk HttpBearerAuth.ts. */
export async function bearerToken(
  userId: string,
  keyBase64: string,
  method: string,
  resourcePath: string,
  issuedAt: number,
): Promise<string> {
  if (!/^[1-9][0-9]*$/.test(userId))
    throw new Error('Invalid application user ID.');
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0)
    throw new Error('Invalid issued-at time.');
  if (
    !resourcePath.startsWith(`${apiPrefix}/`) ||
    !['GET', 'POST'].includes(method)
  )
    throw new Error('Invalid signed request.');
  const keyBytes = bytesBase64(keyBase64);
  if (keyBytes.length !== 32)
    throw new Error(
      'The application authentication key must contain 32 bytes.',
    );
  const header = base64Url(
    encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT', ver: 1 })),
  );
  const payload = base64Url(
    encoder.encode(
      JSON.stringify({
        sub: userId,
        iat: issuedAt,
        requestPath: resourcePath,
        requestMethod: method,
      }),
    ),
  );
  const key = await crypto.subtle.importKey(
    'raw',
    bufferSource(keyBytes),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
}

export class PostFinanceCheckoutClient {
  private config: CheckoutConfiguration;
  private fetcher: typeof fetch;
  private ledger?: MutationLedger;
  private now: () => number;

  constructor(
    configuration: CheckoutConfiguration,
    dependencies: {
      fetch?: typeof fetch;
      ledger?: MutationLedger;
      now?: () => number;
    } = {},
  ) {
    // A copy prevents callers from enabling methods by mutating the original object.
    this.config = structuredClone(configuration);
    this.fetcher = dependencies.fetch ?? fetch;
    this.ledger = dependencies.ledger;
    this.now = dependencies.now ?? Date.now;
  }

  private connection(): {
    origin: string;
    userId: string;
    key: string;
    spaceId: number;
  } {
    const c = this.config;
    if (
      c.enabled !== true ||
      !c.applicationUserId ||
      !c.authenticationKeyBase64 ||
      !c.spaceId
    ) {
      throw new CheckoutUnavailable(
        'PostFinance Checkout has no enabled merchant configuration.',
      );
    }
    id(c.spaceId, 'space ID');
    const origin = c.apiOrigin ?? 'https://checkout.postfinance.ch';
    if (!approvedOrigins.has(origin))
      throw new CheckoutUnavailable('Unapproved API origin.');
    return {
      origin,
      userId: c.applicationUserId,
      key: c.authenticationKeyBase64,
      spaceId: c.spaceId,
    };
  }

  /** Secret-free immutable provenance for internal read-only verifiers. */
  readScope(): Readonly<{ apiOrigin: string; spaceId: number }> {
    const scope = this.connection();
    return Object.freeze({ apiOrigin: scope.origin, spaceId: scope.spaceId });
  }

  private requireRecurring(method: SwissMethod): void {
    this.connection();
    const c = this.config;
    if (
      !this.ledger ||
      c.merchantApproved !== true ||
      c.subscriptionFeatureEnabled !== true ||
      c.chargeFlowEnabled !== true
    ) {
      throw new CheckoutUnavailable(
        'Merchant approval, subscriptions, Charge Flow and durable ledger are required.',
      );
    }
    if (
      !(method === 'postfinance_pay'
        ? c.postfinancePayTokenEnabled === true
        : method === 'twint' && c.twintUserOnFileEnabled === true)
    ) {
      throw new CheckoutUnavailable(
        'The requested recurring payment method has not been activated.',
      );
    }
  }

  private requirePrepaid(method: SwissMethod): void {
    this.connection();
    const c = this.config;
    if (
      !this.ledger ||
      c.merchantApproved !== true ||
      c.chargeFlowEnabled !== true ||
      c.prepaidFeatureEnabled !== true ||
      !['PRODUCTION', 'TEST'].includes(c.prepaidEnvironment ?? '')
    )
      throw new CheckoutUnavailable(
        'Verified prepaid configuration and durable ledger are required.',
      );
    if (
      !(method === 'postfinance_pay'
        ? c.postfinancePayTokenEnabled === true
        : method === 'twint' && c.twintUserOnFileEnabled === true)
    )
      throw new CheckoutUnavailable(
        'The requested recurring payment method has not been activated.',
      );
  }

  private returnUrls(urls: { successUrl: string; failureUrl: string }) {
    if (!this.config.returnOrigin)
      throw new CheckoutUnavailable('A fixed HTTPS return origin is required.');
    const origin = new URL(this.config.returnOrigin);
    if (origin.protocol !== 'https:' || origin.username || origin.password)
      throw new Error('Invalid return origin.');
    for (const value of [urls.successUrl, urls.failureUrl]) {
      const url = new URL(value);
      if (
        url.protocol !== 'https:' ||
        url.origin !== origin.origin ||
        url.username ||
        url.password
      )
        throw new Error('Invalid checkout return URL.');
    }
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    spaceScoped = true,
    maxResponseBytes = 1_048_576,
  ): Promise<unknown> {
    const c = this.connection();
    const resourcePath = `${apiPrefix}${path}`;
    const token = await bearerToken(
      c.userId,
      c.key,
      method,
      resourcePath,
      Math.floor(this.now() / 1000),
    );
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };
    if (spaceScoped) headers.Space = String(c.spaceId);
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await this.fetcher(`${c.origin}${resourcePath}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok) throw new CheckoutApiError(response.status);
    if (response.status === 204) return null;
    const text = await responseText(response, maxResponseBytes);
    return response.headers.get('content-type')?.includes('json')
      ? JSON.parse(text)
      : text;
  }

  private async mutateOnce(
    path: string,
    body: unknown,
    businessKey: string,
  ): Promise<unknown> {
    const c = this.connection();
    if (!this.ledger || !/^[A-Za-z0-9_-]{1,120}$/.test(businessKey))
      throw new Error('Durable ledger and stable business key required.');
    const scope = `${c.origin}|${c.spaceId}|POST|${path}|${businessKey}`;
    const claim = await this.ledger.claim(scope, await fingerprint(body));
    if (claim.kind === 'completed') return JSON.parse(claim.json);
    if (claim.kind === 'conflict')
      throw new Error('The business key already has a different request body.');
    if (claim.kind === 'uncertain')
      throw new Error(
        'Reconcile the previous provider operation before any retry.',
      );
    try {
      const result = await this.request('POST', path, body);
      await this.ledger.complete(scope, JSON.stringify(result));
      return result;
    } catch (error) {
      await this.ledger.markUncertain(scope);
      throw error;
    }
  }

  async createSubscriber(
    input: {
      externalId: string;
      emailAddress: string;
      reference: string;
      language?: string;
    },
    method: SwissMethod,
  ): Promise<JsonObject> {
    this.requireRecurring(method);
    if (
      !/^[A-Za-z0-9_-]{1,120}$/.test(input.externalId) ||
      !input.emailAddress ||
      !input.reference
    )
      throw new Error('Invalid subscriber.');
    const body: JsonObject = {
      externalId: input.externalId,
      emailAddress: input.emailAddress,
      reference: input.reference,
    };
    if (input.language !== undefined) body.language = input.language;
    const result = await this.mutateOnce(
      '/subscriptions/subscribers',
      body,
      input.externalId,
    );
    object(result);
    return result;
  }

  /** Returns a SubscriptionVersion, whose subscription.id is the subscription ID. */
  async createSubscription(
    input: {
      productKey: string;
      subscriberId: number;
      reference: string;
      version: number;
    },
    method: SwissMethod,
    businessKey: string,
  ): Promise<JsonObject> {
    this.requireRecurring(method);
    const product = this.config.products?.[input.productKey];
    if (
      !product ||
      product.currency !== 'CHF' ||
      product.billingPeriod !== 'P1M' ||
      !Number.isSafeInteger(product.priceChfMinor) ||
      product.priceChfMinor <= 0 ||
      !product.methods.includes(method)
    ) {
      throw new CheckoutUnavailable(
        'A verified monthly CHF product for this method is required.',
      );
    }
    id(product.productId, 'product ID');
    id(input.subscriberId, 'subscriber ID');
    if (
      !input.reference ||
      !Number.isSafeInteger(input.version) ||
      input.version < 0
    )
      throw new Error('Invalid subscription reference or provider version.');
    const body: JsonObject = {
      product: product.productId,
      currency: 'CHF',
      subscription: {
        subscriber: input.subscriberId,
        reference: input.reference,
        version: input.version,
      },
    };
    if (product.componentConfigurations)
      body.componentConfigurations = product.componentConfigurations;
    const result = await this.mutateOnce('/subscriptions', body, businessKey);
    object(result);
    return result;
  }

  async initializeSubscriberPresent(
    subscriptionId: number,
    method: SwissMethod,
    urls: { successUrl: string; failureUrl: string },
    businessKey: string,
  ): Promise<JsonObject> {
    this.requireRecurring(method);
    id(subscriptionId, 'subscription ID');
    this.returnUrls(urls);
    const result = await this.mutateOnce(
      `/subscriptions/${subscriptionId}/initialize-subscriber-present`,
      urls,
      businessKey,
    );
    object(result);
    return result;
  }

  /** Creates an order, not an entitlement. input must come from a frozen local
   * period owned by the authenticated account, never from browser price data. */
  async createPrepaidTransaction(
    input: {
      productKey: string;
      periodId: string;
      customerReference: string;
      emailAddress: string;
      tokenId?: number;
      urls: { successUrl: string; failureUrl: string };
    },
    method: SwissMethod,
    businessKey: string,
  ): Promise<JsonObject> {
    this.requirePrepaid(method);
    const product = this.config.prepaidProducts?.[input.productKey];
    if (
      !product ||
      product.currency !== 'CHF' ||
      product.billingPeriod !== 'P1M' ||
      !Number.isSafeInteger(product.priceChfMinor) ||
      product.priceChfMinor <= 0 ||
      !/^[A-Za-z0-9_-]{1,120}$/.test(product.reference) ||
      !product.name ||
      product.name.length > 120
    )
      throw new CheckoutUnavailable(
        'A verified prepaid monthly CHF price is required.',
      );
    const configurationId = product.methodConfigurations[method];
    id(configurationId, 'payment method configuration ID');
    if (
      !/^[A-Za-z0-9_-]{1,120}$/.test(input.periodId) ||
      !/^[A-Za-z0-9_-]{1,120}$/.test(input.customerReference) ||
      !/^[^\s@]{1,128}@[^\s@]{1,128}\.[^\s@]{1,64}$/.test(input.emailAddress) ||
      input.emailAddress.length > 254
    )
      throw new Error('Invalid prepaid period or payer.');
    this.returnUrls(input.urls);
    if (input.tokenId !== undefined) id(input.tokenId, 'token ID');
    const body: JsonObject = {
      currency: 'CHF',
      // Transaction.environment is LIVE/PREVIEW, not the authorization's
      // TEST/PRODUCTION enum. Use the official creation strategy explicitly.
      environmentSelectionStrategy:
        this.config.prepaidEnvironment === 'TEST'
          ? 'FORCE_TEST_ENVIRONMENT'
          : 'FORCE_PRODUCTION_ENVIRONMENT',
      customerId: input.customerReference,
      customerEmailAddress: input.emailAddress,
      merchantReference: input.periodId,
      invoiceMerchantReference: input.periodId,
      metaData: {
        zentra_period_id: input.periodId,
        zentra_plan_version: product.reference,
      },
      lineItems: [
        {
          quantity: 1,
          name: product.name,
          amountIncludingTax: product.priceChfMinor / 100,
          type: 'PRODUCT',
          uniqueId: input.periodId,
          sku: product.reference,
          shippingRequired: false,
        },
      ],
      allowedPaymentMethodConfigurations: [configurationId],
      customersPresence:
        input.tokenId === undefined ? 'VIRTUAL_PRESENT' : 'NOT_PRESENT',
      completionBehavior: 'COMPLETE_IMMEDIATELY',
      autoConfirmationEnabled: false,
      successUrl: input.urls.successUrl,
      failedUrl: input.urls.failureUrl,
      ...(input.tokenId === undefined
        ? { tokenizationMode: 'FORCE_CREATION' }
        : { token: input.tokenId }),
    };
    const result = await this.mutateOnce(
      '/payment/transactions',
      body,
      businessKey,
    );
    object(result);
    return result;
  }

  /** Version must come from the current provider read and be frozen in the
   * local operation. Replaying the same operation never increments it. */
  async confirmPrepaidTransaction(
    transactionId: number,
    version: number,
    method: SwissMethod,
    businessKey: string,
  ): Promise<JsonObject> {
    this.requirePrepaid(method);
    id(transactionId, 'transaction ID');
    if (!Number.isSafeInteger(version) || version < 0)
      throw new Error('Invalid transaction version.');
    const result = await this.mutateOnce(
      `/payment/transactions/${transactionId}/confirm`,
      { version },
      businessKey,
    );
    object(result);
    return result;
  }

  /** Applies only to PENDING transactions. Read before this step; do not
   * confirm the renewal first. Flow selection belongs to the merchant Space. */
  async applyPrepaidChargeFlow(
    transactionId: number,
    method: SwissMethod,
    businessKey: string,
  ): Promise<JsonObject> {
    this.requirePrepaid(method);
    id(transactionId, 'transaction ID');
    const result = await this.mutateOnce(
      `/payment/transactions/${transactionId}/charge-flow/apply`,
      undefined,
      businessKey,
    );
    object(result);
    return result;
  }

  /** Stops an in-progress flow, not a captured payment. Local cancellation
   * must fence future period creation first, then reconcile a payment race. */
  async cancelPrepaidChargeFlow(
    transactionId: number,
    method: SwissMethod,
    businessKey: string,
  ): Promise<JsonObject> {
    this.requirePrepaid(method);
    id(transactionId, 'transaction ID');
    const result = await this.mutateOnce(
      `/payment/transactions/${transactionId}/charge-flow/cancel`,
      undefined,
      businessKey,
    );
    object(result);
    return result;
  }

  async readTransaction(transactionId: number): Promise<JsonObject> {
    id(transactionId, 'transaction ID');
    const result = await this.request(
      'GET',
      queryPath(`/payment/transactions/${transactionId}`, {
        expand:
          'token,paymentConnectorConfiguration.paymentMethodConfiguration.paymentMethod',
      }),
    );
    this.scopedEntity(result, transactionId);
    return result;
  }

  async readTransactionInvoice(
    invoiceId: number,
    expectedTransactionId?: number,
  ): Promise<JsonObject> {
    id(invoiceId, 'invoice ID');
    if (expectedTransactionId !== undefined)
      id(expectedTransactionId, 'transaction ID');
    const result = await this.request(
      'GET',
      `/payment/transactions/invoices/${invoiceId}`,
    );
    this.scopedEntity(result, invoiceId);
    this.transactionLink(result, 'linkedTransaction', expectedTransactionId);
    return result;
  }

  /** Exhaust the search before selecting an invoice. An empty result means
   * no invoice has been found, never that the period has been paid. */
  async findTransactionInvoice(
    transactionId: number,
  ): Promise<JsonObject | null> {
    id(transactionId, 'transaction ID');
    const invoices = await this.searchTransactionEntities(
      '/payment/transactions/invoices/search',
      `linkedTransaction:${transactionId}`,
      'linkedTransaction',
      transactionId,
      1,
    );
    if (invoices.length === 0) return null;
    const invoice = await this.readTransactionInvoice(
      invoices[0].id as number,
      transactionId,
    );
    const after = await this.searchTransactionEntities(
      '/payment/transactions/invoices/search',
      `linkedTransaction:${transactionId}`,
      'linkedTransaction',
      transactionId,
      1,
    );
    if (after.length !== 1 || after[0].id !== invoice.id)
      throw new Error('Provider invoice search changed during re-read.');
    return invoice;
  }

  async readRefund(
    refundId: number,
    expectedTransactionId?: number,
  ): Promise<JsonObject> {
    id(refundId, 'refund ID');
    if (expectedTransactionId !== undefined)
      id(expectedTransactionId, 'transaction ID');
    const result = await this.request(
      'GET',
      queryPath(`/payment/refunds/${refundId}`, { expand: 'transaction' }),
      undefined,
      true,
      maximumSearchResponseBytes,
    );
    this.scopedEntity(result, refundId);
    this.transactionLink(result, 'transaction', expectedTransactionId);
    return result;
  }

  /** A successful return proves the bounded search was exhausted and every
   * discovered refund was re-read. Unknown financial states remain raw for
   * the pure verifier; these reads never grant access or issue a refund. */
  async listTransactionRefunds(transactionId: number): Promise<JsonObject[]> {
    id(transactionId, 'transaction ID');
    const found = await this.searchTransactionEntities(
      '/payment/refunds/search',
      `transaction.id:${transactionId}`,
      'transaction',
      transactionId,
      searchPageSize * maximumSearchPages,
    );
    const refunds: JsonObject[] = [];
    let bytes = 0;
    for (const entry of found) {
      const refund = await this.readRefund(entry.id as number, transactionId);
      bytes += encoder.encode(JSON.stringify(refund)).byteLength;
      if (bytes > 1_048_576)
        throw new Error('Oversized combined refund response.');
      refunds.push(refund);
    }
    const after = await this.searchTransactionEntities(
      '/payment/refunds/search',
      `transaction.id:${transactionId}`,
      'transaction',
      transactionId,
      searchPageSize * maximumSearchPages,
    );
    if (
      after.length !== refunds.length ||
      after.some((entry, index) => entry.id !== refunds[index].id)
    )
      throw new Error('Provider refund search changed during re-read.');
    return refunds;
  }

  private scopedEntity(
    value: unknown,
    expectedId?: number,
  ): asserts value is JsonObject {
    object(value);
    id(value.id, 'provider entity ID');
    if (
      (expectedId !== undefined && value.id !== expectedId) ||
      value.linkedSpaceId !== this.connection().spaceId
    )
      throw new Error(
        'Provider entity belongs to another configured ID or space.',
      );
  }

  private transactionLink(
    value: JsonObject,
    relation: 'linkedTransaction' | 'transaction',
    expectedId?: number,
  ): void {
    let transactionId = value[relation];
    if (relation === 'transaction') {
      this.scopedEntity(transactionId);
      transactionId = transactionId.id;
    }
    id(transactionId, 'linked transaction ID');
    if (expectedId !== undefined && transactionId !== expectedId)
      throw new Error('Provider entity belongs to another transaction.');
  }

  /** Official v2 search envelope: data/offset/hasMore/limit. Neither missing
   * metadata nor a partial/unstable result may be treated as complete. */
  private async searchTransactionEntities(
    path: string,
    query: string,
    relation: 'linkedTransaction' | 'transaction',
    transactionId: number,
    maximumResults: number,
  ): Promise<JsonObject[]> {
    const results: JsonObject[] = [];
    let offset = 0,
      previousId = 0;
    for (let page = 0; page < maximumSearchPages; page++) {
      const parameters = {
        ...(relation === 'transaction' ? { expand: 'transaction' } : {}),
        limit: searchPageSize,
        offset,
        order: 'id:ASC',
        query,
      };
      const response = await this.request(
        'GET',
        queryPath(path, parameters),
        undefined,
        true,
        maximumSearchResponseBytes,
      );
      object(response);
      if (
        !Array.isArray(response.data) ||
        typeof response.hasMore !== 'boolean' ||
        response.offset !== offset ||
        !Number.isSafeInteger(response.limit) ||
        (response.limit as number) < 1 ||
        (response.limit as number) > searchPageSize ||
        response.data.length > (response.limit as number) ||
        (response.data.length === 0 && (response.hasMore || page > 0))
      )
        throw new Error(
          'Incomplete or non-progressing provider search response.',
        );
      for (const entry of response.data) {
        this.scopedEntity(entry);
        this.transactionLink(entry, relation, transactionId);
        if ((entry.id as number) <= previousId)
          throw new Error('Repeated or unordered provider search result.');
        previousId = entry.id as number;
        results.push(entry);
        if (results.length > maximumResults)
          throw new Error('Ambiguous or excessive provider search result.');
      }
      if (!response.hasMore) return results;
      offset += response.data.length;
    }
    throw new Error(
      'Provider search exceeded the configured pagination bound.',
    );
  }

  async readToken(tokenId: number): Promise<JsonObject> {
    id(tokenId, 'token ID');
    const result = await this.request('GET', `/payment/tokens/${tokenId}`);
    object(result);
    return result;
  }

  async readActiveTokenVersion(tokenId: number): Promise<JsonObject> {
    id(tokenId, 'token ID');
    const result = await this.request(
      'GET',
      queryPath(`/payment/tokens/${tokenId}/active-version`, {
        expand:
          'token,paymentMethod,paymentConnectorConfiguration.paymentMethodConfiguration.paymentMethod',
      }),
    );
    object(result);
    return result;
  }

  async readSubscription(subscriptionId: number): Promise<JsonObject> {
    id(subscriptionId, 'subscription ID');
    const result = await this.request(
      'GET',
      `/subscriptions/${subscriptionId}`,
    );
    object(result);
    return result;
  }

  async paymentPageUrl(transactionId: number): Promise<string> {
    id(transactionId, 'transaction ID');
    const result = await this.request(
      'GET',
      `/payment/transactions/${transactionId}/payment-page-url`,
    );
    if (typeof result !== 'string')
      throw new Error('Expected provider payment-page URL.');
    const url = new URL(result);
    if (
      url.protocol !== 'https:' ||
      url.origin !== this.connection().origin ||
      url.username ||
      url.password
    )
      throw new Error('Unapproved payment-page URL.');
    return url.href;
  }

  async webhookPublicKey(keyId: string): Promise<string> {
    if (!/^[A-Za-z0-9-]{1,128}$/.test(keyId))
      throw new Error('Invalid webhook key ID.');
    const result = await this.request(
      'GET',
      `/webhooks/encryption-keys/${encodeURIComponent(keyId)}`,
      undefined,
      false,
      4096,
    );
    if (typeof result !== 'string')
      throw new Error('Expected Base64 SPKI public key.');
    return result;
  }
}

/** Convert strict ASN.1 DER ECDSA r/s to the P1363 encoding required by WebCrypto. */
export function derToP1363(der: Uint8Array): Uint8Array {
  if (
    der.length < 8 ||
    der.length > 72 ||
    der[0] !== 0x30 ||
    der[1] !== der.length - 2
  )
    throw new Error('Invalid P-256 DER signature.');
  let cursor = 2;
  const output = new Uint8Array(64);
  for (let scalar = 0; scalar < 2; scalar++) {
    if (der[cursor++] !== 0x02) throw new Error('Invalid DER integer.');
    const length = der[cursor++];
    if (!length || length > 33 || cursor + length > der.length)
      throw new Error('Invalid DER scalar length.');
    let part = der.slice(cursor, cursor + length);
    cursor += length;
    if (part[0] & 0x80) throw new Error('Negative DER scalar.');
    if (part.length > 1 && part[0] === 0) {
      if (!(part[1] & 0x80)) throw new Error('Non-minimal DER scalar.');
      part = part.slice(1);
    }
    if (part.length > 32 || part.every((byte) => byte === 0))
      throw new Error('Invalid ECDSA scalar.');
    output.set(part, scalar * 32 + 32 - part.length);
  }
  if (cursor !== der.length) throw new Error('Trailing DER signature data.');
  return output;
}

export async function verifyWebhookSignature(
  rawBody: Uint8Array,
  signatureHeader: string,
  keyResolver: (keyId: string) => Promise<string>,
): Promise<void> {
  if (rawBody.length > 65_536) throw new Error('Oversized webhook.');
  const match =
    /^algorithm=SHA256withECDSA,\s*keyId=([A-Za-z0-9-]{1,128}),\s*signature=([A-Za-z0-9+/=]+)$/.exec(
      signatureHeader,
    );
  if (!match)
    throw new Error('Invalid or unsupported webhook signature header.');
  const signature = bytesBase64(match[2]);
  const candidates: Uint8Array[] = [];
  if (signature.length === 64) candidates.push(signature);
  try {
    candidates.push(derToP1363(signature));
  } catch {
    /* P1363 may not be DER. */
  }
  if (!candidates.length)
    throw new Error('Invalid webhook signature encoding.');
  const publicKey = await crypto.subtle.importKey(
    'spki',
    bufferSource(bytesBase64(await keyResolver(match[1]))),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  for (const candidate of candidates) {
    if (
      await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        publicKey,
        bufferSource(candidate),
        bufferSource(rawBody),
      )
    )
      return;
  }
  throw new Error('Invalid webhook signature.');
}

/** Authenticate bytes before parsing; accept durable work once. Re-read provider state for entitlements. */
export async function acceptWebhook(
  rawBody: Uint8Array,
  signatureHeader: string,
  dependencies: {
    keyResolver: (keyId: string) => Promise<string>;
    inbox: WebhookInbox;
    apiOrigin: string;
    spaceId: number;
    allowedListenerIds: number[];
    now?: () => number;
    maxEventAgeMs?: number;
  },
): Promise<{ event: CheckoutWebhook; duplicate: boolean }> {
  if (!approvedOrigins.has(dependencies.apiOrigin))
    throw new Error('Invalid webhook origin scope.');
  await verifyWebhookSignature(
    rawBody,
    signatureHeader,
    dependencies.keyResolver,
  );
  const data: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(rawBody),
  );
  object(data);
  for (const key of [
    'eventId',
    'entityId',
    'spaceId',
    'webhookListenerId',
    'listenerEntityId',
  ])
    id(data[key], key);
  if (
    data.spaceId !== dependencies.spaceId ||
    !dependencies.allowedListenerIds.includes(data.webhookListenerId as number)
  )
    throw new Error('Webhook belongs to another configured space or listener.');
  if (
    typeof data.timestamp !== 'string' ||
    !Number.isFinite(Date.parse(data.timestamp))
  )
    throw new Error('Invalid webhook timestamp.');
  const age = (dependencies.now ?? Date.now)() - Date.parse(data.timestamp);
  if (age < -600_000) throw new Error('Webhook timestamp is in the future.');
  if (
    dependencies.maxEventAgeMs !== undefined &&
    (!Number.isFinite(dependencies.maxEventAgeMs) ||
      dependencies.maxEventAgeMs <= 0 ||
      age > dependencies.maxEventAgeMs)
  )
    throw new Error('Webhook exceeds the configured event-age policy.');
  const event = data as unknown as CheckoutWebhook;
  const scope = `${dependencies.apiOrigin}|${event.spaceId}|${event.webhookListenerId}|${event.eventId}`;
  const accepted = await dependencies.inbox.acceptOnce(scope, event);
  return { event, duplicate: !accepted };
}
