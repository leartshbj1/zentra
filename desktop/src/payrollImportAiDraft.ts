import type {
  PayrollAiIdentityEvidence,
  PayrollAnalysisConflict,
  PayrollConfirmedRecurringLine,
  PayrollImportDraft,
  PayrollImportEmployeeDraft,
  PayrollImportLineDraft,
} from './types';
import { createId } from './utils';
import { mergePayrollLines } from './payrollImportQuality';

type RecordValue = Record<string, unknown>;

export type PayrollImportConfirmedAiFields = {
  employmentRate?: boolean;
  salaryMode?: boolean;
};

export type ParsedPayrollAiDraft = {
  draft: PayrollImportDraft;
  detected: {
    employmentRate: boolean;
    salaryMode: boolean;
  };
  provenance: PayrollAiProvenance;
};

export type ReconciledPayrollAiDraft = ParsedPayrollAiDraft & {
  identity: PayrollAiIdentityEvidence;
  /** Nombre de sorties JSON effectivement parsées, jamais le nombre annoncé par le worker. */
  validatedPasses: 1 | 2;
};

export type PayrollAiProvenance = {
  fields: Record<string, number[]>;
  lines: Array<{
    /** Index de l'occurrence dans le brouillon final lorsqu'il est connu. */
    lineIndex?: number;
    label: string;
    kind: PayrollImportLineDraft['kind'];
    amountCents: number;
    pages: number[];
  }>;
  /** Alternatives réellement observées avec des pages exploitables. */
  conflicts?: PayrollAnalysisConflict[];
};

export type PayrollAiPageBatch = {
  pageStart: number;
  pageEnd: number;
  analysis: ReconciledPayrollAiDraft;
};

function payrollDraftFieldValueForProvenance(draft: PayrollImportDraft, field: string): string | number | undefined {
  switch (field) {
    case 'employee.name': return draft.employee.name;
    case 'employee.employee_number': return draft.employee.employeeNumber;
    case 'employee.role': return draft.employee.role;
    case 'employee.address': return draft.employee.addressLine1;
    case 'employee.birth_date': return draft.employee.birthDate;
    case 'employee.avs_number': return draft.employee.avsNumber;
    case 'employee.iban': return draft.employee.iban;
    case 'employee.employment_rate': return draft.employee.employmentRate;
    case 'employee.salary_mode': return draft.employee.salaryMode;
    case 'period': return draft.period;
    case 'payment_date': return draft.paymentDate;
    case 'gross_cents': return draft.grossCents;
    case 'net_cents': return draft.netCents;
    default: return undefined;
  }
}

function provenanceValuesMatch(field: string, left: string | number | undefined, right: string | number | undefined) {
  if (typeof left === 'number' || typeof right === 'number') {
    if (typeof left !== 'number' || typeof right !== 'number') return false;
    if ((field === 'gross_cents' || field === 'net_cents') && (left <= 0 || right <= 0)) return false;
    return left === right;
  }
  if (left === undefined || right === undefined) return false;
  if (!left.trim() || !right.trim()) return false;
  if (field === 'employee.avs_number') return normalizedDigits(left) === normalizedDigits(right);
  if (field === 'employee.iban') return normalizedIban(left) === normalizedIban(right);
  if (field === 'period' || field === 'payment_date' || field === 'employee.birth_date') return left.trim() === right.trim();
  return normalizedText(left) === normalizedText(right);
}

/**
 * Écarte toute indication de page dont la valeur IA n'est plus la valeur du
 * brouillon final (par exemple parce que le parseur ou l'humain a prévalu).
 */
export function payrollAiProvenanceForFinalDraft(
  finalDraft: PayrollImportDraft,
  aiDraft: PayrollImportDraft,
  provenance: PayrollAiProvenance,
): PayrollAiProvenance {
  const usedLineIndexes = new Set<number>();
  return {
    fields: Object.fromEntries(Object.entries(provenance.fields).filter(([field]) => (
      provenanceValuesMatch(
        field,
        payrollDraftFieldValueForProvenance(finalDraft, field),
        payrollDraftFieldValueForProvenance(aiDraft, field),
      )
    ))),
    lines: provenance.lines.flatMap((source) => {
      const lineIndex = finalDraft.lines.findIndex((line, index) => (
        !usedLineIndexes.has(index)
        && normalizedText(line.label) === normalizedText(source.label)
        && line.kind === source.kind
        && line.amountCents === source.amountCents
      ));
      if (lineIndex < 0) return [];
      usedLineIndexes.add(lineIndex);
      return [{ ...source, lineIndex, pages: [...source.pages] }];
    }),
    conflicts: provenance.conflicts?.map((conflict) => ({
      ...conflict,
      values: [...conflict.values],
      pages: [...conflict.pages],
      passIndexes: [...conflict.passIndexes],
    })),
  };
}

function recordValue(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}

const textValue = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const numberValue = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;

/**
 * Les montants du contrat IA sont des centimes entiers. SmolVLM restitue
 * toutefois parfois le montant imprimé (par exemple `CHF 6'500.00`) comme
 * chaîne. Cette conversion reste volontairement étroite et n'interprète
 * jamais une chaîne contenant un libellé ou une expression.
 */
