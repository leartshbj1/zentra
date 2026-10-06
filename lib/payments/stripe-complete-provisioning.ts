import { digest } from '@/lib/support/crypto';
import type Stripe from 'stripe';
import { database } from '@/lib/runtime';
import { PublicError, sha256 } from '@/lib/stripe';
import {
  stripeReferenceId,
  paidThroughFromInvoice,
  stripeSecretKeyLivemode,
} from '@/lib/stripe-event';
import { UPSERT_SUBSCRIPTION_SQL } from '@/lib/stripe-sql';
import { UPSERT_COMPLETE_SQL } from '@/lib/complete/access';
import { COMPLETE_PRODUCT, completePlan } from '@/lib/complete/plans';
import { D1PurchaseIntents } from './purchase-intents';
import {
  verifyStripeSupportCash,
  type SupportSettlementTransport,
} from './stripe-support-provisioning';
import {
  STRIPE_COMPLETE_CATALOG_VERSION,
  type StripeCompleteRequest,
} from './stripe-complete-purchase';
type Database = Pick<D1Database, 'prepare' | 'batch'>;
const unavailable = () =>
  new PublicError(
    'Le paiement Complet est encore en cours de vérification.',
    402,
  );
const invalid = () =>
  new PublicError(
    'La preuve de paiement ne correspond pas à votre entreprise.',
    403,
  );
const ref = (v: unknown) =>
  stripeReferenceId(v as string | { id: string } | null);
