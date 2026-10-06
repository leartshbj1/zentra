import { cookies } from 'next/headers';
import { getZentraUser } from '@/app/zentra-auth';
import { stripeConfiguration } from '@/lib/runtime';
import { assertStripeCheckoutReady } from '@/lib/stripe-readiness';
import { stripeTestAccessAllowed } from '@/lib/stripe-test-access';
import { planById } from '@/lib/plans';
import { readJsonObjectWithinLimit } from '@/lib/request-body';
import { hasCurrentLegalAcceptance } from '@/lib/legal';
import { prepareReferral } from '@/lib/referrals';
import { AccountPublicError } from '@/lib/account-security';
import { stripeGestionPurchase } from '@/lib/payments/stripe-gestion-purchase';
import {
  activationCookieName,
  enforceCheckoutRateLimit,
  jsonError,
  noStoreHeaders,
  PublicError,
  requireSameOrigin,
} from '@/lib/stripe';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const origin = requireSameOrigin(request);
    const body = await readJsonObjectWithinLimit(request, 4_096);
    const plan = planById(body.plan);
    if (!plan) throw new PublicError('Choisissez Solo, Start ou Pro.');
    if (body.action !== undefined && body.action !== 'cancelCheckout')
      throw new PublicError('Cette action est inconnue.');
    const configuration = stripeConfiguration();
    const identity = await getZentraUser({ refreshSession: true });
    if (!identity)
      throw new PublicError(
        'Connectez-vous à votre compte Zentra avant de choisir l’abonnement.',
        401,
      );
    if (!stripeTestAccessAllowed(configuration, identity))
      throw new PublicError(
        'Le paiement Stripe est actuellement en test privé, réservé aux comptes autorisés.',
        403,
      );
    const cancel = body.action === 'cancelCheckout';
    if (!cancel && !hasCurrentLegalAcceptance(body))
      throw new PublicError(
        'Lisez et acceptez les conditions d’abonnement Zentra. Si la page est ancienne, rechargez-la.',
      );
    if (!cancel) await assertStripeCheckoutReady(plan.id);
    await enforceCheckoutRateLimit(request);
    const result = await stripeGestionPurchase(
      {
        user: identity,
        planId: plan.id,
        origin,
        organizationId: body.organizationId,
        referralCode: body.referralCode,
        abandon: cancel,
      },
      prepareReferral,
    );
    if ('canceled' in result)
      return Response.json({ canceled: true }, { headers: noStoreHeaders() });
    const jar = await cookies();
    jar.set(activationCookieName(result.sessionId), result.claim, {
      httpOnly: true,
      secure: new URL(origin).protocol === 'https:',
      sameSite: 'lax',
      path: '/',
      maxAge: 365 * 86_400,
    });
    // The durable claim, reservation id and encrypted server snapshot never
    // enter the JSON response. Only the secure cookie carries the claim.
    return Response.json({ url: result.url }, { headers: noStoreHeaders() });
  } catch (error) {
    return jsonError(
      error instanceof AccountPublicError
        ? new PublicError(error.message, error.status)
        : error,
    );
  }
}
