import { describe, expect, it } from 'vitest';
import type { Invoice } from './types';
import { dashboardDeadlines } from './dashboardDeadlines';

const invoice = (id: string, dueDate: string, status = 'issued', type = 'invoice') => ({id, dueDate, status, type}) as Invoice;
describe('dashboard deadlines', () => {
  it('shows the earliest outstanding invoices, not the most recently inserted ones', () => {
    const rows = [invoice('later','2026-11-02'), invoice('partial','2026-10-01','partially_paid'), invoice('overdue','2026-08-31')];
    expect(dashboardDeadlines(rows,2).map(row=>row.id)).toEqual(['overdue','partial']);
    expect(rows.map(row=>row.id)).toEqual(['later','partial','overdue']);
  });
  it('excludes paid, draft, cancelled and credit notes; leaves unknown due dates last', () => {
    const rows = [invoice('unknown',''), invoice('paid','2026-01-01','paid'), invoice('draft','2026-01-01','draft'), invoice('cancelled','2026-01-01','cancelled'), invoice('credit','2026-01-01','issued','credit_note'), invoice('due','2026-10-01')];
    expect(dashboardDeadlines(rows).map(row=>row.id)).toEqual(['due','unknown']);
  });
});
