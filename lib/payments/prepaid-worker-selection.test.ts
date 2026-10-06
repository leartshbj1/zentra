import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

const runtime = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/runtime', () => ({
  database: () => runtime.db,
  runtimeValue: () => '',
  stripeConfiguration: () => ({ secretKey: '', priceIds: {}, signingKey: '' }),
}));
vi.mock('@/app/zentra-auth', () => ({ getZentraUser: async () => null }));
vi.mock('@/lib/site-language-server', () => ({
  currentSiteLanguage: () => 'fr',
}));
vi.mock('stripe', () => ({
  default: class {
    constructor() {
      throw Error('No merchant SDK in worker selection tests.');
    }
    static createFetchHttpClient() {
      throw Error('No Stripe HTTP.');
    }
  },
}));
import { LEGAL_VERSION } from '@/lib/legal';
import { prepaidCatalog } from './prepaid-catalog';
import { prepaidMonthlyPeriod } from './prepaid-calendar';
import {
  prepareInitialPrepaidPurchase,
  type PrepaidPurchaseConfiguration,
} from './prepaid-purchase-preparation';
import { D1PrepaidPeriods } from './prepaid-periods';
import { D1PurchaseIntents } from './purchase-intents';
import { D1PostFinanceWebhookInbox } from './postfinance-store';
import { D1PrepaidProvisioning } from './prepaid-provisioning';
import { D1PrepaidTokens } from './prepaid-token';
import {
  PostFinanceCheckoutClient,
  type JsonObject,
} from './postfinance-client';
import { runPrepaidRenewal } from './prepaid-renewal';
import {
  cancelPrepaidRenewal,
  stopCancelledPrepaidFlows,
} from './prepaid-cancellation';
import { runPostFinanceBillingWorker } from './postfinance-billing-worker-route';
import {
  D1PrepaidRenewalAdmission,
  RENEWAL_ADMISSION_LEASE_SECONDS,
} from './prepaid-renewal-admission';

type Prepared = Extract<
  Awaited<ReturnType<typeof prepareInitialPrepaidPurchase>>,
  { state: 'prepared' }
>;
type Company = {
  prepared: Prepared;
  user: { userId: string; email: string; emailConfirmed: boolean };
  index: number;
};
const origin = 'https://checkout.postfinance.ch',
  site = 'https://zentra.example.test';
let sql: DatabaseSync,
  clock: number,
  configuration: PrepaidPurchaseConfiguration;
let current: Company, index: number, nextTransaction: number;
let calls: { method: string; path: string; body: JsonObject | null }[];
let transactions: Map<number, JsonObject>,
  tokens: Map<number, JsonObject>,
  versions: Map<number, JsonObject>;
let transport: ReturnType<typeof vi.fn>;
let override:
  | ((
      path: string,
      method: string,
    ) => Response | undefined | Promise<Response | undefined>)
  | undefined;
function setTime(seconds: number) {
  clock = seconds;
  vi.setSystemTime(seconds * 1000);
}
const seconds = (date: string) => Date.parse(date) / 1000;
const count = (table: string) =>
  Number(sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n);
