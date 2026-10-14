import { expect, it } from 'vitest';
import { normalizeAutopilotReviewPage, AUTOPILOT_REVIEW_REASONS } from './autopilotReview';
import { autopilotCopy, autopilotReviewReason } from './autopilotPresentation';
const item = { proposalId: 'proposal-a', sourceId: 'source-a', createdAt: 1791947827,
  disposition: 'needs_review', reasons: ['low_confidence'], requiresHumanValidation: true };
const page = { organizationId: 'company-a', items: [item], nextCursor: null };
it('accepts only the scoped read-only projection and never promotes it into a quote', () => {
  const result = normalizeAutopilotReviewPage(page, 'company-a');
  expect(result).toEqual(page); expect(Object.isFrozen(result?.items[0])).toBe(true);
  expect(normalizeAutopilotReviewPage(page, 'company-b')).toBeNull();
  expect(normalizeAutopilotReviewPage({ ...page, items: [{ ...item, quoteId: 'invented' }] }, 'company-a')).toBeNull();
});
it('rejects unknown reasons, unsafe cursors, impossible dates and incomplete rows', () => {
  for(const change of [{ reasons: ['automatic_approval'] }, { disposition: 'ready' }, { createdAt: NaN },
    { requiresHumanValidation: false }, { sourceId: '../foreign' }, { reasons: [] }, { reasons: ['low_confidence','low_confidence'] }])
    expect(normalizeAutopilotReviewPage({ ...page, items: [{ ...item, ...change }] }, 'company-a')).toBeNull();
  expect(normalizeAutopilotReviewPage({ ...page, nextCursor: 'https://foreign' }, 'company-a')).toBeNull();
  expect(normalizeAutopilotReviewPage({ ...page, items: Array.from({ length: 51 }, () => item) }, 'company-a')).toBeNull();
});
it('does not invoke getters while validating a retained page', () => {
  let reads = 0; const value = { ...page };
  Object.defineProperty(value, 'items', { enumerable: true, get() { reads++; return [item]; } });
  expect(normalizeAutopilotReviewPage(value, 'company-a')).toBeNull(); expect(reads).toBe(0);
});
it('deduplicates identical rows and rejects conflicting proposal or source identities', () => {
  expect(normalizeAutopilotReviewPage({ ...page, items: [item,item] }, 'company-a')?.items).toHaveLength(1);
  for(const change of [{ sourceId: 'other' }, { proposalId: 'other' }])
    expect(normalizeAutopilotReviewPage({ ...page, items: [item,{ ...item,...change }] }, 'company-a')).toBeNull();
});
it.each(['fr','de','it','en'])('provides every human review reason and UI label in %s', language => {
  for(const reason of AUTOPILOT_REVIEW_REASONS) expect(autopilotReviewReason(reason, language)).toMatch(/\p{L}/u);
  for(const label of Object.values(autopilotCopy(language))) expect(label.length).toBeGreaterThan(0);
  if(language !== 'fr') expect(autopilotReviewReason('low_confidence',language)).not.toBe(autopilotReviewReason('low_confidence','fr'));
});
