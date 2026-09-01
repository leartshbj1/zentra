import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  SELECT_STRIPE_WEBHOOK_PROOF_SQL,
  stripeWebhookProofMatches,
  type StripeWebhookProofRow,
  UPSERT_STRIPE_WEBHOOK_PROOF_SQL,
} from './stripe-webhook-proof';

describe('Stripe webhook secret proof', () => {
  it('accepts only a proof tied to the exact endpoint, secret, mode and API version', () => {
    const row: StripeWebhookProofRow = {
      endpoint_id: 'we_current',
      secret_sha256: 'a'.repeat(43),
      livemode: 0,
      api_version: '2026-08-26.dahlia',
      last_verified_event_id: 'evt_canary',
      verified_at: 1_788_000_000,
    };
    const expected = {
      endpointId: 'we_current',
      secretSha256: 'a'.repeat(43),
      livemode: false,
      apiVersion: '2026-08-26.dahlia',
      now: 1_788_000_100,
    };

    expect(stripeWebhookProofMatches(row, expected)).toBe(true);
    expect(
      stripeWebhookProofMatches(
        { ...row, secret_sha256: 'b'.repeat(43) },
        expected,
      ),
    ).toBe(false);
    expect(
      stripeWebhookProofMatches({ ...row, endpoint_id: 'we_other' }, expected),
    ).toBe(false);
    expect(stripeWebhookProofMatches({ ...row, livemode: 1 }, expected)).toBe(
      false,
    );
    expect(
      stripeWebhookProofMatches(
        { ...row, verified_at: expected.now - 1_001 },
        { ...expected, maxAgeSeconds: 1_000 },
      ),
    ).toBe(false);
    expect(
      stripeWebhookProofMatches(
        { ...row, verified_at: expected.now + 301 },
        expected,
      ),
    ).toBe(false);
  });

  it('upserts the last verified delivery without preserving an old secret', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE stripe_webhook_proofs(
      endpoint_id TEXT PRIMARY KEY NOT NULL,
      secret_sha256 TEXT NOT NULL,
      livemode INTEGER NOT NULL,
      api_version TEXT NOT NULL,
      last_verified_event_id TEXT NOT NULL,
      verified_at INTEGER NOT NULL
    )`);
    const upsert = db.prepare(UPSERT_STRIPE_WEBHOOK_PROOF_SQL);
    upsert.run(
      'we_current',
      'a'.repeat(43),
      0,
      '2026-08-26.dahlia',
      'evt_first',
      10,
    );
    upsert.run(
      'we_current',
      'b'.repeat(43),
      0,
      '2026-08-26.dahlia',
      'evt_second',
      20,
    );

    expect(
      db
        .prepare(SELECT_STRIPE_WEBHOOK_PROOF_SQL)
        .get('we_current') as StripeWebhookProofRow,
    ).toMatchObject({
      secret_sha256: 'b'.repeat(43),
      last_verified_event_id: 'evt_second',
      verified_at: 20,
    });
  });
});
