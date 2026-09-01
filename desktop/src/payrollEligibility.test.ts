import { describe, expect, it } from 'vitest';
import {
  assessSwissFederalProfile,
  assessSwissPayrollEligibility,
} from './payrollEligibility';
import type {
  AppSettings,
  Employee,
  PayrollContributionDefinition,
} from './types';

function definition(
  code: string,
  category: PayrollContributionDefinition['category'],
  side: 'employee' | 'employer',
  rateBp: number,
  annualCeilingCents: number | null = null,
): PayrollContributionDefinition {
  return {
    id: code,
    code,
    label: code,
    category,
    side,
    calculationKind: 'rate',
    rateBp,
    fixedAmountCents: null,
    annualCeilingCents,
    basisKind: 'gross',
    source: 'source officielle',
    effectiveFrom: '2026-01-01',
    effectiveTo: '2026-12-31',
    active: true,
    liabilityAccountId: '',
    expenseAccountId: '',
  };
}

const federal = [
  definition('AVS_EMPLOYEE', 'avs_ai_apg', 'employee', 435),
  definition('AVS_EMPLOYER', 'avs_ai_apg', 'employer', 435),
  definition('AI_EMPLOYEE', 'avs_ai_apg', 'employee', 70),
  definition('AI_EMPLOYER', 'avs_ai_apg', 'employer', 70),
  definition('APG_EMPLOYEE', 'avs_ai_apg', 'employee', 25),
  definition('APG_EMPLOYER', 'avs_ai_apg', 'employer', 25),
  definition('AC_EMPLOYEE', 'ac', 'employee', 110, 14_820_000),
  definition('AC_EMPLOYER', 'ac', 'employer', 110, 14_820_000),
];
const aap = definition('AAP_CONFIRMED', 'aap', 'employer', 100, 14_820_000);
const aanp = definition('AANP_CONFIRMED', 'aanp', 'employee', 100, 14_820_000);

describe('profil fédéral suisse', () => {
  it('refuse une catégorie partiellement sélectionnée', () => {
    const result = assessSwissFederalProfile(
      federal,
      new Set(['AVS_EMPLOYEE']),
    );
    expect(result.avsAiApgComplete).toBe(false);
    expect(result.issues.join(' ')).toContain('AVS_EMPLOYER');
  });

  it('exige les huit codes, les deux parts et les totaux exacts', () => {
    const result = assessSwissFederalProfile(
      federal,
      new Set(federal.map((item) => item.id)),
    );
    expect(result).toEqual({
      avsAiApgComplete: true,
      acComplete: true,
      issues: [],
    });
  });
});

