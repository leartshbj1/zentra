import { cookies } from 'next/headers';
import { SupabaseAuthError, type SupabaseAuthSession } from './supabase-auth';
import {
  accessCookieMaxAge,
  authCookieOptions,
  PKCE_COOKIE_MAX_AGE,
  REFRESH_COOKIE_MAX_AGE,
  SUPABASE_ACCESS_COOKIE,
  SUPABASE_REFRESH_COOKIE,
  SUPABASE_PKCE_COOKIE,
  SUPABASE_AUTH_RETURN_COOKIE,
  SUPABASE_SIGNED_OUT_COOKIE,
  SUPABASE_SESSION_OWNER_COOKIE,
  SESSION_OWNER_COOKIE_MAX_AGE,
  validSessionOwner,
  SUPABASE_RECOVERY_COOKIE,
  RECOVERY_COOKIE_MAX_AGE,
} from './supabase-auth-cookie-policy';
import { isValidPkceVerifier } from './supabase-auth-pkce';

export async function readSupabaseAuthCookies() {
  const jar = await cookies();
  const owner = jar.get(SUPABASE_SESSION_OWNER_COOKIE)?.value ?? '';
  return {
    accessToken: jar.get(SUPABASE_ACCESS_COOKIE)?.value ?? '',
    refreshToken: jar.get(SUPABASE_REFRESH_COOKIE)?.value ?? '',
    signedOut: jar.get(SUPABASE_SIGNED_OUT_COOKIE)?.value === '1',
    sessionOwnerId: validSessionOwner(owner) ? owner : '',
  };
}

export async function writeSupabaseAuthCookies(
  session: SupabaseAuthSession,
  explicitSignIn = false,
) {
  if (!session.user.emailConfirmed)
    throw new SupabaseAuthError(
      'Confirmez votre adresse e-mail avant de vous connecter.',
      403,
      'email_not_confirmed',
    );
  const jar = await cookies();
  if (explicitSignIn) {
    if (!validSessionOwner(session.user.id))
      throw new SupabaseAuthError('L’identité de la session est invalide. Reconnectez-vous.', 502, 'invalid_user_response');
    // This binding only narrows a provider-verified identity; it never grants access.
    jar.set(SUPABASE_SESSION_OWNER_COOKIE, session.user.id, authCookieOptions(SESSION_OWNER_COOKIE_MAX_AGE));
    jar.set(SUPABASE_SIGNED_OUT_COOKIE, '', authCookieOptions(0));
    jar.set(SUPABASE_RECOVERY_COOKIE, '', authCookieOptions(0));
  } else if (jar.get(SUPABASE_SESSION_OWNER_COOKIE)?.value !== session.user.id || !validSessionOwner(session.user.id)) {
    throw new SupabaseAuthError('Reconnectez-vous pour vérifier la session.', 401, 'session_owner_mismatch');
  }
  jar.set(
    SUPABASE_ACCESS_COOKIE,
    session.accessToken,
    authCookieOptions(accessCookieMaxAge(session)),
  );
  jar.set(
    SUPABASE_REFRESH_COOKIE,
    session.refreshToken,
    authCookieOptions(REFRESH_COOKIE_MAX_AGE),
  );
}

export async function clearSupabaseAuthCookies() {
  const jar = await cookies();
  // Keep the fixed owner barrier: an old automatic response must not erase
  // a later explicit login's binding. signed_out still takes precedence.
  jar.set(SUPABASE_ACCESS_COOKIE, '', authCookieOptions(0));
  jar.set(SUPABASE_REFRESH_COOKIE, '', authCookieOptions(0));
  jar.set(SUPABASE_PKCE_COOKIE, '', authCookieOptions(0));
  jar.set(SUPABASE_AUTH_RETURN_COOKIE, '', authCookieOptions(0));
  jar.set(SUPABASE_RECOVERY_COOKIE, '', authCookieOptions(0));
  // A late refresh response or a legacy Sites identity must not undo logout.
  jar.set(
    SUPABASE_SIGNED_OUT_COOKIE,
    '1',
    authCookieOptions(REFRESH_COOKIE_MAX_AGE),
  );
}

export async function writeSupabaseRecoveryCookie(
  session: SupabaseAuthSession,
) {
  if (!session.user.emailConfirmed)
    throw new SupabaseAuthError('Lien invalide.', 403);
  await clearSupabaseAuthCookies();
  const jar = await cookies();
  jar.set(
    SUPABASE_RECOVERY_COOKIE,
    session.accessToken,
    authCookieOptions(
      Math.min(RECOVERY_COOKIE_MAX_AGE, accessCookieMaxAge(session)),
    ),
  );
}

export async function readSupabaseRecoveryCookie() {
  return (await cookies()).get(SUPABASE_RECOVERY_COOKIE)?.value ?? '';
}

export async function writeSupabasePkceCookie(
  verifier: string,
  returnTo = '/compte',
) {
  if (!isValidPkceVerifier(verifier)) {
    throw new Error('Le vérificateur PKCE est invalide.');
  }
  const jar = await cookies();
  jar.set(
    SUPABASE_PKCE_COOKIE,
    verifier,
    authCookieOptions(PKCE_COOKIE_MAX_AGE),
  );
  jar.set(
    SUPABASE_AUTH_RETURN_COOKIE,
    returnTo,
    authCookieOptions(PKCE_COOKIE_MAX_AGE),
  );
}

export async function readSupabaseAuthReturnCookie() {
  const jar = await cookies();
  return jar.get(SUPABASE_AUTH_RETURN_COOKIE)?.value ?? '/compte';
}

export async function readSupabasePkceCookie() {
  const jar = await cookies();
  const value = jar.get(SUPABASE_PKCE_COOKIE)?.value ?? '';
  return isValidPkceVerifier(value) ? value : '';
}

export async function clearSupabasePkceCookie() {
  const jar = await cookies();
  jar.set(SUPABASE_PKCE_COOKIE, '', authCookieOptions(0));
  jar.set(SUPABASE_AUTH_RETURN_COOKIE, '', authCookieOptions(0));
}
