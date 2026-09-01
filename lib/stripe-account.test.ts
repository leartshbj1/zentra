import type Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { stripeAccountReadinessProblem } from './stripe-account';

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
  return { price, taxSettings, portal };
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
  });
}

describe('Stripe account readiness domain', () => {
  it('accepts the exact Elyko Price, Product, Tax and Portal contract', () => {
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
});
