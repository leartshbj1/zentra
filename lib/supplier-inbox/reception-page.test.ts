import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ user: vi.fn(), membership: vi.fn(), inbox: vi.fn() }));
vi.mock('@/app/zentra-auth', () => ({ getZentraUser: mocks.user, zentraSignInPath: () => '/connexion' }));
vi.mock('@/lib/account', () => ({ requireBrowserMembership: mocks.membership }));
vi.mock('@/lib/supplier-inbox/service', () => ({ inboxState: mocks.inbox }));
vi.mock('@/components/automation/supplier-receipts', () => ({ SupplierReceipts: () => null }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => { throw new Error(`redirect:${url}`); },
  notFound: () => { throw new Error('not-found'); },
}));

import Page from '@/app/compte/automation/reception/page';

describe('supplier reception page company boundary', () => {
  beforeEach(() => { vi.resetAllMocks(); });
  it('requires authentication before reading documents', async () => {
    mocks.user.mockResolvedValue(null);
    await expect(Page({ searchParams: Promise.resolve({ entreprise: 'company-a' }) })).rejects.toThrow('redirect:/connexion');
    expect(mocks.inbox).not.toHaveBeenCalled();
  });
  it('requires an explicitly selected company', async () => {
    mocks.user.mockResolvedValue({ userId: 'person-a' });
    await expect(Page({ searchParams: Promise.resolve({}) })).rejects.toThrow('redirect:/compte/automation');
    expect(mocks.inbox).not.toHaveBeenCalled();
  });
  it('never reads another company after membership is refused', async () => {
    mocks.user.mockResolvedValue({ userId: 'person-a' });
    mocks.membership.mockRejectedValue(new Error('forbidden'));
    await expect(Page({ searchParams: Promise.resolve({ entreprise: 'company-b' }) })).rejects.toThrow('not-found');
    expect(mocks.membership).toHaveBeenCalledWith('person-a', 'company-b');
    expect(mocks.inbox).not.toHaveBeenCalled();
  });
});
