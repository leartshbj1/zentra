import { cookies } from 'next/headers';
import { getZentraUser } from '@/app/zentra-auth';
import { database, stripeConfiguration } from '@/lib/runtime';
import { assertStripeCheckoutReady } from '@/lib/stripe-readiness';
import { stripeTestAccessAllowed } from '@/lib/stripe-test-access';
import { planById } from '@/lib/plans';
import { readJsonObjectWithinLimit } from '@/lib/request-body';
import { LEGAL_VERSION, hasCurrentLegalAcceptance } from '@/lib/legal';
import { prepareReferral,rememberReferralCheckout,referralCheckoutIdentity } from '@/lib/referrals';
import { retrieveCheckoutSession } from '@/lib/stripe';
import { AccountPublicError } from '@/lib/account-security';
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
    if (!hasCurrentLegalAcceptance(body)) {
      throw new PublicError('Lisez et acceptez les conditions d’abonnement Zentra. Si la page est ancienne, rechargez-la.');
    }
    await assertStripeCheckoutReady(plan.id);
    await enforceCheckoutRateLimit(request);
    const referral=await prepareReferral(body.referralCode,identity);
    if(referral?.existingSessionId){const existing=await retrieveCheckoutSession(referral.existingSessionId);if(existing.url)return Response.json({url:existing.url},{headers:noStoreHeaders()});}
    const claim = randomBase64Url();
    const candidateHash = await sha256(claim);
    const claimHash=referral?await referralCheckoutIdentity({claimId:referral.claimId,previousSessionId:referral.previousSessionId,userId:identity.userId,planId:plan.id,origin,email:identity.email,candidateHash}):candidateHash;
    const session = await createCheckoutSession(
      origin,
      claimHash,
      identity,
      plan.id,
      referral??undefined,
    );
    if(referral)await rememberReferralCheckout(referral.claimId,session.id,identity.userId);
    const now = Math.floor(Date.now() / 1000);
    const db = database();
    await db
      .prepare('DELETE FROM checkout_attempts WHERE expires_at<?')
      .bind(now)
      .run();
    await db.batch([db.prepare(
        'INSERT INTO checkout_attempts(claim_hash,checkout_session_id,created_at,expires_at,account_user_id,account_email,account_name) VALUES(?,?,?,?,?,?,?) ON CONFLICT(checkout_session_id) DO NOTHING',
      )
      .bind(claimHash, session.id, now, now + 365 * 86_400, identity.userId, identity.email, identity.displayName),
      db.prepare('INSERT INTO legal_acceptances(acceptance_id,user_id,document_version,context,plan_id,checkout_session_id,origin,accepted_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(checkout_session_id) DO NOTHING')
        .bind(crypto.randomUUID(), identity.userId, LEGAL_VERSION, 'checkout_requested', plan.id, session.id, origin, new Date().toISOString()),
    ]);
    const jar = await cookies();
    if(candidateHash===claimHash)jar.set(activationCookieName(session.id), claim, {
      httpOnly: true,
      secure: new URL(origin).protocol === 'https:',
      sameSite: 'lax',
      path: '/',
      maxAge: 365 * 86_400,
    });
    return Response.json({ url: session.url }, { headers: noStoreHeaders() });
  } catch (error) {
    return jsonError(error instanceof AccountPublicError?new PublicError(error.message,error.status):error);
  }
}
