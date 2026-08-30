import { stripeConfiguration } from '@/lib/runtime';
import { noStoreHeaders } from '@/lib/stripe';

export const dynamic = 'force-dynamic';

export async function GET() {
  const { checkoutReady } = stripeConfiguration();
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
