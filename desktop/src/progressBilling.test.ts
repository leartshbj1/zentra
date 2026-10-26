import { describe, expect, it } from 'vitest';
import { lineCumulative, nextProgressStep, previewProgress, previousProgress, roundBp, roundFive, type PreviousProgress, type ProgressBill, type ProgressPreview } from './progressBilling';
import type { Invoice, Quote } from './types';

const quote = {
  id: 'q', number: 'D-1', clientId: 'c', projectId: null, title: 'Cage d’escalier', issueDate: '2026-09-01', validUntil: '2026-10-01',
  currency: 'CHF', status: 'accepted', notes: '', terms: '', createdAt: '',
  lines: [
    { id: 'a', description: 'Peinture murs', quantity: 200, unit: 'm²', unitPriceCents: 2_500, vatRateBp: 810 },
    { id: 'b', description: 'Plâtrerie', quantity: 1, unit: 'forfait', unitPriceCents: 800_000, vatRateBp: 810 },
  ],
} as Quote;
const empty: PreviousProgress = { sequence: 0, lineNet: {}, retentionByRate: {}, roundingCents: 0, billedNetCents: 0, finalBilled: false, retentionReleased: false, draftSequence: null };

function ok(result: ProgressPreview | { error: string }): ProgressPreview {
  if ('error' in result) throw new Error(result.error);
  return result;
}
function advance(previous: PreviousProgress, result: ProgressPreview, kind: 'situation' | 'final' | 'retention_release', retentionBp: number): PreviousProgress {
  const lineNet = { ...previous.lineNet };
  for (const line of result.increments) lineNet[line.lineId] = line.cumulativeNetCents;
  const retentionByRate = kind === 'retention_release' ? { 810: 0 } : { 810: kind === 'final' && retentionBp < 0 ? 0 : roundBp(result.cumulativeNetCents, retentionBp) };
  return { ...previous, sequence: previous.sequence + 1, lineNet, retentionByRate, roundingCents: previous.roundingCents + result.roundingCents, billedNetCents: previous.billedNetCents + result.netCents + result.roundingCents, finalBilled: previous.finalBilled || kind === 'final', retentionReleased: kind === 'retention_release' };
}

describe('situations SIA 118 (mêmes cas que le calcul natif)', () => {
  it('arrondit au 5 centimes et au point de base comme l’app native', () => {
    expect([1_002, 1_003, 1_007, 1_008, -3].map(roundFive)).toEqual([1_000, 1_005, 1_005, 1_010, -5]);
    expect(roundBp(10_925, 810)).toBe(885);
    expect(roundBp(-17_500, 810)).toBe(-1_418);
  });

  it('cumule, déduit les situations précédentes, retient la garantie puis la libère', () => {
    const first = ok(previewProgress('situation', quote, { a: { mode: 'percent', percentBp: 4_000 }, b: { mode: 'percent', percentBp: 2_500 } }, 1_000, false, true, empty));
    expect(first).toMatchObject({ cumulativeNetCents: 400_000, cumulativeRetentionCents: 40_000, netCents: 360_000, totalCents: 389_160, roundingCents: 0 });
    const afterFirst = advance(empty, first, 'situation', 1_000);
    const second = ok(previewProgress('situation', quote, { a: { mode: 'quantity', quantity: 150 } }, 1_000, false, true, afterFirst));
    expect(second).toMatchObject({ cumulativeNetCents: 575_000, previousNetCents: 360_000, netCents: 157_500, roundingCents: -2 });
    expect(second.totalCents % 5).toBe(0);
    const afterSecond = advance(afterFirst, second, 'situation', 1_000);
    const last = ok(previewProgress('final', quote, {}, 1_000, false, true, afterSecond));
    expect(last).toMatchObject({ cumulativeNetCents: 1_300_000, cumulativeRetentionCents: 130_000, netCents: 652_500, roundingCents: 3 });
    const afterFinal = advance(afterSecond, last, 'final', 1_000);
    expect(nextProgressStep(afterFinal)).toBe('retention_release');
    expect(previewProgress('situation', quote, { a: { mode: 'percent', percentBp: 10_000 } }, 1_000, false, true, afterFinal)).toHaveProperty('error');
    const release = ok(previewProgress('retention_release', quote, {}, 1_000, false, true, afterFinal));
    expect(release.netCents).toBe(130_000);
    expect(release.totalCents % 5).toBe(0);
  });

  it('refuse un recul, un taux hors limites et une libération prématurée', () => {
    expect(previewProgress('situation', quote, { a: { mode: 'percent', percentBp: 10_001 } }, 1_000, false, true, empty)).toHaveProperty('error');
    expect(previewProgress('situation', quote, { a: { mode: 'percent', percentBp: 5_000 } }, 3_001, false, true, empty)).toHaveProperty('error');
    expect(previewProgress('retention_release', quote, {}, 1_000, false, true, empty)).toHaveProperty('error');
    const first = ok(previewProgress('situation', quote, { a: { mode: 'percent', percentBp: 6_000 } }, 1_000, false, true, empty));
    expect(previewProgress('situation', quote, { a: { mode: 'percent', percentBp: 4_000 } }, 1_000, false, true, advance(empty, first, 'situation', 1_000))).toHaveProperty('error');
    expect(lineCumulative(quote.lines[0], { mode: 'quantity', quantity: 220 })).toEqual({ netCents: 550_000, quantity: 220 });
  });

  it('lit l’état laissé par les factures émises, en ignorant les annulées', () => {
    const bill = (id: string, sequence: number, invoiceId: string, cumulative: number): ProgressBill => ({ id, quoteId: 'q', invoiceId, sequence, kind: 'situation', progressDate: '2026-10-01', retentionBp: 1_000,
      cumulativeNetCents: cumulative, cumulativeRetentionCents: cumulative / 10, retentionByRate: { 810: cumulative / 10 }, previousNetCents: 0, netCents: cumulative * 0.9, roundingCents: 0,
      lines: [{ quoteItemId: 'a', mode: 'percent', cumulativePercentBp: 1_000, cumulativeQuantity: 20, cumulativeNetCents: cumulative }] });
    const invoices = [{ id: 'i1', status: 'issued' }, { id: 'i2', status: 'cancelled' }, { id: 'i3', status: 'draft' }] as Invoice[];
    const state = previousProgress('q', [bill('b1', 1, 'i1', 50_000), bill('b2', 2, 'i2', 90_000), bill('b3', 3, 'i3', 70_000)], invoices);
    expect(state).toMatchObject({ sequence: 3, lineNet: { a: 50_000 }, billedNetCents: 45_000, draftSequence: 3 });
    expect(nextProgressStep(state)).toBe('draft');
  });
});
