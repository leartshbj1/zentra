import type Stripe from 'stripe';
import { database } from '@/lib/runtime';
import { sha256 } from '@/lib/stripe';
import { stripeReferenceId } from '@/lib/stripe-event';
import { AccountPublicError } from '@/lib/account-security';
import { digest } from '@/lib/support/crypto';
import { SupportError } from '@/lib/support/types';
import {
  AUTOMATION_PRICE_CENTS,
  AUTOMATION_PRODUCT,
} from '@/lib/automation/types';
import {
  verifyStripeSupportCash,
  type SupportSettlementTransport,
} from './stripe-support-provisioning';
import { D1PurchaseIntents } from './purchase-intents';
import type { AutomationRequestRow } from './stripe-automation-purchase';

type Database = Pick<D1Database, 'prepare' | 'batch'>;
type Config = {
  productId: string;
  priceId: string;
  portalId: string;
  livemode: boolean;
  keyBinding: string;
  automaticTax?: boolean;
};
type Period = { start: number; end: number; invoiceId: string } | null;
export type AutomationSettlementTransport = SupportSettlementTransport;
const ref = (v: unknown) =>
  stripeReferenceId(v as string | { id: string } | null);
const invalid = () =>
  new AccountPublicError(
    'Ce paiement Automation ne correspond pas à votre entreprise et à son abonnement Gestion.',
    409,
  );
const unavailable = () =>
  new AccountPublicError(
    'La confirmation de ce paiement doit être vérifiée. Aucun second abonnement ne sera créé.',
    503,
  );
export async function verifyStripeAutomationCash(
  invoice: Stripe.Invoice,
  subscription: Stripe.Subscription,
  transport: Pick<
    AutomationSettlementTransport,
    'payments' | 'paymentIntent' | 'charge'
  >,
) {
  try {
    return await verifyStripeSupportCash(invoice, subscription, transport);
  } catch (error) {
    if (error instanceof SupportError)
      throw new AccountPublicError(
        error.status === 409
          ? 'Le paiement Automation ne correspond pas à cette entreprise.'
          : 'La confirmation du paiement Automation doit être vérifiée. Aucun second abonnement ne sera créé.',
        error.status,
      );
    throw error;
  }
}
/** Internal verified provider pipeline only. A browser refresh may revoke, but
 * cannot manufacture the signature-verified webhook's first paid period. */
