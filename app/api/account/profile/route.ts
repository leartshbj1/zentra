import { getZentraUser } from '@/app/zentra-auth';
import { enforceAccountRateLimit, normalizedEmail } from '@/lib/account';
import { database } from '@/lib/runtime';
import { readJsonObjectWithinLimit } from '@/lib/request-body';
import { clearSupabaseAuthCookies, readSupabaseAuthCookies } from '@/lib/supabase-auth-cookies';
import { supabaseAuthClient, supabaseAuthSiteOrigin } from '@/lib/supabase-auth-runtime';
import { authJsonError, authNoStoreHeaders, AuthPublicError, requireAuthSameOrigin } from '@/lib/supabase-auth-http';
import { MAX_AUTH_PASSWORD_LENGTH, MIN_AUTH_PASSWORD_LENGTH } from '@/lib/supabase-auth-policy';
import { revokeAccountSessions } from '@/lib/account-session-policy';
export const dynamic = 'force-dynamic';
export async function PUT(request: Request) {
  try {
    requireAuthSameOrigin(request, { requireOrigin: true });
    const user = await getZentraUser({ refreshSession: true });
    if (!user || user.provider !== 'supabase') throw new AuthPublicError('Reconnectez-vous pour modifier votre compte.', 401);
    const body = await readJsonObjectWithinLimit(request, 4096);
    if (body.expectedUserId !== user.userId) throw new AuthPublicError('Le compte a changé dans un autre onglet. Rechargez cette page.', 409);
    const client = supabaseAuthClient();
    await enforceAccountRateLimit(request, 'account-profile', user.userId, 10);
    if (body.action === 'name') {
      const name = typeof body.displayName === 'string' ? body.displayName.trim() : '';
      if (!name || name.length > 120) throw new AuthPublicError('Saisissez votre nom (120 caractères maximum).');
      const { accessToken } = await readSupabaseAuthCookies();
      if (!accessToken) throw new AuthPublicError('Reconnectez-vous avant d’enregistrer.', 401);
      await client.updateProfile(accessToken, name);
      await database().prepare('UPDATE organization_members SET display_name=? WHERE user_id=?').bind(name, user.userId).run();
      return Response.json({ updated: true }, { headers: authNoStoreHeaders() });
    }
    if (!['email', 'password', 'signout-all'].includes(String(body.action))) throw new AuthPublicError('Choisissez une action disponible.');
    const password = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    if (!password || password.length > MAX_AUTH_PASSWORD_LENGTH) throw new AuthPublicError('Saisissez votre mot de passe actuel.');
    // Reauthenticate using the server identity, never an email supplied by the caller.
    const fresh = await client.signIn(user.email, password);
    try {
      if (fresh.user.id !== user.userId || !fresh.user.emailConfirmed)
        throw new AuthPublicError('L’identité du compte doit être vérifiée. Reconnectez-vous.', 403);
      if (body.action === 'email') {
        const email = normalizedEmail(typeof body.email === 'string' ? body.email : '');
        if (email === user.email) throw new AuthPublicError('Cette adresse est déjà celle de votre compte.');
        await client.updateEmail(fresh.accessToken, email, `${supabaseAuthSiteOrigin(request)}/compte/profil`);
        return Response.json({ confirmationRequired: true }, { headers: authNoStoreHeaders() });
      }
      if (body.action === 'password') {
        const next = typeof body.password === 'string' ? body.password : '';
        if (next.length < MIN_AUTH_PASSWORD_LENGTH || next.length > MAX_AUTH_PASSWORD_LENGTH)
          throw new AuthPublicError(`Choisissez un mot de passe de ${MIN_AUTH_PASSWORD_LENGTH} à ${MAX_AUTH_PASSWORD_LENGTH} caractères.`);
        await client.updatePassword(fresh.accessToken, next);
      }
      await revokeAccountSessions(user.userId);
      await client.signOut(fresh.accessToken, 'global');
      await clearSupabaseAuthCookies();
      return Response.json({ updated: true, signedOut: true }, { headers: authNoStoreHeaders() });
    } finally {
      // Do not leave the extra password-verification session active.
      await client.signOut(fresh.accessToken, 'local').catch(() => undefined);
    }
  } catch (error) { return authJsonError(error); }
}
