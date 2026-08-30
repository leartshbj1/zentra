import { cookies } from 'next/headers';
import { issueLicense } from '@/lib/license-token';
import {
  activationCookieName,
  jsonError,
  noStoreHeaders,
  PublicError,
  referenceId,
  requireSameOrigin,
  retrieveCheckoutSession,
  retrieveSubscription,
  sha256,
  upsertSubscription,
  validatePaidSubscription,
} from '@/lib/stripe';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const body = (await request.json()) as { sessionId?: unknown; installationId?: unknown };
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    const installationId = typeof body.installationId === 'string' ? body.installationId.trim() : '';
    const claim = (await cookies()).get(activationCookieName(sessionId))?.value ?? '';
    if (!claim) throw new PublicError('Cette session d’activation n’est plus reconnue. Reprenez le paiement depuis ce navigateur.', 401);
    const session = await retrieveCheckoutSession(sessionId);
    const expectedHash = session.metadata?.activation_claim_hash ?? '';
    if (!expectedHash || (await sha256(claim)) !== expectedHash) throw new PublicError('Cette session de paiement ne vous appartient pas.', 403);
    const subscription = await retrieveSubscription(referenceId(session.subscription));
    const item = validatePaidSubscription(session, subscription);
    await upsertSubscription(subscription, session);
    const customerName = session.customer_details?.business_name ?? session.customer_details?.name ?? null;
    const license = await issueLicense({ subscriptionId: subscription.id, installationId, customerName, periodEnd: item.current_period_end! });
    return Response.json(license, { headers: noStoreHeaders() });
  } catch (error) {
    return jsonError(error);
  }
}
