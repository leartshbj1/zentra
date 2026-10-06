import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import type Stripe from 'stripe';
import type { ZentraUser } from '@/app/zentra-auth';
import { D1StripeAutomationPurchase } from './stripe-automation-purchase';
import {
  D1StripeAutomationProvisioning,
  type AutomationSettlementTransport,
} from './stripe-automation-provisioning';
import {
  paidAutomationPeriod,
  AUTOMATION_TERMS_VERSION,
} from '@/lib/automation/billing';
import { AUTOMATION_CONSENT_VERSION } from '@/lib/automation/config';
import { automationEntitlement } from '@/lib/automation/entitlement';
import { sha256 } from '@/lib/stripe';
import { digest } from '@/lib/support/crypto';
let sql: DatabaseSync,
  now: number,
  beforeBatch: (() => void) | null,
  providerScope: string,
  originalFetch: typeof fetch;
let session: Stripe.Checkout.Session,
  subscription: Stripe.Subscription,
  invoice: Stripe.Invoice,
  charge: Stripe.Charge,
  payment: Stripe.InvoicePayment,
  paymentIntent: Stripe.PaymentIntent;
let transport: AutomationSettlementTransport;
const runtime = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/runtime', () => ({
  database: () => runtime.db,
  runtimeValue: (key: string) =>
    key === 'STRIPE_SECRET_KEY' ? 'sk_test_automation_proof_fake' : '',
  stripeConfiguration: () => ({
    secretKey: 'sk_test_automation_proof_fake',
    siteUrl: 'https://zentraapp.ch',
  }),
}));
vi.mock('@/lib/site-language-server', () => ({
  currentSiteLanguage: () => 'fr',
}));
const user = {
  userId: 'automation-proof-owner',
  email: 'automation-proof@example.test',
  displayName: 'Synthetic owner',
  fullName: null,
  emailConfirmed: true,
  provider: 'supabase',
} satisfies ZentraUser;
const config = {
  secretKey: 'sk_test_automation_proof_fake',
  productId: 'prod_automation_proof',
  priceId: 'price_automation_proof',
  portalId: 'portal_fake',
  livemode: false,
  keyBinding: '',
  automaticTax: false,
};
function d1() {
  return {
    prepare(query: string) {
      let args: SQLInputValue[] = [];
      const p = {
        bind(...v: SQLInputValue[]) {
          args = v;
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
    async batch(queries: { query: string; args: SQLInputValue[] }[]) {
      beforeBatch?.();
      sql.exec('BEGIN IMMEDIATE');
      try {
        const out = queries.map((q) => ({
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
  } as unknown as D1Database;
}
const count = (t: string) =>
  sql.prepare('SELECT COUNT(*) n FROM ' + t).get()!.n;
const rights = () =>
  automationEntitlement({
    organizationId: 'automation-proof',
    userId: user.userId,
    role: 'owner',
    founder: false,
  } as Parameters<typeof automationEntitlement>[0]);
const provision = (
  source: 'verified_webhook' | 'account_refresh' = 'verified_webhook',
) =>
  new D1StripeAutomationProvisioning(
    d1(),
    transport,
    paidAutomationPeriod,
    () => now,
  ).provision(subscription, invoice, config, providerScope, source);
function noRights() {
  expect(count('automation_subscriptions')).toBe(0);
  expect(count('stripe_automation_paid_projections')).toBe(0);
  expect(
    sql.prepare('SELECT state FROM purchase_intents').get()!.state,
  ).not.toBe('settled');
  expect(
    sql.prepare('SELECT released_at FROM purchase_intent_footprints').get()!
      .released_at,
  ).toBeNull();
}
async function prepare(lost = false) {
  const price = {
    id: config.priceId,
    active: true,
    product: { id: config.productId, active: true },
    livemode: false,
    currency: 'chf',
    unit_amount: 1500,
    type: 'recurring',
    recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
    tax_behavior: 'inclusive',
    metadata: { service: 'zentra_automation' },
  } as unknown as Stripe.Price;
  const ctrl = new D1StripeAutomationPurchase(
    d1(),
    config,
    {
      price: async () => price,
      create: async (p) => {
        session = {
          id: 'cs_test_automationproof',
          mode: 'subscription',
          status: 'open',
          payment_status: 'unpaid',
          url: 'https://checkout.stripe.com/synthetic-proof',
          livemode: false,
          client_reference_id: p.client_reference_id,
          expires_at: p.expires_at,
          metadata: { ...p.metadata },
          customer: p.customer as string,
          subscription: null,
        } as Stripe.Checkout.Session;
        subscription = {
          id: 'sub_automation_proof',
          customer: p.customer,
          status: 'active',
          livemode: false,
          cancel_at_period_end: false,
          metadata: { ...p.subscription_data!.metadata },
          latest_invoice: 'in_automation_proof',
          items: { data: [{ quantity: 1, price }] },
        } as Stripe.Subscription;
        if (lost) throw Error('Synthetic lost response');
        return session;
      },
      retrieve: async () => session,
      list: async () => ({ data: [session], has_more: false }),
      expire: async () => ({ ...session, status: 'expired' as const }),
    },
    () => now,
  );
  const request = ctrl.checkout({
    user,
    organizationId: 'automation-proof',
    origin: 'https://zentraapp.ch',
    legalVersion: AUTOMATION_TERMS_VERSION,
    consentVersion: AUTOMATION_CONSENT_VERSION,
  });
  if (lost) await expect(request).rejects.toThrow('Synthetic lost response');
  else await request;
  session.status = 'complete';
  session.payment_status = 'paid';
  session.subscription = subscription.id;
  invoice = {
    id: 'in_automation_proof',
    status: 'paid',
    livemode: false,
    currency: 'chf',
    amount_paid: 1500,
    amount_due: 1500,
    automatic_tax: { enabled: false, status: null },
    total: 1500,
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
          subtotal: 1500,
          period: { start: now - 60, end: now + 30 * 86400 },
          pricing: {
            unit_amount_decimal: '1500',
            price_details: { price: price.id },
          },
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
    id: 'inpay_automation_proof',
    invoice: invoice.id,
    livemode: false,
    currency: 'chf',
    status: 'paid',
    amount_paid: 1500,
    payment: { type: 'payment_intent', payment_intent: 'pi_automation_proof' },
  } as Stripe.InvoicePayment;
  paymentIntent = {
    id: 'pi_automation_proof',
    latest_charge: 'ch_automation_proof',
    amount_received: 1500,
    status: 'succeeded',
    customer: subscription.customer,
    currency: 'chf',
    livemode: false,
  } as Stripe.PaymentIntent;
  charge = {
    id: 'ch_automation_proof',
    payment_intent: paymentIntent.id,
    paid: true,
    captured: true,
    status: 'succeeded',
    amount_captured: 1500,
    amount_refunded: 0,
    refunded: false,
    customer: subscription.customer,
    currency: 'chf',
    livemode: false,
  } as Stripe.Charge;
}
beforeEach(async () => {
  now = Math.floor(Date.now() / 1000);
  beforeBatch = null;
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => {
    throw Error('External HTTP forbidden');
  });
  sql = new DatabaseSync(':memory:');
  for (const f of readdirSync(new URL('../../drizzle/', import.meta.url))
    .filter((f) => f.endsWith('.sql'))
    .sort())
    sql.exec(
      readFileSync(new URL('../../drizzle/' + f, import.meta.url), 'utf8'),
    );
  runtime.db = d1();
  config.keyBinding = await digest(config.secretKey);
  providerScope = 'stripe_key_' + (await sha256(config.secretKey));
  sql
    .prepare(
      "INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,entitlement_valid_until,livemode,updated_at,seat_limit) VALUES('sub_base_proof','cus_base_proof','price_base','active',?,?,0,?,3)",
    )
    .run(now + 864000, now + 864000, now);
  sql
    .prepare(
      "INSERT INTO organizations VALUES('automation-proof','Synthetic company','sub_base_proof',?,?,?)",
    )
    .run(user.userId, now, now);
  sql
    .prepare(
      "INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES('member-proof','automation-proof',?,?,'owner',?)",
    )
    .run(user.userId, user.email, now);
  transport = {
    session: vi.fn(async () => session),
    sessions: vi.fn(async () => ({ data: [session], has_more: false })),
    payments: vi.fn(async () => ({ data: [payment], has_more: false })),
    paymentIntent: vi.fn(async () => paymentIntent),
    charge: vi.fn(async () => charge),
  };
});
afterEach(() => {
  sql?.close();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  globalThis.fetch = originalFetch;
});
describe('Automation exact paid handoff, cash proof and immutable refunds', () => {
  it('projects signed cash-backed first period, settles/release, preserves consent and replays without altering proof', async () => {
    await prepare();
    await expect(rights()).resolves.toBe(false);
    await expect(provision()).resolves.toBe(true);
    expect(count('stripe_automation_paid_projections')).toBe(1);
    expect(sql.prepare('SELECT state FROM purchase_intents').get()!.state).toBe(
      'settled',
    );
    expect(
      sql.prepare('SELECT released_at FROM purchase_intent_footprints').get()!
        .released_at,
    ).toBe(now);
    expect(
      sql
        .prepare('SELECT closed_at FROM stripe_automation_purchase_requests')
        .get()!.closed_at,
    ).toBe(now);
    expect(
      sql
        .prepare(
          'SELECT enabled,mode,consent_version,consent_at FROM automation_settings',
        )
        .get(),
    ).toEqual({
      enabled: 0,
      mode: 'shadow',
      consent_version: AUTOMATION_CONSENT_VERSION,
      consent_at: now,
    });
    await expect(rights()).resolves.toBe(true);
    const proof = sql
      .prepare('SELECT * FROM stripe_automation_paid_projections')
      .get();
    await expect(provision()).resolves.toBe(false);
    expect(
      sql.prepare('SELECT * FROM stripe_automation_paid_projections').get(),
    ).toEqual(proof);
  });
  it('concurrent handoffs retain exactly one immutable projection', async () => {
    await prepare();
    await expect(Promise.all([provision(), provision()])).resolves.toEqual([
      true,
      true,
    ]);
    expect(count('stripe_automation_paid_projections')).toBe(1);
    expect(count('automation_subscriptions')).toBe(1);
    expect(count('legal_acceptances')).toBe(1);
  });
  it('first account refresh and unpaid status cannot grant a period', async () => {
    await prepare();
    await expect(provision('account_refresh')).resolves.toBe(true);
    noRights();
    invoice.status = 'open';
    await expect(provision()).resolves.toBe(true);
    noRights();
  });
  it('lost response is reconciled from exactly one authoritative session', async () => {
    await prepare(true);
    expect(
      sql
        .prepare('SELECT session_id FROM stripe_automation_purchase_requests')
        .get()!.session_id,
    ).toBeNull();
    await provision();
    expect(transport.sessions).toHaveBeenCalledTimes(1);
    expect(count('legal_acceptances')).toBe(1);
    await expect(rights()).resolves.toBe(true);
  });
  it('original price/tax/config snapshot survives admin price rotation', async () => {
    await prepare();
    await expect(
      new D1StripeAutomationProvisioning(
        d1(),
        transport,
        paidAutomationPeriod,
        () => now,
      ).provision(
        subscription,
        invoice,
        {
          ...config,
          productId: 'prod_rotated',
          priceId: 'price_rotated',
          automaticTax: true,
        },
        providerScope,
        'verified_webhook',
      ),
    ).resolves.toBe(true);
    await expect(rights()).resolves.toBe(true);
  });
  it.each([
    'owner',
    'company',
    'base',
    'session-customer',
    'session-subscription',
    'session-price',
    'scope',
    'consent',
    'price',
    'quantity',
    'paid-date',
    'period',
    'invoice-customer',
  ])('rejects mismatched %s without partial rights', async (kind) => {
    await prepare();
    if (kind === 'owner') subscription.metadata.owner_id = 'other';
    if (kind === 'company') subscription.metadata.organization_id = 'other';
    if (kind === 'base') subscription.metadata.base_subscription_id = 'other';
    if (kind === 'session-customer') session.customer = 'cus_other';
    if (kind === 'session-subscription') session.subscription = 'sub_other';
    if (kind === 'session-price') session.metadata!.price_id = 'price_other';
    if (kind === 'scope') providerScope = 'stripe_key_other';
    if (kind === 'consent') subscription.metadata.consent_version = 'other';
    if (kind === 'price') subscription.items.data[0].price.unit_amount = 999;
    if (kind === 'quantity') subscription.items.data[0].quantity = 2;
    if (kind === 'paid-date') invoice.status_transitions.paid_at = now + 600;
    if (kind === 'period') invoice.lines.data[0].period.end = now + 33 * 86400;
    if (kind === 'invoice-customer') invoice.customer = 'cus_other';
    await expect(provision()).rejects.toThrow();
    noRights();
  });
  it.each([
    'truncated',
    'missing',
    'wrong-customer',
    'uncaptured',
    'duplicate',
    'amount',
  ])('requires bounded complete positive cash evidence: %s', async (kind) => {
    await prepare();
    if (kind === 'truncated')
      vi.mocked(transport.payments).mockResolvedValue({
        data: [payment],
        has_more: true,
      });
    if (kind === 'missing')
      vi.mocked(transport.payments).mockResolvedValue({
        data: [],
        has_more: false,
      });
    if (kind === 'wrong-customer') paymentIntent.customer = 'cus_other';
    if (kind === 'uncaptured') charge.captured = false;
    if (kind === 'duplicate')
      vi.mocked(transport.payments).mockResolvedValue({
        data: [payment, payment],
        has_more: false,
      });
    if (kind === 'amount') charge.amount_captured = 1499;
    await expect(provision()).rejects.toThrow();
    noRights();
  });
  it.each(['owner', 'base', 'customer', 'deleted'])(
    'rolls back the entire projection when %s changes immediately before batch',
    async (kind) => {
      await prepare();
      beforeBatch = () => {
        beforeBatch = null;
        if (kind === 'owner')
          sql.exec("UPDATE organization_members SET role='member'");
        if (kind === 'base')
          sql.exec('UPDATE subscriptions SET entitlement_valid_until=0');
        if (kind === 'customer')
          sql.exec("UPDATE subscriptions SET customer_id='cus_changed'");
        if (kind === 'deleted')
          sql
            .prepare(
              'INSERT INTO account_session_policy(user_id,deleted_at) VALUES(?,?)',
            )
            .run(user.userId, now);
      };
      await expect(provision()).rejects.toThrow();
      noRights();
    },
  );
  it('preexisting preferences survive the paid handoff', async () => {
    await prepare();
    sql
      .prepare(
        "INSERT INTO automation_settings(organization_id,enabled,mode,flags,consent_version,consent_by,consent_at,updated_at) VALUES('automation-proof',1,'assist',?,'old','old',1,?)",
      )
      .run('["invoices"]', now);
    await provision();
    expect(
      sql
        .prepare(
          'SELECT enabled,mode,flags,consent_version FROM automation_settings',
        )
        .get(),
    ).toEqual({
      enabled: 1,
      mode: 'assist',
      flags: '["invoices"]',
      consent_version: AUTOMATION_CONSENT_VERSION,
    });
  });
  it('partial refund prevents first activation irreversibly even when a stale paid charge is replayed', async () => {
    await prepare();
    charge.amount_refunded = 1;
    await expect(provision()).rejects.toThrow();
    noRights();
    expect(count('automation_refunds')).toBe(1);
    charge.amount_refunded = 0;
    await expect(provision()).rejects.toThrow();
    noRights();
    expect(() => sql.exec('DELETE FROM automation_refunds')).toThrow();
    expect(() =>
      sql.exec('UPDATE automation_refunds SET verified_at=verified_at+1'),
    ).toThrow();
  });
  it('a refund tombstone closes access after handoff despite a stale active subscription', async () => {
    await prepare();
    await provision();
    await expect(rights()).resolves.toBe(true);
    sql
      .prepare(
        'INSERT INTO automation_refunds(invoice_id,customer_id,livemode,verified_at) VALUES(?,?,0,?)',
      )
      .run(invoice.id, 'cus_base_proof', now);
    await expect(rights()).resolves.toBe(false);
    await expect(provision()).resolves.toBe(false);
    await expect(rights()).resolves.toBe(false);
    expect(() =>
      sql.exec(
        'UPDATE stripe_automation_paid_projections SET paid_until=paid_until+1',
      ),
    ).toThrow();
    expect(() =>
      sql.exec('DELETE FROM stripe_automation_paid_projections'),
    ).toThrow();
  });
});
