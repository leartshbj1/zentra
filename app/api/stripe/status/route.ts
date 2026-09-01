import { noStoreHeaders } from '@/lib/stripe';
import {
  stripeCheckoutReadiness,
  stripePortalLoginUrl,
} from '@/lib/stripe-readiness';

export const dynamic = 'force-dynamic';

export async function GET() {
  const [readiness, portalLoginUrl] = await Promise.all([
    stripeCheckoutReadiness(),
    stripePortalLoginUrl(),
  ]);
  return Response.json(
    {
      ready: Boolean(readiness),
      priceChfCents: 5_000,
      interval: 'month',
      provider: 'stripe',
      portalLoginUrl: portalLoginUrl ?? undefined,
    },
    { headers: noStoreHeaders() },
  );
}
