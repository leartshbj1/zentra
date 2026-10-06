// Proposed destination: lib/payments/postfinance-option-attempt.test.ts.
// Synthetic local fixtures only. No provider, auth, or production HTTP is used.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import type { ZentraUser } from '@/app/zentra-auth';

const fixture = vi.hoisted(() => ({
  database: null as unknown,
  authenticate:
    vi.fn<
      (options: {
        refreshSession?: boolean;
        offerAccess?: boolean;
      }) => Promise<ZentraUser | null>
    >(),
  binding: vi.fn<(name: string) => string>(),
}));
vi.mock('@/lib/runtime', () => ({
  database: () => fixture.database,
  runtimeValue: (name: string) => fixture.binding(name),
  stripeConfiguration: () => ({
    secretKey: '',
    siteUrl: 'https://zentra.example.test',
    siteOriginAliases: '',
    priceIds: {},
    signingKey: '',
  }),
}));
vi.mock('@/app/zentra-auth', () => ({
  getZentraUser: (options: {
    refreshSession?: boolean;
    offerAccess?: boolean;
  }) => fixture.authenticate(options),
}));
vi.mock('@/lib/site-language-server', () => ({
  currentSiteLanguage: () => 'fr',
}));

import { LEGAL_VERSION } from '@/lib/legal';
import { SUPPORT_LEGAL_VERSION } from '@/lib/support/plans';
import { COMPLETE_TERMS_VERSION } from '@/lib/complete/plans';
import { AUTOMATION_TERMS_VERSION } from '@/lib/automation/billing';
import { AUTOMATION_CONSENT_VERSION } from '@/lib/automation/config';
import { prepaidCatalog, prepaidProduct } from '@/lib/payments/prepaid-catalog';
import { postFinancePurchaseConfiguration } from '@/lib/payments/postfinance-purchase-configuration';
import {
  postFinancePurchaseOption,
  ownedPostFinanceTargets,
} from '@/lib/payments/postfinance-option';
import { runPostFinanceOption } from '@/lib/payments/postfinance-option-route';
import { runPostFinanceAttempt } from '@/lib/payments/postfinance-attempt-route';
import { prepareInitialPrepaidPurchase } from '@/lib/payments/prepaid-purchase-preparation';
import { D1PurchaseIntents } from '@/lib/payments/purchase-intents';

const origin = 'https://zentra.example.test';
const requestId = '22222222-2222-4222-8222-222222222222';
const user: ZentraUser = {
  userId: '11111111-1111-4111-8111-111111111111',
  email: 'owner@example.test',
  emailConfirmed: true,
  displayName: 'Synthetic owner',
  fullName: null,
  provider: 'supabase',
};
const foreign: ZentraUser = {
  ...user,
  userId: '33333333-3333-4333-8333-333333333333',
  email: 'other@example.test',
};
let sql: DatabaseSync, values: Record<string, string>, queries: string[];
let network: ReturnType<typeof vi.spyOn>;
const clock = Date.parse('2026-10-06T10:11:12Z') / 1000;

