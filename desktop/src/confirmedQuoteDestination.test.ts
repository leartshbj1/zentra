import { describe, expect, it } from 'vitest';
import { resolveConfirmedQuoteDestination, type ConfirmedQuoteDestinationRequest } from './confirmedQuoteDestination';
import type { Quote, QuoteStatus, Workspace } from './types';
import type { FormDraftIdentityValue } from './useFormDraft';
import { captureWorkspaceMutationOrigin } from './workspaceMemberOrigin';

const quoteId = '7418f947-06af-4dfb-84d0-0f2eae5fb946';
const otherQuoteId = 'b8c6975a-6f44-4b15-a579-068b072d95f1';
const nonceA = '0123456789abcdef0123456789abcdef';
const nonceB = 'fedcba9876543210fedcba9876543210';
const identity: FormDraftIdentityValue = {
  companyId: 'physical-company-a', organizationId: 'organization-a',
  memberId: 'member-a', memberContextNonce: nonceA, ready: true,
};
const quote: Quote = {
  id: quoteId, number: '', clientId: 'client-a', projectId: null, title: 'Travaux à vérifier',
  issueDate: '2026-10-11', validUntil: '2026-11-11', currency: 'CHF', status: 'draft',
  lines: [], notes: '', terms: '', createdAt: '2026-10-11T12:00:00Z',
};
type QuoteWorkspace = Pick<Workspace, 'workNotesScope' | 'quotes'>;
const workspace: QuoteWorkspace = { workNotesScope: identity.companyId, quotes: [quote] };
const request: ConfirmedQuoteDestinationRequest = {
  organizationId: identity.organizationId!, quoteId,
  origin: captureWorkspaceMutationOrigin(workspace, identity),
};
const current = { active: true, readOnly: false };

