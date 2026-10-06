import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runPostFinanceCreateRecovery,
  type PostFinanceCreateRecoveryBinding,
} from './postfinance-create-recovery-route';
import { LEGAL_VERSION } from '@/lib/legal';
import { SUPPORT_LEGAL_VERSION } from '@/lib/support/plans';
import { COMPLETE_TERMS_VERSION } from '@/lib/complete/plans';
import { AUTOMATION_TERMS_VERSION } from '@/lib/automation/billing';
import { AUTOMATION_CONSENT_VERSION } from '@/lib/automation/config';
import { prepaidCatalog, prepaidProduct } from './prepaid-catalog';
import { prepareInitialPrepaidPurchase } from './prepaid-purchase-preparation';
import {
  runInitialPrepaidCheckout,
  type PreparedInitialPrepaidPurchase,
} from './prepaid-initial-checkout';
import type { PrepaidCreateRecoveryConfiguration } from './prepaid-create-recovery';
import { D1PostFinanceSettlementQueue } from './prepaid-observation-store';
vi.mock('@/app/zentra-auth', () => ({
  getZentraUser: async () => {
    throw Error('Inject a synthetic account');
  },
}));

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
  userId: '22222222-2222-4222-8222-222222222222',
  email: 'owner@example.test',
  emailConfirmed: true,
  displayName: 'Fictional owner',
  fullName: null,
  provider: 'supabase' as const,
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
async function setup(
  environment: 'TEST' | 'PRODUCTION' = 'TEST',
  productKey = 'gestion:start',
) {
  clock = Date.parse('2026-10-06T10:11:12Z') / 1000;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock * 1000);
  sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  sql.function('unixepoch', () => clock);
  const migrations =
    process.env.ZENTRA_MIGRATIONS_DIR ??
    fileURLToPath(new URL('../../drizzle/', import.meta.url));
  for (const f of readdirSync(migrations)
    .filter(
      (f) =>
        f.endsWith('.sql') &&
        (!process.env.ZENTRA_OBSERVATION_SQL || f < '0083'),
    )
    .sort())
    sql.exec(readFileSync(join(migrations, f), 'utf8'));
  if (process.env.ZENTRA_OBSERVATION_SQL)
    sql.exec(readFileSync(process.env.ZENTRA_OBSERVATION_SQL, 'utf8'));
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
  sql
    .prepare(
      'INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at) VALUES(?,?,?,?,?)',
    )
    .run('workspace-a', user.userId, 'Owned workspace', clock, clock);
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
      productKey,
      organizationId:
        prepaidProduct(productKey)?.productKind === 'support'
          ? undefined
          : 'company-a',
      workspaceId: prepaidProduct(productKey)?.support
        ? 'workspace-a'
        : undefined,
      method: 'postfinance_pay',
      acceptTerms: true,
      legalVersion: productKey.startsWith('gestion:')
        ? LEGAL_VERSION
        : productKey.startsWith('support:')
          ? SUPPORT_LEGAL_VERSION
          : productKey === 'automation'
            ? AUTOMATION_TERMS_VERSION
            : COMPLETE_TERMS_VERSION,
      consentVersion:
        productKey === 'automation' ? AUTOMATION_CONSENT_VERSION : undefined,
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

