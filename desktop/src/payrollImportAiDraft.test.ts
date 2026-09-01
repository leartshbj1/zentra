import { describe, expect, it } from 'vitest';
import { combinePayrollAiPageBatches, mergePayrollImportDraft, parsePayrollAiJson, reconcilePayrollAiPasses } from './payrollImportAiDraft';
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
      field_pages: { 'employee.employee_number': 1, 'employee.avs_number': 1, 'employee.iban': 1, 'employee.birth_date': 1, period: 1, payment_date: 1, gross_cents: 1, net_cents: 1 },
      lines: [{ label: 'Salaire mensuel', kind: 'earning', amount_cents: 500_000, recurring: true, confidence_bp: 9_100, source_page: 1 }, { label: 'Retenues', kind: 'deduction', amount_cents: 50_000, recurring: false, confidence_bp: 8_800, source_page: 1 }], warnings: [],
    });
    const verified = JSON.stringify({
      employee: { name: 'Alex Exemple', employee_number: 'E001', avs_number: '7569217076985', iban: 'CH9300762011623852957', birth_date: '1990-01-02', employment_rate: 80, salary_mode: 'monthly' },
      period: '2026-08', payment_date: '2026-08-25', gross_cents: 500_000, net_cents: 450_000,
      field_pages: { 'employee.employee_number': 1, 'employee.avs_number': 1, 'employee.iban': 1, 'employee.birth_date': 1, period: 1, payment_date: 1, gross_cents: 1, net_cents: 1 },
      lines: [{ label: 'Salaire mensuel', kind: 'earning', amount_cents: 500_000, recurring: true, confidence_bp: 8_300, source_page: 1 }, { label: 'Retenues', kind: 'deduction', amount_cents: 50_000, recurring: false, confidence_bp: 8_600, source_page: 1 }], warnings: [],
    });
    const result = reconcilePayrollAiPasses(primary, verified);
    expect(result.identity).toMatchObject({ passes: 2, employeeNumber: 'E001', avsNumber: '7569217076985', birthDate: '1990-01-02', iban: 'CH9300762011623852957', conflicts: [] });
    expect(result.draft.lines[0]).toMatchObject({ amountCents: 500_000, recurring: true, confidenceBp: 8_300 });
    expect(result.detected).toEqual({ employmentRate: true, salaryMode: true });
  });

  it('désactive le rattachement fort et rabaisse une rubrique sans page source concordante', () => {
    const raw = JSON.stringify({
      employee: { name: 'Alex Exemple', avs_number: '756.9217.0769.85' },
      period: '2026-08', payment_date: '', gross_cents: 500_000, net_cents: 500_000,
      lines: [{ label: 'Salaire mensuel', kind: 'earning', amount_cents: 500_000, recurring: true, confidence_bp: 9_200 }],
      warnings: [],
    });
    const result = reconcilePayrollAiPasses(raw, raw);
    expect(result.identity).toMatchObject({ passes: 1, avsNumber: '' });
    expect(result.draft.lines[0]).toMatchObject({ recurring: false, confidenceBp: 4_999 });
    expect(result.draft.warnings.join(' ')).toContain('page source non confirmée');
    expect(result.draft.warnings.join(' ')).toContain('propositions faibles');
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

  it('conserve uniquement une provenance de page entière et explicite', () => {
    const parsed = parsePayrollAiJson(JSON.stringify({
      employee: { name: 'Alex Exemple' }, period: '2026-08', payment_date: '', gross_cents: 500_000, net_cents: 500_000,
      field_pages: { 'employee.name': 2, period: [2, 2], gross_cents: 2.5, net_cents: 999 },
      lines: [{ label: 'Salaire', kind: 'earning', amount_cents: 500_000, recurring: true, confidence_bp: 9_000, source_page: 2 }], warnings: [],
    }));
    expect(parsed.provenance.fields).toEqual({ 'employee.name': [2], period: [2] });
    expect(parsed.provenance.lines[0].pages).toEqual([2]);
  });

  it('assemble tous les lots multipages et bloque une identité contradictoire', () => {
    const page = (pageNumber: number, employeeName: string, line: { label: string; kind: 'earning' | 'deduction'; amount: number }) => {
      const raw = JSON.stringify({
        employee: { name: employeeName, employee_number: 'E-001', avs_number: '756.9217.0769.85' },
        period: '2026-08', payment_date: '2026-08-25', gross_cents: 500_000, net_cents: 450_000,
        field_pages: { 'employee.name': pageNumber, 'employee.employee_number': pageNumber, 'employee.avs_number': pageNumber, period: pageNumber, gross_cents: pageNumber, net_cents: pageNumber },
        lines: [{ label: line.label, kind: line.kind, amount_cents: line.amount, recurring: line.kind === 'earning', confidence_bp: 9_000, source_page: pageNumber }], warnings: [],
      });
      return reconcilePayrollAiPasses(raw, raw);
    };
    const combined = combinePayrollAiPageBatches([
      { pageStart: 1, pageEnd: 1, analysis: page(1, 'Alex Exemple', { label: 'Salaire', kind: 'earning', amount: 500_000 }) },
      { pageStart: 2, pageEnd: 2, analysis: page(2, 'Autre Personne', { label: 'Retenues', kind: 'deduction', amount: 50_000 }) },
    ]);
    expect(combined.draft.lines).toHaveLength(2);
    expect(combined.draft.employee.name).toBe('');
    expect(combined.identity.passes).toBe(0);
    expect(combined.identity.conflicts).toContain('nom du collaborateur');
    expect(combined.draft.warnings.join(' ')).toContain('Conflit entre pages');
    expect(combined.draft.warnings.join(' ')).toContain('Provenance IA');
  });

  it('déduplique une même rubrique relue sur deux lots sans la compter deux fois', () => {
    const raw = (pageNumber: number) => JSON.stringify({
      employee: { name: 'Alex Exemple' }, period: '2026-08', payment_date: '2026-08-25', gross_cents: 500_000, net_cents: 500_000,
      field_pages: { 'employee.name': pageNumber, period: pageNumber, gross_cents: pageNumber, net_cents: pageNumber },
      lines: [{ label: 'Salaire mensuel', kind: 'earning', amount_cents: 500_000, recurring: true, confidence_bp: 9_000, source_page: pageNumber }], warnings: [],
    });
    const combined = combinePayrollAiPageBatches([
      { pageStart: 1, pageEnd: 1, analysis: reconcilePayrollAiPasses(raw(1), raw(1)) },
      { pageStart: 2, pageEnd: 2, analysis: reconcilePayrollAiPasses(raw(2), raw(2)) },
    ]);
    expect(combined.draft.lines).toHaveLength(1);
    expect(combined.provenance.lines[0].pages).toEqual([1, 2]);
  });

  it('écarte les deux montants quand une rubrique se contredit entre pages', () => {
    const raw = (pageNumber: number, amount: number) => JSON.stringify({
      employee: { name: 'Alex Exemple' }, period: '2026-08', payment_date: '', gross_cents: 0, net_cents: 0,
      field_pages: { 'employee.name': pageNumber, period: pageNumber },
      lines: [{ label: 'Cotisation LPP', kind: 'deduction', amount_cents: amount, recurring: false, confidence_bp: 9_000, source_page: pageNumber }], warnings: [],
    });
    const combined = combinePayrollAiPageBatches([
      { pageStart: 1, pageEnd: 1, analysis: reconcilePayrollAiPasses(raw(1, 25_000), raw(1, 25_000)) },
      { pageStart: 2, pageEnd: 2, analysis: reconcilePayrollAiPasses(raw(2, 26_000), raw(2, 26_000)) },
    ]);
    expect(combined.draft.lines).toEqual([]);
    expect(combined.draft.warnings.join(' ')).toContain('ont tous deux été écartés');
  });
});
