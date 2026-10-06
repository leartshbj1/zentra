import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import type Stripe from 'stripe';
import type { ZentraUser } from '@/app/zentra-auth';
import { D1StripeSupportPurchase } from './stripe-support-purchase';
import {
  D1StripeSupportProvisioning,
  verifyStripeSupportCash,
  type SupportSettlementTransport,
} from './stripe-support-provisioning';
import {
  paidSupportPeriod,
  persistSupportStripeEvent,
  billingState,
} from '@/lib/support/billing';
import { digest } from '@/lib/support/crypto';
import { sha256 } from '@/lib/stripe';
import { SUPPORT_LEGAL_VERSION } from '@/lib/support/plans';
import type { Workspace } from '@/lib/support/types';

const runtime = vi.hoisted(() => ({
  db: null as unknown,
  config: {} as Record<string, string>,
  session: null as unknown,
  subscription: null as unknown,
  invoice: null as unknown,
  charge: null as unknown,
  paymentIntent: null as unknown,
  payment: null as unknown,
}));
vi.mock('@/lib/runtime', () => ({
  database: () => runtime.db,
  runtimeValue: (key: string) => runtime.config[key] ?? '',
  stripeConfiguration: () => ({
    secretKey: runtime.config.STRIPE_SECRET_KEY,
    siteUrl: 'https://zentraapp.ch',
    testMode: 'owner_only',
    ownerAccountUserId: 'support-proof-owner',
    ownerEmail: 'proof@example.test',
  }),
}));
vi.mock('@/lib/site-language-server', () => ({
  currentSiteLanguage: () => 'fr',
}));
vi.mock('stripe', () => ({
  default: class {
    static createFetchHttpClient() {
      return {};
    }
    checkout = {
      sessions: {
        retrieve: async () => runtime.session,
        list: async () => ({ data: [runtime.session], has_more: false }),
        create: () => {
          throw new Error('No real provider dispatch in provisioning tests');
        },
      },
    };
    subscriptions = { retrieve: async () => runtime.subscription };
    invoices = { retrieve: async () => runtime.invoice };
    invoicePayments = {
      list: async () => ({ data: [runtime.payment], has_more: false }),
    };
    paymentIntents = { retrieve: async () => runtime.paymentIntent };
    charges = { retrieve: async () => runtime.charge };
  },
}));
let sql: DatabaseSync, now: number, beforeBatch: (() => void) | null;
let session: Stripe.Checkout.Session,
  subscription: Stripe.Subscription,
  invoice: Stripe.Invoice;
let payment: Stripe.InvoicePayment,
  paymentIntent: Stripe.PaymentIntent,
  charge: Stripe.Charge;
let transport: SupportSettlementTransport, providerScope: string;
const user = {
  userId: 'support-proof-owner',
  email: 'proof@example.test',
  displayName: 'Synthetic proof owner',
  fullName: 'Synthetic proof owner',
  provider: 'supabase',
  emailConfirmed: true,
} as ZentraUser;
const config = {
  secretKey: 'sk_test_support_proof_synthetic_not_real',
  productId: 'prod_support_proof',
  prices: {
    starter: 'price_starter_proof',
    team: 'price_team_proof',
    business: 'price_business_proof',
  },
  portalId: 'portal_proof',
  livemode: false,
  keyBinding: '',
};
const count = (table: string) =>
  sql.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n;
