import { writeSupabasePkceCookie } from '@/lib/supabase-auth-cookies';
import {
  authJsonError,
  authNoStoreHeaders,
  AuthPublicError,
  readAuthCredentials,
  requireAuthSameOrigin,
} from '@/lib/supabase-auth-http';
import {
  supabaseAuthClient,
  supabaseAuthSiteOrigin,
} from '@/lib/supabase-auth-runtime';
import { createSupabasePkceFlow } from '@/lib/supabase-auth-pkce';
import { enforceAccountRateLimit } from '@/lib/account';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const siteOrigin = supabaseAuthSiteOrigin(request);
    requireAuthSameOrigin(request, { requireOrigin: true });
    if (new URL(request.url).origin !== siteOrigin) {
      throw new AuthPublicError('Origine de la demande refusée.', 403);
    }
    const { email, password, displayName } =
      await readAuthCredentials(request, { requireStrongPassword: true });
    await Promise.all([
      enforceAccountRateLimit(request, 'auth-signup-email', email, 4),
      enforceAccountRateLimit(request, 'auth-signup-address', 'all', 12),
    ]);
    const pkce = await createSupabasePkceFlow();
    const confirmationUrl = new URL('/api/auth/confirmation', siteOrigin);
    const client = supabaseAuthClient();
    const result = await client.signUp(
      email,
      password,
      displayName,
      {
        emailRedirectTo: confirmationUrl.toString(),
        codeChallenge: pkce.challenge,
      },
    );
    if (result.session) {
      try {
        await client.signOut(result.session.accessToken);
      } catch {
        // Les jetons ne sont jamais transmis au navigateur.
      }
      throw new AuthPublicError(
        'La confirmation e-mail doit être activée pour créer un compte Zentra.',
        503,
      );
    }
    await writeSupabasePkceCookie(pkce.verifier);
    return Response.json(
      {
        authenticated: false,
        requiresEmailConfirmation: true,
      },
      { status: 202, headers: authNoStoreHeaders() },
    );
  } catch (error) {
    return authJsonError(error);
  }
}
