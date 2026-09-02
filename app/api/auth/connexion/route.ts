import {
  clearSupabasePkceCookie,
  writeSupabaseAuthCookies,
} from '@/lib/supabase-auth-cookies';
import {
  authJsonError,
  authNoStoreHeaders,
  publicAuthUser,
  readAuthCredentials,
  requireAuthSameOrigin,
} from '@/lib/supabase-auth-http';
import { supabaseAuthClient } from '@/lib/supabase-auth-runtime';
import { enforceAccountRateLimit } from '@/lib/account';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    requireAuthSameOrigin(request, { requireOrigin: true });
    const { email, password } = await readAuthCredentials(request);
    await Promise.all([
      enforceAccountRateLimit(request, 'auth-login-email', email, 12),
      enforceAccountRateLimit(request, 'auth-login-address', 'all', 50),
    ]);
    const session = await supabaseAuthClient().signIn(email, password);
    await writeSupabaseAuthCookies(session);
    await clearSupabasePkceCookie();
    return Response.json(
      { authenticated: true, user: publicAuthUser(session.user) },
      { headers: authNoStoreHeaders() },
    );
  } catch (error) {
    return authJsonError(error);
  }
}
