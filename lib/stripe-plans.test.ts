import type Stripe from 'stripe';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const stubs = vi.hoisted(() => ({
  create: vi.fn(),
  config: {
    secretKey: 'sk_test_plans_test_only',
    priceId: 'price_legacy',
    priceIds: { solo: 'price_solo', start: 'price_start', pro: 'price_pro' },
    testMode: 'owner_only',
  },
}));
vi.mock('@/lib/runtime', () => ({
  database: vi.fn(),
  stripeConfiguration: () => stubs.config,
}));
vi.mock('stripe', () => ({
  default: class {
    static createFetchHttpClient() {
      return {};
    }
    checkout = { sessions: { create: stubs.create } };
  },
}));
import {
  createCheckoutSession,
  validateActiveZentraSubscription,
  validatePaidSubscription,
} from './stripe';
import { ZENTRA_PLANS, type ZentraPlan } from './plans';
function subscription(plan: ZentraPlan): Stripe.Subscription {
  return {
    id: 'sub_test',
    status: 'active',
    livemode: false,
    metadata: { plan: plan.licensePlan },
    automatic_tax: { enabled: false },
    items: {
      data: [
        {
          quantity: 1,
          current_period_end: 2_000_000_000,
          price: {
            id: stubs.config.priceIds[plan.id],
            unit_amount: plan.priceChfCents,
            currency: 'chf',
            tax_behavior: 'inclusive',
            recurring: {
              interval: 'month',
              interval_count: 1,
              usage_type: 'licensed',
            },
          },
        },
      ],
    },
  } as unknown as Stripe.Subscription;
}
beforeEach(() => {
  vi.clearAllMocks();
  stubs.create.mockResolvedValue({
    id: 'cs_test',
    url: 'https://checkout.stripe.com/c/pay/test',
  });
});
describe('Three paid plans through Checkout and subscription validation', () => {
  it.each(ZENTRA_PLANS)(
    'uses the server-owned $name Price and account binding',
    async (plan) => {
      await createCheckoutSession(
        'https://zentra.example',
        `claim_${plan.id}`,
        { userId: 'owner', email: 'owner@example.test' },
        plan.id,
      );
      expect(stubs.create).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'subscription',
          line_items: [{ price: stubs.config.priceIds[plan.id], quantity: 1 }],
          metadata: expect.objectContaining({
            plan: plan.licensePlan,
            account_user_id: 'owner',
          }),
          subscription_data: expect.objectContaining({
            metadata: { plan: plan.licensePlan, account_user_id: 'owner' },
          }),
        }),
        expect.any(Object),
      );
      const current = subscription(plan);
      expect(validateActiveZentraSubscription(current)).toBe(
        current.items.data[0],
      );
      expect(
        validatePaidSubscription(
          {
            mode: 'subscription',
            status: 'complete',
            payment_status: 'paid',
            metadata: { plan: plan.licensePlan },
          } as unknown as Stripe.Checkout.Session,
          current,
        ),
      ).toBe(current.items.data[0]);
    },
  );
  it.each(['quantity', 'price', 'amount', 'currency', 'mode', 'plan'] as const)(
    'rejects a mismatched subscription %s',
    (field) => {
      const current = subscription(ZENTRA_PLANS[1]);
      const item = current.items.data[0];
      if (field === 'quantity') item.quantity = 3;
      if (field === 'price') item.price.id = stubs.config.priceIds.solo;
      if (field === 'amount') item.price.unit_amount = 4900;
      if (field === 'currency') item.price.currency = 'eur';
      if (field === 'mode') current.livemode = true;
      if (field === 'plan') current.metadata.plan = ZENTRA_PLANS[2].licensePlan;
      expect(() => validateActiveZentraSubscription(current)).toThrow();
    },
  );
  it('does not activate unpaid checkout or a different selected plan', () => {
    const current = subscription(ZENTRA_PLANS[0]);
    expect(() =>
      validatePaidSubscription(
        {
          mode: 'subscription',
          status: 'complete',
          payment_status: 'unpaid',
          metadata: current.metadata,
        } as unknown as Stripe.Checkout.Session,
        current,
      ),
    ).toThrow('paiement');
    expect(() =>
      validatePaidSubscription(
        {
          mode: 'subscription',
          status: 'complete',
          payment_status: 'paid',
          metadata: { plan: ZENTRA_PLANS[2].licensePlan },
        } as unknown as Stripe.Checkout.Session,
        current,
      ),
    ).toThrow('produit');
  });
});
