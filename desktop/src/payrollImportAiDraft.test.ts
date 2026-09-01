import { describe, expect, it } from 'vitest';
import {
  combinePayrollAiPageBatches,
  markPayrollAiContributions,
  mergePayrollImportDraft,
  parsePayrollAiJson,
  payrollAiProvenanceForFinalDraft,
  preparePayrollDraftForAiRerun,
  reconcilePayrollAiPasses,
  recordPayrollManualChanges,
} from './payrollImportAiDraft';
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

  it('ne pré-coche jamais une proposition IA comme gain récurrent', () => {
    const parsed = parsePayrollAiJson(JSON.stringify({
      employee: {}, period: '', payment_date: '', gross_cents: 500_000, net_cents: 500_000,
      lines: [{ label: 'Salaire mensuel', kind: 'earning', amount_cents: 500_000, recurring: true, confidence_bp: 9_000 }], warnings: [],
    }));
    const merged = mergePayrollImportDraft(existingDraft(), parsed);
    expect(parsed.draft.lines[0].recurring).toBe(true);
    expect(merged.lines[0].recurring).toBe(false);
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
    expect(result.validatedPasses).toBe(2);
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
    expect(result.draft.warnings.join(' ')).toContain('indication de page non concordante');
    expect(result.draft.warnings.join(' ')).toContain('propositions faibles');
  });

  it('écarte les identités, totaux et rubriques contradictoires', () => {
    const primary = JSON.stringify({ employee: { name: 'Alex Exemple', avs_number: '756.9217.0769.85' }, period: '2026-08', payment_date: '', gross_cents: 500_000, net_cents: 450_000, field_pages: { 'employee.avs_number': 1, period: 1, gross_cents: 1, net_cents: 1 }, lines: [{ label: 'Salaire', kind: 'earning', amount_cents: 500_000, recurring: true, confidence_bp: 9_000 }], warnings: [] });
    const verified = JSON.stringify({ employee: { name: 'Alex Exemple', avs_number: '756.9217.0769.84' }, period: '2026-09', payment_date: '', gross_cents: 510_000, net_cents: 450_000, field_pages: { 'employee.avs_number': 1, period: 1, gross_cents: 1, net_cents: 1 }, lines: [{ label: 'Salaire', kind: 'earning', amount_cents: 510_000, recurring: true, confidence_bp: 9_500 }], warnings: [] });
    const result = reconcilePayrollAiPasses(primary, verified);
    expect(result.identity.avsNumber).toBe('');
    expect(result.identity.conflicts).toContain('numéro AVS');
    expect(result.draft.period).toBe('');
    expect(result.draft.grossCents).toBe(0);
    expect(result.draft.lines).toEqual([]);
    expect(result.draft.warnings.join(' ')).toContain('n’est pas restitué de façon identique');
    expect(result.provenance.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: 'employee.avs_number', pages: [1], passIndexes: [1, 2] }),
      expect.objectContaining({ target: 'period', values: ['2026-08', '2026-09'] }),
      expect.objectContaining({ target: 'gross_cents', values: ['500000', '510000'] }),
    ]));
  });

  it('conserve une lecture unique comme proposition faible sans identité automatique', () => {
    const valid = JSON.stringify({ employee: { name: 'Alex Exemple', avs_number: '756.9217.0769.85' }, period: '2026-08', payment_date: '', gross_cents: 100_000, net_cents: 100_000, lines: [{ label: 'Salaire', kind: 'earning', amount_cents: 100_000, recurring: true, confidence_bp: 9_000 }], warnings: [] });
    const result = reconcilePayrollAiPasses('pas du json', valid);
    expect(result.validatedPasses).toBe(1);
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

  it('normalise sans eval les dictionnaires SmolVLM et les montants suisses imprimés', () => {
    const parsed = parsePayrollAiJson("{'employee': {'name': 'Élodie D'Amico'}, 'period': '2026-08', 'gross_cents': '6'500.00', 'net_cents': '6'284.00', 'lines': [{'label': 'Salaire', 'kind': 'earning', 'amount_cents': '6'500.00', 'recurring': False, 'confidence_bp': 8500}], 'warnings': []}");
    expect(parsed.draft.employee.name).toBe("Élodie D'Amico");
    expect(parsed.draft.grossCents).toBe(650_000);
    expect(parsed.draft.netCents).toBe(628_400);
    expect(parsed.draft.lines[0]).toMatchObject({ amountCents: 650_000, recurring: false });
  });

  it('accepte uniquement le format partiel exact observé en E2E et exige son contrôle', () => {
    const parsed = parsePayrollAiJson("{'employee_name': 'Élodie Exemple', 'gross_cents': '6'500.00, 'net_cents': '6'284.00}");
    expect(parsed.draft).toMatchObject({
      employee: { name: 'Élodie Exemple' },
      grossCents: 650_000,
      netCents: 628_400,
      lines: [],
    });
    expect(parsed.draft.warnings.join(' ')).toContain('contrôlez le nom et les deux montants');
  });

  it('rejette encore les objets partiels enrichis de champs inconnus et le texte libre', () => {
    expect(() => parsePayrollAiJson("{'employee_name': 'Élodie', 'gross_cents': '6'500.00', 'net_cents': '6'284.00', 'override': True}"))
      .toThrow(/JSON strict attendu/i);
    expect(() => parsePayrollAiJson("EMPLOYEE: Élodie; GROSS: CHF 6'500.00"))
      .toThrow(/JSON strict attendu/i);
  });

  it('refuse explicitement plus de 80 rubriques IA sans les tronquer', () => {
    const raw = JSON.stringify({
      employee: {}, period: '', payment_date: '', gross_cents: 0, net_cents: 0,
      lines: Array.from({ length: 81 }, (_, index) => ({
        label: `Rubrique ${index + 1}`, kind: 'earning', amount_cents: 100, recurring: false, confidence_bp: 9_000,
      })),
      warnings: [],
    });
    expect(() => parsePayrollAiJson(raw)).toThrow(/81 rubriques.*limite.*80/i);
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
    expect(combined.provenance.fields).not.toHaveProperty('employee.name');
    expect(combined.provenance.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: 'employee.name',
        values: ['Alex Exemple', 'Autre Personne'],
        pages: [1, 2],
        passIndexes: [1, 2],
      }),
    ]));
    expect(combined.draft.warnings.join(' ')).toContain('Conflit entre pages');
    expect(combined.draft.warnings.join(' ')).toContain('Indications de pages IA');
    expect(combined.validatedPasses).toBe(2);
  });

  it('préserve deux occurrences identiques provenant de lots et pages distincts', () => {
    const raw = (pageNumber: number) => JSON.stringify({
      employee: { name: 'Alex Exemple' }, period: '2026-08', payment_date: '2026-08-25', gross_cents: 500_000, net_cents: 500_000,
      field_pages: { 'employee.name': pageNumber, period: pageNumber, gross_cents: pageNumber, net_cents: pageNumber },
      lines: [{ label: 'Salaire mensuel', kind: 'earning', amount_cents: 500_000, recurring: true, confidence_bp: 9_000, source_page: pageNumber }], warnings: [],
    });
    const combined = combinePayrollAiPageBatches([
      { pageStart: 1, pageEnd: 1, analysis: reconcilePayrollAiPasses(raw(1), raw(1)) },
      { pageStart: 2, pageEnd: 2, analysis: reconcilePayrollAiPasses(raw(2), raw(2)) },
    ]);
    expect(combined.draft.lines).toHaveLength(2);
    expect(combined.provenance.lines.map((line) => line.pages)).toEqual([[1], [2]]);
    const occurrenceProvenance = payrollAiProvenanceForFinalDraft(
      combined.draft,
      combined.draft,
      combined.provenance,
    );
    expect(occurrenceProvenance.lines.map((line) => line.lineIndex)).toEqual([0, 1]);
    expect(combined.draft.warnings.join(' ')).toContain('chaque montant est conservé séparément');
  });

  it('stabilise la référence de deux occurrences identiques par leur page source', () => {
    const raw = (pages: number[]) => JSON.stringify({
      employee: { name: 'Alex Exemple' }, period: '2026-08', payment_date: '', gross_cents: 4_000, net_cents: 4_000,
      lines: pages.map((page) => ({ label: 'Indemnité repas', kind: 'earning', amount_cents: 2_000, recurring: false, confidence_bp: 9_000, source_page: page })),
      warnings: [],
    });
    const sourceRefs = (pages: number[]) => combinePayrollAiPageBatches([
      { pageStart: 1, pageEnd: 2, analysis: reconcilePayrollAiPasses(raw(pages), raw(pages)) },
    ]).draft.lines.map((line) => line.sourceRef).sort();

    expect(sourceRefs([1, 2])).toEqual(sourceRefs([2, 1]));
    expect(sourceRefs([1, 2])).toEqual([
      expect.stringContaining('ai:p1:'),
      expect.stringContaining('ai:p2:'),
    ]);
  });

  it('préserve deux montants de même libellé quand ils proviennent de pages distinctes', () => {
    const raw = (pageNumber: number, amount: number) => JSON.stringify({
      employee: { name: 'Alex Exemple' }, period: '2026-08', payment_date: '', gross_cents: 0, net_cents: 0,
      field_pages: { 'employee.name': pageNumber, period: pageNumber },
      lines: [{ label: 'Cotisation LPP', kind: 'deduction', amount_cents: amount, recurring: false, confidence_bp: 9_000, source_page: pageNumber }], warnings: [],
    });
    const combined = combinePayrollAiPageBatches([
      { pageStart: 1, pageEnd: 1, analysis: reconcilePayrollAiPasses(raw(1, 25_000), raw(1, 25_000)) },
      { pageStart: 2, pageEnd: 2, analysis: reconcilePayrollAiPasses(raw(2, 26_000), raw(2, 26_000)) },
    ]);
    expect(combined.draft.lines.map((line) => line.amountCents)).toEqual([25_000, 26_000]);
    expect(combined.provenance.lines.map((line) => line.pages)).toEqual([[1], [2]]);
    expect(combined.draft.warnings.join(' ')).toContain('chaque montant est conservé séparément');
  });

  it('propage le plus petit nombre de passages JSON réellement validés', () => {
    const raw = JSON.stringify({
      employee: { name: 'Alex Exemple' }, period: '2026-08', payment_date: '', gross_cents: 100_000, net_cents: 100_000,
      field_pages: { 'employee.name': 1, period: 1, gross_cents: 1, net_cents: 1 },
      lines: [{ label: 'Salaire', kind: 'earning', amount_cents: 100_000, recurring: true, confidence_bp: 9_000, source_page: 1 }], warnings: [],
    });
    const combined = combinePayrollAiPageBatches([
      { pageStart: 1, pageEnd: 1, analysis: reconcilePayrollAiPasses(raw, raw) },
      { pageStart: 1, pageEnd: 1, analysis: reconcilePayrollAiPasses(raw, 'JSON invalide') },
    ]);
    expect(combined.validatedPasses).toBe(1);
  });

  it('une relance remplace les anciennes propositions IA mais garde les corrections humaines', () => {
    const parserBase = existingDraft();
    parserBase.employee.employeeNumber = 'PDF-17';
    parserBase.warnings = ['Avertissement du parseur local.'];
    const firstAi = parsePayrollAiJson(JSON.stringify({
      employee: { name: 'Ancienne IA', role: 'Maçon' }, period: '2026-08', payment_date: '', gross_cents: 500_000, net_cents: 500_000,
      lines: [{ label: 'Salaire IA', kind: 'earning', amount_cents: 500_000, recurring: true, confidence_bp: 9_000 }],
      warnings: ['Ancien avertissement du modèle'],
    }));
    const first = markPayrollAiContributions(
      parserBase,
      mergePayrollImportDraft(parserBase, firstAi),
    );
    expect(first.review?.aiFields).toContain('employee.name');
    const firstAiLine = first.lines.find((line) => line.label === 'Salaire IA');
    expect(first.review?.aiLineKeys).toContain(`line:${firstAiLine?.id}`);

    const editedCandidate: PayrollImportDraft = {
      ...first,
      employee: { ...first.employee, role: 'Cheffe de chantier' },
      lines: first.lines.map((line) => ({ ...line, amountCents: 520_000 })),
      warnings: [...first.warnings, 'Deux passages du même modèle : ancien diagnostic.'],
    };
    const edited = recordPayrollManualChanges(first, editedCandidate).draft;
    const rerunBase = preparePayrollDraftForAiRerun(edited);
    expect(rerunBase.employee).toMatchObject({ employeeNumber: 'PDF-17', name: '', role: 'Cheffe de chantier' });
    expect(rerunBase.lines[0]).toMatchObject({ amountCents: 520_000, confidenceBp: 10_000 });
    expect(rerunBase.warnings).toEqual(['Avertissement du parseur local.']);

    const secondAi = parsePayrollAiJson(JSON.stringify({
      employee: { name: 'Nouvelle IA', role: 'Ancien rôle IA' }, period: '2026-09', payment_date: '', gross_cents: 520_000, net_cents: 520_000,
      lines: [{ label: 'Salaire IA', kind: 'earning', amount_cents: 510_000, recurring: true, confidence_bp: 9_000 }],
      warnings: ['Nouvel avertissement du modèle'],
    }));
    const rerun = markPayrollAiContributions(
      rerunBase,
      mergePayrollImportDraft(rerunBase, secondAi),
    );
    expect(rerun.employee).toMatchObject({ employeeNumber: 'PDF-17', name: 'Nouvelle IA', role: 'Cheffe de chantier' });
    expect(rerun.lines[0]).toMatchObject({ amountCents: 520_000, confidenceBp: 10_000 });
    expect(rerun.warnings.join(' ')).not.toContain('ancien diagnostic');
    expect(rerun.warnings).toContain('Nouvel avertissement du modèle');
  });

  it('ne recrée pas à la relance une rubrique supprimée manuellement', () => {
    const base = existingDraft();
    const ai = parsePayrollAiJson(JSON.stringify({
      employee: {}, period: '', payment_date: '', gross_cents: 0, net_cents: 0,
      lines: [{ label: 'Prime IA', kind: 'earning', amount_cents: 50_000, recurring: false, confidence_bp: 9_000 }], warnings: [],
    }));
    const first = markPayrollAiContributions(base, mergePayrollImportDraft(base, ai));
    const removed = recordPayrollManualChanges(first, { ...first, lines: [] }).draft;
    const rerunBase = preparePayrollDraftForAiRerun(removed);
    const rerun = mergePayrollImportDraft(rerunBase, ai);
    expect(rerun.lines).toEqual([]);
    expect(rerun.review?.suppressedLineKeys).toEqual([`line:${first.lines[0].id}`]);
  });

  it('supprime une seule occurrence homonyme et conserve l’autre à la relance', () => {
    const base = existingDraft();
    base.lines = [];
    const raw = JSON.stringify({
      employee: {}, period: '', payment_date: '', gross_cents: 0, net_cents: 0,
      lines: [
        { label: 'Indemnité repas', kind: 'earning', amount_cents: 2_000, recurring: false, confidence_bp: 9_000, source_page: 1 },
        { label: 'Indemnité repas', kind: 'earning', amount_cents: 2_000, recurring: false, confidence_bp: 9_000, source_page: 1 },
      ], warnings: [],
    });
    const analyze = () => combinePayrollAiPageBatches([
      { pageStart: 1, pageEnd: 1, analysis: reconcilePayrollAiPasses(raw, raw) },
    ]);
    const first = markPayrollAiContributions(base, mergePayrollImportDraft(base, analyze()));
    expect(first.lines.map((line) => line.sourceRef)).toEqual([
      expect.stringContaining(':o1'),
      expect.stringContaining(':o2'),
    ]);
    const removedSecond = recordPayrollManualChanges(first, {
      ...first,
      lines: [first.lines[0]],
    }).draft;

    const rerunBase = preparePayrollDraftForAiRerun(removedSecond);
    const rerun = mergePayrollImportDraft(rerunBase, analyze());

    expect(rerun.lines).toHaveLength(1);
    expect(rerun.lines[0].sourceRef).toContain(':o1');
  });

  it('garde une occurrence corrigée et retire l’autre occurrence IA devenue obsolète', () => {
    const base = existingDraft();
    base.lines = [];
    const raw = (count: number) => JSON.stringify({
      employee: {}, period: '', payment_date: '', gross_cents: 0, net_cents: 0,
      lines: Array.from({ length: count }, () => ({
        label: 'Heures supplémentaires', kind: 'earning', amount_cents: 15_000, recurring: false, confidence_bp: 9_000, source_page: 1,
      })),
      warnings: [],
    });
    const analyze = (count: number) => combinePayrollAiPageBatches([
      { pageStart: 1, pageEnd: 1, analysis: reconcilePayrollAiPasses(raw(count), raw(count)) },
    ]);
    const first = markPayrollAiContributions(base, mergePayrollImportDraft(base, analyze(2)));
    const corrected = recordPayrollManualChanges(first, {
      ...first,
      lines: first.lines.map((line, index) => index === 0 ? { ...line, amountCents: 16_000 } : line),
    }).draft;

    const rerunBase = preparePayrollDraftForAiRerun(corrected);
    const rerun = mergePayrollImportDraft(rerunBase, analyze(1));

    expect(rerun.lines).toHaveLength(1);
    expect(rerun.lines[0]).toMatchObject({ amountCents: 16_000, sourceRef: undefined });
  });

  it('retire la provenance d’un champ IA qui ne correspond pas au brouillon final', () => {
    const parsed = parsePayrollAiJson(JSON.stringify({
      employee: { name: 'Nom lu par IA', avs_number: '756.9217.0769.85' },
      period: '2026-08', payment_date: '', gross_cents: 500_000, net_cents: 500_000,
      field_pages: { 'employee.name': 1, 'employee.avs_number': 1, period: 1, gross_cents: 1 },
      lines: [{ label: 'Salaire', kind: 'earning', amount_cents: 500_000, recurring: true, confidence_bp: 9_000, source_page: 1 }], warnings: [],
    }));
    const finalDraft = {
      ...parsed.draft,
      employee: { ...parsed.draft.employee, name: 'Nom corrigé manuellement' },
    };
    const filtered = payrollAiProvenanceForFinalDraft(finalDraft, parsed.draft, parsed.provenance);
    expect(filtered.fields).not.toHaveProperty('employee.name');
    expect(filtered.fields).toMatchObject({ 'employee.avs_number': [1], period: [1], gross_cents: [1] });
    expect(filtered.lines).toHaveLength(1);
  });

  it('retire la provenance scalaire quand un conflit inter-lots a vidé la valeur', () => {
    const raw = (pageNumber: number, period: string) => JSON.stringify({
      employee: { name: 'Alex Exemple' }, period, payment_date: '', gross_cents: 500_000, net_cents: 450_000,
      field_pages: { 'employee.name': pageNumber, period: pageNumber, gross_cents: pageNumber, net_cents: pageNumber },
      lines: [], warnings: [],
    });
    const combined = combinePayrollAiPageBatches([
      { pageStart: 1, pageEnd: 1, analysis: reconcilePayrollAiPasses(raw(1, '2026-07'), raw(1, '2026-07')) },
      { pageStart: 2, pageEnd: 2, analysis: reconcilePayrollAiPasses(raw(2, '2026-08'), raw(2, '2026-08')) },
    ]);
    expect(combined.draft.period).toBe('');
    expect(combined.provenance.fields).not.toHaveProperty('period');
    expect(combined.provenance.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: 'period', values: ['2026-07', '2026-08'], pages: [1, 2] }),
    ]));
    const filtered = payrollAiProvenanceForFinalDraft(combined.draft, combined.draft, combined.provenance);
    expect(filtered.fields).not.toHaveProperty('period');
  });

  it('écarte les pages des valeurs par défaut après conflit inter-lots taux et mode', () => {
    const raw = (pageNumber: number, employmentRate: number, salaryMode: 'monthly' | 'hourly') => JSON.stringify({
      employee: { name: 'Alex Exemple', employment_rate: employmentRate, salary_mode: salaryMode },
      period: '2026-08', payment_date: '', gross_cents: 0, net_cents: 0,
      field_pages: { 'employee.name': pageNumber, 'employee.employment_rate': pageNumber, 'employee.salary_mode': pageNumber, period: pageNumber },
      lines: [], warnings: [],
    });
    const combined = combinePayrollAiPageBatches([
      { pageStart: 1, pageEnd: 1, analysis: reconcilePayrollAiPasses(raw(1, 80, 'monthly'), raw(1, 80, 'monthly')) },
      { pageStart: 2, pageEnd: 2, analysis: reconcilePayrollAiPasses(raw(2, 90, 'hourly'), raw(2, 90, 'hourly')) },
    ]);

    expect(combined.draft.employee).toMatchObject({ employmentRate: 100, salaryMode: 'monthly' });
    expect(combined.detected).toEqual({ employmentRate: false, salaryMode: false });
    expect(combined.provenance.fields).not.toHaveProperty('employee.employment_rate');
    expect(combined.provenance.fields).not.toHaveProperty('employee.salary_mode');
    expect(combined.provenance.conflicts?.map((conflict) => conflict.target)).toEqual(expect.arrayContaining([
      'employee.employment_rate',
      'employee.salary_mode',
    ]));
  });

  it('conserve la traçabilité quand la personne confirme seulement une rubrique récurrente', () => {
    const previous = existingDraft();
    previous.lines = [{ id: 'line-1', label: 'Salaire mensuel', kind: 'earning', amountCents: 500_000, recurring: false, confidenceBp: 9_000 }];
    previous.review = {
      employeeId: '',
      employeeLinkSource: 'auto',
      aiLineKeys: ['earning:salairemensuel'],
      manualFields: ['period'],
      manualLineKeys: [],
      suppressedLineKeys: [],
    };
    const candidate: PayrollImportDraft = {
      ...previous,
      lines: [{ ...previous.lines[0], recurring: true }],
      review: {
        ...previous.review,
        employeeId: 'employee-1',
        employeeLinkSource: 'manual',
        confirmedRecurringLines: [{ label: 'Salaire mensuel', kind: 'earning', amountCents: 500_000 }],
      },
    };
    const recorded = recordPayrollManualChanges(previous, candidate);
    expect(recorded.contentChanged).toBe(false);
    expect(recorded.draft.lines[0].confidenceBp).toBe(9_000);
    expect(recorded.draft.review).toMatchObject({
      employeeId: 'employee-1',
      employeeLinkSource: 'manual',
      manualFields: ['period'],
      manualLineKeys: ['line:line-1'],
      confirmedRecurringLines: [{ lineId: 'line-1', label: 'Salaire mensuel', kind: 'earning', amountCents: 500_000 }],
    });
  });
});
