import { describe, expect, it } from 'vitest';
import {
  payrollAnalysisManifestFromRaw,
  payrollAnalysisManifestToRaw,
  updatePayrollImportDraftMutation,
} from './bridge';
import type {
  PayrollAnalysisManifest,
  PayrollImportDraft,
} from './types';

const manifest: PayrollAnalysisManifest = {
  schemaVersion: 1,
  modelId: 'HuggingFaceTB/SmolVLM-500M-Instruct',
  modelRevision: 'revision-locale-figee',
  inputSha256: 'a'.repeat(64),
  analyzedPages: [1, 2],
  passes: 2,
  fieldProvenance: [
    {
      field: 'employee.name',
      value: 'Alex Exemple',
      pages: [1],
      passIndexes: [1, 2],
      confidenceBp: 9_250,
    },
  ],
  lineProvenance: [
    {
      lineIndex: 0,
      label: 'Salaire mensuel',
      kind: 'earning',
      amountCents: 500_000,
      pages: [2],
      passIndexes: [1, 2],
      confidenceBp: 9_000,
    },
  ],
  conflicts: [],
  analyzedAt: '2026-09-01T10:15:30Z',
};

const draft: PayrollImportDraft = {
  employee: {
    employeeNumber: '',
    name: 'Alex Exemple',
    role: '',
    addressLine1: '',
    addressLine2: '',
    postalCode: '',
    city: '',
    canton: '',
    birthDate: '',
    avsNumber: '',
    iban: '',
    employmentRate: 100,
    salaryMode: 'monthly',
  },
  period: '2026-08',
  paymentDate: '',
  grossCents: 500_000,
  netCents: 500_000,
  lines: [
    {
      id: 'line-1',
      sourceRef: 'ai:p1-2:kearning:h12345678:a500000:o1',
      label: 'Salaire mensuel',
      kind: 'earning',
      amountCents: 500_000,
      recurring: true,
      confidenceBp: 9_000,
    },
  ],
  warnings: [],
};

describe('bridge du manifeste local de paie', () => {
  it('restaure strictement le JSON snake_case écrit par Rust', () => {
    const raw = payrollAnalysisManifestToRaw(manifest);
    expect(raw).toMatchObject({
      schema_version: 1,
      input_sha256: 'a'.repeat(64),
      field_provenance: [
        expect.objectContaining({
          field: 'employee.name',
          value: 'Alex Exemple',
        }),
      ],
      line_provenance: [
        expect.objectContaining({
          line_index: 0,
          amount_cents: 500_000,
          pass_indexes: [1, 2],
        }),
      ],
    });
    expect(payrollAnalysisManifestFromRaw(JSON.stringify(raw))).toEqual(
      manifest,
    );
  });

  it('renvoie undefined au lieu de fabriquer un manifeste invalide', () => {
    expect(payrollAnalysisManifestFromRaw(null)).toBeUndefined();
    expect(payrollAnalysisManifestFromRaw('{json-invalide')).toBeUndefined();
    expect(
      payrollAnalysisManifestFromRaw({
        ...payrollAnalysisManifestToRaw(manifest),
        field_provenance: [
          {
            field: 'employee.name',
            value: 42,
            pages: [3],
            pass_indexes: [1, 2],
            confidence_bp: 9_250,
          },
        ],
      }),
    ).toBeUndefined();
    expect(
      payrollAnalysisManifestFromRaw({
        ...payrollAnalysisManifestToRaw(manifest),
        conflicts: [{
          target: 'employee.untrusted_field',
          values: ['A', 'B'],
          pages: [1],
          pass_indexes: [1, 2],
        }],
      }),
    ).toBeUndefined();
    expect(
      payrollAnalysisManifestFromRaw({
        ...payrollAnalysisManifestToRaw(manifest),
        conflicts: [{
          target: 'employee.name',
          values: ['Alex Exemple', 'Autre Personne'],
          pages: [1, 2],
          pass_indexes: [1, 2],
        }],
      }),
    ).toBeUndefined();
  });

  it('retire une ancienne provenance scalaire sans valeur au lieu de la pr\u00e9senter comme actuelle', () => {
    const raw = payrollAnalysisManifestToRaw(manifest);
    const legacyFields = raw.field_provenance as Array<Record<string, unknown>>;
    delete legacyFields[0].value;

    const restored = payrollAnalysisManifestFromRaw(raw);
    expect(restored).toBeDefined();
    expect(restored?.fieldProvenance).toEqual([]);
    expect(restored?.lineProvenance).toEqual(manifest.lineProvenance);
  });

  it('omet le champ pour un ancien appel afin de préserver la preuve stockée', () => {
    const mutation = updatePayrollImportDraftMutation(
      'import-1',
      draft,
      'manuel',
      '',
      8_000,
    );
    expect(mutation.args.input).not.toHaveProperty('analysis_manifest');
  });

  it('transmet le manifeste complet fourni par l’analyse locale', () => {
    const mutation = updatePayrollImportDraftMutation(
      'import-1',
      draft,
      'smolvlm-local-double-read',
      manifest.modelRevision,
      9_000,
      manifest,
    );
    expect(mutation.args.input.analysis_manifest).toEqual(
      payrollAnalysisManifestToRaw(manifest),
    );
  });

  it('distingue un ancien appel d’un abandon intégral explicite', () => {
    const mutation = updatePayrollImportDraftMutation(
      'import-1',
      {
        ...draft,
        review: {
          employeeId: '',
          employeeLinkSource: '',
          aiFields: ['employee.name'],
          aiLineKeys: ['earning:salairemensuel'],
          aiWarnings: ['Ancien avertissement IA'],
          manualFields: ['period'],
          manualLineKeys: [],
          suppressedLineKeys: ['deduction:anciennecotisation'],
          confirmedRecurringLines: [{ lineId: 'line-1', label: 'Salaire mensuel', kind: 'earning', amountCents: 500_000 }],
        },
      },
      'manual_review',
      '',
      8_000,
      null,
    );
    expect(mutation.args.input).toMatchObject({
      clear_analysis_manifest: true,
      draft: {
        review: {
          ai_fields: ['employee.name'],
          ai_line_keys: ['earning:salairemensuel'],
          ai_warnings: ['Ancien avertissement IA'],
          manual_fields: ['period'],
          suppressed_line_keys: ['deduction:anciennecotisation'],
          confirmed_recurring_lines: [{ line_id: 'line-1', label: 'Salaire mensuel', kind: 'earning', amount_cents: 500_000 }],
        },
        lines: [expect.objectContaining({ id: 'line-1', source_ref: 'ai:p1-2:kearning:h12345678:a500000:o1' })],
      },
    });
    expect(mutation.args.input).not.toHaveProperty('analysis_manifest');
  });
});
