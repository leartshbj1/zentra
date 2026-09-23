import type Stripe from 'stripe';
import {
  automationStripe,
  fullyRefundedAutomationInvoice,
} from '@/lib/automation/billing';
import { stripeReferenceId, stripeSecretKeyLivemode } from '@/lib/stripe-event';
import { database, runtimeValue, stripeConfiguration } from '@/lib/runtime';
import { PublicError } from '@/lib/stripe';
import { COMPLETE_PRODUCT, completePlan, type CompletePlan } from './plans';

const ref = (v: unknown) =>
  stripeReferenceId(v as string | { id: string } | null);
export function validCompletePrice(
  price: Stripe.Price,
  plan: CompletePlan,
  live: boolean,
) {
  return (
    price.livemode === live &&
    price.currency === 'chf' &&
    price.unit_amount === plan.priceChfCents &&
    ref(price.product) === plan.productId &&
    price.lookup_key === plan.lookupKey &&
    price.metadata.service === COMPLETE_PRODUCT &&
    price.metadata.bundle_plan === plan.id &&
    price.recurring?.interval === 'month' &&
    price.recurring.interval_count === 1 &&
    price.recurring.usage_type === 'licensed' &&
    price.tax_behavior === 'inclusive'
  );
}
export function subscriptionCompletePlan(subscription: Stripe.Subscription) {
  if (subscription.metadata.service !== COMPLETE_PRODUCT) return null;
  const plan = completePlan(subscription.metadata.bundle_plan);
  const live = stripeSecretKeyLivemode(runtimeValue('STRIPE_SECRET_KEY'));
  const item = subscription.items.data[0];
  return plan &&
    live !== null &&
    subscription.livemode === live &&
    subscription.metadata.plan === plan.licensePlan &&
    subscription.items.data.length === 1 &&
    item?.quantity === 1 &&
    validCompletePrice(item.price, plan, live)
    ? plan
    : null;
}
export async function ensureCompletePrice(plan: CompletePlan) {
  const stripe = automationStripe(),
    live = stripeSecretKeyLivemode(runtimeValue('STRIPE_SECRET_KEY'));
  if (live === null)
    throw new PublicError('Le paiement est indisponible.', 503);
  const prices = await stripe.prices.list({
    lookup_keys: [plan.lookupKey],
    limit: 2,
  });
  if (prices.data.length) {
    const price = prices.data[0],
      product = await stripe.products.retrieve(plan.productId);
    if (
      prices.data.length !== 1 ||
      !price.active ||
      !validCompletePrice(price, plan, live) ||
      product.deleted ||
      !product.active ||
      !product.tax_code
    )
      throw new PublicError(
        'Ce pack doit être vérifié avant le paiement.',
        503,
      );
    return price;
  }
  // Fixed catalog identities + Stripe idempotency make concurrent first checkouts safe.
  let product: Stripe.Product | Stripe.DeletedProduct;
  try {
    product = await stripe.products.retrieve(plan.productId);
  } catch (error) {
    if ((error as { code?: string }).code !== 'resource_missing') throw error;
    const basePrice = await stripe.prices.retrieve(
      stripeConfiguration().priceIds[plan.gestion],
      { expand: ['product'] },
    );
    const baseProduct = basePrice.product;
    const taxCode =
      typeof baseProduct === 'string' || baseProduct.deleted
        ? ''
        : ref(baseProduct.tax_code);
    if (!/^txcd_[0-9]{8}$/.test(taxCode))
      throw new PublicError('La catégorie du produit doit être vérifiée.', 503);
    product = await stripe.products.create(
      {
        id: plan.productId,
        name: `Zentra Complet ${plan.name}`,
        description: `Gestion, Support et Automation pour une entreprise. ${plan.seats} personne(s), ${plan.analyses} analyses Support par mois.`,
        tax_code: taxCode,
        metadata: { service: COMPLETE_PRODUCT, bundle_plan: plan.id },
      },
      { idempotencyKey: plan.productId },
    );
  }
  if (
    product.deleted ||
    !product.active ||
    product.metadata.service !== COMPLETE_PRODUCT
  )
    throw new PublicError('Le catalogue des packs doit être vérifié.', 503);
  const price = await stripe.prices.create(
    {
      product: plan.productId,
      currency: 'chf',
      unit_amount: plan.priceChfCents,
      recurring: {
        interval: 'month',
        interval_count: 1,
        usage_type: 'licensed',
      },
      tax_behavior: 'inclusive',
      lookup_key: plan.lookupKey,
      metadata: { service: COMPLETE_PRODUCT, bundle_plan: plan.id },
    },
    { idempotencyKey: plan.lookupKey },
  );
  if (!validCompletePrice(price, plan, live))
    throw new PublicError('Le tarif du pack doit être vérifié.', 503);
  return price;
}
export async function completePortal(customerId: string, returnUrl: string) {
  const stripe = automationStripe(),
    live = stripeSecretKeyLivemode(runtimeValue('STRIPE_SECRET_KEY'));
  const configurations = await stripe.billingPortal.configurations.list({
    active: true,
    limit: 100,
  });
  let config = configurations.data.find(
    (c) => c.metadata?.service === COMPLETE_PRODUCT && c.livemode === live,
  );
  if (!config) {
    if (configurations.has_more)
      throw new PublicError('Le portail du pack doit être vérifié.', 503);
    config = await stripe.billingPortal.configurations.create(
      {
        metadata: { service: COMPLETE_PRODUCT },
        features: {
          invoice_history: { enabled: true },
          payment_method_update: { enabled: true },
          subscription_cancel: { enabled: true, mode: 'at_period_end' },
          subscription_update: { enabled: false },
        },
      },
      { idempotencyKey: 'zentra_complete_portal_v1' },
    );
  }
  if (
    config.livemode !== live ||
    config.features.subscription_update.enabled ||
    !config.features.subscription_cancel.enabled ||
    config.features.subscription_cancel.mode !== 'at_period_end' ||
    !config.features.invoice_history.enabled ||
    !config.features.payment_method_update.enabled
  )
    throw new PublicError('Le portail du pack doit être vérifié.', 503);
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    configuration: config.id,
    return_url: returnUrl,
  });
  return { url: session.url };
}
export async function persistCompleteRefund(event: Stripe.Event) {
  if (event.type !== 'charge.refunded') return false;
  const live = stripeSecretKeyLivemode(runtimeValue('STRIPE_SECRET_KEY'));
  if (live === null || event.livemode !== live) return false;
  const stripe = automationStripe(),
    charge = await stripe.charges.retrieve(
      (event.data.object as Stripe.Charge).id,
    );
  if (!charge.refunded || !ref(charge.payment_intent)) return false;
  const payments = await stripe.invoicePayments.list({
    payment: {
      type: 'payment_intent',
      payment_intent: ref(charge.payment_intent),
    },
    limit: 100,
  });
  if (payments.has_more)
    throw new PublicError('Le remboursement doit être vérifié.', 503);
  let handled = false;
  for (const id of new Set(payments.data.map((p) => ref(p.invoice)))) {
    const invoice = await stripe.invoices.retrieve(id),
      subId = ref(invoice.parent?.subscription_details?.subscription);
    if (
      !subId ||
      invoice.livemode !== live ||
      ref(invoice.customer) !== ref(charge.customer)
    )
      continue;
    const subscription = await stripe.subscriptions.retrieve(subId);
    if (
      !subscriptionCompletePlan(subscription) ||
      ref(subscription.customer) !== ref(charge.customer)
    )
      continue;
    if (await fullyRefundedAutomationInvoice(stripe, id)) {
      await database().batch([
        database()
          .prepare(
            'INSERT INTO complete_refunds(invoice_id,customer_id,livemode,verified_at) VALUES(?,?,?,?) ON CONFLICT(invoice_id) DO UPDATE SET verified_at=excluded.verified_at',
          )
          .bind(
            id,
            ref(charge.customer),
            Number(live),
            Math.floor(Date.now() / 1000),
          ),
        database()
          .prepare(
            'UPDATE subscriptions SET entitlement_valid_until=0 WHERE subscription_id=? AND last_paid_invoice_id=? AND customer_id=? AND livemode=?',
          )
          .bind(subId, id, ref(charge.customer), Number(live)),
      ]);
      handled = true;
    }
  }
  return handled;
}