function d1() {
  return {
    prepare(query: string) {
      let values: SQLInputValue[] = [];
      const statement = {
        bind(...args: SQLInputValue[]) {
          values = args;
          return statement;
        },
        execute() {
          return { success: true, meta: sql.prepare(query).run(...values) };
        },
        async run() {
          return statement.execute();
        },
        async first() {
          return sql.prepare(query).get(...values) ?? null;
        },
        async all() {
          return { results: sql.prepare(query).all(...values) };
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
const connector = () => ({
  id: 92,
  linkedSpaceId: 405,
  state: 'ACTIVE',
  paymentMethodConfiguration: {
    id: 91,
    linkedSpaceId: 405,
    state: 'ACTIVE',
    paymentMethod: { id: 99 },
  },
});
function config(): PrepaidPurchaseConfiguration {
  return {
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
      authenticationKeyBase64: Buffer.alloc(32, 7).toString('base64'),
      returnOrigin: site,
      prepaidProducts: Object.fromEntries(
        prepaidCatalog().map((p) => [
          p.productKey,
          {
            currency: 'CHF',
            billingPeriod: 'P1M',
            priceChfMinor: p.priceChfMinor,
            reference: p.catalogVersion,
            name: p.name,
            methodConfigurations: { postfinance_pay: 91 },
          },
        ]),
      ),
    },
  };
}
async function company(date = '2026-01-31T09:17:23Z'): Promise<Company> {
  const n = ++index;
  setTime(seconds(date));
  const user = {
    userId: `worker-owner-${n}`,
    email: `owner-${n}@example.test`,
    emailConfirmed: true,
  };
  const organizationId = `worker-company-${n}`,
    subscriptionId = `trial-worker-${n}`;
  sql
    .prepare(
      "INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,updated_at) VALUES(?,?,?,'incomplete',0,?)",
    )
    .run(subscriptionId, 'local', 'local', clock);
  sql
    .prepare(
      'INSERT INTO organizations(organization_id,name,subscription_id,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?)',
    )
    .run(
      organizationId,
      'Fictional company',
      subscriptionId,
      user.userId,
      clock,
      clock,
    );
  sql
    .prepare(
      "INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES(?,?,?,?,'owner',?)",
    )
    .run(`worker-member-${n}`, organizationId, user.userId, user.email, clock);
  const result = await prepareInitialPrepaidPurchase(
    configuration,
    {
      user,
      requestId: `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`,
      productKey: 'gestion:start',
      organizationId,
      method: 'postfinance_pay',
      acceptTerms: true,
      legalVersion: LEGAL_VERSION,
    },
    { database: () => d1(), now: () => clock },
  );
  if (result.state !== 'prepared') throw Error('Expected real preparation.');
  const transactionId = 100 * n + 71,
    invoiceId = 100 * n + 81,
    tokenId = 100 * n + 1;
  const intents = new D1PurchaseIntents(d1(), () => clock);
  await intents.markDispatched(result.intent);
  await new D1PrepaidPeriods(d1(), () => clock).bindTransaction(
    result.period.periodId,
    transactionId,
  );
  await intents.bindProviderReference(result.intent, String(transactionId));
  const inbox = new D1PostFinanceWebhookInbox(
    d1(),
    {
      apiOrigin: origin,
      spaceId: 405,
      listeners: [{ id: 10, entityId: 20, technicalName: 'Transaction' }],
    },
    () => clock,
  );
  await inbox.acceptOnce(`${origin}|405|10|${n}`, {
    eventId: n,
    entityId: transactionId,
    spaceId: 405,
    webhookListenerId: 10,
    listenerEntityId: 20,
    listenerEntityTechnicalName: 'Transaction',
    timestamp: new Date(clock * 1000).toISOString(),
  });
  const work = (await inbox.claimNext())!;
  await new D1PrepaidProvisioning(d1(), () => clock).provision(
    {
      periodId: result.period.periodId,
      transactionId,
      invoiceId,
      apiOrigin: origin,
      spaceId: 405,
      environment: 'PRODUCTION',
      ownerId: user.userId,
      organizationId,
      workspaceId: null,
      startsAt: result.period.startsAt,
      endsAt: result.period.endsAt,
      currency: 'CHF',
      priceChfMinor: 5900,
      catalogVersion: result.period.catalogVersion,
      evidenceFingerprint: String(n % 10).repeat(64),
    },
    work,
  );
  transactions.set(transactionId, {
    id: transactionId,
    linkedSpaceId: 405,
    version: 2,
    state: 'FULFILL',
    environment: 'LIVE',
    authorizationEnvironment: 'PRODUCTION',
    currency: 'CHF',
    totalSettledAmount: 59,
    refundedAmount: 0,
    customerId: result.expectation.customerReference,
    merchantReference: result.period.periodId,
    metaData: {
      zentra_period_id: result.period.periodId,
      zentra_plan_version: result.period.catalogVersion,
    },
    tokenizationMode: 'FORCE_CREATION',
    customersPresence: 'VIRTUAL_PRESENT',
    token: { id: tokenId },
    paymentConnectorConfiguration: connector(),
  });
  tokens.set(tokenId, {
    id: tokenId,
    linkedSpaceId: 405,
    version: 0,
    state: 'ACTIVE',
    customerId: result.expectation.customerReference,
  });
  versions.set(tokenId, {
    id: tokenId + 1,
    linkedSpaceId: 405,
    version: 0,
    state: 'ACTIVE',
    environment: 'PRODUCTION',
    token: { id: tokenId },
    paymentConnectorConfiguration: connector(),
    paymentMethod: { id: 99 },
  });
  const tokenStore = new D1PrepaidTokens(d1(), () => clock);
  const expected = await tokenStore.initialContext(
    result.contract.contractId,
    'postfinance_pay',
  );
  if (!expected) throw Error('Expected closed initial handoff.');
  await tokenStore.bindInitial(
    new PostFinanceCheckoutClient(configuration.connection, {
      fetch: transport as typeof fetch,
      now: () => clock * 1000,
    }),
    expected,
    work,
  );
  await inbox.completeWork(work);
  return { prepared: result, user, index: n };
}
const renew = (c: Company) =>
  runPrepaidRenewal(
    configuration,
    { contractId: c.prepared.contract.contractId, ordinal: 1 },
    {
      database: () => d1(),
      now: () => clock,
      fetch: transport as typeof fetch,
    },
  );
const cancel = (c: Company) =>
  cancelPrepaidRenewal(d1(), c.user, c.prepared.contract.contractId, clock);
const stop = () =>
  stopCancelledPrepaidFlows(configuration, {
    database: () => d1(),
    now: () => clock,
    fetch: transport as typeof fetch,
  });
function read(name: string) {
  const values: Record<string, string> = {
    POSTFINANCE_BILLING_WORKER_ENABLED: 'true',
    POSTFINANCE_BILLING_WORKER_TOKEN: 'A'.repeat(43),
    POSTFINANCE_MERCHANT_APPROVED: 'true',
    POSTFINANCE_CHARGE_FLOW_ENABLED: 'true',
    POSTFINANCE_SETTLEMENT_EVIDENCE_VERIFIED: 'true',
    POSTFINANCE_API_ORIGIN: origin,
    POSTFINANCE_APPLICATION_USER_ID: '512',
    POSTFINANCE_AUTHENTICATION_KEY_BASE64: Buffer.alloc(32, 7).toString(
      'base64',
    ),
    POSTFINANCE_SPACE_ID: '405',
    POSTFINANCE_RETURN_ORIGIN: site,
    POSTFINANCE_PREPAID_ENVIRONMENT: 'PRODUCTION',
    POSTFINANCE_PRODUCTION_ENABLED: 'true',
    POSTFINANCE_PAY_TOKEN_ENABLED: 'true',
    POSTFINANCE_PREPAID_CATALOG_JSON: JSON.stringify(
      configuration.connection.prepaidProducts,
    ),
    POSTFINANCE_PREPAID_CONNECTORS_JSON: JSON.stringify(
      configuration.connectorConfigurations,
    ),
  };
  return values[name] ?? '';
}
const worker = (body?: string) =>
  runPostFinanceBillingWorker(
    new Request(`${site}/api/payments/postfinance/billing-worker`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + 'A'.repeat(43),
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body }),
    }),
    {
      read,
      database: () => d1(),
      now: () => clock * 1000,
      fetch: transport as typeof fetch,
    },
  );
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  index = 0;
  nextTransaction = 1000;
  calls = [];
  override = undefined;
  transactions = new Map();
  tokens = new Map();
  versions = new Map();
  configuration = config();
  setTime(seconds('2026-01-31T09:17:23Z'));
  sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  sql.function('unixepoch', () => clock);
  for (const file of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((f) => f.endsWith('.sql'))
    .sort())
    sql.exec(
      readFileSync(new URL('../../drizzle/' + file, import.meta.url), 'utf8'),
    );
  runtime.db = d1();
  transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' || input instanceof URL
        ? String(input)
        : input.url,
    );
    if (url.origin !== origin) throw Error('Unexpected external origin.');
    const method = init?.method ?? 'GET',
      path = url.pathname,
      body =
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as JsonObject)
          : null;
    calls.push({ method, path, body });
    const response = await override?.(path, method);
    if (response) return response;
    const tokenPath = path.match(/\/tokens\/(\d+)(\/active-version)?$/);
    if (method === 'GET' && tokenPath)
      return Response.json(
        tokenPath[2]
          ? versions.get(Number(tokenPath[1]))
          : tokens.get(Number(tokenPath[1])),
      );
    const transactionPath = path.match(
      /\/transactions\/(\d+)(\/charge-flow\/(apply|cancel))?$/,
    );
    if (method === 'GET' && transactionPath)
      return Response.json(transactions.get(Number(transactionPath[1])));
    if (
      method === 'POST' &&
      path === '/api/v2.0/payment/transactions' &&
      body
    ) {
      const id = nextTransaction++;
      const tx: JsonObject = {
        ...body,
        id,
        linkedSpaceId: 405,
        version: 0,
        state: 'PENDING',
        environment: 'LIVE',
        authorizationEnvironment: null,
        authorizationAmount: 59,
        token: { id: body.token },
        paymentConnectorConfiguration: null,
      };
      transactions.set(id, tx);
      return Response.json(tx);
    }
    if (method === 'POST' && transactionPath && transactionPath[3]) {
      const tx = transactions.get(Number(transactionPath[1]));
      if (!tx) throw Error('Unknown fictional transaction.');
      if (transactionPath[3] === 'apply') {
        if (tx.state !== 'PENDING') throw Error('Apply requires PENDING.');
        tx.state = 'PROCESSING';
      }
      return Response.json(tx);
    }
    throw Error('Unexpected fictional provider operation.');
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw Error('Real network is forbidden.');
  });
  current = await company();
  calls = [];
  transport.mockClear();
});
afterEach(() => {
  sql?.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('bounded cancellation selection never mistakes a terminal observation for a stop or payment', () => {
  it.each(['FULFILL', 'COMPLETED', 'FAILED', 'DECLINE', 'VOIDED'])(
    'removes a bound %s renewal once, then reaches the next cancellation job',
    async (state) => {
      const other = await company();
      setTime(current.prepared.period.endsAt);
      const a = await renew(current),
        b = await renew(other);
      await cancel(current);
      await cancel(other);
      transactions.get(a.transactionId!)!.state = state;
      calls = [];
      expect(await stop()).toMatchObject({
        inspected: 1,
        stopped: 0,
        terminalObserved: 1,
        uncertain: 0,
      });
      expect(calls.every((call) => call.method === 'GET')).toBe(true);
      expect(
        sql
          .prepare(
            'SELECT state FROM prepaid_flow_cancellations WHERE transaction_id=?',
          )
          .get(a.transactionId!)?.state,
      ).toBe('completed');
      expect(count('prepaid_settlement_proofs')).toBe(2);
      expect(await stop()).toMatchObject({
        inspected: 1,
        stopped: 1,
        terminalObserved: 0,
        uncertain: 0,
      });
      expect(
        calls.filter((call) => call.method === 'POST').map((call) => call.path),
      ).toEqual([
        `/api/v2.0/payment/transactions/${b.transactionId}/charge-flow/cancel`,
      ]);
      expect(await stop()).toMatchObject({ inspected: 0 });
    },
  );
  it('does not persist or act on a terminal transaction with a foreign payer or changed invoice line', async () => {
    setTime(current.prepared.period.endsAt);
    const renewal = await renew(current);
    await cancel(current);
    const tx = transactions.get(renewal.transactionId!)!;
    tx.state = 'FULFILL';
    tx.customerId = 'foreign-customer';
    calls = [];
    expect(await stop()).toMatchObject({
      terminalObserved: 0,
      stopped: 0,
      uncertain: 1,
    });
    expect(count('prepaid_flow_cancellations')).toBe(0);
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
    tx.customerId = current.prepared.expectation.customerReference;
    (tx.lineItems as JsonObject[])[0].amountIncludingTax = 1;
    expect(await stop()).toMatchObject({
      terminalObserved: 0,
      stopped: 0,
      uncertain: 1,
    });
    expect(count('prepaid_flow_cancellations')).toBe(0);
  });
});

describe('private worker selects only an exact anchored, not yet dispatched current renewal', () => {
  it('accepts the actual empty JSON pg_net envelope and dispatches each period once', async () => {
    setTime(current.prepared.period.endsAt);
    calls = [];
    const response = await worker('{}');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ renewal: 'submitted' });
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(2);
    const after = calls.length;
    expect(await (await worker('{}')).json()).toMatchObject({
      renewal: 'idle',
    });
    expect(calls).toHaveLength(after);
    expect(count('prepaid_settlement_proofs')).toBe(1);
  });
  it.each([
    ['2025-12-31T09:17:23Z', '2026-02-28T09:17:23Z'],
    ['2026-01-29T09:17:23Z', '2026-03-30T09:17:23Z'],
    ['2026-01-30T09:17:23Z', '2026-03-30T09:17:23Z'],
  ])(
    'skips the expired window anchored at %s without blocking another company',
    async (anchor, now) => {
      const expired = await company(anchor);
      setTime(seconds(now));
      calls = [];
      const response = await worker();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ renewal: 'submitted' });
      expect(
        sql
          .prepare(
            'SELECT COUNT(*) AS n FROM prepaid_periods WHERE contract_id=?',
          )
          .get(expired.prepared.contract.contractId)?.n,
      ).toBe(1);
      const period = sql
        .prepare(
          'SELECT starts_at,ends_at FROM prepaid_periods WHERE contract_id=? AND ordinal=1',
        )
        .get(current.prepared.contract.contractId)!;
      expect(period.starts_at).toBe(current.prepared.period.endsAt);
      expect(period.ends_at).toBe(seconds('2026-03-31T09:17:23Z'));
      expect(calls.filter((call) => call.method === 'POST')).toHaveLength(2);
    },
  );
  it('uses leap February and keeps the original day and UTC time through the exclusive end', async () => {
    const leap = await company('2024-01-30T09:17:23Z');
    setTime(seconds('2024-03-29T09:17:23Z'));
    calls = [];
    const response = await worker();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ renewal: 'submitted' });
    const dates = prepaidMonthlyPeriod(seconds('2024-01-30T09:17:23Z'), 1);
    expect(dates.startSeconds).toBe(seconds('2024-02-29T09:17:23Z'));
    expect(
      sql
        .prepare(
          'SELECT ends_at FROM prepaid_periods WHERE contract_id=? AND ordinal=1',
        )
        .get(leap.prepared.contract.contractId)?.ends_at,
    ).toBe(dates.endSeconds);
    setTime(dates.endSeconds);
    calls = [];
    const expired = await worker();
    expect(expired.status).toBe(200);
    expect(await expired.json()).toMatchObject({ renewal: 'idle' });
    expect(calls).toHaveLength(0);
  });
  it('skips a submitted flow durably, so the next eligible company is not starved', async () => {
    const other = await company();
    setTime(current.prepared.period.endsAt);
    const first = await worker();
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ renewal: 'submitted' });
    calls = [];
    const second = await worker();
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ renewal: 'submitted' });
    expect(
      sql
        .prepare(
          'SELECT COUNT(*) AS n FROM prepaid_renewal_requests WHERE contract_id=?',
        )
        .get(other.prepared.contract.contractId)?.n,
    ).toBe(1);
    const third = await worker();
    expect(third.status).toBe(200);
    expect(await third.json()).toMatchObject({ renewal: 'idle' });
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(2);
  });
  it('does not reissue an uncertain create and still advances to the next company', async () => {
    const other = await company();
    setTime(current.prepared.period.endsAt);
    override = (path, method) => {
      if (method === 'POST' && path === '/api/v2.0/payment/transactions')
        throw Error('Lost accepted response.');
      return undefined;
    };
    expect((await renew(current)).state).toBe('uncertain');
    override = undefined;
    calls = [];
    const response = await worker();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ renewal: 'submitted' });
    expect(
      sql
        .prepare(
          'SELECT COUNT(*) AS n FROM prepaid_renewal_requests WHERE contract_id=?',
        )
        .get(other.prepared.contract.contractId)?.n,
    ).toBe(1);
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(2);
    expect(count('prepaid_settlement_proofs')).toBe(2);
  });
  it('does not repeat an uncertain ChargeFlow and reaches another due company', async () => {
    const other = await company();
    setTime(current.prepared.period.endsAt);
    override = (path, method) => {
      if (method === 'POST' && path.endsWith('/charge-flow/apply')) {
        transactions.get(1000)!.state = 'PROCESSING';
        throw Error('Flow accepted, response lost.');
      }
      return undefined;
    };
    expect((await renew(current)).state).toBe('uncertain');
    override = undefined;
    calls = [];
    const response = await worker();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ renewal: 'submitted' });
    expect(
      calls.filter((call) => call.method === 'POST').map((call) => call.path),
    ).toEqual([
      '/api/v2.0/payment/transactions',
      '/api/v2.0/payment/transactions/1001/charge-flow/apply',
    ]);
    expect(
      sql
        .prepare(
          'SELECT COUNT(*) AS n FROM prepaid_renewal_requests WHERE contract_id=?',
        )
        .get(other.prepared.contract.contractId)?.n,
    ).toBe(1);
  });
  it('resumes an exclusively local prepared request that never claimed a merchant operation', async () => {
    setTime(current.prepared.period.endsAt);
    const database = d1(),
      prepare = database.prepare.bind(database);
    database.prepare = ((query: string) => {
      const statement = prepare(query);
      if (query.startsWith('INSERT INTO postfinance_mutations'))
        statement.run = async () => {
          throw Error('Database interruption before atomic financial claim.');
        };
      return statement;
    }) as D1Database['prepare'];
    expect(
      (
        await runPrepaidRenewal(
          configuration,
          { contractId: current.prepared.contract.contractId, ordinal: 1 },
          {
            database: () => database,
            now: () => clock,
            fetch: transport as typeof fetch,
          },
        )
      ).state,
    ).toBe('uncertain');
    expect(count('prepaid_renewal_requests')).toBe(1);
    expect(count('postfinance_mutations')).toBe(0);
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
    calls = [];
    const response = await worker();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ renewal: 'submitted' });
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(2);
  });
  it('does not start one second before the original UTC due time', async () => {
    setTime(current.prepared.period.endsAt - 1);
    calls = [];
    const early = await worker();
    expect(early.status).toBe(200);
    expect(await early.json()).toMatchObject({ renewal: 'idle' });
    expect(calls).toHaveLength(0);
    setTime(current.prepared.period.endsAt);
    const due = await worker();
    expect(due.status).toBe(200);
    expect(await due.json()).toMatchObject({ renewal: 'submitted' });
  });
  it('resumes a completed create without a second create POST after local interruption before binding', async () => {
    setTime(current.prepared.period.endsAt);
    let failed = false;
    const database = d1(),
      prepare = database.prepare.bind(database);
    database.prepare = ((query: string) => {
      const statement = prepare(query);
      if (query.startsWith('INSERT INTO prepaid_transactions')) {
        statement.run = async () => {
          failed = true;
          throw Error(
            'Local binding interrupted after completed merchant receipt.',
          );
        };
      }
      return statement;
    }) as D1Database['prepare'];
    expect(
      (
        await runPrepaidRenewal(
          configuration,
          { contractId: current.prepared.contract.contractId, ordinal: 1 },
          {
            database: () => database,
            now: () => clock,
            fetch: transport as typeof fetch,
          },
        )
      ).state,
    ).toBe('uncertain');
    expect(failed).toBe(true);
    calls = [];
    const response = await worker();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ renewal: 'submitted' });
    expect(
      calls.filter((call) => call.method === 'POST').map((call) => call.path),
    ).toEqual(['/api/v2.0/payment/transactions/1000/charge-flow/apply']);
  });
});

