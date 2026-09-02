import type { Employee, Payslip } from './types';

export type SmallSalaryEmployeeFormDraft = {
  assessmentYear: string;
  sector: string;
  employeeRequestedContributions: string;
  decisionDate: string;
  openingGross: string;
  openingContributedBasis: string;
  evidenceReference: string;
};

export type SmallSalaryEmployeeFields = Pick<
  Employee,
  | 'smallSalaryAssessmentYear'
  | 'smallSalarySector'
  | 'smallSalaryEmployeeRequestedContributions'
  | 'smallSalaryDecisionDate'
  | 'smallSalaryOpeningGrossCents'
  | 'smallSalaryOpeningContributedBasisCents'
  | 'smallSalaryEvidenceReference'
>;

const EMPTY_SMALL_SALARY_FIELDS: SmallSalaryEmployeeFields = {
  smallSalaryAssessmentYear: null,
  smallSalarySector: null,
  smallSalaryEmployeeRequestedContributions: null,
  smallSalaryDecisionDate: '',
  smallSalaryOpeningGrossCents: null,
  smallSalaryOpeningContributedBasisCents: null,
  smallSalaryEvidenceReference: '',
};

function parseFrancAmount(value: string, label: string): number {
  const normalized = value
    .trim()
    .replace(/[\s'’]/g, '')
    .replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized))
    throw new Error(`${label} doit être un montant positif avec au maximum deux décimales.`);
  const francs = Number(normalized);
  if (!Number.isFinite(francs) || francs < 0)
    throw new Error(`${label} doit être un montant positif ou zéro.`);
  return Math.round(francs * 100);
}

function isRealIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * Transforme la section annuelle du formulaire collaborateur en un bloc
 * atomique. Un ancien dossier peut rester entièrement vide; dès qu'une valeur
 * est saisie, toutes les décisions et ouvertures doivent être explicites.
 */
export function parseSmallSalaryEmployeeForm(
  draft: SmallSalaryEmployeeFormDraft,
): SmallSalaryEmployeeFields {
  const normalized = {
    assessmentYear: draft.assessmentYear.trim(),
    sector: draft.sector.trim(),
    employeeRequestedContributions:
      draft.employeeRequestedContributions.trim(),
    decisionDate: draft.decisionDate.trim(),
    openingGross: draft.openingGross.trim(),
    openingContributedBasis: draft.openingContributedBasis.trim(),
    evidenceReference: draft.evidenceReference.trim(),
  };
  if (!Object.values(normalized).some((value) => value !== ''))
    return { ...EMPTY_SMALL_SALARY_FIELDS };

  const missing = [
    ['année', normalized.assessmentYear],
    ['secteur', normalized.sector],
    ['choix du salarié', normalized.employeeRequestedContributions],
    ['date de décision', normalized.decisionDate],
    ['brut d’ouverture', normalized.openingGross],
    ['base déjà cotisée', normalized.openingContributedBasis],
    ['référence de preuve', normalized.evidenceReference],
  ]
    .filter(([, value]) => value === '')
    .map(([label]) => label);
  if (missing.length)
    throw new Error(
      `Complétez toute la décision annuelle « salaire de minime importance » : ${missing.join(', ')}. Saisissez 0 lorsqu’une ouverture est réellement nulle.`,
    );

  const assessmentYear = Number(normalized.assessmentYear);
  if (
    !/^\d{4}$/.test(normalized.assessmentYear) ||
    !Number.isInteger(assessmentYear) ||
    assessmentYear < 2000 ||
    assessmentYear > 9999
  )
    throw new Error('L’année d’évaluation des petits salaires doit contenir quatre chiffres.');

  if (
    normalized.sector !== 'ordinary' &&
    normalized.sector !== 'private_household' &&
    normalized.sector !== 'arts_culture'
  )
    throw new Error('Choisissez le secteur réel pour la décision annuelle.');
  if (
    normalized.employeeRequestedContributions !== 'yes' &&
    normalized.employeeRequestedContributions !== 'no'
  )
    throw new Error('Confirmez explicitement si le salarié a demandé les cotisations.');
  if (
    !isRealIsoDate(normalized.decisionDate) ||
    normalized.decisionDate.slice(0, 4) !== normalized.assessmentYear
  )
    throw new Error(
      'La date de décision/demande doit être une date réelle dans l’année d’évaluation.',
    );

  const openingGrossCents = parseFrancAmount(
    normalized.openingGross,
    'Le brut d’ouverture',
  );
  const openingContributedBasisCents = parseFrancAmount(
    normalized.openingContributedBasis,
    'La base déjà cotisée',
  );
  if (openingContributedBasisCents > openingGrossCents)
    throw new Error(
      'La base déjà cotisée ne peut pas dépasser le brut d’ouverture de la même année.',
    );
  if (normalized.evidenceReference.length > 500)
    throw new Error('La référence de preuve est limitée à 500 caractères.');

  return {
    smallSalaryAssessmentYear: assessmentYear,
    smallSalarySector: normalized.sector,
    smallSalaryEmployeeRequestedContributions:
      normalized.employeeRequestedContributions === 'yes',
    smallSalaryDecisionDate: normalized.decisionDate,
    smallSalaryOpeningGrossCents: openingGrossCents,
    smallSalaryOpeningContributedBasisCents:
      openingContributedBasisCents,
    smallSalaryEvidenceReference: normalized.evidenceReference,
  };
}

