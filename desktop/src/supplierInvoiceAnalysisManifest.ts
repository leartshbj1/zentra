import {
  SUPPLIER_INVOICE_AI_FIELDS,
  SUPPLIER_INVOICE_MAX_ANALYZED_PAGES,
  SUPPLIER_INVOICE_MAX_LINE_OCCURRENCES,
  supplierInvoiceCanonicalFieldValue,
  supplierInvoiceCanonicalLineValue,
  type SupplierInvoiceAiConflict,
  type SupplierInvoiceAiDraft,
  type SupplierInvoiceAiField,
  type SupplierInvoiceAiProvenance,
  type ReconciledSupplierInvoiceAiDraft,
} from './supplierInvoiceAiDraft';
import {
  assessSupplierInvoiceConfirmation,
  isSupplierInvoiceRoundingPolicy,
  type SupplierInvoiceHumanBusinessReview,
  type SupplierInvoiceRoundingPolicy,
} from './supplierInvoiceImportQuality';

export const SUPPLIER_INVOICE_ANALYSIS_MANIFEST_SCHEMA_VERSION = 1 as const;
export const SUPPLIER_INVOICE_HUMAN_REVIEW_ATTESTATION_VERSION = 'zentra.supplier-invoice.local-review.v1';
export const SUPPLIER_INVOICE_HUMAN_REVIEW_ATTESTATION_TEXT =
  'J\'ai compare chaque valeur au document source et je confirme les corrections ainsi que les choix metier effectues manuellement.';

export type SupplierInvoiceAnalysisFieldEvidence = {
  field: SupplierInvoiceAiField;
  value: string;
  pages: number[];
  passIndexes: number[];
  confidenceBp: number;
};

export type SupplierInvoiceAnalysisLineEvidence = {
  occurrenceId: string;
  lineIndex: number;
  canonicalValue: string;
  pages: number[];
  passIndexes: number[];
  confidenceBp: number;
};

export type SupplierInvoiceAnalysisConflictResolution = {
  conflict: SupplierInvoiceAiConflict;
  resolvedCanonicalValue: string;
  confirmedByHuman: true;
};

export type SupplierInvoiceConflictResolutionInput = {
  target: SupplierInvoiceAiConflict['target'];
  resolvedCanonicalValue: string;
  confirmedByHuman: boolean;
};

export type SupplierInvoiceAnalysisManifest = {
  schemaVersion: typeof SUPPLIER_INVOICE_ANALYSIS_MANIFEST_SCHEMA_VERSION;
  modelId: string;
  modelRevision: string;
  inputSha256: string;
  analyzedPages: number[];
  passes: 2;
  fieldProvenance: SupplierInvoiceAnalysisFieldEvidence[];
  lineProvenance: SupplierInvoiceAnalysisLineEvidence[];
  conflicts: SupplierInvoiceAiConflict[];
  resolvedConflicts: SupplierInvoiceAnalysisConflictResolution[];
  analyzedAt: string;
};

export type SupplierInvoiceHumanReviewAttestation = {
  schemaVersion: 1;
  attestationVersion: typeof SUPPLIER_INVOICE_HUMAN_REVIEW_ATTESTATION_VERSION;
  statement: typeof SUPPLIER_INVOICE_HUMAN_REVIEW_ATTESTATION_TEXT;
  sourceSha256: string;
  draftSha256: string;
  manifestSha256: string;
  businessReviewSha256: string;
  roundingPolicy: SupplierInvoiceRoundingPolicy;
};

const FIELD_SET = new Set<string>(SUPPLIER_INVOICE_AI_FIELDS);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CANONICAL_JSON_MAX_DEPTH = 64;
const CANONICAL_JSON_MAX_NODES = 50_000;
const CANONICAL_JSON_MAX_CHARACTERS = 1_000_000;

function cloneConflict(conflict: SupplierInvoiceAiConflict): SupplierInvoiceAiConflict {
  return {
    ...conflict,
    values: [...conflict.values],
    pages: [...conflict.pages],
    passIndexes: [...conflict.passIndexes],
  };
}

function cloneConflictResolution(
  resolution: SupplierInvoiceAnalysisConflictResolution,
): SupplierInvoiceAnalysisConflictResolution {
  return {
    conflict: cloneConflict(resolution.conflict),
    resolvedCanonicalValue: resolution.resolvedCanonicalValue,
    confirmedByHuman: true,
  };
}

