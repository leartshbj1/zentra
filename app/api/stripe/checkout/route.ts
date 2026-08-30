import { cookies } from 'next/headers';
import { database, stripeConfiguration } from '@/lib/runtime';
import {
  activationCookieName,
  createCheckoutSession,
  enforceCheckoutRateLimit,
  jsonError,
  noStoreHeaders,
  randomBase64Url,
  requireSameOrigin,
  sha256,
} from '@/lib/stripe';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    if (!stripeConfiguration().checkoutReady) throw new Error('Stripe configuration incomplete');
    await enforceCheckoutRateLimit(request);
    const claim = randomBase64Url();
    const claimHash = await sha256(claim);
    const session = await createCheckoutSession(requireSameOrigin(request), claimHash);
    const now = Math.floor(Date.now() / 1000);
    await database()
      .prepare('INSERT INTO checkout_attempts(claim_hash,checkout_session_id,created_at,expires_at) VALUES(?,?,?,?)')
      .bind(claimHash, session.id, now, now + 365 * 86_400)
      .run();
    const jar = await cookies();
    jar.set(activationCookieName(session.id), claim, {
      httpOnly: true,
      secure: new URL(request.url).protocol === 'https:',
      sameSite: 'lax',
      path: '/',
      maxAge: 365 * 86_400,
    });
    return Response.json({ url: session.url }, { headers: noStoreHeaders() });
  } catch (error) {
    if (error instanceof Error && error.message === 'Stripe configuration incomplete') {
      return Response.json({ error: 'Le paiement Stripe attend encore la configuration du compte marchand.' }, { status: 503, headers: noStoreHeaders() });
    }
    return jsonError(error);
  }
}
