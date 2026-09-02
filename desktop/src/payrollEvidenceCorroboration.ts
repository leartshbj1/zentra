import type { PayrollAiProvenance } from './payrollImportAiDraft';
import type { PayrollImportDraft } from './types';

const VISUAL_DOUBLE_READ_CONFIDENCE_BP = 7_000;
const VISUAL_SINGLE_READ_CONFIDENCE_BP = 5_200;
const TEXT_CORROBORATED_DOUBLE_READ_CONFIDENCE_BP = 9_200;
const TEXT_CORROBORATED_SINGLE_READ_CONFIDENCE_BP = 7_800;
const UNSOURCED_CONFIDENCE_BP = 4_999;

const MONTHS = [
  ['janvier', 'januar', 'gennaio', 'january'],
  ['fevrier', 'februar', 'febbraio', 'february'],
  ['mars', 'marz', 'marzo', 'march'],
  ['avril', 'april', 'aprile'],
  ['mai', 'maggio', 'may'],
  ['juin', 'juni', 'giugno', 'june'],
  ['juillet', 'juli', 'luglio', 'july'],
  ['aout', 'august', 'agosto'],
  ['septembre', 'september', 'settembre'],
  ['octobre', 'oktober', 'ottobre', 'october'],
  ['novembre', 'november'],
  ['decembre', 'dezember', 'dicembre', 'december'],
] as const;

type CorroborationInput = {
  draft: PayrollImportDraft;
  provenance: PayrollAiProvenance;
  pageTexts: readonly string[];
  passes: number;
};

export type PayrollEvidenceCorroboration = {
  draft: PayrollImportDraft;
  provenance: PayrollAiProvenance;
  lineCount: number;
  corroboratedLineCount: number;
  hasTextLayer: boolean;
};

