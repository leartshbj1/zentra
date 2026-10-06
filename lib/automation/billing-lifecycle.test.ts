import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import type Stripe from 'stripe';
const mocks = vi.hoisted(() => ({
  db: null as unknown,
  subscription: vi.fn(),
  invoice: vi.fn(),
  payments: vi.fn(),
  charge: vi.fn(),
  intent: vi.fn(),
  checkout: vi.fn(),
}));
vi.mock('@/lib/runtime', () => ({
  database: () => mocks.db,
  runtimeValue: (key: string) =>
    key === 'STRIPE_SECRET_KEY' ? 'sk_live_fixture' : '',
  stripeConfiguration: () => ({ secretKey: 'sk_live_fixture' }),
}));
vi.mock('@/lib/account', () => ({ requireBrowserMembership: vi.fn() }));
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
    subscriptions = { retrieve: mocks.subscription };
    invoices = { retrieve: mocks.invoice };
    invoicePayments = { list: mocks.payments };
    charges = { retrieve: mocks.charge };
    paymentIntents = { retrieve: mocks.intent };
    checkout = { sessions: { retrieve: mocks.checkout } };
  },
}));
import {
  persistAutomationStripeEvent,
  automationBillingState,
  refreshAutomationPayment,
} from './billing';
import type { ZentraUser } from '@/app/zentra-auth';
import { automationEntitlement } from './entitlement';
import { digest } from '@/lib/support/crypto';
import { D1StripeAutomationPurchase } from '@/lib/payments/stripe-automation-purchase';
let db: DatabaseSync;
let originalFetch: typeof fetch;
const now = () => Math.floor(Date.now() / 1000);
const actor = {
  organizationId: 'org_a',
  userId: 'owner',
  role: 'owner',
  founder: false,
};
let subscription: Stripe.Subscription;
let invoices: Map<string, Stripe.Invoice>;
let refunds: Set<string>;
let checkoutSession: Stripe.Checkout.Session;
let purchaseSerial: number;
const price = {
  id: 'price_auto',
  object: 'price',
  billing_scheme: 'per_unit',
  created: 1,
  custom_unit_amount: null,
  lookup_key: null,
  nickname: null,
  tiers_mode: null,
  transform_quantity: null,
  unit_amount_decimal: null,
  active: true,
  livemode: true,
  product: 'prod_auto',
  currency: 'chf',
  unit_amount: 1500,
  type: 'recurring',
  recurring: {
    interval: 'month',
    interval_count: 1,
    usage_type: 'licensed',
    meter: null,
    trial_period_days: null,
  },
  tax_behavior: 'inclusive',
  metadata: { service: 'zentra_automation' },
} satisfies Stripe.Price;
function invoice(
  id = 'in_current',
  start = now() - 60,
  end = now() + 30 * 86400,
) {
  return {
    id,
    status: 'paid',
    livemode: true,
    currency: 'chf',
    total: 1500,
    amount_paid: 1500,
    amount_due: 1500,
    amount_remaining: 0,
    status_transitions: { paid_at: now() },
    customer: 'cus_a',
    automatic_tax: { enabled: true, status: 'complete' },
    billing_reason: 'subscription_cycle',
    parent: {
      type: 'subscription_details',
      subscription_details: {
        subscription: subscription.id,
        metadata: subscription.metadata,
      },
    },
    lines: {
      has_more: false,
      data: [
        {
          currency: 'chf',
          quantity: 1,
          subtotal: 1500,
          parent: {
            type: 'subscription_item_details',
            subscription_item_details: {
              proration: false,
              subscription: subscription.id,
            },
          },
          pricing: {
            unit_amount_decimal: '1500',
            price_details: { price: 'price_auto' },
          },
          period: { start, end },
        },
      ],
    },
  } as unknown as Stripe.Invoice;
}
function event(type: string, id = 'in_current') {
  const object =
    type === 'charge.refunded'
      ? { id: 'ch_' + id }
      : type === 'invoice.paid'
        ? invoices.get(id)
        : subscription;
  return {
    id: 'evt_' + crypto.randomUUID(),
    type,
    livemode: true,
    data: { object },
  } as Stripe.Event;
}
const apply = () => persistAutomationStripeEvent(event('invoice.paid'));
const owner = {
  userId: 'owner',
  email: 'owner@example.test',
  emailConfirmed: true,
  provider: 'supabase',
  displayName: 'Fictional owner',
  fullName: null,
} satisfies ZentraUser;
function prepareReturn(invoiceId = 'in_current') {
  mocks.checkout.mockResolvedValue({
    ...checkoutSession,
    status: 'complete',
    payment_status: 'paid',
    subscription: subscription.id,
    invoice: invoiceId,
  });
}
async function preparePurchase() {
  await new D1StripeAutomationPurchase(
    mocks.db as ConstructorParameters<typeof D1StripeAutomationPurchase>[0],
    {
      secretKey: 'sk_live_fixture',
      productId: 'prod_auto',
      priceId: 'price_auto',
      livemode: true,
      automaticTax: true,
    },
    {
      price: async () => price,
      create: async (parameters) => {
        subscription.metadata = { ...parameters.metadata } as Stripe.Metadata;
        checkoutSession = {
          ...structuredClone(parameters),
          id: 'cs_auto_' + ++purchaseSerial,
          url: 'https://checkout.stripe.com/c/pay/fixture',
          status: 'open',
          payment_status: 'unpaid',
          livemode: true,
          subscription: null,
          invoice: null,
          currency: 'chf',
          amount_total: 1500,
        } as unknown as Stripe.Checkout.Session;
        return checkoutSession;
      },
      retrieve: async () => checkoutSession,
      list: async () => ({ data: [checkoutSession], has_more: false }),
      expire: async () => ({
        ...checkoutSession,
        status: 'expired',
        url: null,
      }),
    },
  ).checkout({
    user: owner,
    organizationId: 'org_a',
    origin: 'https://zentraapp.ch',
    legalVersion: 'automation-2026-09-22',
    consentVersion: 'automation-2026-09-20',
  });
  prepareReturn();
}
beforeEach(async () => {
  vi.clearAllMocks();
  originalFetch = globalThis.fetch;
  purchaseSerial = 0;
  globalThis.fetch = vi.fn(async () => {
    throw Error('External HTTP is forbidden in lifecycle fixtures.');
  });
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const n of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((n) => n.endsWith('.sql'))
    .sort())
    db.exec(
      readFileSync(new URL('../../drizzle/' + n, import.meta.url), 'utf8'),
    );
  mocks.db = {
    async batch(statements: { run(): Promise<unknown> }[]) {
      db.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    prepare: (query: string) => {
      let args: SQLInputValue[] = [];
      const p = {
        bind: (...v: SQLInputValue[]) => {
          args = v;
          return p;
        },
        first: async () => db.prepare(query).get(...args) || null,
        all: async () => ({ results: db.prepare(query).all(...args) }),
        run: async () => ({ meta: db.prepare(query).run(...args) }),
      };
      return p;
    },
  };
  db.exec(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,entitlement_valid_until,livemode,updated_at) VALUES('base','cus_a','price_base','active',2000000000,2000000000,1,1),('base_b','cus_a','price_base','active',2000000000,2000000000,1,1);
    INSERT INTO organizations VALUES('org_a','Company A','base','owner',1,1),('org_b','Company B','base_b','owner',1,1);
    INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES('member','org_a','owner','owner@example.test','owner',1);`);
  db.prepare(
    "INSERT INTO automation_platform VALUES('billing',?,'admin',1)",
  ).run(
    JSON.stringify({
      productId: 'prod_auto',
      priceId: 'price_auto',
      portalId: 'portal',
      livemode: true,
      keyBinding: await digest('sk_live_fixture'),
    }),
  );
  subscription = {
    id: 'sub_auto',
    customer: 'cus_a',
    status: 'active',
    livemode: true,
    cancel_at_period_end: false,
    metadata: {
      service: 'zentra_automation',
      organization_id: 'org_a',
      owner_id: 'owner',
    },
    items: { data: [{ quantity: 1, price }] },
  } as unknown as Stripe.Subscription;
  await preparePurchase();
  invoices = new Map([['in_current', invoice()]]);
  refunds = new Set();
  mocks.subscription.mockImplementation(async () => subscription);
  mocks.invoice.mockImplementation(async (id: string) => invoices.get(id));
  mocks.payments.mockImplementation(
    async (input: {
      invoice?: string;
      payment?: { payment_intent: string };
    }) => {
      const id = input.invoice ?? input.payment!.payment_intent.slice(3);
      return {
        has_more: false,
        data: [
          {
            id: 'inpay_' + id,
            status: 'paid',
            livemode: true,
            currency: 'chf',
            amount_paid: 1500,
            invoice: id,
            payment: { type: 'payment_intent', payment_intent: 'pi_' + id },
          },
        ],
      };
    },
  );
  mocks.intent.mockImplementation(async (id: string) => ({
    id,
    livemode: true,
    customer: 'cus_a',
    currency: 'chf',
    status: 'succeeded',
    amount_received: 1500,
    latest_charge: 'ch_' + id.slice(3),
  }));
  mocks.charge.mockImplementation(async (id: string) => ({
    id,
    customer: 'cus_a',
    livemode: true,
    currency: 'chf',
    paid: true,
    captured: true,
    status: 'succeeded',
    payment_intent: 'pi_' + id.slice(3),
    refunded: refunds.has(id.slice(3)),
    amount_captured: 1500,
    amount_refunded: refunds.has(id.slice(3)) ? 1500 : 0,
  }));
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  globalThis.fetch = originalFetch;
  db.close();
});
it('does not activate from an account refresh before the signed payment notification arrives', async () => {
  prepareReturn();
  await refreshAutomationPayment('org_a', owner);
  expect(await automationEntitlement(actor)).toBe(false);
  expect(
    db.prepare('SELECT COUNT(*) AS n FROM automation_settings').get()?.n,
  ).toBe(0);
  await apply();
  expect(await automationEntitlement(actor)).toBe(true);
});
it('does not extend the paid period from an account refresh while the renewal notification is pending', async () => {
  await apply();
  // The paid initial handoff is real; only the mutable access cache is elapsed.
  db.prepare('UPDATE automation_subscriptions SET paid_until=?').run(now() - 1);
  const previous = db
    .prepare(
      'SELECT paid_until,last_paid_invoice_id FROM automation_subscriptions',
    )
    .get();
  invoices.set('in_renewal', invoice('in_renewal'));
  prepareReturn('in_renewal');
  await refreshAutomationPayment('org_a', owner);
  expect(await automationEntitlement(actor)).toBe(false);
  expect(
    db
      .prepare(
        'SELECT paid_until,last_paid_invoice_id FROM automation_subscriptions',
      )
      .get(),
  ).toEqual(previous);
  await persistAutomationStripeEvent(event('invoice.paid', 'in_renewal'));
  expect(await automationEntitlement(actor)).toBe(true);
});
it.each(['cancellation', 'refund'])(
  'an account refresh still removes access after a verified %s',
  async (change) => {
    await apply();
    prepareReturn();
    if (change === 'cancellation') subscription.status = 'canceled';
    else refunds.add('in_current');
    await refreshAutomationPayment('org_a', owner);
    expect(await automationEntitlement(actor)).toBe(false);
  },
);
it('activates only after verified payment for its space and initialises settings without enabling workers', async () => {
  await persistAutomationStripeEvent(event('customer.subscription.updated'));
  expect(await automationEntitlement(actor)).toBe(false);
  await apply();
  expect(await automationEntitlement(actor)).toBe(true);
  expect(
    await automationEntitlement({ ...actor, organizationId: 'org_b' }),
  ).toBe(false);
  expect(
    db
      .prepare('SELECT enabled,mode,consent_version FROM automation_settings')
      .get(),
  ).toMatchObject({
    enabled: 0,
    mode: 'shadow',
    consent_version: 'automation-2026-09-20',
  });
});
it.each(['price', 'quantity', 'company', 'customer', 'service'])(
  'stops an already paid option when its Stripe %s changes, without moving it to another space',
  async (change) => {
    await apply();
    db.exec(
      "UPDATE automation_settings SET enabled=1,mode='suggest',flags='[\"supplier_routing\"]'",
    );
    const original = structuredClone(subscription);
    if (change === 'price')
      subscription.items.data[0] = {
        ...subscription.items.data[0],
        price: { ...subscription.items.data[0].price, id: 'price_other' },
      };
    if (change === 'quantity')
      subscription.items.data[0] = {
        ...subscription.items.data[0],
        quantity: 2,
      };
    if (change === 'company') subscription.metadata.organization_id = 'org_b';
    if (change === 'customer') subscription.customer = 'cus_other';
    if (change === 'service') subscription.metadata.service = 'other';
    const update = persistAutomationStripeEvent(
      event('customer.subscription.updated'),
    );
    if (change === 'service') await expect(update).resolves.toBe(true);
    else await expect(update).rejects.toMatchObject({ status: 409 });
    expect(await automationEntitlement(actor)).toBe(false);
    expect(
      await automationEntitlement({ ...actor, organizationId: 'org_b' }),
    ).toBe(false);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM automation_subscriptions').get()?.n,
    ).toBe(1);
    expect(
      db.prepare('SELECT enabled,flags FROM automation_settings').get(),
    ).toMatchObject({ enabled: 1, flags: '["supplier_routing"]' });
    subscription = original;
    await persistAutomationStripeEvent(event('customer.subscription.updated'));
    expect(await automationEntitlement(actor)).toBe(true);
  },
);
it('duplicate and older paid invoices cannot move the paid-period watermark backwards', async () => {
  await apply();
  const end = db
    .prepare('SELECT paid_until FROM automation_subscriptions')
    .get()?.paid_until;
  invoices.set('in_old', invoice('in_old', now() - 31 * 86400, now() - 86400));
  await persistAutomationStripeEvent(event('invoice.paid', 'in_old'));
  await apply();
  expect(
    db
      .prepare(
        'SELECT paid_until,last_paid_invoice_id FROM automation_subscriptions',
      )
      .get(),
  ).toMatchObject({ paid_until: end, last_paid_invoice_id: 'in_current' });
});
it('cancellation at period end and past_due keep only the period already paid', async () => {
  await apply();
  subscription.cancel_at_period_end = true;
  subscription.status = 'past_due';
  await persistAutomationStripeEvent(event('customer.subscription.updated'));
  expect(await automationEntitlement(actor)).toBe(true);
  db.exec('UPDATE automation_subscriptions SET paid_until=1');
  expect(await automationEntitlement(actor)).toBe(false);
});
it.each(['unpaid', 'canceled', 'paused', 'incomplete_expired'] as const)(
  'stops %s immediately and preserves saved preferences',
  async (status) => {
    await apply();
    db.exec("UPDATE automation_settings SET enabled=1,mode='suggest'");
    subscription.status = status;
    await persistAutomationStripeEvent(event('customer.subscription.updated'));
    expect(await automationEntitlement(actor)).toBe(false);
    expect(
      db.prepare('SELECT enabled,mode FROM automation_settings').get(),
    ).toMatchObject({ enabled: 1, mode: 'suggest' });
  },
);
it('an old paid webhook cannot override the current unpaid Stripe subscription', async () => {
  await apply();
  subscription.status = 'unpaid';
  await apply();
  expect(await automationEntitlement(actor)).toBe(false);
});
it('refunds cannot be undone by replaying current or older invoice.paid events', async () => {
  await apply();
  refunds.add('in_current');
  await persistAutomationStripeEvent(event('charge.refunded'));
  expect(await automationEntitlement(actor)).toBe(false);
  expect((await automationBillingState('org_a')).refunded).toBe(true);
  invoices.set(
    'in_old',
    invoice('in_old', now() - 10 * 86400, now() + 10 * 86400),
  );
  await persistAutomationStripeEvent(event('invoice.paid', 'in_old'));
  await apply();
  expect(await automationEntitlement(actor)).toBe(false);
  expect(
    db
      .prepare('SELECT last_paid_invoice_id FROM automation_subscriptions')
      .get()?.last_paid_invoice_id,
  ).toBe('in_current');
});
it('persists a refund arriving before the first invoice.paid event', async () => {
  refunds.add('in_current');
  await persistAutomationStripeEvent(event('charge.refunded'));
  // Even a stale payment read cannot undo the already verified refund.
  refunds.clear();
  await expect(apply()).rejects.toMatchObject({ status: 409 });
  expect(await automationEntitlement(actor)).toBe(false);
  expect(
    db
      .prepare('SELECT invoice_id,customer_id,livemode FROM automation_refunds')
      .all(),
  ).toEqual([{ invoice_id: 'in_current', customer_id: 'cus_a', livemode: 1 }]);
});
it('a newly paid later period restores access while a delayed old refund cannot revoke it', async () => {
  await apply();
  refunds.add('in_current');
  await persistAutomationStripeEvent(event('charge.refunded'));
  invoices.set('in_next', invoice('in_next', now(), now() + 31 * 86400));
  await persistAutomationStripeEvent(event('invoice.paid', 'in_next'));
  expect(await automationEntitlement(actor)).toBe(true);
  await persistAutomationStripeEvent(event('charge.refunded'));
  expect(await automationEntitlement(actor)).toBe(true);
});
it('a new reserved purchase after cancellation and elapsed coverage does not inherit the old paid period', async () => {
  await apply();
  subscription.status = 'canceled';
  await persistAutomationStripeEvent(event('customer.subscription.deleted'));
  db.exec('UPDATE automation_subscriptions SET paid_until=0');
  subscription = { ...subscription, id: 'sub_new', status: 'active' };
  await preparePurchase();
  await persistAutomationStripeEvent(event('customer.subscription.created'));
  expect(await automationEntitlement(actor)).toBe(false);
  invoices.set('in_reactivated', invoice('in_reactivated'));
  prepareReturn('in_reactivated');
  await persistAutomationStripeEvent(event('invoice.paid', 'in_reactivated'));
  expect(await automationEntitlement(actor)).toBe(true);
});
it.each([
  { livemode: false },
  {
    metadata: {
      service: 'zentra_automation',
      organization_id: 'org_b',
      owner_id: 'stranger',
    },
  },
  { items: { data: [{ quantity: 2, price }] } },
])('rejects mismatched payment identity or plan %j', async (patch) => {
  Object.assign(subscription, patch);
  await expect(apply()).rejects.toMatchObject({ status: 409 });
  expect(await automationEntitlement(actor)).toBe(false);
});
it('payment verification failures do not activate the option', async () => {
  mocks.payments.mockRejectedValue(Error('Stripe unavailable'));
  await expect(apply()).rejects.toThrow('Stripe unavailable');
  expect(await automationEntitlement(actor)).toBe(false);
});
