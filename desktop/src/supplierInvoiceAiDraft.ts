export const SUPPLIER_INVOICE_MAX_ANALYZED_PAGES = 12;
export const SUPPLIER_INVOICE_MAX_LINE_OCCURRENCES = 40;
export const SUPPLIER_INVOICE_AI_MAX_JSON_CHARS = 250_000;
export const SUPPLIER_INVOICE_AI_MAX_JSON_DEPTH = 32;
export const SUPPLIER_INVOICE_AI_MAX_JSON_NODES = 20_000;

export const SUPPLIER_INVOICE_AI_FIELDS = [
  'supplier.printed_name',
  'supplier.uid_number',
  'supplier.iban',
  'reference',
  'invoice_date',
  'due_date',
  'currency',
  'printed_net_cents',
  'printed_vat_cents',
  'printed_total_cents',
] as const;

export type SupplierInvoiceAiField = typeof SUPPLIER_INVOICE_AI_FIELDS[number];

export type SupplierInvoiceAiLine = {
  /** Identite documentaire stable; ce n'est pas un identifiant comptable. */
  occurrenceId: string;
  description: string;
  quantityMilli: number | null;
  unit: string;
  unitPriceCents: number | null;
  discountBp: number | null;
  vatBp: number | null;
  printedNetCents: number | null;
  printedVatCents: number | null;
  printedTotalCents: number | null;
};

export type SupplierInvoiceAiDraft = {
  supplier: {
    /** Identite imprimee uniquement. Aucun fournisseur applicatif n'est choisi ici. */
    printedName: string;
    uidNumber: string;
    iban: string;
  };
  reference: string;
  invoiceDate: string;
  dueDate: string;
  /** Valeur observee. Le controle qualite bloque toute valeur autre que CHF. */
  currency: string;
  printedNetCents: number | null;
  printedVatCents: number | null;
  printedTotalCents: number | null;
  lines: SupplierInvoiceAiLine[];
  warnings: string[];
};

export type SupplierInvoiceAiFieldProvenance = {
  pages: number[];
  passIndexes: number[];
};

export type SupplierInvoiceAiLineProvenance = {
  occurrenceId: string;
  lineIndex: number;
  pages: number[];
  passIndexes: number[];
};

export type SupplierInvoiceAiConflict = {
  target: SupplierInvoiceAiField | `line:${string}`;
  kind: 'field' | 'line';
  /** null signifie que la passe n'a rien observe pour cette cible. */
  values: Array<string | null>;
  pages: number[];
  passIndexes: number[];
};

export type SupplierInvoiceAiProvenance = {
  fields: Partial<Record<SupplierInvoiceAiField, SupplierInvoiceAiFieldProvenance>>;
  lines: SupplierInvoiceAiLineProvenance[];
  conflicts: SupplierInvoiceAiConflict[];
};

export type ParsedSupplierInvoiceAiPass = {
  passIndex: 1 | 2;
  analyzedPageCount: number;
  inputSha256: string;
  modelId: string;
  modelRevision: string;
  draft: SupplierInvoiceAiDraft;
  provenance: SupplierInvoiceAiProvenance;
};

export type ReconciledSupplierInvoiceAiDraft = {
  analysisContext: {
    analyzedPageCount: number;
    inputSha256: string;
    modelId: string;
    modelRevision: string;
  };
  draft: SupplierInvoiceAiDraft;
  provenance: SupplierInvoiceAiProvenance;
};

type JsonRecord = Record<string, unknown>;

