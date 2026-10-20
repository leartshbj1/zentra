import { describe, expect, it } from 'vitest';
import { effectiveAmount, effectiveStage, nextStage, opportunityFromRaw, pipelineRows, pipelineSummary, stalledOpportunities, type Opportunity } from './pipeline';

const opportunity = (patch: Partial<Opportunity> = {}): Opportunity => ({
  id: 'o1', clientId: null, prospectName: 'Boulangerie Favre', title: 'Laboratoire', stage: 'lead', amountCents: 1_000_000, expectedCloseDate: null, quoteId: null,
  notes: '', lostReason: '', stageChangedAt: '2026-10-01T08:00:00Z', createdAt: '2026-10-01T08:00:00Z', updatedAt: '2026-10-01T08:00:00Z', ...patch,
});
const quote = (status: 'draft' | 'issued' | 'accepted' | 'refused' | 'expired') => ({ id: 'q1', status, lines: [{ id: 'l', description: 'x', quantity: 2, unit: 'h', unitPriceCents: 10_000, vatRateBp: 810 }] });

describe('pipeline', () => {
  it('reads a stored opportunity', () => {
    expect(opportunityFromRaw({ id: 'o', client_id: null, prospect_name: 'A', title: 'T', stage: 'quote', amount_cents: 5, expected_close_date: '', quote_id: 'q' }))
      .toMatchObject({ clientId: null, stage: 'quote', amountCents: 5, expectedCloseDate: null, quoteId: 'q' });
    expect(opportunityFromRaw({ stage: 'other' }).stage).toBe('lead');
  });

  it('follows the linked quote', () => {
    const linked = opportunity({ quoteId: 'q1', stage: 'contact' });
    expect(effectiveStage(linked, [quote('issued')])).toBe('quote');
    expect(effectiveStage(linked, [quote('draft')])).toBe('quote');
    expect(effectiveStage(linked, [quote('accepted')])).toBe('won');
    expect(effectiveStage(linked, [quote('expired')])).toBe('lost');
    expect(effectiveStage(linked, [])).toBe('contact');
    // 2 × 100.00, hors TVA.
    expect(effectiveAmount(linked, [quote('issued')])).toBe(20_000);
    expect(effectiveAmount(opportunity(), [])).toBe(1_000_000);
  });

  it('weights open opportunities by stage', () => {
    const rows = pipelineRows([
      opportunity({ id: 'a', stage: 'lead', amountCents: 1_000_000 }),
      opportunity({ id: 'b', stage: 'contact', amountCents: 333_333 }),
      opportunity({ id: 'c', stage: 'won', amountCents: 500_000, stageChangedAt: '2026-03-01T00:00:00Z' }),
      opportunity({ id: 'd', stage: 'lost', stageChangedAt: '2025-12-01T00:00:00Z' }),
    ], []);
    // 10 % de 10 000.00 + 30 % de 3 333.33 (999.999 → 1 000.00).
    expect(pipelineSummary(rows, '2026')).toEqual({ open: 2, openCents: 1_333_333, weightedCents: 100_000 + 100_000, wonCents: 500_000, lostCount: 0 });
    expect(nextStage('lead')).toBe('contact');
    expect(nextStage('quote')).toBeNull();
  });

  it('flags quiet and overdue opportunities', () => {
    const rows = pipelineRows([
      opportunity({ id: 'quiet', updatedAt: '2026-09-25T10:00:00Z' }),
      opportunity({ id: 'fresh', updatedAt: '2026-10-10T10:00:00Z' }),
      opportunity({ id: 'late', expectedCloseDate: '2026-10-15', updatedAt: '2026-10-18T10:00:00Z' }),
      opportunity({ id: 'done', stage: 'won', updatedAt: '2026-01-01T00:00:00Z' }),
    ], []);
    expect(stalledOpportunities(rows, '2026-10-20').map(row => [row.opportunity.id, row.reason, row.days])).toEqual([['late', 'overdue', 5], ['quiet', 'quiet', 25]]);
  });
});
