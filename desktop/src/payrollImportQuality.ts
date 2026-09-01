import type { PayrollImportDraft, PayrollImportLineDraft } from './types';

export type PayrollDraftAssessment = {
  scoreBp: number;
  blockers: string[];
  warnings: string[];
  checks: Array<{ label: string; ok: boolean; detail: string }>;
};

export function payrollControlQualityLabel(scoreBp: number) {
  if (scoreBp >= 8_500) return 'élevée';
  if (scoreBp >= 6_000) return 'moyenne';
  return 'faible';
}

function normalizeLabel(value: string) {
  return value
    .toLocaleLowerCase('fr-CH')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function utcDate(value: string) {
  if (!isValidIsoCalendarDate(value) || !value) return null;
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function payrollPeriodBounds(period: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return null;
  const [year, month] = period.split('-').map(Number);
  return {
    start: new Date(Date.UTC(year, month - 1, 1)),
    end: new Date(Date.UTC(year, month, 0)),
  };
}

function daysBetween(left: Date, right: Date) {
  return Math.round((left.getTime() - right.getTime()) / 86_400_000);
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
  const currentLength = merged.length;
  const usedCurrentIndexes = new Set<number>();
  const warnings: string[] = [];
  for (const candidate of detected) {
    const key = normalizeLabel(candidate.label);
    const existingIndex = merged.findIndex((line, index) => (
      index < currentLength
      && !usedCurrentIndexes.has(index)
      && normalizeLabel(line.label) === key
      && line.kind === candidate.kind
      && line.amountCents === candidate.amountCents
    ));
    if (existingIndex < 0) {
      if (merged.slice(0, currentLength).some((line) => (
        normalizeLabel(line.label) === key && line.kind === candidate.kind
      ))) {
        warnings.push(`Occurrence supplémentaire ou montant différent pour « ${candidate.label} » : la proposition IA a été conservée séparément pour contrôle.`);
      }
      merged.push(candidate);
      continue;
    }
    usedCurrentIndexes.add(existingIndex);
    const existing = merged[existingIndex];
    merged[existingIndex] = {
      ...existing,
      sourceRef: existing.sourceRef || candidate.sourceRef,
      recurring: existing.recurring || candidate.recurring,
      confidenceBp: Math.max(existing.confidenceBp, candidate.confidenceBp),
    };
  }
  return { lines: merged, warnings };
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
  const birthDateValid = isValidIsoCalendarDate(draft.employee.birthDate);
  const employmentRateValid = Number.isSafeInteger(draft.employee.employmentRate)
    && draft.employee.employmentRate >= 1
    && draft.employee.employmentRate <= 100;
  const salaryModeValid = draft.employee.salaryMode === 'monthly' || draft.employee.salaryMode === 'hourly';
  const uniqueLineIds = new Set(draft.lines.map((line) => line.id)).size === draft.lines.length;
  const monetaryValuesValid = [draft.grossCents, draft.netCents, ...draft.lines.map((line) => line.amountCents)]
    .every((value) => Number.isSafeInteger(value) && value >= 0);
  const periodBounds = payrollPeriodBounds(draft.period);
  const birthDate = utcDate(draft.employee.birthDate);
  const paymentDate = utcDate(draft.paymentDate);
  const birthBeforePayroll = !birthDate || !periodBounds || birthDate <= periodBounds.end;
  const birthBeforePayment = !birthDate || !paymentDate || birthDate <= paymentDate;
  const chronologyValid = birthBeforePayroll && birthBeforePayment;

  if (!draft.employee.name.trim()) blockers.push('Le nom du collaborateur manque.');
  if (!periodValid) blockers.push('La période salariale doit être une année et un mois valides.');
  if (!draft.lines.length) blockers.push('Aucune rubrique salariale exploitable n’a été détectée.');
  if (draft.lines.length > 80) blockers.push(`La fiche contient ${draft.lines.length} rubriques; séparez le document pour rester sous la limite de 80 sans perdre de ligne.`);
  if (draft.lines.some((line) => !line.label.trim() || line.amountCents <= 0)) blockers.push('Chaque rubrique doit avoir un libellé et un montant positif.');
  if (!grossMatches) blockers.push('La somme des gains ne correspond pas au salaire brut imprimé.');
  if (!netMatches) blockers.push('Le net recalculé (brut − retenues + remboursements) ne correspond pas au net imprimé.');
  if (!avsValid) blockers.push('Le numéro AVS ne passe pas le contrôle EAN-13 suisse.');
  if (!ibanValid) blockers.push('L’IBAN ne passe pas le contrôle MOD-97.');
  if (!paymentDateValid) blockers.push('La date de paiement détectée est invalide.');
  if (!birthDateValid) blockers.push('La date de naissance détectée est invalide.');
  if (!employmentRateValid) blockers.push('Le taux d’activité doit être un pourcentage entier compris entre 1 et 100.');
  if (!salaryModeValid) blockers.push('Le mode de salaire doit être mensuel ou horaire.');
  if (!uniqueLineIds) blockers.push('Deux rubriques partagent le même identifiant technique; relancez l’analyse ou recréez la ligne concernée.');
  if (!monetaryValuesValid) blockers.push('Les montants doivent être des centimes entiers positifs ou nuls, sans valeur technique invalide.');
  if (!chronologyValid) blockers.push('La date de naissance doit précéder la période salariale et la date de paiement.');

  const summaryLineLabels = new Set([
    'salairebrut', 'totalbrut', 'bruttolohn', 'bruttogehalt', 'salariolordo',
    'salaire net', 'salairenet', 'netapayer', 'nettolo hn', 'nettolohn', 'salario netto', 'salarionetto',
  ].map(normalizeLabel));
  const summaryLines = draft.lines.filter((line) => summaryLineLabels.has(normalizeLabel(line.label)));
  if (summaryLines.length) {
    blockers.push(`Une rubrique semble être un total imprimé compté comme ligne (${summaryLines.map((line) => line.label).join(', ')}); retirez-la pour éviter un double comptage.`);
  }

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
  if (periodBounds && paymentDate) {
    const tooEarly = daysBetween(periodBounds.start, paymentDate) > 31;
    const tooLate = daysBetween(paymentDate, periodBounds.end) > 62;
    if (tooEarly || tooLate) warnings.push('La date de paiement est éloignée de la période salariale; contrôlez le mois et l’année sur le document original.');
  }

  const employerMarkers = ['employeur', 'patronal', 'arbeitgeber', 'datore', 'padronale'];
  const expenseMarkers = ['remboursement', 'frais', 'spesen', 'rimborso', 'indemnitekilometrique'];
  const misclassifiedEmployerLines = draft.lines.filter((line) => (
    line.kind === 'deduction'
    && employerMarkers.some((marker) => normalizeLabel(line.label).includes(normalizeLabel(marker)))
  ));
  if (misclassifiedEmployerLines.length) {
    warnings.push(`Part patronale possiblement classée comme retenue employé : ${misclassifiedEmployerLines.map((line) => line.label).join(', ')}.`);
  }
  const misclassifiedExpenses = draft.lines.filter((line) => (
    line.kind === 'earning'
    && expenseMarkers.some((marker) => normalizeLabel(line.label).includes(normalizeLabel(marker)))
  ));
  if (misclassifiedExpenses.length) {
    warnings.push(`Remboursement de frais possiblement inclus dans le brut : ${misclassifiedExpenses.map((line) => line.label).join(', ')}.`);
  }

  const counterpartWarnings = new Set<string>();
  for (const line of draft.lines) {
    const counterpart = draft.lines.find((candidate) => (
      candidate.id !== line.id
      && candidate.amountCents === line.amountCents
      && normalizeLabel(candidate.label) === normalizeLabel(line.label)
      && ((candidate.kind === 'employer' && line.kind === 'deduction')
        || (candidate.kind === 'deduction' && line.kind === 'employer'))
    ));
    if (counterpart) counterpartWarnings.add(line.label);
  }
  if (counterpartWarnings.size) {
    warnings.push(`Parts employé/employeur identiques à distinguer explicitement : ${[...counterpartWarnings].join(', ')}.`);
  }

  const requiredChecks = [Boolean(draft.employee.name.trim()), periodValid, draft.lines.length > 0, grossMatches, netMatches, avsValid, ibanValid, paymentDateValid, birthDateValid, employmentRateValid, salaryModeValid, uniqueLineIds, monetaryValuesValid, chronologyValid, !summaryLines.length];
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
      { label: 'Naissance', ok: birthDateValid, detail: draft.employee.birthDate ? (birthDateValid ? 'Date civile valide' : 'Date invalide') : 'Non renseignée' },
      { label: 'AVS', ok: avsValid, detail: draft.employee.avsNumber ? (avsValid ? 'Clé EAN-13 valide' : 'Clé invalide') : 'Non renseigné' },
      { label: 'IBAN', ok: ibanValid, detail: draft.employee.iban ? (ibanValid ? 'MOD-97 valide' : 'MOD-97 invalide') : 'Non renseigné' },
      { label: 'Taux', ok: employmentRateValid, detail: employmentRateValid ? `${draft.employee.employmentRate} %` : 'Hors plage 1–100' },
      { label: 'Chronologie', ok: chronologyValid, detail: chronologyValid ? 'Dates compatibles' : 'Naissance postérieure à la paie' },
      { label: 'Rubriques', ok: uniqueLineIds && monetaryValuesValid && !summaryLines.length, detail: uniqueLineIds && monetaryValuesValid && !summaryLines.length ? 'Structure cohérente' : 'Structure à corriger' },
      { label: 'Brut', ok: grossMatches, detail: grossMatches ? 'Somme cohérente' : 'Écart à corriger' },
      { label: 'Net', ok: netMatches, detail: netMatches ? 'Somme cohérente' : 'Écart à corriger' },
    ],
  };
}
