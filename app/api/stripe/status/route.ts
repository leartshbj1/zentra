import { getZentraUser } from '@/app/zentra-auth';
import { stripeConfiguration } from '@/lib/runtime';
import { noStoreHeaders } from '@/lib/stripe';
import { stripeTestAccessAllowed } from '@/lib/stripe-test-access';
import { stripeCheckoutReadiness } from '@/lib/stripe-readiness';
import { planById, ZENTRA_PLANS } from '@/lib/plans';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const plan =
    planById(new URL(request.url).searchParams.get('plan')) ?? ZENTRA_PLANS[0];
  const configuration = stripeConfiguration();
  const identity = await getZentraUser({ refreshSession: true });
  const accessAllowed = stripeTestAccessAllowed(configuration, identity);
  const readiness = accessAllowed
    ? await stripeCheckoutReadiness(plan.id)
    : null;
  return Response.json(
    {
      ready: accessAllowed && Boolean(readiness),
      plan: plan.id,
      priceChfCents: plan.priceChfCents,
      seats: plan.seats,
      interval: 'month',
      provider: 'stripe',
      testMode: configuration.testMode === 'owner_only',
      authenticated: Boolean(identity),
      accessRestricted: !accessAllowed,
      portalLoginUrl: readiness?.portalLoginUrl,
    },
    { headers: noStoreHeaders() },
  );
}
