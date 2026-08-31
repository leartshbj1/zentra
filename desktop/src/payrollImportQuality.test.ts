import { describe, expect, it } from 'vitest';
import { assessPayrollDraft, isValidIban, isValidIsoCalendarDate, isValidSwissAvsNumber, payrollImportTotals } from './payrollImportQuality';
import type { PayrollImportDraft } from './types';

describe('contrôles déterministes de l’import paie', () => {
  it('refuse les dates calendaires impossibles', () => {
    expect(isValidIsoCalendarDate('2026-02-29')).toBe(false);
    expect(isValidIsoCalendarDate('2028-02-29')).toBe(true);
    expect(isValidIsoCalendarDate('2026-04-31')).toBe(false);
    expect(isValidIsoCalendarDate('')).toBe(true);
  });

  it('contrôle les clés AVS et IBAN sans accepter une simple forme', () => {
    expect(isValidSwissAvsNumber('756.9217.0769.85')).toBe(true);
    expect(isValidSwissAvsNumber('756.9217.0769.84')).toBe(false);
    expect(isValidIban('CH93 0076 2011 6238 5295 7')).toBe(true);
    expect(isValidIban('CH93 0076 2011 6238 5295 6')).toBe(false);
  });

  it('exclut les remboursements du brut et les ajoute au net', () => {
    const draft: PayrollImportDraft = {
      employee: {
        employeeNumber: '', name: 'Alex Exemple', role: '', addressLine1: '', addressLine2: '', postalCode: '', city: '', canton: '', birthDate: '', avsNumber: '', iban: '', employmentRate: 100, salaryMode: 'monthly',
      },
      period: '2026-08',
      paymentDate: '2026-08-25',
      grossCents: 500_000,
      netCents: 470_000,
      lines: [
        { id: 'salary', label: 'Salaire mensuel', kind: 'earning', amountCents: 500_000, recurring: true, confidenceBp: 9_000 },
        { id: 'deduction', label: 'Retenues', kind: 'deduction', amountCents: 50_000, recurring: false, confidenceBp: 9_000 },
        { id: 'expenses', label: 'Remboursement de frais', kind: 'reimbursement', amountCents: 20_000, recurring: false, confidenceBp: 9_000 },
      ],
      warnings: [],
    };
    expect(payrollImportTotals(draft.lines)).toEqual({
      gross: 500_000,
      deductions: 50_000,
      reimbursements: 20_000,
      employer: 0,
      net: 470_000,
    });
    expect(assessPayrollDraft(draft).blockers).toEqual([]);
  });
});