const FIELD_SET = new Set<string>(SUPPLIER_INVOICE_AI_FIELDS);
const FORBIDDEN_BUSINESS_KEYS = new Set([
  'supplierid',
  'projectid',
  'accountid',
  'expenseaccountid',
  'category',
  'createdsupplier',
  'newsupplier',
]);
const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function jsonRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} doit etre un objet JSON.`);
  }
  return value as JsonRecord;
}

function optionalJsonRecord(value: unknown, label: string): JsonRecord {
  if (value === undefined || value === null) return {};
  return jsonRecord(value, label);
}

function normalizedKey(value: string) {
  return value.replace(/[_\-\s]/g, '').toLowerCase();
}

function assertNoBusinessSelections(value: unknown, rootPath = 'document') {
  const pending: Array<{ value: unknown; path: string; depth: number }> = [
    { value, path: rootPath, depth: 0 },
  ];
  let visitedNodes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    visitedNodes += 1;
    if (visitedNodes > SUPPLIER_INVOICE_AI_MAX_JSON_NODES) {
      throw new Error(`Le JSON depasse ${SUPPLIER_INVOICE_AI_MAX_JSON_NODES} noeuds autorises.`);
    }
    if (current.depth > SUPPLIER_INVOICE_AI_MAX_JSON_DEPTH) {
      throw new Error(`Le JSON depasse la profondeur maximale de ${SUPPLIER_INVOICE_AI_MAX_JSON_DEPTH}.`);
    }
    if (!current.value || typeof current.value !== 'object') continue;
    const entries = Array.isArray(current.value)
      ? current.value.map((child, index) => [String(index), child] as const)
      : Object.entries(current.value as JsonRecord);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, child] = entries[index];
      if (PROTOTYPE_KEYS.has(key)) {
        throw new Error(`Cle JSON interdite dans ${current.path}.`);
      }
      if (FORBIDDEN_BUSINESS_KEYS.has(normalizedKey(key))) {
        throw new Error(
          `La proposition locale ne peut ni creer ni choisir fournisseur, projet, categorie ou compte (${current.path}.${key}).`,
        );
      }
      pending.push({
        value: child,
        path: Array.isArray(current.value) ? `${current.path}[${key}]` : `${current.path}.${key}`,
        depth: current.depth + 1,
      });
    }
  }
}

function safeText(value: unknown, label: string, maxLength: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`${label} doit etre un texte JSON.`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw new Error(`${label} depasse ${maxLength} caracteres.`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed)) {
    throw new Error(`${label} contient des caracteres de controle interdits.`);
  }
  return trimmed;
}

function requiredAnalysisText(value: unknown, label: string, maxLength: number): string {
  const parsed = safeText(value, label, maxLength);
  if (!parsed) throw new Error(`${label} manque.`);
  return parsed;
}

function normalizedSha256(value: unknown, label: string): string {
  const parsed = requiredAnalysisText(value, label, 64).toLowerCase();
  if (!SHA256_PATTERN.test(parsed)) throw new Error(`${label} doit etre un SHA-256 hexadecimal.`);
  return parsed;
}

function optionalInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} doit etre un entier compris entre ${minimum} et ${maximum}.`);
  }
  return value as number;
}

function requiredPositiveInteger(value: unknown, label: string, maximum: number): number {
  const parsed = optionalInteger(value, label, 1, maximum);
  if (parsed === null) throw new Error(`${label} manque.`);
  return parsed;
}

function normalizedPages(value: unknown, label: string, analyzedPageCount: number): number[] {
  if (!Array.isArray(value) || !value.length) {
    throw new Error(`${label} doit indiquer au moins une page source.`);
  }
  const pages = [...new Set(value.map((page) => {
    if (!Number.isSafeInteger(page) || page < 1 || page > analyzedPageCount) {
      throw new Error(`${label} contient une page hors du document analyse.`);
    }
    return page as number;
  }))].sort((left, right) => left - right);
  return pages;
}

function parseWarnings(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('warnings doit etre un tableau JSON.');
  if (value.length > 50) throw new Error('Le resultat contient plus de 50 avertissements.');
  return [...new Set(value.map((warning, index) => (
    safeText(warning, `warnings[${index}]`, 500)
  )).filter(Boolean))];
}

function emptyDraft(): SupplierInvoiceAiDraft {
  return {
    supplier: { printedName: '', uidNumber: '', iban: '' },
    reference: '',
    invoiceDate: '',
    dueDate: '',
    currency: '',
    printedNetCents: null,
    printedVatCents: null,
    printedTotalCents: null,
    lines: [],
    warnings: [],
  };
}

export function emptySupplierInvoiceAiDraft(): SupplierInvoiceAiDraft {
  return emptyDraft();
}

