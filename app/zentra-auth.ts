import { redirect } from 'next/navigation';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import {
  clearSupabaseAuthCookies,
  readSupabaseAuthCookies,
  writeSupabaseAuthCookies,
} from '@/lib/supabase-auth-cookies';
import {
  isRejectedAuthCredential,
  safeAuthReturnPath,
} from '@/lib/supabase-auth-http';
import { optionalSupabaseAuthClient } from '@/lib/supabase-auth-runtime';
import type { SupabaseAuthUser } from '@/lib/supabase-auth';

export type ZentraUser = {
  userId: string;
  displayName: string;
  email: string;
  fullName: string | null;
  provider: 'supabase' | 'sites';
  emailConfirmed: boolean;
};

type ZentraUserOptions = {
  refreshSession?: boolean;
};

function fromSupabaseUser(user: SupabaseAuthUser): ZentraUser {
  return {
    // Une adresse peut être modifiée ou réattribuée. Une future migration
    // SIWC devra prouver les deux identités et persister un lien explicite.
    userId: user.id,
    displayName: user.displayName,
    email: user.email,
    fullName:
      user.displayName && user.displayName !== user.email
        ? user.displayName
        : null,
    provider: 'supabase',
    emailConfirmed: user.emailConfirmed,
  };
}

export async function getZentraUser(
  options: ZentraUserOptions = {},
): Promise<ZentraUser | null> {
  const { accessToken, refreshToken } = await readSupabaseAuthCookies();
  const client = optionalSupabaseAuthClient();
  if (accessToken) {
    if (!client) return null;
    try {
      const user = await client.getUser(accessToken);
      return fromSupabaseUser(user);
    } catch (error) {
      if (!isRejectedAuthCredential(error)) throw error;
    }
  }

  if (refreshToken && options.refreshSession) {
    if (!client) return null;
    try {
      const renewed = await client.refresh(refreshToken);
      await writeSupabaseAuthCookies(renewed);
      return fromSupabaseUser(renewed.user);
    } catch (error) {
      if (!isRejectedAuthCredential(error)) throw error;
      await clearSupabaseAuthCookies();
    }
  }

  if ((accessToken || refreshToken) && options.refreshSession && !refreshToken) {
    await clearSupabaseAuthCookies();
  }

  // Dès qu’une session Supabase existe, même expirée, ne jamais la remplacer
  // silencieusement par l’identité Sites. Les pages passent par /connexion,
  // dont la route de session renouvelle le refresh token de façon atomique.
  if (accessToken || refreshToken) return null;

  const sitesUser = await getChatGPTUser();
  return sitesUser
    ? {
        ...sitesUser,
        provider: 'sites',
        emailConfirmed: true,
      }
    : null;
}

export async function requireZentraUser(returnTo: string): Promise<ZentraUser> {
  const user = await getZentraUser();
  if (user) return user;
  redirect(zentraSignInPath(returnTo));
}

export function zentraSignInPath(returnTo = '/compte') {
  return `/connexion?retour=${encodeURIComponent(safeAuthReturnPath(returnTo))}`;
}
