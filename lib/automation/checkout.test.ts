import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
const mocks = vi.hoisted(() => ({
  db: null as unknown,
  member: vi.fn(),
  create: vi.fn(),
  retrieve: vi.fn(),
  list: vi.fn(),
  expire: vi.fn(),
  price: vi.fn(),
}));
vi.mock('@/lib/runtime', () => ({
  database: () => mocks.db,
  runtimeValue: () => 'sk_live_fixture',
  stripeConfiguration: () => ({ secretKey: 'sk_live_fixture' }),
}));
vi.mock('@/lib/account', () => ({ requireBrowserMembership: mocks.member }));
vi.mock('@/lib/stripe', async () => {
  const { digest } = await import('@/lib/support/crypto');
  return {
    STRIPE_API_VERSION: '2026-08-26.dahlia',
    REQUIRED_STRIPE_WEBHOOK_EVENTS: [],
    sha256: digest,
  };
});
vi.mock('stripe', () => ({
  default: class {
    static createFetchHttpClient() {
      return {};
    }
    prices = { retrieve: mocks.price };
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
import { createAutomationCheckout } from './billing';
import { cancelStripeAutomationCheckout } from '@/lib/payments/stripe-automation-purchase';
import { digest } from '@/lib/support/crypto';
import type { ZentraUser } from '@/app/zentra-auth';
let sql: DatabaseSync;
let latestSession: Record<string, unknown>;
let createSerial: number;
let originalFetch: typeof fetch;
const now = () => Math.floor(Date.now() / 1000);
const user = {
  userId: 'owner_a',
  email: 'owner@example.ch',
  emailConfirmed: true,
  provider: 'supabase',
  displayName: 'Fictional owner',
  fullName: null,
} satisfies ZentraUser;
const terms = {
  acceptTerms: true,
  legalVersion: 'automation-2026-09-22',
  consentVersion: 'automation-2026-09-20',
};
const checkout = () =>
  createAutomationCheckout('org_a', user, terms, 'https://zentraapp.ch');
beforeEach(async () => {
  vi.clearAllMocks();
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => {
    throw Error('External HTTP is forbidden in checkout fixtures.');
  });
  createSerial = 0;
  sql = new DatabaseSync(':memory:');
  for (const name of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((n) => n.endsWith('.sql'))
    .sort())
    sql.exec(
      readFileSync(new URL('../../drizzle/' + name, import.meta.url), 'utf8'),
    );
  mocks.db = {
    async batch(statements: { run(): Promise<unknown> }[]) {
      sql.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sql.exec('COMMIT');
        return results;
      } catch (error) {
        sql.exec('ROLLBACK');
        throw error;
      }
    },
    prepare(query: string) {
      let args: SQLInputValue[] = [];
      const p = {
        bind(...v: SQLInputValue[]) {
          args = v;
          return p;
        },
        async first() {
          return sql.prepare(query).get(...args) || null;
        },
        async all() {
          return { results: sql.prepare(query).all(...args) };
        },
        async run() {
          return {
            meta: { changes: Number(sql.prepare(query).run(...args).changes) },
          };
        },
      };
      return p;
    },
  };
  sql
    .prepare(
      "INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,entitlement_valid_until,livemode,updated_at) VALUES('sub_a','cus_a','price_base','active',?,?,1,1)",
    )
    .run(now() + 86400, now() + 86400);
  sql.exec(
    "INSERT INTO organizations VALUES('org_a','Company A','sub_a','owner_a',1,1)",
  );
  sql
    .prepare(
      "INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES('owner-member','org_a',?,?,'owner',1)",
    )
    .run(user.userId, user.email);
  sql
    .prepare(
      "INSERT INTO automation_platform(id,value,updated_by,updated_at) VALUES('billing',?,'founder',1)",
    )
    .run(
      JSON.stringify({
        productId: 'prod_auto',
        priceId: 'price_auto',
        portalId: 'portal',
        livemode: true,
        keyBinding: await digest('sk_live_fixture'),
      }),
    );
  mocks.member.mockResolvedValue({
    organizationId: 'org_a',
    subscriptionId: 'sub_a',
    role: 'owner',
  });
  mocks.price.mockResolvedValue({
    id: 'price_auto',
    active: true,
    livemode: true,
    product: 'prod_auto',
    currency: 'chf',
    unit_amount: 1500,
    type: 'recurring',
    recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
    tax_behavior: 'inclusive',
    metadata: { service: 'zentra_automation' },
  });
  mocks.create.mockImplementation(
    async (parameters: Record<string, unknown>) => {
      latestSession = {
        ...structuredClone(parameters),
        id: 'cs_fixture_' + ++createSerial,
        url: 'https://checkout.stripe.com/c/pay/fixture',
        status: 'open',
        payment_status: 'unpaid',
        livemode: true,
        subscription: null,
        currency: 'chf',
        amount_total: 1500,
      };
      return structuredClone(latestSession);
    },
  );
  mocks.retrieve.mockImplementation(async () => structuredClone(latestSession));
  mocks.expire.mockImplementation(async () => {
    latestSession = { ...latestSession, status: 'expired', url: null };
    return structuredClone(latestSession);
  });
  mocks.list.mockResolvedValue({ data: [], has_more: false });
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  globalThis.fetch = originalFetch;
  sql.close();
});
it('retries an uncertain Stripe response with the same immutable parameters and idempotency key', async () => {
  mocks.create.mockRejectedValueOnce(Error('network interrupted'));
  await expect(checkout()).rejects.toThrow('network interrupted');
  const first = mocks.create.mock.calls[0];
  await checkout();
  expect(mocks.create.mock.calls[1]).toEqual(first);
  expect(first[0]).toMatchObject({
    customer: 'cus_a',
    line_items: [{ price: 'price_auto', quantity: 1 }],
    allow_promotion_codes: false,
  });
  expect(
    sql.prepare('SELECT count(*) AS n FROM legal_acceptances').get()?.n,
  ).toBe(1);
  expect(
    sql.prepare('SELECT count(*) AS n FROM automation_subscriptions').get()?.n,
  ).toBe(0);
});
it('reuses an open checkout and blocks complete-but-unconfirmed checkout without a second subscription', async () => {
  await checkout();
  await checkout();
  expect(mocks.create).toHaveBeenCalledTimes(1);
  latestSession = {
    ...latestSession,
    status: 'complete',
    payment_status: 'paid',
    subscription: 'sub_addon',
  };
  await expect(checkout()).resolves.toEqual({
    url: 'https://zentraapp.ch/compte/automation?entreprise=org_a',
  });
  expect(mocks.create).toHaveBeenCalledTimes(1);
  expect(
    sql.prepare('SELECT count(*) AS n FROM automation_subscriptions').get()?.n,
  ).toBe(0);
  expect(sql.prepare('SELECT state FROM purchase_intents').get()?.state).toBe(
    'dispatched',
  );
});
it('requires verified expiry and explicit cancellation before another checkout', async () => {
  await checkout();
  latestSession = { ...latestSession, status: 'expired', url: null };
  await expect(checkout()).rejects.toThrow('expiré');
  expect(mocks.create).toHaveBeenCalledTimes(1);
  await expect(cancelStripeAutomationCheckout('org_a', user)).resolves.toEqual({
    canceled: true,
  });
  await checkout();
  expect(mocks.create).toHaveBeenCalledTimes(2);
  expect(mocks.create.mock.calls[1][1]).not.toEqual(
    mocks.create.mock.calls[0][1],
  );
});
it('requires owner authorization, current base entitlement and explicit consent', async () => {
  mocks.member.mockRejectedValueOnce(Error('owner required'));
  await expect(checkout()).rejects.toThrow('owner required');
  await expect(
    createAutomationCheckout('org_a', user, {}, 'https://zentraapp.ch'),
  ).rejects.toThrow('Acceptez');
  sql.exec('UPDATE subscriptions SET entitlement_valid_until=0');
  await expect(checkout()).rejects.toThrow('actif');
  expect(mocks.create).not.toHaveBeenCalled();
});
it('does not take over a pending checkout being prepared by another owner', async () => {
  sql
    .prepare(
      "INSERT INTO automation_checkouts(organization_id,attempt_id,user_id,expires_at,created_at) VALUES('org_a','attempt','previous_owner',?,1)",
    )
    .run(now() + 3600);
  await expect(checkout()).rejects.toThrow(/préparation|vérifié/);
  expect(mocks.create).not.toHaveBeenCalled();
});
vi.mock('@/lib/site-language-server', () => ({
  currentSiteLanguage: () => 'fr',
}));
