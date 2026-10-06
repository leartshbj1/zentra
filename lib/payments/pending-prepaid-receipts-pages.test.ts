import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  authenticate: vi.fn(),
  discover: vi.fn(),
  language: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NOT_FOUND');
  }),
}));
vi.mock('@/app/zentra-auth', () => ({ requireZentraUser: state.authenticate }));
vi.mock('@/lib/site-language-server', () => ({
  getSiteLanguage: state.language,
}));
vi.mock('next/navigation', () => ({ notFound: state.notFound }));
vi.mock('@/lib/payments/pending-prepaid-receipts', () => ({
  listOwnedPendingPrepaidReceipts: state.discover,
  PendingPrepaidReceiptCursorError: class extends Error {},
}));
vi.mock('@/components/account/pending-payments', () => ({
  PendingPayments: () => null,
}));
import PaymentsPage from '@/app/compte/paiements/page';
import { PendingPrepaidReceiptCursorError } from './pending-prepaid-receipts';

const user = { userId: 'private-owner', emailConfirmed: true };
const page = { items: [], nextCursor: null };
beforeEach(() => {
  vi.clearAllMocks();
  state.authenticate.mockResolvedValue(user);
  state.discover.mockResolvedValue(page);
  state.language.mockResolvedValue('fr');
});
afterEach(() => vi.restoreAllMocks());

describe('private payment history page', () => {
  it('authenticates before reading private payment data, without offering access', async () => {
    state.authenticate.mockRejectedValue(new Error('SIGN_IN'));
    await expect(
      PaymentsPage({
        searchParams: Promise.resolve({ avant: 'private-cursor' }),
      }),
    ).rejects.toThrow('SIGN_IN');
    expect(state.authenticate).toHaveBeenCalledWith(
      '/compte/paiements?avant=private-cursor',
      { offerAccess: false },
    );
    expect(state.discover).not.toHaveBeenCalled();
    expect(state.language).not.toHaveBeenCalled();
  });

  it('rejects repeated cursor parameters only after authenticating', async () => {
    await expect(
      PaymentsPage({
        searchParams: Promise.resolve({ avant: ['first', 'second'] }),
      }),
    ).rejects.toThrow('NOT_FOUND');
    expect(state.authenticate).toHaveBeenCalledWith('/compte/paiements', {
      offerAccess: false,
    });
    expect(state.discover).not.toHaveBeenCalled();
  });

  it('passes only the authenticated owner and cursor to the canonical reader', async () => {
    const result = await PaymentsPage({
      searchParams: Promise.resolve({ avant: 'abc_-', owner: 'someone-else' }),
    });
    expect(state.discover).toHaveBeenCalledWith(user, { cursor: 'abc_-' });
    expect(result.props.children[1].props).toEqual({
      page,
      language: 'fr',
      showEmpty: true,
    });
  });

  it('shows not-found for an invalid cursor instead of an empty successful history', async () => {
    state.discover.mockRejectedValue(new PendingPrepaidReceiptCursorError());
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      PaymentsPage({ searchParams: Promise.resolve({ avant: 'bad' }) }),
    ).rejects.toThrow('NOT_FOUND');
    expect(warning).not.toHaveBeenCalled();
  });

  it('shows an unavailable state and logs no account or database details when discovery fails', async () => {
    state.discover.mockRejectedValue(
      new Error('private-email@example.test secret-query'),
    );
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await PaymentsPage({ searchParams: Promise.resolve({}) });
    expect(result.props.children[1].props.page).toBeNull();
    expect(warning).toHaveBeenCalledExactlyOnceWith('zentra_payment_followup', {
      provider: 'postfinance',
      code: 'list_unavailable',
    });
  });

  it.each([
    ['fr', 'Suivi des paiements'],
    ['de', 'Zahlungen im Blick'],
    ['it', 'Stato dei pagamenti'],
    ['en', 'Payment tracking'],
  ])(
    'uses the requested %s language for the history and its component',
    async (language, title) => {
      state.language.mockResolvedValue(language);
      const result = await PaymentsPage({ searchParams: Promise.resolve({}) });
      expect(result.props.children[0].props.children).toBe(title);
      expect(result.props.children[1].props.language).toBe(language);
    },
  );
});