describe('private confirmed quote destination', () => {
  it('resolves only the exact quote ID among otherwise similar documents', () => {
    const other = { ...quote, id: otherQuoteId };
    const result = resolveConfirmedQuoteDestination(request, { ...workspace, quotes: [other, quote] }, identity, current);
    expect(result).toEqual({ kind: 'available', quote, mode: 'edit' });
    if (result.kind === 'available') expect(result.quote).toBe(quote);
  });

  it('uses the currently loaded document after an edit or issue, never a captured document', () => {
    const changed: Quote = { ...quote, title: 'Titre relu par un humain', number: 'D-2026-17', status: 'issued' };
    const result = resolveConfirmedQuoteDestination(request, { ...workspace, quotes: [changed] }, identity, current);
    expect(result).toEqual({ kind: 'available', quote: changed, mode: 'consult' });
    if (result.kind === 'available') {
      expect(result.quote).toBe(changed);
      expect(result.quote).not.toBe(quote);
    }
  });

  it('reports an absent quote without inferring deletion or returning another quote', () => {
    for (const quotes of [[], [{ ...quote, id: otherQuoteId }]])
      expect(resolveConfirmedQuoteDestination(request, { ...workspace, quotes }, identity, current))
        .toEqual({ kind: 'unavailable', reason: 'missing' });
  });

  it.each(['', 'proposal:a', 'confirmed:a', 'D-2026-17', quoteId.toUpperCase()])('never substitutes an alternative identity for %s', id => {
    const result = resolveConfirmedQuoteDestination({ ...request, quoteId: id }, workspace, identity, current);
    expect(result.kind).toBe('unavailable');
  });

  it.each([
    { quoteId: '' }, { quoteId: ` ${quoteId}` }, { quoteId: `${quoteId} ` },
    { organizationId: '' }, { organizationId: ' organization-a' },
  ])('does not normalize an invalid destination request %j', patch => {
    expect(resolveConfirmedQuoteDestination({ ...request, ...patch }, workspace, identity, current))
      .toEqual({ kind: 'unavailable', reason: 'invalid_request' });
  });

  it('refuses an old organization even when the current company contains the same quote ID', () => {
    const nextIdentity = { ...identity, organizationId: 'organization-b', companyId: 'physical-company-b' };
    const nextWorkspace = { ...workspace, workNotesScope: nextIdentity.companyId };
    expect(resolveConfirmedQuoteDestination(request, nextWorkspace, nextIdentity, current))
      .toEqual({ kind: 'unavailable', reason: 'context_changed' });
  });

  it.each([undefined, '', 'organization-b'])('requires the exact admitted organization %s', organizationId => {
    expect(resolveConfirmedQuoteDestination(request, workspace, { ...identity, organizationId }, current))
      .toEqual({ kind: 'unavailable', reason: 'context_changed' });
  });

  it.each([undefined, ''])('requires a physical workspace scope instead of the identity fallback %s', workNotesScope => {
    expect(resolveConfirmedQuoteDestination(request, { ...workspace, workNotesScope }, identity, current))
      .toEqual({ kind: 'unavailable', reason: 'context_changed' });
  });

  it('refuses an unavailable workspace and an inactive lifetime', () => {
    expect(resolveConfirmedQuoteDestination(request, undefined, identity, current))
      .toEqual({ kind: 'unavailable', reason: 'context_changed' });
    expect(resolveConfirmedQuoteDestination(request, workspace, identity, { ...current, active: false }))
      .toEqual({ kind: 'unavailable', reason: 'context_changed' });
  });

  it('refuses a mismatched physical workspace and an unadmitted physical replacement', () => {
    const nextWorkspace = { ...workspace, workNotesScope: 'physical-company-b' };
    expect(resolveConfirmedQuoteDestination(request, nextWorkspace, identity, current))
      .toEqual({ kind: 'unavailable', reason: 'context_changed' });
    expect(resolveConfirmedQuoteDestination(request, nextWorkspace, { ...identity, companyId: nextWorkspace.workNotesScope }, current))
      .toEqual({ kind: 'unavailable', reason: 'context_changed' });
  });

  it.each([
    { ready: false }, { ready: undefined }, { memberId: undefined }, { memberId: '' },
    { memberContextNonce: undefined }, { memberContextNonce: 'bad' }, { memberContextNonce: nonceB },
    { companyId: undefined }, { companyId: 'physical-company-b' },
  ])('requires the original ready member context %j', patch => {
    expect(resolveConfirmedQuoteDestination(request, workspace, { ...identity, ...patch }, current))
      .toEqual({ kind: 'unavailable', reason: 'context_changed' });
  });

  it('does not revive an old request after the same company is admitted with a new nonce', () => {
    expect(resolveConfirmedQuoteDestination(request, workspace, { ...identity, memberContextNonce: nonceB }, current))
      .toEqual({ kind: 'unavailable', reason: 'context_changed' });
  });

  it.each([
    [quote, quote], [quote, { ...quote }], [quote, { ...quote, title: 'Conflicting copy', status: 'issued' as const }],
  ])('refuses every duplicate matching ID, including identical objects', (first, second) => {
    expect(resolveConfirmedQuoteDestination(request, { ...workspace, quotes: [first, second] }, identity, current))
      .toEqual({ kind: 'unavailable', reason: 'ambiguous' });
  });

  it('does not let unrelated duplicate IDs obscure the unique requested quote', () => {
    const other = { ...quote, id: otherQuoteId };
    expect(resolveConfirmedQuoteDestination(request, { ...workspace, quotes: [other, other, quote] }, identity, current))
      .toEqual({ kind: 'available', quote, mode: 'edit' });
  });

  const statuses: QuoteStatus[] = ['draft', 'issued', 'accepted', 'refused', 'expired', 'cancelled'];
  it.each(statuses)('derives the destination mode from current status %s', status => {
    const item = { ...quote, status };
    expect(resolveConfirmedQuoteDestination(request, { ...workspace, quotes: [item] }, identity, current))
      .toEqual({ kind: 'available', quote: item, mode: status === 'draft' ? 'edit' : 'consult' });
  });

  it.each(statuses)('permits consultation only in read-only mode for current status %s', status => {
    const item = { ...quote, status };
    expect(resolveConfirmedQuoteDestination(request, { ...workspace, quotes: [item] }, identity, { ...current, readOnly: true }))
      .toEqual({ kind: 'available', quote: item, mode: 'consult' });
  });

  it('does not mutate or freeze the supplied workspace, identity, request or current quote', () => {
    const localQuote = { ...quote, lines: Object.freeze([]) as unknown as Quote['lines'] };
    const localWorkspace = Object.freeze({ ...workspace, quotes: Object.freeze([localQuote]) as unknown as Quote[] });
    const localIdentity = Object.freeze({ ...identity });
    const localRequest = Object.freeze({ ...request });
    const before = JSON.stringify([localRequest, localWorkspace, localIdentity, current]);
    const result = resolveConfirmedQuoteDestination(localRequest, localWorkspace, localIdentity, Object.freeze({ ...current }));
    expect(result.kind).toBe('available');
    expect(JSON.stringify([localRequest, localWorkspace, localIdentity, current])).toBe(before);
    expect(Object.isFrozen(localQuote)).toBe(false);
  });
});
