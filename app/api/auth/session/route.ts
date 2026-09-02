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

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    requireAuthSameOrigin(request);
    const client = supabaseAuthClient();
    const { accessToken, refreshToken } = await readSupabaseAuthCookies();
    let user: SupabaseAuthUser | null = null;

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
      } catch (error) {
        if (!isRejectedAuthCredential(error)) throw error;
        await clearSupabaseAuthCookies();
      }
    }

    if (!user) {
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
