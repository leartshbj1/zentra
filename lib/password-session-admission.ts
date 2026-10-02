import { accountSessionAllowed } from './account-session-policy';
import { database } from './runtime';
import { AuthPublicError } from './supabase-auth-http';
import { SupabaseAuthError, type createSupabaseAuthClient, type SupabaseAuthSession } from './supabase-auth';

type PasswordClient = Pick<ReturnType<typeof createSupabaseAuthClient>, 'signIn' | 'refresh'>;
const MAX_BOUNDARY_WAIT_MS = 1_100;
const refused = () => new AuthPublicError('La session n’a pas pu être ouverte. Réessayez de vous connecter dans un instant.', 409);

/** Only a password grant made by this request can use this bounded recovery.
 * Never pass an existing cookie/refresh session through the admission helper.
 */
export async function signInWithSessionPolicy(
  client: PasswordClient,
  email: string,
  password: string,
): Promise<SupabaseAuthSession> {
  const fresh = await client.signIn(email, password);
  if (!fresh.user.emailConfirmed)
    throw new SupabaseAuthError('Confirmez votre adresse e-mail avant de vous connecter.', 403, 'email_not_confirmed');
  const userId = fresh.user.id;
  if (await accountSessionAllowed(userId, fresh.accessToken)) return fresh;

  const policy = await database()
    .prepare('SELECT revoked_before,deleted_at FROM account_session_policy WHERE user_id=?')
    .bind(userId)
    .first<{ revoked_before: number; deleted_at: number | null }>();
  let claims: { sub?: unknown; iat?: unknown };
  try {
    claims = JSON.parse(atob(fresh.accessToken.split('.')[1].replaceAll('-', '+').replaceAll('_', '/')));
  } catch { throw refused(); }
  const currentTime = Date.now();
  if (
    !policy || policy.deleted_at !== null || claims.sub !== userId ||
    !Number.isSafeInteger(claims.iat) || claims.iat !== policy.revoked_before ||
    policy.revoked_before !== Math.floor(currentTime / 1_000)
  ) throw refused();

  const wait = (policy.revoked_before + 1) * 1_000 - currentTime;
  if (wait <= 0 || wait > MAX_BOUNDARY_WAIT_MS) throw refused();
  await new Promise<void>(resolve => setTimeout(resolve, wait));
  // Refresh only the new password-verification session. Supabase may return
  // the same token during its reuse interval; admission must be checked again.
  const renewed = await client.refresh(fresh.refreshToken);
  if (
    renewed.user.id !== userId || renewed.user.email !== fresh.user.email || !renewed.user.emailConfirmed ||
    !(await accountSessionAllowed(userId, renewed.accessToken))
  ) throw refused();
  return renewed;
}