function d1() {
  return {
    prepare(query: string) {
      let args: SQLInputValue[] = [];
      const p = {
        bind(...values: SQLInputValue[]) {
          args = values;
          return p;
        },
        async first() {
          return sql.prepare(query).get(...args) ?? null;
        },
        async all() {
          return { results: sql.prepare(query).all(...args) };
        },
        async run() {
          return { success: true, meta: sql.prepare(query).run(...args) };
        },
        query,
        get args() {
          return args;
        },
      };
      return p;
    },
    async batch(queries: Array<{ query: string; args: SQLInputValue[] }>) {
      beforeBatch?.();
      sql.exec('BEGIN IMMEDIATE');
      try {
        const out = queries.map((q) => ({
          success: true,
          meta: sql.prepare(q.query).run(...q.args),
        }));
        sql.exec('COMMIT');
        return out;
      } catch (error) {
        sql.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
}
const provision = () =>
  new D1StripeSupportProvisioning(
    d1(),
    transport,
    paidSupportPeriod,
    () => now,
  ).provision(subscription, invoice, config, providerScope);
function assertNoRights() {
  expect(count('support_subscriptions')).toBe(0);
  expect(count('stripe_support_paid_projections')).toBe(0);
  expect(
    sql.prepare('SELECT state FROM purchase_intents').get()?.state,
  ).not.toBe('settled');
  expect(
    sql.prepare('SELECT released_at FROM purchase_intent_footprints').get()
      ?.released_at,
  ).toBeNull();
}
function syncRuntime() {
  runtime.session = session;
  runtime.subscription = subscription;
  runtime.invoice = invoice;
  runtime.charge = charge;
  runtime.paymentIntent = paymentIntent;
  runtime.payment = payment;
}
function company() {
  sql
    .prepare(
      "INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at,seat_limit) VALUES('draft_proof_company','draft_customer','synthetic','incomplete',0,0,?,3)",
    )
    .run(now);
  sql
    .prepare(
      "INSERT INTO organizations(organization_id,name,subscription_id,created_by_user_id,created_at,updated_at) VALUES('company-proof','Synthetic company','draft_proof_company',?,?,?)",
    )
    .run(user.userId, now, now);
  sql
    .prepare(
      "INSERT INTO organization_members(membership_id,organization_id,user_id,email,display_name,role,joined_at) VALUES('member-proof','company-proof',?,?,'Synthetic owner','owner',?)",
    )
    .run(user.userId, user.email, now);
  sql
    .prepare(
      "INSERT INTO support_gestion_links(workspace_id,organization_id,enabled,auto_post,connected_by,created_at) VALUES('support-proof','company-proof',1,0,?,?)",
    )
    .run(user.userId, now);
}
async function prepare(linked = false, responseLost = false) {
  if (linked) company();
  const price = {
    id: config.prices.team,
    active: true,
    product: { id: config.productId, active: true },
    livemode: false,
    currency: 'chf',
    unit_amount: 4900,
    type: 'recurring',
    recurring: { interval: 'month', interval_count: 1 },
    tax_behavior: 'inclusive',
    metadata: { service: 'zentra-support', plan: 'team' },
  } as unknown as Stripe.Price;
  const checkoutTransport = {
    price: async () => price,
    create: async (parameters: Stripe.Checkout.SessionCreateParams) => {
      session = {
        id: 'cs_test_supportproof',
        mode: 'subscription',
        status: 'open',
        payment_status: 'unpaid',
        url: 'https://checkout.stripe.com/synthetic-proof',
        livemode: false,
        client_reference_id: parameters.client_reference_id,
        expires_at: parameters.expires_at,
        metadata: { ...parameters.metadata },
        subscription: null,
        customer: 'cus_support_proof',
      } as Stripe.Checkout.Session;
      subscription = {
        id: 'sub_support_proof',
        customer: 'cus_support_proof',
        status: 'active',
        livemode: false,
        cancel_at_period_end: false,
        metadata: { ...parameters.subscription_data!.metadata },
        latest_invoice: 'in_support_proof',
        items: { data: [{ quantity: 1, price }] },
      } as Stripe.Subscription;
      if (responseLost) throw new Error('Synthetic lost checkout response');
      return session;
    },
    retrieve: async () => session,
    list: async () => ({ data: [session], has_more: false }),
    expire: async () => ({ ...session, status: 'expired' as const }),
  };
  const controller = new D1StripeSupportPurchase(
    d1(),
    config,
    checkoutTransport,
    () => now,
  );
  const request = controller.checkout({
    user,
    workspaceId: 'support-proof',
    planId: 'team',
    origin: 'https://zentraapp.ch',
    legalVersion: SUPPORT_LEGAL_VERSION,
  });
  if (responseLost)
    await expect(request).rejects.toThrow('Synthetic lost checkout response');
  else await request;
  session.status = 'complete';
  session.payment_status = 'paid';
  session.subscription = subscription.id;
  invoice = {
    id: 'in_support_proof',
    status: 'paid',
    livemode: false,
    currency: 'chf',
    amount_paid: 4900,
    amount_due: 4900,
    total: 4900,
    customer: subscription.customer,
    status_transitions: { paid_at: now },
    billing_reason: 'subscription_create',
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
          subtotal: 4900,
          period: { start: now - 60, end: now + 30 * 86400 },
          pricing: { price_details: { price: price.id } },
          parent: {
            type: 'subscription_item_details',
            subscription_item_details: {
              proration: false,
              subscription: subscription.id,
            },
          },
        },
      ],
    },
  } as unknown as Stripe.Invoice;
  payment = {
    id: 'inpay_support_proof',
    invoice: invoice.id,
    livemode: false,
    currency: 'chf',
    status: 'paid',
    amount_paid: 4900,
    payment: { type: 'payment_intent', payment_intent: 'pi_support_proof' },
  } as Stripe.InvoicePayment;
  paymentIntent = {
    id: 'pi_support_proof',
    latest_charge: 'ch_support_proof',
    amount_received: 4900,
    status: 'succeeded',
    customer: subscription.customer,
    currency: 'chf',
    livemode: false,
  } as Stripe.PaymentIntent;
  charge = {
    id: 'ch_support_proof',
    payment_intent: paymentIntent.id,
    paid: true,
    captured: true,
    status: 'succeeded',
    amount_captured: 4900,
    amount_refunded: 0,
    refunded: false,
    customer: subscription.customer,
    currency: 'chf',
    livemode: false,
  } as Stripe.Charge;
  syncRuntime();
}
beforeEach(async () => {
  now = Math.floor(Date.now() / 1000);
  beforeBatch = null;
  sql = new DatabaseSync(':memory:');
  for (const f of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((f) => f.endsWith('.sql'))
    .sort())
    sql.exec(
      readFileSync(new URL('../../drizzle/' + f, import.meta.url), 'utf8'),
    );
  runtime.db = d1();
  runtime.config = {
    STRIPE_SECRET_KEY: config.secretKey,
    PUBLIC_SITE_URL: 'https://zentraapp.ch',
  };
  config.keyBinding = await digest(config.secretKey);
  providerScope = 'stripe_key_' + (await sha256(config.secretKey));
  sql
    .prepare(
      "INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at) VALUES('support-proof',?,'Synthetic support',?,?)",
    )
    .run(user.userId, now, now);
  sql
    .prepare("INSERT INTO support_billing_config VALUES('stripe',?,?)")
    .run(JSON.stringify(config), now);
  transport = {
    session: vi.fn(async () => session),
    sessions: vi.fn(async () => ({ data: [session], has_more: false })),
    payments: vi.fn(async () => ({ data: [payment], has_more: false })),
    paymentIntent: vi.fn(async () => paymentIntent),
    charge: vi.fn(async () => charge),
  };
});
afterEach(() => sql.close());
describe('Support paid handoff using real migrations, verified invoice and captured cash', () => {
  it.each([false, true])(
    'projects the exact standalone/linked target atomically, then settles and releases its footprints: %s',
    async (linked) => {
      await prepare(linked);
      await expect(provision()).resolves.toBe(true);
      expect(count('support_subscriptions')).toBe(1);
      expect(count('stripe_support_paid_projections')).toBe(1);
      expect(
        sql.prepare('SELECT state FROM purchase_intents').get()?.state,
      ).toBe('settled');
      expect(
        sql
          .prepare(
            'SELECT COUNT(*) n FROM purchase_intent_footprints WHERE released_at IS NOT NULL',
          )
          .get()?.n,
      ).toBe(linked ? 2 : 1);
      expect(
        sql
          .prepare(
            'SELECT closed_at,subscription_id FROM stripe_support_purchase_requests',
          )
          .get(),
      ).toEqual({ closed_at: now, subscription_id: subscription.id });
      const before = sql
        .prepare('SELECT * FROM stripe_support_paid_projections')
        .get();
      await expect(provision()).resolves.toBe(false);
      expect(
        sql.prepare('SELECT * FROM stripe_support_paid_projections').get(),
      ).toEqual(before);
    },
  );
  it('recovers the authoritative session and original consent after a lost checkout response', async () => {
    await prepare(false, true);
    expect(
      sql
        .prepare('SELECT session_id FROM stripe_support_purchase_requests')
        .get()?.session_id,
    ).toBeNull();
    await provision();
    expect(transport.sessions).toHaveBeenCalledTimes(1);
    expect(
      sql
        .prepare('SELECT session_id FROM stripe_support_purchase_requests')
        .get()?.session_id,
    ).toBe(session.id);
    expect(count('support_checkout_acceptances')).toBe(1);
    expect(count('legal_acceptances')).toBe(1);
  });
  it('two concurrent reconciliations retain one immutable proof and one paid subscription', async () => {
    await prepare(true);
    await expect(Promise.all([provision(), provision()])).resolves.toEqual([
      true,
      true,
    ]);
    expect(count('stripe_support_paid_projections')).toBe(1);
    expect(count('support_subscriptions')).toBe(1);
    expect(count('support_checkout_acceptances')).toBe(1);
    expect(count('legal_acceptances')).toBe(1);
    expect(
      sql
        .prepare(
          'SELECT COUNT(*) n FROM purchase_intent_footprints WHERE released_at IS NOT NULL',
        )
        .get()?.n,
    ).toBe(2);
  });
  it('does not grant from a status event or an unpaid invoice', async () => {
    await prepare();
    invoice.status = 'open';
    await expect(provision()).resolves.toBe(true);
    assertNoRights();
    expect(transport.payments).not.toHaveBeenCalled();
  });
  it.each([
    'owner',
    'workspace',
    'subscription',
    'session-customer',
    'environment',
    'price',
    'invoice-customer',
    'invoice-date',
    'invoice-subscription',
  ])(
    'rejects changed %s context without projecting or releasing',
    async (fault) => {
      await prepare();
      if (fault === 'owner') subscription.metadata.owner_id = 'other';
      if (fault === 'workspace') subscription.metadata.workspace_id = 'other';
      if (fault === 'subscription') session.subscription = 'sub_other';
      if (fault === 'session-customer') session.customer = 'cus_other';
      if (fault === 'environment') session.livemode = true;
      if (fault === 'price')
        subscription.items.data[0].price.id = 'price_other';
      if (fault === 'invoice-customer') invoice.customer = 'cus_other';
      if (fault === 'invoice-date')
        invoice.status_transitions.paid_at = now + 1000;
      if (fault === 'invoice-subscription')
        invoice.parent!.subscription_details!.subscription = 'sub_other';
      await expect(provision()).rejects.toMatchObject({ status: 409 });
      assertNoRights();
    },
  );
  it.each([
    'missing-charge',
    'uncaptured',
    'wrong-charge-customer',
    'wrong-pi-customer',
    'truncated',
    'zero-payments',
    'duplicate-payment',
    'record-only',
  ])('does not invent cash evidence for %s', async (fault) => {
    await prepare();
    if (fault === 'missing-charge') paymentIntent.latest_charge = null;
    if (fault === 'uncaptured') charge.captured = false;
    if (fault === 'wrong-charge-customer') charge.customer = 'cus_other';
    if (fault === 'wrong-pi-customer') paymentIntent.customer = 'cus_other';
    if (fault === 'truncated')
      transport.payments = vi.fn(async () => ({
        data: [payment],
        has_more: true,
      }));
    if (fault === 'zero-payments')
      transport.payments = vi.fn(async () => ({ data: [], has_more: false }));
    if (fault === 'duplicate-payment')
      transport.payments = vi.fn(async () => ({
        data: [payment, payment],
        has_more: false,
      }));
    if (fault === 'record-only')
      payment.payment = {
        type: 'payment_record',
        payment_record: 'pymrec_synthetic',
      };
    await expect(provision()).rejects.toThrow();
    assertNoRights();
  });
  it('supports a synthetic captured TWINT charge through its PaymentIntent without depending on card fields', async () => {
    await prepare();
    charge.payment_method_details = {
      type: 'twint',
      twint: {},
    } as Stripe.Charge.PaymentMethodDetails;
    await expect(provision()).resolves.toBe(true);
    expect(count('stripe_support_paid_projections')).toBe(1);
  });
  it('replaces a terminated and expired historical subscription only after its new invoice is proved', async () => {
    sql
      .prepare(
        "INSERT INTO support_subscriptions(workspace_id,subscription_id,customer_id,plan_id,status,paid_from,paid_until,paid_plan_id,last_paid_invoice_id,cancel_at_period_end,livemode,updated_at) VALUES('support-proof','sub_old','cus_old','starter','canceled',0,0,NULL,NULL,0,0,?)",
      )
      .run(now);
    await prepare();
    await provision();
    expect(
      sql
        .prepare(
          'SELECT subscription_id,last_paid_invoice_id FROM support_subscriptions',
        )
        .get(),
    ).toEqual({
      subscription_id: subscription.id,
      last_paid_invoice_id: invoice.id,
    });
  });
  it('persists a reversal before the first grant and never resurrects it from an unchanged paid cache', async () => {
    await prepare();
    charge.amount_refunded = 4900;
    charge.refunded = true;
    await expect(provision()).rejects.toMatchObject({ status: 409 });
    expect(count('support_refunds')).toBe(1);
    assertNoRights();
    charge.amount_refunded = 0;
    charge.refunded = false;
    await expect(provision()).rejects.toMatchObject({ status: 409 });
    assertNoRights();
    expect(() => sql.prepare('DELETE FROM support_refunds').run()).toThrow(
      /history/,
    );
  });
  it('rolls back the complete projection if a refund wins the race immediately before the SQL batch', async () => {
    await prepare();
    beforeBatch = () => {
      beforeBatch = null;
      sql
        .prepare('INSERT INTO support_refunds VALUES(?,?,?,?)')
        .run(invoice.id!, 'cus_support_proof', 0, now);
    };
    await expect(provision()).rejects.toThrow(/paid_binding/);
    assertNoRights();
    expect(count('support_refunds')).toBe(1);
  });
  it('rechecks active ownership in SQL if it is revoked after provider verification', async () => {
    await prepare(true);
    beforeBatch = () => {
      beforeBatch = null;
      sql
        .prepare(
          "UPDATE organization_members SET revoked_at=? WHERE membership_id='member-proof'",
        )
        .run(now);
    };
    await expect(provision()).rejects.toThrow(/paid_binding/);
    assertNoRights();
  });
  it('rejects the new Support reader target if the company link moves before projection', async () => {
    await prepare(true);
    sql
      .prepare(
        "DELETE FROM support_gestion_links WHERE workspace_id='support-proof'",
      )
      .run();
    await expect(provision()).rejects.toThrow(/paid_binding/);
    assertNoRights();
  });
  it('cannot release a footprint from a forged paid cache without a projection proof', async () => {
    await prepare();
    const intent = sql.prepare('SELECT * FROM purchase_intents').get()!;
    sql
      .prepare(
        "UPDATE purchase_intents SET state='settled',evidence_fingerprint=?,finalized_at=? WHERE intent_id=?",
      )
      .run('a'.repeat(64), now, intent.intent_id);
    expect(() =>
      sql
        .prepare('UPDATE purchase_intent_footprints SET released_at=?')
        .run(now),
    ).toThrow(/immutable/);
    expect(count('stripe_support_paid_projections')).toBe(0);
  });
  it('freezes the paid proof against edits and deletes', async () => {
    await prepare();
    await provision();
    expect(() =>
      sql
        .prepare("UPDATE stripe_support_paid_projections SET price_id='other'")
        .run(),
    ).toThrow(/immutable/);
    expect(() =>
      sql.prepare('DELETE FROM stripe_support_paid_projections').run(),
    ).toThrow(/history/);
  });
  it('bounds direct-charge verification and refuses duplicate charge claims', async () => {
    await prepare();
    payment.payment = { type: 'charge', charge: charge.id };
    await expect(
      verifyStripeSupportCash(invoice, subscription, transport),
    ).resolves.toMatchObject({ refunded: false });
    expect(transport.paymentIntent).not.toHaveBeenCalled();
    transport.payments = async () => ({
      data: [payment, { ...payment, id: 'inpay_other', amount_paid: 1 }],
      has_more: false,
    });
    await expect(
      verifyStripeSupportCash(invoice, subscription, transport),
    ).rejects.toThrow();
  });
});
describe('real Support reconciliation entry points, fictitious read-only SDK', () => {
  it('the invoice webhook performs the actual paid handoff, not just a cache update', async () => {
    await prepare();
    const event = {
      id: 'evt_support_proof',
      type: 'invoice.paid',
      livemode: false,
      data: { object: invoice },
    } as Stripe.Event;
    await expect(persistSupportStripeEvent(event)).resolves.toBe(true);
    expect(sql.prepare('SELECT state FROM purchase_intents').get()?.state).toBe(
      'settled',
    );
    expect(
      (
        await billingState({
          id: 'support-proof',
          owner_id: user.userId,
        } as Workspace)
      ).active,
    ).toBe(true);
  });
  it('renewal with an authorized current price is not constrained by the closed initial snapshot', async () => {
    await prepare();
    await provision();
    now += 100;
    const p = subscription.items.data[0].price;
    p.id = config.prices.business;
    p.unit_amount = 9900;
    p.metadata.plan = 'business';
    invoice.id = 'in_support_next';
    invoice.amount_paid = invoice.amount_due = invoice.total = 9900;
    invoice.billing_reason = 'subscription_cycle';
    invoice.lines.data[0].subtotal = 9900;
    invoice.lines.data[0].pricing!.price_details!.price = p.id;
    invoice.lines.data[0].period = { start: now, end: now + 30 * 86400 };
    payment.invoice = invoice.id;
    payment.amount_paid = 9900;
    paymentIntent.amount_received = charge.amount_captured = 9900;
    syncRuntime();
    await persistSupportStripeEvent({
      id: 'evt_support_next',
      type: 'invoice.paid',
      livemode: false,
      data: { object: invoice },
    } as Stripe.Event);
    expect(
      sql
        .prepare(
          'SELECT paid_plan_id,last_paid_invoice_id FROM support_subscriptions',
        )
        .get(),
    ).toEqual({ paid_plan_id: 'business', last_paid_invoice_id: invoice.id });
    expect(
      sql
        .prepare(
          'SELECT price_id,invoice_id FROM stripe_support_paid_projections',
        )
        .get(),
    ).toEqual({ price_id: config.prices.team, invoice_id: 'in_support_proof' });
  });
  it('a refund webhook removes access and stale invoice replays cannot re-enable it', async () => {
    await prepare();
    await provision();
    charge.amount_refunded = 4900;
    charge.refunded = true;
    syncRuntime();
    await expect(
      persistSupportStripeEvent({
        id: 'evt_support_refund',
        type: 'charge.refunded',
        livemode: false,
        data: { object: charge },
      } as Stripe.Event),
    ).resolves.toBe(true);
    const workspace = {
      id: 'support-proof',
      owner_id: user.userId,
    } as Workspace;
    expect((await billingState(workspace)).active).toBe(false);
    charge.amount_refunded = 0;
    charge.refunded = false;
    syncRuntime();
    await persistSupportStripeEvent({
      id: 'evt_support_stale',
      type: 'invoice.paid',
      livemode: false,
      data: { object: invoice },
    } as Stripe.Event);
    expect((await billingState(workspace)).active).toBe(false);
    expect(count('support_refunds')).toBe(1);
  });
});
