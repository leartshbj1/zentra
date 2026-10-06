import type Stripe from 'stripe';
import { database } from '@/lib/runtime';
import { sha256 } from '@/lib/stripe';
import { stripeReferenceId } from '@/lib/stripe-event';
import { digest } from '@/lib/support/crypto';
import {
  SUPPORT_PRODUCT,
  supportPlan,
  type SupportPlanId,
} from '@/lib/support/plans';
import { SupportError } from '@/lib/support/types';
import { D1PurchaseIntents } from './purchase-intents';

type Database = Pick<D1Database, 'prepare' | 'batch'>;
type BillingConfiguration = {
  productId: string;
  prices: Record<SupportPlanId, string>;
  portalId: string;
  livemode: boolean;
  keyBinding: string;
};
type PaidPeriod = {
  plan: SupportPlanId;
  start: number;
  end: number;
  invoiceId: string;
} | null;
export type SupportSettlementTransport = {
  session(this: void, id: string): Promise<Stripe.Checkout.Session>;
  sessions(
    this: void,
    from: number,
    until: number,
  ): Promise<{ data: Stripe.Checkout.Session[]; has_more: boolean }>;
  payments(
    this: void,
    invoiceId: string,
  ): Promise<{ data: Stripe.InvoicePayment[]; has_more: boolean }>;
  paymentIntent(this: void, id: string): Promise<Stripe.PaymentIntent>;
  charge(this: void, id: string): Promise<Stripe.Charge>;
};
type RequestRow = {
  request_id: string;
  workspace_id: string;
  organization_id: string | null;
  owner_id: string;
  environment: 'TEST' | 'PRODUCTION';
  provider_scope: string;
  plan_id: SupportPlanId;
  parameters_json: string;
  legal_version: string;
  accepted_at: number;
  origin: string;
  intent_id: string | null;
  session_id: string | null;
  subscription_id: string | null;
  created_at: number;
  expires_at: number;
  closed_at: number | null;
};
const ref = (value: unknown) =>
  stripeReferenceId(value as string | { id: string } | null);
const invalid = () =>
  new SupportError(
    'Le paiement Support ne correspond pas à l’espace et à la formule choisis.',
    409,
  );
const unavailable = () =>
  new SupportError(
    'La confirmation du paiement Support doit être vérifiée. Aucun nouvel abonnement ne sera créé.',
    503,
  );

/** Bound positive cash evidence. PI status alone, a missing charge, incomplete
 * pagination and PaymentRecords never become a successful payment proof. */