function values(): Record<PostFinanceCreateRecoveryBinding, string> {
  return {
    POSTFINANCE_CREATE_RECOVERY_ENABLED: 'true',
    POSTFINANCE_PURCHASES_ENABLED: 'true',
    POSTFINANCE_MERCHANT_APPROVED: 'true',
    POSTFINANCE_API_ORIGIN: 'https://checkout.postfinance.ch',
    POSTFINANCE_APPLICATION_USER_ID: '512',
    POSTFINANCE_AUTHENTICATION_KEY_BASE64: Buffer.alloc(32, 0x5a).toString(
      'base64',
    ),
    POSTFINANCE_SPACE_ID: '405',
    POSTFINANCE_RETURN_ORIGIN: 'https://zentra.example.test',
    POSTFINANCE_PREPAID_ENVIRONMENT: 'TEST',
    POSTFINANCE_PREPAID_CATALOG_JSON: JSON.stringify(
      configuration.connection.prepaidProducts,
    ),
    POSTFINANCE_PREPAID_CONNECTORS_JSON: JSON.stringify(
      configuration.connectorConfigurations,
    ),
    POSTFINANCE_CHARGE_FLOW_ENABLED: 'true',
    POSTFINANCE_PAY_TOKEN_ENABLED: 'true',
    POSTFINANCE_TWINT_USER_ON_FILE_ENABLED: 'false',
    POSTFINANCE_SETTLEMENT_EVIDENCE_VERIFIED: 'true',
    POSTFINANCE_TEST_ACCOUNT_USER_IDS: JSON.stringify([user.userId]),
  };
}
function request(
  body = JSON.stringify({ purchaseId: prepared.intent.intentId }),
  options: RequestInit = {},
) {
  return new Request(
    'https://zentra.example.test/api/payments/postfinance/recover-create',
    {
      method: 'POST',
      headers: {
        Origin: 'https://zentra.example.test',
        'Sec-Fetch-Site': 'same-origin',
        'Content-Type': 'application/json',
      },
      body,
      ...options,
    },
  );
}
const routeDeps = () => ({
  ...deps(),
  read: (name: PostFinanceCreateRecoveryBinding) => values()[name],
  user: async () => user,
});
const querySnapshot = () => [
  rights(),
  ledger(),
  sql.prepare('SELECT * FROM prepaid_transactions').all(),
  sql.prepare('SELECT * FROM prepaid_create_recoveries').all(),
  sql.prepare('SELECT * FROM postfinance_observation_jobs').all(),
];
function assertOnlyReads() {
  expect(
    fetchFixture.mock.calls.every(([, init]) => init.method === 'GET'),
  ).toBe(true);
  expect(
    fetchFixture.mock.calls.some(([url]) =>
      /confirm|charge-flow|payment-page/.test(url),
    ),
  ).toBe(false);
}