export class D1StripeCompleteProvisioning {
  constructor(
    private readonly db: Database,
    private readonly transport: SupportSettlementTransport,
    private readonly clock = () => Math.floor(Date.now() / 1000),
  ) {}
  async provision(
    subscription: Stripe.Subscription,
    invoice: Stripe.Invoice | null | undefined,
    providerScope: string,
    expectedLivemode: boolean,
  ) {
    const requestId = subscription.metadata.complete_request_id;
    if (!requestId) return false;
    const row = await this.db
      .prepare(
        'SELECT * FROM stripe_complete_purchase_requests WHERE request_id=?',
      )
      .bind(requestId)
      .first<StripeCompleteRequest>();
    if (
      !row ||
      row.provider_scope !== providerScope ||
      row.environment !== (expectedLivemode ? 'PRODUCTION' : 'TEST') ||
      !row.intent_id ||
      subscription.livemode !== expectedLivemode ||
      subscription.metadata.service !== COMPLETE_PRODUCT ||
      subscription.metadata.account_user_id !== row.owner_id ||
      subscription.metadata.organization_id !== row.organization_id ||
      subscription.metadata.workspace_id !== row.workspace_id ||
      subscription.metadata.bundle_plan !== row.plan_id ||
      subscription.metadata.catalog_version !== STRIPE_COMPLETE_CATALOG_VERSION
    )
      throw invalid();
    const intents = new D1PurchaseIntents(this.db, this.clock),
      binding = {
        intentId: row.intent_id,
        ownerId: row.owner_id,
        environment: row.environment,
        provider: 'stripe' as const,
        providerScope: row.provider_scope,
      };
    const intent = await this.db
      .prepare('SELECT fingerprint FROM purchase_intents WHERE intent_id=?')
      .bind(row.intent_id)
      .first<{ fingerprint: string }>();
    if (!intent) throw invalid();
    let current = await intents.read({
      ...binding,
      fingerprint: intent.fingerprint,
    });
    if (row.closed_at !== null) {
      if (
        current.state !== 'settled' ||
        row.subscription_id !== subscription.id ||
        !(await this.db
          .prepare(
            'SELECT 1 FROM stripe_complete_closed_paid_projections WHERE request_id=? AND subscription_id=?',
          )
          .bind(row.request_id, subscription.id)
          .first())
      )
        throw invalid();
      return false; // Historical initial snapshot cannot override later paid cycles/plan changes.
    }
    if (!['dispatched', 'uncertain', 'settled'].includes(current.state))
      throw invalid();
    if (!invoice || invoice.status !== 'paid') return true; // Intercept status-only updates before legacy caches.
    const plan = completePlan(row.plan_id),
      catalog = JSON.parse(row.catalog_json),
      params = JSON.parse(
        row.parameters_json,
      ) as Stripe.Checkout.SessionCreateParams;
    const item = subscription.items.data[0],
      price = item?.price;
    if (
      !plan ||
      catalog.version !== STRIPE_COMPLETE_CATALOG_VERSION ||
      catalog.planId !== row.plan_id ||
      !item ||
      subscription.items.has_more ||
      subscription.items.data.length !== 1 ||
      item.quantity !== 1 ||
      subscription.metadata.plan !== catalog.licensePlan ||
      subscription.metadata.price_id !== catalog.priceId ||
      subscription.metadata.plan !== params.metadata?.plan ||
      !/^sub_[A-Za-z0-9_]+$/.test(subscription.id) ||
      !/^cus_[A-Za-z0-9_]+$/.test(ref(subscription.customer)) ||
      !['active', 'past_due'].includes(subscription.status) ||
      price.id !== catalog.priceId ||
      ref(price.product) !== catalog.productId ||
      price.livemode !== expectedLivemode ||
      price.currency !== 'chf' ||
      price.unit_amount !== catalog.priceChfCents ||
      price.tax_behavior !== 'inclusive' ||
      price.recurring?.interval !== 'month' ||
      price.recurring.interval_count !== 1 ||
      price.recurring.usage_type !== 'licensed' ||
      price.metadata.service !== COMPLETE_PRODUCT ||
      price.metadata.bundle_plan !== row.plan_id ||
      price.lookup_key !== catalog.lookupKey ||
      subscription.automatic_tax.enabled !== params.automatic_tax?.enabled
    )
      throw invalid();
    const end = paidThroughFromInvoice(invoice, {
      subscriptionId: subscription.id,
      priceId: catalog.priceId,
      unitAmount: catalog.priceChfCents,
      livemode: expectedLivemode,
      automaticTaxRequired: params.automatic_tax?.enabled !== false,
      authorizedDiscountCents: 0,
    });
    const line = invoice.lines.data.find(
        (l) =>
          ref(l.pricing?.price_details?.price) === catalog.priceId &&
          l.period.end === end,
      ),
      start = line?.period.start,
      paidAt = invoice.status_transitions.paid_at;
    if (
      !end ||
      !start ||
      !Number.isSafeInteger(paidAt) ||
      !paidAt ||
      invoice.billing_reason !== 'subscription_create' ||
      invoice.amount_remaining !== 0 ||
      invoice.amount_paid !== invoice.total ||
      start < row.created_at - 300 ||
      start > this.clock() ||
      end <= this.clock() ||
      paidAt < row.created_at - 300 ||
      paidAt > this.clock() ||
      item.current_period_end !== end
    )
      throw unavailable();
    let session: Stripe.Checkout.Session;
    if (row.session_id || current.providerReference)
      session = await this.transport.session(
        row.session_id ?? current.providerReference!,
      );
    else {
      const list = await this.transport.sessions(
          row.created_at - 60,
          row.expires_at + 60,
        ),
        matches = list.data.filter(
          (s) => s.metadata?.complete_request_id === row.request_id,
        );
      if (list.has_more || matches.length !== 1) throw unavailable();
      session = matches[0];
    }
    if (
      session.mode !== 'subscription' ||
      session.status !== 'complete' ||
      session.payment_status !== 'paid' ||
      session.livemode !== expectedLivemode ||
      session.client_reference_id !== row.claim_hash ||
      session.expires_at !== row.expires_at ||
      session.metadata?.complete_request_id !== row.request_id ||
      session.metadata.account_user_id !== row.owner_id ||
      session.metadata.organization_id !== row.organization_id ||
      session.metadata.workspace_id !== row.workspace_id ||
      session.metadata.activation_claim_hash !== row.claim_hash ||
      session.metadata.bundle_plan !== row.plan_id ||
      session.metadata.service !== COMPLETE_PRODUCT ||
      session.metadata.price_id !== catalog.priceId ||
      session.metadata.plan !== catalog.licensePlan ||
      ref(session.subscription) !== subscription.id ||
      ref(session.customer) !== ref(subscription.customer) ||
      (row.session_id && row.session_id !== session.id) ||
      (row.subscription_id && row.subscription_id !== subscription.id)
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
          'INSERT INTO complete_refunds(invoice_id,customer_id,livemode,verified_at) VALUES(?,?,?,?) ON CONFLICT(invoice_id) DO NOTHING',
        )
        .bind(
          invoice.id!,
          cash.customerId,
          Number(expectedLivemode),
          this.clock(),
        )
        .run();
      throw invalid();
    }
    if (
      await this.db
        .prepare(
          'SELECT 1 FROM complete_refunds WHERE invoice_id=? AND customer_id=? AND livemode=?',
        )
        .bind(invoice.id!, cash.customerId, Number(expectedLivemode))
        .first()
    )
      throw invalid();
    const now = this.clock(),
      evidence = await digest(
        JSON.stringify([
          'stripe-complete-initial-handoff-v1',
          row.request_id,
          row.intent_id,
          row.owner_id,
          row.organization_id,
          row.workspace_id,
          row.previous_subscription_id,
          row.trial_subscription_id,
          row.environment,
          row.provider_scope,
          row.catalog_json,
          session.id,
          subscription.id,
          cash.customerId,
          invoice.id,
          start,
          end,
          paidAt,
        ]),
      );
    const alreadyClosed = async () => {
      const completed = await intents.read({
        ...binding,
        fingerprint: intent.fingerprint,
      });
      return (
        completed.state === 'settled' &&
        completed.providerReference === session.id &&
        completed.evidenceFingerprint === evidence &&
        !!(await this.db
          .prepare(
            'SELECT 1 FROM stripe_complete_closed_paid_projections WHERE request_id=? AND subscription_id=? AND evidence_fingerprint=?',
          )
          .bind(row.request_id, subscription.id, evidence)
          .first())
      );
    };
    try {
      current = await intents.bindProviderReference(current, session.id);
    } catch (error) {
      if (!(await alreadyClosed())) throw error;
      return true;
    }
    // Every mutable product projection is in the SAME transaction as its immutable
    // cash evidence, target CAS, finalization and four footprint releases. A failed
    // guard rolls all writes back; no partial cache can activate another product.
    try {
      await this.db.batch([
        this.db
          .prepare(
            'UPDATE stripe_complete_purchase_requests SET session_id=?,subscription_id=? WHERE request_id=? AND (session_id IS NULL OR session_id=?) AND (subscription_id IS NULL OR subscription_id=?)',
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
            'INSERT INTO checkout_attempts(claim_hash,checkout_session_id,created_at,expires_at,account_user_id,account_email,account_name) VALUES(?,?,?,?,?,?,?) ON CONFLICT(checkout_session_id) DO NOTHING',
          )
          .bind(
            row.claim_hash,
            session.id,
            row.created_at,
            row.created_at + 365 * 86400,
            row.owner_id,
            row.account_email,
            row.account_name,
          ),
        this.db
          .prepare(
            'INSERT INTO legal_acceptances(acceptance_id,user_id,document_version,context,plan_id,checkout_session_id,origin,accepted_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(checkout_session_id) DO NOTHING',
          )
          .bind(
            crypto.randomUUID(),
            row.owner_id,
            row.legal_version,
            'complete_checkout_requested',
            row.plan_id,
            session.id,
            row.origin,
            new Date(row.created_at * 1000).toISOString(),
          ),
        this.db
          .prepare(
            'INSERT INTO stripe_complete_paid_projections(request_id,intent_id,owner_id,organization_id,workspace_id,previous_subscription_id,environment,provider_scope,session_id,subscription_id,customer_id,price_id,plan_id,invoice_id,paid_from,paid_until,paid_at,evidence_fingerprint,verified_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(request_id) DO NOTHING',
          )
          .bind(
            row.request_id,
            row.intent_id,
            row.owner_id,
            row.organization_id,
            row.workspace_id,
            row.previous_subscription_id,
            row.environment,
            row.provider_scope,
            session.id,
            subscription.id,
            cash.customerId,
            catalog.priceId,
            row.plan_id,
            invoice.id!,
            start,
            end,
            paidAt,
            evidence,
            now,
          ),
        this.db
          .prepare(UPSERT_SUBSCRIPTION_SQL)
          .bind(
            subscription.id,
            cash.customerId,
            session.id,
            row.account_email,
            session.customer_details?.business_name ??
              session.customer_details?.name ??
              row.account_name,
            catalog.priceId,
            subscription.status,
            end,
            Number(subscription.cancel_at_period_end),
            Number(expectedLivemode),
            end,
            invoice.id!,
            paidAt,
            null,
            null,
            now,
            catalog.licensePlan,
            catalog.licensePlan,
            catalog.seats,
          ),
        this.db
          .prepare(UPSERT_COMPLETE_SQL)
          .bind(
            subscription.id,
            row.plan_id,
            row.plan_id,
            start,
            end,
            invoice.id!,
          ),
        this.db
          .prepare(
            `UPDATE organizations SET subscription_id=?,updated_at=? WHERE organization_id=? AND created_by_user_id=? AND subscription_id=? AND EXISTS(SELECT 1 FROM stripe_complete_paid_projections p WHERE p.request_id=? AND p.evidence_fingerprint=?)`,
          )
          .bind(
            subscription.id,
            now,
            row.organization_id,
            row.owner_id,
            row.previous_subscription_id,
            row.request_id,
            evidence,
          ),
        this.db
          .prepare(
            `INSERT INTO support_gestion_links(workspace_id,organization_id,enabled,auto_post,connected_by,created_at) SELECT ?,?,1,0,?,? WHERE NOT EXISTS(SELECT 1 FROM support_gestion_links WHERE workspace_id=? OR organization_id=?) ON CONFLICT DO NOTHING`,
          )
          .bind(
            row.workspace_id,
            row.organization_id,
            row.owner_id,
            now,
            row.workspace_id,
            row.organization_id,
          ),
        this.db
          .prepare(
            `UPDATE account_trials SET converted_subscription_id=? WHERE user_id=? AND organization_id=? AND subscription_id=? AND converted_subscription_id IS NULL AND EXISTS(SELECT 1 FROM stripe_complete_verified_paid_projections WHERE request_id=? AND evidence_fingerprint=?)`,
          )
          .bind(
            subscription.id,
            row.owner_id,
            row.organization_id,
            row.trial_subscription_id ?? '',
            row.request_id,
            evidence,
          ),
        this.db
          .prepare(
            `UPDATE license_activations SET subscription_id=? WHERE subscription_id=? AND EXISTS(SELECT 1 FROM stripe_complete_verified_paid_projections WHERE request_id=? AND evidence_fingerprint=?)`,
          )
          .bind(
            subscription.id,
            row.previous_subscription_id,
            row.request_id,
            evidence,
          ),
        this.db
          .prepare(
            `UPDATE purchase_intents SET state='settled',evidence_fingerprint=?,finalized_at=? WHERE intent_id=? AND fingerprint=? AND provider_reference=? AND state IN ('dispatched','uncertain')`,
          )
          .bind(
            evidence,
            now,
            current.intentId,
            current.fingerprint,
            session.id,
          ),
        this.db
          .prepare(
            `UPDATE purchase_intent_footprints SET released_at=? WHERE intent_id=? AND released_at IS NULL AND EXISTS(SELECT 1 FROM purchase_intents i JOIN stripe_complete_verified_paid_projections p ON p.intent_id=i.intent_id AND p.evidence_fingerprint=i.evidence_fingerprint WHERE i.intent_id=? AND i.state='settled' AND i.finalized_at=?)`,
          )
          .bind(now, row.intent_id, row.intent_id, now),
        this.db
          .prepare(
            `UPDATE stripe_complete_purchase_requests SET closed_at=? WHERE request_id=? AND closed_at IS NULL AND EXISTS(SELECT 1 FROM purchase_intents i WHERE i.intent_id=stripe_complete_purchase_requests.intent_id AND i.state='settled' AND i.evidence_fingerprint=? AND NOT EXISTS(SELECT 1 FROM purchase_intent_footprints f WHERE f.intent_id=i.intent_id AND f.released_at IS NULL))`,
          )
          .bind(now, row.request_id, evidence),
      ]);
    } catch (error) {
      // A concurrent verifier can finish after our last read but before this
      // batch. Its BEFORE INSERT guard correctly refuses our stale target;
      // accept only its exact durable, closed cash handoff, without new writes.
      if (!(await alreadyClosed())) throw error;
      return true;
    }
    if (
      !(await this.db
        .prepare(
          'SELECT 1 FROM stripe_complete_closed_paid_projections WHERE request_id=? AND evidence_fingerprint=?',
        )
        .bind(row.request_id, evidence)
        .first())
    )
      throw unavailable();
    return true;
  }
}
export async function provisionStripeCompletePurchase(
  subscription: Stripe.Subscription,
  invoice: Stripe.Invoice | null | undefined,
  stripe: Stripe,
  secretKey: string,
  _session?: Stripe.Checkout.Session | null,
) {
  const live = stripeSecretKeyLivemode(secretKey);
  if (live === null) throw invalid();
  return new D1StripeCompleteProvisioning(database(), {
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
  }).provision(
    subscription,
    invoice,
    'stripe_key_' + (await sha256(secretKey)),
    live,
  );
}
export async function findStripeCompleteCompany(
  subscriptionId: string,
  ownerId?: string,
) {
  return database()
    .prepare(
      `SELECT o.organization_id AS id,o.name FROM stripe_complete_closed_paid_projections p JOIN organizations o ON o.organization_id=p.organization_id AND o.subscription_id=p.subscription_id WHERE p.subscription_id=? AND (? IS NULL OR p.owner_id=?)`,
    )
    .bind(subscriptionId, ownerId ?? null, ownerId ?? null)
    .first<{ id: string; name: string }>();
}
