import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import type { ZentraUser } from '@/app/zentra-auth';
import { LEGAL_VERSION } from '@/lib/legal';
import { prepaidCatalog } from './prepaid-catalog';
import { runPostFinancePurchase } from './postfinance-purchase-route';

vi.mock('@/lib/runtime', () => ({
  database: () => {
    throw Error('Inject the migrated test database.');
  },
  runtimeValue: () => '',
  stripeConfiguration: () => ({
    secretKey: '',
    siteUrl: 'https://zentra.example.test',
    siteOriginAliases: '',
    priceIds: {},
    signingKey: '',
  }),
}));
vi.mock('@/app/zentra-auth', () => ({
  getZentraUser: () => {
    throw Error('Inject the verified account.');
  },
}));
vi.mock('@/lib/site-language-server', () => ({
  currentSiteLanguage: () => 'fr',
}));

const origin = 'https://zentra.example.test';
const user: ZentraUser = {
  userId: '11111111-1111-4111-8111-111111111111',
  email: 'owner@example.test',
  displayName: 'Owner fixture',
  fullName: null,
  provider: 'supabase',
  emailConfirmed: true,
};
const body = {
  requestId: '22222222-2222-4222-8222-222222222222',
  productKey: 'gestion:solo',
  organizationId: 'company-a',
  method: 'postfinance_pay',
  acceptTerms: true,
  legalVersion: LEGAL_VERSION,
};
const clock = Date.parse('2026-10-06T10:11:12Z') / 1000;
let sql: DatabaseSync, values: Record<string, string>, reads: string[];
let identity: ZentraUser | null, transaction: Record<string, unknown> | null;
let database: Mock<() => Pick<D1Database, 'prepare' | 'batch'>>,
  authenticate: Mock<() => Promise<ZentraUser | null>>,
  rate: Mock<(request: Request) => Promise<void>>,
  transport: ReturnType<typeof vi.fn>,
  network: ReturnType<typeof vi.spyOn>;
let lostCreate: boolean;
const count = (table: string) =>
  Number(sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n);
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
  });
