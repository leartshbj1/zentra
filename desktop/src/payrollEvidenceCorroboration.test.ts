import { describe, expect, it } from 'vitest';
import { corroboratePayrollAiEvidence } from './payrollEvidenceCorroboration';
import { calibratePayrollAiDraftConfidence, payrollAnalysisManifestFromAi } from './payrollAnalysisManifest';
import { payrollAiProvenanceForFinalDraft, type PayrollAiProvenance } from './payrollImportAiDraft';
import type { PayrollImportDraft } from './types';

const draft = (): PayrollImportDraft => ({
  employee: {
    employeeNumber: 'E-017',
    name: 'Élodie Exemple',
    role: 'Cheffe de projet',
    addressLine1: 'Rue du Test 1',
    addressLine2: '',
    postalCode: '1000',
    city: 'Lausanne',
    canton: 'VD',
    birthDate: '1990-01-02',
    avsNumber: '756.9217.0769.85',
    iban: 'CH9300762011623852957',
    employmentRate: 80,
    salaryMode: 'monthly',
  },
  period: '2026-08',
  paymentDate: '2026-08-25',
  grossCents: 650_000,
  netCents: 612_560,
  lines: [
    { id: 'salary', label: 'Salaire mensuel', kind: 'earning', amountCents: 650_000, recurring: false, confidenceBp: 10_000 },
    { id: 'avs', label: 'Cotisation AVS/AI/APG', kind: 'deduction', amountCents: 34_450, recurring: false, confidenceBp: 10_000 },
    { id: 'ac', label: 'Cotisation AC', kind: 'deduction', amountCents: 3_575, recurring: false, confidenceBp: 10_000 },
  ],
  warnings: [],
});

const provenance = (): PayrollAiProvenance => ({
  fields: {
    'employee.name': [1],
    period: [1],
    gross_cents: [1],
    net_cents: [1],
  },
  lines: [
    { lineIndex: 0, label: 'Salaire mensuel', kind: 'earning', amountCents: 650_000, pages: [1] },
    { lineIndex: 1, label: 'Cotisation AVS/AI/APG', kind: 'deduction', amountCents: 34_450, pages: [1] },
    { lineIndex: 2, label: 'Cotisation AC', kind: 'deduction', amountCents: 3_575, pages: [2] },
  ],
});

