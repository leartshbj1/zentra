import { describe, expect, it } from 'vitest';
import { assessPayrollDraft, isValidIban, isValidIsoCalendarDate, isValidSwissAvsNumber, mergePayrollLines, payrollControlQualityLabel, payrollImportTotals } from './payrollImportQuality';
import type { PayrollImportDraft, PayrollImportLineDraft } from './types';

describe('contrôles déterministes de l’import paie', () => {
  it('présente les scores internes comme catégories sans fausse précision', () => {
    expect(payrollControlQualityLabel(9_000)).toBe('élevée');
    expect(payrollControlQualityLabel(6_500)).toBe('moyenne');
    expect(payrollControlQualityLabel(4_999)).toBe('faible');
  });
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

  it('bloque une date de naissance impossible avant la confirmation', () => {
    const draft: PayrollImportDraft = {
      employee: {
        employeeNumber: '', name: 'Alex Exemple', role: '', addressLine1: '', addressLine2: '', postalCode: '', city: '', canton: '', birthDate: '2026-02-30', avsNumber: '', iban: '', employmentRate: 100, salaryMode: 'monthly',
      },
      period: '2026-08',
      paymentDate: '',
      grossCents: 500_000,
      netCents: 500_000,
      lines: [
        { id: 'salary', label: 'Salaire mensuel', kind: 'earning', amountCents: 500_000, recurring: true, confidenceBp: 9_000 },
      ],
      warnings: [],
    };

    expect(assessPayrollDraft(draft).blockers).toContain('La date de naissance détectée est invalide.');
  });

  it('apparie les occurrences une à une et conserve une deuxième occurrence IA identique', () => {
    const textLine: PayrollImportLineDraft = {
      id: 'text-1', label: 'Indemnité repas', kind: 'earning', amountCents: 2_000, recurring: false, confidenceBp: 8_000,
    };
    const detected = [
      { ...textLine, id: 'ai-1', confidenceBp: 9_000 },
      { ...textLine, id: 'ai-2', confidenceBp: 9_000 },
    ];

    const merged = mergePayrollLines([textLine], detected);

    expect(merged.lines).toHaveLength(2);
    expect(merged.lines.map((line) => line.id)).toEqual(['text-1', 'ai-2']);
  });

  it('conserve séparément les occurrences IA de même libellé avec des montants distincts', () => {
    const current: PayrollImportLineDraft[] = [
      { id: 'text-1', label: 'Heures supplémentaires', kind: 'earning', amountCents: 15_000, recurring: false, confidenceBp: 8_000 },
    ];
    const detected: PayrollImportLineDraft[] = [
      { id: 'ai-1', label: 'Heures supplémentaires', kind: 'earning', amountCents: 15_000, recurring: false, confidenceBp: 9_000 },
      { id: 'ai-2', label: 'Heures supplémentaires', kind: 'earning', amountCents: 22_000, recurring: false, confidenceBp: 9_000 },
    ];

    const merged = mergePayrollLines(current, detected);

    expect(merged.lines.map((line) => line.amountCents)).toEqual([15_000, 22_000]);
    expect(merged.warnings.join(' ')).toContain('conservée séparément');
  });

  it('ne tronque pas silencieusement une fusion au-delà de 80 rubriques', () => {
    const current: PayrollImportLineDraft[] = [{
      id: 'text-1', label: 'Salaire', kind: 'earning', amountCents: 1_000, recurring: false, confidenceBp: 8_000,
    }];
    const detected: PayrollImportLineDraft[] = Array.from({ length: 80 }, (_, index) => ({
      id: `ai-${index + 1}`, label: `Prime ${index + 1}`, kind: 'earning', amountCents: 100, recurring: false, confidenceBp: 9_000,
    }));

    const merged = mergePayrollLines(current, detected);

    expect(merged.lines).toHaveLength(81);
    const draft: PayrollImportDraft = {
      employee: { employeeNumber: '', name: 'Alex', role: '', addressLine1: '', addressLine2: '', postalCode: '', city: '', canton: '', birthDate: '', avsNumber: '', iban: '', employmentRate: 100, salaryMode: 'monthly' },
      period: '2026-08', paymentDate: '', grossCents: 9_000, netCents: 9_000, lines: merged.lines, warnings: [],
    };
    expect(assessPayrollDraft(draft).blockers.join(' ')).toMatch(/81 rubriques.*80/);
  });
});
