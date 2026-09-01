import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { constructVerifiedStripeEvent } from './stripe-webhook';

const client = new Stripe('sk_test_unit_only', {
  apiVersion: '2026-08-26.dahlia',
});
const webhookSecret = 'whsec_unit_test_only';
const now = Math.floor(Date.now() / 1000);

function body(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: 'evt_unit',
    object: 'event',
    api_version: '2026-08-26.dahlia',
    created: now,
    data: { object: { id: 'in_unit', object: 'invoice' } },
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type: 'invoice.paid',
    ...overrides,
  });
}

function signature(payload: string, timestamp = now) {
  return Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: webhookSecret,
    timestamp,
  });
}

function verify(
  payload: string,
  header: string,
  overrides: Partial<{
    expectedLivemode: boolean;
    expectedApiVersion: string;
  }> = {},
) {
  return constructVerifiedStripeEvent({
    client,
    rawBody: payload,
    signatureHeader: header,
    webhookSecret,
    toleranceSeconds: 300,
    expectedLivemode: false,
    expectedApiVersion: '2026-08-26.dahlia',
    ...overrides,
  });
}

describe('Stripe webhook verification', () => {
  it('accepts an exactly signed Dahlia event in the expected mode', async () => {
    const payload = body();
    await expect(verify(payload, signature(payload))).resolves.toMatchObject({
      id: 'evt_unit',
      api_version: '2026-08-26.dahlia',
      livemode: false,
    });
  });

  it('rejects an altered body', async () => {
    const payload = body();
    await expect(verify(`${payload} `, signature(payload))).rejects.toThrow();
  });

  it('rejects an expired signature timestamp', async () => {
    const payload = body();
    await expect(
      verify(payload, signature(payload, now - 301)),
    ).rejects.toThrow();
  });

  it('rejects a valid signature from the wrong API version', async () => {
    const payload = body({ api_version: '2025-03-31.basil' });
    await expect(verify(payload, signature(payload))).rejects.toThrow(
      'API version mismatch',
    );
  });

  it('rejects a valid signature from the wrong Stripe mode', async () => {
    const payload = body({ livemode: true });
    await expect(verify(payload, signature(payload))).rejects.toThrow(
      'mode mismatch',
    );
  });
});
