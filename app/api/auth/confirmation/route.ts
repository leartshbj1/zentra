import {
  clearSupabasePkceCookie,
  readSupabasePkceCookie,
  writeSupabaseAuthCookies,
} from '@/lib/supabase-auth-cookies';
import { authNoStoreHeaders } from '@/lib/supabase-auth-http';
import { isValidSupabaseAuthCode } from '@/lib/supabase-auth-pkce';
import { supabaseAuthClient } from '@/lib/supabase-auth-runtime';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const codes = requestUrl.searchParams.getAll('code');
  const authCode = codes.length === 1 ? codes[0] : '';

  if (requestUrl.searchParams.has('error')) {
    await clearSupabasePkceCookie();
    return confirmationFailure('lien_refuse');
  }

  const verifier = await readSupabasePkceCookie();
  await clearSupabasePkceCookie();
  if (!verifier) {
    return confirmationFailure('navigateur_different');
  }
  if (!isValidSupabaseAuthCode(authCode)) {
    return confirmationFailure('code_invalide');
  }

  try {
    const session = await supabaseAuthClient().exchangePkceCode(
      authCode,
      verifier,
    );
    await writeSupabaseAuthCookies(session);
    return redirectResponse('/compte');
  } catch {
    return confirmationFailure('echange_echoue');
  }
}

function confirmationFailure(reason: string) {
  const location = new URL('/connexion', 'https://zentra.local');
  location.searchParams.set('erreur', reason);
  return redirectResponse(`${location.pathname}${location.search}`);
}

function redirectResponse(location: string) {
  return new Response(null, {
    status: 303,
    headers: {
      ...authNoStoreHeaders(),
      Location: location,
    },
  });
}
