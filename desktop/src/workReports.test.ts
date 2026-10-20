import { describe, expect, it } from 'vitest';
import { reportTotals, reportsToInvoice, signaturePath, signatureReady } from './workReports';
import type { WorkReport } from './types';

describe('rapports de régie', () => {
  it('adds hours and material with VAT rounded line by line, like the invoice', () => {
    const totals = reportTotals([
      { kind: 'labor', quantity: 3, unitPriceCents: 9_500, vatBp: 810 },
      { kind: 'material', quantity: 1, unitPriceCents: 12_000, vatBp: 810 },
      { kind: 'labor', quantity: 0.5, unitPriceCents: 9_500, vatBp: 810 },
    ]);
    expect(totals).toEqual({ netCents: 45_250, vatCents: 2_309 + 972 + 385, totalCents: 45_250 + 3_666, hours: 3.5, materials: 1 });
  });

  it('turns strokes into a compact path on a 600 × 200 canvas', () => {
    const path = signaturePath([[{ x: 10, y: 10 }, { x: 10.2, y: 10.1 }, { x: 50, y: 40 }, { x: 90, y: 20 }], [{ x: 100, y: 50 }, { x: 120, y: 60 }]], 300, 100);
    expect(path).toBe('M20 20 L100 80 L180 40 M200 100 L240 120');
    expect(signatureReady(path)).toBe(true);
    expect(signatureReady('M20 20')).toBe(false);
    expect(signaturePath([[{ x: -5, y: 500 }]], 300, 100)).toBe('M0 200');
  });

  it('lists signed reports not invoiced yet', () => {
    const report = (id: string, status: WorkReport['status'], invoiceId: string | null) => ({ id, status, invoiceId } as WorkReport);
    expect(reportsToInvoice([report('a', 'draft', null), report('b', 'signed', null), report('c', 'invoiced', 'i1')]).map((row) => row.id)).toEqual(['b']);
  });
});
