import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
const runtime = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/runtime', () => ({
  database: () => runtime.db,
  runtimeValue: () => '',
  stripeConfiguration: () => ({
    secretKey: '',
    siteUrl: 'https://zentra.example.test',
    siteOriginAliases: '',
    priceIds: {},
    signingKey: '',
  }),
}));
vi.mock('@/app/zentra-auth', () => ({ getZentraUser: async () => null }));
vi.mock('@/lib/site-language-server', () => ({
  currentSiteLanguage: () => 'fr',
}));
vi.mock('stripe', () => ({
  default: class {
    constructor() {
      throw Error('No real Stripe in lifecycle fixture.');
    }
    static createFetchHttpClient() {
      throw Error('No real Stripe.');
    }
  },
}));
import { LEGAL_VERSION } from '@/lib/legal';
import { prepaidCatalog } from './prepaid-catalog';
import {
  prepareInitialPrepaidPurchase,
  type PrepaidPurchaseConfiguration,
} from './prepaid-purchase-preparation';
import { D1PrepaidPeriods } from './prepaid-periods';
import { D1PurchaseIntents } from './purchase-intents';
import {
  D1PostFinanceWebhookInbox,
  D1PostFinanceMutationLedger,
} from './postfinance-store';
import { D1PrepaidProvisioning } from './prepaid-provisioning';
import { D1PrepaidTokens } from './prepaid-token';
import { PostFinanceCheckoutClient } from './postfinance-client';
import { runPrepaidRenewal } from './prepaid-renewal';
import {
  cancelPrepaidRenewal,
  stopCancelledPrepaidFlows,
} from './prepaid-cancellation';
import { runPostFinanceCancellation } from './postfinance-cancellation-route';
import { runPostFinanceBillingWorker } from './postfinance-billing-worker-route';

const origin = 'https://checkout.postfinance.ch',
  site = 'https://zentra.example.test';
const user = {
  userId: 'lifecycle-owner',
  email: 'owner@example.test',
  emailConfirmed: true,
  displayName: 'Fixture Owner',
  fullName: 'Fixture Owner',
  provider: 'sites' as const,
};
let sql: DatabaseSync,
  clock: number,
  configuration: PrepaidPurchaseConfiguration;
let prepared: Extract<
  Awaited<ReturnType<typeof prepareInitialPrepaidPurchase>>,
  { state: 'prepared' }
>;
let calls: {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}[];
let tx: Record<string, unknown> | null, initial: Record<string, unknown>;
let token: Record<string, unknown>, version: Record<string, unknown>;
let override:
  | ((
      path: string,
      method: string,
    ) => Response | undefined | Promise<Response | undefined>)
  | undefined;
let beforeSql: ((query: string) => void) | undefined;
let transport: ReturnType<typeof vi.fn>;
let network: ReturnType<typeof vi.spyOn>;
const count = (table: string) =>
  Number(sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n);
function d1() {
  return {
    prepare(query: string) {
      let values: SQLInputValue[] = [];
      const s = {
        bind(...v: SQLInputValue[]) {
          values = v;
          return s;
        },
        execute() {
          beforeSql?.(query);
          return { success: true, meta: sql.prepare(query).run(...values) };
        },
        async run() {
          return s.execute();
        },
        async first() {
          return sql.prepare(query).get(...values) ?? null;
        },
        async all() {
          return { results: sql.prepare(query).all(...values) };
        },
      };
      return s;
    },
    async batch(statements: { execute(): unknown }[]) {
      sql.exec('BEGIN');
      try {
        const r = statements.map((s) => s.execute());
        sql.exec('COMMIT');
        return r;
      } catch (e) {
        sql.exec('ROLLBACK');
        throw e;
      }
    },
  } as unknown as Pick<D1Database, 'prepare' | 'batch'>;
}
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
function setTime(t: number) {
  clock = t;
  vi.setSystemTime(clock * 1000);
}
const client = () =>
  new PostFinanceCheckoutClient(configuration.connection, {
    fetch: transport as typeof fetch,
    now: () => clock * 1000,
  });
