import type {
  PayrollAiIdentityEvidence,
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
};

export type ReconciledPayrollAiDraft = ParsedPayrollAiDraft & {
  identity: PayrollAiIdentityEvidence;
};

function recordValue(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}

const textValue = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const numberValue = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;

function parseJsonObject(raw: string): RecordValue {
  const cleaned = raw.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const starts = [...cleaned.matchAll(/\{/g)].map((match) => match.index ?? 0).reverse();
  for (const start of starts) {
    for (let end = cleaned.lastIndexOf('}'); end > start; end = cleaned.lastIndexOf('}', end - 1)) {
      try {
        const candidate = recordValue(JSON.parse(cleaned.slice(start, end + 1)) as unknown);
        // Un objet imbriqué (par exemple `employee`) est lui aussi du JSON
        // valide. N'accepter que l'enveloppe complète évite de perdre toutes
        // les valeurs lors d'une lecture depuis la dernière accolade.
        if (Object.keys(recordValue(candidate.employee)).length || Array.isArray(candidate.lines)) return candidate;
      } catch {
        // Continue with the previous closing brace; model output can contain a short prefix.
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
    grossCents: Math.max(0, numberValue(parsed.gross_cents ?? parsed.grossCents)),
    netCents: Math.max(0, numberValue(parsed.net_cents ?? parsed.netCents)),
    lines: lines.slice(0, 80).map((line): PayrollImportLineDraft => {
      const kind = textValue(line.kind);
      return {
        id: createId(),
        label: textValue(line.label),
        kind: kind === 'deduction' || kind === 'reimbursement' || kind === 'non_gross_payment' || kind === 'employer'
          ? kind === 'non_gross_payment' ? 'reimbursement' : kind
          : 'earning',
        amountCents: Math.max(0, numberValue(line.amount_cents ?? line.amountCents)),
        recurring: kind === 'earning' && line.recurring === true,
        confidenceBp: Math.min(10_000, Math.max(0, numberValue(line.confidence_bp ?? line.confidenceBp))),
      };
    }).filter((line) => line.label && line.amountCents > 0),
    warnings: [
      ...(Array.isArray(parsed.warnings) ? parsed.warnings.map(textValue).filter(Boolean).slice(0, 30) : []),
      ...(invalidKindCount ? [`${invalidKindCount} rubrique(s) avec une classification IA inconnue ont été écartées; contrôlez le document original.`] : []),
    ],
  };
  return { draft, detected };
}

const normalizedText = (value: string) => value.toLocaleLowerCase('fr-CH').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
const normalizedDigits = (value: string) => value.replace(/\D/g, '');
const normalizedIban = (value: string) => value.replace(/\s/g, '').toUpperCase();

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
    warnings.push(`Double lecture : « ${label} » n’est pas confirmé de façon identique; vérifiez le document original.`);
    conflicts?.push(label);
  }
  return '';
}

/**
 * Réconcilie deux lectures réellement indépendantes. Les champs d'identité,
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

  if (!primary && !verified) throw verifiedError ?? primaryError ?? new Error("Les deux lectures locales sont inexploitables.");
  if (!primary || !verified) {
    const single = primary ?? verified!;
    return {
      draft: {
        ...single.draft,
        employee: { ...single.draft.employee },
        lines: single.draft.lines.map((line) => ({ ...line, recurring: false, confidenceBp: Math.min(4_999, line.confidenceBp) })),
        warnings: [...new Set([...single.draft.warnings, 'Une seule des deux lectures locales est exploitable : toutes les valeurs restent des propositions faibles et aucun collaborateur ne sera associé automatiquement.'])],
      },
      detected: { employmentRate: false, salaryMode: false },
      identity: { passes: 1, employeeNumber: '', avsNumber: '', birthDate: '', iban: '', conflicts: [] },
    };
  }

  const warnings = [...new Set([...primary.draft.warnings, ...verified.draft.warnings])];
  const identityConflicts: string[] = [];
  const employeeNumber = consensusText('numéro employé', primary.draft.employee.employeeNumber, verified.draft.employee.employeeNumber, normalizedText, warnings, identityConflicts);
  const avsNumber = consensusText('numéro AVS', primary.draft.employee.avsNumber, verified.draft.employee.avsNumber, normalizedDigits, warnings, identityConflicts);
  const birthDate = consensusText('date de naissance', primary.draft.employee.birthDate, verified.draft.employee.birthDate, (value) => value.trim(), warnings, identityConflicts);
  const iban = consensusText('IBAN employé', primary.draft.employee.iban, verified.draft.employee.iban, normalizedIban, warnings, identityConflicts);
  const pickEmployeeText = (label: string, first: string, second: string) => consensusText(label, first, second, normalizedText, warnings);
  const employmentRateAgrees = primary.detected.employmentRate
    && verified.detected.employmentRate
    && primary.draft.employee.employmentRate === verified.draft.employee.employmentRate;
  const salaryModeAgrees = primary.detected.salaryMode
    && verified.detected.salaryMode
    && primary.draft.employee.salaryMode === verified.draft.employee.salaryMode;
  if ((primary.detected.employmentRate || verified.detected.employmentRate) && !employmentRateAgrees) warnings.push('Double lecture : le taux d’activité diffère ou manque dans une lecture; confirmez-le manuellement.');
  if ((primary.detected.salaryMode || verified.detected.salaryMode) && !salaryModeAgrees) warnings.push('Double lecture : le mode de salaire diffère ou manque dans une lecture; confirmez-le manuellement.');

  const period = consensusText('période salariale', primary.draft.period, verified.draft.period, (value) => value.trim(), warnings);
  const paymentDate = consensusText('date de paiement', primary.draft.paymentDate, verified.draft.paymentDate, (value) => value.trim(), warnings);
  const amountConsensus = (label: string, first: number, second: number) => {
    if (first > 0 && second > 0 && first === second) return second;
    if (first || second) warnings.push(`Double lecture : le ${label} imprimé diffère ou manque dans une lecture; contrôlez le montant.`);
    return 0;
  };

  const usedVerified = new Set<number>();
  const lines: PayrollImportLineDraft[] = [];
  for (const first of primary.draft.lines) {
    const index = verified.draft.lines.findIndex((second, candidateIndex) => !usedVerified.has(candidateIndex)
      && normalizedText(second.label) === normalizedText(first.label)
      && second.kind === first.kind
      && second.amountCents === first.amountCents);
    if (index < 0) continue;
    usedVerified.add(index);
    const second = verified.draft.lines[index];
    lines.push({
      ...second,
      id: createId(),
      recurring: second.kind === 'earning' && first.recurring && second.recurring,
      confidenceBp: Math.min(first.confidenceBp, second.confidenceBp),
    });
  }
  const unmatched = primary.draft.lines.length + verified.draft.lines.length - lines.length * 2;
  if (unmatched > 0) warnings.push(`${unmatched} rubrique(s) n’ont pas concordé entre les deux lectures et n’ont pas été ajoutées automatiquement.`);

  return {
    draft: {
      employee: {
        employeeNumber,
        name: pickEmployeeText('nom du collaborateur', primary.draft.employee.name, verified.draft.employee.name),
        role: pickEmployeeText('fonction', primary.draft.employee.role, verified.draft.employee.role),
        addressLine1: pickEmployeeText('adresse', primary.draft.employee.addressLine1, verified.draft.employee.addressLine1),
        addressLine2: pickEmployeeText('complément d’adresse', primary.draft.employee.addressLine2, verified.draft.employee.addressLine2),
        postalCode: consensusText('NPA', primary.draft.employee.postalCode, verified.draft.employee.postalCode, normalizedText, warnings),
        city: pickEmployeeText('localité', primary.draft.employee.city, verified.draft.employee.city),
        canton: consensusText('canton', primary.draft.employee.canton, verified.draft.employee.canton, normalizedText, warnings).toUpperCase(),
        birthDate,
        avsNumber,
        iban: normalizedIban(iban),
        employmentRate: employmentRateAgrees ? verified.draft.employee.employmentRate : 100,
        salaryMode: salaryModeAgrees ? verified.draft.employee.salaryMode : 'monthly',
      },
      period,
      paymentDate,
      grossCents: amountConsensus('brut', primary.draft.grossCents, verified.draft.grossCents),
      netCents: amountConsensus('net', primary.draft.netCents, verified.draft.netCents),
      lines,
      warnings: [...new Set(warnings)],
    },
    detected: { employmentRate: employmentRateAgrees, salaryMode: salaryModeAgrees },
    identity: { passes: 2, employeeNumber, avsNumber, birthDate, iban: normalizedIban(iban), conflicts: identityConflicts },
  };
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
  const pick = (existing: string, detected: string) => existing.trim() || detected.trim();
  const employee: PayrollImportEmployeeDraft = {
    employeeNumber: pick(current.employee.employeeNumber, ai.employee.employeeNumber),
    name: pick(current.employee.name, ai.employee.name),
    role: pick(current.employee.role, ai.employee.role),
    addressLine1: pick(current.employee.addressLine1, ai.employee.addressLine1),
    addressLine2: pick(current.employee.addressLine2, ai.employee.addressLine2),
    postalCode: pick(current.employee.postalCode, ai.employee.postalCode),
    city: pick(current.employee.city, ai.employee.city),
    canton: pick(current.employee.canton, ai.employee.canton),
    birthDate: pick(current.employee.birthDate, ai.employee.birthDate),
    avsNumber: pick(current.employee.avsNumber, ai.employee.avsNumber),
    iban: pick(current.employee.iban, ai.employee.iban),
    employmentRate: confirmed.employmentRate
      ? current.employee.employmentRate
      : parsedAi.detected.employmentRate ? ai.employee.employmentRate : current.employee.employmentRate,
    salaryMode: confirmed.salaryMode
      ? current.employee.salaryMode
      : parsedAi.detected.salaryMode ? ai.employee.salaryMode : current.employee.salaryMode,
  };
  const grossCents = current.grossCents || ai.grossCents;
  const netCents = current.netCents || ai.netCents;
  const lineMerge = mergePayrollLines(current.lines, ai.lines);
  const warnings = [...new Set([
    ...current.warnings,
    ...ai.warnings,
    ...lineMerge.warnings,
    ...(current.grossCents && ai.grossCents && current.grossCents !== ai.grossCents ? ['Le brut lu par l’IA diffère de la couche texte; la valeur déjà détectée a été conservée.'] : []),
    ...(current.netCents && ai.netCents && current.netCents !== ai.netCents ? ['Le net lu par l’IA diffère de la couche texte; la valeur déjà détectée a été conservée.'] : []),
  ])];
  return {
    employee,
    period: pick(current.period, ai.period),
    paymentDate: pick(current.paymentDate, ai.paymentDate),
    grossCents,
    netCents,
    lines: lineMerge.lines,
    warnings,
  };
}
