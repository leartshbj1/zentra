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
import { D1StripeGestionPurchase } from './payments/stripe-gestion-purchase';
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
    query,
    get args() {
      return args;
    },
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
  mocks.db = {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      sql.exec('BEGIN IMMEDIATE');
      try {
        const out = statements.map((q) => ({
          success: true,
          meta: sql.prepare(q.query).run(...q.args),
        }));
        sql.exec('COMMIT');
        return out;
      } catch (e) {
        sql.exec('ROLLBACK');
        throw e;
      }
    },
  };
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

// Integration with the actual controller and all SQL migrations. Only the
// provider transport is synthetic; no ledger, authorization or referral mock.
function canceledDraftController() {
  const configuration = {
    secretKey: 'sk_test_synthetic_not_real',
    signingKey: Buffer.from(
      '302e020100300506032b657004220420' + '01'.repeat(32),
      'hex',
    ).toString('base64url'),
    priceIds: { solo: 'price_solo', start: 'price_start', pro: 'price_pro' },
    testMode: 'accounts_only',
  } as ReturnType<typeof import('./runtime').stripeConfiguration>;
  const sessions = new Map<string, Stripe.Checkout.Session>();
  const creates: Stripe.Checkout.SessionCreateParams[] = [];
  const controller = new D1StripeGestionPurchase(
    mocks.db as D1Database,
    configuration,
    {
      create: async (r, p) => {
        creates.push(p);
        const s = {
          id: 'cs_test_' + r.request_id.replaceAll('-', ''),
          url: 'https://checkout.stripe.com/synthetic',
          mode: 'subscription',
          status: 'open',
          livemode: false,
          client_reference_id: r.claim_hash,
          expires_at: r.expires_at,
          metadata: { ...p.metadata },
        } as Stripe.Checkout.Session;
        sessions.set(s.id, s);
        return s;
      },
      retrieve: async (id) => sessions.get(id)!,
      list: async () => ({ data: [...sessions.values()], has_more: false }),
      expire: async (id) => {
        const s = sessions.get(id)!;
        s.status = 'expired';
        s.url = null;
        return s;
      },
    },
  );
  const checkout = (patch: Record<string, unknown> = {}) =>
    controller.checkout(
      { user, origin: 'https://zentraapp.ch', planId: 'solo', ...patch },
      prepareReferral,
    );
  const context = () => {
    const r = sql
      .prepare(
        'SELECT request_id,organization_id FROM gestion_purchase_requests WHERE closed_at IS NOT NULL ORDER BY rowid DESC LIMIT 1',
      )
      .get()!;
    return {
      requestId: String(r.request_id),
      organizationId: String(r.organization_id),
    };
  };
  return { checkout, creates, context };
}
it('allows adding first code after verified cancellation of an inactive draft, not on a frozen retry', async () => {
  const c = canceledDraftController();
  await c.checkout();
  expect(await c.checkout({ abandon: true })).toEqual({ canceled: true });
  const a = await c.checkout({ referralCode: 'ZT-0123456789ABCDEF' }),
    b = await c.checkout({ referralCode: 'ZT-0123456789ABCDEF' });
  expect(a).toEqual(b);
  expect(mocks.coupons).toHaveBeenCalledOnce();
  expect(c.creates[1]).toMatchObject({
    discounts: [{ coupon: expect.stringMatching(/^zr-first-/) }],
  });
  expect(
    sql.prepare('SELECT COUNT(*) AS n FROM referral_claims').get()?.n,
  ).toBe(1);
  expect(
    sql.prepare('SELECT COUNT(*) AS n FROM gestion_purchase_requests').get()?.n,
  ).toBe(2);
  expect(
    sql.prepare('SELECT referral_code FROM gestion_purchase_drafts').get()
      ?.referral_code,
  ).toBeNull();
});
it('allows removing code after verified cancellation without deleting claim or issuing another coupon', async () => {
  const c = canceledDraftController();
  await c.checkout({ referralCode: 'ZT-0123456789ABCDEF' });
  const original = sql.prepare('SELECT * FROM referral_claims').get()!;
  await c.checkout({ abandon: true });
  await c.checkout();
  expect(c.creates[1].discounts).toBeUndefined();
  expect(mocks.coupons).toHaveBeenCalledOnce();
  expect(
    sql
      .prepare('SELECT id,referrer_organization_id FROM referral_claims')
      .get(),
  ).toMatchObject({
    id: original.id,
    referrer_organization_id: original.referrer_organization_id,
  });
  expect(
    sql.prepare('SELECT COUNT(*) AS n FROM gestion_purchase_requests').get()?.n,
  ).toBe(2);
});
it('keeps the original sponsor rule explicit when a different valid code is selected after cancellation', async () => {
  const c = canceledDraftController();
  await c.checkout({ referralCode: 'ZT-0123456789ABCDEF' });
  await c.checkout({ abandon: true });
  sql.exec(
    "INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,entitlement_valid_until,updated_at) VALUES('sub_ref2','cus_ref2','price','active',2000000000,2000000000,1); INSERT INTO organizations VALUES('org_ref2','Referrer2','sub_ref2','referrer2',1,1); INSERT INTO referral_codes VALUES('org_ref2','ZT-FEDCBA9876543210',1)",
  );
  await expect(
    c.checkout({ referralCode: 'ZT-FEDCBA9876543210' }),
  ).rejects.toThrow('Un parrainage a déjà été choisi');
  expect(c.creates).toHaveLength(1);
  expect(mocks.coupons).toHaveBeenCalledOnce();
  expect(
    sql.prepare('SELECT referrer_organization_id FROM referral_claims').get()
      ?.referrer_organization_id,
  ).toBe('org_ref');
});
it('never exempts a pending/open/uncertain checkout, another account, revoked ownership, or a fabricated cancellation', async () => {
  const c = canceledDraftController();
  await c.checkout();
  const r = sql.prepare('SELECT * FROM gestion_purchase_requests').get()!;
  const ctx = {
    organizationId: String(r.organization_id),
    requestId: String(r.request_id),
  };
  await expect(
    prepareReferral('ZT-0123456789ABCDEF', user, ctx),
  ).rejects.toMatchObject({ status: 409 });
  await c.checkout({ abandon: true });
  await expect(
    prepareReferral('ZT-0123456789ABCDEF', { ...user, userId: 'foreign' }, ctx),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    prepareReferral('ZT-0123456789ABCDEF', user, {
      ...ctx,
      requestId: 'fabricated',
    }),
  ).rejects.toMatchObject({ status: 409 });
  sql
    .prepare('UPDATE organization_members SET revoked_at=1 WHERE user_id=?')
    .run(user.userId);
  await expect(
    prepareReferral('ZT-0123456789ABCDEF', user, ctx),
  ).rejects.toMatchObject({ status: 409 });
  expect(mocks.coupons).not.toHaveBeenCalled();
});
it('keeps self-referral and any other company membership refused under the cancelled-draft exception', async () => {
  const c = canceledDraftController();
  await c.checkout();
  await c.checkout({ abandon: true });
  sql
    .prepare(
      'UPDATE organizations SET created_by_user_id=? WHERE organization_id=?',
    )
    .run(user.userId, 'org_ref');
  await expect(
    prepareReferral('ZT-0123456789ABCDEF', user, c.context()),
  ).rejects.toThrow('nouvelle entreprise');
  sql
    .prepare(
      'UPDATE organizations SET created_by_user_id=? WHERE organization_id=?',
    )
    .run('referrer', 'org_ref');
  sql
    .prepare(
      "INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES('extra','org_ref',?,?,'member',1)",
    )
    .run(user.userId, user.email);
  await expect(
    prepareReferral('ZT-0123456789ABCDEF', user, c.context()),
  ).rejects.toThrow('nouvelle entreprise');
  expect(mocks.coupons).not.toHaveBeenCalled();
});
