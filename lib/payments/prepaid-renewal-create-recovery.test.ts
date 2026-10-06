import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { LEGAL_VERSION } from '@/lib/legal';
import { prepaidCatalog } from '@/lib/payments/prepaid-catalog';
import { prepareInitialPrepaidPurchase } from '@/lib/payments/prepaid-purchase-preparation';
import {
  runInitialPrepaidCheckout,
  type PreparedInitialPrepaidPurchase,
} from '@/lib/payments/prepaid-initial-checkout';
import {
  recoverPrepaidCreate,
  type PrepaidCreateRecoveryConfiguration,
} from '@/lib/payments/prepaid-create-recovery';
import { D1PostFinanceWebhookInbox } from '@/lib/payments/postfinance-store';
import { D1PrepaidProvisioning } from '@/lib/payments/prepaid-provisioning';
import { D1PrepaidTokens } from '@/lib/payments/prepaid-token';
import { PostFinanceCheckoutClient } from '@/lib/payments/postfinance-client';
import { runPrepaidRenewal } from '@/lib/payments/prepaid-renewal';

vi.mock('@/lib/runtime', () => ({
  database: () => {
    throw Error('Inject D1');
  },
  runtimeValue: () => '',
  stripeConfiguration: () => ({
    secretKey: '',
    testMode: '',
    priceIds: {},
    signingKey: '',
  }),
}));
let sql: DatabaseSync, clock: number, prepared: PreparedInitialPrepaidPurchase;
let configuration: PrepaidCreateRecoveryConfiguration,
  transaction: Record<string, unknown>;
type FixtureFetch = (url: string, init: RequestInit) => Promise<Response>;
let fetchFixture: ReturnType<typeof vi.fn<FixtureFetch>>,
  realNetwork: ReturnType<typeof vi.spyOn>;
let search: (attempt: number, offset: number) => Record<string, unknown>;
let mutateRead: (tx: Record<string, unknown>, attempt: number) => void;
let beforeBatch: (() => void) | undefined,
  interruptStatement: string | undefined;
let reads: number, searches: number, queries: string[];
const user = {
  userId: 'recovery-owner',
  email: 'owner@example.test',
  emailConfirmed: true,
};
const count = (name: string) =>
  Number(sql.prepare(`SELECT COUNT(*) n FROM ${name}`).get()!.n);
