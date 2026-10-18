import { describe, expect, it } from 'vitest';
import { normalizeAutopilotReviewPage } from './autopilotReview';
import { initialDocumentFormDraft, validDocumentFormDraft } from './documentFormDraft';
import { initialOnboardingSettings } from './onboardingDraft';

const suggestion = { customer: { kind: 'existing', name: 'Atelier du Léman' }, currency: 'CHF', netCents: 17800,
  lines: [{ articleId: 'article-pro', description: 'Zentra Gestion Pro', unit: 'mois', quantityMilli: 2000, unitPriceCents: 8900, taxRateBp: 0, netCents: 17800 }] };
const item = { proposalId: 'proposal-a', sourceId: 'source-a', createdAt: 1791947827,
  disposition: 'needs_review', reasons: ['low_confidence'], requiresHumanValidation: true, suggestion };
const page = (value: unknown) => ({ organizationId: 'company-a', items: [value], nextCursor: null });

describe('Autopilote review suggestion', () => {
  it('keeps a well-formed suggestion on the review item', () => {
    const result = normalizeAutopilotReviewPage(page(item), 'company-a');
    expect(result?.items[0].suggestion).toEqual(suggestion);
    expect(Object.isFrozen(result?.items[0].suggestion?.lines[0])).toBe(true);
  });

  it('drops a malformed suggestion but keeps the review readable', () => {
    for (const broken of [
      { ...suggestion, currency: 'USD' },
      { ...suggestion, customer: { kind: 'invented', name: 'X' } },
      { ...suggestion, lines: [{ ...suggestion.lines[0], quantityMilli: 0 }] },
      { ...suggestion, lines: [{ ...suggestion.lines[0], articleId: '../foreign' }] },
      { ...suggestion, lines: Array.from({ length: 9 }, () => suggestion.lines[0]) },
      { ...suggestion, extra: true },
    ]) {
      const result = normalizeAutopilotReviewPage(page({ ...item, suggestion: broken }), 'company-a');
      expect(result?.items[0].proposalId).toBe('proposal-a');
      expect(result?.items[0].suggestion).toBeUndefined();
    }
  });

  it('starts a new quote from a seed: lines, existing client or a new client name', () => {
    const line = { id: 'line-1', catalogItemId: 'article-pro', description: 'Zentra Gestion Pro', quantity: 2, unit: 'mois', unitPriceCents: 8900, discountBp: 0, vatRateBp: 0 };
    const existing = initialDocumentFormDraft('quotes', initialOnboardingSettings, 'empty', undefined, undefined, undefined, 0, undefined, undefined,
      { id: 'proposal-a', clientId: 'client-1', lines: [line] });
    expect(existing.lines).toEqual([line]);
    expect(existing.selectedClientId).toBe('client-1');
    expect(existing.quickClientOpen).toBe(false);
    expect(validDocumentFormDraft(existing)).toBe(true);
    const fresh = initialDocumentFormDraft('quotes', initialOnboardingSettings, 'empty', undefined, undefined, undefined, 0, 'quick', undefined,
      { id: 'proposal-a', newClientName: 'Nouveau client SA', lines: [line] });
    expect(fresh.selectedClientId).toBe('');
    expect(fresh.quickClientOpen).toBe(true);
    expect(fresh.quickClient.company).toBe('Nouveau client SA');
    const plain = initialDocumentFormDraft('quotes', initialOnboardingSettings, 'empty');
    expect(plain.lines[0].id).toBe('empty');
    expect(plain.quickClient.company).toBe('');
  });
});
