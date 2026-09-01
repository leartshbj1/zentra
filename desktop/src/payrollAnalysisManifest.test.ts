import { describe, expect, it } from 'vitest';
import {
  calibratePayrollAiDraftConfidence,
  payrollAiProvenanceFromManifest,
  payrollAnalysisManifestFromAi,
  reconcilePayrollAnalysisManifest,
} from './payrollAnalysisManifest';
import { recordPayrollManualChanges, type PayrollAiProvenance } from './payrollImportAiDraft';
import type { PayrollImportDraft } from './types';

const draft: PayrollImportDraft = {
  employee: { employeeNumber: '', name: 'Alex Exemple', role: '', addressLine1: '', addressLine2: '', postalCode: '', city: '', canton: 'VD', birthDate: '', avsNumber: '', iban: '', employmentRate: 100, salaryMode: 'monthly' },
  period: '2026-08',
  paymentDate: '',
  grossCents: 500_000,
  netCents: 450_000,
  lines: [
    { id: 'salary', label: 'Salaire mensuel', kind: 'earning', amountCents: 500_000, recurring: true, confidenceBp: 10_000 },
    { id: 'weak', label: 'Retenue illisible', kind: 'deduction', amountCents: 50_000, recurring: false, confidenceBp: 9_900 },
  ],
  warnings: [],
};

const provenance: PayrollAiProvenance = {
  fields: { period: [1], gross_cents: [1] },
  lines: [
    { label: 'Salaire mensuel', kind: 'earning', amountCents: 500_000, pages: [1] },
    { label: 'Retenue illisible', kind: 'deduction', amountCents: 50_000, pages: [] },
  ],
  conflicts: [
    { target: 'employee.avs_number', values: ['756.1111.1111.11', '756.2222.2222.22'], pages: [1, 2], passIndexes: [1, 2] },
  ],
};