function foldText(value: string) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('fr-CH')
    .replace(/[’`]/g, "'")
    .replace(/[^a-z0-9'.,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactAlphanumeric(value: string) {
  return foldText(value).replace(/[^a-z0-9]/g, '');
}

function labelTokens(value: string) {
  const ignored = new Set([
    'chf', 'part', 'total', 'montant', 'betrag', 'amount', 'importo',
    'employe', 'employee', 'arbeitnehmer', 'dipendente',
  ]);
  return [...new Set(foldText(value)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2 && !ignored.has(token)))];
}

function parsePrintedMoney(value: string): number | null {
  const compact = value
    .replace(/\bCHF\b/gi, '')
    .replace(/[\u00a0\u202f]/g, ' ')
    .trim();
  if (!compact) return null;

  const decimalMatch = /^(\d{1,3}(?:['’ ]\d{3})+|\d+)[.,](\d{2})$/.exec(compact);
  if (decimalMatch) {
    const francs = Number(decimalMatch[1].replace(/['’ ]/g, ''));
    const cents = Number(decimalMatch[2]);
    const amount = francs * 100 + cents;
    return Number.isSafeInteger(amount) ? amount : null;
  }

  // Un montant sans décimales n'est accepté qu'avec CHF ou un séparateur de
  // milliers. Cela évite de confondre une année, un NPA ou un numéro employé
  // avec un salaire.
  const integerMatch = /^(\d{1,3}(?:['’ ]\d{3})+|\d+)$/.exec(compact);
  if (!integerMatch || (!/\bCHF\b/i.test(value) && !/['’ ]/.test(compact))) return null;
  const francs = Number(integerMatch[1].replace(/['’ ]/g, ''));
  const amount = francs * 100;
  return Number.isSafeInteger(amount) ? amount : null;
}

function moneyValuesOnLine(line: string) {
  const candidates = line.match(/(?:\bCHF\s*)?(?:\d{1,3}(?:['’\u00a0\u202f ]\d{3})+|\d+)(?:[.,]\d{2})?(?:\s*CHF\b)?/gi) ?? [];
  return candidates.flatMap((candidate) => {
    const value = parsePrintedMoney(candidate);
    return value === null ? [] : [value];
  });
}

function lineCorroboratesPayrollLine(pageText: string, label: string, amountCents: number) {
  const tokens = labelTokens(label);
  if (!tokens.length || amountCents <= 0) return false;
  for (const rawLine of pageText.split(/\r?\n/)) {
    if (!moneyValuesOnLine(rawLine).includes(amountCents)) continue;
    const normalizedLineTokens = new Set(foldText(rawLine).split(/[^a-z0-9]+/).filter(Boolean));
    const tokenMatches = tokens.filter((token) => normalizedLineTokens.has(token)).length;
    const requiredMatches = tokens.length === 1 ? 1 : Math.min(2, tokens.length);
    if (tokenMatches >= requiredMatches) return true;
  }
  return false;
}

function normalizedLines(pageText: string) {
  return pageText.split(/\r?\n/).map((raw) => ({ raw, folded: foldText(raw) }));
}

function lineContainsAnyLabel(line: string, labels: readonly string[]) {
  const compactLine = compactAlphanumeric(line);
  return labels.some((label) => compactLine.includes(compactAlphanumeric(label)));
}

function pageCorroboratesLabeledAmount(
  pageText: string,
  amountCents: number,
  labels: readonly string[],
) {
  if (amountCents <= 0) return false;
  return normalizedLines(pageText).some(({ raw, folded }) => (
    moneyValuesOnLine(raw).includes(amountCents)
    && lineContainsAnyLabel(folded, labels)
  ));
}

const FIELD_LABELS = {
  employeeNumber: [
    'numero employe', 'numero collaborateur', 'matricule', 'personalnummer',
    'mitarbeiternummer', 'numero dipendente', 'employee number',
  ],
  birthDate: [
    'date de naissance', 'ne le', 'nee le', 'geburtsdatum', 'nato il',
    'nata il', 'date of birth',
  ],
  avsNumber: [
    'numero avs', 'no avs', 'avs nr', 'ahv nr', 'numero avs ai',
    'social security number',
  ],
  employmentRate: [
    "taux d'activite", "taux d'occupation", 'taux activite', 'taux occupation',
    'pensum', 'beschäftigungsgrad',
    'beschaftigungsgrad', 'grado occupazione', 'employment rate',
  ],
  paymentDate: [
    'date de paiement', 'date de versement', 'paye le', 'auszahlungsdatum',
    'zahlungsdatum', 'data pagamento', 'payment date',
  ],
  gross: [
    'salaire brut', 'total brut', 'bruttolohn', 'brutto lohn', 'salario lordo',
    'gross salary', 'gross pay',
  ],
  net: [
    'net a payer', 'salaire net', 'total net', 'nettolohn', 'netto lohn',
    'salario netto', 'net pay', 'net salary',
  ],
  monthly: [
    'salaire mensuel', 'traitement mensuel', 'monatslohn', 'salario mensile',
    'monthly salary', 'monthly wage',
  ],
  hourly: [
    'salaire horaire', 'taux horaire', 'stundenlohn', 'salario orario',
    'hourly salary', 'hourly wage',
  ],
} as const;

function pageCorroboratesLabeledText(
  pageText: string,
  value: string,
  labels: readonly string[],
) {
  const compactValue = compactAlphanumeric(value);
  if (compactValue.length < 2) return false;
  return normalizedLines(pageText).some(({ folded }) => (
    compactAlphanumeric(folded).includes(compactValue)
    && lineContainsAnyLabel(folded, labels)
  ));
}

function periodVariants(value: string) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value.trim());
  if (!match) return [];
  const year = match[1];
  const month = Number(match[2]);
  return [
    `${match[2]} ${year}`,
    `${month} ${year}`,
    `${match[2]}${year}`,
    ...MONTHS[month - 1].map((name) => `${name} ${year}`),
  ].map(compactAlphanumeric);
}

function fieldValue(draft: PayrollImportDraft, field: string): string | number | undefined {
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

function pageCorroboratesField(pageText: string, field: string, value: string | number | undefined) {
  if (value === undefined || value === '') return false;
  if (field === 'gross_cents' && typeof value === 'number') {
    return pageCorroboratesLabeledAmount(pageText, value, FIELD_LABELS.gross);
  }
  if (field === 'net_cents' && typeof value === 'number') {
    return pageCorroboratesLabeledAmount(pageText, value, FIELD_LABELS.net);
  }
  const compactPage = compactAlphanumeric(pageText);
  if (!compactPage) return false;
  if (field === 'period' && typeof value === 'string') {
    return periodVariants(value).some((variant) => variant && compactPage.includes(variant));
  }
  if (field === 'employee.employee_number' && typeof value === 'string')
    return pageCorroboratesLabeledText(pageText, value, FIELD_LABELS.employeeNumber);
  if (field === 'employee.birth_date' && typeof value === 'string')
    return pageCorroboratesLabeledText(pageText, value, FIELD_LABELS.birthDate);
  if (field === 'employee.avs_number' && typeof value === 'string')
    return pageCorroboratesLabeledText(pageText, value, FIELD_LABELS.avsNumber);
  if (field === 'employee.employment_rate' && typeof value === 'number') {
    const rate = String(value);
    return normalizedLines(pageText).some(({ raw, folded }) => (
      lineContainsAnyLabel(folded, FIELD_LABELS.employmentRate)
      && new RegExp(`(^|\\D)${rate}(?:[.,]0+)?\\s*%`).test(raw)
    ));
  }
  if (field === 'employee.salary_mode' && typeof value === 'string') {
    const labels = value === 'monthly' ? FIELD_LABELS.monthly : FIELD_LABELS.hourly;
    return normalizedLines(pageText).some(({ folded }) => lineContainsAnyLabel(folded, labels));
  }
  if (field === 'payment_date' && typeof value === 'string')
    return pageCorroboratesLabeledText(pageText, value, FIELD_LABELS.paymentDate);
  const compactValue = compactAlphanumeric(String(value));
  // Les identifiants longs, l'IBAN, le nom, le rôle et l'adresse restent
  // spécifiques lorsqu'ils sont réellement présents. Les champs courts ou
  // numériques ont été traités ci-dessus avec leur libellé afin qu'un nombre
  // fortuit ailleurs sur la page ne puisse jamais produire une confiance 9200.
  return compactValue.length >= 4 && compactPage.includes(compactValue);
}

function visualConfidence(passes: number, hasPages: boolean) {
  if (!hasPages) return UNSOURCED_CONFIDENCE_BP;
  return passes >= 2 ? VISUAL_DOUBLE_READ_CONFIDENCE_BP : VISUAL_SINGLE_READ_CONFIDENCE_BP;
}

function corroboratedConfidence(passes: number) {
  return passes >= 2
    ? TEXT_CORROBORATED_DOUBLE_READ_CONFIDENCE_BP
    : TEXT_CORROBORATED_SINGLE_READ_CONFIDENCE_BP;
}

/**
 * Corrobore les pages auto-déclarées par SmolVLM avec la couche texte locale
 * du PDF. La couche texte n'est jamais utilisée comme ordre ou comme schéma :
 * elle sert seulement à vérifier qu'une valeur et, pour une rubrique, son
 * libellé et son montant sont réellement présents sur la page annoncée.
 */
export function corroboratePayrollAiEvidence(input: CorroborationInput): PayrollEvidenceCorroboration {
  const pageTexts = input.pageTexts.map((text) => text.slice(0, 8_000));
  const hasTextLayer = pageTexts.some((text) => text.trim().length > 0);
  const fieldConfidenceBp: Record<string, number> = {};
  for (const [field, pages] of Object.entries(input.provenance.fields)) {
    const isCorroborated = pages.some((page) => {
      const pageText = pageTexts[page - 1] ?? '';
      return pageText.trim() && pageCorroboratesField(pageText, field, fieldValue(input.draft, field));
    });
    fieldConfidenceBp[field] = isCorroborated
      ? corroboratedConfidence(input.passes)
      : visualConfidence(input.passes, pages.length > 0);
  }

  let corroboratedLineCount = 0;
  const lines = input.provenance.lines.map((line) => {
    const isCorroborated = line.pages.some((page) => {
      const pageText = pageTexts[page - 1] ?? '';
      return pageText.trim() && lineCorroboratesPayrollLine(pageText, line.label, line.amountCents);
    });
    if (isCorroborated) corroboratedLineCount += 1;
    return {
      ...line,
      pages: [...line.pages],
      confidenceBp: isCorroborated
        ? corroboratedConfidence(input.passes)
        : visualConfidence(input.passes, line.pages.length > 0),
    };
  });

  const lineCount = lines.length;
  const warnings = [...input.draft.warnings];
  if (hasTextLayer && lineCount) {
    warnings.push(
      `${corroboratedLineCount}/${lineCount} rubrique${lineCount > 1 ? 's' : ''} corroborée${corroboratedLineCount > 1 ? 's' : ''} par libellé et montant dans la couche texte locale du PDF.`,
    );
    if (corroboratedLineCount < lineCount) {
      warnings.push('Les autres rubriques reposent uniquement sur les lectures visuelles du même modèle et restent à contrôler sur l’image originale.');
    }
  } else if (lineCount) {
    warnings.push('Aucune couche texte locale ne permet de corroborer les rubriques : la confiance reste limitée aux lectures visuelles du même modèle.');
  }

  const provenance: PayrollAiProvenance = {
    fields: Object.fromEntries(Object.entries(input.provenance.fields).map(([field, pages]) => [field, [...pages]])),
    fieldConfidenceBp,
    lines,
    conflicts: input.provenance.conflicts?.map((conflict) => ({
      ...conflict,
      values: [...conflict.values],
      pages: [...conflict.pages],
      passIndexes: [...conflict.passIndexes],
    })),
  };
  return {
    draft: {
      ...input.draft,
      employee: { ...input.draft.employee },
      lines: input.draft.lines.map((line) => ({ ...line })),
      warnings: [...new Set(warnings)].slice(0, 30),
      review: input.draft.review ? { ...input.draft.review } : undefined,
    },
    provenance,
    lineCount,
    corroboratedLineCount,
    hasTextLayer,
  };
}