export function supplierInvoiceCanonicalFieldValue(
  draft: SupplierInvoiceAiDraft,
  field: SupplierInvoiceAiField,
): string {
  switch (field) {
    case 'supplier.printed_name': return draft.supplier.printedName.trim();
    case 'supplier.uid_number': return draft.supplier.uidNumber.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    case 'supplier.iban': return draft.supplier.iban.replace(/\s/g, '').toUpperCase();
    case 'reference': return draft.reference.trim();
    case 'invoice_date': return draft.invoiceDate.trim();
    case 'due_date': return draft.dueDate.trim();
    case 'currency': return draft.currency.trim().toUpperCase();
    case 'printed_net_cents': return draft.printedNetCents === null ? '' : String(draft.printedNetCents);
    case 'printed_vat_cents': return draft.printedVatCents === null ? '' : String(draft.printedVatCents);
    case 'printed_total_cents': return draft.printedTotalCents === null ? '' : String(draft.printedTotalCents);
  }
}

export function supplierInvoiceCanonicalLineValue(line: SupplierInvoiceAiLine): string {
  return JSON.stringify({
    description: line.description.trim(),
    quantity_milli: line.quantityMilli,
    unit: line.unit.trim(),
    unit_price_cents: line.unitPriceCents,
    discount_bp: line.discountBp,
    vat_bp: line.vatBp,
    printed_net_cents: line.printedNetCents,
    printed_vat_cents: line.printedVatCents,
    printed_total_cents: line.printedTotalCents,
  });
}

function draftFieldValue(draft: SupplierInvoiceAiDraft, field: SupplierInvoiceAiField): unknown {
  switch (field) {
    case 'supplier.printed_name': return draft.supplier.printedName;
    case 'supplier.uid_number': return draft.supplier.uidNumber;
    case 'supplier.iban': return draft.supplier.iban;
    case 'reference': return draft.reference;
    case 'invoice_date': return draft.invoiceDate;
    case 'due_date': return draft.dueDate;
    case 'currency': return draft.currency;
    case 'printed_net_cents': return draft.printedNetCents;
    case 'printed_vat_cents': return draft.printedVatCents;
    case 'printed_total_cents': return draft.printedTotalCents;
  }
}

function setDraftField(draft: SupplierInvoiceAiDraft, field: SupplierInvoiceAiField, value: unknown) {
  switch (field) {
    case 'supplier.printed_name': draft.supplier.printedName = value as string; break;
    case 'supplier.uid_number': draft.supplier.uidNumber = value as string; break;
    case 'supplier.iban': draft.supplier.iban = value as string; break;
    case 'reference': draft.reference = value as string; break;
    case 'invoice_date': draft.invoiceDate = value as string; break;
    case 'due_date': draft.dueDate = value as string; break;
    case 'currency': draft.currency = value as string; break;
    case 'printed_net_cents': draft.printedNetCents = value as number | null; break;
    case 'printed_vat_cents': draft.printedVatCents = value as number | null; break;
    case 'printed_total_cents': draft.printedTotalCents = value as number | null; break;
  }
}

function blankFieldValue(field: SupplierInvoiceAiField): string | null {
  return field.endsWith('_cents') ? null : '';
}

function readFieldPages(
  raw: JsonRecord,
  draft: SupplierInvoiceAiDraft,
  analyzedPageCount: number,
): Partial<Record<SupplierInvoiceAiField, number[]>> {
  const fieldPagesRaw = optionalJsonRecord(raw.field_pages, 'field_pages');
  for (const field of Object.keys(fieldPagesRaw)) {
    if (!FIELD_SET.has(field)) throw new Error(`Champ de provenance non pris en charge: ${field}.`);
  }

  const fieldPages: Partial<Record<SupplierInvoiceAiField, number[]>> = {};
  for (const field of SUPPLIER_INVOICE_AI_FIELDS) {
    const value = supplierInvoiceCanonicalFieldValue(draft, field);
    const pagesValue = fieldPagesRaw[field];
    if (!value) {
      if (pagesValue !== undefined && pagesValue !== null) {
        normalizedPages(pagesValue, `field_pages.${field}`, analyzedPageCount);
      }
      continue;
    }
    fieldPages[field] = normalizedPages(
      pagesValue,
      `field_pages.${field}`,
      analyzedPageCount,
    );
  }
  return fieldPages;
}

