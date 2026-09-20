import type Stripe from 'stripe';

export function buildZentraCheckoutParams(input: {
  origin: string;
  claimHash: string;
  priceId: string;
  plan: string;
  accountUserId: string;
  accountEmail: string;
  automaticTax?: boolean;
  referral?: { claimId:string;couponId:string };
}): Stripe.Checkout.SessionCreateParams {
  return {
    mode: 'subscription',
    locale: 'fr',
    billing_address_collection: 'required',
    automatic_tax: { enabled: input.automaticTax !== false },
    tax_id_collection: { enabled: true },
    name_collection: {
      business: { enabled: true, optional: true },
      individual: { enabled: true, optional: false },
    },
    allow_promotion_codes: false,
    ...(input.referral ? {discounts:[{coupon:input.referral.couponId}]} : {}),
    customer_email: input.accountEmail,
    client_reference_id: input.claimHash,
    line_items: [{ price: input.priceId, quantity: 1 }],
    metadata: {
      plan: input.plan,
      activation_claim_hash: input.claimHash,
      account_user_id: input.accountUserId,
      ...(input.referral ? {referral_claim:input.referral.claimId} : {}),
    },
    subscription_data: {
      billing_mode: { type: 'flexible' },
      description: 'Abonnement Zentra · accès lié à votre compte',
      invoice_settings: { issuer: { type: 'self' } },
      metadata: {
        plan: input.plan,
        account_user_id: input.accountUserId,
        ...(input.referral ? {referral_claim:input.referral.claimId} : {}),
      },
    },
    success_url: `${input.origin}/paiement/succes?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${input.origin}/pricing?paiement=annule`,
  };
}
