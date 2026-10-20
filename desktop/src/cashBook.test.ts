import { describe, expect, it } from 'vitest';
import { cashBalance, cashBookLines, countedCents, eveningCountDue, isCashMethod, uncorrectedCount } from './cashBook';
import type { CashBookEntry, CashCount, Invoice, Payment } from './types';

const entry = (id: string, date: string, kind: CashBookEntry['kind'], amountCents: number, countId: string | null = null): CashBookEntry =>
  ({ id, entryDate: date, kind, amountCents, description: kind, reference: '', countId, createdAt: `${date}T08:00:00Z` });
const payment = (id: string, date: string, amountCents: number, method: string): Payment =>
  ({ id, invoiceId: 'i1', date, amountCents, method, reference: '' } as Payment);
const invoices = [{ id: 'i1', number: 'F-2026-001', status: 'sent' } as unknown as Invoice];

describe('livre de caisse', () => {
  it('recognises cash in four languages, like the native app', () => {
    expect(['Espèces', 'Cash', 'Bargeld', 'Bar', 'Contanti', 'caisse'].every(isCashMethod)).toBe(true);
    expect(['Virement', 'TWINT / carte (Payrexx)', 'barrière', ''].some(isCashMethod)).toBe(false);
  });

  it('merges entries and cash invoice payments with a running balance', () => {
    const workspace = {
      invoices,
      payments: [payment('p1', '2026-10-02', 8_000, 'Espèces'), payment('p2', '2026-10-02', 5_000, 'Virement')],
      cashBookEntries: [entry('e1', '2026-10-01', 'opening', 20_000), entry('e2', '2026-10-03', 'bank_deposit', -15_000)],
    };
    const lines = cashBookLines(workspace);
    expect(lines.map((line) => [line.id, line.balanceCents])).toEqual([['e1', 20_000], ['p1', 28_000], ['e2', 13_000]]);
    expect(lines[1]).toMatchObject({ kind: 'invoice_payment', label: 'F-2026-001' });
    expect(cashBalance(workspace, '2026-10-02')).toBe(28_000);
  });

  it('reminds the evening count and shows a difference until corrected', () => {
    const workspace = { invoices, payments: [], cashBookEntries: [entry('e1', '2026-10-20', 'receipt', 4_000)], cashCounts: [] as CashCount[] };
    expect(eveningCountDue(workspace, new Date(2026, 9, 20, 18, 0))).toBe(true);
    expect(eveningCountDue(workspace, new Date(2026, 9, 20, 12, 0))).toBe(false);
    const count: CashCount = { id: 'k1', countDate: '2026-10-20', countedCents: 2_800, expectedCents: 4_000, differenceCents: -1_200, denominations: {}, note: '', createdAt: '2026-10-20T18:00:00Z' };
    expect(eveningCountDue({ ...workspace, cashCounts: [count] }, new Date(2026, 9, 20, 18, 0))).toBe(false);
    expect(uncorrectedCount([count], workspace.cashBookEntries)?.id).toBe('k1');
    expect(uncorrectedCount([count], [...workspace.cashBookEntries, entry('e2', '2026-10-20', 'correction', -1_200, 'k1')])).toBeNull();
  });

  it('adds up notes and coins', () => {
    expect(countedCents({ 20_000: 2, 500: 3, 5: 1 })).toBe(41_505);
    expect(countedCents({})).toBe(0);
  });
});