export async function verifyStripeSupportCash(
  invoice: Stripe.Invoice,
  subscription: Stripe.Subscription,
  transport: Pick<
    SupportSettlementTransport,
    'payments' | 'paymentIntent' | 'charge'
  >,
) {
  const customerId = ref(subscription.customer),
    list = await transport.payments(invoice.id!);
  if (list.has_more || !list.data.length || list.data.length > 5)
    throw unavailable();
  const paymentIds = new Set<string>(),
    chargeIds = new Set<string>();
  let paid = 0,
    refunded = false;
  for (const payment of list.data) {
    if (
      !payment.id ||
      paymentIds.has(payment.id) ||
      payment.status !== 'paid' ||
      ref(payment.invoice) !== invoice.id ||
      payment.livemode !== invoice.livemode ||
      payment.currency !== 'chf' ||
      !Number.isSafeInteger(payment.amount_paid) ||
      (payment.amount_paid ?? 0) <= 0
    )
      throw invalid();
    paymentIds.add(payment.id);
    paid += payment.amount_paid!;
    let chargeId = '';
    if (payment.payment.type === 'charge')
      chargeId = ref(payment.payment.charge);
    else if (payment.payment.type === 'payment_intent') {
      const id = ref(payment.payment.payment_intent);
      if (!/^pi_[A-Za-z0-9_]+$/.test(id)) throw unavailable();
      const intent = await transport.paymentIntent(id);
      if (
        intent.id !== id ||
        intent.livemode !== invoice.livemode ||
        ref(intent.customer) !== customerId ||
        intent.currency !== 'chf' ||
        intent.status !== 'succeeded' ||
        intent.amount_received < payment.amount_paid!
      )
        throw invalid();
      chargeId = ref(intent.latest_charge);
    }
    if (!/^ch_[A-Za-z0-9_]+$/.test(chargeId) || chargeIds.has(chargeId))
      throw unavailable();
    chargeIds.add(chargeId);
    const charge = await transport.charge(chargeId);
    if (
      charge.id !== chargeId ||
      charge.livemode !== invoice.livemode ||
      ref(charge.customer) !== customerId ||
      charge.currency !== 'chf' ||
      !charge.paid ||
      !charge.captured ||
      charge.status !== 'succeeded' ||
      !Number.isSafeInteger(charge.amount_captured) ||
      charge.amount_captured < payment.amount_paid! ||
      !Number.isSafeInteger(charge.amount_refunded) ||
      charge.amount_refunded < 0 ||
      (payment.payment.type === 'payment_intent' &&
        ref(charge.payment_intent) !== ref(payment.payment.payment_intent))
    )
      throw invalid();
    if (charge.refunded || charge.amount_refunded > 0) refunded = true;
  }
  if (
    paid !== invoice.amount_paid ||
    paid <= 0 ||
    ref(invoice.customer) !== customerId ||
    invoice.livemode !== subscription.livemode
  )
    throw invalid();
  return {
    customerId,
    livemode: invoice.livemode,
    invoiceId: invoice.id!,
    refunded,
  };
}

/** Receives authoritative provider objects exclusively from the verified
 * webhook/account-refresh pipeline. It cannot be called by a browser route. */
