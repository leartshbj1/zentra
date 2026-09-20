import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import type Stripe from 'stripe';
const mocks = vi.hoisted(() => ({
  db: null as unknown,
  invoice: null as unknown,
  subscription: null as unknown,
  membership: vi.fn(),
  coupons: vi.fn(),
  update: vi.fn(),
}));
vi.mock('@/lib/runtime', () => ({
  database: () => mocks.db,
  stripeConfiguration: () => ({
    priceIds: { solo: 'price_solo', start: 'price_start', pro: 'price_pro' },
  }),
}));
vi.mock('@/lib/account', () => ({
  requireBrowserMembership: mocks.membership,
}));
vi.mock('@/lib/automation/billing', () => ({
  automationStripe: () => ({
    invoices: { retrieve: async () => mocks.invoice },
    subscriptions: {
      retrieve: async () => mocks.subscription,
      update: mocks.update,
    },
    prices: {
      retrieve: async () => ({
        active: true,
        currency: 'chf',
        recurring: { interval: 'month' },
        product: 'prod_gestion',
      }),
    },
    coupons: { create: mocks.coupons, retrieve: async () => ({}) },
    checkout: { sessions: { retrieve: async () => ({ status: 'expired' }) } },
  }),
}));
import {
  prepareReferral,
  authorizedReferralDiscount,
  referralState,
  applyNextReferralReward,
  referralCheckoutIdentity,
} from './referrals';
import { buildZentraCheckoutParams } from './stripe-checkout';
let sql: DatabaseSync;
const user = {
  userId: 'new',
  email: 'new@example.test',
  emailConfirmed: true,
  provider: 'supabase',
  displayName: 'New',
  fullName: 'New',
} as const;
function prepare(query: string) {
  let args: SQLInputValue[] = [];
  const p = {
    bind: (...v: SQLInputValue[]) => {
      args = v;
      return p;
    },
    run: async () => ({
      meta: { changes: Number(sql.prepare(query).run(...args).changes) },
    }),
    first: async () => sql.prepare(query).get(...args) || null,
    all: async () => ({ results: sql.prepare(query).all(...args) }),
  };
  return p;
}
const sub = {
  id: 'sub_new',
  metadata: {
    plan: 'zentra-solo-monthly-49-chf',
    account_user_id: 'new',
    referral_claim: 'claim1',
  },
} as unknown as Stripe.Subscription;
function discountedInvoice(
  percent = 50,
  claim = 'claim1',
  patch: Record<string, unknown> = {},
) {
  return {
    id: 'in_first',
    total: 4900 - Math.round((4900 * percent) / 100),
    billing_reason: 'subscription_create',
    discounts: [
      {
        id: 'di_1',
        source: {
          type: 'coupon',
          coupon: {
            id: percent === 50 ? `zr-first-${claim}` : `zr-reward-${claim}`,
            percent_off: percent,
            duration: 'once',
            metadata: { service: 'zentra-referral', claim_id: claim },
          },
        },
      },
    ],
    total_discount_amounts: [
      { amount: Math.round((4900 * percent) / 100), discount: 'di_1' },
    ],
    lines: { has_more: false, data: [{}] },
    ...patch,
  } as unknown as Stripe.Invoice;
}
beforeEach(() => {
  vi.clearAllMocks();
  sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  const folder = new URL('../drizzle/', import.meta.url);
  for (const name of readdirSync(folder)
    .filter((n) => n.endsWith('.sql'))
    .sort())
    sql.exec(readFileSync(new URL(name, folder), 'utf8'));
  sql.exec(
    "INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,entitlement_valid_until,livemode,updated_at) VALUES('sub_ref','cus_ref','price','active',2000000000,2000000000,1,1); INSERT INTO organizations VALUES('org_ref','Referrer','sub_ref','referrer',1,1); INSERT INTO referral_codes VALUES('org_ref','ZT-0123456789ABCDEF',1)",
  );
  mocks.db = { prepare };
  mocks.coupons.mockImplementation(async (params: unknown) => params);
  mocks.update.mockResolvedValue({});
  mocks.invoice = discountedInvoice();
  mocks.subscription = {
    id: 'sub_ref',
    status: 'active',
    metadata: { plan: 'zentra-solo-monthly-49-chf' },
    discounts: [],
    items: { data: [{ price: { product: 'prod_gestion' } }] },
  };
});
afterEach(() => sql.close());
function claim() {
  sql.exec(
    "INSERT INTO referral_claims(id,referrer_organization_id,referred_user_id,state,created_at) VALUES('claim1','org_ref','new','pending',1)",
  );
}
it('creates first-month-only 50% coupon scoped to Gestion products', async () => {
  const r = await prepareReferral('zt-0123456789abcdef', user);
  expect(r?.couponId).toContain('zr-first-');
  expect(mocks.coupons.mock.calls[0][0]).toMatchObject({
    percent_off: 50,
    duration: 'once',
    max_redemptions: 1,
    applies_to: { products: ['prod_gestion'] },
  });
});
it('rejects self referral', async () => {
  await expect(
    prepareReferral('ZT-0123456789ABCDEF', { ...user, userId: 'referrer' }),
  ).rejects.toMatchObject({ status: 400 });
  expect(mocks.coupons).not.toHaveBeenCalled();
});
it('rejects existing company member', async () => {
  sql.exec(
    "INSERT INTO organization_members(membership_id,organization_id,user_id,email,display_name,role,joined_at) VALUES('m','org_ref','new','new@example.test','New','member',1)",
  );
  await expect(
    prepareReferral('ZT-0123456789ABCDEF', user),
  ).rejects.toMatchObject({ status: 400 });
});
it('refuses invalid, expired or fabricated codes', async () => {
  await expect(prepareReferral('invalid', user)).rejects.toThrow();
  sql.exec('UPDATE subscriptions SET entitlement_valid_until=1');
  await expect(prepareReferral('ZT-0123456789ABCDEF', user)).rejects.toThrow();
  expect(mocks.coupons).not.toHaveBeenCalled();
});
it('requires membership to obtain another company code', async () => {
  mocks.membership.mockRejectedValueOnce(Error('denied'));
  await expect(referralState('org_ref', 'other')).rejects.toThrow('denied');
});
it('retains the same code across requests', async () => {
  expect((await referralState('org_ref', 'referrer')).code).toBe(
    (await referralState('org_ref', 'referrer')).code,
  );
});
it('binds coupon and referral to authenticated Checkout subscription metadata', () => {
  const p = buildZentraCheckoutParams({
    origin: 'https://zentraapp.ch',
    claimHash: 'hash',
    priceId: 'price_solo',
    plan: 'zentra-solo-monthly-49-chf',
    accountUserId: 'new',
    accountEmail: 'new@example.test',
    referral: { claimId: 'claim1', couponId: 'zr-first-claim1' },
  });
  expect(p.subscription_data?.metadata).toMatchObject({
    account_user_id: 'new',
    referral_claim: 'claim1',
  });
  expect(p.discounts).toEqual([{ coupon: 'zr-first-claim1' }]);
});
it('authorizes exactly the recorded first invoice reduction', async () => {
  claim();
  expect(await authorizedReferralDiscount(discountedInvoice(), sub)).toBe(2450);
});
it.each([
  {
    metadata: {
      plan: 'zentra-solo-monthly-49-chf',
      account_user_id: 'other',
      referral_claim: 'claim1',
    },
  },
  {
    id: 'other',
    metadata: {
      plan: 'zentra-solo-monthly-49-chf',
      account_user_id: 'new',
      referral_claim: 'another',
    },
  },
])('rejects another identity or referral %j', async (patch) => {
  claim();
  expect(
    await authorizedReferralDiscount(discountedInvoice(), {
      ...sub,
      ...patch,
    } as Stripe.Subscription),
  ).toBe(0);
});
it('rejects unrecorded coupon, a second month, replay on different invoice and wrong amounts', async () => {
  claim();
  for (const patch of [
    { billing_reason: 'subscription_cycle' },
    { total: 10 },
    { id: 'in_second' },
  ]) {
    sql.exec("UPDATE referral_claims SET first_invoice_id='in_first'");
    mocks.invoice = discountedInvoice(50, 'claim1', patch);
    expect(
      await authorizedReferralDiscount(mocks.invoice as Stripe.Invoice, sub),
    ).toBe(0);
  }
  mocks.invoice = discountedInvoice(50, 'missing');
  expect(
    await authorizedReferralDiscount(mocks.invoice as Stripe.Invoice, sub),
  ).toBe(0);
});
it('prepares only one 25% reward for the next monthly invoice', async () => {
  claim();
  sql.exec("UPDATE referral_claims SET state='qualified'");
  await applyNextReferralReward('org_ref');
  await applyNextReferralReward('org_ref');
  expect(mocks.update).toHaveBeenCalledTimes(1);
  expect(mocks.update.mock.calls[0]).toEqual([
    'sub_ref',
    { discounts: [{ coupon: 'zr-reward-claim1' }], proration_behavior: 'none' },
    { idempotencyKey: 'referral-award-claim1' },
  ]);
  expect(sql.prepare('SELECT state FROM referral_claims').get()?.state).toBe(
    'reward_applied',
  );
});
it('preserves existing discounts and queues reward instead of stacking', async () => {
  claim();
  sql.exec("UPDATE referral_claims SET state='qualified'");
  mocks.subscription = {
    ...(mocks.subscription as object),
    discounts: ['di_existing'],
  };
  await applyNextReferralReward('org_ref');
  expect(mocks.update).not.toHaveBeenCalled();
  expect(sql.prepare('SELECT state FROM referral_claims').get()?.state).toBe(
    'qualified',
  );
});

it('serializes duplicate referral checkout identity and rejects a changed plan', async () => {
  const input = {
    claimId: 'claim1',
    userId: 'new',
    planId: 'solo',
    origin: 'https://zentraapp.ch',
    email: 'new@example.test',
    candidateHash: 'a'.repeat(64),
  };
  const [a, b] = await Promise.all([
    referralCheckoutIdentity(input),
    referralCheckoutIdentity({ ...input, candidateHash: 'b'.repeat(64) }),
  ]);
  expect(a).toBe(b);
  await expect(
    referralCheckoutIdentity({ ...input, planId: 'pro' }),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    await referralCheckoutIdentity({
      ...input,
      previousSessionId: 'cs_expired',
      candidateHash: 'c'.repeat(64),
    }),
  ).toBe('c'.repeat(64));
});
