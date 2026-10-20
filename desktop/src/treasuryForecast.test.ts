import { describe, expect, it } from 'vitest';
import { forecastEvents, plusDays, treasuryForecast } from './treasuryForecast';
import type { Contract, Workspace } from './types';

const line = (cents: number) => ({ id: 'l', description: 'Prestation', quantity: 1, unit: 'forfait', unitPriceCents: cents, discountBp: 0, vatRateBp: 0 });
const workspace = (): Parameters<typeof treasuryForecast>[0] => ({
  invoices: [
    { id: 'i1', number: 'F-1', type: 'standard', status: 'sent', currency: 'CHF', dueDate: '2026-10-30', lines: [line(500_000)] },
    { id: 'i2', number: 'F-2', type: 'standard', status: 'overdue', currency: 'CHF', dueDate: '2026-09-30', lines: [line(100_000)] },
    { id: 'i3', number: 'F-3', type: 'standard', status: 'paid', currency: 'CHF', dueDate: '2026-11-30', lines: [line(900_000)] },
  ] as unknown as Workspace['invoices'],
  payments: [{ id: 'p1', invoiceId: 'i1', date: '2026-10-05', amountCents: 100_000, method: 'Virement', reference: '' }] as Workspace['payments'],
  supplierInvoices: [{ id: 's1', supplierName: 'Bois SA', documentStatus: 'validated', balanceCents: 300_000, currency: 'CHF', dueDate: '2026-11-10' }] as unknown as Workspace['supplierInvoices'],
  expenses: [{ id: 'x1', supplier: 'Garage', paymentStatus: 'pending', dueDate: '2026-10-25', totalCents: 50_000 }] as unknown as Workspace['expenses'],
  payslips: [
    { id: 'ps1', period: '2026-09', status: 'paid', paymentDate: '2026-09-25', lines: [{ kind: 'earning', amountCents: 600_000 }, { kind: 'deduction', amountCents: 80_000 }] },
    { id: 'ps2', period: '2026-09', status: 'paid', paymentDate: '2026-09-25', lines: [{ kind: 'earning', amountCents: 400_000 }] },
  ] as unknown as Workspace['payslips'],
  recurrenceSchedules: [{ id: 'r1', sourceSalesOrderId: 'o1', frequency: 'monthly', nextScheduledFor: '2026-11-01', paymentTermsDays: 30, endDate: null, status: 'active' }] as unknown as Workspace['recurrenceSchedules'],
  salesOrders: [{ id: 'o1', number: 'C-1', currency: 'CHF', totalCents: 120_000 }] as unknown as Workspace['salesOrders'],
  contracts: [{ id: 'c1', side: 'supplier', title: 'Loyer', amountCents: 240_000, currency: 'CHF', frequency: 'monthly', startDate: '2024-04-01', endDate: null, autoRenew: true, renewalMonths: 12, status: 'active', terminatedOn: null } as Contract],
});

describe('prévision de trésorerie', () => {
  it('collects what is already known, in date order', () => {
    const events = forecastEvents(workspace(), '2026-10-20');
    expect(events.map((event) => [event.date, event.kind, event.amountCents])).toEqual([
      ['2026-10-25', 'payroll', -920_000],
      ['2026-10-25', 'expense', -50_000],
      ['2026-10-27', 'overdue', 100_000],
      ['2026-10-30', 'invoice', 400_000],
      ['2026-11-01', 'contract', -240_000],
      ['2026-11-10', 'supplier', -300_000],
      ['2026-11-25', 'payroll', -920_000],
      ['2026-12-01', 'contract', -240_000],
      ['2026-12-01', 'recurring', 120_000],
      ['2026-12-25', 'payroll', -920_000],
      ['2026-12-31', 'recurring', 120_000],
      ['2027-01-01', 'contract', -240_000],
    ]);
  });

  it('gives the balance at 30, 60 and 90 days and the low point with its cause', () => {
    const forecast = treasuryForecast(workspace(), 2_000_000, '2026-10-20');
    expect(forecast.at[30]).toBe(2_000_000 - 50_000 - 920_000 + 100_000 + 400_000 - 240_000 - 300_000);
    expect(forecast.at[90]).toBe(forecast.at[30] - 920_000 - 240_000 + 120_000 - 920_000 + 120_000 - 240_000);
    expect(forecast.low.date).toBe('2026-11-10');
    expect(forecast.low.cause?.kind).toBe('supplier');
    expect(plusDays('2026-12-31', 1)).toBe('2027-01-01');
    // TVA calculée : sort à son échéance et peut devenir la cause du creux.
    const withVat = treasuryForecast(workspace(), 2_000_000, '2026-10-20', [{ date: '2026-11-15', kind: 'vat', label: '', amountCents: -1_500_000 }, { date: '2027-06-01', kind: 'vat', label: '', amountCents: -1 }]);
    expect(withVat.low).toMatchObject({ date: '2026-11-15', cause: { kind: 'vat' } });
    expect(withVat.events.some((event) => event.date === '2027-06-01')).toBe(false);
  });
});
