import { AccountPublicError, sha256Hex } from './account-security';
import { database } from './runtime';

const PERIOD_SECONDS = 30 * 60;
export const PASSWORD_RECOVERY_MAX_REQUESTS = 5;

// Five requests in a 30-minute window, followed by a full 30-minute cooldown
// from the fifth request. Rejected retries never extend that cooldown.
async function consumeRecoveryAllowance(
  scope: string,
  subject: string,
  maximum: number,
) {
  const now = Math.floor(Date.now() / 1000);
  const key = await sha256Hex(`zentra-recovery-rate-v2:${scope}:${subject}`);
  const db = database();
  const accepted = await db
    .prepare(`
    INSERT INTO checkout_rate_limits(rate_key,count,window_started_at,expires_at)
    VALUES(?,1,?,?)
    ON CONFLICT(rate_key) DO UPDATE SET
      count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END,
      window_started_at=CASE WHEN expires_at<=? THEN ? ELSE window_started_at END,
      expires_at=CASE WHEN expires_at<=? OR count+1=? THEN ? ELSE expires_at END
    WHERE expires_at<=? OR count<?
    RETURNING count,expires_at
  `)
    .bind(
      key,
      now,
      now + PERIOD_SECONDS,
      now,
      now,
      now,
      now,
      maximum,
      now + PERIOD_SECONDS,
      now,
      maximum,
    )
    .first<{ count: number; expires_at: number }>();
  if (accepted) return;
  const row = await db
    .prepare('SELECT expires_at FROM checkout_rate_limits WHERE rate_key=?')
    .bind(key)
    .first<{ expires_at: number }>();
  const retryAfterSeconds = Math.max(
    1,
    (row?.expires_at ?? now + PERIOD_SECONDS) - now,
  );
  const minutes = Math.ceil(retryAfterSeconds / 60);
  throw new AccountPublicError(
    scope === 'email'
      ? `Vous avez atteint la limite de 5 demandes. Réessayez dans ${minutes} minute${minutes > 1 ? 's' : ''}.`
      : `Trop de demandes depuis cette connexion. Réessayez dans ${minutes} minute${minutes > 1 ? 's' : ''}.`,
    429,
    retryAfterSeconds,
  );
}

export async function enforcePasswordRecoveryRateLimit(
  request: Request,
  email: string,
) {
  const address = request.headers.get('CF-Connecting-IP')?.trim() || 'unknown';
  // A separate network budget limits bulk requests to different addresses.
  await consumeRecoveryAllowance('address', address, 20);
  await consumeRecoveryAllowance(
    'email',
    email.trim().toLowerCase(),
    PASSWORD_RECOVERY_MAX_REQUESTS,
  );
}
