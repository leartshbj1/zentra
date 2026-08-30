import { cookies } from 'next/headers';
import {
  activationCookieName,
  createPortalSession,
  jsonError,
  noStoreHeaders,
  PublicError,
  referenceId,
  requireSameOrigin,
  retrieveCheckoutSession,
  sha256,
} from '@/lib/stripe';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const origin = requireSameOrigin(request);
    const body = (await request.json()) as { sessionId?: unknown };
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    const claim = (await cookies()).get(activationCookieName(sessionId))?.value ?? '';
    if (!claim) throw new PublicError('Session client introuvable.', 401);
    const session = await retrieveCheckoutSession(sessionId);
    if ((await sha256(claim)) !== session.metadata?.activation_claim_hash) throw new PublicError('Cette session de paiement ne vous appartient pas.', 403);
    const url = await createPortalSession(referenceId(session.customer), `${origin}/paiement/succes?session_id=${encodeURIComponent(session.id)}`);
    return Response.json({ url }, { headers: noStoreHeaders() });
  } catch (error) {
    return jsonError(error);
  }
}
