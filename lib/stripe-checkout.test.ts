import { describe, expect, it } from 'vitest';
import { buildElykoCheckoutParams } from './stripe-checkout';

describe('Elyko hosted Checkout contract', () => {
  const params = buildElykoCheckoutParams({
    origin: 'https://elyko.example',
    claimHash: 'claim_hash',
    priceId: 'price_monthly',
    plan: 'elyko-monthly-50-chf',
  });

  it('uses the single stable monthly Price without client-side price data', () => {
    expect(params.mode).toBe('subscription');
    expect(params.line_items).toEqual([
      { price: 'price_monthly', quantity: 1 },
    ]);
    expect(params.line_items?.[0]).not.toHaveProperty('price_data');
    expect(params).not.toHaveProperty('submit_type');
  });

  it('enables the identity and Stripe Tax inputs required for invoices', () => {
    expect(params).toMatchObject({
      billing_address_collection: 'required',
      automatic_tax: { enabled: true },
      tax_id_collection: { enabled: true },
      name_collection: {
        business: { enabled: true, optional: true },
        individual: { enabled: true, optional: false },
      },
    });
  });

  it('binds the activation claim and Elyko plan on both objects', () => {
    expect(params.metadata).toEqual({
      plan: 'elyko-monthly-50-chf',
      activation_claim_hash: 'claim_hash',
    });
    expect(params.subscription_data?.metadata).toEqual({
      plan: 'elyko-monthly-50-chf',
    });
  });

  it('keeps both redirect URLs on the trusted origin', () => {
    expect(params.success_url).toBe(
      'https://elyko.example/paiement/succes?session_id={CHECKOUT_SESSION_ID}',
    );
    expect(params.cancel_url).toBe(
      'https://elyko.example/?paiement=annule#tarif',
    );
  });
});
