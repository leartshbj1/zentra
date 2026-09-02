import { cookies } from 'next/headers';
import type { SupabaseAuthSession } from './supabase-auth';
import {
  accessCookieMaxAge,
  authCookieOptions,
  PKCE_COOKIE_MAX_AGE,
  REFRESH_COOKIE_MAX_AGE,
  SUPABASE_ACCESS_COOKIE,
  SUPABASE_REFRESH_COOKIE,
  SUPABASE_PKCE_COOKIE,
} from './supabase-auth-cookie-policy';
import { isValidPkceVerifier } from './supabase-auth-pkce';

export async function readSupabaseAuthCookies() {
  const jar = await cookies();
  return {
    accessToken: jar.get(SUPABASE_ACCESS_COOKIE)?.value ?? '',
    refreshToken: jar.get(SUPABASE_REFRESH_COOKIE)?.value ?? '',
  };
}

export async function writeSupabaseAuthCookies(session: SupabaseAuthSession) {
  const jar = await cookies();
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
  jar.set(SUPABASE_ACCESS_COOKIE, '', authCookieOptions(0));
  jar.set(SUPABASE_REFRESH_COOKIE, '', authCookieOptions(0));
  jar.set(SUPABASE_PKCE_COOKIE, '', authCookieOptions(0));
}

export async function writeSupabasePkceCookie(verifier: string) {
  if (!isValidPkceVerifier(verifier)) {
    throw new Error('Le vérificateur PKCE est invalide.');
  }
  const jar = await cookies();
  jar.set(
    SUPABASE_PKCE_COOKIE,
    verifier,
    authCookieOptions(PKCE_COOKIE_MAX_AGE),
  );
}

export async function readSupabasePkceCookie() {
  const jar = await cookies();
  const value = jar.get(SUPABASE_PKCE_COOKIE)?.value ?? '';
  return isValidPkceVerifier(value) ? value : '';
}

export async function clearSupabasePkceCookie() {
  const jar = await cookies();
  jar.set(SUPABASE_PKCE_COOKIE, '', authCookieOptions(0));
}
