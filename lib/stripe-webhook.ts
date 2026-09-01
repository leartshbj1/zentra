import Stripe from 'stripe';

export async function constructVerifiedStripeEvent(input: {
  client: Stripe;
  rawBody: string;
  signatureHeader: string;
  webhookSecret: string;
  toleranceSeconds: number;
  expectedLivemode: boolean;
  expectedApiVersion: string;
}) {
  const event = await input.client.webhooks.constructEventAsync(
    input.rawBody,
    input.signatureHeader,
    input.webhookSecret,
    input.toleranceSeconds,
    Stripe.createSubtleCryptoProvider(),
  );
  if (event.livemode !== input.expectedLivemode)
    throw new Error('Stripe event mode mismatch');
  if (event.api_version !== input.expectedApiVersion)
    throw new Error('Stripe event API version mismatch');
  return event;
}