const renew = (ordinal = 1) =>
  runPrepaidRenewal(
    configuration,
    { contractId: prepared.contract.contractId, ordinal },
    {
      database: () => d1(),
      now: () => clock,
      fetch: transport as typeof fetch,
    },
  );
const stop = () =>
  stopCancelledPrepaidFlows(configuration, {
    database: () => d1(),
    now: () => clock,
    fetch: transport as typeof fetch,
  });
const cancel = () =>
  cancelPrepaidRenewal(d1(), user, prepared.contract.contractId, clock);
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  setTime(Date.parse('2026-01-31T09:17:23Z') / 1000);
  network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw Error('No external HTTP allowed.');
  });
  beforeSql = undefined;
  override = undefined;
  calls = [];
  tx = null;
  configuration = config();
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
  sql
    .prepare(
      "INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,updated_at) VALUES('trial-lifecycle','local','local','incomplete',0,?)",
    )
    .run(clock);
  sql
    .prepare(
      "INSERT INTO organizations(organization_id,name,subscription_id,created_by_user_id,created_at,updated_at) VALUES('lifecycle-company','Fictional PME','trial-lifecycle',?,?,?)",
    )
    .run(user.userId, clock, clock);
  sql
    .prepare(
      "INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES('lifecycle-member','lifecycle-company',?,?,'owner',?)",
    )
    .run(user.userId, user.email, clock);
  const p = await prepareInitialPrepaidPurchase(
    configuration,
    {
      user,
      requestId: '11111111-1111-4111-8111-111111111111',
      productKey: 'gestion:start',
      organizationId: 'lifecycle-company',
      method: 'postfinance_pay',
      acceptTerms: true,
      legalVersion: LEGAL_VERSION,
    },
    { database: () => d1(), now: () => clock },
  );
  if (p.state !== 'prepared') throw Error('Expected real preparation.');
  prepared = p;
  const intents = new D1PurchaseIntents(d1(), () => clock);
  await intents.markDispatched(p.intent);
  await new D1PrepaidPeriods(d1(), () => clock).bindTransaction(
    p.period.periodId,
    71,
  );
  await intents.bindProviderReference(p.intent, '71');
  const inbox = new D1PostFinanceWebhookInbox(
    d1(),
    {
      apiOrigin: origin,
      spaceId: 405,
      listeners: [{ id: 10, entityId: 20, technicalName: 'Transaction' }],
    },
    () => clock,
  );
  await inbox.acceptOnce(`${origin}|405|10|1`, {
    eventId: 1,
    entityId: 71,
    spaceId: 405,
    webhookListenerId: 10,
    listenerEntityId: 20,
    listenerEntityTechnicalName: 'Transaction',
    timestamp: new Date(clock * 1000).toISOString(),
  });
  const work = (await inbox.claimNext())!;
  await new D1PrepaidProvisioning(d1(), () => clock).provision(
    {
      periodId: p.period.periodId,
      transactionId: 71,
      invoiceId: 81,
      apiOrigin: origin,
      spaceId: 405,
      environment: 'PRODUCTION',
      ownerId: user.userId,
      organizationId: p.contract.organizationId,
      workspaceId: null,
      startsAt: p.period.startsAt,
      endsAt: p.period.endsAt,
      currency: 'CHF',
      priceChfMinor: 5900,
      catalogVersion: p.period.catalogVersion,
      evidenceFingerprint: 'a'.repeat(64),
    },
    work,
  );
  initial = {
    id: 71,
    linkedSpaceId: 405,
    version: 2,
    state: 'FULFILL',
    environment: 'LIVE',
    authorizationEnvironment: 'PRODUCTION',
    currency: 'CHF',
    totalSettledAmount: 59,
    refundedAmount: 0,
    customerId: p.expectation.customerReference,
    merchantReference: p.period.periodId,
    metaData: {
      zentra_period_id: p.period.periodId,
      zentra_plan_version: p.period.catalogVersion,
    },
    tokenizationMode: 'FORCE_CREATION',
    customersPresence: 'VIRTUAL_PRESENT',
    token: { id: 101 },
    paymentConnectorConfiguration: connector(),
  };
  token = {
    id: 101,
    linkedSpaceId: 405,
    version: 0,
    state: 'ACTIVE',
    customerId: p.expectation.customerReference,
  };
  version = {
    id: 102,
    linkedSpaceId: 405,
    version: 0,
    state: 'ACTIVE',
    environment: 'PRODUCTION',
    token: { id: 101 },
    paymentConnectorConfiguration: connector(),
    paymentMethod: { id: 99 },
  };
  transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(
        typeof input === 'string' || input instanceof URL
          ? String(input)
          : input.url,
      ),
      method = init?.method ?? 'GET';
    if (u.origin !== origin) throw Error('No other network allowed.');
    if (init?.body != null && typeof init.body !== 'string')
      throw Error('Fixture expects a serialized JSON body.');
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: u.pathname, body });
    const special = await override?.(u.pathname, method);
    if (special) return special;
    if (method === 'GET') {
      if (u.pathname.endsWith('/tokens/101/active-version'))
        return Response.json(version);
      if (u.pathname.endsWith('/tokens/101')) return Response.json(token);
      if (u.pathname.endsWith('/transactions/71'))
        return Response.json(initial);
      if (u.pathname.endsWith('/transactions/72') && tx)
        return Response.json(tx);
      throw Error('Unexpected provider GET.');
    }
    if (method === 'POST' && u.pathname === '/api/v2.0/payment/transactions') {
      tx = {
        ...body,
        id: 72,
        linkedSpaceId: 405,
        version: 0,
        state: 'PENDING',
        environment: 'LIVE',
        authorizationEnvironment: null,
        authorizationAmount: 59,
        token: { id: body.token },
        paymentConnectorConfiguration: null,
      };
      return Response.json(tx);
    }
    if (
      method === 'POST' &&
      u.pathname.endsWith('/transactions/72/charge-flow/apply')
    ) {
      if (!tx || tx.state !== 'PENDING')
        throw Error('Must apply PENDING only.');
      tx.state = 'PROCESSING';
      return Response.json(tx);
    }
    if (
      method === 'POST' &&
      u.pathname.endsWith('/transactions/72/charge-flow/cancel')
    )
      return Response.json({ ...tx, id: 72, linkedSpaceId: 405 });
    throw Error('Unexpected provider mutation.');
  });
  const tokens = new D1PrepaidTokens(d1(), () => clock),
    expected = await tokens.initialContext(
      p.contract.contractId,
      'postfinance_pay',
    );
  if (!expected) throw Error('Initial handoff must be closed.');
  await tokens.bindInitial(client(), expected, work);
  calls = [];
  transport.mockClear();
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled();
  sql?.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('durable monthly renewal through the real periods, token store and dispatch ledger', () => {
  it('renews on February28 for coverage through March31 then applies ChargeFlow without confirm or paid rights', async () => {
    setTime(prepared.period.endsAt);
    const r = await renew();
    expect(r.state).toBe('submitted');
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => c.path)).toEqual([
      '/api/v2.0/payment/transactions',
      '/api/v2.0/payment/transactions/72/charge-flow/apply',
    ]);
    expect(posts[0].body).toMatchObject({
      token: 101,
      customersPresence: 'NOT_PRESENT',
      autoConfirmationEnabled: false,
      allowedPaymentMethodConfigurations: [91],
    });
    expect(
      new Date(
        Number(
          sql
            .prepare('SELECT ends_at FROM prepaid_periods WHERE ordinal=1')
            .get()?.ends_at,
        ) * 1000,
      ).toISOString(),
    ).toBe('2026-03-31T09:17:23.000Z');
    expect(count('prepaid_settlement_proofs')).toBe(1);
    expect(count('prepaid_renewal_requests')).toBe(1);
    expect(
      sql.prepare('SELECT parameters FROM prepaid_renewal_requests').get()
        ?.parameters,
    ).not.toContain('authentication');
  });
  it('eight retries reuse both financial receipts even after processing starts', async () => {
    setTime(prepared.period.endsAt);
    for (let i = 0; i < 8; i++) expect((await renew()).state).toBe('submitted');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2);
    expect(count('prepaid_periods')).toBe(2);
  });
  it('resumes a prepared renewal after a local failure before the first merchant claim', async () => {
    setTime(prepared.period.endsAt);
    beforeSql = (query) => {
      if (query.includes('INSERT INTO postfinance_mutations')) {
        beforeSql = undefined;
        throw Error('Local interruption before durable dispatch claim.');
      }
    };
    expect((await renew()).state).toBe('uncertain');
    expect(count('prepaid_renewal_requests')).toBe(1);
    expect(count('postfinance_mutations')).toBe(0);
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    expect((await renew()).state).toBe('submitted');
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(2);
  });
  it('preserves immutable dispatch hashes and prevents changing the bound apply scope', async () => {
    setTime(prepared.period.endsAt);
    expect((await renew()).state).toBe('submitted');
    const request = sql
      .prepare('SELECT * FROM prepaid_renewal_requests')
      .get()!;
    expect(String(request.create_scope_hash)).toMatch(/^[a-f0-9]{64}$/);
    expect(String(request.apply_scope_hash)).toMatch(/^[a-f0-9]{64}$/);
    expect(() =>
      sql
        .prepare('UPDATE prepaid_renewal_requests SET create_scope_hash=?')
        .run('f'.repeat(64)),
    ).toThrow('prepaid_renewal_immutable');
    expect(() =>
      sql
        .prepare('UPDATE prepaid_renewal_requests SET apply_scope_hash=?')
        .run('f'.repeat(64)),
    ).toThrow('prepaid_renewal_immutable');
    expect(count('postfinance_mutations')).toBe(2);
  });
  it.each(['replaced-company-subscription', 'deleted-account'])(
    'refuses new financial dispatch when %s races the prepared renewal',
    async (change) => {
      setTime(prepared.period.endsAt);
      beforeSql = (query) => {
        if (query.includes('INSERT INTO postfinance_mutations')) {
          beforeSql = undefined;
          if (change === 'replaced-company-subscription') {
            sql
              .prepare(
                "UPDATE organizations SET subscription_id='trial-lifecycle' WHERE organization_id='lifecycle-company'",
              )
              .run();
          } else {
            sql
              .prepare(
                'INSERT INTO account_session_policy(user_id,revoked_before,deleted_at) VALUES(?,0,?)',
              )
              .run(user.userId, clock);
          }
        }
      };
      expect((await renew()).state).toBe('uncertain');
      expect(count('prepaid_renewal_requests')).toBe(1);
      expect(count('postfinance_mutations')).toBe(0);
      expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    },
  );
  it('parallel clicks cannot create two transactions or apply two flows', async () => {
    setTime(prepared.period.endsAt);
    const result = await Promise.allSettled(
      Array.from({ length: 8 }, () => renew()),
    );
    expect(
      result.some(
        (r) => r.status === 'fulfilled' && r.value.state === 'submitted',
      ),
    ).toBe(true);
    expect(
      calls.filter(
        (c) =>
          c.method === 'POST' && c.path === '/api/v2.0/payment/transactions',
      ),
    ).toHaveLength(1);
    expect(
      calls.filter(
        (c) => c.method === 'POST' && c.path.endsWith('/charge-flow/apply'),
      ),
    ).toHaveLength(1);
  });
  it.each(['create', 'apply'])(
    'never retries a lost %s financial response',
    async (stage) => {
      setTime(prepared.period.endsAt);
      override = (path, method) => {
        if (
          method === 'POST' &&
          (stage === 'create'
            ? path === '/api/v2.0/payment/transactions'
            : path.endsWith('/charge-flow/apply'))
        )
          throw Error('Response lost after merchant acceptance.');
        return undefined;
      };
      expect((await renew()).state).toBe('uncertain');
      expect((await renew()).state).toBe('uncertain');
      expect(calls.filter((c) => c.method === 'POST')).toHaveLength(
        stage === 'create' ? 1 : 2,
      );
      expect(count('prepaid_settlement_proofs')).toBe(1);
    },
  );
  it.each([
    'wrong-token',
    'expired-token',
    'changed-version',
    'refund',
    'changed-payer',
  ])('refuses %s without a financial POST', async (reason) => {
    setTime(prepared.period.endsAt);
    if (reason === 'wrong-token') initial.token = { id: 900 };
    if (reason === 'expired-token')
      version.expiresOn = new Date(clock * 1000).toISOString();
    if (reason === 'changed-version') version.version = 1;
    if (reason === 'refund') initial.refundedAmount = 1;
    if (reason === 'changed-payer') token.customerId = 'someone-else';
    await expect(renew()).rejects.toThrow();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
  it.each(['early', 'overdue', 'skipped'])(
    'refuses a %s period without contacting the merchant',
    async (reason) => {
      if (reason === 'overdue') setTime(prepared.period.endsAt + 33 * 86400);
      else if (reason === 'skipped') setTime(prepared.period.endsAt);
      await expect(renew(reason === 'skipped' ? 2 : 1)).rejects.toThrow();
      expect(calls).toHaveLength(0);
    },
  );
  it('stops create at its atomic SQL claim when cancellation races fresh token reads', async () => {
    setTime(prepared.period.endsAt);
    beforeSql = (query) => {
      if (query.startsWith('INSERT INTO postfinance_mutations')) {
        beforeSql = undefined;
        sql.prepare('UPDATE prepaid_contracts SET cancelled_at=?').run(clock);
      }
    };
    expect((await renew()).state).toBe('uncertain');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
  it('stops ChargeFlow when cancellation follows an accepted create', async () => {
    setTime(prepared.period.endsAt);
    override = (path, method) => {
      if (method === 'GET' && path.endsWith('/transactions/72'))
        sql.prepare('UPDATE prepaid_contracts SET cancelled_at=?').run(clock);
      return undefined;
    };
    expect((await renew()).state).toBe('uncertain');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });
  it('pins the frozen initial company after another space is created', async () => {
    setTime(prepared.period.endsAt);
    sql
      .prepare(
        "INSERT INTO organizations(organization_id,name,subscription_id,created_by_user_id,created_at,updated_at) VALUES('another-company','Other','trial-lifecycle',?,?,?)",
      )
      .run(user.userId, clock, clock);
    await renew();
    expect(
      sql.prepare('SELECT contract_id FROM prepaid_renewal_requests').get()
        ?.contract_id,
    ).toBe(prepared.contract.contractId);
    expect(
      sql
        .prepare(
          "SELECT subscription_id FROM organizations WHERE organization_id='another-company'",
        )
        .get()?.subscription_id,
    ).toBe('trial-lifecycle');
  });
});

describe('cancellation is owned, durable, monotone and independent of merchant availability', () => {
  it('retains paid coverage and data and keeps the first cancellation time on repeats', async () => {
    const before = sql.prepare('SELECT * FROM organizations').get();
    const a = await cancel();
    setTime(clock + 100);
    const b = await cancel();
    expect(a.cancelled).toBe(true);
    expect(b.cancelledAt).toBe(a.cancelledAt);
    expect(a.paidUntil).toBe(prepared.period.endsAt);
    expect(sql.prepare('SELECT * FROM organizations').get()).toEqual(before);
    expect(count('prepaid_settlement_proofs')).toBe(1);
    expect(calls).toHaveLength(0);
  });
  it.each(['other-user', 'unconfirmed', 'revoked-owner'])(
    'refuses %s without changing the contract',
    async (reason) => {
      if (reason === 'revoked-owner')
        sql.prepare('UPDATE organization_members SET revoked_at=?').run(clock);
      await expect(
        cancelPrepaidRenewal(
          d1(),
          {
            ...user,
            ...(reason === 'other-user'
              ? { userId: 'other' }
              : reason === 'unconfirmed'
                ? { emailConfirmed: false }
                : {}),
          },
          prepared.contract.contractId,
          clock,
        ),
      ).rejects.toThrow();
      expect(
        sql.prepare('SELECT cancelled_at FROM prepaid_contracts').get()
          ?.cancelled_at,
      ).toBeNull();
    },
  );
  it('never cancels the initial paid transaction', async () => {
    await cancel();
    expect(await stop()).toMatchObject({ inspected: 0, stopped: 0 });
    expect(calls).toHaveLength(0);
  });
  it('stops one in-flight renewal once and does not refund or remove paid evidence', async () => {
    setTime(prepared.period.endsAt);
    await renew();
    await cancel();
    calls = [];
    expect(await stop()).toMatchObject({ stopped: 1, uncertain: 0 });
    expect(await stop()).toMatchObject({ inspected: 0, stopped: 0 });
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual(
      ['/api/v2.0/payment/transactions/72/charge-flow/cancel'],
    );
    expect(count('prepaid_settlement_proofs')).toBe(1);
    expect(
      sql.prepare('SELECT state FROM prepaid_flow_cancellations').get()?.state,
    ).toBe('completed');
  });
  it('does not repeat an uncertain cancellation POST for the same period', async () => {
    setTime(prepared.period.endsAt);
    await renew();
    await cancel();
    calls = [];
    override = (path, method) => {
      if (method === 'POST' && path.endsWith('/charge-flow/cancel'))
        throw Error('Lost cancellation response.');
      return undefined;
    };
    expect(await stop()).toMatchObject({ uncertain: 1 });
    expect(await stop()).toMatchObject({ inspected: 0 });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(
      sql.prepare('SELECT state FROM prepaid_flow_cancellations').get()?.state,
    ).toBe('uncertain');
  });
  it('rejects a merchant read from another currency before cancel POST', async () => {
    setTime(prepared.period.endsAt);
    await renew();
    await cancel();
    calls = [];
    tx!.currency = 'EUR';
    expect(await stop()).toMatchObject({ stopped: 0, uncertain: 1 });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
  it('disabling the worker touches neither database nor transport', async () => {
    const database = vi.fn(() => {
      throw Error('Must not open database.');
    });
    const fetch = vi.fn();
    expect(
      await stopCancelledPrepaidFlows(
        { ...configuration, enabled: false },
        { database, fetch },
      ),
    ).toMatchObject({ state: 'disabled' });
    expect(database).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('the customer route uses its authenticated owner and works without terms or merchant secrets', async () => {
    const rateLimit = vi.fn(async () => {}),
      auth = vi.fn(async () => user);
    const request = new Request(site + '/api/payments/postfinance/cancel', {
      method: 'POST',
      headers: { Origin: site, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contractId: prepared.contract.contractId }),
    });
    const response = await runPostFinanceCancellation(request, {
      database: () => d1(),
      user: auth,
      rateLimit,
      now: () => clock,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ cancelled: true });
    expect(calls).toHaveLength(0);
  });
  it.each(['disabled', 'missing-token', 'wrong-token', 'body', 'query'])(
    'private scheduler refuses %s without a database or provider call',
    async (reason) => {
      const database = vi.fn(() => {
        throw Error('No database.');
      });
      const fetch = vi.fn();
      const read = (name: string) =>
        name === 'POSTFINANCE_BILLING_WORKER_ENABLED'
          ? reason === 'disabled'
            ? 'false'
            : 'true'
          : name === 'POSTFINANCE_BILLING_WORKER_TOKEN'
            ? reason === 'missing-token'
              ? ''
              : 'A'.repeat(43)
            : '';
      const request = new Request(
        site +
          '/api/payments/postfinance/billing-worker' +
          (reason === 'query' ? '?company=wrong' : ''),
        {
          method: 'POST',
          headers: {
            Authorization:
              'Bearer ' + (reason === 'wrong-token' ? 'B' : 'A').repeat(43),
          },
          ...(reason === 'body' ? { body: '{}' } : {}),
        },
      );
      const response = await runPostFinanceBillingWorker(request, {
        read,
        database,
        fetch,
      });
      expect(response.status).toBe(
        reason === 'disabled'
          ? 503
          : reason === 'body' || reason === 'query'
            ? 400
            : 401,
      );
      expect(database).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it('rejects an arbitrary cancellation operation at the durable financial scope fence', async () => {
    await cancel();
    const ledger = new D1PostFinanceMutationLedger(d1(), () => clock, {
      ...prepared.contract,
      periodId: prepared.period.periodId,
      operation: 'cancel',
      transactionId: 71,
    });
    await expect(
      ledger.claim(
        `${origin}|405|POST|/payment/transactions/71/charge-flow/cancel|${prepared.period.periodId}_cancel`,
        'a'.repeat(43),
      ),
    ).rejects.toThrow('dispatch is unavailable');
  });
});
