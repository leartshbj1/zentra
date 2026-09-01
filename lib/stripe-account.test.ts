import type Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import {
  isTrustedStripePortalLoginUrl,
  stripeAccountReadinessProblem,
} from './stripe-account';

const requiredWebhookEvents = [
  'checkout.session.completed',
  'invoice.paid',
  'invoice.payment_failed',
  'customer.subscription.updated',
] as const;

function fixtures() {
  const price = {
    active: true,
    livemode: false,
    currency: 'chf',
    unit_amount: 5_000,
    type: 'recurring',
    recurring: {
      interval: 'month',
      interval_count: 1,
      usage_type: 'licensed',
    },
    tax_behavior: 'inclusive',
    product: {
      active: true,
      tax_code: 'txcd_10202003',
    },
  } as unknown as Stripe.Price;
  const taxSettings = {
    status: 'active',
    livemode: false,
    defaults: { provider: 'stripe' },
  } as unknown as Stripe.Tax.Settings;
  const portal = {
    active: true,
    is_default: true,
    livemode: false,
    login_page: {
      enabled: true,
      url: 'https://billing.stripe.com/p/login/test',
    },
    features: {
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: { enabled: true, mode: 'at_period_end' },
    },
  } as unknown as Stripe.BillingPortal.Configuration;
  const webhook = {
    status: 'enabled',
    livemode: false,
    url: 'https://elyko.example/api/stripe/webhook',
    api_version: '2026-08-26.dahlia',
    enabled_events: [...requiredWebhookEvents],
  } as unknown as Stripe.WebhookEndpoint;
  return { price, taxSettings, portal, webhook };
}

function validate(
  patch: Partial<ReturnType<typeof fixtures>> = {},
  expectedLivemode = false,
) {
  return stripeAccountReadinessProblem({
    ...fixtures(),
    ...patch,
    expectedLivemode,
    unitAmount: 5_000,
    taxBehavior: 'inclusive',
    expectedWebhookUrl: 'https://elyko.example/api/stripe/webhook',
    expectedApiVersion: '2026-08-26.dahlia',
    requiredWebhookEvents,
  });
}

describe('Stripe account readiness domain', () => {
  it('accepts the exact Zentra Price, Product, Tax and Portal contract', () => {
    expect(validate()).toBeNull();
  });

  it.each([
    ['inactive', { active: false }],
    ['wrong amount', { unit_amount: 4_900 }],
    ['wrong currency', { currency: 'eur' }],
    [
      'wrong cadence',
      {
        recurring: {
          interval: 'year',
          interval_count: 1,
          usage_type: 'licensed',
        },
      },
    ],
    ['wrong tax behavior', { tax_behavior: 'exclusive' }],
  ])('rejects a %s Price', (_label, pricePatch) => {
    const { price } = fixtures();
    expect(
      validate({ price: { ...price, ...pricePatch } as Stripe.Price }),
    ).toBe('price');
  });

  it('rejects a Product without an explicit tax code', () => {
    const { price } = fixtures();
    expect(
      validate({
        price: {
          ...price,
          product: { active: true, tax_code: null },
        } as unknown as Stripe.Price,
      }),
    ).toBe('product');
  });

  it('fails closed when Stripe does not return the expanded Product', () => {
    const { price } = fixtures();
    expect(
      validate({
        price: { ...price, product: null } as unknown as Stripe.Price,
      }),
    ).toBe('product');
  });

  it('rejects pending Stripe Tax or a mode mismatch', () => {
    const { taxSettings } = fixtures();
    expect(
      validate({
        taxSettings: {
          ...taxSettings,
          status: 'pending',
        } as Stripe.Tax.Settings,
      }),
    ).toBe('tax');
    expect(validate({}, true)).toBe('price');
  });

  it('rejects a Portal that cannot cancel at period end', () => {
    const { portal } = fixtures();
    expect(
      validate({
        portal: {
          ...portal,
          features: {
            ...portal.features,
            subscription_cancel: {
              ...portal.features.subscription_cancel,
              mode: 'immediately',
            },
          },
        },
      }),
    ).toBe('portal');
  });

  it('rejects a Portal without customer recovery by email', () => {
    const { portal } = fixtures();
    expect(
      validate({
        portal: {
          ...portal,
          login_page: { enabled: false, url: null },
        },
      }),
    ).toBe('portal');
  });

  it('allows only the official Stripe-hosted portal login URL', () => {
    expect(
      isTrustedStripePortalLoginUrl(
        'https://billing.stripe.com/p/login/test-account',
      ),
    ).toBe(true);
    expect(
      isTrustedStripePortalLoginUrl(
        'https://billing.stripe.com.evil.example/p/login/test-account',
      ),
    ).toBe(false);
    expect(
      isTrustedStripePortalLoginUrl(
        'https://billing.stripe.com/customer-portal',
      ),
    ).toBe(false);
  });

  it('rejects a webhook with the wrong URL, version, mode or event set', () => {
    const { webhook } = fixtures();
    for (const patch of [
      { url: 'https://evil.example/api/stripe/webhook' },
      { api_version: '2026-02-25.clover' },
      { livemode: true },
      { enabled_events: ['invoice.paid'] },
      { status: 'disabled' },
    ]) {
      expect(
        validate({
          webhook: { ...webhook, ...patch } as Stripe.WebhookEndpoint,
        }),
      ).toBe('webhook');
    }
  });

  it('accepts a webhook subscribed to every event', () => {
    const { webhook } = fixtures();
    expect(
      validate({
        webhook: {
          ...webhook,
          enabled_events: ['*'],
        } as Stripe.WebhookEndpoint,
      }),
    ).toBeNull();
  });
});
