import type Stripe from 'stripe';

export type StripeReference = string | { id: string } | null;

export function stripeReferenceId(value: StripeReference): string {
  return typeof value === 'string' ? value : (value?.id ?? '');
}

/**
 * Stripe no longer exposes `invoice.subscription` with Basil and later. Invoice
 * events must follow the typed parent relationship introduced in 2025.
 */
export function subscriptionIdFromStripeEvent(event: Stripe.Event): string {
  if (event.type.startsWith('customer.subscription.')) {
    const subscription = event.data.object as { id?: unknown };
    return typeof subscription.id === 'string' ? subscription.id : '';
  }
  if (event.type.startsWith('invoice.')) {
    const invoice = event.data.object as Stripe.Invoice;
    if (invoice.parent?.type !== 'subscription_details') return '';
    return stripeReferenceId(
      invoice.parent.subscription_details?.subscription as StripeReference,
    );
  }
  if (
    event.type === 'checkout.session.completed' ||
    event.type === 'checkout.session.async_payment_succeeded'
  ) {
    return stripeReferenceId(
      (event.data.object as Stripe.Checkout.Session)
        .subscription as StripeReference,
    );
  }
  return '';
}

export function stripeSecretKeyLivemode(secretKey: string): boolean | null {
  if (/^(sk|rk)_live_/.test(secretKey)) return true;
  if (/^(sk|rk)_test_/.test(secretKey)) return false;
  return null;
}

export type ElykoInvoiceValidation = {
  subscriptionId: string;
  priceId: string;
  unitAmount: number;
  livemode: boolean;
};

/**
 * Returns the exact service-period end covered by a paid Elyko invoice.
 *
 * This deliberately never relies on the Subscription's current period. Stripe
 * can deliver an old invoice event after the Subscription has already moved to
 * a later period, and that later period might not have been paid.
 */
export function paidThroughFromInvoice(
  invoice: Stripe.Invoice,
  expected: ElykoInvoiceValidation,
): number | null {
  if (
    invoice.status !== 'paid' ||
    invoice.livemode !== expected.livemode ||
    invoice.currency.toLowerCase() !== 'chf' ||
    invoice.total !== expected.unitAmount ||
    invoice.automatic_tax?.enabled !== true ||
    invoice.automatic_tax.status !== 'complete' ||
    invoice.parent?.type !== 'subscription_details' ||
    stripeReferenceId(
      invoice.parent.subscription_details?.subscription as StripeReference,
    ) !== expected.subscriptionId ||
    !['subscription_create', 'subscription_cycle'].includes(
      invoice.billing_reason ?? '',
    ) ||
    invoice.lines.has_more
  ) {
    return null;
  }

  const matchingLines = invoice.lines.data.filter((line) => {
    const details = line.parent?.subscription_item_details;
    const price = line.pricing?.price_details?.price;
    const priceId =
      typeof price === 'string'
        ? price
        : typeof price?.id === 'string'
          ? price.id
          : '';
    return (
      line.parent?.type === 'subscription_item_details' &&
      details?.proration === false &&
      details.subscription === expected.subscriptionId &&
      priceId === expected.priceId &&
      line.currency.toLowerCase() === 'chf' &&
      line.quantity === 1 &&
      line.subtotal === expected.unitAmount &&
      line.pricing?.unit_amount_decimal?.toString() ===
        String(expected.unitAmount) &&
      Number.isSafeInteger(line.period.start) &&
      Number.isSafeInteger(line.period.end) &&
      line.period.end > line.period.start
    );
  });

  return matchingLines.length === 1 ? matchingLines[0].period.end : null;
}