export function smallSalarySectorLabel(
  sector: Employee['smallSalarySector'],
): string {
  if (sector === 'ordinary') return 'Secteur ordinaire';
  if (sector === 'private_household') return 'Ménage privé';
  if (sector === 'arts_culture') return 'Arts et culture';
  return 'À confirmer';
}

export function smallSalaryReasonLabel(reasonCode: string): string {
  const labels: Record<string, string> = {
    ordinary_minor_salary_exempt: 'Dispense ordinaire sous le seuil annuel',
    ordinary_below_threshold: 'Dispense ordinaire sous le seuil annuel',
    ordinary_employee_request: 'Cotisations demandées par le salarié',
    ordinary_threshold_exceeded: 'Seuil annuel ordinaire dépassé',
    employee_requested_contributions: 'Cotisations demandées par le salarié',
    private_household_mandatory: 'Cotisations obligatoires en ménage privé',
    private_household_youth_minor_salary_exempt:
      'Dispense jeune en ménage privé sous le seuil annuel',
    private_household_youth_below_threshold:
      'Dispense jeune en ménage privé sous le seuil annuel',
    private_household_youth_employee_request:
      'Cotisations demandées par le jeune salarié',
    private_household_youth_threshold_exceeded:
      'Seuil annuel jeune en ménage privé dépassé',
    arts_culture_mandatory: 'Cotisations obligatoires dans les arts et la culture',
  };
  return labels[reasonCode] ?? reasonCode.replaceAll('_', ' ');
}

/** Cumul d'aperçu aligné sur les statuts retenus par le moteur annuel. */
export function recordedSmallSalaryGrossBeforePeriod(input: {
  payslips: Payslip[];
  employeeId: string;
  period: string;
  excludedPayslipId?: string;
}): number {
  if (!input.employeeId || !/^\d{4}-\d{2}$/.test(input.period)) return 0;
  const yearPrefix = `${input.period.slice(0, 4)}-`;
  const retainedStatuses = new Set<Payslip['status']>([
    'validated',
    'posted',
    'paid',
  ]);
  return input.payslips
    .filter(
      (payslip) =>
        payslip.id !== input.excludedPayslipId &&
        payslip.employeeId === input.employeeId &&
        payslip.period.startsWith(yearPrefix) &&
        payslip.period < input.period &&
        retainedStatuses.has(payslip.status),
    )
    .reduce(
      (sum, payslip) =>
        sum +
        payslip.lines
          .filter((line) => line.kind === 'earning')
          .reduce((lineSum, line) => lineSum + line.amountCents, 0),
      0,
    );
}
