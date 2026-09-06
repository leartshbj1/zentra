import { getZentraUser } from '@/app/zentra-auth';
import { enforceAccountRateLimit } from '@/lib/account';
import { database } from '@/lib/runtime';
import { readJsonObjectWithinLimit } from '@/lib/request-body';
import {
  authJsonError,
  authNoStoreHeaders,
  AuthPublicError,
  requireAuthSameOrigin,
} from '@/lib/supabase-auth-http';
import {
  clearSupabaseAuthCookies,
  readSupabaseAuthCookies,
  writeSupabasePkceCookie,
} from '@/lib/supabase-auth-cookies';
import { createSupabasePkceFlow } from '@/lib/supabase-auth-pkce';
import {
  MAX_AUTH_PASSWORD_LENGTH,
  MIN_AUTH_PASSWORD_LENGTH,
} from '@/lib/supabase-auth-policy';
import {
  supabaseAuthClient,
  supabaseAuthSiteOrigin,
} from '@/lib/supabase-auth-runtime';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    requireAuthSameOrigin(request, { requireOrigin: true });
    const origin = supabaseAuthSiteOrigin(request);
    if (new URL(request.url).origin !== origin)
      throw new AuthPublicError('Origine de la demande refusée.', 403);
    const body = await readJsonObjectWithinLimit(request, 4_096);
    const email =
      typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new AuthPublicError('Saisissez une adresse e-mail valide.');
    await Promise.all([
      enforceAccountRateLimit(request, 'auth-recovery-email', email, 3),
      enforceAccountRateLimit(request, 'auth-recovery-address', 'all', 10),
    ]);
    const pkce = await createSupabasePkceFlow();
    await supabaseAuthClient().requestPasswordReset(email, {
      emailRedirectTo: new URL('/api/auth/confirmation', origin).href,
      codeChallenge: pkce.challenge,
    });
    await writeSupabasePkceCookie(pkce.verifier, '/mot-de-passe/nouveau');
    return Response.json(
      { requested: true },
      { headers: authNoStoreHeaders() },
    );
  } catch (error) {
    return authJsonError(error);
  }
}

export async function PUT(request: Request) {
  try {
    requireAuthSameOrigin(request, { requireOrigin: true });
    const user = await getZentraUser({ refreshSession: true });
    if (!user || user.provider !== 'supabase' || !user.emailConfirmed)
      throw new AuthPublicError(
        'Ouvrez le lien reçu par e-mail pour choisir votre mot de passe.',
        401,
      );
    const body = await readJsonObjectWithinLimit(request, 4_096);
    const password = typeof body.password === 'string' ? body.password : '';
    if (
      password.length < MIN_AUTH_PASSWORD_LENGTH ||
      password.length > MAX_AUTH_PASSWORD_LENGTH
    )
      throw new AuthPublicError(
        `Le mot de passe doit contenir entre ${MIN_AUTH_PASSWORD_LENGTH} et ${MAX_AUTH_PASSWORD_LENGTH} caractères.`,
      );
    await enforceAccountRateLimit(
      request,
      'auth-password-update',
      user.userId,
      5,
    );
    const { accessToken } = await readSupabaseAuthCookies();
    const client = supabaseAuthClient();
    await client.updatePassword(accessToken, password);
    await database()
      .prepare(
        'UPDATE device_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL',
      )
      .bind(Math.floor(Date.now() / 1000), user.userId)
      .run();
    await client.signOut(accessToken, 'global');
    await clearSupabaseAuthCookies();
    return Response.json({ updated: true }, { headers: authNoStoreHeaders() });
  } catch (error) {
    return authJsonError(error);
  }
}