function parseLine(
  value: unknown,
  index: number,
  analyzedPageCount: number,
): { line: SupplierInvoiceAiLine; pages: number[]; sourceOrdinal: number } {
  const raw = jsonRecord(value, `lines[${index}]`);
  const pages = normalizedPages(raw.pages, `lines[${index}].pages`, analyzedPageCount);
  const sourceOrdinal = requiredPositiveInteger(
    raw.source_ordinal,
    `lines[${index}].source_ordinal`,
    SUPPLIER_INVOICE_MAX_LINE_OCCURRENCES,
  );
  const occurrenceId = `supplier-line:p${pages[0]}:o${sourceOrdinal}`;
  return {
    line: {
      occurrenceId,
      description: safeText(raw.description, `lines[${index}].description`, 1_000),
      quantityMilli: optionalInteger(raw.quantity_milli, `lines[${index}].quantity_milli`, 0, 1_000_000_000),
      unit: safeText(raw.unit, `lines[${index}].unit`, 50),
      unitPriceCents: optionalInteger(raw.unit_price_cents, `lines[${index}].unit_price_cents`, 0, 10_000_000_000),
      discountBp: optionalInteger(raw.discount_bp, `lines[${index}].discount_bp`, 0, 10_000),
      vatBp: optionalInteger(raw.vat_bp, `lines[${index}].vat_bp`, 0, 10_000),
      printedNetCents: optionalInteger(raw.printed_net_cents, `lines[${index}].printed_net_cents`, 0, 10_000_000_000),
      printedVatCents: optionalInteger(raw.printed_vat_cents, `lines[${index}].printed_vat_cents`, 0, 10_000_000_000),
      printedTotalCents: optionalInteger(raw.printed_total_cents, `lines[${index}].printed_total_cents`, 0, 10_000_000_000),
    },
    pages,
    sourceOrdinal,
  };
}

/**
 * Parse une sortie de modele comme donnee hostile. La fonction n'accepte que
 * du JSON complet, ne complete aucun montant et ne coupe jamais les lignes.
 */
