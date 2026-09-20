import {
  clearSupabaseAuthCookies,
  readSupabaseAuthCookies,
  writeSupabaseAuthCookies,
} from '@/lib/supabase-auth-cookies';
import {
  authJsonError,
  authNoStoreHeaders,
  isRejectedAuthCredential,
  publicAuthUser,
  requireAuthSameOrigin,
} from '@/lib/supabase-auth-http';
import { supabaseAuthClient } from '@/lib/supabase-auth-runtime';
import type { SupabaseAuthUser } from '@/lib/supabase-auth';
import { accountSessionAllowed } from '@/lib/account-session-policy';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    requireAuthSameOrigin(request);
    const { accessToken, refreshToken, signedOut } =
      await readSupabaseAuthCookies();
    if (signedOut || (!accessToken && !refreshToken)) {
      return Response.json(
        { authenticated: false },
        { headers: authNoStoreHeaders() },
      );
    }
    const client = supabaseAuthClient();
    let user: SupabaseAuthUser | null = null;
    let verifiedToken = accessToken || '';

    if (accessToken) {
      try {
        user = await client.getUser(accessToken);
      } catch (error) {
        if (!isRejectedAuthCredential(error)) throw error;
        user = null;
      }
    }

    if (!user && refreshToken) {
      try {
        const renewed = await client.refresh(refreshToken);
        await writeSupabaseAuthCookies(renewed);
        user = renewed.user;
        verifiedToken = renewed.accessToken;
      } catch (error) {
        if (!isRejectedAuthCredential(error)) throw error;
        await clearSupabaseAuthCookies();
      }
    }

    if (!user?.emailConfirmed || !(await accountSessionAllowed(user.id, verifiedToken))) {
      if (accessToken || refreshToken) await clearSupabaseAuthCookies();
      return Response.json(
        { authenticated: false },
        { headers: authNoStoreHeaders() },
      );
    }
    return Response.json(
      { authenticated: true, user: publicAuthUser(user) },
      { headers: authNoStoreHeaders() },
    );
  } catch (error) {
    return authJsonError(error);
  }
}
