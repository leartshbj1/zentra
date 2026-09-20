import {
  clearSupabaseAuthCookies,
  readSupabaseAuthCookies,
} from '@/lib/supabase-auth-cookies';
import {
  authJsonError,
  authNoStoreHeaders,
  requireAuthSameOrigin,
  safeAuthReturnPath,
} from '@/lib/supabase-auth-http';
import { optionalSupabaseAuthClient } from '@/lib/supabase-auth-runtime';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const acceptsHtml =
    request.headers.get('accept')?.includes('text/html') ?? false;
  const returnTo = safeAuthReturnPath(
    new URL(request.url).searchParams.get('retour'),
  );
  const destination = `/connexion?autre=1&deconnecte=1&retour=${encodeURIComponent(returnTo)}`;
  try {
    requireAuthSameOrigin(request);
  } catch (error) {
    return authJsonError(error);
  }

  try {
    const { accessToken } = await readSupabaseAuthCookies();
    const client = optionalSupabaseAuthClient();
    if (accessToken && client) {
      try {
        await client.signOut(accessToken);
      } catch {
        // La session locale est supprimée même si Supabase est momentanément
        // inaccessible. Le jeton d’accès est court et reste HttpOnly.
      }
    }
    await clearSupabaseAuthCookies();
    if (acceptsHtml) {
      return new Response(null, {
        status: 303,
        headers: { ...authNoStoreHeaders(), Location: destination },
      });
    }
    return Response.json(
      { authenticated: false, redirectTo: destination },
      { headers: authNoStoreHeaders() },
    );
  } catch (error) {
    await clearSupabaseAuthCookies();
    if (acceptsHtml) {
      return new Response(null, {
        status: 303,
        headers: { ...authNoStoreHeaders(), Location: destination },
      });
    }
    return authJsonError(error);
  }
}
