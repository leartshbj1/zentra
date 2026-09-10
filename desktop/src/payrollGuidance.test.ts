import { describe, expect, it } from 'vitest';
import {
  guidedAhvBasis,
  recurringSalary,
  suggestPayrollDefinitions,
} from './payrollGuidance';
import { initialOnboardingSettings } from './onboardingDraft';
import { SWISS_FAMILY_ALLOWANCES_2026 } from './swissFamilyAllowances2026';
import type {
  Employee,
  EmployeePayrollTemplate,
  PayrollContributionDefinition,
  PayslipLine,
} from './types';

describe('native 59 salary basis proposals', () => {
  const salary: PayslipLine = {id: 'salary', label: 'Salaire', kind: 'earning', amountCents: 500000};
  it('proposes one ordinary salary and excludes reimbursements', () => {
    expect(guidedAhvBasis([salary]).amountCents).toBe(500000);
    expect(guidedAhvBasis([salary, {...salary, kind: 'reimbursement'}]).amountCents).toBe(500000);
  });
  it('requires an explicit basis for supplements without guessing their tax treatment', () => {
    expect(guidedAhvBasis([salary, {...salary, id: 'family', label: 'Allocation'}]).amountCents).toBeUndefined();
    expect(guidedAhvBasis([salary, {...salary, id: 'bonus', label: 'Prime'}]).requiresClassification).toBe(true);
  });
  it('rejects missing, negative or unsafe amounts', () => {
    for (const lines of [[], [{...salary, amountCents: -1}], [{...salary, amountCents: Number.MAX_SAFE_INTEGER + 1}]]) expect(guidedAhvBasis(lines).amountCents).toBeUndefined();
  });
});

