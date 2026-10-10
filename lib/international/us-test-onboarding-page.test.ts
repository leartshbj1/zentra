import { beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ enabled: vi.fn(), requireUser: vi.fn(), user: vi.fn(), language: vi.fn() }));
vi.mock('@/app/zentra-auth', () => ({ getZentraUser: f.user, requireZentraUser: f.requireUser, zentraSignInPath: (path: string) => '/connexion?returnTo=' + encodeURIComponent(path) }));
vi.mock('@/lib/site-language-server', () => ({ getSiteLanguage: f.language }));
vi.mock('@/lib/international/us-saas-test-bindings', () => ({ usTestBillingEnabled: f.enabled }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('not_found'); }, redirect: (path: string) => { throw new Error('redirect:' + path); } }));
import Page from '../../app/compte/espaces/us/nouveau/page';
import { onboardingActor, onboardingRequestId } from './us-test-onboarding.test-fixtures';
const page = (query: Record<string, string | string[] | undefined> = {}) => Page({ searchParams: Promise.resolve(query) });
beforeEach(() => { vi.resetAllMocks(); f.enabled.mockResolvedValue(true); f.requireUser.mockResolvedValue({ userId: onboardingActor }); f.user.mockResolvedValue({ userId: onboardingActor }); f.language.mockResolvedValue('fr'); });
describe('sandbox-only authenticated US TEST entry', () => {
  it('keeps the page absent before reading Auth when the sandbox gate is closed', async () => { f.enabled.mockResolvedValue(false); await expect(page()).rejects.toThrow('not_found'); expect(f.requireUser).not.toHaveBeenCalled(); expect(f.user).not.toHaveBeenCalled(); });
  it('uses account auth without purchase access side effects and forwards only a locator', async () => { const node = await page({ requestId: onboardingRequestId, checkout: 'returned', success: 'true', payment: 'paid' }); expect(f.requireUser).toHaveBeenCalledWith('/compte/espaces/us/nouveau', { offerAccess: false }); expect(f.user).toHaveBeenCalledWith({ offerAccess: false }); expect(node.props).toEqual({ expectedUserId: onboardingActor, language: 'fr', initialRequestId: onboardingRequestId, checkoutReturn: 'returned' }); expect(f.enabled).toHaveBeenCalledTimes(2); });
  it.each([null, { userId: '00000000-0000-4000-8000-999999999999' }])('rejects changed Auth before returning an old actor %j', async user => { f.user.mockResolvedValue(user); await expect(page()).rejects.toThrow('redirect:/connexion?returnTo='); });
  it('rechecks the closed gate after awaited account and query reads', async () => { f.enabled.mockResolvedValueOnce(true).mockResolvedValueOnce(false); await expect(page()).rejects.toThrow('not_found'); });
  it('never forwards malformed or duplicate query values as an admission', async () => { const node = await page({ requestId: ['a', onboardingRequestId], checkout: ['returned', 'canceled'] }); expect(node.props.initialRequestId).toBe(null); expect(node.props.checkoutReturn).toBe(null); });
});