export class D1StripeSupportProvisioning {
  constructor(
    private readonly db: Database,
    private readonly transport: SupportSettlementTransport,
    private readonly paidPeriod: (
      invoice: Stripe.Invoice,
      subscription: Stripe.Subscription,
      config: BillingConfiguration,
    ) => PaidPeriod,
    private readonly clock = () => Math.floor(Date.now() / 1000),
  ) {}
  async provision(
    subscription: Stripe.Subscription,
    invoice: Stripe.Invoice | null | undefined,
    config: BillingConfiguration,
    providerScope: string,
  ) {
    const requestId = subscription.metadata.support_request_id;
    if (!requestId) return false; // Unchanged historical subscriptions.
    const row = await this.db
      .prepare(
        'SELECT * FROM stripe_support_purchase_requests WHERE request_id=?',
      )
      .bind(requestId)
      .first<RequestRow>();
    if (
      !row ||
      row.owner_id !== subscription.metadata.owner_id ||
      row.workspace_id !== subscription.metadata.workspace_id ||
      row.environment !== (subscription.livemode ? 'PRODUCTION' : 'TEST') ||
      row.provider_scope !== providerScope ||
      subscription.metadata.service !== SUPPORT_PRODUCT ||
      config.livemode !== subscription.livemode
    )
      throw invalid();
    const intents = new D1PurchaseIntents(this.db, this.clock);
    if (!row.intent_id) throw unavailable();
    const intent = await this.db
      .prepare('SELECT * FROM purchase_intents WHERE intent_id=?')
      .bind(row.intent_id)
      .first<{
        intent_id: string;
        fingerprint: string;
        owner_id: string;
        environment: 'TEST' | 'PRODUCTION';
        provider: 'stripe';
        provider_scope: string;
      }>();
    if (!intent) throw unavailable();
    const binding = {
      intentId: intent.intent_id,
      fingerprint: intent.fingerprint,
      ownerId: row.owner_id,
      environment: row.environment,
      provider: 'stripe' as const,
      providerScope,
    };
    let current = await intents.read(binding);
    if (row.closed_at !== null) {
      if (
        current.state !== 'settled' ||
        row.subscription_id !== subscription.id ||
        row.session_id !== current.providerReference
      )
        throw invalid();
      // After first projection, renewals/plan changes use current configuration;
      // an old checkout snapshot must not constrain all future invoice prices.
      return false;
    }
    if (!['dispatched', 'uncertain', 'settled'].includes(current.state))
      throw invalid();
    if (!invoice || invoice.status !== 'paid') return true; // Never status-only projection.
    const parameters = JSON.parse(
      row.parameters_json,
    ) as Stripe.Checkout.SessionCreateParams;
    const priceId = parameters.line_items?.[0]?.price,
      plan = supportPlan(row.plan_id),
      item = subscription.items.data[0];
    if (
      !plan ||
      typeof priceId !== 'string' ||
      subscription.metadata.plan !== row.plan_id ||
      subscription.metadata.price_id !== priceId ||
      (subscription.metadata.organization_id ?? null) !== row.organization_id ||
      subscription.items.data.length !== 1 ||
      item.quantity !== 1 ||
      item.price.id !== priceId ||
      item.price.currency !== 'chf' ||
      item.price.unit_amount !== plan.priceChfCents ||
      !item.price.active ||
      item.price.livemode !== subscription.livemode ||
      item.price.type !== 'recurring' ||
      item.price.recurring?.interval !== 'month' ||
      item.price.recurring.interval_count !== 1 ||
      item.price.tax_behavior !== 'inclusive' ||
      item.price.metadata.service !== SUPPORT_PRODUCT ||
      item.price.metadata.plan !== row.plan_id ||
      ref(item.price.product) !== parameters.metadata?.product_id ||
      !['active', 'past_due'].includes(subscription.status) ||
      !/^sub_[A-Za-z0-9_]+$/.test(subscription.id) ||
      !/^cus_[A-Za-z0-9_]+$/.test(ref(subscription.customer))
    )
      throw invalid();
    const paid = this.paidPeriod(invoice, subscription, {
      ...config,
      prices: { ...config.prices, [row.plan_id]: priceId },
    });
    if (
      !paid ||
      paid.plan !== row.plan_id ||
      paid.invoiceId !== invoice.id ||
      paid.start < row.created_at - 300 ||
      paid.end <= this.clock() ||
      !Number.isSafeInteger(invoice.status_transitions.paid_at) ||
      invoice.status_transitions.paid_at! < row.created_at - 300 ||
      invoice.status_transitions.paid_at! > this.clock() + 60
    )
      throw invalid();
    let session: Stripe.Checkout.Session;
    if (row.session_id || current.providerReference)
      session = await this.transport.session(
        row.session_id ?? current.providerReference!,
      );
    else {
      const list = await this.transport.sessions(
        row.created_at - 60,
        row.expires_at + 60,
      );
      const matches = list.data.filter(
        (s) => s.metadata?.support_request_id === row.request_id,
      );
      if (list.has_more || matches.length !== 1) throw unavailable();
      session = matches[0];
    }
    if (
      session.mode !== 'subscription' ||
      session.status !== 'complete' ||
      session.payment_status !== 'paid' ||
      session.livemode !== subscription.livemode ||
      session.client_reference_id !== row.workspace_id ||
      session.expires_at !== row.expires_at ||
      session.metadata?.support_request_id !== row.request_id ||
      session.metadata.owner_id !== row.owner_id ||
      session.metadata.workspace_id !== row.workspace_id ||
      session.metadata.plan !== row.plan_id ||
      session.metadata.service !== SUPPORT_PRODUCT ||
      session.metadata.price_id !== priceId ||
      (session.metadata.organization_id ?? null) !== row.organization_id ||
      ref(session.subscription) !== subscription.id ||
      ref(session.customer) !== ref(subscription.customer) ||
      (row.session_id !== null && row.session_id !== session.id) ||
      (row.subscription_id !== null && row.subscription_id !== subscription.id)
    )
      throw invalid();
    const cash = await verifyStripeSupportCash(
      invoice,
      subscription,
      this.transport,
    );
    if (cash.refunded) {
      await this.db
        .prepare(
          'INSERT INTO support_refunds(invoice_id,customer_id,livemode,verified_at) VALUES(?,?,?,?) ON CONFLICT(invoice_id) DO NOTHING',
        )
        .bind(invoice.id!, cash.customerId, Number(cash.livemode), this.clock())
        .run();
      throw invalid();
    }
    if (
      await this.db
        .prepare(
          'SELECT 1 FROM support_refunds WHERE invoice_id=? AND customer_id=? AND livemode=?',
        )
        .bind(invoice.id!, cash.customerId, Number(cash.livemode))
        .first()
    )
      throw invalid();
    const verifiedAt = this.clock(),
      evidence = await digest(
        JSON.stringify([
          row.request_id,
          row.intent_id,
          row.owner_id,
          row.workspace_id,
          row.organization_id,
          row.environment,
          row.provider_scope,
          session.id,
          subscription.id,
          cash.customerId,
          priceId,
          paid.plan,
          invoice.id,
          paid.start,
          paid.end,
        ]),
      );
    try {
      current = await intents.bindProviderReference(current, session.id);
    } catch (error) {
      // Another verified webhook may have completed the atomic handoff between
      // this read and the bind. Only the same immutable positive proof is a replay.
      current = await intents.read(binding);
      if (
        current.state !== 'settled' ||
        current.providerReference !== session.id ||
        current.evidenceFingerprint !== evidence ||
        !(await this.db
          .prepare(
            'SELECT 1 FROM stripe_support_verified_paid_projections WHERE request_id=? AND intent_id=? AND evidence_fingerprint=? AND subscription_id=?',
          )
          .bind(row.request_id, current.intentId, evidence, subscription.id)
          .first())
      )
        throw error;
      return true;
    }
    await this.db.batch([
      this.db
        .prepare(
          'UPDATE stripe_support_purchase_requests SET session_id=?,subscription_id=? WHERE request_id=? AND (session_id IS NULL OR session_id=?) AND (subscription_id IS NULL OR subscription_id=?)',
        )
        .bind(
          session.id,
          subscription.id,
          row.request_id,
          session.id,
          subscription.id,
        ),
      this.db
        .prepare(
          'INSERT INTO support_checkout_acceptances(session_id,workspace_id,owner_id,plan_id,legal_version,accepted_at) VALUES(?,?,?,?,?,?) ON CONFLICT(session_id) DO NOTHING',
        )
        .bind(
          session.id,
          row.workspace_id,
          row.owner_id,
          row.plan_id,
          row.legal_version,
          row.accepted_at,
        ),
      this.db
        .prepare(
          'INSERT INTO legal_acceptances(acceptance_id,user_id,document_version,context,plan_id,checkout_session_id,origin,accepted_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(checkout_session_id) DO NOTHING',
        )
        .bind(
          crypto.randomUUID(),
          row.owner_id,
          row.legal_version,
          'support_checkout_requested',
          row.plan_id,
          session.id,
          row.origin,
          new Date(row.accepted_at * 1000).toISOString(),
        ),
      this.db
        .prepare(`INSERT INTO support_subscriptions(workspace_id,subscription_id,customer_id,plan_id,status,paid_from,paid_until,paid_plan_id,last_paid_invoice_id,cancel_at_period_end,livemode,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET subscription_id=excluded.subscription_id,customer_id=excluded.customer_id,plan_id=excluded.plan_id,status=excluded.status,
        paid_from=excluded.paid_from,paid_until=excluded.paid_until,paid_plan_id=excluded.paid_plan_id,last_paid_invoice_id=excluded.last_paid_invoice_id,cancel_at_period_end=excluded.cancel_at_period_end,livemode=excluded.livemode,updated_at=excluded.updated_at
        WHERE (support_subscriptions.subscription_id=excluded.subscription_id AND support_subscriptions.paid_until<=excluded.paid_until)
        OR (support_subscriptions.paid_until<=? AND support_subscriptions.status IN ('canceled','incomplete_expired'))`)
        .bind(
          row.workspace_id,
          subscription.id,
          cash.customerId,
          paid.plan,
          subscription.status,
          paid.start,
          paid.end,
          paid.plan,
          invoice.id!,
          Number(subscription.cancel_at_period_end),
          Number(subscription.livemode),
          verifiedAt,
          verifiedAt,
        ),
      this.db
        .prepare(`INSERT INTO stripe_support_paid_projections(request_id,intent_id,owner_id,workspace_id,organization_id,environment,provider_scope,session_id,subscription_id,customer_id,price_id,plan_id,invoice_id,paid_from,paid_until,evidence_fingerprint,verified_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(request_id) DO NOTHING`)
        .bind(
          row.request_id,
          current.intentId,
          row.owner_id,
          row.workspace_id,
          row.organization_id,
          row.environment,
          row.provider_scope,
          session.id,
          subscription.id,
          cash.customerId,
          priceId,
          paid.plan,
          invoice.id!,
          paid.start,
          paid.end,
          evidence,
          verifiedAt,
        ),
      this.db
        .prepare(`UPDATE purchase_intents SET state='settled',evidence_fingerprint=?,finalized_at=? WHERE intent_id=? AND fingerprint=? AND provider_reference=? AND state IN ('dispatched','uncertain')
        AND EXISTS(SELECT 1 FROM stripe_support_verified_paid_projections p WHERE p.intent_id=purchase_intents.intent_id AND p.evidence_fingerprint=?)`)
        .bind(
          evidence,
          verifiedAt,
          current.intentId,
          current.fingerprint,
          session.id,
          evidence,
        ),
      this.db
        .prepare(`UPDATE purchase_intent_footprints SET released_at=? WHERE intent_id=? AND released_at IS NULL
        AND EXISTS(SELECT 1 FROM purchase_intents i JOIN stripe_support_verified_paid_projections p ON p.intent_id=i.intent_id AND p.evidence_fingerprint=i.evidence_fingerprint
        WHERE i.intent_id=? AND i.state='settled' AND i.finalized_at=?)`)
        .bind(verifiedAt, current.intentId, current.intentId, verifiedAt),
      this.db
        .prepare(`UPDATE stripe_support_purchase_requests SET closed_at=? WHERE request_id=? AND closed_at IS NULL
        AND EXISTS(SELECT 1 FROM purchase_intents i WHERE i.intent_id=stripe_support_purchase_requests.intent_id AND i.state='settled' AND i.evidence_fingerprint=?)`)
        .bind(verifiedAt, row.request_id, evidence),
    ]);
    const finalized = await intents.read(current);
    if (
      finalized.state !== 'settled' ||
      finalized.evidenceFingerprint !== evidence
    )
      throw unavailable();
    return true;
  }
}

export async function provisionStripeSupportPurchase(
  subscription: Stripe.Subscription,
  invoice: Stripe.Invoice | null | undefined,
  config: BillingConfiguration,
  stripe: Stripe,
  secretKey: string,
) {
  const { paidSupportPeriod } = await import('@/lib/support/billing');
  return new D1StripeSupportProvisioning(
    database(),
    {
      session: (id) => stripe.checkout.sessions.retrieve(id),
      sessions: (from, until) =>
        stripe.checkout.sessions.list({
          created: { gte: from, lte: until },
          limit: 100,
        }),
      payments: (invoiceId) =>
        stripe.invoicePayments.list({
          invoice: invoiceId,
          status: 'paid',
          limit: 5,
        }),
      paymentIntent: (id) => stripe.paymentIntents.retrieve(id),
      charge: (id) => stripe.charges.retrieve(id),
    },
    paidSupportPeriod,
  ).provision(
    subscription,
    invoice,
    config,
    'stripe_key_' + (await sha256(secretKey)),
  );
}