const employee = {
  id: 'one',
  birthDate: '1990-05-01',
  referenceAgeDate: '',
  salaryMode: 'monthly',
  grossSalaryCents: 450000,
  contractualWeeklyMinutes: 2400,
} as Employee;
function definition(
  code: string,
  category: PayrollContributionDefinition['category'],
  side: 'employee' | 'employer',
  rateBp: number,
): PayrollContributionDefinition {
  return {
    id: code,
    code,
    category,
    side,
    label: code,
    calculationKind: 'rate',
    rateBp,
    fixedAmountCents: null,
    annualCeilingCents: category === 'ac' ? 14820000 : null,
    basisKind: 'gross',
    lppComponent: null,
    lppEmployeeId: null,
    source: 'Police confirmée 2026',
    effectiveFrom: '2026-01-01',
    effectiveTo: '2026-12-31',
    active: true,
    liabilityAccountId: '',
    expenseAccountId: '',
  };
}
const definitions = [
  ...(['employee', 'employer'] as const).flatMap((side) => [
    definition(`AVS_${side.toUpperCase()}`, 'avs_ai_apg', side, 435),
    definition(`AI_${side.toUpperCase()}`, 'avs_ai_apg', side, 70),
    definition(`APG_${side.toUpperCase()}`, 'avs_ai_apg', side, 25),
    definition(`AC_${side.toUpperCase()}`, 'ac', side, 110),
  ]),
  definition('aap', 'aap', 'employer', 100),
  definition('aanp', 'aanp', 'employee', 100),
  definition('caf', 'family_allowance', 'employer', 200),
  definition('caf_vs', 'family_allowance', 'employee', 13),
  definition('tax', 'source_tax', 'employee', 700),
  definition('ijm', 'ijm', 'employee', 50),
];
function input(canton = 'VD') {
  return {
    employee,
    settings: {
      ...initialOnboardingSettings,
      payroll: {
        ...initialOnboardingSettings.payroll,
        payrollCanton: canton,
        accidentInsurer: 'LAA',
        familyAllowanceFund: 'CAF',
      },
    },
    period: '2026-09',
    contributionDate: '2026-09-30',
    definitions,
  };
}
describe('guided payroll suggestions', () => {
  it('proposes AVS/AC only when the confirmed annual small-salary assessment requires them', () => {
    const profile = input();
    const confirmed = {
      ...profile,
      employee: {
        ...employee,
        smallSalaryAssessmentYear: 2026,
        smallSalarySector: 'ordinary' as const,
        smallSalaryEmployeeRequestedContributions: false,
        smallSalaryDecisionDate: '2026-01-01',
        smallSalaryOpeningGrossCents: 0,
        smallSalaryOpeningContributedBasisCents: 0,
        smallSalaryEvidenceReference: 'Décision annuelle 2026',
      },
      recordedGrossBeforePeriodCents: 160000,
    };
    const federal = (amount: number) =>
      suggestPayrollDefinitions({
        ...confirmed,
        ahvSalaryCents: amount,
      }).filter((definition) =>
        ['avs_ai_apg', 'ac'].includes(definition.category),
      );
    expect(federal(90000)).toHaveLength(0);
    expect(federal(90001)).toHaveLength(8);
    expect(
      suggestPayrollDefinitions({
        ...confirmed,
        ahvSalaryCents: 90000,
        employee: {
          ...confirmed.employee,
          smallSalaryEmployeeRequestedContributions: true,
        },
      }).filter((definition) =>
        ['avs_ai_apg', 'ac'].includes(definition.category),
      ),
    ).toHaveLength(8);
  });
  it.each(SWISS_FAMILY_ALLOWANCES_2026.map((c) => c.canton))(
    'retains the federal profile and correct CAF side for %s',
    (canton) => {
      const selected = suggestPayrollDefinitions(input(canton));
      expect(
        selected.filter((d) => ['avs_ai_apg', 'ac'].includes(d.category)),
      ).toHaveLength(8);
      expect(selected.some((d) => d.id === 'caf_vs')).toBe(canton === 'VS');
      expect(
        selected.some((d) => ['source_tax', 'ijm'].includes(d.category)),
      ).toBe(false);
    },
  );
  it('respects age thresholds, hours and the month after retirement', () => {
    expect(
      suggestPayrollDefinitions({
        ...input(),
        employee: {
          ...employee,
          birthDate: '2010-01-01',
          contractualWeeklyMinutes: 479,
        },
      }).map((d) => d.id),
    ).toEqual(['aap', 'caf']);
    const retired = {
      ...employee,
      birthDate: '1961-09-01',
      referenceAgeDate: '2026-09-01',
    };
    expect(
      suggestPayrollDefinitions({ ...input(), employee: retired }).filter(
        (d) => d.category === 'ac',
      ),
    ).toHaveLength(2);
    expect(
      suggestPayrollDefinitions({
        ...input(),
        period: '2026-10',
        contributionDate: '2026-10-01',
        employee: retired,
      }).some((d) => d.category === 'ac'),
    ).toBe(false);
  });
  it('does not guess among insurance contracts or reuse expired profiles', () => {
    expect(
      suggestPayrollDefinitions({
        ...input(),
        definitions: [
          ...definitions,
          { ...definitions[8], id: 'other-policy' },
        ],
      }).some((d) => d.category === 'aap'),
    ).toBe(false);
    expect(
      suggestPayrollDefinitions({
        ...input(),
        period: '2027-01',
        contributionDate: '2027-01-01',
      }),
    ).toEqual([]);
    expect(
      suggestPayrollDefinitions({ ...input(), contributionDate: '2027-01-01' }),
    ).toEqual([]);
    expect(
      suggestPayrollDefinitions({
        ...input(),
        employee: { ...employee, birthDate: '1990-02-31' },
      }).some((d) => ['avs_ai_apg', 'ac'].includes(d.category)),
    ).toBe(false);
  });
  it('rejects a duplicate federal rate and excludes another employee pension', () => {
    const duplicate = { ...definitions[0], id: 'duplicate' };
    expect(
      suggestPayrollDefinitions({
        ...input(),
        definitions: [...definitions, duplicate],
      }).some((d) => d.category === 'avs_ai_apg'),
    ).toBe(false);
    expect(
      suggestPayrollDefinitions({
        ...input(),
        definitions: [
          ...definitions,
          {
            ...definitions[0],
            id: 'lpp-other',
            category: 'lpp',
            lppEmployeeId: 'other',
          },
        ],
      }).some((d) => d.category === 'lpp'),
    ).toBe(false);
  });
  it('reuses the agreed monthly salary without multiplying the employment rate', () => {
    expect(recurringSalary({ ...employee, employmentRate: 50 })).toEqual([
      {
        label: 'Salaire mensuel',
        amountCents: 450000,
      },
    ]);
    const template = {
      salaryMode: 'monthly',
      reviewedAt: '2026-09-01',
      recurringEarnings: [{ label: 'Salaire confirmé', amountCents: 460000 }],
    } as EmployeePayrollTemplate;
    expect(recurringSalary(employee, template)[0].amountCents).toBe(460000);
    expect(
      recurringSalary(
        { ...employee, salaryMode: 'hourly', hourlyCostCents: 6000 },
        template,
      ),
    ).toEqual([]);
  });
});
