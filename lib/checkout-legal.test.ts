// Real HTTP controller, account admission, encryption, reservations and all D1
// migrations. Only identity/readiness/rate and the Stripe SDK transport are fixtures.
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import type Stripe from 'stripe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEGAL_VERSION } from './legal';

const mocks = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
  identity: vi.fn(),
  create: vi.fn(),
  retrieve: vi.fn(),
  list: vi.fn(),
  expire: vi.fn(),
  cookie: vi.fn(),
  ready: vi.fn(),
  rate: vi.fn(),
  fetch: vi.fn(),
  failAcceptanceBatch: false,
}));
vi.mock('cloudflare:workers', () => ({ env: mocks.env }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ set: mocks.cookie }),
  headers: () => new Headers(),
}));
vi.mock('@/app/zentra-auth', () => ({ getZentraUser: mocks.identity }));
vi.mock('@/lib/stripe-readiness', () => ({
  assertStripeCheckoutReady: mocks.ready,
}));
vi.mock('@/lib/stripe', async (original) => ({
  ...(await original<object>()),
  enforceCheckoutRateLimit: mocks.rate,
}));
vi.mock('stripe', () => ({
  default: class {
    static createFetchHttpClient() {
      return {};
    }
    checkout = {
      sessions: {
        create: mocks.create,
        retrieve: mocks.retrieve,
        list: mocks.list,
        expire: mocks.expire,
      },
    };
  },
}));

import { POST } from '../app/api/stripe/checkout/route';
import { PublicError } from './stripe';

