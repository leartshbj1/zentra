import { cookies } from 'next/headers';
import { getZentraUser } from '@/app/zentra-auth';
import { readJsonObjectWithinLimit } from '@/lib/request-body';
import { planByLicense } from '@/lib/plans';
import { membershipsForUser, enforceAccountRateLimit } from '@/lib/account';
import { database } from '@/lib/runtime';
import { AccountPublicError } from '@/lib/account-security';
import {
  activationCookieName,
  assertActivationClaim,
  assertCheckoutAccount,
  createPortalSession,
  jsonError,
  noStoreHeaders,
  PublicError,
  referenceId,
  requireSameOrigin,
  retrieveCheckoutSession,
} from '@/lib/stripe';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const origin = requireSameOrigin(request);
    const user = await getZentraUser({ refreshSession: true });
    const body = await readJsonObjectWithinLimit(request, 4_096);
    if (typeof body.organizationId === 'string') {
      if (!user) throw new PublicError('Connectez-vous pour gérer cet abonnement.', 401);
      const membership = (await membershipsForUser(user.userId)).find(
        (item) => item.organizationId === body.organizationId && item.role === 'owner',
      );
      if (!membership) throw new PublicError('Seul le propriétaire peut gérer cet abonnement.', 403);
      await enforceAccountRateLimit(request, 'account-billing-portal', user.userId, 10);
      const subscription = await database().prepare('SELECT customer_id FROM subscriptions WHERE subscription_id=?')
        .bind(membership.subscriptionId).first<{ customer_id: string }>();
      if (!subscription || !/^cus_[A-Za-z0-9]+$/.test(subscription.customer_id))
        throw new PublicError('Cet accès offert ne comporte pas de facturation. Choisissez une formule pour vous abonner.', 409);
      const url = await createPortalSession(subscription.customer_id,
        `${origin}/compte/abonnement?organizationId=${encodeURIComponent(membership.organizationId)}`);
      return Response.json({ url }, { headers: noStoreHeaders() });
    }
    const sessionId =
      typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    const claim =
      (await cookies()).get(activationCookieName(sessionId))?.value ?? '';
    if (!claim) throw new PublicError('Session client introuvable.', 401);
    const session = await retrieveCheckoutSession(sessionId);
    await assertActivationClaim(session, claim);
    assertCheckoutAccount(session, user);
    if (
      session.mode !== 'subscription' ||
      session.status !== 'complete' ||
      !planByLicense(session.metadata?.plan)
    ) {
      throw new PublicError('Cette session Zentra n’est pas finalisée.', 409);
    }
    const url = await createPortalSession(
      referenceId(session.customer),
      `${origin}/paiement/succes?session_id=${encodeURIComponent(session.id)}`,
    );
    return Response.json({ url }, { headers: noStoreHeaders() });
  } catch (error) {
    if(error instanceof AccountPublicError)return Response.json({error:error.message},{status:error.status,headers:noStoreHeaders()});
    return jsonError(error);
  }
}