function normalizedSha256(value: string, label: string) {
  const normalized = value.trim().toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) throw new Error(`${label} doit etre un SHA-256 hexadecimal.`);
  return normalized;
}

function requiredText(value: string, label: string, maxLength: number) {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} manque.`);
  if (trimmed.length > maxLength) throw new Error(`${label} depasse ${maxLength} caracteres.`);
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new Error(`${label} contient un caractere de controle.`);
  return trimmed;
}

function normalizedEvidenceNumbers(
  values: number[],
  label: string,
  minimum: number,
  maximum: number,
): number[] {
  if (!Array.isArray(values) || !values.length) throw new Error(`${label} ne peut pas etre vide.`);
  const normalized = [...new Set(values)].sort((left, right) => left - right);
  if (normalized.some((value) => !Number.isSafeInteger(value) || value < minimum || value > maximum)) {
    throw new Error(`${label} contient une valeur hors limite.`);
  }
  return normalized;
}

function assertTwoPassEvidence(passIndexes: number[], label: string) {
  const normalized = normalizedEvidenceNumbers(passIndexes, label, 1, 2);
  if (normalized.length !== 2 || normalized[0] !== 1 || normalized[1] !== 2) {
    throw new Error(`${label} doit prouver les deux passes locales.`);
  }
  return normalized;
}

function assertAnalyzedAt(value: string) {
  const trimmed = requiredText(value, 'analyzedAt', 100);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(trimmed)
    || Number.isNaN(Date.parse(trimmed))) {
    throw new Error('analyzedAt doit etre une date UTC ISO valide fournie par l\'appelant.');
  }
  return trimmed;
}

function deterministicConfidenceBp(pages: number[], passIndexes: number[]) {
  return pages.length > 0 && passIndexes.length === 2 ? 9_000 : 4_999;
}

function targetCurrentValue(draft: SupplierInvoiceAiDraft, target: SupplierInvoiceAiConflict['target']) {
  if (!target.startsWith('line:')) {
    return supplierInvoiceCanonicalFieldValue(draft, target as SupplierInvoiceAiField);
  }
  const occurrenceId = target.slice('line:'.length);
  const matches = draft.lines.filter((line) => line.occurrenceId === occurrenceId);
  return matches.length === 1 ? supplierInvoiceCanonicalLineValue(matches[0]) : '';
}

type CanonicalJsonState = {
  seen: WeakSet<object>;
  nodes: number;
  characters: number;
};

function canonicalJsonValue(
  value: unknown,
  state: CanonicalJsonState,
  depth: number,
): unknown {
  state.nodes += 1;
  if (state.nodes > CANONICAL_JSON_MAX_NODES) {
    throw new Error(`La valeur JSON depasse ${CANONICAL_JSON_MAX_NODES} noeuds.`);
  }
  if (depth > CANONICAL_JSON_MAX_DEPTH) {
    throw new Error(`La valeur JSON depasse la profondeur maximale de ${CANONICAL_JSON_MAX_DEPTH}.`);
  }
  if (typeof value === 'string') {
    state.characters += value.length;
    if (state.characters > CANONICAL_JSON_MAX_CHARACTERS) {
      throw new Error(`La valeur JSON depasse ${CANONICAL_JSON_MAX_CHARACTERS} caracteres.`);
    }
    return value;
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Une valeur non finie ne peut pas etre hachee.');
    return value;
  }
  if (!value || typeof value !== 'object') {
    throw new Error('Une valeur non JSON ne peut pas etre hachee.');
  }
  if (state.seen.has(value)) {
    throw new Error('Une reference cyclique ou partagee ne peut pas etre hachee comme JSON pur.');
  }
  state.seen.add(value);

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new Error('Un tableau avec prototype non standard ne peut pas etre hache.');
    }
    if (value.length > CANONICAL_JSON_MAX_NODES) {
      throw new Error(`Un tableau JSON depasse ${CANONICAL_JSON_MAX_NODES} elements.`);
    }
    const expectedKeys = new Set<string>(['length']);
    for (let index = 0; index < value.length; index += 1) expectedKeys.add(String(index));
    const actualKeys = Reflect.ownKeys(value);
    if (actualKeys.some((key) => typeof key !== 'string' || !expectedKeys.has(key))
      || actualKeys.length !== expectedKeys.size) {
      throw new Error('Un tableau creux ou avec proprietes additionnelles ne peut pas etre hache comme JSON pur.');
    }
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !('value' in descriptor) || descriptor.value === undefined) {
        throw new Error('Seuls les elements JSON enumerables peuvent etre haches.');
      }
      result.push(canonicalJsonValue(descriptor.value, state, depth + 1));
    }
    return result;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('Seuls les objets JSON simples peuvent etre haches.');
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string')) {
    throw new Error('Une cle symbole ne peut pas etre hachee comme JSON.');
  }
  const stringKeys = ownKeys as string[];
  if (stringKeys.some((key) => PROTOTYPE_KEYS.has(key))) {
    throw new Error('Une cle de prototype ne peut pas etre hachee.');
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of stringKeys.sort()) {
    state.characters += key.length;
    if (state.characters > CANONICAL_JSON_MAX_CHARACTERS) {
      throw new Error(`La valeur JSON depasse ${CANONICAL_JSON_MAX_CHARACTERS} caracteres.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor) || descriptor.value === undefined) {
      throw new Error('Seules les proprietes JSON enumerables peuvent etre hachees.');
    }
    result[key] = canonicalJsonValue(descriptor.value, state, depth + 1);
  }
  return result;
}

