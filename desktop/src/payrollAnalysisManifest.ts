import type { PayrollAiProvenance } from './payrollImportAiDraft';
import type { PayrollAnalysisManifest, PayrollImportDraft } from './types';

function normalizedLineLabel(value: string) {
  return value.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ');
}

const supportedManifestFields = new Set([
  'employee.name',
  'employee.employee_number',
  'employee.role',
  'employee.address',
  'employee.birth_date',
  'employee.avs_number',
  'employee.iban',
  'employee.employment_rate',
  'employee.salary_mode',
  'period',
  'payment_date',
  'gross_cents',
  'net_cents',
]);

function canonicalManifestFieldValue(draft: PayrollImportDraft, field: string) {
  switch (field) {
    case 'employee.name': return draft.employee.name.trim();
    case 'employee.employee_number': return draft.employee.employeeNumber.trim();
    case 'employee.role': return draft.employee.role.trim();
    case 'employee.address': return draft.employee.addressLine1.trim();
    case 'employee.birth_date': return draft.employee.birthDate.trim();
    case 'employee.avs_number': return draft.employee.avsNumber.replace(/\D/g, '');
    case 'employee.iban': return draft.employee.iban.replace(/\s/g, '').toUpperCase();
    case 'employee.employment_rate': return String(draft.employee.employmentRate);
    case 'employee.salary_mode': return draft.employee.salaryMode;
    case 'period': return draft.period.trim();
    case 'payment_date': return draft.paymentDate.trim();
    case 'gross_cents': return draft.grossCents > 0 ? String(draft.grossCents) : '';
    case 'net_cents': return draft.netCents > 0 ? String(draft.netCents) : '';
    default: return '';
  }
}

function manifestLineMatches(
  line: PayrollImportDraft['lines'][number],
  evidence: PayrollAnalysisManifest['lineProvenance'][number],
) {
  return line.label.trim() === evidence.label.trim()
    && line.kind === evidence.kind
    && line.amountCents === evidence.amountCents;
}

function stableLineIdentities(line: PayrollImportDraft['lines'][number]) {
  const identities: Array<{ kind: 'sourceRef' | 'id'; value: string }> = [];
  const sourceRef = line.sourceRef?.trim();
  if (sourceRef) identities.push({ kind: 'sourceRef', value: sourceRef });
  const id = line.id?.trim();
  if (id) identities.push({ kind: 'id', value: id });
  return identities;
}

/**
 * Conserve uniquement les preuves qui décrivent encore exactement le
 * brouillon après une correction humaine. Une ligne stable peut changer
 * d'index (suppression/insertion voisine), mais une preuve n'est jamais
 * transférée à une autre occurrence lorsque son identité est disponible.
 */
