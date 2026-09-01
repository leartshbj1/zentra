export type StripeWebhookProofRow = {
  endpoint_id: string;
  secret_sha256: string;
  livemode: number;
  api_version: string;
  last_verified_event_id: string;
  verified_at: number;
};

export const STRIPE_WEBHOOK_PROOF_MAX_AGE_SECONDS = 35 * 24 * 60 * 60;

export const SELECT_STRIPE_WEBHOOK_PROOF_SQL = `SELECT endpoint_id,secret_sha256,livemode,api_version,last_verified_event_id,verified_at
FROM stripe_webhook_proofs WHERE endpoint_id=? LIMIT 1`;

export const UPSERT_STRIPE_WEBHOOK_PROOF_SQL = `INSERT INTO stripe_webhook_proofs(
  endpoint_id,secret_sha256,livemode,api_version,last_verified_event_id,verified_at
) VALUES(?,?,?,?,?,?)
ON CONFLICT(endpoint_id) DO UPDATE SET
  secret_sha256=excluded.secret_sha256,
  livemode=excluded.livemode,
  api_version=excluded.api_version,
  last_verified_event_id=excluded.last_verified_event_id,
  verified_at=excluded.verified_at`;

export function stripeWebhookProofMatches(
  row: StripeWebhookProofRow | null,
  expected: {
    endpointId: string;
    secretSha256: string;
    livemode: boolean;
    apiVersion: string;
    now: number;
    maxAgeSeconds?: number;
  },
) {
  const maxAgeSeconds =
    expected.maxAgeSeconds ?? STRIPE_WEBHOOK_PROOF_MAX_AGE_SECONDS;
  return Boolean(
    row &&
    row.endpoint_id === expected.endpointId &&
    /^[A-Za-z0-9_-]{43}$/.test(row.secret_sha256) &&
    row.secret_sha256 === expected.secretSha256 &&
    row.livemode === (expected.livemode ? 1 : 0) &&
    row.api_version === expected.apiVersion &&
    /^evt_[A-Za-z0-9_]+$/.test(row.last_verified_event_id) &&
    Number.isSafeInteger(row.verified_at) &&
    Number.isSafeInteger(expected.now) &&
    Number.isSafeInteger(maxAgeSeconds) &&
    maxAgeSeconds > 0 &&
    row.verified_at <= expected.now + 5 * 60 &&
    row.verified_at >= expected.now - maxAgeSeconds,
  );
}
