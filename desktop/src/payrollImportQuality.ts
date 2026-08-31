import type { PayrollImportDraft, PayrollImportLineDraft } from './types';

export type PayrollDraftAssessment = {
  scoreBp: number;
  blockers: string[];
  warnings: string[];
  checks: Array<{ label: string; ok: boolean; detail: string }>;
};

function normalizeLabel(value: string) {
  return value
    .toLocaleLowerCase('fr-CH')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

export function payrollImportTotals(lines: PayrollImportLineDraft[]) {
  const gross = lines.filter((line) => line.kind === 'earning').reduce((sum, line) => sum + line.amountCents, 0);
  const deductions = lines.filter((line) => line.kind === 'deduction').reduce((sum, line) => sum + line.amountCents, 0);
  const reimbursements = lines.filter((line) => line.kind === 'reimbursement').reduce((sum, line) => sum + line.amountCents, 0);
  const employer = lines.filter((line) => line.kind === 'employer').reduce((sum, line) => sum + line.amountCents, 0);
  return { gross, deductions, reimbursements, employer, net: gross - deductions + reimbursements };
}

export function isValidSwissAvsNumber(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (!digits) return true;
  if (digits.length !== 13 || !digits.startsWith('756')) return false;
  const body = digits.slice(0, 12).split('').map(Number);
  const sum = body.reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10 === Number(digits.at(-1));
}

export function isValidIban(value: string): boolean {
  const compact = value.replace(/\s/g, '').toUpperCase();
  if (!compact) return true;
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact)) return false;
  const rearranged = `${compact.slice(4)}${compact.slice(0, 4)}`;
  let remainder = 0;
  for (const character of rearranged) {
    const expanded = /\d/.test(character) ? character : String(character.charCodeAt(0) - 55);
    for (const digit of expanded) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

export function isValidIsoCalendarDate(value: string): boolean {
  if (!value) return true;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function mergePayrollLines(current: PayrollImportLineDraft[], detected: PayrollImportLineDraft[]) {
  if (!current.length) return { lines: detected, warnings: [] as string[] };
  if (!detected.length) return { lines: current, warnings: [] as string[] };
  const merged = current.map((line) => ({ ...line }));
  const warnings: string[] = [];
  for (const candidate of detected) {
    const key = normalizeLabel(candidate.label);
    const existingIndex = merged.findIndex((line) => normalizeLabel(line.label) === key && line.kind === candidate.kind);
    if (existingIndex < 0) {
      merged.push(candidate);
      continue;
    }
    const existing = merged[existingIndex];
    if (existing.amountCents !== candidate.amountCents) {
      warnings.push(`Montant contradictoire pour « ${existing.label} » : la valeur issue du texte PDF a été conservée.`);
      continue;
    }
    merged[existingIndex] = {
      ...existing,
      recurring: existing.recurring || candidate.recurring,
      confidenceBp: Math.max(existing.confidenceBp, candidate.confidenceBp),
    };
  }
  return { lines: merged.slice(0, 80), warnings };
}

export function assessPayrollDraft(draft: PayrollImportDraft): PayrollDraftAssessment {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const totals = payrollImportTotals(draft.lines);
  const grossMatches = !draft.grossCents || Math.abs(draft.grossCents - totals.gross) <= 2;
  const netMatches = !draft.netCents || Math.abs(draft.netCents - totals.net) <= 2;
  const avsValid = isValidSwissAvsNumber(draft.employee.avsNumber);
  const ibanValid = isValidIban(draft.employee.iban);
  const periodValid = /^\d{4}-(0[1-9]|1[0-2])$/.test(draft.period);
  const paymentDateValid = isValidIsoCalendarDate(draft.paymentDate);

  if (!draft.employee.name.trim()) blockers.push('Le nom du collaborateur manque.');
  if (!periodValid) blockers.push('La période salariale doit être une année et un mois valides.');
  if (!draft.lines.length) blockers.push('Aucune rubrique salariale exploitable n’a été détectée.');
  if (draft.lines.some((line) => !line.label.trim() || line.amountCents <= 0)) blockers.push('Chaque rubrique doit avoir un libellé et un montant positif.');
  if (!grossMatches) blockers.push('La somme des gains ne correspond pas au salaire brut imprimé.');
  if (!netMatches) blockers.push('Le net recalculé (brut − retenues + remboursements) ne correspond pas au net imprimé.');
  if (!avsValid) blockers.push('Le numéro AVS ne passe pas le contrôle EAN-13 suisse.');
  if (!ibanValid) blockers.push('L’IBAN ne passe pas le contrôle MOD-97.');
  if (!paymentDateValid) blockers.push('La date de paiement détectée est invalide.');

  const duplicateLabels = new Set<string>();
  const seen = new Set<string>();
  for (const line of draft.lines) {
    const key = `${line.kind}:${normalizeLabel(line.label)}`;
    if (seen.has(key)) duplicateLabels.add(line.label);
    seen.add(key);
  }
  if (duplicateLabels.size) warnings.push(`Rubriques possiblement dupliquées : ${[...duplicateLabels].join(', ')}.`);
  if (!draft.lines.some((line) => line.kind === 'deduction')) warnings.push('Aucune retenue employé n’a été détectée; vérifiez le document original.');
  if (draft.lines.some((line) => line.confidenceBp < 6_000)) warnings.push('Au moins une rubrique a une confiance faible et doit être relue attentivement.');
  if (!draft.grossCents) warnings.push('Le salaire brut imprimé n’a pas été reconnu.');
  if (!draft.netCents) warnings.push('Le salaire net imprimé n’a pas été reconnu.');

  const requiredChecks = [Boolean(draft.employee.name.trim()), periodValid, draft.lines.length > 0, grossMatches, netMatches, avsValid, ibanValid, paymentDateValid];
  const lineConfidence = draft.lines.length
    ? draft.lines.reduce((sum, line) => sum + Math.max(0, Math.min(10_000, line.confidenceBp)), 0) / draft.lines.length
    : 0;
  const completeness = requiredChecks.filter(Boolean).length / requiredChecks.length;
  const printedTotals = (draft.grossCents ? 1 : 0) + (draft.netCents ? 1 : 0);
  const scoreBp = Math.max(0, Math.min(10_000, Math.round(completeness * 5_500 + (lineConfidence / 10_000) * 3_000 + (printedTotals / 2) * 1_500 - blockers.length * 1_500)));

  return {
    scoreBp,
    blockers,
    warnings,
    checks: [
      { label: 'Identité', ok: Boolean(draft.employee.name.trim()), detail: draft.employee.name || 'Nom absent' },
      { label: 'Période', ok: periodValid, detail: draft.period || 'Période absente' },
      { label: 'AVS', ok: avsValid, detail: draft.employee.avsNumber ? (avsValid ? 'Clé EAN-13 valide' : 'Clé invalide') : 'Non renseigné' },
      { label: 'IBAN', ok: ibanValid, detail: draft.employee.iban ? (ibanValid ? 'MOD-97 valide' : 'MOD-97 invalide') : 'Non renseigné' },
      { label: 'Brut', ok: grossMatches, detail: grossMatches ? 'Somme cohérente' : 'Écart à corriger' },
      { label: 'Net', ok: netMatches, detail: netMatches ? 'Somme cohérente' : 'Écart à corriger' },
    ],
  };
}