function centsValue(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : 0;
  if (typeof value !== 'string') return 0;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const cents = Number(trimmed);
    return Number.isSafeInteger(cents) ? cents : 0;
  }
  const match = trimmed.match(/^(?:CHF\s*)?(\d{1,3}(?:['’\u00a0\u202f ]\d{3})+|\d+)(?:([.,])(\d{1,2}))?(?:\s*CHF)?$/i);
  if (!match) return 0;
  const francs = Number(match[1].replace(/['’\u00a0\u202f ]/g, ''));
  const fraction = match[3] ? Number(match[3].padEnd(2, '0')) : 0;
  const cents = francs * 100 + fraction;
  return Number.isSafeInteger(cents) ? cents : 0;
}

/**
 * Convertit uniquement la syntaxe de littéral objet fréquemment émise par le
 * petit modèle (`'texte'`, `True`, `False`, `None`) en JSON. Il ne s'agit pas
 * d'un évaluateur : aucun code, commentaire ou identifiant arbitraire n'est
 * exécuté. Une apostrophe intérieure (D'Amico, 6'500.00) reste du contenu.
 */
function pythonLiteralToJson(raw: string): string {
  let result = '';
  let quote: 'single' | 'double' | null = null;
  let escaped = false;
  let singleRawStart = -1;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (quote === 'double') {
      result += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quote = null;
      continue;
    }
    if (quote === 'single') {
      if (escaped) {
        result += character === '"' ? '\\"' : character;
        escaped = false;
        continue;
      }
      if (character === '\\') {
        result += '\\';
        escaped = true;
        continue;
      }
      if (character === "'") {
        let lookahead = index + 1;
        while (/\s/.test(raw[lookahead] ?? '')) lookahead += 1;
        const next = raw[lookahead] ?? '';
        if (!next || ':,}]'.includes(next)) {
          result += '"';
          quote = null;
          singleRawStart = -1;
        } else {
          result += "'";
        }
        continue;
      }
      // Le modèle observé en E2E utilise la même apostrophe pour ouvrir la
      // chaîne et comme séparateur de milliers, puis oublie parfois l'apostrophe
      // finale : `'6'500.00,`. Fermer implicitement uniquement un montant pur
      // à la virgule de propriété ou à l'accolade terminale.
      if ((character === ',' || character === '}') && singleRawStart >= 0) {
        const content = raw.slice(singleRawStart, index);
        if (/^(?:CHF\s*)?\d{1,3}(?:['’\u00a0\u202f ]\d{3})+(?:[.,]\d{1,2})$/.test(content)) {
          result += `"${character}`;
          quote = null;
          singleRawStart = -1;
          continue;
        }
      }
      if (character === '"') result += '\\"';
      else if (character === '\n') result += '\\n';
      else if (character === '\r') result += '\\r';
      else if (character === '\t') result += '\\t';
      else result += character;
      continue;
    }
    if (character === '"') {
      quote = 'double';
      result += character;
      continue;
    }
    if (character === "'") {
      quote = 'single';
      singleRawStart = index + 1;
      result += '"';
      continue;
    }
    const remainder = raw.slice(index);
    const token = remainder.match(/^(True|False|None)(?![A-Za-z0-9_])/);
    if (token && (index === 0 || !/[A-Za-z0-9_]/.test(raw[index - 1]))) {
      result += token[1] === 'True' ? 'true' : token[1] === 'False' ? 'false' : 'null';
      index += token[1].length - 1;
      continue;
    }
    result += character;
  }
  return result;
}

function completePayrollEnvelope(candidate: RecordValue): RecordValue | null {
  if (Object.keys(recordValue(candidate.employee)).length || Array.isArray(candidate.lines)) return candidate;
  const keys = Object.keys(candidate);
  const flatKeys = new Set(['employee_name', 'gross_cents', 'net_cents']);
  const isKnownPartial = keys.length === 3
    && keys.every((key) => flatKeys.has(key))
    && textValue(candidate.employee_name)
    && centsValue(candidate.gross_cents) > 0
    && centsValue(candidate.net_cents) > 0;
  if (!isKnownPartial) return null;
  return {
    employee: { name: candidate.employee_name },
    period: '',
    payment_date: '',
    gross_cents: candidate.gross_cents,
    net_cents: candidate.net_cents,
    lines: [],
    warnings: ['Sortie IA partielle normalisée : contrôlez le nom et les deux montants sur le document original.'],
  };
}

function pageNumbers(value: unknown): number[] {
  const values = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  return [...new Set(values
    .filter((item): item is number => typeof item === 'number' && Number.isInteger(item) && item >= 1 && item <= 200))]
    .sort((left, right) => left - right)
    .slice(0, 20);
}

function parseFieldPages(value: unknown): Record<string, number[]> {
  const fields = recordValue(value);
  const acceptedFields = new Set([
    'employee.name', 'employee.employee_number', 'employee.role', 'employee.address',
    'employee.birth_date', 'employee.avs_number', 'employee.iban',
    'employee.employment_rate', 'employee.salary_mode', 'period', 'payment_date',
    'gross_cents', 'net_cents',
  ]);
  return Object.fromEntries(Object.entries(fields)
    .map(([field, pages]) => [field.trim().slice(0, 80), pageNumbers(pages)] as const)
    .filter(([field, pages]) => acceptedFields.has(field) && pages.length));
}

function parseJsonObject(raw: string): RecordValue {
  const cleaned = raw.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const starts = [...cleaned.matchAll(/\{/g)].map((match) => match.index ?? 0).reverse();
  for (const start of starts) {
    for (let end = cleaned.lastIndexOf('}'); end > start; end = cleaned.lastIndexOf('}', end - 1)) {
      const rawCandidate = cleaned.slice(start, end + 1);
      for (const serialized of [rawCandidate, pythonLiteralToJson(rawCandidate)]) {
        try {
          const candidate = completePayrollEnvelope(recordValue(JSON.parse(serialized) as unknown));
          // Un objet imbriqué (par exemple `employee`) est lui aussi du JSON
          // valide. N'accepter que l'enveloppe complète évite de perdre toutes
          // les valeurs lors d'une lecture depuis la dernière accolade.
          if (candidate) return candidate;
        } catch {
          // Continue with the normalized form or previous closing brace.
        }
      }
    }
  }
  throw new Error("SmolVLM n'a pas renvoyé le JSON strict attendu. Relancez l'analyse ou saisissez les champs manuellement.");
}

/**
 * Parse la transcription sans transformer un champ IA absent en valeur métier.
 * Les valeurs de repli servent uniquement à garder un brouillon éditable; le
 * drapeau `detected` décide si elles peuvent remplacer le brouillon existant.
 */
export function parsePayrollAiJson(raw: string): ParsedPayrollAiDraft {
  const parsed = parseJsonObject(raw);
  const employee = recordValue(parsed.employee);
  const rawLines = Array.isArray(parsed.lines) ? parsed.lines.map(recordValue) : [];
  const acceptedKinds = new Set(['earning', 'deduction', 'reimbursement', 'non_gross_payment', 'employer']);
  const invalidKindCount = rawLines.filter((line) => !acceptedKinds.has(textValue(line.kind))).length;
  const lines = rawLines.filter((line) => acceptedKinds.has(textValue(line.kind)));
  const rawEmploymentRate = employee.employment_rate ?? employee.employmentRate;
  const employmentRate = numberValue(rawEmploymentRate);
  const rawSalaryMode = textValue(employee.salary_mode ?? employee.salaryMode);
  const detected = {
    employmentRate: employmentRate >= 1 && employmentRate <= 100,
    salaryMode: rawSalaryMode === 'monthly' || rawSalaryMode === 'hourly',
  };
  const parsedLines = lines.map((line): { draft: PayrollImportLineDraft; pages: number[] } => {
    const kind = textValue(line.kind);
    return {
      draft: {
        id: createId(),
        label: textValue(line.label),
        kind: kind === 'deduction' || kind === 'reimbursement' || kind === 'non_gross_payment' || kind === 'employer'
          ? kind === 'non_gross_payment' ? 'reimbursement' : kind
          : 'earning',
        amountCents: Math.max(0, centsValue(line.amount_cents ?? line.amountCents)),
        recurring: kind === 'earning' && line.recurring === true,
        confidenceBp: Math.min(10_000, Math.max(0, numberValue(line.confidence_bp ?? line.confidenceBp))),
      },
      pages: pageNumbers(line.source_pages ?? line.source_page ?? line.sourcePages ?? line.sourcePage),
    };
  }).filter(({ draft: line }) => line.label && line.amountCents > 0);
  if (parsedLines.length > 80) {
    throw new Error(`Le modèle a proposé ${parsedLines.length} rubriques; la limite contrôlable est de 80. Séparez le document au lieu d’ignorer silencieusement des lignes.`);
  }
  const draft: PayrollImportDraft = {
    employee: {
      employeeNumber: textValue(employee.employee_number ?? employee.employeeNumber),
      name: textValue(employee.name),
      role: textValue(employee.role),
      addressLine1: textValue(employee.address_line1 ?? employee.addressLine1),
      addressLine2: textValue(employee.address_line2 ?? employee.addressLine2),
      postalCode: textValue(employee.postal_code ?? employee.postalCode),
      city: textValue(employee.city),
      canton: textValue(employee.canton).toUpperCase(),
      birthDate: textValue(employee.birth_date ?? employee.birthDate),
      avsNumber: textValue(employee.avs_number ?? employee.avsNumber),
      iban: textValue(employee.iban).replace(/\s/g, '').toUpperCase(),
      employmentRate: detected.employmentRate ? employmentRate : 100,
      salaryMode: detected.salaryMode ? rawSalaryMode as PayrollImportEmployeeDraft['salaryMode'] : 'monthly',
    },
    period: textValue(parsed.period),
    paymentDate: textValue(parsed.payment_date ?? parsed.paymentDate),
    grossCents: Math.max(0, centsValue(parsed.gross_cents ?? parsed.grossCents)),
    netCents: Math.max(0, centsValue(parsed.net_cents ?? parsed.netCents)),
    lines: parsedLines.map(({ draft: line }) => line),
    warnings: [
      ...(Array.isArray(parsed.warnings) ? parsed.warnings.map(textValue).filter(Boolean).slice(0, 30) : []),
      ...(invalidKindCount ? [`${invalidKindCount} rubrique(s) avec une classification IA inconnue ont été écartées; contrôlez le document original.`] : []),
    ],
  };
  return {
    draft,
    detected,
    provenance: {
      fields: parseFieldPages(parsed.field_pages ?? parsed.fieldPages),
      lines: parsedLines.map(({ draft: line, pages }) => ({
        label: line.label,
        kind: line.kind,
        amountCents: line.amountCents,
        pages,
      })),
    },
  };
}

const normalizedText = (value: string) => value.toLocaleLowerCase('fr-CH').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
const normalizedDigits = (value: string) => value.replace(/\D/g, '');
const normalizedIban = (value: string) => value.replace(/\s/g, '').toUpperCase();
const stableLineHash = (value: string) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const PAYROLL_DRAFT_FIELDS = [
  'employee.employeeNumber', 'employee.name', 'employee.role',
  'employee.addressLine1', 'employee.addressLine2', 'employee.postalCode',
  'employee.city', 'employee.canton', 'employee.birthDate',
  'employee.avsNumber', 'employee.iban', 'employee.employmentRate',
  'employee.salaryMode', 'period', 'paymentDate', 'grossCents', 'netCents',
] as const;
type PayrollDraftField = typeof PAYROLL_DRAFT_FIELDS[number];

function draftFieldValues(draft: PayrollImportDraft): Record<PayrollDraftField, string | number> {
  return {
    'employee.employeeNumber': draft.employee.employeeNumber,
    'employee.name': draft.employee.name,
    'employee.role': draft.employee.role,
    'employee.addressLine1': draft.employee.addressLine1,
    'employee.addressLine2': draft.employee.addressLine2,
    'employee.postalCode': draft.employee.postalCode,
    'employee.city': draft.employee.city,
    'employee.canton': draft.employee.canton,
    'employee.birthDate': draft.employee.birthDate,
    'employee.avsNumber': draft.employee.avsNumber,
    'employee.iban': draft.employee.iban,
    'employee.employmentRate': draft.employee.employmentRate,
    'employee.salaryMode': draft.employee.salaryMode,
    period: draft.period,
    paymentDate: draft.paymentDate,
    grossCents: draft.grossCents,
    netCents: draft.netCents,
  };
}

function resetDraftField(draft: PayrollImportDraft, field: PayrollDraftField) {
  switch (field) {
    case 'employee.employeeNumber': draft.employee.employeeNumber = ''; break;
    case 'employee.name': draft.employee.name = ''; break;
    case 'employee.role': draft.employee.role = ''; break;
    case 'employee.addressLine1': draft.employee.addressLine1 = ''; break;
    case 'employee.addressLine2': draft.employee.addressLine2 = ''; break;
    case 'employee.postalCode': draft.employee.postalCode = ''; break;
    case 'employee.city': draft.employee.city = ''; break;
    case 'employee.canton': draft.employee.canton = ''; break;
    case 'employee.birthDate': draft.employee.birthDate = ''; break;
    case 'employee.avsNumber': draft.employee.avsNumber = ''; break;
    case 'employee.iban': draft.employee.iban = ''; break;
    case 'employee.employmentRate': draft.employee.employmentRate = 100; break;
    case 'employee.salaryMode': draft.employee.salaryMode = 'monthly'; break;
    case 'period': draft.period = ''; break;
    case 'paymentDate': draft.paymentDate = ''; break;
    case 'grossCents': draft.grossCents = 0; break;
    case 'netCents': draft.netCents = 0; break;
  }
}

function legacyPayrollLineKey(line: Pick<PayrollImportLineDraft, 'kind' | 'label'>) {
  const label = normalizedText(line.label);
  return label ? `${line.kind}:${label}` : '';
}

function payrollLineKey(line: Pick<PayrollImportLineDraft, 'id' | 'sourceRef' | 'kind' | 'label'>) {
  const sourceRef = line.sourceRef?.trim();
  if (sourceRef) return `source:${sourceRef}`;
  const id = line.id?.trim().replace(/[^A-Za-z0-9_-]/g, '');
  return id ? `line:${id}` : legacyPayrollLineKey(line);
}

function lineHasTrackedKey(keys: Set<string>, line: PayrollImportLineDraft) {
  return keys.has(payrollLineKey(line)) || keys.has(legacyPayrollLineKey(line));
}

function confirmedRecurringMatches(
  draft: PayrollImportDraft,
  line: PayrollImportLineDraft,
  confirmed: PayrollConfirmedRecurringLine,
) {
  const sameValue = confirmed.kind === 'earning'
    && confirmed.label === line.label
    && confirmed.amountCents === line.amountCents;
  if (!sameValue) return false;
  if (confirmed.lineId) return confirmed.lineId === line.id;
  return draft.lines.filter((candidate) => (
    candidate.kind === 'earning'
    && candidate.label === line.label
    && candidate.amountCents === line.amountCents
  )).length === 1;
}

function cloneReview(review: PayrollImportDraft['review']): PayrollImportDraft['review'] {
  if (!review) return undefined;
  return {
    ...review,
    aiIdentityEvidence: review.aiIdentityEvidence ? {
      ...review.aiIdentityEvidence,
      conflicts: [...review.aiIdentityEvidence.conflicts],
    } : undefined,
    aiFields: [...(review.aiFields ?? [])],
    aiLineKeys: [...(review.aiLineKeys ?? [])],
    aiWarnings: [...(review.aiWarnings ?? [])],
    manualFields: [...(review.manualFields ?? [])],
    manualLineKeys: [...(review.manualLineKeys ?? [])],
    suppressedLineKeys: [...(review.suppressedLineKeys ?? [])],
    confirmedRecurringLines: (review.confirmedRecurringLines ?? []).map((line) => ({ ...line })),
  };
}

function clonePayrollDraft(draft: PayrollImportDraft): PayrollImportDraft {
  return {
    ...draft,
    employee: { ...draft.employee },
    lines: draft.lines.map((line) => ({ ...line })),
    warnings: [...draft.warnings],
    review: cloneReview(draft.review),
  };
}

function isAiPipelineWarning(warning: string) {
  const normalized = warning.toLocaleLowerCase('fr-CH');
  return normalized.includes('deux passages du même modèle')
    || normalized.includes('double lecture')
    || normalized.includes('provenance ia')
    || normalized.includes('indication de page ia')
    || normalized.includes('indications de pages ia')
    || normalized.includes('conflit entre pages')
    || normalized.includes('rattachement automatique désactivé')
    || normalized.includes('numéros de page proposés par l’ia')
    || normalized.includes('lu par l’ia')
    || normalized.includes('l’ia n’a pas fourni')
    || normalized.includes('rubrique(s) n’ont pas concordé')
    || normalized.includes('montant contradictoire pour')
    || normalized.includes('occurrence supplémentaire ou montant différent')
    || normalized.includes('apparaît sur plusieurs pages ou occurrences')
    || normalized.includes('la provenance ia précédente a été retirée');
}

/**
 * Enregistre uniquement les changements de contenu réellement effectués dans
 * le formulaire. Cette source explicite permet aux relances de remplacer les
 * anciennes propositions IA sans perdre les valeurs humaines.
 */
export function recordPayrollManualChanges(
  previous: PayrollImportDraft,
  candidate: PayrollImportDraft,
): { draft: PayrollImportDraft; contentChanged: boolean } {
  const draft = clonePayrollDraft(candidate);
  const previousReview = cloneReview(previous.review);
  const candidateReview = cloneReview(candidate.review);
  const review = {
    employeeId: '',
    employeeLinkSource: '' as const,
    ...previousReview,
    ...candidateReview,
  };
  const manualFields = new Set(review.manualFields ?? []);
  const aiFields = new Set(review.aiFields ?? []);
  const manualLineKeys = new Set(review.manualLineKeys ?? []);
  const aiLineKeys = new Set(review.aiLineKeys ?? []);
  const suppressedLineKeys = new Set(review.suppressedLineKeys ?? []);
  let confirmedRecurringLines = (review.confirmedRecurringLines ?? []).map((line) => ({ ...line }));
  const beforeValues = draftFieldValues(previous);
  const afterValues = draftFieldValues(draft);
  let contentChanged = false;

  for (const field of PAYROLL_DRAFT_FIELDS) {
    if (beforeValues[field] === afterValues[field]) continue;
    contentChanged = true;
    manualFields.add(field);
    aiFields.delete(field);
  }

  const beforeById = new Map(previous.lines.map((line) => [line.id, line]));
  const afterIds = new Set(draft.lines.map((line) => line.id));
  draft.lines = draft.lines.map((line) => {
    const before = beforeById.get(line.id);
    const evidenceChanged = !before
      || before.label !== line.label
      || before.kind !== line.kind
      || before.amountCents !== line.amountCents;
    const beforeWasConfirmed = Boolean(before && (previousReview?.confirmedRecurringLines ?? [])
      .some((confirmed) => confirmedRecurringMatches(previous, before, confirmed)));
    const isNowConfirmed = (candidateReview?.confirmedRecurringLines ?? [])
      .some((confirmed) => confirmedRecurringMatches(candidate, line, confirmed));
    const humanMetadataChanged = Boolean(before
      && (before.recurring !== line.recurring
        || before.confidenceBp !== line.confidenceBp
        || beforeWasConfirmed !== isNowConfirmed));
    if (!evidenceChanged && !humanMetadataChanged) return line;
    if (evidenceChanged) contentChanged = true;
    const beforeKey = before ? payrollLineKey(before) : '';
    if (before) {
      confirmedRecurringLines = confirmedRecurringLines
        .filter((confirmed) => !confirmedRecurringMatches(previous, before, confirmed));
    }
    const next = {
      ...line,
      // Une correction de contenu devient une ligne humaine distincte. La
      // référence OCR précédente reste dans suppressedLineKeys pour que seule
      // cette occurrence ne soit pas recréée à la relance.
      sourceRef: evidenceChanged ? undefined : line.sourceRef,
      // Cocher « Récurrent » confirme une métadonnée humaine, pas une
      // nouvelle lecture du document. Le score de traçabilité ne doit donc
      // passer à 100/100 que si le contenu analysé de la rubrique change.
      confidenceBp: evidenceChanged ? 10_000 : (before?.confidenceBp ?? line.confidenceBp),
    };
    const nextKey = payrollLineKey(next);
    if (beforeKey) {
      aiLineKeys.delete(beforeKey);
      aiLineKeys.delete(legacyPayrollLineKey(before!));
      manualLineKeys.delete(beforeKey);
      manualLineKeys.delete(legacyPayrollLineKey(before!));
      if (evidenceChanged || beforeKey !== nextKey) suppressedLineKeys.add(beforeKey);
    }
    if (nextKey) {
      aiLineKeys.delete(nextKey);
      manualLineKeys.add(nextKey);
      suppressedLineKeys.delete(nextKey);
    }
    if ((beforeWasConfirmed || isNowConfirmed) && next.kind === 'earning' && next.recurring && next.amountCents > 0) {
      confirmedRecurringLines.push({ lineId: next.id, label: next.label, kind: 'earning', amountCents: next.amountCents });
    }
    return next;
  });
  for (const line of previous.lines) {
    if (afterIds.has(line.id)) continue;
    contentChanged = true;
    const key = payrollLineKey(line);
    if (!key) continue;
    confirmedRecurringLines = confirmedRecurringLines
      .filter((confirmed) => !confirmedRecurringMatches(previous, line, confirmed));
    aiLineKeys.delete(key);
    aiLineKeys.delete(legacyPayrollLineKey(line));
    manualLineKeys.delete(key);
    manualLineKeys.delete(legacyPayrollLineKey(line));
    suppressedLineKeys.add(key);
  }

  draft.review = {
    ...review,
    aiFields: [...aiFields],
    aiLineKeys: [...aiLineKeys],
    manualFields: [...manualFields],
    manualLineKeys: [...manualLineKeys],
    suppressedLineKeys: [...suppressedLineKeys],
    confirmedRecurringLines,
  };
  return { draft, contentChanged };
}

/** Retire les seules valeurs attribuées à la précédente exécution IA. */
export function preparePayrollDraftForAiRerun(current: PayrollImportDraft): PayrollImportDraft {
  const draft = clonePayrollDraft(current);
  const review = cloneReview(draft.review);
  const manualFields = new Set(review?.manualFields ?? []);
  for (const field of review?.aiFields ?? []) {
    if (!manualFields.has(field) && PAYROLL_DRAFT_FIELDS.includes(field as PayrollDraftField)) {
      resetDraftField(draft, field as PayrollDraftField);
    }
  }
  const aiLineKeys = new Set(review?.aiLineKeys ?? []);
  const manualLineKeys = new Set(review?.manualLineKeys ?? []);
  draft.lines = draft.lines.filter((line) => {
    const key = payrollLineKey(line);
    return !key || !lineHasTrackedKey(aiLineKeys, line) || lineHasTrackedKey(manualLineKeys, line);
  });
  const priorAiWarnings = new Set(review?.aiWarnings ?? []);
  draft.warnings = draft.warnings.filter((warning) => (
    !priorAiWarnings.has(warning) && !isAiPipelineWarning(warning)
  ));
  if (review) {
    draft.review = {
      ...review,
      aiIdentityEvidence: undefined,
      aiFields: [],
      aiLineKeys: [],
      aiWarnings: [],
    };
  }
  return draft;
}

/** Remplace l'inventaire des contributions IA par celui de cette exécution. */
export function markPayrollAiContributions(
  base: PayrollImportDraft,
  merged: PayrollImportDraft,
): PayrollImportDraft {
  const draft = clonePayrollDraft(merged);
  const manualFields = new Set(draft.review?.manualFields ?? []);
  const beforeValues = draftFieldValues(base);
  const afterValues = draftFieldValues(draft);
  const aiFields = PAYROLL_DRAFT_FIELDS.filter((field) => (
    beforeValues[field] !== afterValues[field] && !manualFields.has(field)
  ));
  const usedBaseIndexes = new Set<number>();
  const manualLineKeys = new Set(draft.review?.manualLineKeys ?? []);
  const aiLineKeys = [...new Set(draft.lines
    .filter((line) => {
      const key = payrollLineKey(line);
      if (!key || lineHasTrackedKey(manualLineKeys, line)) return false;
      const baseIndex = base.lines.findIndex((candidate, index) => (
        !usedBaseIndexes.has(index)
        && candidate.kind === line.kind
        && normalizedText(candidate.label) === normalizedText(line.label)
        && candidate.amountCents === line.amountCents
      ));
      if (baseIndex >= 0) {
        usedBaseIndexes.add(baseIndex);
        return false;
      }
      return true;
    })
    .map(payrollLineKey))];
  const baseWarnings = new Set(base.warnings);
  const aiWarnings = draft.warnings.filter((warning) => !baseWarnings.has(warning));
  draft.review = {
    employeeId: '',
    employeeLinkSource: '',
    ...draft.review,
    aiFields,
    aiLineKeys,
    aiWarnings,
  };
  return draft;
}

function consensusText(
  label: string,
  primary: string,
  verified: string,
  normalize: (value: string) => string,
  warnings: string[],
  conflicts?: string[],
) {
  const first = normalize(primary);
  const second = normalize(verified);
  if (first && second && first === second) return verified.trim();
  if (first || second) {
    warnings.push(`Deux passages du même modèle : « ${label} » n’est pas restitué de façon identique; vérifiez le document original.`);
    conflicts?.push(label);
  }
  return '';
}

/**
 * Réconcilie deux passages déterministes du même modèle. Les champs d'identité,
 * dates, totaux et rubriques ne deviennent des valeurs IA fortes que lorsque
 * les deux sorties concordent; la couche texte existante reste ensuite
 * prioritaire dans mergePayrollImportDraft.
 */
export function reconcilePayrollAiPasses(primaryRaw: string, verifiedRaw: string): ReconciledPayrollAiDraft {
  let primary: ParsedPayrollAiDraft | null = null;
  let verified: ParsedPayrollAiDraft | null = null;
  let primaryError: unknown;
  let verifiedError: unknown;
  try { primary = parsePayrollAiJson(primaryRaw); } catch (reason) { primaryError = reason; }
  try { verified = parsePayrollAiJson(verifiedRaw); } catch (reason) { verifiedError = reason; }

  if (!primary && !verified) throw verifiedError ?? primaryError ?? new Error("Les deux passages locaux du modèle sont inexploitables.");
  if (!primary || !verified) {
    const single = primary ?? verified!;
    return {
      draft: {
        ...single.draft,
        employee: { ...single.draft.employee },
        lines: single.draft.lines.map((line) => ({ ...line, recurring: false, confidenceBp: Math.min(4_999, line.confidenceBp) })),
        warnings: [...new Set([...single.draft.warnings, 'Un seul des deux passages du même modèle est exploitable : toutes les valeurs restent des propositions faibles et aucun collaborateur ne sera associé automatiquement.'])],
      },
      detected: { employmentRate: false, salaryMode: false },
      provenance: single.provenance,
      identity: { passes: 1, employeeNumber: '', avsNumber: '', birthDate: '', iban: '', conflicts: [] },
      validatedPasses: 1,
    };
  }

  const warnings = [...new Set([...primary.draft.warnings, ...verified.draft.warnings])];
  const identityConflicts: string[] = [];
  const analysisConflicts: PayrollAnalysisConflict[] = [];
  const recordPassConflict = (
    target: string,
    first: string,
    second: string,
    normalize: (value: string) => string,
  ) => {
    const normalizedFirst = normalize(first);
    const normalizedSecond = normalize(second);
    const firstPages = primary.provenance.fields[target] ?? [];
    const secondPages = verified.provenance.fields[target] ?? [];
    if (
      !normalizedFirst
      || !normalizedSecond
      || normalizedFirst === normalizedSecond
      || !firstPages.length
      || !secondPages.length
    ) return;
    analysisConflicts.push({
      target,
      values: [first.trim(), second.trim()],
      pages: [...new Set([...firstPages, ...secondPages])].sort((left, right) => left - right),
      passIndexes: [1, 2],
    });
  };
  const consensusFieldText = (
    target: string,
    label: string,
    first: string,
    second: string,
    normalize: (value: string) => string = normalizedText,
    identity?: string[],
  ) => {
    recordPassConflict(target, first, second, normalize);
    return consensusText(label, first, second, normalize, warnings, identity);
  };
  const employeeNumber = consensusFieldText('employee.employee_number', 'numéro employé', primary.draft.employee.employeeNumber, verified.draft.employee.employeeNumber, normalizedText, identityConflicts);
  const avsNumber = consensusFieldText('employee.avs_number', 'numéro AVS', primary.draft.employee.avsNumber, verified.draft.employee.avsNumber, normalizedDigits, identityConflicts);
  const birthDate = consensusFieldText('employee.birth_date', 'date de naissance', primary.draft.employee.birthDate, verified.draft.employee.birthDate, (value) => value.trim(), identityConflicts);
  const iban = consensusFieldText('employee.iban', 'IBAN employé', primary.draft.employee.iban, verified.draft.employee.iban, normalizedIban, identityConflicts);
  const pickEmployeeText = (target: string, label: string, first: string, second: string) => consensusFieldText(target, label, first, second);
  const employmentRateAgrees = primary.detected.employmentRate
    && verified.detected.employmentRate
    && primary.draft.employee.employmentRate === verified.draft.employee.employmentRate;
  const salaryModeAgrees = primary.detected.salaryMode
    && verified.detected.salaryMode
    && primary.draft.employee.salaryMode === verified.draft.employee.salaryMode;
  if ((primary.detected.employmentRate || verified.detected.employmentRate) && !employmentRateAgrees) {
    if (primary.detected.employmentRate && verified.detected.employmentRate) {
      recordPassConflict('employee.employment_rate', String(primary.draft.employee.employmentRate), String(verified.draft.employee.employmentRate), (value) => value);
    }
    warnings.push('Deux passages du même modèle : le taux d’activité diffère ou manque dans un passage; confirmez-le manuellement.');
  }
  if ((primary.detected.salaryMode || verified.detected.salaryMode) && !salaryModeAgrees) {
    if (primary.detected.salaryMode && verified.detected.salaryMode) {
      recordPassConflict('employee.salary_mode', primary.draft.employee.salaryMode, verified.draft.employee.salaryMode, (value) => value);
    }
    warnings.push('Deux passages du même modèle : le mode de salaire diffère ou manque dans un passage; confirmez-le manuellement.');
  }

  const period = consensusFieldText('period', 'période salariale', primary.draft.period, verified.draft.period, (value) => value.trim());
  const paymentDate = consensusFieldText('payment_date', 'date de paiement', primary.draft.paymentDate, verified.draft.paymentDate, (value) => value.trim());
  const amountConsensus = (target: 'gross_cents' | 'net_cents', label: string, first: number, second: number) => {
    if (first > 0 && second > 0 && first === second) return second;
    if (first || second) {
      recordPassConflict(target, first ? String(first) : '', second ? String(second) : '', (value) => value);
      warnings.push(`Deux passages du même modèle : le ${label} imprimé diffère ou manque dans un passage; contrôlez le montant.`);
    }
    return 0;
  };

  const usedVerified = new Set<number>();
  const matchedLinePairs: Array<{ primaryIndex: number; verifiedIndex: number }> = [];
  const lines: PayrollImportLineDraft[] = [];
  for (const [primaryIndex, first] of primary.draft.lines.entries()) {
    const index = verified.draft.lines.findIndex((second, candidateIndex) => !usedVerified.has(candidateIndex)
      && normalizedText(second.label) === normalizedText(first.label)
      && second.kind === first.kind
      && second.amountCents === first.amountCents);
    if (index < 0) continue;
    usedVerified.add(index);
    matchedLinePairs.push({ primaryIndex, verifiedIndex: index });
    const second = verified.draft.lines[index];
    lines.push({
      ...second,
      id: createId(),
      recurring: second.kind === 'earning' && first.recurring && second.recurring,
      confidenceBp: Math.min(first.confidenceBp, second.confidenceBp),
    });
  }
  const unmatched = primary.draft.lines.length + verified.draft.lines.length - lines.length * 2;
  if (unmatched > 0) warnings.push(`${unmatched} rubrique(s) diffèrent entre les deux passages du même modèle et n’ont pas été ajoutées automatiquement.`);

  const provenanceFields: Record<string, number[]> = {};
  for (const field of new Set([...Object.keys(primary.provenance.fields), ...Object.keys(verified.provenance.fields)])) {
    const firstPages = primary.provenance.fields[field] ?? [];
    const secondPages = verified.provenance.fields[field] ?? [];
    const agreedPages = firstPages.filter((page) => secondPages.includes(page));
    if (agreedPages.length) provenanceFields[field] = agreedPages;
    else if (firstPages.length || secondPages.length) warnings.push(`Deux passages du même modèle : l’indication de page de « ${field} » diffère; contrôlez le document original.`);
  }
  const unsourcedLineLabels: string[] = [];
  const provenanceLines = lines.map((line, lineIndex) => {
    const pair = matchedLinePairs[lineIndex];
    const firstPages = primary.provenance.lines[pair.primaryIndex]?.pages ?? [];
    const secondPages = verified.provenance.lines[pair.verifiedIndex]?.pages ?? [];
    const agreedPages = firstPages.filter((page) => secondPages.includes(page));
    if (!agreedPages.length) unsourcedLineLabels.push(line.label);
    return { label: line.label, kind: line.kind, amountCents: line.amountCents, pages: agreedPages };
  });
  if (unsourcedLineLabels.length) {
    const preview = unsourcedLineLabels.slice(0, 6).map((label) => `« ${label} »`).join(', ');
    const remainder = unsourcedLineLabels.length > 6 ? ` et ${unsourcedLineLabels.length - 6} autre(s)` : '';
    warnings.push(`Deux passages du même modèle : aucune indication de page concordante pour ${preview}${remainder}; ces rubriques restent des propositions faibles.`);
  }

  const linesWithEvidence = lines.map((line, index) => {
    const source = provenanceLines[index];
    return source?.pages.length
      ? line
      : { ...line, recurring: false, confidenceBp: Math.min(4_999, line.confidenceBp) };
  });

  const identityProvenance = [
    [employeeNumber, 'employee.employee_number', 'numéro employé'],
    [avsNumber, 'employee.avs_number', 'numéro AVS'],
    [birthDate, 'employee.birth_date', 'date de naissance'],
    [iban, 'employee.iban', 'IBAN employé'],
  ] as const;
  const identityWithoutSource = identityProvenance
    .filter(([value, field]) => Boolean(value) && !(provenanceFields[field]?.length))
    .map(([, , label]) => label);
  if (identityWithoutSource.length) {
    warnings.push(`Rattachement automatique désactivé : indication de page non concordante pour ${identityWithoutSource.join(', ')}.`);
  }

  for (const [valuePresent, field, label] of [
    [Boolean(period), 'period', 'période'],
    [primary.draft.grossCents > 0 && verified.draft.grossCents > 0, 'gross_cents', 'brut imprimé'],
    [primary.draft.netCents > 0 && verified.draft.netCents > 0, 'net_cents', 'net imprimé'],
  ] as const) {
    if (valuePresent && !(provenanceFields[field]?.length)) {
      warnings.push(`Deux passages du même modèle : l’indication de page du ${label} diffère; comparez la valeur au document original.`);
    }
  }

  return {
    draft: {
      employee: {
        employeeNumber,
        name: pickEmployeeText('employee.name', 'nom du collaborateur', primary.draft.employee.name, verified.draft.employee.name),
        role: pickEmployeeText('employee.role', 'fonction', primary.draft.employee.role, verified.draft.employee.role),
        addressLine1: pickEmployeeText('employee.address', 'adresse', primary.draft.employee.addressLine1, verified.draft.employee.addressLine1),
        addressLine2: consensusText('complément d’adresse', primary.draft.employee.addressLine2, verified.draft.employee.addressLine2, normalizedText, warnings),
        postalCode: consensusText('NPA', primary.draft.employee.postalCode, verified.draft.employee.postalCode, normalizedText, warnings),
        city: consensusText('localité', primary.draft.employee.city, verified.draft.employee.city, normalizedText, warnings),
        canton: consensusText('canton', primary.draft.employee.canton, verified.draft.employee.canton, normalizedText, warnings).toUpperCase(),
        birthDate,
        avsNumber,
        iban: normalizedIban(iban),
        employmentRate: employmentRateAgrees ? verified.draft.employee.employmentRate : 100,
        salaryMode: salaryModeAgrees ? verified.draft.employee.salaryMode : 'monthly',
      },
      period,
      paymentDate,
      grossCents: amountConsensus('gross_cents', 'brut', primary.draft.grossCents, verified.draft.grossCents),
      netCents: amountConsensus('net_cents', 'net', primary.draft.netCents, verified.draft.netCents),
      lines: linesWithEvidence,
      warnings: [...new Set(warnings)],
    },
    detected: { employmentRate: employmentRateAgrees, salaryMode: salaryModeAgrees },
    provenance: { fields: provenanceFields, lines: provenanceLines, conflicts: analysisConflicts },
    identity: { passes: identityWithoutSource.length ? 1 : 2, employeeNumber: identityWithoutSource.length ? '' : employeeNumber, avsNumber: identityWithoutSource.length ? '' : avsNumber, birthDate: identityWithoutSource.length ? '' : birthDate, iban: identityWithoutSource.length ? '' : normalizedIban(iban), conflicts: identityConflicts },
    validatedPasses: 2,
  };
}

function emptyPayrollDraft(): PayrollImportDraft {
  return {
    employee: {
      employeeNumber: '', name: '', role: '', addressLine1: '', addressLine2: '', postalCode: '', city: '', canton: '', birthDate: '', avsNumber: '', iban: '',
      employmentRate: 100,
      salaryMode: 'monthly',
    },
    period: '', paymentDate: '', grossCents: 0, netCents: 0, lines: [], warnings: [],
  };
}

function pageRangeLabel(start: number, end: number) {
  return start === end ? `page ${start}` : `pages ${start}–${end}`;
}

/**
 * Assemble des lots visuels de trois pages maximum sans perdre les conflits
 * inter-pages. Une valeur contradictoire est vidée plutôt que choisie au
 * hasard; sa provenance reste visible dans les avertissements persistés.
 */
export function combinePayrollAiPageBatches(batches: PayrollAiPageBatch[]): ReconciledPayrollAiDraft {
  if (!batches.length) throw new Error('Aucun lot de pages n’a été analysé.');
  const draft = emptyPayrollDraft();
  const detected = { employmentRate: false, salaryMode: false };
  const provenance: PayrollAiProvenance = { fields: {}, lines: [], conflicts: [] };
  const identity: PayrollAiIdentityEvidence = { passes: 0, employeeNumber: '', avsNumber: '', birthDate: '', iban: '', conflicts: [] };
  let validatedPasses: 1 | 2 = 2;
  const conflicts = new Set<string>();
  const structuredConflictTargets = new Set<string>();
  const currentFieldPages = new Map<string, number[]>();
  const currentFieldPasses = new Map<string, 1 | 2>();
  const repeatedLineKeys = new Set<string>();
  const warnings: string[] = [];
  const fieldLabels = new Map<string, string>([
    ['employee.employee_number', 'numéro employé'],
    ['employee.name', 'nom du collaborateur'],
    ['employee.role', 'fonction'],
    ['employee.address', 'adresse'],
    ['employee.birth_date', 'date de naissance'],
    ['employee.avs_number', 'numéro AVS'],
    ['employee.iban', 'IBAN employé'],
    ['employee.employment_rate', 'taux d’activité'],
    ['employee.salary_mode', 'mode de salaire'],
    ['period', 'période salariale'],
    ['payment_date', 'date de paiement'],
    ['gross_cents', 'brut'],
    ['net_cents', 'net'],
  ]);
  const clearConflictingTarget = (target: string) => {
    switch (target) {
      case 'employee.employee_number': draft.employee.employeeNumber = ''; break;
      case 'employee.name': draft.employee.name = ''; break;
      case 'employee.role': draft.employee.role = ''; break;
      case 'employee.address': draft.employee.addressLine1 = ''; break;
      case 'employee.birth_date': draft.employee.birthDate = ''; break;
      case 'employee.avs_number': draft.employee.avsNumber = ''; break;
      case 'employee.iban': draft.employee.iban = ''; break;
      case 'employee.employment_rate':
        draft.employee.employmentRate = 100;
        detected.employmentRate = false;
        break;
      case 'employee.salary_mode':
        draft.employee.salaryMode = 'monthly';
        detected.salaryMode = false;
        break;
      case 'period': draft.period = ''; break;
      case 'payment_date': draft.paymentDate = ''; break;
      case 'gross_cents': draft.grossCents = 0; break;
      case 'net_cents': draft.netCents = 0; break;
      default: break;
    }
  };
  const registerStructuredConflict = (conflict: PayrollAnalysisConflict) => {
    const target = conflict.target;
    structuredConflictTargets.add(target);
    const label = fieldLabels.get(target);
    if (label) conflicts.add(label);
    delete provenance.fields[target];
    currentFieldPages.delete(target);
    currentFieldPasses.delete(target);
    clearConflictingTarget(target);
    if (provenance.conflicts?.some((existing) => existing.target === target)) return;
    provenance.conflicts?.push({
      ...conflict,
      values: [...conflict.values],
      pages: [...new Set(conflict.pages)].sort((left, right) => left - right),
      passIndexes: [...new Set(conflict.passIndexes)].sort((left, right) => left - right),
    });
  };
  const registerInterBatchConflict = (
    target: string | undefined,
    current: string,
    candidate: string,
    candidatePages: number[],
    candidatePasses: 1 | 2,
  ) => {
    if (!target) return;
    structuredConflictTargets.add(target);
    delete provenance.fields[target];
    const existingPages = currentFieldPages.get(target) ?? [];
    const existingPasses = currentFieldPasses.get(target) ?? candidatePasses;
    if (current.trim() && candidate.trim() && existingPages.length && candidatePages.length) {
      registerStructuredConflict({
        target,
        values: [current.trim(), candidate.trim()],
        pages: [...new Set([...existingPages, ...candidatePages])],
        passIndexes: Math.min(existingPasses, candidatePasses) >= 2 ? [1, 2] : [1],
      });
    } else {
      currentFieldPages.delete(target);
      currentFieldPasses.delete(target);
    }
  };
  const retainCurrentFieldEvidence = (
    target: string | undefined,
    candidatePages: number[],
    candidatePasses: 1 | 2,
  ) => {
    if (!target || structuredConflictTargets.has(target) || !candidatePages.length) return;
    currentFieldPages.set(target, [...new Set([...(currentFieldPages.get(target) ?? []), ...candidatePages])].sort((left, right) => left - right));
    currentFieldPasses.set(target, Math.min(currentFieldPasses.get(target) ?? candidatePasses, candidatePasses) as 1 | 2);
  };

  const mergeText = (
    label: string,
    current: string,
    candidate: string,
    normalize: (value: string) => string = normalizedText,
    target?: string,
    candidatePages: number[] = [],
    candidatePasses: 1 | 2 = 1,
  ) => {
    if (conflicts.has(label)) return '';
    if (!candidate.trim()) return current;
    if (!current.trim()) {
      retainCurrentFieldEvidence(target, candidatePages, candidatePasses);
      return candidate.trim();
    }
    if (normalize(current) === normalize(candidate)) {
      retainCurrentFieldEvidence(target, candidatePages, candidatePasses);
      return current;
    }
    conflicts.add(label);
    registerInterBatchConflict(target, current, candidate, candidatePages, candidatePasses);
    warnings.push(`Conflit entre pages pour « ${label} » : aucune valeur n’a été retenue automatiquement.`);
    return '';
  };
  const mergeAmount = (
    target: 'gross_cents' | 'net_cents',
    label: string,
    current: number,
    candidate: number,
    candidatePages: number[],
    candidatePasses: 1 | 2,
  ) => {
    if (conflicts.has(label)) return 0;
    if (!candidate) return current;
    if (!current) {
      retainCurrentFieldEvidence(target, candidatePages, candidatePasses);
      return candidate;
    }
    if (current === candidate) {
      retainCurrentFieldEvidence(target, candidatePages, candidatePasses);
      return current;
    }
    conflicts.add(label);
    registerInterBatchConflict(target, String(current), String(candidate), candidatePages, candidatePasses);
    warnings.push(`Conflit entre pages pour le ${label} imprimé : aucune valeur n’a été retenue automatiquement.`);
    return 0;
  };

  for (const batch of batches) {
    const analysis = batch.analysis;
    validatedPasses = Math.min(validatedPasses, analysis.validatedPasses) as 1 | 2;
    const pageLabel = pageRangeLabel(batch.pageStart, batch.pageEnd);
    warnings.push(...analysis.draft.warnings.map((warning) => `${pageLabel} · ${warning}`));
    const pagesForField = (field: string) => [...new Set((analysis.provenance.fields[field] ?? [])
      .filter((page) => page >= batch.pageStart && page <= batch.pageEnd))]
      .sort((left, right) => left - right);
    for (const conflict of analysis.provenance.conflicts ?? []) {
      if (conflict.pages.length && conflict.pages.every((page) => page >= batch.pageStart && page <= batch.pageEnd)) {
        registerStructuredConflict(conflict);
      }
    }
    const fieldsBefore = Object.keys(provenance.fields).length;
    for (const [field, pages] of Object.entries(analysis.provenance.fields)) {
      if (structuredConflictTargets.has(field)) continue;
      const inRange = pages.filter((page) => page >= batch.pageStart && page <= batch.pageEnd);
      if (inRange.length) provenance.fields[field] = [...new Set([...(provenance.fields[field] ?? []), ...inRange])].sort((a, b) => a - b);
    }
    if (Object.keys(analysis.provenance.fields).length && Object.keys(provenance.fields).length === fieldsBefore) {
      warnings.push(`${pageLabel} · les numéros de page proposés par l’IA étaient hors du lot et ont été écartés.`);
    }

    const candidate = analysis.draft;
    draft.employee.employeeNumber = mergeText('numéro employé', draft.employee.employeeNumber, candidate.employee.employeeNumber, normalizedText, 'employee.employee_number', pagesForField('employee.employee_number'), analysis.validatedPasses);
    draft.employee.name = mergeText('nom du collaborateur', draft.employee.name, candidate.employee.name, normalizedText, 'employee.name', pagesForField('employee.name'), analysis.validatedPasses);
    draft.employee.role = mergeText('fonction', draft.employee.role, candidate.employee.role, normalizedText, 'employee.role', pagesForField('employee.role'), analysis.validatedPasses);
    draft.employee.addressLine1 = mergeText('adresse', draft.employee.addressLine1, candidate.employee.addressLine1, normalizedText, 'employee.address', pagesForField('employee.address'), analysis.validatedPasses);
    draft.employee.addressLine2 = mergeText('complément d’adresse', draft.employee.addressLine2, candidate.employee.addressLine2);
    draft.employee.postalCode = mergeText('NPA', draft.employee.postalCode, candidate.employee.postalCode);
    draft.employee.city = mergeText('localité', draft.employee.city, candidate.employee.city);
    draft.employee.canton = mergeText('canton', draft.employee.canton, candidate.employee.canton);
    draft.employee.birthDate = mergeText('date de naissance', draft.employee.birthDate, candidate.employee.birthDate, (value) => value.trim(), 'employee.birth_date', pagesForField('employee.birth_date'), analysis.validatedPasses);
    draft.employee.avsNumber = mergeText('numéro AVS', draft.employee.avsNumber, candidate.employee.avsNumber, normalizedDigits, 'employee.avs_number', pagesForField('employee.avs_number'), analysis.validatedPasses);
    draft.employee.iban = mergeText('IBAN employé', draft.employee.iban, candidate.employee.iban, normalizedIban, 'employee.iban', pagesForField('employee.iban'), analysis.validatedPasses);
    draft.period = mergeText('période salariale', draft.period, candidate.period, (value) => value.trim(), 'period', pagesForField('period'), analysis.validatedPasses);
    draft.paymentDate = mergeText('date de paiement', draft.paymentDate, candidate.paymentDate, (value) => value.trim(), 'payment_date', pagesForField('payment_date'), analysis.validatedPasses);
    draft.grossCents = mergeAmount('gross_cents', 'brut', draft.grossCents, candidate.grossCents, pagesForField('gross_cents'), analysis.validatedPasses);
    draft.netCents = mergeAmount('net_cents', 'net', draft.netCents, candidate.netCents, pagesForField('net_cents'), analysis.validatedPasses);

    if (analysis.detected.employmentRate && !conflicts.has('taux d’activité')) {
      if (!detected.employmentRate) {
        draft.employee.employmentRate = candidate.employee.employmentRate;
        detected.employmentRate = true;
        retainCurrentFieldEvidence('employee.employment_rate', pagesForField('employee.employment_rate'), analysis.validatedPasses);
      } else if (draft.employee.employmentRate !== candidate.employee.employmentRate) {
        const currentValue = draft.employee.employmentRate;
        detected.employmentRate = false;
        draft.employee.employmentRate = 100;
        conflicts.add('taux d’activité');
        registerInterBatchConflict('employee.employment_rate', String(currentValue), String(candidate.employee.employmentRate), pagesForField('employee.employment_rate'), analysis.validatedPasses);
        warnings.push('Conflit entre pages pour le taux d’activité; confirmez-le manuellement.');
      } else {
        retainCurrentFieldEvidence('employee.employment_rate', pagesForField('employee.employment_rate'), analysis.validatedPasses);
      }
    }
    if (analysis.detected.salaryMode && !conflicts.has('mode de salaire')) {
      if (!detected.salaryMode) {
        draft.employee.salaryMode = candidate.employee.salaryMode;
        detected.salaryMode = true;
        retainCurrentFieldEvidence('employee.salary_mode', pagesForField('employee.salary_mode'), analysis.validatedPasses);
      } else if (draft.employee.salaryMode !== candidate.employee.salaryMode) {
        const currentValue = draft.employee.salaryMode;
        detected.salaryMode = false;
        draft.employee.salaryMode = 'monthly';
        conflicts.add('mode de salaire');
        registerInterBatchConflict('employee.salary_mode', currentValue, candidate.employee.salaryMode, pagesForField('employee.salary_mode'), analysis.validatedPasses);
        warnings.push('Conflit entre pages pour le mode de salaire; confirmez-le manuellement.');
      } else {
        retainCurrentFieldEvidence('employee.salary_mode', pagesForField('employee.salary_mode'), analysis.validatedPasses);
      }
    }

    const batchOccurrenceCounts = new Map<string, number>();
    for (const [lineIndex, line] of candidate.lines.entries()) {
      const lineKey = `${line.kind}:${normalizedText(line.label)}`;
      if (draft.lines.some((existing) => `${existing.kind}:${normalizedText(existing.label)}` === lineKey)
        && !repeatedLineKeys.has(lineKey)) {
        repeatedLineKeys.add(lineKey);
        warnings.push(`La rubrique « ${line.label} » apparaît sur plusieurs pages ou occurrences : chaque montant est conservé séparément et doit être contrôlé.`);
      }
      // Les lots couvrent des pages disjointes. Deux rubriques identiques dans
      // deux lots sont donc deux occurrences possibles, jamais une relecture à
      // dédupliquer. Le rapprochement des deux passages a déjà eu lieu dans
      // reconcilePayrollAiPasses pour chaque lot.
      const sourcePages = (analysis.provenance.lines[lineIndex]?.pages ?? [])
        .filter((page) => page >= batch.pageStart && page <= batch.pageEnd)
        .sort((left, right) => left - right);
      const pageToken = sourcePages.length ? [...new Set(sourcePages)].join('.') : `${batch.pageStart}-${batch.pageEnd}`;
      const occurrenceSignature = `${pageToken}:${lineKey}:${line.amountCents}`;
      const occurrence = (batchOccurrenceCounts.get(occurrenceSignature) ?? 0) + 1;
      batchOccurrenceCounts.set(occurrenceSignature, occurrence);
      draft.lines.push({
        ...line,
        id: createId(),
        sourceRef: line.sourceRef || `ai:p${pageToken}:k${line.kind}:h${stableLineHash(normalizedText(line.label))}:a${line.amountCents}:o${occurrence}`,
      });
    }
    for (const line of analysis.provenance.lines) {
      const pages = line.pages.filter((page) => page >= batch.pageStart && page <= batch.pageEnd);
      provenance.lines.push({ ...line, pages });
    }

    if (analysis.identity.passes >= 2) {
      identity.passes = 2;
      identity.employeeNumber = mergeText('numéro employé', identity.employeeNumber, analysis.identity.employeeNumber);
      identity.avsNumber = mergeText('numéro AVS', identity.avsNumber, analysis.identity.avsNumber, normalizedDigits);
      identity.birthDate = mergeText('date de naissance', identity.birthDate, analysis.identity.birthDate, (value) => value.trim());
      identity.iban = mergeText('IBAN employé', identity.iban, analysis.identity.iban, normalizedIban);
      analysis.identity.conflicts.forEach((conflict) => conflicts.add(conflict));
    }
  }

  provenance.lines = provenance.lines.filter((source) => draft.lines.some((line) => normalizedText(line.label) === normalizedText(source.label)
    && line.kind === source.kind && line.amountCents === source.amountCents));
  const provenanceByPages = new Map<string, string[]>();
  for (const [field, pages] of Object.entries(provenance.fields)) {
    const key = pages.join(',');
    if (key) provenanceByPages.set(key, [...(provenanceByPages.get(key) ?? []), field]);
  }
  for (const [pages, fields] of provenanceByPages) warnings.push(`Indications de pages IA · p. ${pages} : ${fields.join(', ')}.`);
  const lineLabelsByPages = new Map<string, string[]>();
  for (const line of provenance.lines) {
    if (!line.pages.length) continue;
    const key = line.pages.join(',');
    lineLabelsByPages.set(key, [...(lineLabelsByPages.get(key) ?? []), line.label]);
  }
  for (const [pages, labels] of lineLabelsByPages) {
    const uniqueLabels = [...new Set(labels)];
    const preview = uniqueLabels.slice(0, 8).map((label) => `« ${label} »`).join(', ');
    const remainder = uniqueLabels.length > 8 ? ` et ${uniqueLabels.length - 8} autre(s)` : '';
    warnings.push(`Indications de pages IA · p. ${pages} · rubriques : ${preview}${remainder}.`);
  }
  if (!Object.keys(provenance.fields).length && !provenance.lines.some((line) => line.pages.length)) {
    warnings.push('L’IA n’a pas fourni d’indication de page exploitable; comparez chaque valeur au document original.');
  }

  const identityFieldLabels = ['nom du collaborateur', 'numéro employé', 'numéro AVS', 'date de naissance', 'IBAN employé'];
  identity.conflicts = [...new Set([
    ...identity.conflicts,
    ...[...conflicts].filter((field) => identityFieldLabels.includes(field)),
  ])];
  if (identity.conflicts.length) {
    identity.passes = 0;
  }
  draft.warnings = [...new Set(warnings)]
    .sort((left, right) => {
      const priority = (warning: string) => warning.startsWith('Conflit entre pages') ? 0 : warning.startsWith('Indications de pages IA') ? 1 : 2;
      return priority(left) - priority(right);
    })
    .slice(0, 30);
  return { draft, detected, provenance, identity, validatedPasses };
}

/**
 * Les saisies réellement modifiées par l'utilisateur restent prioritaires.
 * Un 100 % / mensuel injecté comme simple valeur d'interface n'est en revanche
 * pas considéré comme confirmé et peut être remplacé par une valeur IA lue.
 */
export function mergePayrollImportDraft(
  current: PayrollImportDraft,
  parsedAi: ParsedPayrollAiDraft,
  confirmed: PayrollImportConfirmedAiFields = {},
): PayrollImportDraft {
  const ai = parsedAi.draft;
  const manualFields = new Set(current.review?.manualFields ?? []);
  const suppressedLineKeys = new Set(current.review?.suppressedLineKeys ?? []);
  const pick = (field: PayrollDraftField, existing: string, detected: string) => (
    manualFields.has(field) ? existing : existing.trim() || detected.trim()
  );
  const employee: PayrollImportEmployeeDraft = {
    employeeNumber: pick('employee.employeeNumber', current.employee.employeeNumber, ai.employee.employeeNumber),
    name: pick('employee.name', current.employee.name, ai.employee.name),
    role: pick('employee.role', current.employee.role, ai.employee.role),
    addressLine1: pick('employee.addressLine1', current.employee.addressLine1, ai.employee.addressLine1),
    addressLine2: pick('employee.addressLine2', current.employee.addressLine2, ai.employee.addressLine2),
    postalCode: pick('employee.postalCode', current.employee.postalCode, ai.employee.postalCode),
    city: pick('employee.city', current.employee.city, ai.employee.city),
    canton: pick('employee.canton', current.employee.canton, ai.employee.canton),
    birthDate: pick('employee.birthDate', current.employee.birthDate, ai.employee.birthDate),
    avsNumber: pick('employee.avsNumber', current.employee.avsNumber, ai.employee.avsNumber),
    iban: pick('employee.iban', current.employee.iban, ai.employee.iban),
    employmentRate: confirmed.employmentRate || manualFields.has('employee.employmentRate')
      ? current.employee.employmentRate
      : parsedAi.detected.employmentRate ? ai.employee.employmentRate : current.employee.employmentRate,
    salaryMode: confirmed.salaryMode || manualFields.has('employee.salaryMode')
      ? current.employee.salaryMode
      : parsedAi.detected.salaryMode ? ai.employee.salaryMode : current.employee.salaryMode,
  };
  const grossCents = manualFields.has('grossCents') ? current.grossCents : current.grossCents || ai.grossCents;
  const netCents = manualFields.has('netCents') ? current.netCents : current.netCents || ai.netCents;
  const acceptedAiLines = ai.lines
    .filter((line) => !lineHasTrackedKey(suppressedLineKeys, line))
    .map((line) => ({ ...line, recurring: false }));
  const lineMerge = mergePayrollLines(current.lines, acceptedAiLines);
  const warnings = [...new Set([
    ...current.warnings,
    ...ai.warnings,
    ...lineMerge.warnings,
    ...(current.grossCents && ai.grossCents && current.grossCents !== ai.grossCents ? ['Le brut lu par l’IA diffère de la couche texte; la valeur déjà détectée a été conservée.'] : []),
    ...(current.netCents && ai.netCents && current.netCents !== ai.netCents ? ['Le net lu par l’IA diffère de la couche texte; la valeur déjà détectée a été conservée.'] : []),
  ])];
  return {
    employee,
    period: pick('period', current.period, ai.period),
    paymentDate: pick('paymentDate', current.paymentDate, ai.paymentDate),
    grossCents,
    netCents,
    lines: lineMerge.lines,
    warnings,
    review: cloneReview(current.review),
  };
}
