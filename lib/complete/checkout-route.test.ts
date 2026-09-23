import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  user: vi.fn(), checkout: vi.fn(), cancel: vi.fn(), ready: vi.fn(), rate: vi.fn(), allowed: vi.fn(),
}));
vi.mock('@/app/zentra-auth', () => ({ getZentraUser: mocks.user }));
vi.mock('@/lib/runtime', () => ({
  stripeConfiguration: () => ({ siteUrl: 'https://zentraapp.ch', siteOriginAliases: 'https://www.zentraapp.ch' }),
}));
vi.mock('@/lib/complete/checkout', () => ({ completeCheckout: mocks.checkout, cancelCompleteCheckout: mocks.cancel }));
vi.mock('@/lib/stripe-readiness', () => ({ assertStripeCheckoutReady: mocks.ready }));
vi.mock('@/lib/stripe-test-access', () => ({ stripeTestAccessAllowed: mocks.allowed, stripeAutomaticTaxRequired: () => true }));
vi.mock('@/lib/stripe', async (original) => ({ ...await original<object>(), enforceCheckoutRateLimit: mocks.rate }));

import { POST } from '@/app/api/complete/checkout/route';
import { PublicError } from '@/lib/stripe';
import { AccountPublicError } from '@/lib/account-security';
import { completePlan, COMPLETE_PLANS, COMPLETE_TERMS_VERSION } from './plans';

const user = { userId: 'verified-owner', email: 'owner@example.test', displayName: 'Owner', emailConfirmed: true };
function request(body: Record<string, unknown> = {}, origin = 'https://zentraapp.ch') {
  return new Request('https://zentraapp.ch/api/complete/checkout', {
    method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ plan: 'team', acceptTerms: true, legalVersion: COMPLETE_TERMS_VERSION, ...body }),
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue(user);
  mocks.allowed.mockReturnValue(true);
  mocks.checkout.mockResolvedValue({ url: 'https://checkout.stripe.com/c/pay/test-only' });
  mocks.cancel.mockResolvedValue({ cancelled: true });
});
describe('Complete checkout HTTP boundary', () => {
  it.each(COMPLETE_PLANS)('uses authenticated identity and the server catalog for $name', async plan => {
    const response = await POST(request({ plan: plan.id, userId: 'forged', priceChfCents: 1 }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(mocks.ready).toHaveBeenCalledWith(plan.gestion);
    expect(mocks.rate).toHaveBeenCalledOnce();
    expect(mocks.checkout).toHaveBeenCalledWith(user, completePlan(plan.id), 'https://zentraapp.ch', true);
  });
  it('rejects cross-site requests before inspecting account or creating payment', async () => {
    expect((await POST(request({}, 'https://attacker.example'))).status).toBe(403);
    expect(mocks.user).not.toHaveBeenCalled();
    expect(mocks.checkout).not.toHaveBeenCalled();
  });
  it('requires login and verified email even for cancellation', async () => {
    mocks.user.mockResolvedValue(null);
    expect((await POST(request())).status).toBe(401);
    mocks.user.mockResolvedValue({ ...user, emailConfirmed: false });
    expect((await POST(request())).status).toBe(403);
    expect((await POST(request({ action: 'cancel' }))).status).toBe(403);
    expect(mocks.checkout).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it('requires a known plan and explicit current pack terms', async () => {
    for (const body of [{ plan: 'enterprise' }, { acceptTerms: false }, { acceptTerms: 'true' }, { legalVersion: 'old' }]) {
      expect((await POST(request(body))).status).toBe(400);
    }
    expect(mocks.ready).not.toHaveBeenCalled();
    expect(mocks.checkout).not.toHaveBeenCalled();
  });
  it('stops before Stripe when readiness, test access or request limits reject checkout', async () => {
    mocks.allowed.mockReturnValueOnce(false);
    expect((await POST(request())).status).toBe(503);
    mocks.ready.mockRejectedValueOnce(new PublicError('Paiement indisponible.', 503));
    expect((await POST(request())).status).toBe(503);
    mocks.rate.mockRejectedValueOnce(new PublicError('Réessayez plus tard.', 429));
    expect((await POST(request())).status).toBe(429);
    expect(mocks.checkout).not.toHaveBeenCalled();
  });
  it('only cancels the logged-in account attempt without requiring another purchase', async () => {
    const response = await POST(request({ action: 'cancel', userId: 'forged', acceptTerms: false }));
    expect(response.status).toBe(200);
    expect(mocks.cancel).toHaveBeenCalledWith(user);
    expect(mocks.checkout).not.toHaveBeenCalled();
  });
  it('returns actionable account errors but does not expose provider secrets', async () => {
    mocks.checkout.mockRejectedValueOnce(new AccountPublicError('Abonnement déjà actif.', 409));
    expect((await POST(request())).status).toBe(409);
    mocks.checkout.mockRejectedValueOnce(new Error('private-provider-detail'));
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('private-provider-detail');
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
  it('bounds the payload before accessing the account', async () => {
    expect((await POST(request({ padding: 'x'.repeat(4096) }))).status).toBe(413);
    expect(mocks.user).not.toHaveBeenCalled();
    expect(mocks.checkout).not.toHaveBeenCalled();
  });
});