function d1(readOnly = false) {
  return {
    prepare(query: string) {
      if (readOnly) {
        if (!/^\s*SELECT\b/i.test(query))
          throw Error('Read-only payment display attempted a write.');
        queries.push(query);
      }
      let parameters: SQLInputValue[] = [];
      const statement = {
        bind(...args: SQLInputValue[]) {
          parameters = args;
          return statement;
        },
        execute() {
          if (readOnly)
            throw Error('No writes in payment option or attempt recovery.');
          return { success: true, meta: sql.prepare(query).run(...parameters) };
        },
        async run() {
          return statement.execute();
        },
        async first() {
          return sql.prepare(query).get(...parameters) ?? null;
        },
        async all() {
          return {
            success: true,
            results: sql.prepare(query).all(...parameters),
          };
        },
      };
      return statement;
    },
    async batch(statements: { execute(): unknown }[]) {
      if (readOnly) throw Error('No batch in read-only payment display.');
      sql.exec('BEGIN');
      try {
        const results = statements.map((statement) => statement.execute());
        sql.exec('COMMIT');
        return results;
      } catch (error) {
        sql.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as Pick<D1Database, 'prepare' | 'batch'>;
}
function snapshot() {
  return JSON.stringify(
    sql
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map(({ name }) => {
        if (typeof name !== 'string')
          throw Error('Invalid fixture table name.');
        return [
          name,
          sql.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
        ];
      }),
  );
}
function seedCompany(id: string, owner = user) {
  sql
    .prepare(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at)
    VALUES(?,?,?,'canceled',0,1,?)`)
    .run(`local-${id}`, `customer-${id}`, 'fixture', clock);
  sql
    .prepare('INSERT INTO organizations VALUES(?,?,?,?,?,?)')
    .run(id, `Synthetic ${id}`, `local-${id}`, owner.userId, clock, clock);
  sql
    .prepare(`INSERT INTO organization_members(membership_id,organization_id,user_id,email,display_name,role,joined_at)
    VALUES(?,?,?,?,?,'owner',?)`)
    .run(
      `owner-${id}`,
      id,
      owner.userId,
      owner.email,
      owner.displayName,
      clock,
    );
}
function seedWorkspace(id: string, owner = user) {
  sql
    .prepare(
      'INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at) VALUES(?,?,?,?,?)',
    )
    .run(id, owner.userId, `Synthetic ${id}`, clock, clock);
}
const optionRequest = (
  search = '?product=gestion%3Asolo',
  init: RequestInit = {},
) => new Request(origin + '/api/payments/postfinance/option' + search, init);
function attemptRequest(
  changes: Record<string, string | null> = {},
  init: RequestInit = {},
) {
  const params = new URLSearchParams({
    requestId,
    product: 'gestion:solo',
    organizationId: 'company-b',
  });
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) params.delete(key);
    else params.set(key, value);
  }
  return new Request(
    origin + '/api/payments/postfinance/attempt?' + params,
    init,
  );
}
const option = (key: unknown = 'gestion:solo', from = origin) =>
  postFinancePurchaseOption(
    key,
    from,
    () => fixture.authenticate({ refreshSession: true, offerAccess: false }),
    fixture.binding,
  );
async function readAttempt(request = attemptRequest()) {
  const before = snapshot();
  queries = [];
  fixture.database = d1(true);
  const response = await runPostFinanceAttempt(request);
  expect(snapshot()).toBe(before);
  return response;
}
async function prepare(
  productKey = 'gestion:solo',
  environment: 'TEST' | 'PRODUCTION' = 'TEST',
) {
  const product = prepaidProduct(productKey)!;
  const configuration = postFinancePurchaseConfiguration((name) =>
    name === 'POSTFINANCE_PREPAID_ENVIRONMENT'
      ? environment
      : (values[name] ?? ''),
  );
  const result = await prepareInitialPrepaidPurchase(
    configuration,
    {
      user,
      requestId,
      productKey,
      organizationId:
        product.productKind === 'support' ? undefined : 'company-b',
      workspaceId: product.support ? 'workspace-b' : undefined,
      method: 'postfinance_pay',
      acceptTerms: true,
      legalVersion:
        product.productKind === 'gestion'
          ? LEGAL_VERSION
          : product.productKind === 'support'
            ? SUPPORT_LEGAL_VERSION
            : product.productKind === 'complete'
              ? COMPLETE_TERMS_VERSION
              : AUTOMATION_TERMS_VERSION,
      consentVersion:
        product.productKind === 'automation'
          ? AUTOMATION_CONSENT_VERSION
          : undefined,
    },
    { database: () => d1(), now: () => clock },
  );
  if (result.state !== 'prepared') throw Error('Synthetic preparation failed.');
  return result;
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock * 1000);
  sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  sql.function('unixepoch', () => clock);
  // Relative path intentionally matches the proposed lib/payments destination.
  for (const file of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((file) => file.endsWith('.sql'))
    .sort())
    sql.exec(
      readFileSync(new URL(`../../drizzle/${file}`, import.meta.url), 'utf8'),
    );
  seedCompany('company-a');
  seedCompany('company-b');
  seedCompany('company-foreign', foreign);
  seedWorkspace('workspace-b');
  seedWorkspace('workspace-foreign', foreign);
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
        prepaidCatalog().map((product) => [
          product.productKey,
          {
            currency: 'CHF',
            billingPeriod: 'P1M',
            priceChfMinor: product.priceChfMinor,
            reference: product.catalogVersion,
            name: product.name,
            methodConfigurations: { postfinance_pay: 91, twint: 93 },
          },
        ]),
      ),
    ),
  };
  fixture.binding.mockReset().mockImplementation((name) => values[name] ?? '');
  fixture.authenticate.mockReset().mockResolvedValue(user);
  queries = [];
  fixture.database = d1(true);
  network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw Error('No external or provider HTTP allowed.');
  });
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled();
  network.mockRestore();
  sql.close();
  vi.useRealTimers();
});

describe('read-only private TEST PostFinance option', () => {
  it('OFF reads only the switch and neither authenticates nor reads the database', async () => {
    values.POSTFINANCE_PURCHASES_ENABLED = 'false';
    expect(await option()).toEqual({ available: false, testMode: false });
    expect(fixture.binding.mock.calls).toEqual([
      ['POSTFINANCE_PURCHASES_ENABLED'],
    ]);
    expect(fixture.authenticate).not.toHaveBeenCalled();
    expect(queries).toEqual([]);
  });
  it('still refuses PRODUCTION with all flags and settlement verification enabled', async () => {
    values.POSTFINANCE_PREPAID_ENVIRONMENT = 'PRODUCTION';
    expect(await option()).toEqual({ available: false, testMode: false });
    expect(fixture.authenticate).not.toHaveBeenCalled();
    expect(queries).toEqual([]);
  });
  it.each(['gestion:solo', 'support:starter', 'automation', 'complet:team'])(
    'advertises only public TEST readiness for configured %s, without reservations or secrets',
    async (productKey) => {
      const before = snapshot();
      const response = await runPostFinanceOption(
        optionRequest('?product=' + encodeURIComponent(productKey)),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        available: true,
        testMode: true,
      });
      expect(response.headers.get('Cache-Control')).toContain(
        'private, no-store',
      );
      expect(response.headers.get('Vary')).toBe('Cookie');
      expect(fixture.authenticate).toHaveBeenCalledExactlyOnceWith({
        refreshSession: true,
        offerAccess: false,
      });
      expect(queries).toEqual([]);
      expect(snapshot()).toBe(before);
    },
  );
  it.each([null, { ...user, emailConfirmed: false }, foreign])(
    'requires a verified allowlisted identity %j',
    async (account) => {
      fixture.authenticate.mockResolvedValue(account);
      expect(await option()).toEqual({ available: false, testMode: false });
      expect(queries).toEqual([]);
    },
  );
  it.each([
    '',
    'not-json',
    JSON.stringify([user.userId, user.userId]),
    JSON.stringify(['invalid-user-id']),
  ])('fails closed for invalid allowlist %j', async (allowlist) => {
    values.POSTFINANCE_TEST_ACCOUNT_USER_IDS = allowlist;
    expect(await option()).toEqual({ available: false, testMode: false });
  });
  it('does not enable a product just because another configured product has PostFinance Pay', async () => {
    const catalogue = JSON.parse(values.POSTFINANCE_PREPAID_CATALOG_JSON);
    catalogue['gestion:solo'].methodConfigurations = { twint: 93 };
    values.POSTFINANCE_PREPAID_CATALOG_JSON = JSON.stringify(catalogue);
    expect(await option()).toEqual({ available: false, testMode: false });
    expect(fixture.authenticate).not.toHaveBeenCalled();
  });
  it('refuses a different return origin and hides invalid server configuration', async () => {
    expect(await option('gestion:solo', 'https://other.example.test')).toEqual({
      available: false,
      testMode: false,
    });
    values.POSTFINANCE_AUTHENTICATION_KEY_BASE64 = 'broken';
    expect(await option()).toEqual({ available: false, testMode: false });
    expect(fixture.authenticate).not.toHaveBeenCalled();
  });
  it.each([
    '?product=unknown',
    '?product=gestion%3Asolo&product=automation',
    '?product=automation&ownerId=other',
    '',
  ])(
    'rejects malformed or ambiguous product query %s before reading settings or identity',
    async (search) => {
      const response = await runPostFinanceOption(optionRequest(search));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ code: 'product_not_found' });
      expect(fixture.binding).not.toHaveBeenCalled();
      expect(fixture.authenticate).not.toHaveBeenCalled();
    },
  );
  it.each([
    { Authorization: 'Bearer synthetic' },
    { 'Sec-Fetch-Site': 'cross-site' },
  ] as Record<string, string>[])(
    'never accepts bearer or cross-site display admission %j',
    async (headers) => {
      const response = await runPostFinanceOption(
        optionRequest(undefined, { headers }),
      );
      expect(await response.json()).toEqual({
        available: false,
        testMode: false,
      });
      expect(fixture.binding).not.toHaveBeenCalled();
      expect(fixture.authenticate).not.toHaveBeenCalled();
    },
  );
  it('does not turn POST into an option or purchase', async () => {
    const response = await runPostFinanceOption(
      optionRequest(undefined, { method: 'POST' }),
    );
    expect(response.status).toBe(405);
    expect(fixture.authenticate).not.toHaveBeenCalled();
    expect(queries).toEqual([]);
  });
});

describe('authoritative owner-only payment target discovery', () => {
  it('returns both actual owned companies and the standalone workspace, never the other owner or a default target', async () => {
    const before = snapshot();
    const targets = await ownedPostFinanceTargets(d1(true), user.userId);
    expect(targets).toEqual({
      organizations: [
        { id: 'company-a', name: 'Synthetic company-a' },
        { id: 'company-b', name: 'Synthetic company-b' },
      ],
      workspaces: [
        {
          id: 'workspace-b',
          name: 'Synthetic workspace-b',
          organizationId: null,
        },
      ],
    });
    expect(snapshot()).toBe(before);
  });
  it('uses the real workspace link and hides its company after ownership is revoked', async () => {
    sql
      .prepare(
        'INSERT INTO support_gestion_links(workspace_id,organization_id,connected_by,created_at) VALUES(?,?,?,?)',
      )
      .run('workspace-b', 'company-b', user.userId, clock);
    expect(
      (await ownedPostFinanceTargets(d1(true), user.userId)).workspaces,
    ).toEqual([
      {
        id: 'workspace-b',
        name: 'Synthetic workspace-b',
        organizationId: 'company-b',
      },
    ]);
    sql
      .prepare(
        'UPDATE organization_members SET revoked_at=? WHERE membership_id=?',
      )
      .run(clock, 'owner-company-b');
    expect(await ownedPostFinanceTargets(d1(true), user.userId)).toEqual({
      organizations: [{ id: 'company-a', name: 'Synthetic company-a' }],
      workspaces: [],
    });
  });
  it('a former verified session cannot reveal payment targets of a deleted account', async () => {
    sql
      .prepare(
        'INSERT INTO account_session_policy(user_id,revoked_before,deleted_at) VALUES(?,?,?)',
      )
      .run(user.userId, clock, clock);
    expect(await ownedPostFinanceTargets(d1(true), user.userId)).toEqual({
      organizations: [],
      workspaces: [],
    });
  });
});

describe('strict read-only receipt recovery after a lost checkout response', () => {
  it('finds company B exactly, not the owner’s first company, with the genuine pending receipt reader', async () => {
    const prepared = await prepare();
    const response = await readAttempt();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      receiptHref: '/compte/paiement?achat=' + prepared.intent.intentId,
    });
    expect(response.headers.get('Cache-Control')).toContain(
      'private, no-store',
    );
    expect(response.headers.get('Vary')).toBe('Cookie');
    expect(fixture.authenticate).toHaveBeenCalledExactlyOnceWith({
      refreshSession: true,
      offerAccess: false,
    });
    expect(queries.length).toBeGreaterThan(1);
    expect(
      sql.prepare('SELECT COUNT(*) AS n FROM prepaid_settlement_proofs').get()
        ?.n,
    ).toBe(0);
  });
  it('does not replay any financial POST for an uncertain receipt', async () => {
    const prepared = await prepare();
    const journal = new D1PurchaseIntents(d1(), () => clock);
    await journal.markDispatched(prepared.intent);
    await journal.markUncertain(prepared.intent);
    const response = await readAttempt();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      receiptHref: '/compte/paiement?achat=' + prepared.intent.intentId,
    });
    expect(
      sql
        .prepare('SELECT state FROM purchase_intents WHERE intent_id=?')
        .get(prepared.intent.intentId)?.state,
    ).toBe('uncertain');
  });
  it.each([
    { requestId: '44444444-4444-4444-8444-444444444444' },
    { product: 'gestion:start' },
    { organizationId: 'company-a' },
    { organizationId: null },
    { workspaceId: 'workspace-b' },
  ] as Record<string, string | null>[])(
    'refuses a coherent but different request, product, or target %j',
    async (change) => {
      await prepare();
      const response = await readAttempt(attemptRequest(change));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ code: 'attempt_not_found' });
    },
  );
  it('requires the exact standalone Support null company and workspace', async () => {
    const prepared = await prepare('support:starter');
    const exact = await readAttempt(
      attemptRequest({
        product: 'support:starter',
        organizationId: null,
        workspaceId: 'workspace-b',
      }),
    );
    expect(exact.status).toBe(200);
    expect(await exact.json()).toEqual({
      receiptHref: '/compte/paiement?achat=' + prepared.intent.intentId,
    });
    expect(
      (
        await readAttempt(
          attemptRequest({
            product: 'support:starter',
            workspaceId: 'workspace-b',
          }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await readAttempt(
          attemptRequest({
            product: 'support:starter',
            organizationId: null,
            workspaceId: 'workspace-foreign',
          }),
        )
      ).status,
    ).toBe(404);
  });
  it('hides another owner’s request even when every public identifier is known', async () => {
    await prepare();
    fixture.authenticate.mockResolvedValue(foreign);
    const response = await readAttempt();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: 'attempt_not_found' });
  });
  it.each(['revoked', 'deleted'])(
    'revalidates %s account ownership instead of trusting the lookup row',
    async (changed) => {
      await prepare();
      if (changed === 'revoked')
        sql
          .prepare(
            'UPDATE organization_members SET revoked_at=? WHERE membership_id=?',
          )
          .run(clock, 'owner-company-b');
      else
        sql
          .prepare(
            'INSERT INTO account_session_policy(user_id,revoked_before,deleted_at) VALUES(?,?,?)',
          )
          .run(user.userId, clock, clock);
      const response = await readAttempt();
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ code: 'attempt_not_found' });
    },
  );
  it('does not pick the first of two genuine environmental matches', async () => {
    const test = await prepare('gestion:solo', 'TEST'),
      liveFixture = await prepare('gestion:solo', 'PRODUCTION');
    expect(test.intent.intentId).not.toBe(liveFixture.intent.intentId);
    expect(
      sql.prepare('SELECT COUNT(*) AS n FROM purchase_intents').get()?.n,
    ).toBe(2);
    const response = await readAttempt();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: 'attempt_not_found' });
    expect(queries).toHaveLength(1);
  });
  it.each([
    { requestId: null },
    { requestId: 'not-a-uuid' },
    { requestId: 'ABCDEF01-2222-4222-8222-222222222222' },
    { product: null },
    { product: 'unknown' },
    { organizationId: '' },
    { organizationId: 'company-b\n' },
    { workspaceId: '\u0000' },
    { workspaceId: 'x'.repeat(181) },
    { ownerId: foreign.userId },
  ] as Record<string, string | null>[])(
    'rejects malformed parameters before any database lookup %j',
    async (changed) => {
      const response = await readAttempt(attemptRequest(changed));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ code: 'attempt_not_found' });
      expect(queries).toEqual([]);
    },
  );
  it('rejects duplicate request IDs even when the first pointer is genuine', async () => {
    await prepare();
    const request = attemptRequest();
    const url = new URL(request.url);
    url.searchParams.append('requestId', requestId);
    const response = await readAttempt(new Request(url));
    expect(response.status).toBe(404);
    expect(queries).toEqual([]);
  });
  it.each([null, { ...user, emailConfirmed: false }])(
    'does not query requests for an unconfirmed or absent account %j',
    async (account) => {
      fixture.authenticate.mockResolvedValue(account);
      const response = await readAttempt();
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ code: 'account_required' });
      expect(queries).toEqual([]);
    },
  );
  it.each([
    { Authorization: 'Bearer synthetic' },
    { 'Sec-Fetch-Site': 'cross-site' },
  ] as Record<string, string>[])(
    'refuses non-browser recovery %j before authentication or database',
    async (headers) => {
      const response = await readAttempt(attemptRequest({}, { headers }));
      expect(response.status).toBe(401);
      expect(fixture.authenticate).not.toHaveBeenCalled();
      expect(queries).toEqual([]);
    },
  );
  it('cannot trigger recovery or payment through POST', async () => {
    const response = await readAttempt(attemptRequest({}, { method: 'POST' }));
    expect(response.status).toBe(405);
    expect(fixture.authenticate).not.toHaveBeenCalled();
    expect(queries).toEqual([]);
  });
});