describe('durable mandate admission is fair without reauthorizing any financial operation', () => {
  const scope = {
    apiOrigin: origin,
    spaceId: 405,
    environment: 'PRODUCTION' as const,
  };
  const admissions = () => new D1PrepaidRenewalAdmission(d1(), () => clock);
  const admissionRow = (company: Company) =>
    sql
      .prepare(
        'SELECT * FROM prepaid_renewal_admissions WHERE contract_id=? AND ordinal=1',
      )
      .get(company.prepared.contract.contractId)!;

  it.each([0, 60])(
    'a refused first mandate leaves the next company eligible even after %s seconds',
    async (delay) => {
      const blocked = await company('2026-01-31T09:17:00Z');
      setTime(current.prepared.period.endsAt);
      tokens.get(100 * blocked.index + 1)!.customerId =
        'foreign-fictional-payer';
      calls = [];
      const first = await worker('{}');
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({
        stopped: 0,
        terminalObserved: 0,
        uncertain: 0,
        renewal: 'idle',
      });
      expect(calls.every((call) => call.method === 'GET')).toBe(true);
      expect(count('prepaid_renewal_requests')).toBe(0);
      expect(count('postfinance_mutations')).toBe(0);
      const deferred = admissionRow(blocked);
      expect(deferred.failure_count).toBe(1);
      expect(deferred.last_failure_code).toBe('mandate_rejected');
      expect(deferred.retry_at).toBe(clock + 60);
      expect(deferred.lease_token).toBeNull();
      setTime(clock + delay);
      calls = [];
      const second = await worker('{}');
      expect(second.status).toBe(200);
      expect(await second.json()).toMatchObject({ renewal: 'submitted' });
      expect(calls.filter((call) => call.method === 'POST')).toHaveLength(2);
      expect(
        sql
          .prepare(
            'SELECT COUNT(*) AS n FROM prepaid_renewal_requests WHERE contract_id=?',
          )
          .get(blocked.prepared.contract.contractId)?.n,
      ).toBe(0);
      expect(
        sql
          .prepare(
            'SELECT COUNT(*) AS n FROM prepaid_renewal_requests WHERE contract_id=?',
          )
          .get(current.prepared.contract.contractId)?.n,
      ).toBe(1);
      expect(count('prepaid_settlement_proofs')).toBe(2);
    },
  );

  it('records a slow pre-dispatch GET failure and advances another company on the next invocation', async () => {
    const blocked = await company('2026-01-31T09:17:00Z');
    setTime(current.prepared.period.endsAt);
    const initialPath = `/api/v2.0/payment/transactions/${100 * blocked.index + 71}`;
    override = (path, method) => {
      if (method === 'GET' && path === initialPath) {
        setTime(clock + 110);
        throw Error('Fictional GET transport timeout.');
      }
      return undefined;
    };
    calls = [];
    const first = await worker('{}');
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ renewal: 'idle', uncertain: 0 });
    expect(admissionRow(blocked).last_failure_code).toBe('mandate_unavailable');
    expect(count('postfinance_mutations')).toBe(0);
    expect(calls).toHaveLength(1);
    override = undefined;
    calls = [];
    expect(await (await worker('{}')).json()).toMatchObject({
      renewal: 'submitted',
    });
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(2);
  });

  it('atomically acquires one scheduling lease under eight simultaneous claims', async () => {
    setTime(current.prepared.period.endsAt);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => admissions().claimNext(scope)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(count('prepaid_renewal_admissions')).toBe(1);
    expect(admissionRow(current).lease_token).toBe(
      results.find(Boolean)!.lease_token,
    );
    expect(calls).toHaveLength(0);
    expect(count('postfinance_mutations')).toBe(0);
  });

  it('reclaims only an expired scheduling lease and prevents the former holder overwriting the new one', async () => {
    setTime(current.prepared.period.endsAt);
    const first = (await admissions().claimNext(scope))!;
    expect(first).not.toBeNull();
    expect(await admissions().claimNext(scope)).toBeNull();
    setTime(clock + RENEWAL_ADMISSION_LEASE_SECONDS);
    const second = (await admissions().claimNext(scope))!;
    expect(second.lease_token).not.toBe(first.lease_token);
    expect(await admissions().defer(first, 'mandate_rejected')).toBe(false);
    expect(await admissions().complete(first)).toBe(false);
    expect(admissionRow(current).lease_token).toBe(second.lease_token);
    expect(await admissions().defer(second, 'mandate_rejected')).toBe(true);
    expect(admissionRow(current).failure_count).toBe(1);
    expect(count('postfinance_mutations')).toBe(0);
  });

  it('bounds repeated mandate backoff and the failure counter without mutating paid evidence or tokens', async () => {
    setTime(current.prepared.period.endsAt);
    const before = JSON.stringify(
      sql.prepare('SELECT * FROM prepaid_tokens').all(),
    );
    for (let n = 1; n <= 10; n++) {
      const lease = (await admissions().claimNext(scope))!;
      expect(lease).not.toBeNull();
      expect(await admissions().defer(lease, 'mandate_rejected')).toBe(true);
      const row = admissionRow(current);
      expect(row.failure_count).toBe(Math.min(n, 8));
      expect(Number(row.retry_at) - clock).toBe(
        Math.min(3600, 60 * 2 ** Math.min(n - 1, 6)),
      );
      expect(await admissions().claimNext(scope)).toBeNull();
      setTime(Number(row.retry_at));
    }
    expect(
      JSON.stringify(sql.prepare('SELECT * FROM prepaid_tokens').all()),
    ).toBe(before);
    expect(count('prepaid_settlement_proofs')).toBe(1);
    expect(count('postfinance_mutations')).toBe(0);
  });

  it('keeps the exact configured environment and merchant scope in atomic selection', async () => {
    setTime(current.prepared.period.endsAt);
    expect(
      await admissions().claimNext({ ...scope, environment: 'TEST' }),
    ).toBeNull();
    expect(await admissions().claimNext({ ...scope, spaceId: 406 })).toBeNull();
    expect(count('prepaid_renewal_admissions')).toBe(0);
    expect(calls).toHaveLength(0);
    expect(await admissions().claimNext(scope)).not.toBeNull();
  });

  it('rechecks cancellation on both sides of scheduling acquisition before any merchant call', async () => {
    setTime(current.prepared.period.endsAt);
    const first = (await admissions().claimNext(scope))!;
    await cancel(current);
    calls = [];
    await expect(renew(current)).rejects.toThrow('Prepaid renewal binding');
    expect(calls).toHaveLength(0);
    expect(await admissions().claimNext(scope)).toBeNull();
    expect(admissionRow(current).lease_token).toBe(first.lease_token);
    expect(count('postfinance_mutations')).toBe(0);
  });

  it('a paused first worker does not let a second worker duplicate the same renewal', async () => {
    setTime(current.prepared.period.endsAt);
    let release!: () => void, observed!: () => void;
    const pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen = new Promise<void>((resolve) => {
      observed = resolve;
    });
    let once = false;
    override = async (_path, method) => {
      if (method === 'GET' && !once) {
        once = true;
        observed();
        await pause;
      }
      return undefined;
    };
    const first = worker('{}');
    await seen;
    const second = await worker('{}');
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ renewal: 'idle' });
    expect(count('postfinance_mutations')).toBe(0);
    release();
    const result = await first;
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ renewal: 'submitted' });
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(2);
    expect(count('prepaid_renewal_requests')).toBe(1);
  });

  it('an owner revoked during the mandate GETs still prevents any new merchant operation', async () => {
    setTime(current.prepared.period.endsAt);
    let gets = 0;
    override = (_path, method) => {
      if (method === 'GET' && ++gets === 6) {
        sql
          .prepare(
            'UPDATE organization_members SET revoked_at=? WHERE user_id=?',
          )
          .run(clock, current.user.userId);
      }
      return undefined;
    };
    calls = [];
    const result = await worker('{}');
    expect(result.status).toBe(503);
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
    expect(count('postfinance_mutations')).toBe(0);
    expect(count('prepaid_settlement_proofs')).toBe(1);
  });

  it('never resets a lost CREATE claim after scheduling lease and backoff durations have elapsed', async () => {
    setTime(current.prepared.period.endsAt);
    override = (path, method) => {
      if (method === 'POST' && path === '/api/v2.0/payment/transactions')
        throw Error('Fictional accepted CREATE response lost.');
      return undefined;
    };
    expect(await (await worker('{}')).json()).toMatchObject({
      renewal: 'uncertain',
    });
    const ledger = sql.prepare('SELECT * FROM postfinance_mutations').all();
    expect(ledger).toHaveLength(1);
    expect(ledger[0].state).toBe('uncertain');
    setTime(clock + 3601);
    override = undefined;
    calls = [];
    expect(await (await worker('{}')).json()).toMatchObject({
      renewal: 'idle',
    });
    expect(calls).toHaveLength(0);
    expect(sql.prepare('SELECT * FROM postfinance_mutations').all()).toEqual(
      ledger,
    );
    expect(count('prepaid_settlement_proofs')).toBe(1);
  });
});
