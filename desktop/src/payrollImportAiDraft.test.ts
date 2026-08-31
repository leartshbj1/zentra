import { describe, expect, it } from 'vitest';
import { mergePayrollImportDraft, parsePayrollAiJson } from './payrollImportAiDraft';
import type { PayrollImportDraft } from './types';

function existingDraft(): PayrollImportDraft {
  return {
    employee: {
      employeeNumber: '', name: '', role: '', addressLine1: '', addressLine2: '', postalCode: '', city: '', canton: '', birthDate: '', avsNumber: '', iban: '',
      employmentRate: 100,
      salaryMode: 'monthly',
    },
    period: '', paymentDate: '', grossCents: 0, netCents: 0, lines: [], warnings: [],
  };
}

function aiJson(employmentRate: number | null, salaryMode: 'monthly' | 'hourly' | null) {
  return JSON.stringify({
    employee: { employment_rate: employmentRate, salary_mode: salaryMode },
    period: '', payment_date: '', gross_cents: 0, net_cents: 0, lines: [], warnings: [],
  });
}

describe('fusion du brouillon de paie et de la lecture IA', () => {
  it('remplace les valeurs d’interface non confirmées par les valeurs réellement détectées', () => {
    const merged = mergePayrollImportDraft(existingDraft(), parsePayrollAiJson(aiJson(80, 'hourly')));
    expect(merged.employee.employmentRate).toBe(80);
    expect(merged.employee.salaryMode).toBe('hourly');
  });

  it('préserve les valeurs explicitement modifiées par la personne', () => {
    const merged = mergePayrollImportDraft(
      existingDraft(),
      parsePayrollAiJson(aiJson(80, 'hourly')),
      { employmentRate: true, salaryMode: true },
    );
    expect(merged.employee.employmentRate).toBe(100);
    expect(merged.employee.salaryMode).toBe('monthly');
  });

  it('ne traite pas les champs IA absents comme 100 pour cent et mensuel détectés', () => {
    const current = existingDraft();
    current.employee.employmentRate = 60;
    current.employee.salaryMode = 'hourly';
    const parsed = parsePayrollAiJson(aiJson(null, null));
    const merged = mergePayrollImportDraft(current, parsed);
    expect(parsed.detected).toEqual({ employmentRate: false, salaryMode: false });
    expect(merged.employee.employmentRate).toBe(60);
    expect(merged.employee.salaryMode).toBe('hourly');
  });

  it('préserve les remboursements hors brut et interdit leur récurrence', () => {
    const parsed = parsePayrollAiJson(JSON.stringify({
      employee: {},
      period: '2026-08',
      payment_date: '2026-08-25',
      gross_cents: 500_000,
      net_cents: 470_000,
      lines: [
        { label: 'Salaire mensuel', kind: 'earning', amount_cents: 500_000, recurring: true, confidence_bp: 9_000 },
        { label: 'Frais de déplacement', kind: 'non_gross_payment', amount_cents: 20_000, recurring: true, confidence_bp: 8_500 },
      ],
      warnings: [],
    }));
    expect(parsed.draft.lines[1]).toMatchObject({
      kind: 'reimbursement',
      amountCents: 20_000,
      recurring: false,
    });
  });
});
