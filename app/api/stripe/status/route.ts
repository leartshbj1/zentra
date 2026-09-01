import { noStoreHeaders } from '@/lib/stripe';
import { stripeCheckoutIsReady } from '@/lib/stripe-readiness';

export const dynamic = 'force-dynamic';

export async function GET() {
  const checkoutReady = await stripeCheckoutIsReady();
  return Response.json(
    {
      ready: checkoutReady,
      priceChfCents: 5_000,
      interval: 'month',
      provider: 'stripe',
    },
    { headers: noStoreHeaders() },
  );
}
