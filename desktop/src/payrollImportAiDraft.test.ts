import { describe, expect, it } from 'vitest';
import { mergePayrollImportDraft, parsePayrollAiJson, reconcilePayrollAiPasses } from './payrollImportAiDraft';
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

  it('ne retient comme forte que la valeur concordante des deux lectures', () => {
    const primary = JSON.stringify({
      employee: { name: 'Alex Exemple', employee_number: 'E-001', avs_number: '756.9217.0769.85', iban: 'CH93 0076 2011 6238 5295 7', birth_date: '1990-01-02', employment_rate: 80, salary_mode: 'monthly' },
      period: '2026-08', payment_date: '2026-08-25', gross_cents: 500_000, net_cents: 450_000,
      lines: [{ label: 'Salaire mensuel', kind: 'earning', amount_cents: 500_000, recurring: true, confidence_bp: 9_100 }, { label: 'Retenues', kind: 'deduction', amount_cents: 50_000, recurring: false, confidence_bp: 8_800 }], warnings: [],
    });
    const verified = JSON.stringify({
      employee: { name: 'Alex Exemple', employee_number: 'E001', avs_number: '7569217076985', iban: 'CH9300762011623852957', birth_date: '1990-01-02', employment_rate: 80, salary_mode: 'monthly' },
      period: '2026-08', payment_date: '2026-08-25', gross_cents: 500_000, net_cents: 450_000,
      lines: [{ label: 'Salaire mensuel', kind: 'earning', amount_cents: 500_000, recurring: true, confidence_bp: 8_300 }, { label: 'Retenues', kind: 'deduction', amount_cents: 50_000, recurring: false, confidence_bp: 8_600 }], warnings: [],
    });
    const result = reconcilePayrollAiPasses(primary, verified);
    expect(result.identity).toMatchObject({ passes: 2, employeeNumber: 'E001', avsNumber: '7569217076985', birthDate: '1990-01-02', iban: 'CH9300762011623852957', conflicts: [] });
    expect(result.draft.lines[0]).toMatchObject({ amountCents: 500_000, recurring: true, confidenceBp: 8_300 });
    expect(result.detected).toEqual({ employmentRate: true, salaryMode: true });
  });

  it('écarte les identités, totaux et rubriques contradictoires', () => {
    const primary = JSON.stringify({ employee: { name: 'Alex Exemple', avs_number: '756.9217.0769.85' }, period: '2026-08', payment_date: '', gross_cents: 500_000, net_cents: 450_000, lines: [{ label: 'Salaire', kind: 'earning', amount_cents: 500_000, recurring: true, confidence_bp: 9_000 }], warnings: [] });
    const verified = JSON.stringify({ employee: { name: 'Alex Exemple', avs_number: '756.9217.0769.84' }, period: '2026-09', payment_date: '', gross_cents: 510_000, net_cents: 450_000, lines: [{ label: 'Salaire', kind: 'earning', amount_cents: 510_000, recurring: true, confidence_bp: 9_500 }], warnings: [] });
    const result = reconcilePayrollAiPasses(primary, verified);
    expect(result.identity.avsNumber).toBe('');
    expect(result.identity.conflicts).toContain('numéro AVS');
    expect(result.draft.period).toBe('');
    expect(result.draft.grossCents).toBe(0);
    expect(result.draft.lines).toEqual([]);
    expect(result.draft.warnings.join(' ')).toContain('n’ont pas concordé');
  });

  it('conserve une lecture unique comme proposition faible sans identité automatique', () => {
    const valid = JSON.stringify({ employee: { name: 'Alex Exemple', avs_number: '756.9217.0769.85' }, period: '2026-08', payment_date: '', gross_cents: 100_000, net_cents: 100_000, lines: [{ label: 'Salaire', kind: 'earning', amount_cents: 100_000, recurring: true, confidence_bp: 9_000 }], warnings: [] });
    const result = reconcilePayrollAiPasses('pas du json', valid);
    expect(result.identity.passes).toBe(1);
    expect(result.identity.avsNumber).toBe('');
    expect(result.draft.lines[0]).toMatchObject({ recurring: false, confidenceBp: 4_999 });
  });

  it('écarte une classification IA inconnue au lieu de la transformer en gain', () => {
    const parsed = parsePayrollAiJson(JSON.stringify({
      employee: {}, period: '2026-08', payment_date: '', gross_cents: 0, net_cents: 0,
      lines: [{ label: 'Texte injecté', kind: 'salary_bonus_unknown', amount_cents: 900_000, recurring: true, confidence_bp: 9_999 }], warnings: [],
    }));
    expect(parsed.draft.lines).toEqual([]);
    expect(parsed.draft.warnings.join(' ')).toContain('classification IA inconnue');
  });
});