export function canonicalSupplierInvoiceJson(value: unknown): string {
  const canonical = JSON.stringify(canonicalJsonValue(
    value,
    { seen: new WeakSet(), nodes: 0, characters: 0 },
    0,
  ));
  if (canonical.length > CANONICAL_JSON_MAX_CHARACTERS * 2) {
    throw new Error('La representation JSON canonique depasse la taille autorisee.');
  }
  return canonical;
}

export function canonicalSupplierInvoiceDraftJson(draft: SupplierInvoiceAiDraft): string {
  return canonicalSupplierInvoiceJson({
    supplier: {
      printedName: draft.supplier.printedName,
      uidNumber: draft.supplier.uidNumber,
      iban: draft.supplier.iban,
    },
    reference: draft.reference,
    invoiceDate: draft.invoiceDate,
    dueDate: draft.dueDate,
    currency: draft.currency,
    printedNetCents: draft.printedNetCents,
    printedVatCents: draft.printedVatCents,
    printedTotalCents: draft.printedTotalCents,
    lines: draft.lines.map((line) => ({ ...line })),
    warnings: [...draft.warnings],
  });
}

export async function supplierInvoiceSha256Hex(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Web Crypto est indisponible; aucune empreinte de secours n\'est acceptee.');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function supplierInvoiceDraftSha256(draft: SupplierInvoiceAiDraft): Promise<string> {
  return supplierInvoiceSha256Hex(canonicalSupplierInvoiceDraftJson(draft));
}