export function parseSupplierInvoiceAiPass(input: {
  raw: string;
  passIndex: 1 | 2;
  analyzedPageCount: number;
  inputSha256: string;
  modelId: string;
  modelRevision: string;
}): ParsedSupplierInvoiceAiPass {
  if (input.passIndex !== 1 && input.passIndex !== 2) {
    throw new Error('L\'index de passe doit valoir 1 ou 2.');
  }
  if (!Number.isSafeInteger(input.analyzedPageCount)
    || input.analyzedPageCount < 1
    || input.analyzedPageCount > SUPPLIER_INVOICE_MAX_ANALYZED_PAGES) {
    throw new Error(`Le document doit contenir entre 1 et ${SUPPLIER_INVOICE_MAX_ANALYZED_PAGES} pages analysees.`);
  }
  if (!input.raw.trim()) throw new Error('La sortie du modele local est vide.');
  if (input.raw.length > SUPPLIER_INVOICE_AI_MAX_JSON_CHARS) {
    throw new Error('La sortie du modele local depasse la limite JSON autorisee.');
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(input.raw);
  } catch {
    throw new Error('La sortie du modele local n\'est pas un JSON complet et valide.');
  }
  assertNoBusinessSelections(decoded);
  const raw = jsonRecord(decoded, 'document');
  const supplier = optionalJsonRecord(raw.supplier, 'supplier');
  const linesRaw = raw.lines ?? [];
  if (!Array.isArray(linesRaw)) throw new Error('lines doit etre un tableau JSON.');
  if (linesRaw.length > SUPPLIER_INVOICE_MAX_LINE_OCCURRENCES) {
    throw new Error(
      `La sortie contient ${linesRaw.length} occurrences de lignes; la limite est ${SUPPLIER_INVOICE_MAX_LINE_OCCURRENCES}, sans troncature.`,
    );
  }

  const draft = emptyDraft();
  draft.supplier = {
    printedName: safeText(supplier.printed_name, 'supplier.printed_name', 500),
    uidNumber: safeText(supplier.uid_number, 'supplier.uid_number', 100),
    iban: safeText(supplier.iban, 'supplier.iban', 100),
  };
  draft.reference = safeText(raw.reference, 'reference', 250);
  draft.invoiceDate = safeText(raw.invoice_date, 'invoice_date', 20);
  draft.dueDate = safeText(raw.due_date, 'due_date', 20);
  draft.currency = safeText(raw.currency, 'currency', 3).toUpperCase();
  draft.printedNetCents = optionalInteger(raw.printed_net_cents, 'printed_net_cents', 0, 10_000_000_000);
  draft.printedVatCents = optionalInteger(raw.printed_vat_cents, 'printed_vat_cents', 0, 10_000_000_000);
  draft.printedTotalCents = optionalInteger(raw.printed_total_cents, 'printed_total_cents', 0, 10_000_000_000);
  draft.warnings = parseWarnings(raw.warnings);

  const parsedLines = linesRaw.map((line, index) => parseLine(line, index, input.analyzedPageCount));
  const occurrenceIds = new Set<string>();
  for (const parsed of parsedLines) {
    if (occurrenceIds.has(parsed.line.occurrenceId)) {
      throw new Error(`Deux lignes partagent la meme occurrence source ${parsed.line.occurrenceId}.`);
    }
    occurrenceIds.add(parsed.line.occurrenceId);
  }
  parsedLines.sort((left, right) => (
    left.pages[0] - right.pages[0] || left.sourceOrdinal - right.sourceOrdinal
  ));
  draft.lines = parsedLines.map(({ line }) => line);

  const fieldPages = readFieldPages(raw, draft, input.analyzedPageCount);
  const fields: SupplierInvoiceAiProvenance['fields'] = {};
  for (const field of SUPPLIER_INVOICE_AI_FIELDS) {
    const pages = fieldPages[field];
    if (pages) fields[field] = { pages: [...pages], passIndexes: [input.passIndex] };
  }

  return {
    passIndex: input.passIndex,
    analyzedPageCount: input.analyzedPageCount,
    inputSha256: normalizedSha256(input.inputSha256, 'inputSha256'),
    modelId: requiredAnalysisText(input.modelId, 'modelId', 500),
    modelRevision: requiredAnalysisText(input.modelRevision, 'modelRevision', 500),
    draft,
    provenance: {
      fields,
      lines: parsedLines.map(({ line, pages }, lineIndex) => ({
        occurrenceId: line.occurrenceId,
        lineIndex,
        pages: [...pages],
        passIndexes: [input.passIndex],
      })),
      conflicts: [],
    },
  };
}

function mergedNumbers(left: number[], right: number[]) {
  return [...new Set([...left, ...right])].sort((a, b) => a - b);
}

function lineProvenanceFor(
  pass: ParsedSupplierInvoiceAiPass,
  occurrenceId: string,
): SupplierInvoiceAiLineProvenance | undefined {
  return pass.provenance.lines.find((item) => item.occurrenceId === occurrenceId);
}

function compareOccurrenceIds(left: string, right: string) {
  const leftMatch = /^supplier-line:p(\d+):o(\d+)$/.exec(left);
  const rightMatch = /^supplier-line:p(\d+):o(\d+)$/.exec(right);
  if (!leftMatch || !rightMatch) return left.localeCompare(right, 'en');
  return Number(leftMatch[1]) - Number(rightMatch[1])
    || Number(leftMatch[2]) - Number(rightMatch[2]);
}

/**
 * Ne considere comme resolue qu'une valeur identique lors des deux lectures.
 * Toute absence ou divergence devient un conflit structure; aucune passe n'est
 * choisie arbitrairement comme valeur de secours.
 */
