import { describe, expect, it, vi } from 'vitest';

const stubs = vi.hoisted(() => ({
  account: vi.fn(async () => ({
    portalLoginUrl: 'https://billing.stripe.com/p/login/elyko',
  })),
  portal: vi.fn(async () => 'https://billing.stripe.com/p/login/elyko'),
  signer: vi.fn(async () => undefined),
  batch: vi.fn(async () => []),
  proof: {
    endpoint_id: 'we_valid',
    secret_sha256: 'a'.repeat(43),
    livemode: 0,
    api_version: '2026-08-26.dahlia',
    last_verified_event_id: 'evt_canary',
    verified_at: 1_788_000_000,
  },
}));

vi.mock('@/lib/license-token', () => ({
  assertLicenseSignerReady: stubs.signer,
}));

vi.mock('@/lib/runtime', () => ({
  database: () => ({
    prepare: (sql: string) => ({
      sql,
      bind: () => ({ first: async () => stubs.proof }),
    }),
    batch: stubs.batch,
  }),
  stripeConfiguration: () => ({
    secretKey: 'sk_test_valid',
    webhookSecret: 'whsec_valid',
    webhookEndpointId: 'we_valid',
    priceId: 'price_valid',
    signingKey: 'A'.repeat(40),
    siteUrl: 'https://elyko.example',
  }),
}));

vi.mock('@/lib/stripe', () => {
  class PublicError extends Error {
    constructor(
      message: string,
      public readonly status: number,
    ) {
      super(message);
    }
  }
  return {
    assertConfiguredStripeAccount: stubs.account,
    assertConfiguredStripePortalLoginUrl: stubs.portal,
    PublicError,
    sha256: vi.fn(async (value: string) =>
      value === 'whsec_valid' ? 'a'.repeat(43) : 'configuration-fingerprint',
    ),
    STRIPE_API_VERSION: '2026-08-26.dahlia',
  };
});

vi.mock('@/lib/stripe-event', () => ({
  stripeSecretKeyLivemode: vi.fn(() => false),
}));

vi.mock('@/lib/stripe-webhook-proof', () => ({
  SELECT_STRIPE_WEBHOOK_PROOF_SQL:
    'SELECT * FROM stripe_webhook_proofs WHERE endpoint_id=?',
  stripeWebhookProofMatches: (
    row: typeof stubs.proof | null,
    expected: {
      endpointId: string;
      secretSha256: string;
      livemode: boolean;
      apiVersion: string;
      now: number;
    },
  ) =>
    Boolean(
      row &&
      row.endpoint_id === expected.endpointId &&
      row.secret_sha256 === expected.secretSha256 &&
      row.livemode === (expected.livemode ? 1 : 0) &&
      row.api_version === expected.apiVersion &&
      row.verified_at <= expected.now + 300,
    ),
}));

import {
  assertStripeCheckoutReady,
  stripeCheckoutReadiness,
  stripePortalLoginUrl,
} from './stripe-readiness';

describe('Stripe checkout readiness', () => {
  it('keeps the cancellation portal available when Checkout is down', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubs.signer.mockRejectedValueOnce(new Error('signer unavailable'));

    await expect(stripeCheckoutReadiness()).resolves.toBeNull();
    await expect(stripePortalLoginUrl()).resolves.toBe(
      'https://billing.stripe.com/p/login/elyko',
    );
    expect(stubs.portal).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('returns the validated portal result instead of discarding it', async () => {
    const expected = {
      portalLoginUrl: 'https://billing.stripe.com/p/login/elyko',
    };

    await expect(assertStripeCheckoutReady()).resolves.toEqual(expected);
    await expect(stripeCheckoutReadiness()).resolves.toEqual(expected);
    expect(stubs.account).toHaveBeenCalledTimes(2);
  });
});