function canonicalReviewText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label} doit etre un texte.`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw new Error(`${label} depasse ${maxLength} caracteres.`);
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new Error(`${label} contient un caractere de controle.`);
  return trimmed;
}

function canonicalReviewBoolean(value: unknown, label: string, optional = false): boolean {
  if (optional && value === undefined) return false;
  if (typeof value !== 'boolean') throw new Error(`${label} doit etre un booleen explicite.`);
  return value;
}

export function canonicalSupplierInvoiceBusinessReviewJson(
  review: SupplierInvoiceHumanBusinessReview,
): string {
  if (!review || typeof review !== 'object' || !Array.isArray(review.lines)) {
    throw new Error('La revue metier doit etre un objet complet.');
  }
  if (!isSupplierInvoiceRoundingPolicy(review.roundingPolicy)) {
    throw new Error('La politique d\'arrondi de la revue metier est invalide.');
  }
  if (review.lines.length > SUPPLIER_INVOICE_MAX_LINE_OCCURRENCES) {
    throw new Error('La revue metier contient trop de classifications de lignes.');
  }
  const normalizedLines = review.lines.map((line, index) => {
    if (!line || typeof line !== 'object') throw new Error(`Revue ligne ${index + 1}: objet invalide.`);
    return {
      occurrenceId: canonicalReviewText(line.occurrenceId, `Revue ligne ${index + 1}.occurrenceId`, 200),
      category: canonicalReviewText(line.category, `Revue ligne ${index + 1}.category`, 200),
      categoryChosenByHuman: canonicalReviewBoolean(
        line.categoryChosenByHuman,
        `Revue ligne ${index + 1}.categoryChosenByHuman`,
      ),
      existingExpenseAccountId: canonicalReviewText(
        line.existingExpenseAccountId ?? '',
        `Revue ligne ${index + 1}.existingExpenseAccountId`,
        200,
      ) || null,
      expenseAccountSelectedByHuman: canonicalReviewBoolean(
        line.expenseAccountSelectedByHuman,
        `Revue ligne ${index + 1}.expenseAccountSelectedByHuman`,
        true,
      ),
      existingProjectId: canonicalReviewText(
        line.existingProjectId ?? '',
        `Revue ligne ${index + 1}.existingProjectId`,
        200,
      ) || null,
      projectSelectedByHuman: canonicalReviewBoolean(
        line.projectSelectedByHuman,
        `Revue ligne ${index + 1}.projectSelectedByHuman`,
        true,
      ),
    };
  }).sort((left, right) => (
    left.occurrenceId < right.occurrenceId ? -1 : left.occurrenceId > right.occurrenceId ? 1 : 0
  ));
  return canonicalSupplierInvoiceJson({
    existingSupplierId: canonicalReviewText(review.existingSupplierId, 'existingSupplierId', 200),
    supplierSelectedByHuman: canonicalReviewBoolean(
      review.supplierSelectedByHuman,
      'supplierSelectedByHuman',
    ),
    existingProjectId: canonicalReviewText(review.existingProjectId ?? '', 'existingProjectId', 200) || null,
    projectSelectedByHuman: canonicalReviewBoolean(
      review.projectSelectedByHuman,
      'projectSelectedByHuman',
      true,
    ),
    roundingPolicy: review.roundingPolicy,
    roundingPolicyConfirmedByHuman: canonicalReviewBoolean(
      review.roundingPolicyConfirmedByHuman,
      'roundingPolicyConfirmedByHuman',
    ),
    lines: normalizedLines,
  });
}

export function supplierInvoiceBusinessReviewSha256(
  review: SupplierInvoiceHumanBusinessReview,
): Promise<string> {
  return supplierInvoiceSha256Hex(canonicalSupplierInvoiceBusinessReviewJson(review));
}

/**
 * Construit une preuve stricte liee au fichier, au modele et aux deux passes.
 * analyzedAt est obligatoire pour eviter une horloge implicite dans ce module.
 */
export function supplierInvoiceAnalysisManifestFromAi(input: {
  reconciled: ReconciledSupplierInvoiceAiDraft;
  analyzedAt: string;
}): SupplierInvoiceAnalysisManifest {
  const { analysisContext, draft, provenance } = input.reconciled;
  if (!analysisContext
    || !Number.isSafeInteger(analysisContext.analyzedPageCount)
    || analysisContext.analyzedPageCount < 1
    || analysisContext.analyzedPageCount > SUPPLIER_INVOICE_MAX_ANALYZED_PAGES) {
    throw new Error(`Le manifeste doit couvrir entre 1 et ${SUPPLIER_INVOICE_MAX_ANALYZED_PAGES} pages.`);
  }
  if (draft.lines.length > SUPPLIER_INVOICE_MAX_LINE_OCCURRENCES) {
    throw new Error(
      `Le manifeste refuse ${draft.lines.length} occurrences; la limite est ${SUPPLIER_INVOICE_MAX_LINE_OCCURRENCES}, sans troncature.`,
    );
  }
  const analyzedPages = Array.from({ length: analysisContext.analyzedPageCount }, (_, index) => index + 1);
  const conflictTargets = new Set<string>();
  const conflicts = provenance.conflicts.map((conflict, index) => {
    const target = conflict.target.trim() as SupplierInvoiceAiConflict['target'];
    if ((!target.startsWith('line:') && !FIELD_SET.has(target)) || target === 'line:') {
      throw new Error(`Conflit ${index + 1}: cible non prise en charge.`);
    }
    if (conflictTargets.has(target)) throw new Error(`Conflit duplique pour ${target}.`);
    conflictTargets.add(target);
    if (conflict.values.length !== 2
      || conflict.values.some((value) => value !== null && typeof value !== 'string')
      || conflict.values.every((value) => value === null)
      || conflict.values[0] === conflict.values[1]
      || conflict.values.some((value) => value !== null && value.length > 5_000)) {
      throw new Error(`Conflit ${target}: alternatives invalides.`);
    }
    if ((target.startsWith('line:') && conflict.kind !== 'line')
      || (!target.startsWith('line:') && conflict.kind !== 'field')) {
      throw new Error(`Conflit ${target}: type de cible incoherent.`);
    }
    const pages = normalizedEvidenceNumbers(conflict.pages, `conflit ${target}.pages`, 1, analysisContext.analyzedPageCount);
    const passIndexes = assertTwoPassEvidence(conflict.passIndexes, `conflit ${target}.passIndexes`);
    return { ...conflict, target, values: [...conflict.values], pages, passIndexes };
  });

  const fieldProvenance: SupplierInvoiceAnalysisFieldEvidence[] = [];
  for (const field of SUPPLIER_INVOICE_AI_FIELDS) {
    const evidence = provenance.fields[field];
    if (!evidence) continue;
    if (conflictTargets.has(field)) throw new Error(`Le champ ${field} est a la fois resolu et en conflit.`);
    const value = supplierInvoiceCanonicalFieldValue(draft, field);
    if (!value) throw new Error(`Le champ ${field} a une provenance sans valeur canonique.`);
    const pages = normalizedEvidenceNumbers(evidence.pages, `${field}.pages`, 1, analysisContext.analyzedPageCount);
    const passIndexes = assertTwoPassEvidence(evidence.passIndexes, `${field}.passIndexes`);
    fieldProvenance.push({
      field,
      value,
      pages,
      passIndexes,
      confidenceBp: deterministicConfidenceBp(pages, passIndexes),
    });
  }

  const seenOccurrenceIds = new Set<string>();
  const lineProvenance = provenance.lines.map((evidence) => {
    const occurrenceId = requiredText(evidence.occurrenceId, 'occurrenceId', 200);
    if (seenOccurrenceIds.has(occurrenceId)) throw new Error(`Provenance dupliquee pour ${occurrenceId}.`);
    seenOccurrenceIds.add(occurrenceId);
    if (conflictTargets.has(`line:${occurrenceId}`)) {
      throw new Error(`La ligne ${occurrenceId} est a la fois resolue et en conflit.`);
    }
    const line = draft.lines[evidence.lineIndex];
    if (!line || line.occurrenceId !== occurrenceId) {
      throw new Error(`La provenance ${occurrenceId} ne correspond pas au brouillon.`);
    }
    const pages = normalizedEvidenceNumbers(evidence.pages, `${occurrenceId}.pages`, 1, analysisContext.analyzedPageCount);
    const passIndexes = assertTwoPassEvidence(evidence.passIndexes, `${occurrenceId}.passIndexes`);
    return {
      occurrenceId,
      lineIndex: evidence.lineIndex,
      canonicalValue: supplierInvoiceCanonicalLineValue(line),
      pages,
      passIndexes,
      confidenceBp: deterministicConfidenceBp(pages, passIndexes),
    };
  }).sort((left, right) => left.lineIndex - right.lineIndex);

  return {
    schemaVersion: SUPPLIER_INVOICE_ANALYSIS_MANIFEST_SCHEMA_VERSION,
    modelId: requiredText(analysisContext.modelId, 'modelId', 500),
    modelRevision: requiredText(analysisContext.modelRevision, 'modelRevision', 500),
    inputSha256: normalizedSha256(analysisContext.inputSha256, 'inputSha256'),
    analyzedPages,
    passes: 2,
    fieldProvenance,
    lineProvenance,
    conflicts,
    resolvedConflicts: [],
    analyzedAt: assertAnalyzedAt(input.analyzedAt),
  };
}

/** Retire uniquement les preuves que les corrections humaines ont invalidees. */
export function reconcileSupplierInvoiceAnalysisManifest(
  manifest: SupplierInvoiceAnalysisManifest,
  previousDraft: SupplierInvoiceAiDraft,
  nextDraft: SupplierInvoiceAiDraft,
  conflictResolutions: readonly SupplierInvoiceConflictResolutionInput[] = [],
): SupplierInvoiceAnalysisManifest {
  const fieldProvenance = manifest.fieldProvenance
    .filter((evidence) => (
      supplierInvoiceCanonicalFieldValue(previousDraft, evidence.field) === evidence.value
      && supplierInvoiceCanonicalFieldValue(nextDraft, evidence.field) === evidence.value
    ))
    .map((evidence) => ({
      ...evidence,
      pages: [...evidence.pages],
      passIndexes: [...evidence.passIndexes],
    }));

  const nextIndexesByOccurrence = new Map<string, number[]>();
  nextDraft.lines.forEach((line, index) => {
    const indexes = nextIndexesByOccurrence.get(line.occurrenceId) ?? [];
    indexes.push(index);
    nextIndexesByOccurrence.set(line.occurrenceId, indexes);
  });
  const lineProvenance = manifest.lineProvenance.flatMap((evidence) => {
    const previousLine = previousDraft.lines[evidence.lineIndex];
    if (!previousLine
      || previousLine.occurrenceId !== evidence.occurrenceId
      || supplierInvoiceCanonicalLineValue(previousLine) !== evidence.canonicalValue) return [];
    const nextIndexes = nextIndexesByOccurrence.get(evidence.occurrenceId) ?? [];
    if (nextIndexes.length !== 1) return [];
    const nextIndex = nextIndexes[0];
    const nextLine = nextDraft.lines[nextIndex];
    if (supplierInvoiceCanonicalLineValue(nextLine) !== evidence.canonicalValue) return [];
    return [{
      ...evidence,
      lineIndex: nextIndex,
      pages: [...evidence.pages],
      passIndexes: [...evidence.passIndexes],
    }];
  }).sort((left, right) => left.lineIndex - right.lineIndex);

  const retainedResolutions: SupplierInvoiceAnalysisConflictResolution[] = [];
  const unresolvedByTarget = new Map<string, SupplierInvoiceAiConflict>();
  for (const conflict of manifest.conflicts) {
    unresolvedByTarget.set(conflict.target, cloneConflict(conflict));
  }
  for (const resolution of manifest.resolvedConflicts) {
    const currentValue = targetCurrentValue(nextDraft, resolution.conflict.target);
    if (resolution.confirmedByHuman === true
      && currentValue === resolution.resolvedCanonicalValue) {
      retainedResolutions.push(cloneConflictResolution(resolution));
    } else {
      unresolvedByTarget.set(resolution.conflict.target, cloneConflict(resolution.conflict));
    }
  }

  const submittedTargets = new Set<string>();
  for (const resolution of conflictResolutions) {
    const target = resolution.target.trim() as SupplierInvoiceAiConflict['target'];
    if (submittedTargets.has(target)) throw new Error(`Resolution dupliquee pour ${target}.`);
    submittedTargets.add(target);
    const conflict = unresolvedByTarget.get(target);
    if (!conflict) throw new Error(`Aucun conflit ouvert ne correspond a ${target}.`);
    if (resolution.confirmedByHuman !== true) {
      throw new Error(`La resolution de ${target} exige une confirmation humaine explicite.`);
    }
    if (typeof resolution.resolvedCanonicalValue !== 'string'
      || resolution.resolvedCanonicalValue.length > 10_000) {
      throw new Error(`La valeur resolue de ${target} est invalide.`);
    }
    const currentValue = targetCurrentValue(nextDraft, conflict.target);
    if (currentValue !== resolution.resolvedCanonicalValue) {
      throw new Error(`La resolution de ${target} ne correspond pas a la valeur courante du brouillon.`);
    }
    retainedResolutions.push({
      conflict: cloneConflict(conflict),
      resolvedCanonicalValue: resolution.resolvedCanonicalValue,
      confirmedByHuman: true,
    });
    unresolvedByTarget.delete(target);
  }
  const conflicts = [...unresolvedByTarget.values()];

  return {
    ...manifest,
    analyzedPages: [...manifest.analyzedPages],
    fieldProvenance,
    lineProvenance,
    conflicts,
    resolvedConflicts: retainedResolutions,
  };
}

export function supplierInvoiceAiProvenanceFromManifest(
  manifest: SupplierInvoiceAnalysisManifest,
): SupplierInvoiceAiProvenance {
  return {
    fields: Object.fromEntries(manifest.fieldProvenance.map((item) => [item.field, {
      pages: [...item.pages],
      passIndexes: [...item.passIndexes],
    }])) as SupplierInvoiceAiProvenance['fields'],
    lines: manifest.lineProvenance.map((item) => ({
      occurrenceId: item.occurrenceId,
      lineIndex: item.lineIndex,
      pages: [...item.pages],
      passIndexes: [...item.passIndexes],
    })),
    conflicts: manifest.conflicts.map(cloneConflict),
  };
}

export async function buildSupplierInvoiceHumanReviewAttestation(input: {
  draft: SupplierInvoiceAiDraft;
  manifest: SupplierInvoiceAnalysisManifest;
  businessReview: SupplierInvoiceHumanBusinessReview;
  sourceSha256: string;
  humanConfirmed: boolean;
}): Promise<{
  attestation: SupplierInvoiceHumanReviewAttestation;
  evidenceSha256: string;
}> {
  if (!input.humanConfirmed) {
    throw new Error('La confirmation humaine explicite est obligatoire.');
  }
  if (input.manifest.schemaVersion !== SUPPLIER_INVOICE_ANALYSIS_MANIFEST_SCHEMA_VERSION
    || input.manifest.passes !== 2
    || !Array.isArray(input.manifest.analyzedPages)
    || !input.manifest.analyzedPages.length
    || input.manifest.analyzedPages.length > SUPPLIER_INVOICE_MAX_ANALYZED_PAGES
    || input.manifest.analyzedPages.some((page, index) => page !== index + 1)
    || !Array.isArray(input.manifest.fieldProvenance)
    || !Array.isArray(input.manifest.lineProvenance)
    || !Array.isArray(input.manifest.conflicts)
    || !Array.isArray(input.manifest.resolvedConflicts)) {
    throw new Error('Le manifeste d\'analyse est incomplet ou incompatible.');
  }
  requiredText(input.manifest.modelId, 'manifest.modelId', 500);
  requiredText(input.manifest.modelRevision, 'manifest.modelRevision', 500);
  assertAnalyzedAt(input.manifest.analyzedAt);
  const sourceSha256 = normalizedSha256(input.sourceSha256, 'sourceSha256');
  if (sourceSha256 !== input.manifest.inputSha256) {
    throw new Error('Le document atteste ne correspond pas au hash du manifeste.');
  }
  if (input.manifest.conflicts.length) {
    throw new Error('Les conflits entre passes doivent etre resolus avant l\'attestation.');
  }
  const assessment = assessSupplierInvoiceConfirmation({
    draft: input.draft,
    conflicts: input.manifest.conflicts,
    businessReview: input.businessReview,
  });
  if (!assessment.ready) {
    throw new Error(`Le brouillon ne peut pas etre atteste: ${assessment.blockers.join(' ')}`);
  }
  for (const resolution of input.manifest.resolvedConflicts) {
    if (resolution.confirmedByHuman !== true
      || targetCurrentValue(input.draft, resolution.conflict.target) !== resolution.resolvedCanonicalValue) {
      throw new Error(`La resolution du conflit ${resolution.conflict.target} est absente ou obsolete.`);
    }
  }
  for (const evidence of input.manifest.fieldProvenance) {
    if (supplierInvoiceCanonicalFieldValue(input.draft, evidence.field) !== evidence.value) {
      throw new Error(`La provenance du champ ${evidence.field} est devenue obsolete.`);
    }
  }
  for (const evidence of input.manifest.lineProvenance) {
    const matches = input.draft.lines.filter((line) => line.occurrenceId === evidence.occurrenceId);
    if (matches.length !== 1 || supplierInvoiceCanonicalLineValue(matches[0]) !== evidence.canonicalValue) {
      throw new Error(`La provenance de l\'occurrence ${evidence.occurrenceId} est devenue obsolete.`);
    }
  }
  const draftSha256 = await supplierInvoiceDraftSha256(input.draft);
  const manifestSha256 = await supplierInvoiceSha256Hex(canonicalSupplierInvoiceJson(input.manifest));
  const businessReviewSha256 = await supplierInvoiceBusinessReviewSha256(input.businessReview);
  const attestation: SupplierInvoiceHumanReviewAttestation = {
    schemaVersion: 1,
    attestationVersion: SUPPLIER_INVOICE_HUMAN_REVIEW_ATTESTATION_VERSION,
    statement: SUPPLIER_INVOICE_HUMAN_REVIEW_ATTESTATION_TEXT,
    sourceSha256,
    draftSha256,
    manifestSha256,
    businessReviewSha256,
    roundingPolicy: input.businessReview.roundingPolicy,
  };
  return {
    attestation,
    evidenceSha256: await supplierInvoiceSha256Hex(canonicalSupplierInvoiceJson(attestation)),
  };
}
