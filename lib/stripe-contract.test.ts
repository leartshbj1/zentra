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
    expect(licenseSource).toContain('access_role: input.accessRole');
    expect(licenseSource).toContain('account_user_id: accountUserId');
    expect(licenseSource).toContain('account_session_id: accountSessionId');
    expect(licenseSource).toContain('AND member.revoked_at IS NULL');
    expect(licenseSource).toContain(
      'AND session.session_id=? AND session.user_id=?',
    );
    expect(licenseSource).toContain(
      'Cette ancienne licence n’est pas liée précisément au compte.',
    );
    expect(licenseSource).toContain('accessRole = accountAccess.role');

    const pollSource = readFileSync(
      new URL('../app/api/account/device/poll/route.ts', import.meta.url),
      'utf8',
    );
    expect(pollSource).toContain(
      'accountUserId: authorization.approved_by_user_id',
    );
    expect(pollSource).toContain('accountSessionId: sessionId');
  });

  it('keeps retained invoice downloads independent from an active subscription', () => {
    const archiveSource = readFileSync(
      new URL(
        '../app/api/archive/account/[archiveId]/route.ts',
        import.meta.url,
      ),
      'utf8',
    );
    expect(archiveSource).toContain('getZentraUser');
    expect(archiveSource).toContain('member.revoked_at IS NULL');
    expect(archiveSource).not.toContain('requireDeviceSession');
    expect(archiveSource).not.toContain('entitlement_valid_until');
  });

  it('binds a checkout claim to the same authenticated Zentra account', () => {
    const checkoutSource = readFileSync(
      new URL('../app/api/stripe/checkout/route.ts', import.meta.url),
      'utf8',
    );
    const claimSource = readFileSync(
      new URL('../app/api/account/claim/route.ts', import.meta.url),
      'utf8',
    );
    const licenseSource = readFileSync(
      new URL('../app/api/stripe/license/route.ts', import.meta.url),
      'utf8',
    );
    const portalSource = readFileSync(
      new URL('../app/api/stripe/portal/route.ts', import.meta.url),
      'utf8',
    );
    expect(checkoutSource).toContain(
      'createCheckoutSession(origin, claimHash, identity)',
    );
    expect(claimSource).toContain('assertCheckoutAccount(session, user)');
    expect(licenseSource).toContain('getZentraUser({ refreshSession: true })');
    expect(licenseSource).toContain('assertCheckoutAccount(session, user)');
    expect(portalSource).toContain('getZentraUser({ refreshSession: true })');
    expect(portalSource).toContain('assertCheckoutAccount(session, user)');
  });

  it('does not query the Stripe portal for anonymous status checks', () => {
    const statusSource = readFileSync(
      new URL('../app/api/stripe/status/route.ts', import.meta.url),
      'utf8',
    );
    expect(statusSource).toContain(
      'accessAllowed ? await stripeCheckoutReadiness() : null',
    );
    expect(statusSource).toContain('portalLoginUrl: readiness?.portalLoginUrl');
    expect(statusSource).not.toContain('stripePortalLoginUrl');
  });
});
