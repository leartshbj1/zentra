import { cookies } from 'next/headers';
import { getZentraUser } from '@/app/zentra-auth';
import { database, stripeConfiguration } from '@/lib/runtime';
import { assertStripeCheckoutReady } from '@/lib/stripe-readiness';
import { stripeTestAccessAllowed } from '@/lib/stripe-test-access';
import { planById } from '@/lib/plans';
import { readJsonObjectWithinLimit } from '@/lib/request-body';
import {
  activationCookieName,
  createCheckoutSession,
  enforceCheckoutRateLimit,
  jsonError,
  noStoreHeaders,
  PublicError,
  randomBase64Url,
  requireSameOrigin,
  sha256,
} from '@/lib/stripe';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const origin = requireSameOrigin(request);
    const body = await readJsonObjectWithinLimit(request, 4_096);
    const plan = planById(body.plan);
    if (!plan) throw new PublicError('Choisissez Solo, Start ou Pro.');
    const configuration = stripeConfiguration();
    const identity = await getZentraUser({ refreshSession: true });
    if (!identity) {
      throw new PublicError(
        'Connectez-vous à votre compte Zentra avant de choisir l’abonnement.',
        401,
      );
    }
    if (!stripeTestAccessAllowed(configuration, identity)) {
      throw new PublicError(
        'Le paiement Stripe est actuellement en test privé, réservé au propriétaire Zentra.',
        403,
      );
    }
    await assertStripeCheckoutReady(plan.id);
    await enforceCheckoutRateLimit(request);
    const claim = randomBase64Url();
    const claimHash = await sha256(claim);
    const session = await createCheckoutSession(
      origin,
      claimHash,
      identity,
      plan.id,
    );
    const now = Math.floor(Date.now() / 1000);
    const db = database();
    await db
      .prepare('DELETE FROM checkout_attempts WHERE expires_at<?')
      .bind(now)
      .run();
    await db
      .prepare(
        'INSERT INTO checkout_attempts(claim_hash,checkout_session_id,created_at,expires_at) VALUES(?,?,?,?)',
      )
      .bind(claimHash, session.id, now, now + 365 * 86_400)
      .run();
    const jar = await cookies();
    jar.set(activationCookieName(session.id), claim, {
      httpOnly: true,
      secure: new URL(origin).protocol === 'https:',
      sameSite: 'lax',
      path: '/',
      maxAge: 365 * 86_400,
    });
    return Response.json({ url: session.url }, { headers: noStoreHeaders() });
  } catch (error) {
    return jsonError(error);
  }
}
