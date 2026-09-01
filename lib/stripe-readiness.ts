import { assertLicenseSignerReady } from '@/lib/license-token';
import { database, stripeConfiguration } from '@/lib/runtime';
import {
  assertConfiguredStripeAccount,
  PublicError,
  sha256,
} from '@/lib/stripe';
import { stripeSecretKeyLivemode } from '@/lib/stripe-event';

const POSITIVE_CACHE_SECONDS = 60;

let readinessCache:
  | { fingerprint: string; checkedAt: number; promise: Promise<void> }
  | undefined;

function assertConfiguredPublicUrl(siteUrl: string) {
  let url: URL;
  try {
    url = new URL(siteUrl);
  } catch {
    throw new PublicError('L’adresse publique Elyko est invalide.', 503);
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.origin !== siteUrl.replace(/\/$/, '')
  ) {
    throw new PublicError(
      'L’adresse publique Elyko doit être une origine HTTPS exacte.',
      503,
    );
  }
}

async function assertDatabaseSchemaReady() {
  const db = database();
  await db.batch([
    db.prepare(
      'SELECT claim_hash,checkout_session_id,created_at,expires_at FROM checkout_attempts LIMIT 0',
    ),
    db.prepare(
      'SELECT subscription_id,entitlement_valid_until,last_paid_invoice_id,last_paid_at,last_payment_failure_invoice_id,last_payment_failure_at FROM subscriptions LIMIT 0',
    ),
    db.prepare(
      'SELECT license_id,subscription_id,installation_id,last_issued_at FROM license_activations LIMIT 0',
    ),
    db.prepare(
      'SELECT event_id,event_created_at,processing_started_at,processing_attempts,processed_at FROM stripe_events LIMIT 0',
    ),
    db.prepare(
      'SELECT rate_key,count,window_started_at,expires_at FROM checkout_rate_limits LIMIT 0',
    ),
  ]);
}

async function runReadinessChecks() {
  const { secretKey, webhookSecret, priceId, signingKey, siteUrl } =
    stripeConfiguration();
  if (stripeSecretKeyLivemode(secretKey) === null)
    throw new PublicError('La clé serveur Stripe est invalide.', 503);
  if (!/^whsec_[A-Za-z0-9]+$/.test(webhookSecret))
    throw new PublicError('Le secret du webhook Stripe est invalide.', 503);
  if (!/^price_[A-Za-z0-9_]+$/.test(priceId))
    throw new PublicError('Le prix Stripe Elyko est invalide.', 503);
  if (!/^[A-Za-z0-9_-]{40,256}$/.test(signingKey))
    throw new PublicError('La clé de signature Elyko est invalide.', 503);
  assertConfiguredPublicUrl(siteUrl);
  await Promise.all([
    assertConfiguredStripeAccount(),
    assertLicenseSignerReady(),
    assertDatabaseSchemaReady(),
  ]);
}

export async function assertStripeCheckoutReady() {
  const configuration = stripeConfiguration();
  const fingerprint = await sha256(
    [
      configuration.secretKey,
      configuration.webhookSecret,
      configuration.priceId,
      configuration.signingKey,
      configuration.siteUrl,
    ].join('\u0000'),
  );
  const now = Math.floor(Date.now() / 1000);
  if (
    readinessCache?.fingerprint === fingerprint &&
    now - readinessCache.checkedAt < POSITIVE_CACHE_SECONDS
  ) {
    return readinessCache.promise;
  }
  const promise = runReadinessChecks();
  readinessCache = { fingerprint, checkedAt: now, promise };
  try {
    await promise;
  } catch (error) {
    if (readinessCache?.promise === promise) readinessCache = undefined;
    throw error;
  }
}

export async function stripeCheckoutIsReady() {
  try {
    await assertStripeCheckoutReady();
    return true;
  } catch (error) {
    console.error('Stripe readiness check failed', {
      type: error instanceof Error ? error.name : 'UnknownError',
      status: error instanceof PublicError ? error.status : 500,
    });
    return false;
  }
}
