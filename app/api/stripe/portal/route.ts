import { cookies } from 'next/headers';
import { readJsonObjectWithinLimit } from '@/lib/request-body';
import {
  activationCookieName,
  assertActivationClaim,
  createPortalSession,
  jsonError,
  LICENSE_PLAN,
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
    const body = await readJsonObjectWithinLimit(request, 4_096);
    const sessionId =
      typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    const claim =
      (await cookies()).get(activationCookieName(sessionId))?.value ?? '';
    if (!claim) throw new PublicError('Session client introuvable.', 401);
    const session = await retrieveCheckoutSession(sessionId);
    await assertActivationClaim(session, claim);
    if (
      session.mode !== 'subscription' ||
      session.status !== 'complete' ||
      session.metadata?.plan !== LICENSE_PLAN
    ) {
      throw new PublicError('Cette session Zentra n’est pas finalisée.', 409);
    }
    const url = await createPortalSession(
      referenceId(session.customer),
      `${origin}/paiement/succes?session_id=${encodeURIComponent(session.id)}`,
    );
    return Response.json({ url }, { headers: noStoreHeaders() });
  } catch (error) {
    return jsonError(error);
  }
}
