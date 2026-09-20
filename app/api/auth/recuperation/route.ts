import { enforceAccountRateLimit } from '@/lib/account';
import { readJsonObjectWithinLimit } from '@/lib/request-body';
import { writeSupabaseRecoveryCookie } from '@/lib/supabase-auth-cookies';
import {
  authJsonError,
  authNoStoreHeaders,
  AuthPublicError,
  requireAuthSameOrigin,
} from '@/lib/supabase-auth-http';
import { supabaseAuthClient } from '@/lib/supabase-auth-runtime';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    requireAuthSameOrigin(request, { requireOrigin: true });
    const body = await readJsonObjectWithinLimit(request, 4096);
    const tokenHash = typeof body.tokenHash === 'string' ? body.tokenHash : '';
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(tokenHash))
      throw new AuthPublicError(
        'Ce lien est incomplet. Demandez un nouveau lien.',
        400,
      );
    await enforceAccountRateLimit(request, 'auth-recovery-verify', 'all', 15);
    let session;
    try {
      // Never infer recovery from the currently signed-in account or a client-supplied type.
      session = await supabaseAuthClient().verifyRecoveryToken(tokenHash);
    } catch {
      throw new AuthPublicError(
        'Ce lien a expiré ou a déjà été utilisé. Demandez un nouveau lien.',
        400,
      );
    }
    await writeSupabaseRecoveryCookie(session);
    return Response.json(
      { ready: true, email: session.user.email },
      { headers: authNoStoreHeaders() },
    );
  } catch (error) {
    return authJsonError(error);
  }
}
