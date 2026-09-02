import type { SupabaseAuthSession } from './supabase-auth';

export const SUPABASE_ACCESS_COOKIE = '__Host-zentra_access';
export const SUPABASE_REFRESH_COOKIE = '__Host-zentra_refresh';
export const SUPABASE_PKCE_COOKIE = '__Host-zentra_pkce';
export const REFRESH_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;
export const PKCE_COOKIE_MAX_AGE = 10 * 60;

export function authCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: Math.max(0, Math.floor(maxAge)),
  };
}

export function accessCookieMaxAge(
  session: Pick<SupabaseAuthSession, 'expiresIn' | 'expiresAt'>,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  const fromExpiry = session.expiresAt
    ? session.expiresAt - nowSeconds
    : session.expiresIn;
  return Math.max(60, Math.min(7 * 24 * 60 * 60, Math.floor(fromExpiry)));
}
