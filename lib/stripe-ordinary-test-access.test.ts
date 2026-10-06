// The access decision, runtime binding, HTTP route, catalog validation and
// checkout persistence are real. Auth/readiness and Stripe transports are closed
// fixtures; this does not certify a provider payment or an account lifecycle.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import type Stripe from 'stripe';
import type { ZentraUser } from '@/app/zentra-auth';

const state = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
  user: null as ZentraUser | null,
  ready: vi.fn(),
  rate: vi.fn(),
  create: vi.fn(),
  retrieve: vi.fn(),
  list: vi.fn(),
  expire: vi.fn(),
  prices: vi.fn(),
  product: vi.fn(),
  fetch: vi.fn(),
  cookie: vi.fn(),
}));
vi.mock('cloudflare:workers', () => ({ env: state.env }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ set: state.cookie }),
  headers: () => new Headers(),
}));
vi.mock('@/app/zentra-auth', () => ({ getZentraUser: async () => state.user }));
vi.mock('@/lib/stripe-readiness', () => ({
  assertStripeCheckoutReady: state.ready,
  stripeCheckoutReadiness: state.ready,
}));
vi.mock('@/lib/stripe', async (original) => ({
  ...(await original<object>()),
  enforceCheckoutRateLimit: state.rate,
}));
vi.mock('stripe', () => ({
  default: class {
    static createFetchHttpClient() {
      return {};
    }
    checkout = {
      sessions: {
        create: state.create,
        retrieve: state.retrieve,
        list: state.list,
        expire: state.expire,
      },
    };
    prices = { list: state.prices };
    products = { retrieve: state.product };
  },
}));

import { stripeConfiguration } from './runtime';
import {
  stripeAutomaticTaxRequired,
  stripeTestAccessAllowed,
} from './stripe-test-access';
import { POST as checkout } from '@/app/api/complete/checkout/route';
import { POST as gestionCheckout } from '@/app/api/stripe/checkout/route';
import { GET as status } from '@/app/api/stripe/status/route';
import { completePlan, COMPLETE_TERMS_VERSION } from './complete/plans';
import { LEGAL_VERSION } from './legal';
import { PublicError } from './stripe';
import {
  billingState,
  isSupportOwner,
  requireSupportSubscription,
} from './support/billing';
import { getPlatformState } from './support/service';
import {
  isAutomationFounder,
  requireAutomationFounder,
} from './automation/access';