export function reconcilePayrollAnalysisManifest(
  manifest: PayrollAnalysisManifest,
  previousDraft: PayrollImportDraft,
  nextDraft: PayrollImportDraft,
): PayrollAnalysisManifest {
  const fieldProvenance = manifest.fieldProvenance
    .filter((evidence) => (
      canonicalManifestFieldValue(nextDraft, evidence.field) === evidence.value
    ))
    .map((evidence) => ({
      ...evidence,
      pages: [...evidence.pages],
      passIndexes: [...evidence.passIndexes],
    }));

  const usedNextIndexes = new Set<number>();
  const lineProvenance = manifest.lineProvenance.flatMap((evidence) => {
    const previousLine = previousDraft.lines[evidence.lineIndex];
    if (!previousLine || !manifestLineMatches(previousLine, evidence)) return [];

    const identities = stableLineIdentities(previousLine);
    let nextIndex = -1;
    if (identities.length) {
      for (const identity of identities) {
        const matchingIndexes = nextDraft.lines.flatMap((line, index) => (
          !usedNextIndexes.has(index)
          && (identity.kind === 'sourceRef'
            ? line.sourceRef?.trim() === identity.value
            : line.id?.trim() === identity.value)
            ? [index]
            : []
        ));
        if (!matchingIndexes.length) continue;
        // Une identité dupliquée ou un contenu corrigé rend l'attribution
        // ambiguë : écarter la preuve au lieu de la réaffecter par ressemblance.
        if (matchingIndexes.length !== 1) return [];
        const candidateIndex = matchingIndexes[0];
        if (!manifestLineMatches(nextDraft.lines[candidateIndex], evidence)) return [];
        nextIndex = candidateIndex;
        break;
      }
      // Une ligne identifiée qui a disparu ne doit pas transmettre sa preuve à
      // une nouvelle ligne humainement ajoutée avec le même contenu.
      if (nextIndex < 0) return [];
    } else {
      const matchingIndexes = nextDraft.lines.flatMap((line, index) => (
        !usedNextIndexes.has(index) && manifestLineMatches(line, evidence)
          ? [index]
          : []
      ));
      // Compatibilité avec les anciens brouillons sans id/sourceRef, seulement
      // lorsqu'une occurrence exacte et non ambiguë subsiste.
      if (matchingIndexes.length !== 1) return [];
      nextIndex = matchingIndexes[0];
    }

    usedNextIndexes.add(nextIndex);
    return [{
      ...evidence,
      lineIndex: nextIndex,
      label: nextDraft.lines[nextIndex].label,
      pages: [...evidence.pages],
      passIndexes: [...evidence.passIndexes],
    }];
  }).sort((left, right) => left.lineIndex - right.lineIndex);

  const conflicts = manifest.conflicts
    .filter((conflict) => (
      canonicalManifestFieldValue(previousDraft, conflict.target)
      === canonicalManifestFieldValue(nextDraft, conflict.target)
    ))
    .map((conflict) => ({
      ...conflict,
      values: [...conflict.values],
      pages: [...conflict.pages],
      passIndexes: [...conflict.passIndexes],
    }));

  return {
    ...manifest,
    analyzedPages: [...manifest.analyzedPages],
    fieldProvenance,
    lineProvenance,
    conflicts,
  };
}

export function deterministicPayrollAiConfidence(pages: number[], passes: number) {
  if (!pages.length) return 4_999;
  return passes >= 2 ? 9_000 : 6_500;
}

/**
 * SmolVLM peut proposer sa propre confiance, mais elle n'est pas calibrée.
 * Zentra remplace donc ce nombre par un score déterministe fondé uniquement sur
 * la présence d'une page source et le nombre de lectures réellement achevées.
 */
export function calibratePayrollAiDraftConfidence(
  draft: PayrollImportDraft,
  provenance: PayrollAiProvenance,
  passes: number,
): PayrollImportDraft {
  const usedSourceIndexes = new Set<number>();
  return {
    ...draft,
    employee: { ...draft.employee },
    lines: draft.lines.map((line, lineIndex) => {
      const sourceIndex = provenance.lines.findIndex((candidate, index) => (
        !usedSourceIndexes.has(index)
        && (candidate.lineIndex === undefined || candidate.lineIndex === lineIndex)
        && candidate.kind === line.kind
        && candidate.amountCents === line.amountCents
        && normalizedLineLabel(candidate.label) === normalizedLineLabel(line.label)
      ));
      if (sourceIndex >= 0) usedSourceIndexes.add(sourceIndex);
      const source = sourceIndex >= 0 ? provenance.lines[sourceIndex] : undefined;
      return {
        ...line,
        recurring: source?.pages.length ? line.recurring : false,
        confidenceBp: deterministicPayrollAiConfidence(source?.pages ?? [], passes),
      };
    }),
    warnings: [...draft.warnings],
    review: draft.review ? { ...draft.review } : undefined,
  };
}

