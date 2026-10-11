import { expect, it, vi } from 'vitest';
import { confirmedQuoteActivityCopy, confirmedQuoteActivityKey, normalizeConfirmedQuoteActivityPage, type ConfirmedQuoteActivity, type ConfirmedQuoteActivityPage } from './confirmedQuoteActivity';

const item: ConfirmedQuoteActivity = {
  activityId: 'confirmed:a', proposalId: 'proposal:a', quoteId: '7418f947-06af-4dfb-84d0-0f2eae5fb946',
  confirmedAt: 1791716400, kind: 'quote_draft_created', requiresHumanValidation: true,
};
const page: ConfirmedQuoteActivityPage = { organizationId: 'company-a', items: [item], nextCursor: null };
const normalize = (raw: unknown) => normalizeConfirmedQuoteActivityPage(raw, 'company-a');

it('captures the canonical page without mutating or sharing its records', () => {
  const normalized = normalize(page)!;
  expect(normalized).toEqual(page);
  expect(normalized).not.toBe(page);
  expect(normalized.items[0]).not.toBe(item);
  expect(Object.isFrozen(normalized.items[0])).toBe(true);
  expect(normalize({ ...page, nextCursor: 'opaque_cursor-1' })?.nextCursor).toBe('opaque_cursor-1');
});

it('requires a separately supplied current organization and rejects retained foreign pages', () => {
  expect(normalizeConfirmedQuoteActivityPage(page)).toBeNull();
  expect(normalizeConfirmedQuoteActivityPage(page, 'company-b')).toBeNull();
  expect(normalizeConfirmedQuoteActivityPage({ ...page, organizationId: 'company-b' }, 'company-a')).toBeNull();
});

it('deduplicates only the identical tuple and preserves distinct genuine events', () => {
  const second = { ...item, activityId: 'confirmed:b', proposalId: 'proposal:b', quoteId: 'b8c6975a-6f44-4b15-a579-068b072d95f1' };
  expect(normalize({ ...page, items: [item, { ...item }, second] })?.items).toEqual([item, second]);
});

it.each([
  { activityId: 'confirmed:b' }, { proposalId: 'proposal:b' },
  { quoteId: 'b8c6975a-6f44-4b15-a579-068b072d95f1' }, { confirmedAt: item.confirmedAt + 1 },
])('rejects the entire page when an identity conflicts: %j', changes => {
  expect(normalize({ ...page, items: [item, { ...item, ...changes }] })).toBeNull();
});

it.each([0, -1, NaN, Infinity, -Infinity, 1.5, 253402300800, '2026-10-11T11:00:00Z', null])('rejects noncanonical or invalid dates: %s', confirmedAt => {
  expect(normalize({ ...page, items: [{ ...item, confirmedAt }] })).toBeNull();
});

it('accepts both finite canonical timestamp boundaries', () => {
  for (const confirmedAt of [1, 253402300799]) expect(normalize({ ...page, items: [{ ...item, confirmedAt }] })?.items[0].confirmedAt).toBe(confirmedAt);
});

it.each([
  { ...page, extra: true }, { organizationId: 'company-a', items: [item] },
  { ...page, nextCursor: '' }, { ...page, nextCursor: 'bad cursor' }, { ...page, nextCursor: 'a'.repeat(4097) },
  { ...page, items: [{ ...item, organizationId: 'company-a' }] },
  { ...page, items: [{ ...item, state: 'draft' }] },
  { ...page, items: [{ ...item, requiresHumanValidation: false }] },
  { ...page, items: [{ ...item, kind: 'quote_sent' }] },
  { ...page, items: [{ ...item, quoteId: 'document-not-a-uuid' }] },
  { ...page, items: [{ ...item, proposalId: ' proposal:a' }] },
])('rejects closed-schema and canonical identity violations: %j', raw => {
  expect(normalize(raw)).toBeNull();
});

it('does not accept the private native activity DTO by inference', () => {
  expect(normalize({ organizationId: 'company-a', entries: [{ ...item, confirmedAt: '2026-10-11T11:00:00Z' }], nextAfterProposalId: null })).toBeNull();
});

it('rejects oversized, sparse, decorated and accessor arrays without executing getters', () => {
  const getter = vi.fn(() => item);
  const accessor: unknown[] = []; Object.defineProperty(accessor, '0', { enumerable: true, get: getter });
  const decorated = Object.assign([item], { extra: true });
  for (const items of [Array(1), Array(51).fill(item), decorated, accessor]) expect(normalize({ ...page, items })).toBeNull();
  expect(getter).not.toHaveBeenCalled();
  const raw = { ...item }; Object.defineProperty(raw, 'confirmedAt', { enumerable: true, get: getter });
  expect(normalize({ ...page, items: [raw] })).toBeNull();
  expect(getter).not.toHaveBeenCalled();
});

it('keys historical rows by an unambiguous organization/proposal tuple', () => {
  expect(confirmedQuoteActivityKey('company:a', 'proposal')).not.toBe(confirmedQuoteActivityKey('company', 'a:proposal'));
  expect(confirmedQuoteActivityKey('company-a', item.proposalId)).not.toBe(confirmedQuoteActivityKey('company-b', item.proposalId));
});

it.each([
  ['fr', 'Devis', 'Devis préparé', 'Ouvrir le devis'],
  ['de', 'Offerten', 'Offerte vorbereitet', 'Offerte öffnen'],
  ['it', 'Preventivi', 'Preventivo preparato', 'Apri preventivo'],
  ['en', 'Quotes', 'Quote prepared', 'Open quote'],
])('supplies factual historical labels in %s', (language, filter, prepared, open) => {
  expect(confirmedQuoteActivityCopy(language)).toMatchObject({ filter, prepared, open });
  expect(confirmedQuoteActivityCopy(language).unavailable).toBeTruthy();
});
