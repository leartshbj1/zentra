import { isValidIban, isValidIsoCalendarDate, isValidSwissAvsNumber } from './payrollImportQuality';

export const EMPLOYEE_DOCUMENT_KEYS = ['name', 'employeeNumber', 'addressLine1', 'postalCode', 'city', 'birthDate', 'avsNumber', 'iban', 'email', 'phone', 'role', 'employmentStart'] as const;
export type EmployeeDocumentField = typeof EMPLOYEE_DOCUMENT_KEYS[number] | 'employmentRate' | 'grossSalary' | 'salaryMode';
export type EmployeeDocumentDraft = { fields: Partial<Record<EmployeeDocumentField, string>>; warnings: string[] };

const normalize = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[’‘`]/g, "'").replace(/\s+/g, ' ').trim();
const compact = (value: string) => normalize(value).replace(/[^a-z0-9]/g, '');
const labels: Partial<Record<EmployeeDocumentField, RegExp>> = {
  birthDate: /naissance|birth|geburt|nascita/i,
  employmentStart: /entr[ée]e|embauche|d[ée]but\s+(?:du\s+)?contrat|engagement|hire|eintritt|assunzione/i,
  role: /fonction|poste|profession|position|beruf|qualifica/i,
  employeeNumber: /(?:num[ée]ro|n[°o])\s*(?:de\s*)?(?:collaborateur|employ[ée]|personnel)|matricule|personalnummer|employee\s*(?:number|id)/i,
  email: /(?:e.?mail|courriel).*(?:employ[ée]|collaborateur)|(?:employ[ée]|collaborateur).*e.?mail/i,
  phone: /(?:t[ée]l[ée]phone|phone|mobile).*(?:employ[ée]|collaborateur)|(?:employ[ée]|collaborateur).*(?:t[ée]l|phone)/i,
  iban: /iban.*(?:employ[ée]|collaborateur|salari[ée]|b[ée]n[ée]ficiaire)|(?:employ[ée]|collaborateur|salari[ée]|b[ée]n[ée]ficiaire).*iban/i,
};

function printedDate(value: string) {
  const match = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(value);
  const iso = match ? `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}` : value;
  return isValidIsoCalendarDate(iso) && iso ? iso : null;
}

/** Proposals are never trusted just because they are valid JSON. Ground each
 * value in the local source, reject invalid identifiers and preserve omissions. */
export function employeeDocumentDraft(raw: string, source: string): EmployeeDocumentDraft {
  let proposed: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw.trim().replace(/^<think>[\s\S]*?<\/think>\s*/i, '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error();
    proposed = parsed as Record<string, unknown>;
  } catch { throw new Error('La lecture n’a pas donné de résultat exploitable. Essayez une image plus nette ou complétez la fiche manuellement.'); }
  const fields: EmployeeDocumentDraft['fields'] = {};
  const warnings: string[] = [];
  const lines = source.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  // Explicitly labelled facts do not need token generation. Ambiguous or
  // repeated values remain blank and go through the same grounding checks.
  for (const [key, label] of Object.entries(labels)) {
    if (proposed[key]) continue;
    const candidates = lines.flatMap(line => {
      const match = label.exec(line);
      if (!match) return [];
      const tail = line.slice(match.index + match[0].length).replace(/^\s*[:\-]\s*/, '').trim();
      const value = key === 'birthDate' || key === 'employmentStart'
        ? tail.match(/\b(?:\d{1,2}[./-]\d{1,2}[./-]\d{4}|\d{4}-\d{2}-\d{2})\b/)?.[0]
        : tail;
      return value ? [value] : [];
    });
    if (new Set(candidates).size === 1) proposed[key] = candidates[0];
  }
  for (const [key, label, pattern] of [
    ['avsNumber', /assurance\s+sociale|\bAVS\b|\bAHV\b/i, /756(?:[. ]?\d){10}\b/],
    ['iban', /\bIBAN\b/i, /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/],
  ] as const) {
    const candidates = lines.filter(line => label.test(line)).flatMap(line => line.match(pattern)?.[0] ?? []);
    if (!proposed[key] && new Set(candidates).size === 1) proposed[key] = candidates[0];
  }
  const normalizedSource = normalize(source);
  for (const key of EMPLOYEE_DOCUMENT_KEYS) {
    const value = typeof proposed[key] === 'string' ? proposed[key].trim().replace(/\s+/g, ' ') : '';
    if (!value || value.length > 180 || /^(?:null|none|unknown|inconnu|n\/?a)$/i.test(value)) continue;
    const identifier = key === 'iban' || key === 'avsNumber';
    const grounded = identifier ? compact(source).includes(compact(value)) : normalizedSource.includes(normalize(value));
    if (!grounded) continue;
    const label = labels[key];
    // Dates and contact details in the company footer are not employee data.
    if (label && !lines.some((line, index) => label.test(line) && normalize(`${line} ${lines[index + 1] ?? ''}`).includes(normalize(value)))) continue;
    if (key === 'avsNumber' && !isValidSwissAvsNumber(value)) { warnings.push('Le numéro AVS imprimé est invalide. Vérifiez-le sur un document officiel.'); continue; }
    if (key === 'iban' && !isValidIban(value)) { warnings.push('L’IBAN imprimé ne passe pas le contrôle de validité.'); continue; }
    if (key === 'birthDate' || key === 'employmentStart') {
      const date = printedDate(value);
      if (date) fields[key] = date;
      continue;
    }
    if (key === 'postalCode' && !/^\d{4,6}$/.test(value)) continue;
    if (key === 'addressLine1' && (!/\d/.test(value) || !/\p{L}{2}/u.test(value) || /https?:|www\.|@/.test(value))) continue;
    if (key === 'name' && (!/^[\p{L}\p{M}][\p{L}\p{M} .’'\-]+$/u.test(value) || /\b(?:sarl|sàrl|gmbh|ltd|conseils|bulletin|salaire)\b/i.test(value))) continue;
    if (key === 'name') {
      const candidates = [...new Set(lines.filter(line => normalize(line).includes(normalize(value)) && /^[\p{L}\p{M} .’'\-]+$/u.test(line) && !/salaire|bulletin|conseils|mensuel/i.test(line)).map(line => line.replace(/^(?:Monsieur|Madame|Herr|Frau|Mr\.?|Mrs\.?)\s+/i, '').trim()))];
      fields.name = candidates.length === 1 ? candidates[0] : value;
    } else fields[key] = value;
  }
  // Detect an invalid printed AVS even when the model omitted it.
  for (const line of lines.filter(line => /assurance\s+sociale|(?:num[ée]ro|n[°o]).*AVS|AVS.*(?:num[ée]ro|n[°o])|AHV.*nummer/i.test(line))) {
    const candidate = line.match(/756[\d.\s]{8,20}\d/)?.[0];
    if (candidate && !isValidSwissAvsNumber(candidate) && !warnings.some(w => w.includes('AVS'))) warnings.push('Le numéro AVS imprimé est invalide. Vérifiez-le sur un document officiel.');
  }
  // A monthly base is a printed earning row, never the net or the total gross.
  const bases = lines.flatMap(line => {
    const match = /^\s*(?:\d{3,5}\s+)?(?:salaire\s+mensuel|monatslohn|monthly\s+(?:salary|wage)|salario\s+mensile)\s*:?\s*(?:CHF\s*)?([\d][\d'’`\u00a0\u202f ]*(?:[.,]\d{1,2})?)\s*(?:CHF)?$/i.exec(line);
    if (!match) return [];
    const value = match[1].replace(/['’`\s\u00a0\u202f]/g, '').replace(',', '.');
    const [francs, fraction = ''] = value.split('.');
    const cents = Number(francs) * 100 + Number(fraction.padEnd(2, '0'));
    return Number.isSafeInteger(cents) && cents > 0 && cents < 100_000_000 ? [cents] : [];
  });
  const uniqueBases = [...new Set(bases)];
  if (uniqueBases.length === 1) { fields.grossSalary = (uniqueBases[0] / 100).toFixed(2); fields.salaryMode = 'monthly'; }
  else if (uniqueBases.length > 1) warnings.push('Plusieurs salaires mensuels sont indiqués. Choisissez la base contractuelle actuelle.');
  const rates = lines.flatMap(line => {
    const match = /(?:taux\s+d['’]activit[ée]|taux\s+d['’]occupation|besch[äa]ftigungsgrad|grado\s+di\s+occupazione)\s*:?\s*(\d{1,3}(?:[.,]\d{1,2})?)\s*%/i.exec(line);
    const rate = match ? Number(match[1].replace(',', '.')) : 0;
    return rate > 0 && rate <= 100 ? [String(rate)] : [];
  });
  if (new Set(rates).size === 1) fields.employmentRate = rates[0];
  return { fields, warnings };
}