export function reconcileSupplierInvoiceAiPasses(
  primary: ParsedSupplierInvoiceAiPass,
  verification: ParsedSupplierInvoiceAiPass,
): ReconciledSupplierInvoiceAiDraft {
  if (primary.passIndex !== 1 || verification.passIndex !== 2) {
    throw new Error('La reconciliation exige exactement les passes 1 et 2.');
  }
  if (primary.analyzedPageCount !== verification.analyzedPageCount) {
    throw new Error('Les deux passes ne couvrent pas le meme nombre de pages.');
  }
  if (primary.inputSha256 !== verification.inputSha256
    || primary.modelId !== verification.modelId
    || primary.modelRevision !== verification.modelRevision) {
    throw new Error('Les deux passes ne sont pas liees au meme fichier et a la meme revision du modele.');
  }

  const draft = emptyDraft();
  const fields: SupplierInvoiceAiProvenance['fields'] = {};
  const conflicts: SupplierInvoiceAiConflict[] = [];

  for (const field of SUPPLIER_INVOICE_AI_FIELDS) {
    const primaryCanonical = supplierInvoiceCanonicalFieldValue(primary.draft, field);
    const verificationCanonical = supplierInvoiceCanonicalFieldValue(verification.draft, field);
    const primaryPages = primary.provenance.fields[field]?.pages ?? [];
    const verificationPages = verification.provenance.fields[field]?.pages ?? [];
    if (!primaryCanonical && !verificationCanonical) continue;
    if (primaryCanonical === verificationCanonical) {
      setDraftField(draft, field, draftFieldValue(primary.draft, field));
      fields[field] = {
        pages: mergedNumbers(primaryPages, verificationPages),
        passIndexes: [1, 2],
      };
      continue;
    }
    setDraftField(draft, field, blankFieldValue(field));
    conflicts.push({
      target: field,
      kind: 'field',
      values: [primaryCanonical || null, verificationCanonical || null],
      pages: mergedNumbers(primaryPages, verificationPages),
      passIndexes: [1, 2],
    });
  }

  const primaryLines = new Map(primary.draft.lines.map((line) => [line.occurrenceId, line]));
  const verificationLines = new Map(verification.draft.lines.map((line) => [line.occurrenceId, line]));
  const occurrenceIds = [...new Set([...primaryLines.keys(), ...verificationLines.keys()])]
    .sort(compareOccurrenceIds);
  const lines: SupplierInvoiceAiLine[] = [];
  const lineProvenance: SupplierInvoiceAiLineProvenance[] = [];

  for (const occurrenceId of occurrenceIds) {
    const primaryLine = primaryLines.get(occurrenceId);
    const verificationLine = verificationLines.get(occurrenceId);
    const primaryEvidence = lineProvenanceFor(primary, occurrenceId);
    const verificationEvidence = lineProvenanceFor(verification, occurrenceId);
    const pages = mergedNumbers(primaryEvidence?.pages ?? [], verificationEvidence?.pages ?? []);
    const primaryValue = primaryLine ? supplierInvoiceCanonicalLineValue(primaryLine) : null;
    const verificationValue = verificationLine ? supplierInvoiceCanonicalLineValue(verificationLine) : null;
    if (primaryLine && verificationLine && primaryValue === verificationValue) {
      const lineIndex = lines.length;
      lines.push({ ...primaryLine });
      lineProvenance.push({ occurrenceId, lineIndex, pages, passIndexes: [1, 2] });
      continue;
    }
    conflicts.push({
      target: `line:${occurrenceId}`,
      kind: 'line',
      values: [primaryValue, verificationValue],
      pages,
      passIndexes: [1, 2],
    });
  }

  draft.lines = lines;
  draft.warnings = [...new Set([...primary.draft.warnings, ...verification.draft.warnings])];
  return {
    analysisContext: {
      analyzedPageCount: primary.analyzedPageCount,
      inputSha256: primary.inputSha256,
      modelId: primary.modelId,
      modelRevision: primary.modelRevision,
    },
    draft,
    provenance: { fields, lines: lineProvenance, conflicts },
  };
}

export function reconcileSupplierInvoiceAiJsonPasses(input: {
  primaryRaw: string;
  verificationRaw: string;
  analyzedPageCount: number;
  inputSha256: string;
  modelId: string;
  modelRevision: string;
}): ReconciledSupplierInvoiceAiDraft {
  return reconcileSupplierInvoiceAiPasses(
    parseSupplierInvoiceAiPass({
      raw: input.primaryRaw,
      passIndex: 1,
      analyzedPageCount: input.analyzedPageCount,
      inputSha256: input.inputSha256,
      modelId: input.modelId,
      modelRevision: input.modelRevision,
    }),
    parseSupplierInvoiceAiPass({
      raw: input.verificationRaw,
      passIndex: 2,
      analyzedPageCount: input.analyzedPageCount,
      inputSha256: input.inputSha256,
      modelId: input.modelId,
      modelRevision: input.modelRevision,
    }),
  );
}
