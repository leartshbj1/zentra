import { getZentraUser } from '@/app/zentra-auth';
import { stripeConfiguration } from '@/lib/runtime';
import {
  requireSameOrigin,
  jsonError,
  noStoreHeaders,
  PublicError,
  enforceCheckoutRateLimit,
} from '@/lib/stripe';
import { readJsonObjectWithinLimit } from '@/lib/request-body';
import { AccountPublicError } from '@/lib/account-security';
import {
  stripeTestAccessAllowed,
  stripeAutomaticTaxRequired,
} from '@/lib/stripe-test-access';
import { assertStripeCheckoutReady } from '@/lib/stripe-readiness';
import { completePlan, COMPLETE_TERMS_VERSION } from '@/lib/complete/plans';
import {
  completeCheckout,
  cancelCompleteCheckout,
} from '@/lib/complete/checkout';

export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try {
    const origin = requireSameOrigin(request),
      body = await readJsonObjectWithinLimit(request, 4096);
    const user = await getZentraUser({ refreshSession: true });
    if (!user)
      throw new PublicError(
        'Connectez-vous à votre compte Zentra pour continuer.',
        401,
      );
    if (!user.emailConfirmed)
      throw new PublicError(
        'Confirmez votre adresse e-mail avant de choisir le pack.',
        403,
      );
    if (body.action === 'cancel')
      return Response.json(await cancelCompleteCheckout(user), {
        headers: noStoreHeaders(),
      });
    const plan = completePlan(body.plan),
      config = stripeConfiguration();
    if (!plan) throw new PublicError('Choisissez un pack Solo, Équipe ou Pro.');
    if (
      body.acceptTerms !== true ||
      body.legalVersion !== COMPLETE_TERMS_VERSION
    )
      throw new PublicError(
        'Lisez et acceptez les conditions du pack avant de continuer.',
      );
    if (!stripeTestAccessAllowed(config, user))
      throw new PublicError(
        'Le paiement n’est pas encore ouvert aux clients.',
        503,
      );
    await assertStripeCheckoutReady(plan.gestion);
    await enforceCheckoutRateLimit(request);
    return Response.json(
      await completeCheckout(
        user,
        plan,
        origin,
        stripeAutomaticTaxRequired(config),
      ),
      { headers: noStoreHeaders() },
    );
  } catch (error) {
    return jsonError(
      error instanceof AccountPublicError
        ? new PublicError(error.message, error.status)
        : error,
    );
  }
}