export class D1StripeAutomationProvisioning {
  constructor(
    private readonly db: Database,
    private readonly transport: AutomationSettlementTransport,
    private readonly period: (
      invoice: Stripe.Invoice,
      subscription: Stripe.Subscription,
      config: Config,
    ) => Period,
    private readonly clock = () => Math.floor(Date.now() / 1000),
  ) {}
  async provision(
    subscription: Stripe.Subscription,
    invoice: Stripe.Invoice | null | undefined,
    config: Config,
    scope: string,
    source: 'verified_webhook' | 'account_refresh',
  ) {
    const id = subscription.metadata.automation_request_id;
    if (!id) return false;
    const row = await this.db
      .prepare(
        'SELECT * FROM stripe_automation_purchase_requests WHERE request_id=?',
      )
      .bind(id)
      .first<AutomationRequestRow>();
    if (
      !row ||
      row.owner_id !== subscription.metadata.owner_id ||
      row.organization_id !== subscription.metadata.organization_id ||
      row.environment !== (subscription.livemode ? 'PRODUCTION' : 'TEST') ||
      row.provider_scope !== scope ||
      subscription.metadata.service !== AUTOMATION_PRODUCT ||
      config.livemode !== subscription.livemode
    )
      throw invalid();
    if (!row.intent_id) throw unavailable();
    const i = await this.db
      .prepare(
        'SELECT intent_id,fingerprint FROM purchase_intents WHERE intent_id=?',
      )
      .bind(row.intent_id)
      .first<{ intent_id: string; fingerprint: string }>();
    if (!i) throw unavailable();
    const binding = {
        intentId: i.intent_id,
        fingerprint: i.fingerprint,
        ownerId: row.owner_id,
        environment: row.environment,
        provider: 'stripe' as const,
        providerScope: scope,
      },
      ledger = new D1PurchaseIntents(this.db, this.clock);
    let current = await ledger.read(binding);
    if (row.closed_at !== null) {
      if (
        current.state !== 'settled' ||
        row.subscription_id !== subscription.id ||
        row.session_id !== current.providerReference
      )
        throw invalid();
      return false;
    }
    if (!['dispatched', 'uncertain', 'settled'].includes(current.state))
      throw invalid();
    if (!invoice || invoice.status !== 'paid') return true;
    const p = JSON.parse(
        row.parameters_json,
      ) as Stripe.Checkout.SessionCreateParams,
      priceId = p.line_items?.[0]?.price,
      item = subscription.items.data[0];
    if (
      typeof priceId !== 'string' ||
      subscription.metadata.price_id !== priceId ||
      subscription.metadata.base_subscription_id !== row.base_subscription_id ||
      subscription.metadata.consent_version !== row.consent_version ||
      ref(subscription.customer) !== row.base_customer_id ||
      subscription.items.data.length !== 1 ||
      item.quantity !== 1 ||
      item.price.id !== priceId ||
      !item.price.active ||
      item.price.currency !== 'chf' ||
      item.price.unit_amount !== AUTOMATION_PRICE_CENTS ||
      item.price.livemode !== subscription.livemode ||
      item.price.type !== 'recurring' ||
      item.price.recurring?.interval !== 'month' ||
      item.price.recurring.interval_count !== 1 ||
      item.price.recurring.usage_type !== 'licensed' ||
      item.price.tax_behavior !== 'inclusive' ||
      item.price.metadata.service !== AUTOMATION_PRODUCT ||
      ref(item.price.product) !== p.metadata?.product_id ||
      !['active', 'past_due'].includes(subscription.status)
    )
      throw invalid();
    const paid = this.period(invoice, subscription, {
      ...config,
      priceId,
      productId: p.metadata!.product_id!,
      automaticTax: p.automatic_tax?.enabled === true,
    });
    if (
      !paid ||
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
      const l = await this.transport.sessions(
          row.created_at - 60,
          row.expires_at + 60,
        ),
        matches = l.data.filter(
          (s) => s.metadata?.automation_request_id === row.request_id,
        );
      if (l.has_more || matches.length !== 1) throw unavailable();
      session = matches[0];
    }
    if (
      session.mode !== 'subscription' ||
      session.status !== 'complete' ||
      session.payment_status !== 'paid' ||
      session.livemode !== subscription.livemode ||
      session.client_reference_id !== row.organization_id ||
      session.expires_at !== row.expires_at ||
      session.metadata?.automation_request_id !== row.request_id ||
      session.metadata.owner_id !== row.owner_id ||
      session.metadata.organization_id !== row.organization_id ||
      session.metadata.service !== AUTOMATION_PRODUCT ||
      session.metadata.price_id !== priceId ||
      session.metadata.base_subscription_id !== row.base_subscription_id ||
      ref(session.subscription) !== subscription.id ||
      ref(session.customer) !== row.base_customer_id ||
      (row.session_id !== null && row.session_id !== session.id) ||
      (row.subscription_id !== null && row.subscription_id !== subscription.id)
    )
      throw invalid();
    const cash = await verifyStripeAutomationCash(
      invoice,
      subscription,
      this.transport,
    );
    if (cash.refunded)
      await this.db
        .prepare(
          'INSERT INTO automation_refunds(invoice_id,customer_id,livemode,verified_at) VALUES(?,?,?,?) ON CONFLICT(invoice_id) DO NOTHING',
        )
        .bind(invoice.id!, cash.customerId, Number(cash.livemode), this.clock())
        .run();
    if (
      cash.refunded ||
      (await this.db
        .prepare(
          'SELECT 1 FROM automation_refunds WHERE invoice_id=? AND customer_id=? AND livemode=?',
        )
        .bind(invoice.id!, cash.customerId, Number(cash.livemode))
        .first())
    )
      throw invalid();
    if (source !== 'verified_webhook') return true; // No first-period grant from a receipt/refresh.
    const verifiedAt = this.clock(),
      evidence = await digest(
        JSON.stringify([
          row.request_id,
          row.intent_id,
          row.owner_id,
          row.organization_id,
          row.base_subscription_id,
          row.base_customer_id,
          row.environment,
          row.provider_scope,
          session.id,
          subscription.id,
          cash.customerId,
          priceId,
          invoice.id,
          paid.start,
          paid.end,
          row.consent_version,
        ]),
      );
    try {
      current = await ledger.bindProviderReference(current, session.id);
    } catch (e) {
      current = await ledger.read(binding);
      if (
        current.state !== 'settled' ||
        current.providerReference !== session.id ||
        current.evidenceFingerprint !== evidence ||
        !(await this.db
          .prepare(
            'SELECT 1 FROM stripe_automation_verified_paid_projections WHERE request_id=? AND evidence_fingerprint=? AND subscription_id=?',
          )
          .bind(row.request_id, evidence, subscription.id)
          .first())
      )
        throw e;
      return true;
    }
    await this.db.batch([
      this.db
        .prepare(
          'UPDATE stripe_automation_purchase_requests SET session_id=?,subscription_id=? WHERE request_id=? AND (session_id IS NULL OR session_id=?) AND (subscription_id IS NULL OR subscription_id=?)',
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
          'INSERT INTO legal_acceptances(acceptance_id,user_id,document_version,context,plan_id,checkout_session_id,origin,accepted_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(checkout_session_id) DO NOTHING',
        )
        .bind(
          crypto.randomUUID(),
          row.owner_id,
          row.legal_version,
          'automation_checkout',
          AUTOMATION_PRODUCT,
          session.id,
          row.origin,
          new Date(row.accepted_at * 1000).toISOString(),
        ),
      this.db
        .prepare(`INSERT INTO automation_subscriptions(organization_id,subscription_id,customer_id,status,paid_from,paid_until,last_paid_invoice_id,cancel_at_period_end,livemode,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(organization_id) DO UPDATE SET subscription_id=excluded.subscription_id,customer_id=excluded.customer_id,status=excluded.status,paid_from=excluded.paid_from,paid_until=excluded.paid_until,last_paid_invoice_id=excluded.last_paid_invoice_id,cancel_at_period_end=excluded.cancel_at_period_end,livemode=excluded.livemode,updated_at=excluded.updated_at
    WHERE (automation_subscriptions.subscription_id=excluded.subscription_id AND automation_subscriptions.paid_until<=excluded.paid_until) OR (automation_subscriptions.paid_until<=? AND automation_subscriptions.status IN ('canceled','incomplete_expired'))`)
        .bind(
          row.organization_id,
          subscription.id,
          cash.customerId,
          subscription.status,
          paid.start,
          paid.end,
          invoice.id!,
          Number(subscription.cancel_at_period_end),
          Number(subscription.livemode),
          verifiedAt,
          verifiedAt,
        ),
      this.db
        .prepare(
          `INSERT INTO stripe_automation_paid_projections(request_id,intent_id,owner_id,organization_id,environment,provider_scope,session_id,subscription_id,customer_id,price_id,base_subscription_id,base_customer_id,invoice_id,paid_from,paid_until,evidence_fingerprint,verified_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(request_id) DO NOTHING`,
        )
        .bind(
          row.request_id,
          current.intentId,
          row.owner_id,
          row.organization_id,
          row.environment,
          row.provider_scope,
          session.id,
          subscription.id,
          cash.customerId,
          priceId,
          row.base_subscription_id,
          row.base_customer_id,
          invoice.id!,
          paid.start,
          paid.end,
          evidence,
          verifiedAt,
        ),
      this.db
        .prepare(`UPDATE purchase_intents SET state='settled',evidence_fingerprint=?,finalized_at=? WHERE intent_id=? AND fingerprint=? AND provider_reference=? AND state IN ('dispatched','uncertain')
    AND EXISTS(SELECT 1 FROM stripe_automation_verified_paid_projections p WHERE p.intent_id=purchase_intents.intent_id AND p.evidence_fingerprint=?)`)
        .bind(
          evidence,
          verifiedAt,
          current.intentId,
          current.fingerprint,
          session.id,
          evidence,
        ),
      this.db
        .prepare(
          `UPDATE purchase_intent_footprints SET released_at=? WHERE intent_id=? AND released_at IS NULL AND EXISTS(SELECT 1 FROM purchase_intents i JOIN stripe_automation_verified_paid_projections p ON p.intent_id=i.intent_id AND p.evidence_fingerprint=i.evidence_fingerprint WHERE i.intent_id=? AND i.state='settled' AND i.finalized_at=?)`,
        )
        .bind(verifiedAt, current.intentId, current.intentId, verifiedAt),
      this.db
        .prepare(
          `UPDATE stripe_automation_purchase_requests SET closed_at=? WHERE request_id=? AND closed_at IS NULL AND EXISTS(SELECT 1 FROM purchase_intents i WHERE i.intent_id=stripe_automation_purchase_requests.intent_id AND i.state='settled' AND i.evidence_fingerprint=?)`,
        )
        .bind(verifiedAt, row.request_id, evidence),
      this.db
        .prepare(
          `INSERT INTO automation_settings(organization_id,enabled,mode,flags,consent_version,consent_by,consent_at,updated_at) VALUES(?,0,'shadow','[]',?,?,?,?) ON CONFLICT(organization_id) DO UPDATE SET consent_version=excluded.consent_version,consent_by=excluded.consent_by,consent_at=excluded.consent_at`,
        )
        .bind(
          row.organization_id,
          row.consent_version,
          row.owner_id,
          row.accepted_at,
          verifiedAt,
        ),
    ]);
    const final = await ledger.read(current);
    if (final.state !== 'settled' || final.evidenceFingerprint !== evidence)
      throw unavailable();
    return true;
  }
}
export async function provisionStripeAutomationPurchase(
  subscription: Stripe.Subscription,
  invoice: Stripe.Invoice | null,
  config: Config,
  stripe: Stripe,
  key: string,
  source: 'verified_webhook' | 'account_refresh',
) {
  const { paidAutomationPeriod } = await import('@/lib/automation/billing');
  return new D1StripeAutomationProvisioning(
    database(),
    {
      session: (id) => stripe.checkout.sessions.retrieve(id),
      sessions: (from, to) =>
        stripe.checkout.sessions.list({
          created: { gte: from, lte: to },
          limit: 100,
        }),
      payments: (id) =>
        stripe.invoicePayments.list({ invoice: id, status: 'paid', limit: 5 }),
      paymentIntent: (id) => stripe.paymentIntents.retrieve(id),
      charge: (id) => stripe.charges.retrieve(id),
    },
    paidAutomationPeriod,
  ).provision(
    subscription,
    invoice,
    config,
    'stripe_key_' + (await sha256(key)),
    source,
  );
}
