import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import type Stripe from 'stripe';
import { digest } from './crypto';
import type { Workspace } from './types';
import { SUPPORT_LEGAL_VERSION } from './plans';
const state = vi.hoisted(() => ({
  db: null as unknown,
  env: { STRIPE_SECRET_KEY: 'sk_live_fixture' } as Record<string, string>,
  subscription: null as unknown,
  invoice: null as unknown,
  session: null as unknown,
  price: null as unknown,
  calls: [] as { body: { line_items?: unknown }; options: unknown }[],
}));
vi.mock('@/lib/runtime', () => ({
  database: () => state.db,
  runtimeValue: (key: string) => state.env[key] || '',
  stripeConfiguration: () => ({
    secretKey: state.env.STRIPE_SECRET_KEY,
    testMode: 'owner_only',
    ownerAccountUserId: 'owner',
    ownerEmail: 'owner@example.test',
  }),
}));
vi.mock('stripe', () => ({
  default: class {
    static createFetchHttpClient() {
      return {};
    }
    subscriptions = { retrieve: async () => state.subscription };
    invoices = { retrieve: async () => state.invoice };
    prices = { retrieve: async () => state.price };
    checkout = {
      sessions: {
        retrieve: async () => state.session,
        create: async (body: unknown, options: unknown) => {
          state.calls.push({ body: body as { line_items?: unknown }, options });
          return state.session;
        },
        expire: async () => {
          state.session = { ...(state.session as object), status: 'expired' };
          return state.session;
        },
      },
    };
  },
}));
import {
  billingState,
  verifySupportBilling,
  paidAccess,
  paidSupportPeriod,
  requireSupportSubscription,
  reserveAnalysis,
  finishAnalysis,
  persistSupportStripeEvent,
  createSupportCheckout,
  refreshSupportPayment,
  cancelSupportCheckout,
  type SubscriptionRow,
} from './billing';
const time = Math.floor(Date.now() / 1000),
  config = {
    productId: 'prod_support',
    prices: {
      starter: 'price_starter',
      team: 'price_team',
      business: 'price_business',
    },
    portalId: 'portal_support',
    livemode: true,
    keyBinding: '',
  };
