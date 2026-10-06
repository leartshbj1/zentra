import { beforeEach, it, expect, vi } from 'vitest';
import type { ZentraUser } from '@/app/zentra-auth';
import { AccountPublicError } from '@/lib/account-security';
const mocks = vi.hoisted(() => ({
  user: null as ZentraUser | null,
  auth: vi.fn(),
  member: vi.fn(),
  rate: vi.fn(),
  checkout: vi.fn(),
  cancel: vi.fn(),
  portal: vi.fn(),
  refresh: vi.fn(),
  state: vi.fn(),
}));
vi.mock('@/app/zentra-auth', () => ({ getZentraUser: mocks.auth }));
vi.mock('@/lib/runtime', () => ({
  stripeConfiguration: () => ({
    siteUrl: 'https://zentraapp.ch',
    siteOriginAliases: '',
  }),
  runtimeValue: () => '',
}));
vi.mock('@/lib/account', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@/lib/account')),
  requireBrowserMembership: mocks.member,
  enforceAccountRateLimit: mocks.rate,
}));
vi.mock('@/lib/automation/billing', () => ({
  createAutomationCheckout: mocks.checkout,
  cancelAutomationCheckout: mocks.cancel,
  automationPortal: mocks.portal,
  refreshAutomationPayment: mocks.refresh,
  automationBillingState: mocks.state,
}));
import { POST } from '@/app/api/automation/billing/route';
const req = (
  body: unknown = { organizationId: 'synthetic-company', action: 'state' },
  origin = 'https://zentraapp.ch',
  contentType = 'application/json',
) =>
  new Request('https://zentraapp.ch/api/automation/billing', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.user = {
    userId: 'synthetic-owner',
    email: 'owner@example.test',
    emailConfirmed: true,
    provider: 'supabase',
    displayName: 'Owner',
    fullName: null,
  };
  mocks.auth.mockImplementation(() => mocks.user);
  mocks.member.mockResolvedValue({ role: 'owner' });
  mocks.rate.mockResolvedValue(undefined);
  mocks.checkout.mockResolvedValue({
    url: 'https://checkout.stripe.com/synthetic',
  });
  mocks.cancel.mockResolvedValue({ canceled: true });
  mocks.portal.mockResolvedValue({
    url: 'https://billing.stripe.com/synthetic',
  });
  mocks.refresh.mockResolvedValue({ status: 'pending' });
  mocks.state.mockResolvedValue({ active: false });
});
it('requires same origin before auth or billing work', async () => {
  expect(
    (await POST(req(undefined, 'https://foreign.example.test'))).status,
  ).toBe(403);
  expect(mocks.auth).not.toHaveBeenCalled();
  expect(mocks.checkout).not.toHaveBeenCalled();
});
it.each([false, true])(
  'rejects missing or unconfirmed session: %s',
  async (unconfirmed) => {
    mocks.user = unconfirmed ? { ...mocks.user!, emailConfirmed: false } : null;
    expect((await POST(req())).status).toBe(401);
    expect(mocks.auth).toHaveBeenCalledWith({ refreshSession: true });
    expect(mocks.member).not.toHaveBeenCalled();
  },
);
it.each([
  null,
  [],
  { organizationId: 5, action: 'state' },
  { organizationId: '', action: 'state' },
  { organizationId: 'x'.repeat(181), action: 'state' },
])(
  'rejects malformed target/body before membership lookup: %j',
  async (body) => {
    expect((await POST(req(body))).status).toBe(400);
    expect(mocks.member).not.toHaveBeenCalled();
    expect(mocks.checkout).not.toHaveBeenCalled();
  },
);
it.each(['malformed', 'too-large', 'wrong-content-type'])(
  'bounds body before account access: %s',
  async (kind) => {
    const r = await POST(
      req(
        kind === 'malformed'
          ? '{'
          : kind === 'too-large'
            ? { organizationId: 'synthetic-company', padding: 'x'.repeat(5000) }
            : {},
        undefined,
        kind === 'wrong-content-type' ? 'text/plain' : 'application/json',
      ),
    );
    expect(r.status).toBe(
      kind === 'malformed' ? 400 : kind === 'too-large' ? 413 : 415,
    );
    expect(mocks.member).not.toHaveBeenCalled();
  },
);
it('preserves an active membership refusal with no billing call', async () => {
  mocks.member.mockRejectedValue(new AccountPublicError('Refus', 403));
  expect(
    (
      await POST(
        req({ organizationId: 'synthetic-company', action: 'checkout' }),
      )
    ).status,
  ).toBe(403);
  expect(mocks.checkout).not.toHaveBeenCalled();
});
it('keeps state read-only and polling does not consume payment-action rate allowance', async () => {
  const r = await POST(req());
  expect(r.status).toBe(200);
  expect(mocks.state).toHaveBeenCalledWith('synthetic-company');
  expect(mocks.rate).not.toHaveBeenCalled();
  expect(r.headers.get('Cache-Control')).toContain('no-store');
});
it.each(['checkout', 'cancelCheckout', 'portal', 'refresh'])(
  'routes authenticated bounded action %s',
  async (action) => {
    const r = await POST(req({ organizationId: 'synthetic-company', action }));
    expect(r.status).toBe(200);
    expect(mocks.rate).toHaveBeenCalledWith(
      expect.any(Request),
      'automation-billing',
      'synthetic-owner',
      30,
    );
    if (action === 'cancelCheckout')
      expect(mocks.cancel).toHaveBeenCalledWith(
        'synthetic-company',
        mocks.user,
      );
  },
);
it('rate refusal stops payment operations with a clear public error', async () => {
  mocks.rate.mockRejectedValue(new AccountPublicError('Réessayez', 429, 60));
  const r = await POST(
    req({ organizationId: 'synthetic-company', action: 'checkout' }),
  );
  expect(r.status).toBe(429);
  expect(await r.json()).toMatchObject({ error: 'Réessayez' });
  expect(mocks.checkout).not.toHaveBeenCalled();
});
it('rejects unknown action without provider work', async () => {
  expect(
    (
      await POST(
        req({ organizationId: 'synthetic-company', action: 'foreign' }),
      )
    ).status,
  ).toBe(400);
  expect(mocks.checkout).not.toHaveBeenCalled();
});
