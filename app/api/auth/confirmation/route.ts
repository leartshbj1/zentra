import {
  clearSupabasePkceCookie,
  readSupabasePkceCookie,
  readSupabaseAuthReturnCookie,
  writeSupabaseAuthCookies,
  writeSupabaseRecoveryCookie,
} from '@/lib/supabase-auth-cookies';
import {
  authNoStoreHeaders,
  safeAuthReturnPath,
} from '@/lib/supabase-auth-http';
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
  const returnTo = safeAuthReturnPath(await readSupabaseAuthReturnCookie());
  if (!verifier) {
    return confirmationFailure('navigateur_different');
  }
  if (!isValidSupabaseAuthCode(authCode)) {
    return confirmationFailure('code_invalide');
  }
  await clearSupabasePkceCookie();

  try {
    const session = await supabaseAuthClient().exchangePkceCode(
      authCode,
      verifier,
    );
    if (returnTo === '/mot-de-passe/nouveau') {
      await writeSupabaseRecoveryCookie(session);
    } else {
      await writeSupabaseAuthCookies(session, true);
    }
    return redirectResponse(returnTo);
  } catch {
    if (returnTo === '/mot-de-passe/nouveau')
      return redirectResponse('/mot-de-passe/nouveau?erreur=lien_invalide');
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