const ownerId = '11111111-1111-4111-8111-111111111111';
const origin = 'https://zentraapp.ch';
const now = Math.floor(new Date('2026-10-06T10:11:12Z').getTime() / 1000);
let db: DatabaseSync;
function prepare(query: string) {
  let args: SQLInputValue[] = [];
  const statement = {
    query,
    bind(...values: SQLInputValue[]) {
      args = values;
      return statement;
    },
    first: async () => db.prepare(query).get(...args) ?? null,
    all: async () => ({ results: db.prepare(query).all(...args) }),
    execute: () => ({
      success: true,
      meta: { changes: Number(db.prepare(query).run(...args).changes) },
    }),
    run: async () => statement.execute(),
  };
  return statement;
}
function request(extra: Record<string, unknown> = {}, requestOrigin = origin) {
  return new Request(origin + '/api/stripe/checkout', {
    method: 'POST',
    headers: { origin: requestOrigin, 'content-type': 'application/json' },
    body: JSON.stringify({ plan: 'start', ...extra }),
  });
}
function accepted(extra: Record<string, unknown> = {}) {
  return request({ acceptTerms: true, legalVersion: LEGAL_VERSION, ...extra });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now * 1000);
  mocks.failAcceptanceBatch = false;
  for (const key of Object.keys(mocks.env)) delete mocks.env[key];
  // Generated here and never written to disk or sent to any provider.
  const signingKey = generateKeyPairSync('ed25519')
    .privateKey.export({ format: 'der', type: 'pkcs8' })
    .toString('base64url');
  Object.assign(mocks.env, {
    STRIPE_SECRET_KEY: 'sk_test_synthetic_legal_not_a_real_key',
    STRIPE_TEST_MODE: 'accounts_only',
    STRIPE_TEST_ACCOUNT_USER_IDS: JSON.stringify([ownerId]),
    STRIPE_PRICE_START_ID: 'price_start_synthetic',
    LICENSE_SIGNING_KEY_PKCS8_B64URL: signingKey,
    PUBLIC_SITE_URL: origin,
  });
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
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.function('unixepoch', () => now);
  for (const file of readdirSync(new URL('../drizzle/', import.meta.url))
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    db.exec(
      readFileSync(new URL('../drizzle/' + file, import.meta.url), 'utf8'),
    );
  }
  mocks.env.DB = {
    prepare,
    batch: async (statements: ReturnType<typeof prepare>[]) => {
      db.exec('BEGIN');
      try {
        const results = statements.map((statement) => statement.execute());
        // Fail only the real post-provider acceptance batch, after its writes,
        // so this proves rollback rather than blocking draft preparation.
        if (
          mocks.failAcceptanceBatch &&
          statements.some((statement) =>
            statement.query.includes('INSERT INTO legal_acceptances'),
          )
        )
          throw new Error('synthetic acceptance storage unavailable');
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
  mocks.identity.mockResolvedValue({
    userId: ownerId,
    email: 'test@example.ch',
    displayName: 'Verified User',
    fullName: 'Verified User',
    provider: 'supabase',
    emailConfirmed: true,
  });
  mocks.ready.mockResolvedValue(undefined);
  mocks.rate.mockResolvedValue(undefined);
  const sessions = new Map<string, Stripe.Checkout.Session>();
  const idempotent = new Map<
    string,
    {
      parameters: Stripe.Checkout.SessionCreateParams;
      session: Stripe.Checkout.Session;
    }
  >();
  mocks.create.mockImplementation(
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
        id: 'cs_test_legal',
        url: 'https://checkout.stripe.com/test',
        status: 'open',
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
  mocks.retrieve.mockImplementation(async (id: string) => {
    const session = sessions.get(id);
    if (!session) throw new Error('Unknown synthetic session');
    return structuredClone(session);
  });
  mocks.list.mockImplementation(async () => ({
    data: structuredClone([...sessions.values()]),
    has_more: false,
  }));
  mocks.expire.mockImplementation(async (id: string) => {
    const session = sessions.get(id);
    if (!session) throw new Error('Unknown synthetic session');
    session.status = 'expired';
    session.url = null;
    return structuredClone(session);
  });
  mocks.fetch.mockRejectedValue(
    new Error('Provider network is closed in this witness'),
  );
  vi.stubGlobal('fetch', mocks.fetch);
});
afterEach(() => {
  expect(mocks.fetch).not.toHaveBeenCalled();
  db.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('authenticated checkout acceptance persistence', () => {
  it('does not create a payment session without explicit current acceptance', async () => {
    for (const extra of [
      {},
      { acceptTerms: true, legalVersion: 'old' },
      { acceptTerms: 'true', legalVersion: LEGAL_VERSION },
    ])
      expect((await POST(request(extra))).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM purchase_intents').get()?.n,
    ).toBe(0);
  });
  it('does not attribute acceptance to an anonymous or supplied identity', async () => {
    mocks.identity.mockResolvedValue(null);
    expect((await POST(accepted({ userId: 'forged' }))).status).toBe(401);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('persists server identity, selected plan and exact version with the checkout claim', async () => {
    const response = await POST(
      accepted({ userId: 'forged', acceptedAt: '1900-01-01' }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      url: 'https://checkout.stripe.com/test',
    });
    expect(db.prepare('SELECT * FROM legal_acceptances').get()).toMatchObject({
      user_id: ownerId,
      document_version: LEGAL_VERSION,
      context: 'checkout_requested',
      plan_id: 'start',
      checkout_session_id: 'cs_test_legal',
      origin,
      accepted_at: new Date(now * 1000).toISOString(),
    });
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM checkout_attempts').get()?.n,
    ).toBe(1);
    expect(
      db
        .prepare(
          'SELECT owner_id, plan_id, state, provider_reference FROM purchase_intents',
        )
        .get(),
    ).toMatchObject({
      owner_id: ownerId,
      plan_id: 'start',
      state: 'dispatched',
      provider_reference: 'cs_test_legal',
    });
    expect(
      db.prepare('SELECT created_by_user_id FROM organizations').get(),
    ).toMatchObject({ created_by_user_id: ownerId });
    const [parameters, options] = mocks.create.mock.calls[0];
    expect(options.idempotencyKey).toBe(
      'hc_checkout_' + parameters.client_reference_id,
    );
    expect(parameters.metadata).toMatchObject({
      account_user_id: ownerId,
      service: 'zentra-gestion',
    });
    expect(mocks.cookie).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      expect.objectContaining({ httpOnly: true, secure: true }),
    );
  });
  it('does not deliver checkout or set a cookie when acceptance storage fails, then recovers the same accepted session', async () => {
    mocks.failAcceptanceBatch = true;
    const response = await POST(accepted());
    expect(response.status).toBe(500);
    expect(await response.json()).not.toHaveProperty('url');
    expect(mocks.cookie).not.toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM legal_acceptances').get()?.n,
    ).toBe(0);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM checkout_attempts').get()?.n,
    ).toBe(0);
    expect(
      db.prepare('SELECT session_id FROM gestion_purchase_requests').get(),
    ).toMatchObject({ session_id: null });
    expect(
      db.prepare('SELECT state,provider_reference FROM purchase_intents').get(),
    ).toMatchObject({
      state: 'dispatched',
      provider_reference: 'cs_test_legal',
    });
    mocks.failAcceptanceBatch = false;
    expect((await POST(accepted())).status).toBe(200);
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.retrieve).toHaveBeenCalledOnce();
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM legal_acceptances').get()?.n,
    ).toBe(1);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM checkout_attempts').get()?.n,
    ).toBe(1);
  });
  it('preserves actual origin and configured allowlist admission, and the rate refusal before reservations', async () => {
    expect(
      (
        await POST(
          request(
            { acceptTerms: true, legalVersion: LEGAL_VERSION },
            'https://foreign.invalid',
          ),
        )
      ).status,
    ).toBe(403);
    mocks.env.STRIPE_TEST_ACCOUNT_USER_IDS = '[]';
    expect((await POST(accepted())).status).toBe(403);
    mocks.env.STRIPE_TEST_ACCOUNT_USER_IDS = JSON.stringify([ownerId]);
    mocks.rate.mockRejectedValueOnce(
      new PublicError('Synthetic rate refusal', 429),
    );
    expect((await POST(accepted())).status).toBe(429);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM purchase_intents').get()?.n,
    ).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM organizations').get()?.n).toBe(
      0,
    );
  });
});