const workspace = { id: 'w1', owner_id: 'owner' } as Workspace;
const user = {
  userId: 'owner',
  email: 'owner@example.test',
  emailConfirmed: true,
  provider: 'supabase',
  displayName: 'Owner',
  fullName: 'Owner',
} as const;
let sql: DatabaseSync;
function invoice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'in_1',
    status: 'paid',
    livemode: true,
    currency: 'chf',
    amount_paid: 2900,
    amount_due: 2900,
    total: 2900,
    customer: 'cus_support',
    billing_reason: 'subscription_create',
    parent: {
      type: 'subscription_details',
      subscription_details: {
        subscription: 'sub_support',
        metadata: { service: 'zentra-support' },
      },
    },
    lines: {
      has_more: false,
      data: [
        {
          currency: 'chf',
          quantity: 1,
          subtotal: 2900,
          period: { start: time - 60, end: time + 86400 * 30 },
          pricing: { price_details: { price: 'price_starter' } },
          parent: {
            type: 'subscription_item_details',
            subscription_item_details: {
              subscription: 'sub_support',
              proration: false,
            },
          },
        },
      ],
    },
    ...overrides,
  } as unknown as Stripe.Invoice;
}
function row(overrides: Partial<SubscriptionRow> = {}) {
  return {
    workspace_id: 'w1',
    subscription_id: 'sub_support',
    customer_id: 'cus_support',
    plan_id: 'starter',
    status: 'active',
    paid_from: time - 60,
    paid_until: time + 86400,
    paid_plan_id: 'starter',
    last_paid_invoice_id: 'in_1',
    cancel_at_period_end: 0,
    livemode: 1,
    updated_at: time,
    ...overrides,
  };
}
function seedPaid(overrides: Partial<SubscriptionRow> = {}) {
  const value = row(overrides);
  sql
    .prepare(
      'INSERT INTO support_subscriptions(' +
        Object.keys(value).join(',') +
        ') VALUES(' +
        Object.values(value)
          .map(() => '?')
          .join(',') +
        ')',
    )
    .run(...Object.values(value));
}
beforeEach(async () => {
  sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  for (const file of [
    '0041_mysterious_brother_voodoo',
    '0042_support_triage_context',
    '0043_support_billing',
    '0044_support_onboarding',
    '0045_support_oauth_rotation',
  ])
    sql.exec(
      readFileSync(
        new URL('../../drizzle/' + file + '.sql', import.meta.url),
        'utf8',
      ),
    );
  state.db = {
    prepare(query: string) {
      let values: SQLInputValue[] = [];
      const api = {
        bind(...v: SQLInputValue[]) {
          values = v;
          return api;
        },
        async first() {
          return sql.prepare(query).get(...values) || null;
        },
        async all() {
          return { results: sql.prepare(query).all(...values) };
        },
        async run() {
          return { meta: sql.prepare(query).run(...values) };
        },
      };
      return api;
    },
  };
  state.env = {
    STRIPE_SECRET_KEY: 'sk_live_fixture',
    PUBLIC_SITE_URL: 'https://zentraapp.ch',
  };
  state.calls = [];
  config.keyBinding = await digest(state.env.STRIPE_SECRET_KEY);
  sql
    .prepare(
      "INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at) VALUES('w1','owner','Fixture',?,?)",
    )
    .run(time, time);
  sql
    .prepare("INSERT INTO support_billing_config VALUES('stripe',?,?)")
    .run(JSON.stringify(config), time);
  state.price = {
    id: 'price_starter',
    product: { id: 'prod_support', active: true },
    active: true,
    livemode: true,
    currency: 'chf',
    unit_amount: 2900,
    type: 'recurring',
    recurring: { interval: 'month', interval_count: 1 },
    tax_behavior: 'inclusive',
    metadata: { service: 'zentra-support', plan: 'starter' },
  };
  state.subscription = {
    id: 'sub_support',
    customer: 'cus_support',
    livemode: true,
    status: 'active',
    metadata: {
      service: 'zentra-support',
      workspace_id: 'w1',
      owner_id: 'owner',
      plan: 'starter',
    },
    items: { data: [{ quantity: 1, price: state.price }] },
    latest_invoice: 'in_1',
    cancel_at_period_end: false,
  };
  state.invoice = invoice();
  state.session = {
    id: 'cs_live_fixture',
    status: 'open',
    payment_status: 'unpaid',
    url: 'https://checkout.stripe.com/c/pay/cs_live_fixture',
    livemode: true,
    client_reference_id: 'w1',
    metadata: {
      service: 'zentra-support',
      workspace_id: 'w1',
      owner_id: 'owner',
    },
    subscription: 'sub_support',
  };
});
afterEach(() => sql.close());
it('bloque les opérations et le contenu sans paiement vérifié', async () => {
  expect((await billingState(workspace)).active).toBe(false);
  await expect(requireSupportSubscription(workspace)).rejects.toMatchObject({
    status: 402,
  });
  await expect(
    reserveAnalysis(workspace, 'ticket', 'lease'),
  ).rejects.toMatchObject({ status: 402 });
});
it.each([
  { paid_until: time - 1 },
  { paid_from: time + 1 },
  { livemode: 0 },
  { status: 'incomplete' },
  { status: 'canceled' },
  { status: 'unpaid' },
  { paid_plan_id: 'unknown' },
])('refuse un droit invalide %j', (change) => {
  expect(paidAccess(row(change), true, time)).toBe(false);
});
it('un échec de renouvellement ne retire pas une période déjà payée', () => {
  expect(paidAccess(row({ status: 'past_due' }), true, time)).toBe(true);
  expect(
    paidAccess(row({ status: 'past_due', paid_until: time }), true, time),
  ).toBe(false);
});
it('valide le prix, la devise, le propriétaire et la période de la facture', () => {
  expect(
    paidSupportPeriod(
      invoice(),
      state.subscription as Stripe.Subscription,
      config,
    )?.plan,
  ).toBe('starter');
  for (const change of [
    { amount_paid: 0 },
    { amount_due: 0 },
    { total: 3000 },
    { currency: 'usd' },
    { livemode: false },
    { customer: 'other' },
    { status: 'open' },
    { billing_reason: 'subscription_update' },
  ])
    expect(
      paidSupportPeriod(
        invoice(change),
        state.subscription as Stripe.Subscription,
        config,
      ),
    ).toBeNull();
  for (const change of [
    { quantity: 2 },
    { subtotal: 2800 },
    { currency: 'eur' },
    { period: { start: time - 60, end: time + 86400 * 365 } },
  ]) {
    const value = invoice();
    Object.assign(value.lines.data[0], change);
    expect(
      paidSupportPeriod(
        value,
        state.subscription as Stripe.Subscription,
        config,
      ),
    ).toBeNull();
  }
});
it('réserve atomiquement la dernière analyse et libère les échecs techniques', async () => {
  seedPaid();
  sql
    .prepare(
      "WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM x WHERE n<1999) INSERT INTO support_analysis_usage SELECT 'seed-'||n,'w1',?,'ticket','charged',0,? FROM x",
    )
    .run(time - 60, time);
  const attempts = await Promise.allSettled([
    reserveAnalysis(workspace, 'a', 'lease-a'),
    reserveAnalysis(workspace, 'b', 'lease-b'),
  ]);
  expect(attempts.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  const successful = attempts.find(
    (x) => x.status === 'fulfilled',
  ) as PromiseFulfilledResult<string>;
  await finishAnalysis(successful.value, false);
  await finishAnalysis(await reserveAnalysis(workspace, 'c', 'lease-c'), true);
  expect((await billingState(workspace)).used).toBe(2000);
  await finishAnalysis('lease-c', true);
  expect((await billingState(workspace)).used).toBe(2000);
  await expect(
    reserveAnalysis(workspace, 'd', 'lease-d'),
  ).rejects.toMatchObject({ status: 402 });
});
it('traite les webhooks rejoués sans prolonger ou reculer la période payée', async () => {
  const event = {
    type: 'invoice.paid',
    data: { object: state.invoice },
  } as Stripe.Event;
  expect(await persistSupportStripeEvent(event)).toBe(true);
  expect(await persistSupportStripeEvent(event)).toBe(true);
  expect((await billingState(workspace)).active).toBe(true);
  const end = (await billingState(workspace)).periodEnd;
  const old = invoice();
  old.id = 'in_old';
  old.lines.data[0].period = { start: time - 86400 * 30, end: time - 60 };
  state.invoice = old;
  await persistSupportStripeEvent({
    type: 'invoice.paid',
    data: { object: old },
  } as Stripe.Event);
  expect((await billingState(workspace)).periodEnd).toBe(end);
  (state.subscription as Stripe.Subscription).status = 'canceled';
  await persistSupportStripeEvent({
    type: 'customer.subscription.deleted',
    data: { object: state.subscription },
  } as Stripe.Event);
  expect((await billingState(workspace)).active).toBe(false);
});
it('laisse les événements ERP à leur propre gestionnaire', async () => {
  expect(
    await persistSupportStripeEvent({
      type: 'invoice.paid',
      data: {
        object: invoice({
          parent: {
            type: 'subscription_details',
            subscription_details: { subscription: 'sub_erp' },
          },
        }),
      },
    } as Stripe.Event),
  ).toBe(false);
});
it('ne fait pas confiance au retour de paiement d’un autre espace ou impayé', async () => {
  await expect(
    refreshSupportPayment(workspace, user, 'cs_live_fixture'),
  ).rejects.toMatchObject({ status: 409 });
  (state.session as Stripe.Checkout.Session).metadata!.workspace_id = 'w2';
  await expect(
    refreshSupportPayment(workspace, user, 'cs_live_fixture'),
  ).rejects.toMatchObject({ status: 403 });
  expect((await billingState(workspace)).active).toBe(false);
});
it('active le paiement au retour même si le webhook est en retard', async () => {
  Object.assign(state.session as object, {
    status: 'complete',
    payment_status: 'paid',
  });
  await refreshSupportPayment(workspace, user, 'cs_live_fixture');
  expect((await billingState(workspace)).active).toBe(true);
});
it('conserve un seul checkout et une preuve durable de consentement', async () => {
  const body = {
    plan: 'starter',
    acceptTerms: true,
    legalVersion: SUPPORT_LEGAL_VERSION,
  };
  await expect(
    createSupportCheckout(workspace, { ...user, userId: 'member' }, body),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    createSupportCheckout(workspace, user, { ...body, acceptTerms: false }),
  ).rejects.toThrow('conditions');
  const first = await createSupportCheckout(workspace, user, body),
    second = await createSupportCheckout(workspace, user, body);
  expect(first).toEqual(second);
  expect(state.calls).toHaveLength(1);
  expect(state.calls[0].body.line_items).toEqual([
    { price: 'price_starter', quantity: 1 },
  ]);
  expect(
    sql.prepare('SELECT * FROM support_checkout_acceptances').all(),
  ).toHaveLength(1);
  await expect(
    createSupportCheckout(workspace, user, { ...body, plan: 'team' }),
  ).rejects.toThrow();
  await cancelSupportCheckout(workspace, user);
  expect(
    sql.prepare('SELECT expires_at FROM support_checkouts').get()?.expires_at,
  ).toBe(0);
});
it('refuse la configuration d’un autre mode Stripe', async () => {
  state.env.STRIPE_SECRET_KEY = 'sk_test_fixture';
  expect((await billingState(workspace)).ready).toBe(false);
  seedPaid();
  expect((await billingState(workspace)).active).toBe(false);
});

it('ferme le checkout de contrôle même quand sa validation échoue',async()=>{
  await expect(verifySupportBilling()).rejects.toMatchObject({status:503});
  expect((state.session as Stripe.Checkout.Session).status).toBe('expired');
  expect((await billingState(workspace)).active).toBe(false);
});
