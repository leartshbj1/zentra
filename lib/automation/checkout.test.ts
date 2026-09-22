import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
const mocks = vi.hoisted(() => ({
  db: null as unknown,
  member: vi.fn(),
  create: vi.fn(),
  retrieve: vi.fn(),
  price: vi.fn(),
}));
vi.mock('@/lib/runtime', () => ({
  database: () => mocks.db,
  runtimeValue: () => 'sk_live_fixture',
  stripeConfiguration: () => ({ secretKey: 'sk_live_fixture' }),
}));
vi.mock('@/lib/account', () => ({ requireBrowserMembership: mocks.member }));
vi.mock('@/lib/stripe', () => ({
  STRIPE_API_VERSION: '2026-08-26.dahlia',
  REQUIRED_STRIPE_WEBHOOK_EVENTS: [],
}));
vi.mock('stripe', () => ({
  default: class {
    static createFetchHttpClient() {
      return {};
    }
    prices = { retrieve: mocks.price };
    checkout = { sessions: { create: mocks.create, retrieve: mocks.retrieve } };
  },
}));
import { createAutomationCheckout } from './billing';
import { digest } from '@/lib/support/crypto';
import type { ZentraUser } from '@/app/zentra-auth';
let sql: DatabaseSync;
const now = () => Math.floor(Date.now() / 1000);
const user = {
  userId: 'owner_a',
  email: 'owner@example.ch',
  emailConfirmed: true,
  provider: 'supabase',
} as ZentraUser;
const terms = {
  acceptTerms: true,
  legalVersion: 'automation-2026-09-22',
  consentVersion: 'automation-2026-09-20',
};
const checkout = () =>
  createAutomationCheckout('org_a', user, terms, 'https://zentraapp.ch');
beforeEach(async () => {
  vi.clearAllMocks();
  sql = new DatabaseSync(':memory:');
  for (const name of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((n) => n.endsWith('.sql'))
    .sort())
    sql.exec(
      readFileSync(new URL('../../drizzle/' + name, import.meta.url), 'utf8'),
    );
  mocks.db = {
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
  mocks.create.mockResolvedValue({
    id: 'cs_fixture',
    url: 'https://checkout.stripe.com/c/pay/fixture',
    expires_at: now() + 3500,
  });
});
afterEach(() => sql.close());
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
  mocks.retrieve.mockResolvedValue({
    id: 'cs_fixture',
    status: 'open',
    url: 'https://checkout.stripe.com/c/pay/fixture',
  });
  await checkout();
  expect(mocks.create).toHaveBeenCalledTimes(1);
  mocks.retrieve.mockResolvedValue({ id: 'cs_fixture', status: 'complete' });
  await expect(checkout()).rejects.toThrow('confirmation');
  expect(mocks.create).toHaveBeenCalledTimes(1);
});
it('allows a new checkout only after the previous session has expired', async () => {
  await checkout();
  mocks.retrieve.mockResolvedValue({ id: 'cs_fixture', status: 'expired' });
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
  await expect(checkout()).rejects.toThrow('préparation');
  expect(mocks.create).not.toHaveBeenCalled();
});
