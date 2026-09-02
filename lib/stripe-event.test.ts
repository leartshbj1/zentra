import { describe, expect, it } from 'vitest';
import Stripe from 'stripe';
import {
  paidThroughFromInvoice,
  stripeReferenceId,
  stripeSecretKeyLivemode,
  subscriptionIdFromStripeEvent,
} from './stripe-event';

function event(type: string, object: Record<string, unknown>) {
  return { type, data: { object } } as unknown as Stripe.Event;
}

function paidInvoice(
  overrides: Record<string, unknown> = {},
  lineOverrides: Record<string, unknown> = {},
) {
  const line = {
    id: 'il_elyko',
    currency: 'chf',
    quantity: 1,
    subtotal: 5_000,
    parent: {
      type: 'subscription_item_details',
      subscription_item_details: {
        proration: false,
        subscription: 'sub_elyko',
        subscription_item: 'si_elyko',
      },
    },
    pricing: {
      type: 'price_details',
      unit_amount_decimal: '5000',
      price_details: { price: 'price_elyko', product: 'prod_elyko' },
    },
    period: { start: 1_800_000_000, end: 1_802_678_400 },
    ...lineOverrides,
  };
  return {
    id: 'in_elyko',
    status: 'paid',
    livemode: false,
    currency: 'chf',
    total: 5_000,
    billing_reason: 'subscription_cycle',
    automatic_tax: { enabled: true, status: 'complete' },
    parent: {
      type: 'subscription_details',
      subscription_details: { subscription: 'sub_elyko' },
    },
    lines: { has_more: false, data: [line] },
    ...overrides,
  } as unknown as Stripe.Invoice;
}

const expectedInvoice = {
  subscriptionId: 'sub_elyko',
  priceId: 'price_elyko',
  unitAmount: 5_000,
  livemode: false,
};

describe('Stripe event routing', () => {
  it('reads a Dahlia invoice subscription from parent.subscription_details', () => {
    expect(
      subscriptionIdFromStripeEvent(
        event('invoice.paid', {
          id: 'in_test',
          parent: {
            type: 'subscription_details',
            subscription_details: { subscription: 'sub_paid' },
          },
        }),
      ),
    ).toBe('sub_paid');
  });

  it('does not attach a manual or quote invoice to a subscription', () => {
    expect(
      subscriptionIdFromStripeEvent(
        event('invoice.paid', {
          id: 'in_manual',
          parent: { type: 'quote_details', quote_details: {} },
        }),
      ),
    ).toBe('');
  });

  it.each([
    ['customer.subscription.updated', { id: 'sub_updated' }, 'sub_updated'],
    [
      'checkout.session.completed',
      { subscription: { id: 'sub_checkout' } },
      'sub_checkout',
    ],
    [
      'checkout.session.async_payment_succeeded',
      { subscription: 'sub_async' },
      'sub_async',
    ],
  ])('routes %s', (type, object, expected) => {
    expect(subscriptionIdFromStripeEvent(event(type, object))).toBe(expected);
  });
});

describe('Stripe environment guardrails', () => {
  it.each([
    ['sk_test_example', false],
    ['rk_test_example', false],
    ['sk_live_example', true],
    ['rk_live_example', true],
    ['', null],
    ['not-a-stripe-key', null],
  ])('detects key mode without exposing the key', (key, expected) => {
    expect(stripeSecretKeyLivemode(key)).toBe(expected);
  });

  it('normalizes expandable Stripe references', () => {
    expect(stripeReferenceId('sub_string')).toBe('sub_string');
    expect(stripeReferenceId({ id: 'sub_object' })).toBe('sub_object');
    expect(stripeReferenceId(null)).toBe('');
  });
});

describe('Paid invoice entitlement', () => {
  it('uses the exact non-prorated Zentra invoice-line period', () => {
    expect(
      paidThroughFromInvoice(
        paidInvoice({ period_end: 1_999_999_999 }),
        expectedInvoice,
      ),
    ).toBe(1_802_678_400);
  });

  it('accepte la facture sans Stripe Tax uniquement quand le test propriétaire l’autorise', () => {
    expect(
      paidThroughFromInvoice(
        paidInvoice({ automatic_tax: { enabled: false, status: null } }),
        { ...expectedInvoice, automaticTaxRequired: false },
      ),
    ).toBe(1_802_678_400);
  });

  it('normalizes Dahlia decimal amounts before granting entitlement', () => {
    expect(
      paidThroughFromInvoice(
        paidInvoice(
          {},
          {
            pricing: {
              type: 'price_details',
              unit_amount_decimal: Stripe.Decimal.from('5000'),
              price_details: {
                price: 'price_elyko',
                product: 'prod_elyko',
              },
            },
          },
        ),
        expectedInvoice,
      ),
    ).toBe(1_802_678_400);
  });

  it('accepts an expanded reference to the configured Price', () => {
    expect(
      paidThroughFromInvoice(
        paidInvoice(
          {},
          {
            pricing: {
              type: 'price_details',
              unit_amount_decimal: '5000',
              price_details: {
                price: { id: 'price_elyko' },
                product: 'prod_elyko',
              },
            },
          },
        ),
        expectedInvoice,
      ),
    ).toBe(1_802_678_400);
  });

  it('keeps an old paid invoice bound to its own old period', () => {
    const oldPeriodEnd = 1_700_000_000;
    expect(
      paidThroughFromInvoice(
        paidInvoice(
          {},
          { period: { start: 1_697_321_600, end: oldPeriodEnd } },
        ),
        expectedInvoice,
      ),
    ).toBe(oldPeriodEnd);
  });

  it.each([
    [{ status: 'open' }, {}],
    [{ total: 0 }, {}],
    [{ billing_reason: 'subscription_update' }, {}],
    [{ automatic_tax: { enabled: true, status: 'failed' } }, {}],
    [{ automatic_tax: { enabled: false, status: null } }, {}],
    [
      {
        automatic_tax: {
          enabled: true,
          status: 'requires_location_inputs',
        },
      },
      {},
    ],
    [{ lines: { has_more: true, data: [] } }, {}],
    [{ livemode: true }, {}],
    [
      {
        parent: {
          type: 'subscription_details',
          subscription_details: { subscription: 'sub_other' },
        },
      },
      {},
    ],
    [{}, { currency: 'eur' }],
    [{}, { quantity: 2 }],
    [{}, { subtotal: 0 }],
    [{}, { pricing: null }],
    [{}, { period: { start: 10, end: 10 } }],
    [
      {},
      {
        parent: {
          type: 'subscription_item_details',
          subscription_item_details: {
            proration: true,
            subscription: 'sub_elyko',
            subscription_item: 'si_elyko',
          },
        },
      },
    ],
  ])(
    'rejects an invoice that cannot prove a paid Zentra period',
    (invoice, line) => {
      expect(
        paidThroughFromInvoice(paidInvoice(invoice, line), expectedInvoice),
      ).toBeNull();
    },
  );

  it('rejects an invoice for another subscription or price', () => {
    expect(
      paidThroughFromInvoice(paidInvoice(), {
        ...expectedInvoice,
        subscriptionId: 'sub_other',
      }),
    ).toBeNull();
    expect(
      paidThroughFromInvoice(paidInvoice(), {
        ...expectedInvoice,
        priceId: 'price_other',
      }),
    ).toBeNull();
  });

  it('rejects duplicate matching plan lines', () => {
    const invoice = paidInvoice();
    invoice.lines.data.push({ ...invoice.lines.data[0], id: 'il_duplicate' });
    expect(paidThroughFromInvoice(invoice, expectedInvoice)).toBeNull();
  });
});
