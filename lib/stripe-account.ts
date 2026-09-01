import type Stripe from 'stripe';

export type StripeAccountReadinessProblem =
  | 'price'
  | 'product'
  | 'tax'
  | 'portal';

export function stripeAccountReadinessProblem(input: {
  price: Stripe.Price;
  taxSettings: Stripe.Tax.Settings;
  portal: Stripe.BillingPortal.Configuration | undefined;
  expectedLivemode: boolean;
  unitAmount: number;
  taxBehavior: 'inclusive' | 'exclusive';
}): StripeAccountReadinessProblem | null {
  const { price, taxSettings, portal } = input;
  if (
    !price.active ||
    price.livemode !== input.expectedLivemode ||
    price.currency.toLowerCase() !== 'chf' ||
    price.unit_amount !== input.unitAmount ||
    price.type !== 'recurring' ||
    price.recurring?.interval !== 'month' ||
    price.recurring.interval_count !== 1 ||
    price.recurring.usage_type !== 'licensed' ||
    price.tax_behavior !== input.taxBehavior
  ) {
    return 'price';
  }

  const product = price.product;
  const taxCode =
    typeof product === 'string' || 'deleted' in product
      ? ''
      : typeof product.tax_code === 'string'
        ? product.tax_code
        : (product.tax_code?.id ?? '');
  if (
    typeof product === 'string' ||
    'deleted' in product ||
    !product.active ||
    !/^txcd_[0-9]{8}$/.test(taxCode)
  ) {
    return 'product';
  }

  if (
    taxSettings.status !== 'active' ||
    taxSettings.livemode !== input.expectedLivemode ||
    taxSettings.defaults.provider !== 'stripe'
  ) {
    return 'tax';
  }

  if (
    !portal ||
    !portal.active ||
    !portal.is_default ||
    portal.livemode !== input.expectedLivemode ||
    !portal.login_page.enabled ||
    !portal.login_page.url ||
    !portal.features.invoice_history.enabled ||
    !portal.features.payment_method_update.enabled ||
    !portal.features.subscription_cancel.enabled ||
    portal.features.subscription_cancel.mode !== 'at_period_end'
  ) {
    return 'portal';
  }
  return null;
}
