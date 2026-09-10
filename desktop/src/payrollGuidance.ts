import {
  assessSwissFederalProfile,
  assessSwissLppEligibility,
  assessSwissSmallSalaryEligibility,
} from './payrollEligibility';
import { familyAllowanceReferenceForCanton } from './swissFamilyAllowances2026';
import type {
  AppSettings,
  Employee,
  EmployeePayrollTemplate,
  PayrollContributionDefinition,
  PayslipLine,
} from './types';

export const PAYROLL_STEPS = [
  'Collaborateur',
  'Salaire du mois',
  'Vérification',
] as const;
export const SOURCE_TAX_TARIFFS =
  'https://www.estv.admin.ch/fr/baremes-impot-a-la-source-importation-systemes-de-comptabilite-salariale';
export const PAYROLL_BASIS_LABELS = {
  gross: 'salaire brut',
  ahv_salary: 'salaire soumis à l’AVS',
  coordinated: 'salaire coordonné LPP',
  custom: 'montant confirmé',
} as const;

/** Native schema 59 has no persisted income classification. Only a single
 * salary line can supply a base automatically; supplements require explicit bases. */
export function guidedAhvBasis(lines: PayslipLine[]) {
  const earnings = lines.filter(line => line.kind === 'earning');
  const amount = earnings[0]?.amountCents;
  return {
    requiresClassification: earnings.length > 1,
    missingEvidence: false,
    familyAllowanceCents: 0,
    amountCents: earnings.length === 1 && Number.isSafeInteger(amount) && amount >= 0 ? amount : undefined,
  };
}

/** Only monthly earnings are reusable. An hourly cost is not an hourly gross wage. */
export function recurringSalary(
  employee: Employee | undefined,
  template?: EmployeePayrollTemplate,
) {
  if (!employee || employee.salaryMode !== 'monthly') return [];
  if (template?.salaryMode === 'monthly' && template.reviewedAt) {
    if (template.recurringEarnings.length)
      return template.recurringEarnings.map((line) => ({ ...line }));
    if (template.baseSalaryCents > 0)
      return [
        {
          label: 'Salaire mensuel',
          amountCents: template.baseSalaryCents,
        },
      ];
  }
  return [
    {
      label: 'Salaire mensuel',
      amountCents: Math.max(0, employee.grossSalaryCents),
    },
  ];
}

/** A proposal from saved contracts, never a substitute for native eligibility checks. */
export function suggestPayrollDefinitions(input: {
  employee: Employee | undefined;
  settings: AppSettings;
  period: string;
  contributionDate: string;
  definitions: PayrollContributionDefinition[];
  ahvSalaryCents?: number;
  recordedGrossBeforePeriodCents?: number;
}) {
  const { employee, settings, period, contributionDate } = input;
  if (!employee || !/^2026-(0[1-9]|1[0-2])$/.test(period)) return [];
  const available = input.definitions.filter(
    (d) =>
      d.active &&
      d.effectiveFrom <= contributionDate &&
      (!d.effectiveTo || d.effectiveTo >= contributionDate),
  );
  const selected = new Set<string>();
  const birth = new Date(`${employee.birthDate}T12:00:00Z`);
  const validBirth =
    !Number.isNaN(birth.valueOf()) &&
    birth.toISOString().slice(0, 10) === employee.birthDate;
  const ageYear = 2026 - birth.getUTCFullYear();
  const federal = assessSwissFederalProfile(available);
  const add = (category: string) =>
    available
      .filter((d) => d.category === category)
      .forEach((d) => selected.add(d.id));
  const reference = employee.referenceAgeDate;
  const referenceDate = new Date(`${reference}T12:00:00Z`);
  const validReference =
    !Number.isNaN(referenceDate.valueOf()) &&
    referenceDate.toISOString().slice(0, 10) === reference;
  const smallSalary =
    input.ahvSalaryCents !== undefined &&
    input.recordedGrossBeforePeriodCents !== undefined
      ? assessSwissSmallSalaryEligibility({
          employee,
          assessmentYear: 2026,
          currentGrossCents: input.ahvSalaryCents,
          recordedGrossBeforePeriodCents: input.recordedGrossBeforePeriodCents,
          contributionDate,
          avsDefinitionsSelected: true,
          statutoryAvsLiable: validBirth ? ageYear >= 18 : null,
          retiredAllowanceKept:
            validReference &&
            reference.slice(0, 7) < period &&
            employee.avsAllowanceWaived === false,
        })
      : null;
  const federalDue = smallSalary?.contributionsDue !== false;
  if (validBirth && ageYear >= 18 && federal.avsAiApgComplete && federalDue)
    add('avs_ai_apg');
  if (
    validBirth &&
    ageYear >= 18 &&
    federal.acComplete &&
    federalDue &&
    (validReference ? reference.slice(0, 7) >= period : ageYear < 64)
  )
    add('ac');
  // Multiple contracts in a category require an explicit choice, including split AANP coverage.
  const unique = (category: string, side: 'employee' | 'employer') => {
    const candidates = available.filter(
      (d) => d.category === category && d.side === side,
    );
    if (candidates.length === 1) selected.add(candidates[0].id);
  };
  if (settings.payroll.accidentInsurer.trim()) {
    unique('aap', 'employer');
    if (
      employee.contractualWeeklyMinutes !== null &&
      employee.contractualWeeklyMinutes >= 480 &&
      !available.some((d) => d.category === 'aanp' && d.side === 'employer')
    )
      unique('aanp', 'employee');
  }
  const canton = familyAllowanceReferenceForCanton(
    settings.payroll.payrollCanton,
  );
  if (canton && settings.payroll.familyAllowanceFund.trim()) {
    unique('family_allowance', 'employer');
    if (canton.canton === 'VS') unique('family_allowance', 'employee');
  }
  const lpp = available.filter(
    (d) => d.category === 'lpp' && d.lppEmployeeId === employee.id,
  );
  const assessment = assessSwissLppEligibility({
    ...input,
    employee,
    definitions: available,
    selectedIds: new Set(lpp.map((d) => d.id)),
  });
  if (!assessment.blockers.length) lpp.forEach((d) => selected.add(d.id));
  // IJM, source tax and miscellaneous deductions are contract/situation specific.
  return available.filter((d) => selected.has(d.id));
}