describe('explicit browser CREATE recovery with real migrated SQLite and fake provider', () => {
  it('the recovery flag OFF refuses before merchant credentials, DB and auth even when purchases remain enabled', async () => {
    const db = vi.fn(() => {
      throw Error('No DB');
    });
    const identity = vi.fn(async () => user);
    const read = vi.fn((name: PostFinanceCreateRecoveryBinding) => {
      if (name === 'POSTFINANCE_CREATE_RECOVERY_ENABLED') return 'false';
      throw Error('No other flag or credential may be read');
    });
    const result = await runPostFinanceCreateRecovery(request(), {
      ...routeDeps(),
      database: db,
      user: identity,
      read,
    });
    expect(result.status).toBe(503);
    expect(read).toHaveBeenCalledExactlyOnceWith(
      'POSTFINANCE_CREATE_RECOVERY_ENABLED',
    );
    expect(db).not.toHaveBeenCalled();
    expect(identity).not.toHaveBeenCalled();
    expect(fetchFixture).not.toHaveBeenCalled();
  });
  it.each(['support:starter', 'automation', 'complet:team'])(
    'uses the frozen %s target and price; no other company or workspace is selected by the browser',
    async (productKey) => {
      realNetwork.mockRestore();
      sql.close();
      await setup('TEST', productKey);
      const before = rights();
      const r = await runPostFinanceCreateRecovery(request(), routeDeps());
      expect(r.status).toBe(200);
      expect(((await r.json()) as { state: string }).state).toBe('tracking');
      expect(count('prepaid_transactions')).toBe(1);
      expect(count('postfinance_observation_jobs')).toBe(1);
      expect(rights()).toEqual(before);
      assertOnlyReads();
      const reference = sql
        .prepare('SELECT period_id,transaction_id FROM prepaid_transactions')
        .get();
      expect(reference).toMatchObject({
        period_id: prepared.period.periodId,
        transaction_id: 55,
      });
    },
  );
  it('binds the accepted transaction and durable observation together; replay dispatches zero provider calls and never grants access', async () => {
    const unchangedRights = rights();
    const originalIntents = sql
      .prepare('SELECT intent_id FROM purchase_intents')
      .all();
    const r = await runPostFinanceCreateRecovery(request(), routeDeps());
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      state: 'tracking',
      receiptHref: `/compte/paiement?achat=${prepared.intent.intentId}`,
    });
    expect(fetchFixture).toHaveBeenCalledTimes(4);
    assertOnlyReads();
    expect(count('prepaid_create_recoveries')).toBe(1);
    expect(count('postfinance_observation_jobs')).toBe(1);
    const jobs = sql
      .prepare('SELECT * FROM postfinance_observation_jobs')
      .all();
    fetchFixture.mockClear();
    const replay = await runPostFinanceCreateRecovery(request(), routeDeps());
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { state: string }).state).toBe('tracking');
    expect(fetchFixture).not.toHaveBeenCalled();
    expect(
      sql.prepare('SELECT * FROM postfinance_observation_jobs').all(),
    ).toEqual(jobs);
    expect(rights()).toEqual(unchangedRights);
    expect(sql.prepare('SELECT intent_id FROM purchase_intents').all()).toEqual(
      originalIntents,
    );
    expect(r.headers.get('Cache-Control')).toContain('private, no-store');
    expect(r.headers.get('Vary')).toBe('Cookie');
  });

  it.each(['OFF', 'PRODUCTION'])(
    '%s refuses before DB, auth or provider, even with an enabled allowlist',
    async (mode) => {
      const db = vi.fn(() => {
        throw Error('DB must remain unread');
      });
      const identity = vi.fn(async () => user);
      const v = values();
      if (mode === 'OFF') v.POSTFINANCE_PURCHASES_ENABLED = 'false';
      else v.POSTFINANCE_PREPAID_ENVIRONMENT = 'PRODUCTION';
      const r = await runPostFinanceCreateRecovery(request(), {
        ...routeDeps(),
        read: (n) => v[n],
        database: db,
        user: identity,
      });
      expect(r.status).toBe(503);
      expect(db).not.toHaveBeenCalled();
      expect(identity).not.toHaveBeenCalled();
      expect(fetchFixture).not.toHaveBeenCalled();
    },
  );

  it.each(['unconfirmed', 'missing', 'not-allowlisted'])(
    '%s is refused before DB/provider',
    async (mode) => {
      const db = vi.fn(() => {
        throw Error('DB must remain unread');
      });
      const identity =
        mode === 'missing'
          ? null
          : {
              ...user,
              ...(mode === 'unconfirmed'
                ? { emailConfirmed: false }
                : { userId: '33333333-3333-4333-8333-333333333333' }),
            };
      const r = await runPostFinanceCreateRecovery(request(), {
        ...routeDeps(),
        user: async () => identity,
        database: db,
      });
      expect(r.status).toBe(mode === 'not-allowlisted' ? 403 : 401);
      expect(db).not.toHaveBeenCalled();
      expect(fetchFixture).not.toHaveBeenCalled();
    },
  );

  it.each([
    { Origin: 'https://foreign.example.test' },
    { 'Sec-Fetch-Site': 'cross-site' },
    { Authorization: 'Bearer synthetic' },
    { Origin: '' },
  ])(
    'requires exact browser origin and session-only authentication: %j',
    async (change) => {
      const db = vi.fn(() => {
        throw Error('DB must remain unread');
      });
      const headers = {
        Origin: 'https://zentra.example.test',
        'Sec-Fetch-Site': 'same-origin',
        'Content-Type': 'application/json',
        ...change,
      };
      const r = await runPostFinanceCreateRecovery(
        request(undefined, { headers: headers as Record<string, string> }),
        { ...routeDeps(), database: db },
      );
      expect(r.status).toBe(403);
      expect(db).not.toHaveBeenCalled();
      expect(fetchFixture).not.toHaveBeenCalled();
    },
  );

  it.each([
    '{}',
    '[]',
    '{"purchaseId":"bad"}',
    '{"purchaseId":42}',
    '{"purchaseId":"purchase_11111111-1111-4111-8111-111111111111","periodId":"untrusted"}',
    '{"purchaseId":"purchase_11111111-1111-4111-8111-111111111111","purchaseId":"purchase_11111111-1111-4111-8111-111111111111"}',
    '{"purchaseId":"purchase_11111111-1111-4111-8111-111111111111","createRecoveryEnabled":true}',
  ])(
    'rejects noncanonical/foreign-selector input %s before DB',
    async (body) => {
      const db = vi.fn(() => {
        throw Error('DB must remain unread');
      });
      const r = await runPostFinanceCreateRecovery(request(body), {
        ...routeDeps(),
        database: db,
      });
      expect(r.status).toBe(400);
      expect(db).not.toHaveBeenCalled();
      expect(fetchFixture).not.toHaveBeenCalled();
    },
  );

  it('bounds raw body bytes and refuses wrong method', async () => {
    const db = vi.fn(() => {
      throw Error('DB must remain unread');
    });
    expect(
      (
        await runPostFinanceCreateRecovery(request(' '.repeat(513)), {
          ...routeDeps(),
          database: db,
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await runPostFinanceCreateRecovery(
          new Request(
            'https://zentra.example.test/api/payments/postfinance/recover-create',
          ),
          { ...routeDeps(), database: db },
        )
      ).status,
    ).toBe(405);
    expect(db).not.toHaveBeenCalled();
    expect(fetchFixture).not.toHaveBeenCalled();
  });

  it.each(['foreign owner', 'revoked owner', 'deleted account'])(
    '%s cannot read or recover the owned purchase',
    async (mode) => {
      if (mode === 'revoked owner')
        sql
          .prepare(
            "UPDATE organization_members SET revoked_at=? WHERE membership_id='member-a'",
          )
          .run(clock);
      if (mode === 'deleted account')
        sql
          .prepare(
            'INSERT INTO account_session_policy(user_id,revoked_before,deleted_at) VALUES(?,?,?)',
          )
          .run(user.userId, clock, clock);
      const identity =
        mode === 'foreign owner'
          ? { ...user, userId: '33333333-3333-4333-8333-333333333333' }
          : user;
      const v = values();
      v.POSTFINANCE_TEST_ACCOUNT_USER_IDS = JSON.stringify([identity.userId]);
      const before = querySnapshot();
      const r = await runPostFinanceCreateRecovery(request(), {
        ...routeDeps(),
        read: (n) => v[n],
        user: async () => identity,
      });
      expect(r.status).toBe(404);
      expect(fetchFixture).not.toHaveBeenCalled();
      expect(querySnapshot()).toEqual(before);
    },
  );

  it.each(['absent', 'ambiguous', 'unstable'])(
    '%s discovery stays unbound, does not grant or retry CREATE',
    async (reason) => {
      const before = querySnapshot();
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
            { id: 55, linkedSpaceId: 405 },
            { id: 56, linkedSpaceId: 405 },
          ],
          offset,
          limit: 10,
          hasMore: false,
        });
      if (reason === 'unstable')
        mutateRead = (tx, n) => {
          tx.version = 7 + n;
        };
      const r = await runPostFinanceCreateRecovery(request(), routeDeps());
      expect(r.status).toBe(200);
      expect(((await r.json()) as { state: string }).state).toBe(
        'verification_required',
      );
      expect(querySnapshot()).toEqual(before);
      assertOnlyReads();
    },
  );

  it('enforces its own 5/30 minute owner budget, then permits a new window without financial retry', async () => {
    search = (_, offset) => ({ data: [], offset, limit: 10, hasMore: false });
    for (let n = 0; n < 5; n++)
      expect(
        (await runPostFinanceCreateRecovery(request(), routeDeps())).status,
      ).toBe(200);
    expect(fetchFixture).toHaveBeenCalledTimes(5);
    expect(
      (await runPostFinanceCreateRecovery(request(), routeDeps())).status,
    ).toBe(429);
    expect(fetchFixture).toHaveBeenCalledTimes(5);
    clock += 1800;
    vi.setSystemTime(clock * 1000);
    expect(
      (await runPostFinanceCreateRecovery(request(), routeDeps())).status,
    ).toBe(200);
    expect(fetchFixture).toHaveBeenCalledTimes(6);
    assertOnlyReads();
    expect(count('prepaid_transactions')).toBe(0);
  });

  it('simultaneous browser requests share the atomic budget and one immutable observation', async () => {
    const before = rights();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        runPostFinanceCreateRecovery(request(), routeDeps()),
      ),
    );
    expect(results.filter((r) => r.status === 429)).toHaveLength(5);
    expect(results.filter((r) => r.status === 200)).toHaveLength(5);
    expect(count('prepaid_transactions')).toBe(1);
    expect(count('prepaid_create_recoveries')).toBe(1);
    expect(count('postfinance_observation_jobs')).toBe(1);
    expect(ledger()[0].state).toBe('completed');
    expect(rights()).toEqual(before);
    assertOnlyReads();
  });

  it('an exhausted observation stays failed8 on recovery replay and is shown as requiring verification', async () => {
    expect(
      (await runPostFinanceCreateRecovery(request(), routeDeps())).status,
    ).toBe(200);
    const queue = new D1PostFinanceSettlementQueue(
      d1(),
      {
        apiOrigin: 'https://checkout.postfinance.ch',
        spaceId: 405,
        listeners: [],
        observations: { enabled: true, environment: 'TEST' },
      },
      () => clock,
    );
    for (let n = 0; n < 8; n++) {
      const work = await queue.claimNext();
      expect(work).not.toBeNull();
      expect(await queue.failWork(work!, 'provider_unavailable')).toBe(true);
      clock += 3601;
      vi.setSystemTime(clock * 1000);
    }
    const before = sql
      .prepare('SELECT * FROM postfinance_observation_jobs')
      .all();
    expect(before[0]).toMatchObject({ state: 'failed', attempts: 8 });
    fetchFixture.mockClear();
    const r = await runPostFinanceCreateRecovery(request(), routeDeps());
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      state: 'verification_required',
      receiptHref: `/compte/paiement?achat=${prepared.intent.intentId}`,
    });
    expect(
      sql.prepare('SELECT * FROM postfinance_observation_jobs').all(),
    ).toEqual(before);
    expect(fetchFixture).not.toHaveBeenCalled();
    expect(await queue.claimNext()).toBeNull();
  });

  it('revocation after the last GET rolls back binding, receipt and observation together', async () => {
    const original = search;
    search = (n, offset) => {
      if (n === 2)
        sql
          .prepare(
            "UPDATE organization_members SET revoked_at=? WHERE membership_id='member-a'",
          )
          .run(clock);
      return original(n, offset);
    };
    const r = await runPostFinanceCreateRecovery(request(), routeDeps());
    expect(r.status).toBe(503);
    expect(count('prepaid_transactions')).toBe(0);
    expect(count('prepaid_create_recoveries')).toBe(0);
    expect(count('postfinance_observation_jobs')).toBe(0);
    expect(ledger()[0].state).toBe('uncertain');
    assertOnlyReads();
  });

  it('batch failure on observation admission rolls back the financial binding and preserves CREATE uncertainty', async () => {
    interruptStatement = 'INSERT INTO postfinance_observation_jobs';
    const before = querySnapshot();
    const r = await runPostFinanceCreateRecovery(request(), routeDeps());
    expect(r.status).toBe(503);
    expect(querySnapshot()).toEqual(before);
    assertOnlyReads();
  });

  it('a changed authenticated account after provider reads receives no receipt link', async () => {
    let n = 0;
    const r = await runPostFinanceCreateRecovery(request(), {
      ...routeDeps(),
      user: async () =>
        ++n === 1
          ? user
          : { ...user, userId: '33333333-3333-4333-8333-333333333333' },
    });
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ code: 'account_required' });
    expect(count('prepaid_transactions')).toBe(1);
    expect(count('postfinance_observation_jobs')).toBe(1); // accepted money remains tracked, never a new charge
    assertOnlyReads();
  });

  it('aborts before the atomic batch even if a provider fixture ignores the signal and responds late', async () => {
    const abort = new AbortController();
    const original = search;
    search = (n, offset) => {
      if (n === 2) abort.abort();
      return original(n, offset);
    };
    const before = querySnapshot();
    const r = await runPostFinanceCreateRecovery(
      request(undefined, { signal: abort.signal }),
      routeDeps(),
    );
    expect(r.status).toBe(503);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(querySnapshot()).toEqual(before);
    assertOnlyReads();
  });

  it('the global 30 second deadline rejects a hanging GET; its eventual response cannot bind anything', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    let release!: () => void;
    fetchFixture.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return Response.json({
        data: [{ id: 55, linkedSpaceId: 405 }],
        offset: 0,
        limit: 10,
        hasMore: false,
      });
    });
    const before = querySnapshot();
    const pending = runPostFinanceCreateRecovery(request(), routeDeps());
    for (let n = 0; n < 100 && !release; n++)
      await new Promise((resolve) => setImmediate(resolve));
    expect(release).toBeTypeOf('function');
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await pending).status).toBe(503);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(querySnapshot()).toEqual(before);
    expect(fetchFixture).toHaveBeenCalledTimes(1);
  });
});
