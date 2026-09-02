import { getZentraUser } from '@/app/zentra-auth';
import { stripeConfiguration } from '@/lib/runtime';
import { noStoreHeaders } from '@/lib/stripe';
import { stripeTestAccessAllowed } from '@/lib/stripe-test-access';
import {
  stripeCheckoutReadiness,
  stripePortalLoginUrl,
} from '@/lib/stripe-readiness';

export const dynamic = 'force-dynamic';

export async function GET() {
  const configuration = stripeConfiguration();
  const identity = await getZentraUser({ refreshSession: true });
  const accessAllowed = stripeTestAccessAllowed(configuration, identity);
  const [readiness, portalLoginUrl] = await Promise.all([
    accessAllowed ? stripeCheckoutReadiness() : Promise.resolve(null),
    stripePortalLoginUrl(),
  ]);
  return Response.json(
    {
      ready: accessAllowed && Boolean(readiness),
      priceChfCents: 5_000,
      interval: 'month',
      provider: 'stripe',
      testMode: configuration.testMode === 'owner_only',
      authenticated: Boolean(identity),
      accessRestricted: !accessAllowed,
      portalLoginUrl: portalLoginUrl ?? undefined,
    },
    { headers: noStoreHeaders() },
  );
}