function d1() {
  return {
    prepare(query: string) {
      let args: SQLInputValue[] = [];
      const statement = {
        bind(...items: SQLInputValue[]) {
          args = items;
          return statement;
        },
        execute: () => ({
          success: true,
          meta: sql.prepare(query).run(...args),
        }),
        async run() {
          return statement.execute();
        },
        async first() {
          return sql.prepare(query).get(...args) ?? null;
        },
        async all() {
          return { results: sql.prepare(query).all(...args) };
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
function request(extra: Record<string, unknown> = {}, from = origin) {
  return new Request(origin + '/api/payments/postfinance/checkout', {
    method: 'POST',
    headers: { origin: from, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, ...extra }),
  });
}
const run = (input = request()) =>
  runPostFinancePurchase(input, {
    read: (name) => {
      reads.push(name);
      return values[name] ?? '';
    },
    database,
    user: authenticate,
    rateLimit: rate,
    fetch: transport as typeof fetch,
    now: () => clock,
  });
function assertNoPurchase() {
  expect(database).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
  expect(count('purchase_intents')).toBe(0);
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock * 1000);
  sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  sql.function('unixepoch', () => clock);
  for (const file of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((f) => f.endsWith('.sql'))
    .sort())
    sql.exec(
      readFileSync(new URL(`../../drizzle/${file}`, import.meta.url), 'utf8'),
    );
  sql
    .prepare(
      "INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,updated_at) VALUES('local-a','local-a','local-a','canceled',0,?)",
    )
    .run(clock);
  sql
    .prepare('INSERT INTO organizations VALUES(?,?,?,?,?,?)')
    .run(
      'company-a',
      'Synthetic company',
      'local-a',
      user.userId,
      clock,
      clock,
    );
  sql
    .prepare(
      "INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES('owner-a','company-a',?,?,'owner',?)",
    )
    .run(user.userId, user.email, clock);
  values = {
    POSTFINANCE_PURCHASES_ENABLED: 'true',
    POSTFINANCE_MERCHANT_APPROVED: 'true',
    POSTFINANCE_CHARGE_FLOW_ENABLED: 'true',
    POSTFINANCE_API_ORIGIN: 'https://checkout.postfinance.ch',
    POSTFINANCE_APPLICATION_USER_ID: '512',
    POSTFINANCE_SPACE_ID: '405',
    POSTFINANCE_AUTHENTICATION_KEY_BASE64: Buffer.alloc(32, 0x5a).toString(
      'base64',
    ),
    POSTFINANCE_RETURN_ORIGIN: origin,
    POSTFINANCE_PREPAID_ENVIRONMENT: 'TEST',
    POSTFINANCE_PAY_TOKEN_ENABLED: 'true',
    POSTFINANCE_TWINT_USER_ON_FILE_ENABLED: 'true',
    POSTFINANCE_SETTLEMENT_EVIDENCE_VERIFIED: 'true',
    POSTFINANCE_TEST_ACCOUNT_USER_IDS: JSON.stringify([user.userId]),
    POSTFINANCE_PREPAID_CONNECTORS_JSON: JSON.stringify({
      postfinance_pay: 92,
      twint: 94,
    }),
    POSTFINANCE_PREPAID_CATALOG_JSON: JSON.stringify(
      Object.fromEntries(
        prepaidCatalog().map((p) => [
          p.productKey,
          {
            currency: 'CHF',
            billingPeriod: 'P1M',
            priceChfMinor: p.priceChfMinor,
            reference: p.catalogVersion,
            name: p.name,
            methodConfigurations: { postfinance_pay: 91, twint: 93 },
          },
        ]),
      ),
    ),
  };
  reads = [];
  identity = user;
  transaction = null;
  lostCreate = false;
  database = vi.fn(d1);
  authenticate = vi.fn(async () => identity);
  rate = vi.fn(async () => {});
  transport = vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname,
      method = init.method;
    if (method === 'POST' && path === '/api/v2.0/payment/transactions') {
      transaction = {
        ...JSON.parse(init.body as string),
        id: 55,
        linkedSpaceId: 405,
        state: 'PENDING',
        version: 7,
        environment: 'PREVIEW',
        authorizationAmount: 49,
      };
      if (lostCreate) throw Error('Lost provider response after create.');
      return json(transaction);
    }
    if (method === 'GET' && path === '/api/v2.0/payment/transactions/55')
      return json(transaction);
    if (
      method === 'POST' &&
      path === '/api/v2.0/payment/transactions/55/confirm'
    ) {
      transaction!.state = 'CONFIRMED';
      transaction!.version = 8;
      return json(transaction);
    }
    if (
      method === 'GET' &&
      path === '/api/v2.0/payment/transactions/55/payment-page-url'
    )
      return json('https://checkout.postfinance.ch/payment/test-fixture');
    throw Error('Unexpected provider operation.');
  });
  network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw Error('Actual network is prohibited in these tests.');
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled();
  for (const table of [
    'prepaid_settlement_proofs',
    'prepaid_period_revocations',
    'license_activations',
    'device_sessions',
    'complete_subscriptions',
    'automation_subscriptions',
    'support_subscriptions',
  ])
    expect(count(table)).toBe(0);
  expect(
    sql.prepare('SELECT subscription_id FROM organizations').get()
      ?.subscription_id,
  ).toBe('local-a');
  sql.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('public boundary of the private PostFinance purchase preview', () => {
  it('is off without reading any secret, authenticating or reaching D1/provider', async () => {
    values.POSTFINANCE_PURCHASES_ENABLED = '';
    const response = await run();
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(reads).toEqual(['POSTFINANCE_PURCHASES_ENABLED']);
    expect(authenticate).not.toHaveBeenCalled();
    assertNoPurchase();
  });
  it('never exposes LIVE purchase while projection and recurring launch verification remain incomplete', async () => {
    values.POSTFINANCE_PREPAID_ENVIRONMENT = 'PRODUCTION';
    const response = await run();
    expect(response.status).toBe(503);
    expect(authenticate).not.toHaveBeenCalled();
    assertNoPurchase();
  });
  it.each([null, { ...user, emailConfirmed: false }])(
    'requires a freshly verified account %j',
    async (account) => {
      identity = account;
      expect((await run()).status).toBe(401);
      expect(authenticate).toHaveBeenCalledOnce();
      assertNoPurchase();
    },
  );
  it('rejects foreign origins and configured return-origin mismatch before authentication', async () => {
    expect(
      (await run(request({}, 'https://foreign.example.test'))).status,
    ).toBe(403);
    expect(authenticate).not.toHaveBeenCalled();
    assertNoPurchase();
    values.POSTFINANCE_RETURN_ORIGIN = 'https://different.example.test';
    expect((await run()).status).toBe(403);
    assertNoPurchase();
  });
  it.each([
    '',
    '[]',
    '["owner@example.test"]',
    '["*"]',
    JSON.stringify([user.userId, user.userId]),
  ])(
    'does not admit TEST accounts through an invalid allowlist %s',
    async (raw) => {
      values.POSTFINANCE_TEST_ACCOUNT_USER_IDS = raw;
      expect((await run()).status).toBe(403);
      assertNoPurchase();
    },
  );
  it.each([
    'spaceId',
    'apiOrigin',
    'priceChfMinor',
    'settlementEvidenceVerified',
    'userId',
    'connected',
    'connectorConfigurationId',
  ])(
    'refuses browser-owned %s rather than projecting it into merchant configuration',
    async (field) => {
      expect((await run(request({ [field]: 'browser-fixture' }))).status).toBe(
        400,
      );
      assertNoPurchase();
    },
  );
  it('preserves rate limits without starting a durable purchase', async () => {
    const { PublicError } = await import('@/lib/stripe');
    rate.mockRejectedValue(new PublicError('Slow down.', 429));
    expect((await run()).status).toBe(429);
    assertNoPurchase();
  });
  it.each([
    { acceptTerms: false },
    { legalVersion: 'old' },
    { requestId: 'bad' },
    { method: 'cash' },
    { organizationId: 'missing' },
    { productKey: 'gestion:fake' },
  ])(
    'rejects invalid intent/terms/target %j before merchant POST',
    async (extra) => {
      expect([400, 403]).toContain((await run(request(extra))).status);
      expect(transport).not.toHaveBeenCalled();
      expect(count('purchase_intents')).toBe(0);
    },
  );
  it('does not let another allowlisted account buy the company', async () => {
    identity = { ...user, userId: '33333333-3333-4333-8333-333333333333' };
    values.POSTFINANCE_TEST_ACCOUNT_USER_IDS = JSON.stringify([
      identity.userId,
    ]);
    expect((await run()).status).toBe(403);
    expect(transport).not.toHaveBeenCalled();
    expect(count('purchase_intents')).toBe(0);
  });
  it('returns only an approved page URL through all real D1/payment stages, and replays without another provider POST', async () => {
    const response = await run();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      url: 'https://checkout.postfinance.ch/payment/test-fixture',
    });
    const posts = () =>
      transport.mock.calls.filter(([, init]) => init.method === 'POST');
    expect(posts()).toHaveLength(2);
    expect(posts().map(([url]) => new URL(url).pathname)).toEqual([
      '/api/v2.0/payment/transactions',
      '/api/v2.0/payment/transactions/55/confirm',
    ]);
    expect(transaction?.successUrl).toContain(
      '/compte?paiement=confirmation&achat=',
    );
    const again = await run();
    expect(again.status).toBe(200);
    expect(posts()).toHaveLength(2);
  });
  it('cannot retry an uncertain provider create or charge again after a missing response', async () => {
    lostCreate = true;
    expect((await run()).status).toBe(409);
    expect((await run()).status).toBe(409);
    expect(transport).toHaveBeenCalledOnce();
    expect(sql.prepare('SELECT state FROM purchase_intents').get()?.state).toBe(
      'uncertain',
    );
  });
  it('uses generic diagnostics for invalid deployment secrets without leaking them', async () => {
    const bad = 'fixture-sensitive-private-server-value';
    values.POSTFINANCE_AUTHENTICATION_KEY_BASE64 = bad;
    const response = await run();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(bad);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(
      bad,
    );
    assertNoPurchase();
  });
});