describe('preuve persistante de l’analyse paie', () => {
  it('remplace la confiance auto-déclarée par un score déterministe', () => {
    const calibrated = calibratePayrollAiDraftConfidence(draft, provenance, 2);
    expect(calibrated.lines.map((line) => line.confidenceBp)).toEqual([9_000, 4_999]);
  });

  it('construit un manifeste lié au hash, au modèle, aux pages et au brouillon', () => {
    const calibrated = calibratePayrollAiDraftConfidence(draft, provenance, 2);
    const manifest = payrollAnalysisManifestFromAi({
      draft: calibrated,
      provenance,
      modelId: 'HuggingFaceTB/SmolVLM-500M-Instruct',
      modelRevision: 'revision-pinned',
      inputSha256: 'A'.repeat(64),
      analyzedPageCount: 2,
      passes: 2,
      analyzedAt: '2026-09-01T12:00:00.000Z',
    });

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      inputSha256: 'a'.repeat(64),
      analyzedPages: [1, 2],
      passes: 2,
      conflicts: [expect.objectContaining({ target: 'employee.avs_number', pages: [1, 2] })],
    });
    expect(manifest.fieldProvenance[0].passIndexes).toEqual([1, 2]);
    expect(manifest.fieldProvenance).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'period', value: '2026-08' }),
      expect.objectContaining({ field: 'gross_cents', value: '500000' }),
    ]));
    expect(manifest.lineProvenance).toEqual([
      expect.objectContaining({ lineIndex: 0, label: 'Salaire mensuel', confidenceBp: 9_000 }),
    ]);
    expect(payrollAiProvenanceFromManifest(manifest)).toEqual({
      fields: { period: [1], gross_cents: [1] },
      lines: [{ lineIndex: 0, label: 'Salaire mensuel', kind: 'earning', amountCents: 500_000, pages: [1] }],
    });
  });

  it('n\u2019\u00e9met aucune provenance scalaire pour une valeur absente', () => {
    const manifest = payrollAnalysisManifestFromAi({
      draft: { ...draft, employee: { ...draft.employee, employeeNumber: '' } },
      provenance: { fields: { 'employee.employee_number': [1] }, lines: [] },
      modelId: 'HuggingFaceTB/SmolVLM-500M-Instruct',
      modelRevision: 'revision-pinned',
      inputSha256: 'c'.repeat(64),
      analyzedPageCount: 1,
      passes: 1,
      analyzedAt: '2026-09-01T12:00:00.000Z',
    });

    expect(manifest.fieldProvenance).toEqual([]);
  });

  it('privilégie un conflit structuré à une provenance résolue de même cible', () => {
    const manifest = payrollAnalysisManifestFromAi({
      draft,
      provenance: {
        fields: { period: [1] },
        lines: [],
        conflicts: [{ target: 'period', values: ['2026-07', '2026-08'], pages: [1, 2], passIndexes: [1, 2] }],
      },
      modelId: 'HuggingFaceTB/SmolVLM-500M-Instruct',
      modelRevision: 'revision-pinned',
      inputSha256: 'd'.repeat(64),
      analyzedPageCount: 2,
      passes: 2,
      analyzedAt: '2026-09-01T12:00:00.000Z',
    });

    expect(manifest.fieldProvenance).toEqual([]);
    expect(manifest.conflicts).toEqual([expect.objectContaining({ target: 'period' })]);
  });

  it('lie deux occurrences identiques à deux index et pages distincts', () => {
    const duplicateDraft: PayrollImportDraft = {
      ...draft,
      employee: { ...draft.employee },
      lines: [
        { id: 'allowance-1', label: 'Indemnité repas', kind: 'earning', amountCents: 2_000, recurring: false, confidenceBp: 9_000 },
        { id: 'allowance-2', label: 'Indemnité repas', kind: 'earning', amountCents: 2_000, recurring: false, confidenceBp: 9_000 },
      ],
    };
    const duplicateProvenance: PayrollAiProvenance = {
      fields: {},
      lines: [
        { lineIndex: 0, label: 'Indemnité repas', kind: 'earning', amountCents: 2_000, pages: [1] },
        { lineIndex: 1, label: 'Indemnité repas', kind: 'earning', amountCents: 2_000, pages: [2] },
      ],
    };

    const manifest = payrollAnalysisManifestFromAi({
      draft: duplicateDraft,
      provenance: duplicateProvenance,
      modelId: 'HuggingFaceTB/SmolVLM-500M-Instruct',
      modelRevision: 'revision-pinned',
      inputSha256: 'b'.repeat(64),
      analyzedPageCount: 2,
      passes: 2,
      analyzedAt: '2026-09-01T12:00:00.000Z',
    });

    expect(manifest.lineProvenance.map((item) => ({ lineIndex: item.lineIndex, pages: item.pages }))).toEqual([
      { lineIndex: 0, pages: [1] },
      { lineIndex: 1, pages: [2] },
    ]);
  });

  it('retire seulement le champ corrigé et conserve les preuves inchangées', () => {
    const source = payrollAnalysisManifestFromAi({
      draft,
      provenance: {
        fields: { 'employee.name': [1], period: [1], gross_cents: [1] },
        lines: [
          { lineIndex: 0, label: 'Salaire mensuel', kind: 'earning', amountCents: 500_000, pages: [1] },
          { lineIndex: 1, label: 'Retenue illisible', kind: 'deduction', amountCents: 50_000, pages: [2] },
        ],
      },
      modelId: 'HuggingFaceTB/SmolVLM-500M-Instruct',
      modelRevision: 'revision-pinned',
      inputSha256: 'e'.repeat(64),
      analyzedPageCount: 2,
      passes: 2,
      analyzedAt: '2026-09-01T12:00:00.000Z',
    });
    const edit = recordPayrollManualChanges(draft, {
      ...draft,
      employee: { ...draft.employee, name: 'Alex Corrigé' },
    });

    const reconciled = reconcilePayrollAnalysisManifest(source, draft, edit.draft);

    expect(edit.draft.review?.manualFields).toContain('employee.name');
    expect(edit.draft.review?.aiFields).not.toContain('employee.name');
    expect(reconciled.fieldProvenance.map((item) => item.field)).toEqual([
      'period',
      'gross_cents',
    ]);
    expect(reconciled.lineProvenance).toHaveLength(2);
    expect(source.fieldProvenance).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'employee.name' }),
    ]));
  });

  it('réindexe une ligne inchangée, sans donner de preuve à une suppression ou un ajout humain', () => {
    const source = payrollAnalysisManifestFromAi({
      draft,
      provenance: {
        fields: { period: [1] },
        lines: [
          { lineIndex: 0, label: 'Salaire mensuel', kind: 'earning', amountCents: 500_000, pages: [1] },
          { lineIndex: 1, label: 'Retenue illisible', kind: 'deduction', amountCents: 50_000, pages: [2] },
        ],
      },
      modelId: 'HuggingFaceTB/SmolVLM-500M-Instruct',
      modelRevision: 'revision-pinned',
      inputSha256: 'f'.repeat(64),
      analyzedPageCount: 2,
      passes: 2,
      analyzedAt: '2026-09-01T12:00:00.000Z',
    });
    const addedLine: PayrollImportDraft['lines'][number] = {
      id: 'human-line',
      label: 'Prime contrôlée manuellement',
      kind: 'earning',
      amountCents: 10_000,
      recurring: false,
      confidenceBp: 10_000,
    };
    const edit = recordPayrollManualChanges(draft, {
      ...draft,
      employee: { ...draft.employee },
      lines: [{ ...draft.lines[1] }, addedLine],
    });

    const reconciled = reconcilePayrollAnalysisManifest(source, draft, edit.draft);

    expect(reconciled.lineProvenance).toEqual([
      expect.objectContaining({
        lineIndex: 0,
        label: 'Retenue illisible',
        pages: [2],
      }),
    ]);
    expect(reconciled.lineProvenance).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ label: addedLine.label }),
    ]));
    expect(edit.draft.review?.manualLineKeys).toContain('line:human-line');
    expect(edit.draft.review?.suppressedLineKeys?.length).toBeGreaterThan(0);
  });

  it('reste compatible avec les anciennes lignes sans id ni référence source', () => {
    const legacyDraft: PayrollImportDraft = {
      ...draft,
      employee: { ...draft.employee },
      lines: draft.lines.map((line) => ({ ...line, id: '', sourceRef: undefined })),
    };
    const source = payrollAnalysisManifestFromAi({
      draft: legacyDraft,
      provenance: {
        fields: { period: [1] },
        lines: [
          { lineIndex: 0, label: 'Salaire mensuel', kind: 'earning', amountCents: 500_000, pages: [1] },
          { lineIndex: 1, label: 'Retenue illisible', kind: 'deduction', amountCents: 50_000, pages: [2] },
        ],
      },
      modelId: 'HuggingFaceTB/SmolVLM-500M-Instruct',
      modelRevision: 'revision-pinned',
      inputSha256: '1'.repeat(64),
      analyzedPageCount: 2,
      passes: 2,
      analyzedAt: '2026-09-01T12:00:00.000Z',
    });
    const nextDraft: PayrollImportDraft = {
      ...legacyDraft,
      employee: { ...legacyDraft.employee },
      lines: [
        { id: '', label: 'Ajout humain', kind: 'earning', amountCents: 1_000, recurring: false, confidenceBp: 10_000 },
        ...legacyDraft.lines.map((line) => ({ ...line })),
      ],
    };

    const reconciled = reconcilePayrollAnalysisManifest(source, legacyDraft, nextDraft);

    expect(reconciled.lineProvenance.map((item) => ({ lineIndex: item.lineIndex, label: item.label }))).toEqual([
      { lineIndex: 1, label: 'Salaire mensuel' },
      { lineIndex: 2, label: 'Retenue illisible' },
    ]);
  });
});