describe('corroboration locale de la preuve IA de paie', () => {
  it('élève uniquement les rubriques dont libellé et montant figurent sur la page annoncée', () => {
    const source = draft();
    const result = corroboratePayrollAiEvidence({
      draft: source,
      provenance: provenance(),
      pageTexts: [
        "Décompte août 2026\nCollaboratrice Élodie Exemple\nSalaire mensuel CHF 6'500.00\nCotisation AVS/AI/APG 344,50\nSalaire brut 6 500.00\nNet à payer CHF 6'125.60",
        'Autre annexe\nCotisation assurance accident 35.75',
      ],
      passes: 2,
    });

    expect(result).toMatchObject({ hasTextLayer: true, lineCount: 3, corroboratedLineCount: 2 });
    expect(result.provenance.lines.map((line) => line.confidenceBp)).toEqual([9_200, 9_200, 7_000]);
    expect(result.provenance.fieldConfidenceBp).toMatchObject({
      'employee.name': 9_200,
      period: 9_200,
      gross_cents: 9_200,
      net_cents: 9_200,
    });
    expect(result.draft.warnings).toContain('2/3 rubriques corroborées par libellé et montant dans la couche texte locale du PDF.');
    expect(source.warnings).toEqual([]);
  });

  it('ne valide pas un montant isolé sous un autre libellé ni une valeur sur une autre page', () => {
    const result = corroboratePayrollAiEvidence({
      draft: draft(),
      provenance: provenance(),
      pageTexts: ["Indemnité vacances 6'500.00\nNet à payer 6'125.60", 'Cotisation AC 35.75'],
      passes: 2,
    });

    expect(result.provenance.lines.map((line) => line.confidenceBp)).toEqual([7_000, 7_000, 9_200]);
    expect(result.corroboratedLineCount).toBe(1);
  });

  it('ne corrobore pas le brut, le net ou un taux court sans leur libellé exact', () => {
    const source = draft();
    const result = corroboratePayrollAiEvidence({
      draft: source,
      provenance: {
        fields: {
          gross_cents: [1],
          net_cents: [1],
          'employee.employment_rate': [1],
        },
        lines: [],
      },
      pageTexts: [
        "Indemnité exceptionnelle CHF 6'500.00\nSolde du compte CHF 6'125.60\nCode interne 80",
      ],
      passes: 2,
    });

    expect(result.provenance.fieldConfidenceBp).toEqual({
      gross_cents: 7_000,
      net_cents: 7_000,
      'employee.employment_rate': 7_000,
    });
  });

  it('corrobore les totaux et le taux uniquement sur des lignes sémantiques', () => {
    const result = corroboratePayrollAiEvidence({
      draft: draft(),
      provenance: {
        fields: {
          gross_cents: [1],
          net_cents: [1],
          'employee.employment_rate': [1],
          'employee.salary_mode': [1],
        },
        lines: [],
      },
      pageTexts: [
        "Taux d'activité 80 %\nMode: salaire mensuel\nSalaire brut CHF 6'500.00\nNet à payer CHF 6'125.60",
      ],
      passes: 2,
    });

    expect(result.provenance.fieldConfidenceBp).toEqual({
      gross_cents: 9_200,
      net_cents: 9_200,
      'employee.employment_rate': 9_200,
      'employee.salary_mode': 9_200,
    });
  });

  it('reste honnêtement en confiance visuelle lorsqu’un scan ou une image n’a pas de couche texte', () => {
    const result = corroboratePayrollAiEvidence({
      draft: draft(),
      provenance: provenance(),
      pageTexts: [],
      passes: 2,
    });

    expect(result.hasTextLayer).toBe(false);
    expect(result.provenance.lines.map((line) => line.confidenceBp)).toEqual([7_000, 7_000, 7_000]);
    expect(result.draft.warnings).toContain('Aucune couche texte locale ne permet de corroborer les rubriques : la confiance reste limitée aux lectures visuelles du même modèle.');
  });

  it('distingue une lecture unique corroborée d’une double lecture corroborée', () => {
    const result = corroboratePayrollAiEvidence({
      draft: draft(),
      provenance: { fields: {}, lines: [{ lineIndex: 0, label: 'Salaire mensuel', kind: 'earning', amountCents: 650_000, pages: [1] }] },
      pageTexts: ["Salaire mensuel 6'500.00"],
      passes: 1,
    });
    const calibrated = calibratePayrollAiDraftConfidence(result.draft, result.provenance, 1);

    expect(result.provenance.lines[0].confidenceBp).toBe(7_800);
    expect(calibrated.lines[0].confidenceBp).toBe(7_800);
  });

  it('fige les confiances corroborées dans le manifeste au lieu de recréer un 9000 générique', () => {
    const source = draft();
    const corroborated = corroboratePayrollAiEvidence({
      draft: source,
      provenance: provenance(),
      pageTexts: ["Élodie Exemple · août 2026\nSalaire mensuel 6'500.00\nSalaire brut 6'500.00\nNet à payer 6'125.60"],
      passes: 2,
    });
    const calibrated = calibratePayrollAiDraftConfidence(corroborated.draft, corroborated.provenance, 2);
    const finalProvenance = payrollAiProvenanceForFinalDraft(calibrated, corroborated.draft, corroborated.provenance);
    const manifest = payrollAnalysisManifestFromAi({
      draft: calibrated,
      provenance: finalProvenance,
      modelId: 'HuggingFaceTB/SmolVLM-500M-Instruct',
      modelRevision: 'pinned',
      inputSha256: 'a'.repeat(64),
      analyzedPageCount: 2,
      passes: 2,
      hasTextLayer: corroborated.hasTextLayer,
      analyzedAt: '2026-09-02T12:00:00.000Z',
    });

    expect(manifest.lineProvenance.map((line) => line.confidenceBp)).toEqual([9_200, 7_000, 7_000]);
    expect(manifest.fieldProvenance.find((field) => field.field === 'gross_cents')?.confidenceBp).toBe(9_200);
  });
});