describe('assujettissement par date', () => {
  const employee = {
    id: 'e',
    name: 'Test',
    birthDate: '2008-12-31',
    employmentStart: '2026-01-01',
    employmentRate: 100,
    contractualWeeklyMinutes: 2_400,
    acOpeningYear: 2026,
    acOpeningBasisCents: 0,
  } as Employee;
  const settings = {
    work: { workWeekHours: 40 },
    payroll: {
      avsFund: 'Caisse',
      accidentInsurer: 'Assureur',
      pensionFund: '',
      dailyAllowanceInsurer: '',
      familyAllowanceFund: '',
    },
  } as AppSettings;

  it('applique AVS dès janvier de l’année qui suit le 17e anniversaire', () => {
    const result = assessSwissPayrollEligibility({
      employee,
      settings,
      period: '2026-01',
      grossCents: 500_000,
      definitions: federal,
      selectedIds: new Set(),
    });
    expect(result.blockers.join(' ')).toContain('AVS_EMPLOYEE');
  });

  it('refuse une date civile normalisée implicitement par JavaScript', () => {
    const invalid = { ...employee, birthDate: '2008-02-31' };
    const result = assessSwissPayrollEligibility({
      employee: invalid,
      settings,
      period: '2026-01',
      grossCents: 500_000,
      definitions: federal,
      selectedIds: new Set(),
    });
    expect(result.blockers.join(' ')).toContain(
      'date de naissance est invalide',
    );
  });

  it('bloque la zone de l’âge de référence sans date explicite', () => {
    const older = { ...employee, birthDate: '1962-01-15' };
    const result = assessSwissPayrollEligibility({
      employee: older,
      settings,
      period: '2026-08',
      grossCents: 500_000,
      definitions: federal,
      selectedIds: new Set(federal.map((item) => item.id)),
    });
    expect(result.blockers.join(' ')).toContain('date/validation explicite');
  });

  it('refuse de déduire le seuil AANP du seul taux d’activité', () => {
    const result = assessSwissPayrollEligibility({
      employee: { ...employee, contractualWeeklyMinutes: null },
      settings,
      period: '2026-08',
      grossCents: 500_000,
      definitions: federal,
      selectedIds: new Set(),
    });
    expect(result.blockers.join(' ')).toContain(
      'horaire contractuel hebdomadaire manque',
    );
  });

  it('exige une ouverture AC annuelle explicite, y compris zéro', () => {
    const result = assessSwissPayrollEligibility({
      employee: { ...employee, acOpeningYear: null, acOpeningBasisCents: null },
      settings,
      period: '2026-08',
      grossCents: 500_000,
      definitions: federal,
      selectedIds: new Set(federal.map((item) => item.id)),
    });
    expect(result.blockers.join(' ')).toContain(
      'base d’ouverture AC 2026',
    );
  });

  it('applique le seuil AANP aux heures contractuelles explicites', () => {
    const definitions = [...federal, aap, aanp];
    const selectedWithoutAanp = new Set([
      ...federal.map((item) => item.id),
      aap.id,
    ]);
    const atThreshold = assessSwissPayrollEligibility({
      employee: { ...employee, contractualWeeklyMinutes: 480 },
      settings,
      period: '2026-08',
      grossCents: 500_000,
      definitions,
      selectedIds: selectedWithoutAanp,
    });
    expect(atThreshold.blockers.join(' ')).toContain('atteint 8 h/semaine');

    const belowThreshold = assessSwissPayrollEligibility({
      employee: { ...employee, contractualWeeklyMinutes: 479 },
      settings,
      period: '2026-08',
      grossCents: 500_000,
      definitions,
      selectedIds: new Set([...selectedWithoutAanp, aanp.id]),
    });
    expect(belowThreshold.blockers.join(' ')).toContain(
      'moins de 8 h/semaine',
    );
  });

  it('refuse une prime LAA fixe ou privée du plafond fédéral 2026', () => {
    const invalidAap = {
      ...aap,
      calculationKind: 'fixed' as const,
      rateBp: null,
      fixedAmountCents: 100,
      annualCeilingCents: null,
    };
    const result = assessSwissPayrollEligibility({
      employee: { ...employee, contractualWeeklyMinutes: 479 },
      settings,
      period: '2026-08',
      grossCents: 500_000,
      definitions: [...federal, invalidAap],
      selectedIds: new Set([
        ...federal.map((item) => item.id),
        invalidAap.id,
      ]),
    });
    expect(result.blockers.join(' ')).toContain(
      'plafond fédéral 2026 de CHF 148’200',
    );
  });

  it('conserve l’AC pendant le mois d’atteinte puis l’interdit le mois suivant', () => {
    const older = {
      ...employee,
      birthDate: '1962-09-15',
      referenceAgeDate: '2026-09-15',
      avsAllowanceWaived: false,
    } as Employee;
    const selectedIds = new Set(federal.map((item) => item.id));
    const september = assessSwissPayrollEligibility({
      employee: older,
      settings,
      period: '2026-09',
      grossCents: 500_000,
      definitions: federal,
      selectedIds,
    });
    expect(september.blockers.join(' ')).not.toContain('retirez l’AC');
    const october = assessSwissPayrollEligibility({
      employee: older,
      settings,
      period: '2026-10',
      grossCents: 500_000,
      definitions: federal,
      selectedIds,
    });
    expect(october.blockers.join(' ')).toContain('retirez l’AC');
  });
});
