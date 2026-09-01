import { readFileSync } from 'node:fs';
import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';

describe('Stripe SDK and webhook version contract', () => {
  it('forces a deliberate endpoint upgrade when the Stripe SDK version changes', () => {
    const stripeSource = readFileSync(
      new URL('./stripe.ts', import.meta.url),
      'utf8',
    );
    expect(stripeSource).toContain(
      `export const STRIPE_API_VERSION = '${Stripe.API_VERSION}';`,
    );
  });

  it('keeps license renewal independent from webhook delivery', () => {
    const licenseSource = readFileSync(
      new URL('./license-token.ts', import.meta.url),
      'utf8',
    );
    expect(licenseSource).toContain(
      'const latestInvoice = await retrieveInvoice(latestInvoiceId);',
    );
    expect(licenseSource).toContain(
      'const paidThrough = validatePaidZentraInvoice(latestInvoice, subscription);',
    );
    expect(licenseSource).toContain(
      'await upsertSubscription(subscription, null, {',
    );
  });
});
