import { beforeEach, it, expect, vi } from 'vitest';
import type Stripe from 'stripe';
const mocks = vi.hoisted(() => ({
  environment: { STRIPE_SECRET_KEY: 'sk_live_fixture' } as Record<
    string,
    string
  >,
}));
vi.mock('@/lib/runtime', () => ({
  runtimeValue: (key: string) => mocks.environment[key] || '',
  stripeConfiguration: () => ({
    secretKey: 'sk_live_fixture',
    testMode: '',
    ownerEmail: 'owner@example.ch',
  }),
}));
vi.mock('@/lib/account', () => ({ requireBrowserMembership: vi.fn() }));
vi.mock('@/lib/stripe', () => ({
  STRIPE_API_VERSION: '2026-08-26.dahlia',
  REQUIRED_STRIPE_WEBHOOK_EVENTS: [],
}));
import { validAutomationPrice, paidAutomationPeriod } from './billing';
const config = {
  productId: 'prod_automation',
  priceId: 'price_auto',
  portalId: 'portal',
  livemode: true,
  keyBinding: 'fixture',
};
const time = Math.floor(Date.now() / 1000);
const price = {
  id: 'price_auto',
  active: true,
  livemode: true,
  product: 'prod_automation',
  currency: 'chf',
  unit_amount: 1500,
  type: 'recurring',
  recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
  tax_behavior: 'inclusive',
  metadata: { service: 'zentra_automation' },
} as unknown as Stripe.Price;
const subscription = {
  id: 'sub_auto',
  customer: 'cus_a',
} as Stripe.Subscription;
function invoice(
  patch: Record<string, unknown> = {},
  linePatch: Record<string, unknown> = {},
) {
  return {
    id: 'in_auto',
    status: 'paid',
    livemode: true,
    currency: 'chf',
    total: 1500,
    amount_paid: 1500,
    amount_due: 1500,
    customer: 'cus_a',
    automatic_tax: { enabled: true, status: 'complete' },
    billing_reason: 'subscription_create',
    parent: {
      type: 'subscription_details',
      subscription_details: { subscription: 'sub_auto' },
    },
    lines: {
      has_more: false,
      data: [
        {
          currency: 'chf',
          quantity: 1,
          subtotal: 1500,
          parent: {
            type: 'subscription_item_details',
            subscription_item_details: {
              proration: false,
              subscription: 'sub_auto',
            },
          },
          pricing: {
            unit_amount_decimal: '1500',
            price_details: { price: 'price_auto' },
          },
          period: { start: time - 60, end: time + 30 * 86400 },
          ...linePatch,
        },
      ],
    },
    ...patch,
  } as unknown as Stripe.Invoice;
}
beforeEach(() => {
  mocks.environment = { STRIPE_SECRET_KEY: 'sk_live_fixture' };
});
it('accepts the exact CHF 15 monthly product', () => {
  expect(validAutomationPrice(price, config)).toBe(true);
  expect(paidAutomationPeriod(invoice(), subscription, config)).toMatchObject({
    invoiceId: 'in_auto',
  });
});
it.each([
  { unit_amount: 1499 },
  { livemode: false },
  { currency: 'eur' },
  { metadata: { service: 'zentra-support' } },
  { recurring: { interval: 'year', interval_count: 1 } },
  { product: 'foreign' },
])('rejects wrong Stripe price %j', (patch) => {
  expect(
    validAutomationPrice({ ...price, ...patch } as Stripe.Price, config),
  ).toBe(false);
});
it.each([
  { status: 'open' },
  { amount_paid: 0 },
  { total: 0 },
  { amount_due: 0 },
  { livemode: false },
  { customer: 'cus_other' },
  { billing_reason: 'manual' },
  {
    parent: {
      type: 'subscription_details',
      subscription_details: { subscription: 'sub_other' },
    },
  },
])('does not activate from invalid settlement %j', (patch) => {
  expect(paidAutomationPeriod(invoice(patch), subscription, config)).toBeNull();
});
it('keeps exact paid period rather than current subscription period', () => {
  expect(
    paidAutomationPeriod(
      invoice(),
      {
        ...subscription,
        current_period_end: time + 400 * 86400,
      } as Stripe.Subscription,
      config,
    )?.end,
  ).toBe(time + 30 * 86400);
});
it.each([
  { quantity: 2 },
  { period: { start: time + 800, end: time + 30 * 86400 } },
  { period: { start: time, end: time + 365 * 86400 } },
  {
    pricing: {
      unit_amount_decimal: '1000',
      price_details: { price: 'price_auto' },
    },
  },
])('rejects malformed service period/line %j', (patch) => {
  expect(
    paidAutomationPeriod(invoice({}, patch), subscription, config),
  ).toBeNull();
});