const clientId = 'a1111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const ownerId = '33333333-3333-4333-8333-333333333333';
const user = {
  userId: clientId,
  email: 'ordinary@example.invalid',
  displayName: 'Synthetic ordinary client',
  fullName: 'Synthetic ordinary client',
  emailConfirmed: true,
  provider: 'supabase',
} as const;
const plan = completePlan('team')!;
const origin = 'https://sandbox.example.invalid';
const now = Math.floor(new Date('2026-10-06T10:11:12Z').getTime() / 1000);
let sql: DatabaseSync;
let writes: string[];
function request(body: Record<string, unknown> = {}, requestOrigin = origin) {
  return new Request(origin + '/api/complete/checkout', {
    method: 'POST',
    headers: { origin: requestOrigin, 'content-type': 'application/json' },
    body: JSON.stringify({
      plan: 'team',
      acceptTerms: true,
      legalVersion: COMPLETE_TERMS_VERSION,
      ...body,
    }),
  });
}
function prepare(query: string) {
  let args: SQLInputValue[] = [];
  const p = {
    bind(...values: SQLInputValue[]) {
      args = values;
      return p;
    },
    first: async () => sql.prepare(query).get(...args) ?? null,
    all: async () => ({ results: sql.prepare(query).all(...args) }),
    execute() {
      writes.push(query);
      return {
        success: true,
        meta: { changes: Number(sql.prepare(query).run(...args).changes) },
      };
    },
    run: async () => p.execute(),
  };
  return p;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now * 1000);
  for (const key of Object.keys(state.env)) delete state.env[key];
  Object.assign(state.env, {
    STRIPE_SECRET_KEY: 'sk_test_synthetic_not_a_real_key',
    STRIPE_TEST_MODE: 'accounts_only',
    STRIPE_TEST_ACCOUNT_USER_IDS: JSON.stringify([clientId]),
    OWNER_ACCOUNT_USER_ID: ownerId,
    ZENTRA_OWNER_EMAIL: 'founder@example.invalid',
    PUBLIC_SITE_URL: origin,
    STRIPE_PRICE_SOLO_ID: 'price_solo_synthetic',
    LICENSE_SIGNING_KEY_PKCS8_B64URL: generateKeyPairSync('ed25519')
      .privateKey.export({ format: 'der', type: 'pkcs8' })
      .toString('base64url'),
  });
  // Only fixture values can reach process.env fallbacks; never inspect host secrets.
  for (const key of [
    'STRIPE_SECRET_KEY',
    'STRIPE_TEST_MODE',
    'STRIPE_TEST_ACCOUNT_USER_IDS',
    'OWNER_ACCOUNT_USER_ID',
    'ZENTRA_OWNER_EMAIL',
    'PUBLIC_SITE_URL',
    'STRIPE_WEBHOOK_SECRET',
    'STRIPE_WEBHOOK_ENDPOINT_ID',
    'STRIPE_WEBHOOK_URL',
    'STRIPE_PRICE_ID',
    'STRIPE_PRICE_SOLO_ID',
    'STRIPE_PRICE_START_ID',
    'STRIPE_PRICE_PRO_ID',
    'LICENSE_SIGNING_KEY_PKCS8_B64URL',
    'SITE_ORIGIN_ALIASES',
    'TYPESAFE_API_KEY',
    'SUPPORT_ADMIN_TOKEN_SHA256',
  ])
    vi.stubEnv(key, '');
  state.user = user;
  state.ready.mockResolvedValue({ portalLoginUrl: origin + '/portal-fixture' });
  // The SDK transports mirror the real frozen request, not controller state.
  // Repeated keys must keep the same parameters and return the same session.
  const sessions = new Map<string, Stripe.Checkout.Session>();
  const idempotent = new Map<
    string,
    {
      parameters: Stripe.Checkout.SessionCreateParams;
      session: Stripe.Checkout.Session;
    }
  >();
  state.create.mockImplementation(
    async (
      parameters: Stripe.Checkout.SessionCreateParams,
      options: { idempotencyKey: string },
    ) => {
      const previous = idempotent.get(options.idempotencyKey);
      if (previous) {
        expect(parameters).toEqual(previous.parameters);
        return structuredClone(previous.session);
      }
      const session = {
        id: 'cs_synthetic',
        status: 'open',
        url: 'https://checkout.stripe.com/synthetic-not-real',
        mode: parameters.mode,
        livemode: false,
        created: now,
        metadata: structuredClone(parameters.metadata),
        client_reference_id: parameters.client_reference_id,
        expires_at: parameters.expires_at,
      } as Stripe.Checkout.Session;
      sessions.set(session.id, session);
      idempotent.set(options.idempotencyKey, {
        parameters: structuredClone(parameters),
        session,
      });
      return structuredClone(session);
    },
  );
  state.retrieve.mockImplementation(async (id: string) => {
    const session = sessions.get(id);
    if (!session) throw new Error('Unknown synthetic session');
    return structuredClone(session);
  });
  state.list.mockImplementation(async () => ({
    data: structuredClone([...sessions.values()]),
    has_more: false,
  }));
  state.expire.mockImplementation(async (id: string) => {
    const session = sessions.get(id);
    if (!session) throw new Error('Unknown synthetic session');
    session.status = 'expired';
    session.url = null;
    return structuredClone(session);
  });
  state.prices.mockResolvedValue({
    data: [
      {
        id: 'price_synthetic',
        active: true,
        livemode: false,
        currency: 'chf',
        unit_amount: plan.priceChfCents,
        product: plan.productId,
        lookup_key: plan.lookupKey,
        tax_behavior: 'inclusive',
        recurring: {
          interval: 'month',
          interval_count: 1,
          usage_type: 'licensed',
        },
        metadata: { service: 'zentra-complet', bundle_plan: plan.id },
      },
    ],
  });
  state.product.mockResolvedValue({
    id: plan.productId,
    active: true,
    tax_code: 'txcd_10000000',
  });
  state.fetch.mockRejectedValue(
    new Error('Provider network is closed in this witness'),
  );
  vi.stubGlobal('fetch', state.fetch);
  sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  sql.function('unixepoch', () => now);
  for (const file of readdirSync(new URL('../drizzle/', import.meta.url))
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    sql.exec(
      readFileSync(new URL('../drizzle/' + file, import.meta.url), 'utf8'),
    );
  }
  writes = [];
  state.env.DB = {
    prepare,
    batch: async (queries: ReturnType<typeof prepare>[]) => {
      sql.exec('BEGIN');
      try {
        const result = queries.map((q) => q.execute());
        sql.exec('COMMIT');
        return result;
      } catch (error) {
        sql.exec('ROLLBACK');
        throw error;
      }
    },
  };
});
afterEach(() => {
  expect(state.fetch).not.toHaveBeenCalled();
  sql.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('ordinary sandbox payment accounts', () => {
  it('reads the independent allowlist from the real worker configuration', () => {
    expect(stripeConfiguration()).toMatchObject({
      testAccountUserIds: JSON.stringify([clientId]),
      ownerAccountUserId: ownerId,
    });
    expect(stripeTestAccessAllowed(stripeConfiguration(), user)).toBe(true);
    expect(stripeAutomaticTaxRequired(stripeConfiguration())).toBe(true);
  });
  it('also uses the existing server process fallback without owner settings', () => {
    state.env.STRIPE_TEST_ACCOUNT_USER_IDS = '';
    state.env.OWNER_ACCOUNT_USER_ID = '';
    state.env.ZENTRA_OWNER_EMAIL = '';
    vi.stubEnv('STRIPE_TEST_ACCOUNT_USER_IDS', JSON.stringify([clientId]));
    expect(stripeTestAccessAllowed(stripeConfiguration(), user)).toBe(true);
  });
  it('never substitutes owner id, founder email, or an email match for the allowlist', () => {
    expect(
      stripeTestAccessAllowed(stripeConfiguration(), {
        ...user,
        userId: ownerId,
        email: 'founder@example.invalid',
      }),
    ).toBe(false);
    expect(
      stripeTestAccessAllowed(stripeConfiguration(), {
        ...user,
        userId: otherId,
      }),
    ).toBe(false);
    state.env.STRIPE_TEST_ACCOUNT_USER_IDS = JSON.stringify([otherId]);
    expect(stripeTestAccessAllowed(stripeConfiguration(), user)).toBe(false);
  });
  it.each([
    undefined,
    '',
    ' ',
    'null',
    '{}',
    '"11111111-1111-4111-8111-111111111111"',
    '[]',
    'not-json',
    '["*"]',
    '[1]',
    '[null]',
    '[{}]',
    '["ordinary@example.invalid"]',
    JSON.stringify([clientId, 'malformed']),
    JSON.stringify([clientId, clientId]),
    JSON.stringify([clientId, clientId.toUpperCase()]),
    JSON.stringify(
      Array.from(
        { length: 21 },
        (_, n) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`,
      ),
    ),
    '[' + ' '.repeat(4097) + JSON.stringify(clientId) + ']',
  ])(
    'refuses the entire missing, malformed or excessive configuration %j',
    (value) => {
      state.env.STRIPE_TEST_ACCOUNT_USER_IDS = value;
      expect(stripeTestAccessAllowed(stripeConfiguration(), user)).toBe(false);
    },
  );
  it('allows at most 20 distinct stable ids and normalizes UUID case only', () => {
    const ids = Array.from(
      { length: 20 },
      (_, n) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`,
    );
    ids[19] = clientId;
    state.env.STRIPE_TEST_ACCOUNT_USER_IDS = JSON.stringify(ids);
    expect(stripeTestAccessAllowed(stripeConfiguration(), user)).toBe(true);
    state.env.STRIPE_TEST_ACCOUNT_USER_IDS = JSON.stringify([
      clientId.toUpperCase(),
    ]);
    expect(stripeTestAccessAllowed(stripeConfiguration(), user)).toBe(true);
  });
  it.each([
    null,
    { ...user, emailConfirmed: false },
    { ...user, userId: '' },
    { ...user, userId: 'malformed' },
    { ...user, email: '' },
    { ...user, email: 'malformed' },
  ])(
    'refuses an anonymous, unconfirmed or malformed identity %j',
    (identity) => {
      expect(stripeTestAccessAllowed(stripeConfiguration(), identity)).toBe(
        false,
      );
    },
  );
  it.each(['', 'accounts-only', 'ACCOUNTS_ONLY', 'public', 'all'])(
    'refuses the unknown mode %j',
    (mode) => {
      state.env.STRIPE_TEST_MODE = mode;
      expect(stripeTestAccessAllowed(stripeConfiguration(), user)).toBe(false);
    },
  );
  it('preserves the historical owner-only decision and tax exception', () => {
    state.env.STRIPE_TEST_MODE = 'owner_only';
    expect(stripeTestAccessAllowed(stripeConfiguration(), user)).toBe(false);
    expect(
      stripeTestAccessAllowed(stripeConfiguration(), {
        ...user,
        userId: ownerId,
      }),
    ).toBe(true);
    expect(
      stripeTestAccessAllowed(stripeConfiguration(), {
        ...user,
        userId: otherId,
        email: ' FOUNDER@EXAMPLE.INVALID ',
      }),
    ).toBe(true);
    expect(stripeAutomaticTaxRequired(stripeConfiguration())).toBe(false);
  });
  it('preserves the live decision even with a broken sandbox allowlist', () => {
    state.env.STRIPE_SECRET_KEY = 'sk_live_synthetic_not_a_real_key';
    state.env.STRIPE_TEST_ACCOUNT_USER_IDS = '*';
    expect(
      stripeTestAccessAllowed(stripeConfiguration(), {
        ...user,
        userId: otherId,
      }),
    ).toBe(true);
    expect(stripeTestAccessAllowed(stripeConfiguration(), null)).toBe(false);
    expect(
      stripeTestAccessAllowed(stripeConfiguration(), {
        ...user,
        emailConfirmed: false,
      }),
    ).toBe(false);
    expect(stripeAutomaticTaxRequired(stripeConfiguration())).toBe(true);
  });
  it.each(['', 'rk_test_synthetic', 'sk_unknown_synthetic'])(
    'refuses the unknown server key %j',
    (key) => {
      state.env.STRIPE_SECRET_KEY = key;
      expect(stripeTestAccessAllowed(stripeConfiguration(), user)).toBe(false);
    },
  );
});

describe('ordinary account through the real checkout route', () => {
  it('also reaches the real Gestion checkout with only the authenticated identity', async () => {
    const response = await gestionCheckout(
      new Request(origin + '/api/stripe/checkout', {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({
          plan: 'solo',
          acceptTerms: true,
          legalVersion: LEGAL_VERSION,
          userId: ownerId,
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(state.ready).toHaveBeenCalledWith('solo');
    expect(state.create).toHaveBeenCalledOnce();
    expect(state.create.mock.calls[0][0]).toMatchObject({
      automatic_tax: { enabled: true },
      line_items: [{ price: 'price_solo_synthetic', quantity: 1 }],
      metadata: { account_user_id: clientId, service: 'zentra-gestion' },
      customer_email: user.email,
      expires_at: now + 3600,
    });
    const [parameters, options] = state.create.mock.calls[0];
    expect(options.idempotencyKey).toBe(
      'hc_checkout_' + parameters.client_reference_id,
    );
    expect(
      sql
        .prepare(
          'SELECT owner_id,plan_id,state,provider_reference FROM purchase_intents',
        )
        .get(),
    ).toMatchObject({
      owner_id: clientId,
      plan_id: 'solo',
      state: 'dispatched',
      provider_reference: 'cs_synthetic',
    });
    expect(
      sql.prepare('SELECT account_user_id FROM checkout_attempts').get(),
    ).toMatchObject({ account_user_id: clientId });
    expect(state.cookie).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ secure: true, httpOnly: true }),
    );
  });
  it('keeps Gestion closed to unlisted identities without disclosing configuration', async () => {
    state.user = { ...user, userId: otherId };
    const response = await gestionCheckout(
      new Request(origin + '/api/stripe/checkout', {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({
          plan: 'solo',
          acceptTerms: true,
          legalVersion: LEGAL_VERSION,
        }),
      }),
    );
    expect(response.status).toBe(403);
    const body = await response.text();
    expect(body).not.toContain(clientId);
    expect(body).not.toContain(otherId);
    expect(body).not.toContain(ownerId);
    expect(state.ready).not.toHaveBeenCalled();
    expect(state.create).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
  it('persists and creates the real pack checkout without acquiring owner/founder access', async () => {
    const response = await checkout(
      request({ userId: ownerId, priceChfCents: 1 }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      url: 'https://checkout.stripe.com/synthetic-not-real',
    });
    expect(state.ready).toHaveBeenCalledWith(plan.gestion);
    expect(state.rate).toHaveBeenCalledOnce();
    expect(state.create).toHaveBeenCalledOnce();
    const [params, options] = state.create.mock.calls[0];
    expect(params).toMatchObject({
      mode: 'subscription',
      customer_email: user.email,
      automatic_tax: { enabled: true },
      line_items: [{ price: 'price_synthetic', quantity: 1 }],
      metadata: {
        account_user_id: clientId,
        service: 'zentra-complet',
        bundle_plan: 'team',
      },
      subscription_data: {
        metadata: { account_user_id: clientId, bundle_plan: 'team' },
      },
    });
    expect(options.idempotencyKey).toMatch(/^zentra_complete_/);
    expect(
      sql.prepare('SELECT account_user_id FROM checkout_attempts').get(),
    ).toMatchObject({ account_user_id: clientId });
    expect(
      sql.prepare('SELECT user_id FROM legal_acceptances').get(),
    ).toMatchObject({ user_id: clientId });
    const workspace = { id: 'synthetic-workspace', owner_id: clientId };
    expect(await isSupportOwner(workspace)).toBe(false);
    expect(isAutomationFounder(user)).toBe(false);
    await expect(requireAutomationFounder(request())).rejects.toMatchObject({
      status: 403,
    });
    await expect(getPlatformState()).rejects.toMatchObject({ status: 403 });
    await expect(requireSupportSubscription(workspace)).rejects.toMatchObject({
      status: 402,
    });
    expect(await billingState(workspace)).toMatchObject({
      ownerAccess: false,
      active: false,
      offeredAccess: false,
    });
    expect(
      sql.prepare('SELECT COUNT(*) AS n FROM founder_support_grants').get(),
    ).toMatchObject({ n: 0 });
    expect(
      sql.prepare('SELECT COUNT(*) AS n FROM account_trials').get(),
    ).toMatchObject({ n: 0 });
    expect(
      sql
        .prepare(
          "SELECT COUNT(*) AS n FROM support_billing_config WHERE id LIKE 'owner:%'",
        )
        .get(),
    ).toMatchObject({ n: 0 });
  });
  it('reuses the same persisted attempt and refuses after allowlist removal', async () => {
    expect((await checkout(request())).status).toBe(200);
    expect((await checkout(request())).status).toBe(200);
    expect(state.create).toHaveBeenCalledOnce();
    expect(state.retrieve).toHaveBeenCalledOnce();
    state.env.STRIPE_TEST_ACCOUNT_USER_IDS = JSON.stringify([otherId]);
    const response = await checkout(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(clientId);
    expect(state.create).toHaveBeenCalledOnce();
    expect(state.retrieve).toHaveBeenCalledOnce();
  });
  it('reports restricted test status without exposing the allowlist or querying readiness', async () => {
    state.user = { ...user, userId: otherId };
    const response = await status(new Request(origin + '/api/stripe/status'));
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({
      ready: false,
      testMode: true,
      authenticated: true,
      accessRestricted: true,
    });
    expect(text).not.toContain(clientId);
    expect(text).not.toContain(otherId);
    expect(text).not.toContain(ownerId);
    expect(state.ready).not.toHaveBeenCalled();
    expect((await checkout(request())).status).toBe(503);
    expect(state.create).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
  it('reports allowed test status but does not grant access when readiness fails', async () => {
    expect(
      await (await status(new Request(origin + '/api/stripe/status'))).json(),
    ).toMatchObject({ ready: true, testMode: true, accessRestricted: false });
    state.ready.mockRejectedValueOnce(
      new PublicError('Signed webhook proof unavailable.', 503),
    );
    expect((await checkout(request())).status).toBe(503);
    expect(state.create).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
  it('preserves live status without treating the sandbox mode as live test access', async () => {
    state.env.STRIPE_SECRET_KEY = 'sk_live_synthetic_not_a_real_key';
    expect(
      await (await status(new Request(origin + '/api/stripe/status'))).json(),
    ).toMatchObject({ ready: true, testMode: false, accessRestricted: false });
  });
  it.each([
    [{}, 'https://foreign.example.invalid', 403],
    [{ acceptTerms: false }, origin, 400],
    [{ legalVersion: 'old' }, origin, 400],
    [{ plan: 'unknown' }, origin, 400],
  ] as const)(
    'preserves origin, legal and plan refusal before effects %j',
    async (body, from, code) => {
      expect((await checkout(request(body, from))).status).toBe(code);
      expect(state.ready).not.toHaveBeenCalled();
      expect(state.create).not.toHaveBeenCalled();
      expect(writes).toEqual([]);
    },
  );
  it('preserves confirmation and quota/rate refusal before checkout effects', async () => {
    state.user = { ...user, emailConfirmed: false };
    expect((await checkout(request())).status).toBe(403);
    state.user = user;
    state.rate.mockRejectedValueOnce(new PublicError('Rate refused.', 429));
    expect((await checkout(request())).status).toBe(429);
    expect(state.create).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
});