function d1() {
  return {
    prepare(query: string) {
      queries.push(query);
      let values: SQLInputValue[] = [];
      const stmt = {
        bind(...v: SQLInputValue[]) {
          values = v;
          return stmt;
        },
        execute() {
          if (interruptStatement && query.includes(interruptStatement)) {
            interruptStatement = undefined;
            throw Error('Fixture storage failure');
          }
          return { success: true, meta: sql.prepare(query).run(...values) };
        },
        async run() {
          return stmt.execute();
        },
        async first() {
          return sql.prepare(query).get(...values) ?? null;
        },
        async all() {
          return { results: sql.prepare(query).all(...values) };
        },
      };
      return stmt;
    },
    async batch(statements: { execute(): unknown }[]) {
      const f = beforeBatch;
      beforeBatch = undefined;
      f?.();
      sql.exec('BEGIN');
      try {
        const result = statements.map((s) => s.execute());
        sql.exec('COMMIT');
        return result;
      } catch (e) {
        sql.exec('ROLLBACK');
        throw e;
      }
    },
  } as unknown as Pick<D1Database, 'prepare' | 'batch'>;
}
function config(): PrepaidCreateRecoveryConfiguration {
  return {
    enabled: true,
    createRecoveryEnabled: true,
    settlementEvidenceVerified: true,
    connectorConfigurations: { postfinance_pay: 92 },
    connection: {
      enabled: true,
      merchantApproved: true,
      prepaidFeatureEnabled: true,
      chargeFlowEnabled: true,
      postfinancePayTokenEnabled: true,
      prepaidEnvironment: 'TEST',
      apiOrigin: 'https://checkout.postfinance.ch',
      spaceId: 405,
      applicationUserId: '512',
      authenticationKeyBase64: Buffer.alloc(32, 0x5a).toString('base64'),
      returnOrigin: 'https://zentra.example.test',
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
const deps = () => ({
  database: d1,
  now: () => clock,
  fetch: fetchFixture as typeof fetch,
});
const recover = () =>
  recoverPrepaidCreate(
    configuration,
    { periodId: prepared.period.periodId },
    deps(),
  );
function ledger() {
  return sql
    .prepare(
      "SELECT * FROM postfinance_mutations WHERE state IN('claimed','uncertain','completed')",
    )
    .all();
}
function rights() {
  return [
    'organizations',
    'subscriptions',
    'organization_members',
    'support_workspaces',
    'support_gestion_links',
    'support_subscriptions',
    'automation_subscriptions',
    'complete_subscriptions',
    'prepaid_settlement_proofs',
    'device_sessions',
    'license_activations',
  ].map((name) => [
    name,
    sql.prepare(`SELECT * FROM ${name} ORDER BY 1`).all(),
  ]);
}
async function setup(environment: 'TEST' | 'PRODUCTION' = 'TEST') {
  clock = Date.parse('2026-10-06T10:11:12Z') / 1000;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock * 1000);
  sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  sql.function('unixepoch', () => clock);
  const migrationDirectory = process.env.ZENTRA_QA_MIGRATIONS_DIRECTORY
    ? new URL(process.env.ZENTRA_QA_MIGRATIONS_DIRECTORY)
    : new URL('../../drizzle/', import.meta.url);
  for (const f of readdirSync(migrationDirectory)
    .filter((f) => f.endsWith('.sql'))
    .sort())
    sql.exec(readFileSync(new URL(f, migrationDirectory), 'utf8'));
  if (
    !sql
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='prepaid_renewal_create_recovery_jobs'",
      )
      .get()
  ) {
    const fragment = process.env.ZENTRA_QA_RENEWAL_RECOVERY_FRAGMENT;
    if (!fragment)
      throw Error('The real renewal recovery migration is required.');
    sql.exec(readFileSync(new URL(fragment), 'utf8'));
  }
  sql
    .prepare(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,updated_at)
    VALUES('trial','local','local','incomplete',0,?)`)
    .run(clock);
  sql
    .prepare('INSERT INTO organizations VALUES(?,?,?,?,?,?)')
    .run('company-a', 'Fictional company', 'trial', user.userId, clock, clock);
  sql
    .prepare(`INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at)
    VALUES('member-a','company-a',?,?,'owner',?)`)
    .run(user.userId, user.email, clock);
  realNetwork = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw Error('No real network');
  });
  configuration = config();
  configuration.connection.prepaidEnvironment = environment;
  queries = [];
  beforeBatch = undefined;
  interruptStatement = undefined;
  reads = 0;
  searches = 0;
  mutateRead = () => {};
  search = (_attempt, offset) => ({
    data: [{ id: 55, linkedSpaceId: 405 }],
    offset,
    limit: 10,
    hasMore: false,
  });
  fetchFixture = vi.fn(async (url: string, init: RequestInit) => {
    const u = new URL(url);
    expect(u.origin).toBe('https://checkout.postfinance.ch');
    expect((init.headers as Record<string, string>).Space).toBe('405');
    expect(init.redirect).toBe('error');
    if (
      init.method === 'POST' &&
      u.pathname === '/api/v2.0/payment/transactions'
    ) {
      const body = JSON.parse(init.body as string);
      transaction = {
        ...body,
        id: 55,
        linkedSpaceId: 405,
        state: 'PENDING',
        version: 7,
        environment: environment === 'TEST' ? 'PREVIEW' : 'LIVE',
        authorizationAmount: body.lineItems[0].amountIncludingTax,
        ...(body.token === undefined
          ? {}
          : { token: { id: body.token, linkedSpaceId: 405 } }),
      };
      throw Error('Accepted CREATE, lost HTTP response');
    }
    expect(init.method).toBe('GET');
    if (u.pathname.endsWith('/transactions/search')) {
      expect(u.searchParams.get('query')).toBe(
        `merchantReference:${prepared.period.periodId}`,
      );
      expect(u.searchParams.get('order')).toBe('id:ASC');
      expect(u.searchParams.get('limit')).toBe('10');
      return Response.json(
        search(++searches, Number(u.searchParams.get('offset'))),
      );
    }
    if (u.pathname.endsWith('/transactions/55')) {
      expect(u.searchParams.get('expand')).toBe(
        'token,paymentConnectorConfiguration.paymentMethodConfiguration.paymentMethod',
      );
      const fresh = structuredClone(transaction);
      mutateRead(fresh, ++reads);
      return Response.json(fresh);
    }
    throw Error('Unexpected recovery transport');
  });
  const p = await prepareInitialPrepaidPurchase(
    configuration,
    {
      user,
      requestId: '11111111-1111-4111-8111-111111111111',
      productKey: 'gestion:start',
      organizationId: 'company-a',
      method: 'postfinance_pay',
      acceptTerms: true,
      legalVersion: LEGAL_VERSION,
    },
    deps(),
  );
  if (p.state !== 'prepared') throw Error('Expected real preparation');
  prepared = p;
  expect(
    (await runInitialPrepaidCheckout(configuration, prepared, deps())).state,
  ).toBe('uncertain');
  expect(count('prepaid_transactions')).toBe(0);
  expect(ledger()[0].state).toBe('uncertain');
  fetchFixture.mockClear();
  queries = [];
}
beforeEach(() => setup());
afterEach(() => {
  expect(realNetwork).not.toHaveBeenCalled();
  realNetwork.mockRestore();
  sql.close();
  vi.useRealTimers();
});

import {
  D1PrepaidRenewalCreateRecoveries,
  recoverOnePrepaidRenewalCreate,
} from './prepaid-renewal-create-recovery';
import { runPostFinanceBillingWorker } from './postfinance-billing-worker-route';

async function setupRenewal() {
  sql.close();
  realNetwork.mockRestore();
  await setup('PRODUCTION');
  await recover();
  const connector = {
    id: 92,
    linkedSpaceId: 405,
    state: 'ACTIVE',
    paymentMethodConfiguration: {
      id: 91,
      linkedSpaceId: 405,
      state: 'ACTIVE',
      paymentMethod: { id: 99 },
    },
  };
  transaction = {
    ...transaction,
    state: 'FULFILL',
    authorizationEnvironment: 'PRODUCTION',
    totalSettledAmount: prepared.period.priceChfMinor / 100,
    refundedAmount: 0,
    token: { id: 101, linkedSpaceId: 405 },
    paymentConnectorConfiguration: connector,
  };
  const initial = structuredClone(transaction);
  const inbox = new D1PostFinanceWebhookInbox(
    d1(),
    {
      apiOrigin: prepared.contract.apiOrigin,
      spaceId: 405,
      listeners: [{ id: 10, entityId: 20, technicalName: 'Transaction' }],
    },
    () => clock,
  );
  await inbox.acceptOnce(`${prepared.contract.apiOrigin}|405|10|1`, {
    eventId: 1,
    entityId: 55,
    spaceId: 405,
    webhookListenerId: 10,
    listenerEntityId: 20,
    listenerEntityTechnicalName: 'Transaction',
    timestamp: new Date(clock * 1000).toISOString(),
  });
  const work = (await inbox.claimNext())!;
  await new D1PrepaidProvisioning(d1(), () => clock).provision(
    {
      periodId: prepared.period.periodId,
      transactionId: 55,
      invoiceId: 81,
      apiOrigin: prepared.contract.apiOrigin,
      spaceId: 405,
      environment: 'PRODUCTION',
      ownerId: user.userId,
      organizationId: 'company-a',
      workspaceId: null,
      startsAt: prepared.period.startsAt,
      endsAt: prepared.period.endsAt,
      currency: 'CHF',
      priceChfMinor: prepared.period.priceChfMinor,
      catalogVersion: prepared.period.catalogVersion,
      evidenceFingerprint: 'a'.repeat(64),
    },
    work,
  );
  const createTransport = fetchFixture;
  const transport = vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/transactions/55')) return Response.json(initial);
    if (path.endsWith('/tokens/101'))
      return Response.json({
        id: 101,
        linkedSpaceId: 405,
        version: 0,
        state: 'ACTIVE',
        customerId: prepared.expectation.customerReference,
      });
    if (path.endsWith('/tokens/101/active-version'))
      return Response.json({
        id: 102,
        linkedSpaceId: 405,
        version: 0,
        state: 'ACTIVE',
        environment: 'PRODUCTION',
        token: { id: 101 },
        paymentConnectorConfiguration: connector,
        paymentMethod: { id: 99 },
      });
    return createTransport(url, init);
  });
  const tokens = new D1PrepaidTokens(d1(), () => clock),
    expected = await tokens.initialContext(
      prepared.contract.contractId,
      'postfinance_pay',
    );
  expect(expected).not.toBeNull();
  await tokens.bindInitial(
    new PostFinanceCheckoutClient(configuration.connection, {
      fetch: transport as typeof fetch,
      now: () => clock * 1000,
    }),
    expected!,
    work,
  );
  clock = prepared.period.endsAt;
  vi.setSystemTime(clock * 1000);
  expect(
    (
      await runPrepaidRenewal(
        configuration,
        { contractId: prepared.contract.contractId, ordinal: 1 },
        { database: d1, now: () => clock, fetch: transport as typeof fetch },
      )
    ).state,
  ).toBe('uncertain');
  const renewed = sql
    .prepare('SELECT period_id FROM prepaid_periods WHERE ordinal=1')
    .get()!.period_id as string;
  expect(count('prepaid_transactions')).toBe(1);
  expect(
    sql.prepare('SELECT * FROM prepaid_renewal_requests').get()!
      .apply_scope_hash,
  ).toBeNull();
  prepared = {
    ...prepared,
    period: { ...prepared.period, periodId: renewed },
  };
  reads = 0;
  searches = 0;
  fetchFixture.mockClear();
  // A second provider transaction represents the new period, not the initial ID.
  transaction.id = 56;
  search = (_, offset) => ({
    data: [{ id: 56, linkedSpaceId: 405 }],
    offset,
    limit: 10,
    hasMore: false,
  });
  const recoverySearchTransport = fetchFixture;
  const recoveryTransport = vi.fn(async (url: string, init: RequestInit) => {
    if (new URL(url).pathname.endsWith('/transactions/56')) {
      expect(init.method).toBe('GET');
      return Response.json(transaction);
    }
    return recoverySearchTransport(url, init);
  });

  fetchFixture = recoveryTransport as typeof fetchFixture;
}
const scope = () => ({
  apiOrigin: configuration.connection.apiOrigin!,
  spaceId: configuration.connection.spaceId!,
  environment: configuration.connection.prepaidEnvironment!,
});
const queue = () => new D1PrepaidRenewalCreateRecoveries(d1(), () => clock);
const recoverRenewal = () =>
  recoverOnePrepaidRenewalCreate(configuration, deps());
const currentLedger = () =>
  sql
    .prepare(
      'SELECT * FROM postfinance_mutations WHERE scope_hash=(SELECT create_scope_hash FROM prepaid_renewal_requests)',
    )
    .get()!;
const job = () =>
  sql.prepare('SELECT * FROM prepaid_renewal_create_recovery_jobs').get()!;

describe('server-only GET recovery for a lost renewal CREATE', () => {
  it('disabled means zero database and transport', async () => {
    const db = vi.fn(() => {
        throw Error('No DB');
      }),
      http = vi.fn(() => {
        throw Error('No HTTP');
      });
    expect(
      await recoverOnePrepaidRenewalCreate(
        { ...configuration, createRecoveryEnabled: false },
        { database: db, fetch: http },
      ),
    ).toEqual({ state: 'disabled' });
    expect(db).not.toHaveBeenCalled();
    expect(http).not.toHaveBeenCalled();
  });
  it('does not admit initial ordinal zero or reinterpret it as a renewal', async () => {
    expect(await queue().admit(scope())).toBe(0);
    expect(await recoverRenewal()).toEqual({ state: 'idle' });
    expect(fetchFixture).not.toHaveBeenCalled();
  });
  it('binds the original accepted renewal using only GET, preserving initial reference, cash and tokens', async () => {
    await setupRenewal();
    const before = rights(),
      tokens = sql.prepare('SELECT * FROM prepaid_tokens').all();
    const r = await recoverRenewal();
    expect(r).toMatchObject({
      state: 'bound',
      transactionId: 56,
      reconciliationOnly: false,
    });
    expect(fetchFixture.mock.calls.every((c) => c[1].method === 'GET')).toBe(
      true,
    );
    expect(rights()).toEqual(before);
    expect(sql.prepare('SELECT * FROM prepaid_tokens').all()).toEqual(tokens);
    expect(
      sql.prepare('SELECT provider_reference FROM purchase_intents').get()!
        .provider_reference,
    ).toBe('55');
    expect(currentLedger().state).toBe('completed');
    expect(job().state).toBe('completed');
    expect(
      sql.prepare('SELECT * FROM prepaid_renewal_requests').get()!
        .apply_scope_hash,
    ).toBeNull();
    expect(
      sql
        .prepare(
          'SELECT provenance FROM postfinance_observation_jobs WHERE transaction_id=56',
        )
        .get()!.provenance,
    ).toBe('create_recovery');
  });
  it('still discovers an accepted CREATE after cancellation and expiration without new money or rights', async () => {
    await setupRenewal();
    const p = sql
      .prepare('SELECT ends_at FROM prepaid_periods WHERE ordinal=1')
      .get()!;
    clock = Number(p.ends_at) + 86400;
    vi.setSystemTime(clock * 1000);
    sql
      .prepare(
        'UPDATE prepaid_contracts SET cancelled_at=? WHERE contract_id=?',
      )
      .run(clock, prepared.contract.contractId);
    const before = rights();
    expect(await recoverRenewal()).toMatchObject({
      state: 'bound',
      transactionId: 56,
    });
    expect(rights()).toEqual(before);
    expect(fetchFixture.mock.calls.every((c) => c[1].method === 'GET')).toBe(
      true,
    );
  });
  it('leaves advanced state reconciliation-only and does not infer paid from a recovered transaction', async () => {
    await setupRenewal();
    transaction.state = 'FULFILL';
    transaction.authorizationEnvironment = 'PRODUCTION';
    transaction.totalSettledAmount = 59;
    const before = rights();
    expect(await recoverRenewal()).toMatchObject({
      state: 'bound',
      reconciliationOnly: true,
    });
    expect(rights()).toEqual(before);
  });
  it.each(['apiOrigin', 'spaceId', 'environment'] as const)(
    'wrong server scope %s admits nothing and sends no HTTP',
    async (field) => {
      await setupRenewal();
      const s = scope();
      if (field === 'apiOrigin') s.apiOrigin = 'https://app-wallee.com';
      else if (field === 'spaceId') s.spaceId = 406;
      else s.environment = 'TEST';
      expect(await queue().admit(s)).toBe(0);
      expect(await queue().claimNext(s)).toBeNull();
      expect(fetchFixture).not.toHaveBeenCalled();
    },
  );
  it('owner revoked before admission gives no GET and no recovery job', async () => {
    await setupRenewal();
    sql.prepare('UPDATE organization_members SET revoked_at=?').run(clock);
    expect(await recoverRenewal()).toEqual({ state: 'idle' });
    expect(fetchFixture).not.toHaveBeenCalled();
    expect(count('prepaid_renewal_create_recovery_jobs')).toBe(0);
  });
  it('configuration catalogue drift is refused before merchant GET', async () => {
    await setupRenewal();
    configuration.connection.prepaidProducts!['gestion:start'].priceChfMinor++;
    expect(await recoverRenewal()).toMatchObject({
      state: 'pending',
      reason: 'binding',
    });
    expect(fetchFixture).not.toHaveBeenCalled();
    expect(currentLedger().state).toBe('uncertain');
  });
  it('two acquisition calls cannot share a live scheduling lease', async () => {
    await setupRenewal();
    expect(await queue().admit(scope())).toBe(1);
    const [a, b] = await Promise.all([
      queue().claimNext(scope()),
      queue().claimNext(scope()),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(job().attempts).toBe(1);
    expect(currentLedger().state).toBe('uncertain');
  });
  it.each(['absent', 'ambiguous', 'unstable', 'unavailable'] as const)(
    'backoff %s never resets original financial claim',
    async (reason) => {
      await setupRenewal();
      const before = currentLedger(),
        initial = rights();
      if (reason === 'absent')
        search = (_, offset) => ({
          data: [],
          offset,
          limit: 10,
          hasMore: false,
        });
      if (reason === 'ambiguous')
        search = (_, offset) => ({
          data: [
            { id: 56, linkedSpaceId: 405 },
            { id: 57, linkedSpaceId: 405 },
          ],
          offset,
          limit: 10,
          hasMore: false,
        });
      if (reason === 'unstable') {
        let n = 0;
        const original = fetchFixture;
        fetchFixture = vi.fn(async (url, init) => {
          const response = await original(url, init);
          if (new URL(url).pathname.endsWith('/transactions/56')) {
            const x = (await response.json()) as Record<string, unknown>;
            x.version = ++n;
            return Response.json(x);
          }
          return response;
        });
      }
      if (reason === 'unavailable')
        fetchFixture = vi.fn(async () => {
          throw Error('Fictional provider down');
        });
      expect(await recoverRenewal()).toMatchObject({
        state: 'pending',
        reason,
      });
      expect(currentLedger()).toEqual(before);
      expect(rights()).toEqual(initial);
      expect(job()).toMatchObject({
        state: 'queued',
        attempts: 1,
        last_error_code: reason,
        next_attempt_at: clock + 60,
      });
      const calls = fetchFixture.mock.calls.length;
      expect(await recoverRenewal()).toEqual({ state: 'idle' });
      expect(fetchFixture.mock.calls.length).toBe(calls);
    },
  );
  it('lease expiry between stable reads and batch rolls back transaction, ledger and observation', async () => {
    await setupRenewal();
    const before = currentLedger();
    beforeBatch = () => {
      clock += 131;
      vi.setSystemTime(clock * 1000);
    };
    await expect(recoverRenewal()).rejects.toThrow('Recovery lease lost');
    expect(currentLedger()).toEqual(before);
    expect(count('prepaid_transactions')).toBe(1);
    expect(
      sql
        .prepare(
          'SELECT 1 FROM postfinance_observation_jobs WHERE transaction_id=56',
        )
        .get(),
    ).toBeUndefined();
    expect(
      sql
        .prepare(
          'SELECT 1 FROM prepaid_create_recoveries WHERE transaction_id=56',
        )
        .get(),
    ).toBeUndefined();
  });
  it('the shorter recovery phase deadline is enforced inside the final D1 binding batch', async () => {
    await setupRenewal();
    const before = currentLedger(),
      deadlineSeconds = clock + 30;
    beforeBatch = () => {
      clock += 31;
      vi.setSystemTime(clock * 1000);
    };
    expect(
      await recoverOnePrepaidRenewalCreate(configuration, {
        ...deps(),
        deadlineSeconds,
      }),
    ).toMatchObject({ state: 'pending', reason: 'unavailable' });
    expect(currentLedger()).toEqual(before);
    expect(count('prepaid_transactions')).toBe(1);
    expect(
      sql
        .prepare(
          'SELECT 1 FROM postfinance_observation_jobs WHERE transaction_id=56',
        )
        .get(),
    ).toBeUndefined();
  });
  it('owner revoked in the binding batch rolls back all recovered financial evidence', async () => {
    await setupRenewal();
    const before = currentLedger();
    beforeBatch = () => {
      sql.prepare('UPDATE organization_members SET revoked_at=?').run(clock);
    };
    expect(await recoverRenewal()).toMatchObject({ state: 'pending' });
    expect(currentLedger()).toEqual(before);
    expect(count('prepaid_transactions')).toBe(1);
    expect(
      sql
        .prepare(
          'SELECT 1 FROM postfinance_observation_jobs WHERE transaction_id=56',
        )
        .get(),
    ).toBeUndefined();
  });
  it('storage interruption is retryable without releasing or replacing the financial claim', async () => {
    await setupRenewal();
    const before = currentLedger();
    interruptStatement = 'UPDATE postfinance_mutations';
    expect(await recoverRenewal()).toMatchObject({
      state: 'pending',
      reason: 'unavailable',
    });
    expect(currentLedger()).toEqual(before);
    expect(count('prepaid_transactions')).toBe(1);
    clock += 60;
    vi.setSystemTime(clock * 1000);
    expect(await recoverRenewal()).toMatchObject({
      state: 'bound',
      transactionId: 56,
    });
  });
  it('completed replay and terminal eighth failure never reset scheduling or observations', async () => {
    await setupRenewal();
    search = (_, offset) => ({ data: [], offset, limit: 10, hasMore: false });
    const before = currentLedger();
    for (let n = 1; n <= 8; n++) {
      expect(await recoverRenewal()).toMatchObject({
        state: n === 8 ? 'failed' : 'pending',
      });
      if (n < 8) {
        clock = Number(job().next_attempt_at);
        vi.setSystemTime(clock * 1000);
      }
    }
    const terminal = job();
    clock += 86400;
    vi.setSystemTime(clock * 1000);
    expect(await recoverRenewal()).toEqual({ state: 'idle' });
    expect(job()).toEqual(terminal);
    expect(currentLedger()).toEqual(before);
  });
  it('completed job replay is idle with no GET and preserves the admitted observation bytes', async () => {
    await setupRenewal();
    expect(await recoverRenewal()).toMatchObject({ state: 'bound' });
    const terminal = job(),
      observation = sql
        .prepare(
          'SELECT * FROM postfinance_observation_jobs WHERE transaction_id=56',
        )
        .get();
    fetchFixture.mockClear();
    expect(await recoverRenewal()).toEqual({ state: 'idle' });
    expect(job()).toEqual(terminal);
    expect(fetchFixture).not.toHaveBeenCalled();
    expect(
      sql
        .prepare(
          'SELECT * FROM postfinance_observation_jobs WHERE transaction_id=56',
        )
        .get(),
    ).toEqual(observation);
  });
  it('an eighth processing attempt interrupted by a crash becomes terminal without a reset', async () => {
    await setupRenewal();
    await queue().admit(scope());
    for (let n = 1; n <= 8; n++) {
      const work = await queue().claimNext(scope());
      expect(work?.attempts).toBe(n);
      if (n < 8) {
        expect(await queue().defer(work!, 'unavailable')).toBe(true);
        clock = Number(job().next_attempt_at);
        vi.setSystemTime(clock * 1000);
      }
    }
    const before = currentLedger();
    clock += 131;
    vi.setSystemTime(clock * 1000);
    expect(await queue().claimNext(scope())).toBeNull();
    expect(job()).toMatchObject({
      state: 'failed',
      attempts: 8,
      last_error_code: 'unavailable',
    });
    expect(currentLedger()).toEqual(before);
  });
  it('owner lost after acquisition is rejected before GET and deferred without financial changes', async () => {
    await setupRenewal();
    await queue().admit(scope());
    const work = await queue().claimNext(scope());
    sql.prepare('UPDATE organization_members SET revoked_at=?').run(clock);
    await expect(queue().assertLive(work!)).rejects.toThrow('binding');
    expect(fetchFixture).not.toHaveBeenCalled();
    expect(currentLedger().state).toBe('uncertain');
  });
  it('internal exclusion leaves the chosen normal contract out of the recovery phase', async () => {
    await setupRenewal();
    await queue().admit(scope());
    expect(
      await queue().claimNext(scope(), prepared.contract.contractId),
    ).toBeNull();
    expect(job().attempts).toBe(0);
  });
  it('forged lease and source scope cannot bind a recovered transaction', async () => {
    await setupRenewal();
    await queue().admit(scope());
    const work = (await queue().claimNext(scope()))!;
    await expect(
      queue().assertLive({ ...work, space_id: 406 }),
    ).rejects.toThrow('Recovery lease lost');
    await expect(
      queue().assertLive({ ...work, lease_token: crypto.randomUUID() }),
    ).rejects.toThrow('Recovery lease lost');
    expect(fetchFixture).not.toHaveBeenCalled();
  });
  it('immutable and terminal job records cannot be retargeted or deleted', async () => {
    await setupRenewal();
    expect(await recoverRenewal()).toMatchObject({ state: 'bound' });
    expect(() =>
      sql
        .prepare('UPDATE prepaid_renewal_create_recovery_jobs SET ordinal=2')
        .run(),
    ).toThrow('identity');
    expect(() =>
      sql
        .prepare(
          "UPDATE prepaid_renewal_create_recovery_jobs SET state='queued'",
        )
        .run(),
    ).toThrow('terminal');
    expect(() =>
      sql.prepare('DELETE FROM prepaid_renewal_create_recovery_jobs').run(),
    ).toThrow('retained');
  });
  function workerBindings(recovery = true) {
    const c = configuration.connection;
    return (name: string) =>
      (
        ({
          POSTFINANCE_BILLING_WORKER_ENABLED: 'true',
          POSTFINANCE_BILLING_WORKER_TOKEN: 'w'.repeat(43),
          POSTFINANCE_RENEWAL_CREATE_RECOVERY_ENABLED: recovery ? 'true' : '',
          POSTFINANCE_PURCHASES_ENABLED: 'true',
          POSTFINANCE_MERCHANT_APPROVED: 'true',
          POSTFINANCE_API_ORIGIN: c.apiOrigin!,
          POSTFINANCE_SPACE_ID: String(c.spaceId),
          POSTFINANCE_APPLICATION_USER_ID: c.applicationUserId!,
          POSTFINANCE_AUTHENTICATION_KEY_BASE64: c.authenticationKeyBase64!,
          POSTFINANCE_RETURN_ORIGIN: c.returnOrigin!,
          POSTFINANCE_PREPAID_ENVIRONMENT: c.prepaidEnvironment!,
          POSTFINANCE_PRODUCTION_ENABLED: 'true',
          POSTFINANCE_CHARGE_FLOW_ENABLED: 'true',
          POSTFINANCE_PAY_TOKEN_ENABLED: 'true',
          POSTFINANCE_SETTLEMENT_EVIDENCE_VERIFIED: 'true',
          POSTFINANCE_PREPAID_CATALOG_JSON: JSON.stringify(c.prepaidProducts),
          POSTFINANCE_PREPAID_CONNECTORS_JSON: JSON.stringify(
            configuration.connectorConfigurations,
          ),
        }) as Record<string, string>
      )[name] ?? '';
  }
  const workerRequest = (token = 'w'.repeat(43)) =>
    new Request('https://zentra.example.test/api/internal/billing', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token },
    });
  it('private billing worker reaches recovery with GET only and never charges its recovered PENDING contract', async () => {
    await setupRenewal();
    const posts = fetchFixture.mock.calls.length;
    const response = await runPostFinanceBillingWorker(workerRequest(), {
      read: workerBindings(),
      database: d1,
      now: () => clock * 1000,
      fetch: fetchFixture as typeof fetch,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      recovery: 'bound',
      renewal: 'idle',
    });
    expect(
      fetchFixture.mock.calls.slice(posts).every((c) => c[1].method === 'GET'),
    ).toBe(true);
    expect(
      sql
        .prepare('SELECT apply_scope_hash FROM prepaid_renewal_requests')
        .get()!.apply_scope_hash,
    ).toBeNull();
  });
  it('legacy billing with recovery OFF never reads its new scheduling table', async () => {
    await setupRenewal();
    queries = [];
    const response = await runPostFinanceBillingWorker(workerRequest(), {
      read: workerBindings(false),
      database: d1,
      now: () => clock * 1000,
      fetch: fetchFixture as typeof fetch,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty('recovery');
    expect(
      queries.some((q) => q.includes('prepaid_renewal_create_recovery_jobs')),
    ).toBe(false);
    expect(fetchFixture).not.toHaveBeenCalled();
  });
  it('private billing OFF or wrong bearer refuses before DB or provider', async () => {
    const database = vi.fn(() => {
      throw Error('No DB');
    });
    expect(
      (
        await runPostFinanceBillingWorker(workerRequest(), {
          read: () => '',
          database,
        })
      ).status,
    ).toBe(503);
    expect(
      (
        await runPostFinanceBillingWorker(workerRequest('z'.repeat(43)), {
          read: workerBindings(),
          database,
        })
      ).status,
    ).toBe(401);
    expect(database).not.toHaveBeenCalled();
    expect(fetchFixture).not.toHaveBeenCalled();
  });
});
