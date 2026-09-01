import { cookies } from 'next/headers';
import { database } from '@/lib/runtime';
import { assertStripeCheckoutReady } from '@/lib/stripe-readiness';
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
    const origin = requireSameOrigin(request);
    await assertStripeCheckoutReady();
    await enforceCheckoutRateLimit(request);
    const claim = randomBase64Url();
    const claimHash = await sha256(claim);
    const session = await createCheckoutSession(origin, claimHash);
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
