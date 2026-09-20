import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEGAL_VERSION } from './legal';

const mocks = vi.hoisted(() => ({
  identity: vi.fn(),
  db: vi.fn(),
  create: vi.fn(),
  cookie: vi.fn(),
  ready: vi.fn(),
  failBatch: false,
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ set: mocks.cookie }),
}));
vi.mock('@/app/zentra-auth', () => ({ getZentraUser: mocks.identity }));
vi.mock('@/lib/runtime', () => ({
  database: mocks.db,
  stripeConfiguration: () => ({}),
}));
vi.mock('@/lib/stripe-readiness', () => ({
  assertStripeCheckoutReady: mocks.ready,
}));
vi.mock('@/lib/stripe-test-access', () => ({
  stripeTestAccessAllowed: () => true,
}));
vi.mock('@/lib/stripe', () => ({
  activationCookieName: () => 'test-checkout',
  createCheckoutSession: mocks.create,
  enforceCheckoutRateLimit: async () => {},
  noStoreHeaders: () => ({ 'Cache-Control': 'no-store' }),
  requireSameOrigin: () => 'https://zentraapp.ch',
  randomBase64Url: () => 'test-claim',
  sha256: async () => 'test-hash',
  PublicError: class extends Error {
    constructor(
      message: string,
      public status = 400,
    ) {
      super(message);
    }
  },
  jsonError: (error: Error & { status?: number }) =>
    Response.json({ error: error.message }, { status: error.status ?? 500 }),
}));
import { POST } from '../app/api/stripe/checkout/route';
let db: DatabaseSync;
function request(extra: Record<string, unknown> = {}) {
  return new Request('https://zentraapp.ch/api/stripe/checkout', {
    method: 'POST',
    headers: {
      origin: 'https://zentraapp.ch',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ plan: 'start', ...extra }),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.failBatch = false;
  db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE checkout_attempts(claim_hash TEXT PRIMARY KEY,checkout_session_id TEXT UNIQUE,created_at INTEGER,expires_at INTEGER)',
  );
  db.exec(
    readFileSync(
      new URL('../drizzle/0037_sloppy_lockjaw.sql', import.meta.url),
      'utf8',
    ),
  );
  db.exec(
    readFileSync(
      new URL(
        '../drizzle/0039_account_checkout_activation.sql',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  mocks.db.mockReturnValue({
    prepare: (sql: string) => ({
      bind: (...values: SQLInputValue[]) => ({
        run: () => db.prepare(sql).run(...values),
      }),
    }),
    batch: async (statements: Array<{ run: () => unknown }>) => {
      db.exec('BEGIN');
      try {
        const results = statements.map((s) => s.run());
        if (mocks.failBatch) throw new Error('test storage unavailable');
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  });
  mocks.identity.mockResolvedValue({
    userId: 'verified-user',
    email: 'test@example.ch',
    displayName: 'Verified User',
  });
  mocks.create.mockResolvedValue({
    id: 'cs_test_legal',
    url: 'https://checkout.stripe.com/test',
  });
});
afterEach(() => db.close());
describe('authenticated checkout acceptance persistence', () => {
  it('does not create a payment session without explicit current acceptance', async () => {
    for (const extra of [
      {},
      { acceptTerms: true, legalVersion: 'old' },
      { acceptTerms: 'true', legalVersion: LEGAL_VERSION },
    ]) {
      expect((await POST(request(extra))).status).toBe(400);
    }
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('does not attribute acceptance to an anonymous or supplied identity', async () => {
    mocks.identity.mockResolvedValue(null);
    expect(
      (
        await POST(
          request({
            acceptTerms: true,
            legalVersion: LEGAL_VERSION,
            userId: 'forged',
          }),
        )
      ).status,
    ).toBe(401);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('persists server identity, selected plan and exact version with the checkout claim', async () => {
    const response = await POST(
      request({
        acceptTerms: true,
        legalVersion: LEGAL_VERSION,
        userId: 'forged',
        acceptedAt: '1900-01-01',
      }),
    );
    expect(response.status).toBe(200);
    const row = db.prepare('SELECT * FROM legal_acceptances').get();
    expect(row).toMatchObject({
      user_id: 'verified-user',
      document_version: LEGAL_VERSION,
      context: 'checkout_requested',
      plan_id: 'start',
      checkout_session_id: 'cs_test_legal',
      origin: 'https://zentraapp.ch',
    });
    expect(row?.accepted_at).not.toBe('1900-01-01');
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM checkout_attempts').get()?.n,
    ).toBe(1);
  });
  it('does not deliver checkout or set a cookie when acceptance storage fails', async () => {
    mocks.failBatch = true;
    const response = await POST(
      request({ acceptTerms: true, legalVersion: LEGAL_VERSION }),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).not.toHaveProperty('url');
    expect(mocks.cookie).not.toHaveBeenCalled();
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM legal_acceptances').get()?.n,
    ).toBe(0);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM checkout_attempts').get()?.n,
    ).toBe(0);
  });
});
