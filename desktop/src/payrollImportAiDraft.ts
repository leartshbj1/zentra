import type {
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
  const lines = Array.isArray(parsed.lines) ? parsed.lines.map(recordValue) : [];
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
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings.map(textValue).filter(Boolean).slice(0, 30) : [],
  };
  return { draft, detected };
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