export function payrollAnalysisManifestFromAi(input: {
  draft: PayrollImportDraft;
  provenance: PayrollAiProvenance;
  modelId: string;
  modelRevision: string;
  inputSha256: string;
  analyzedPageCount: number;
  passes: number;
  analyzedAt?: string;
}): PayrollAnalysisManifest {
  const passes = Math.max(1, Math.min(4, Math.round(input.passes)));
  const passIndexes = Array.from({ length: passes }, (_, index) => index + 1);
  const analyzedPages = Array.from(
    { length: Math.max(1, Math.round(input.analyzedPageCount)) },
    (_, index) => index + 1,
  );
  const fieldProvenance = Object.entries(input.provenance.fields)
    .flatMap(([field, pages]) => {
      const value = canonicalManifestFieldValue(input.draft, field);
      if (!pages.length || !value) return [];
      return [{
        field,
        value,
        pages: [...new Set(pages)].sort((left, right) => left - right),
        passIndexes,
        confidenceBp: deterministicPayrollAiConfidence(pages, passes),
      }];
    });
  const usedLineIndexes = new Set<number>();
  const lineProvenance = input.provenance.lines.flatMap((source) => {
    if (!source.pages.length) return [];
    const explicitLineIndex = source.lineIndex;
    const lineIndex = explicitLineIndex !== undefined
      && !usedLineIndexes.has(explicitLineIndex)
      && input.draft.lines[explicitLineIndex]?.kind === source.kind
      && input.draft.lines[explicitLineIndex]?.amountCents === source.amountCents
      && normalizedLineLabel(input.draft.lines[explicitLineIndex]?.label ?? '') === normalizedLineLabel(source.label)
      ? explicitLineIndex
      : input.draft.lines.findIndex((line, index) => (
        !usedLineIndexes.has(index)
        && line.kind === source.kind
        && line.amountCents === source.amountCents
        && normalizedLineLabel(line.label) === normalizedLineLabel(source.label)
      ));
    if (lineIndex < 0) return [];
    usedLineIndexes.add(lineIndex);
    const line = input.draft.lines[lineIndex];
    return [{
      lineIndex,
      label: line.label,
      kind: line.kind,
      amountCents: line.amountCents,
      pages: [...new Set(source.pages)].sort((left, right) => left - right),
      passIndexes,
      confidenceBp: deterministicPayrollAiConfidence(source.pages, passes),
    }];
  });
  const conflictTargets = new Set<string>();
  const conflicts = (input.provenance.conflicts ?? []).flatMap((conflict) => {
    const target = conflict.target.trim();
    const values = [...new Set(conflict.values.map((value) => value.trim()).filter(Boolean))];
    const pages = [...new Set(conflict.pages)].sort((left, right) => left - right);
    const conflictPassIndexes = [...new Set(conflict.passIndexes)].sort((left, right) => left - right);
    if (
      !supportedManifestFields.has(target)
      || conflictTargets.has(target)
      || values.length < 2
      || values.length > 8
      || values.some((value) => value.length > 250 || /[\u0000-\u001f\u007f]/.test(value))
      || !pages.length
      || pages.some((page) => !Number.isSafeInteger(page) || !analyzedPages.includes(page))
      || !conflictPassIndexes.length
      || conflictPassIndexes.some((passIndex) => !Number.isSafeInteger(passIndex) || passIndex < 1 || passIndex > passes)
    ) return [];
    conflictTargets.add(target);
    return [{ target, values, pages, passIndexes: conflictPassIndexes }];
  });
  const conflictingTargets = new Set(conflicts.map((conflict) => conflict.target));

  return {
    schemaVersion: 1,
    modelId: input.modelId.trim(),
    modelRevision: input.modelRevision.trim(),
    inputSha256: input.inputSha256.trim().toLowerCase(),
    analyzedPages,
    passes,
    fieldProvenance: fieldProvenance.filter((provenance) => !conflictingTargets.has(provenance.field)),
    lineProvenance,
    conflicts,
    analyzedAt: input.analyzedAt ?? new Date().toISOString(),
  };
}

export function payrollAiProvenanceFromManifest(
  manifest: PayrollAnalysisManifest | null,
): PayrollAiProvenance | undefined {
  if (!manifest) return undefined;
  return {
    fields: Object.fromEntries(
      manifest.fieldProvenance.map((item) => [item.field, [...item.pages]]),
    ),
    lines: manifest.lineProvenance.map((item) => ({
      lineIndex: item.lineIndex,
      label: item.label,
      kind: item.kind,
      amountCents: item.amountCents,
      pages: [...item.pages],
    })),
  };
}
