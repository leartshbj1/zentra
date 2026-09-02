import type Stripe from 'stripe';

export type StripeAccountReadinessProblem =
  | 'price'
  | 'product'
  | 'tax'
  | 'portal'
  | 'webhook';

export function isTrustedStripePortalLoginUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'billing.stripe.com' &&
      !url.username &&
      !url.password &&
      url.pathname.startsWith('/p/login/')
    );
  } catch {
    return false;
  }
}

export function stripePortalConfigurationIsReady(
  portal: Stripe.BillingPortal.Configuration | undefined,
  expectedLivemode: boolean,
) {
  return Boolean(
    portal &&
    portal.active &&
    portal.is_default &&
    portal.livemode === expectedLivemode &&
    portal.login_page.enabled &&
    isTrustedStripePortalLoginUrl(portal.login_page.url) &&
    portal.features.invoice_history.enabled &&
    portal.features.payment_method_update.enabled &&
    portal.features.subscription_cancel.enabled &&
    portal.features.subscription_cancel.mode === 'at_period_end',
  );
}

export function stripeAccountReadinessProblem(input: {
  price: Stripe.Price;
  taxSettings: Stripe.Tax.Settings;
  portal: Stripe.BillingPortal.Configuration | undefined;
  webhook: Stripe.WebhookEndpoint;
  expectedLivemode: boolean;
  unitAmount: number;
  taxBehavior: 'inclusive' | 'exclusive';
  expectedWebhookUrl: string;
  expectedApiVersion: string;
  requiredWebhookEvents: readonly string[];
  allowPendingTaxInTestMode?: boolean;
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
    !product || typeof product === 'string' || 'deleted' in product
      ? ''
      : typeof product.tax_code === 'string'
        ? product.tax_code
        : (product.tax_code?.id ?? '');
  if (
    !product ||
    typeof product === 'string' ||
    'deleted' in product ||
    !product.active ||
    !/^txcd_[0-9]{8}$/.test(taxCode)
  ) {
    return 'product';
  }

  const taxReady =
    taxSettings.status === 'active' &&
    taxSettings.livemode === input.expectedLivemode &&
    taxSettings.defaults.provider === 'stripe';
  if (!taxReady && !input.allowPendingTaxInTestMode) {
    return 'tax';
  }

  if (!stripePortalConfigurationIsReady(portal, input.expectedLivemode)) {
    return 'portal';
  }

  const enabledEvents = new Set<string>(input.webhook.enabled_events);
  const allEvents = enabledEvents.has('*');
  if (
    input.webhook.status !== 'enabled' ||
    input.webhook.livemode !== input.expectedLivemode ||
    input.webhook.url !== input.expectedWebhookUrl ||
    input.webhook.api_version !== input.expectedApiVersion ||
    (!allEvents &&
      input.requiredWebhookEvents.some((event) => !enabledEvents.has(event)))
  ) {
    return 'webhook';
  }
  return null;
}
