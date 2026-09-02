import { describe, expect, it } from 'vitest';
import {
  assessSwissFederalProfile,
  assessSwissLppEligibility,
  assessSwissPayrollEligibility,
  assessSwissSmallSalaryEligibility,
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
    basisKind: category === 'aap' || category === 'aanp' || category === 'family_allowance'
      ? 'ahv_salary'
      : 'gross',
    lppComponent: null,
    lppEmployeeId: null,
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

const lppSettings = {
  payroll: {
    avsFund: '',
    accidentInsurer: '',
    pensionFund: 'Fondation Exemple',
    dailyAllowanceInsurer: '',
    familyAllowanceFund: '',
    payrollCanton: 'VD',
    lppPlanEvidence: {
      contractNumber: 'LPP-2026-0042',
      regulationReference: 'Règlement LPP 2026, édition signée',
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-12-31',
      employerAggregateShareConfirmed: true,
    },
  },
} as AppSettings;

function lppDefinition(
  employeeId = 'e',
  component: 'risk' | 'savings' | 'combined' = 'combined',
): PayrollContributionDefinition {
  return {
    id: `LPP_${employeeId}_${component}`,
    code: `LPP_${component.toUpperCase()}`,
    label: `LPP ${component}`,
    category: 'lpp',
    side: 'employee',
    calculationKind: 'fixed',
    rateBp: null,
    fixedAmountCents: 24_500,
    annualCeilingCents: null,
    basisKind: 'coordinated',
    source: 'Règlement LPP 2026, édition signée',
    effectiveFrom: '2026-01-01',
    effectiveTo: '2026-12-31',
    active: true,
    liabilityAccountId: '',
    expenseAccountId: '',
    lppComponent: component,
    lppEmployeeId: employeeId,
  } as PayrollContributionDefinition;
}

function lppEmployee(
  patch: Partial<Employee> & Record<string, unknown> = {},
): Employee {
  return {
    id: 'e',
    name: 'Test LPP',
    birthDate: '1990-06-15',
    employmentStart: '2020-01-01',
    employmentEnd: '',
    employmentContractKind: 'indefinite',
    lppAssessmentYear: 2026,
    lppAnnualSalaryCents: 8_000_000,
    lppExceptionCode: '',
    lppExceptionEvidenceReference: '',
    ...patch,
  } as Employee;
}

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

    const wrongBasis = { ...aap, basisKind: 'gross' as const };
    const wrongBasisResult = assessSwissPayrollEligibility({
      employee: { ...employee, contractualWeeklyMinutes: 479 },
      settings,
      period: '2026-08',
      grossCents: 500_000,
      definitions: [...federal, wrongBasis],
      selectedIds: new Set([...federal.map((item) => item.id), wrongBasis.id]),
    });
    expect(wrongBasisResult.blockers.join(' ')).toContain('assiette salaire AVS');
  });

  it('refuse une CAF fixe, plafonnée ou calculée hors salaire AVS', () => {
    const validCaf = definition('CAF_EMPLOYER', 'family_allowance', 'employer', 200);
    for (const invalidCaf of [
      { ...validCaf, calculationKind: 'fixed' as const, rateBp: null, fixedAmountCents: 2_000 },
      { ...validCaf, basisKind: 'gross' as const },
      { ...validCaf, annualCeilingCents: 10_000_000 },
    ]) {
      const result = assessSwissPayrollEligibility({
        employee: { ...employee, contractualWeeklyMinutes: 479 },
        settings: {
          ...settings,
          payroll: { ...settings.payroll, familyAllowanceFund: 'CAF cantonale', payrollCanton: 'VD' },
        },
        period: '2026-08',
        grossCents: 500_000,
        definitions: [...federal, aap, invalidCaf],
        selectedIds: new Set([...federal.map((item) => item.id), aap.id, invalidCaf.id]),
      });
      expect(result.blockers.join(' ')).toContain('Chaque cotisation CAF');
    }
  });

  it('exige une convention structurée pour une part AANP employeur', () => {
    const employerAanp = {
      ...definition('AANP_EMPLOYER', 'aanp', 'employer', 100, 14_820_000),
      source: 'Police LAA 2026, clause 8',
    };
    const definitions = [...federal, aap, employerAanp];
    const selectedIds = new Set(definitions.map((item) => item.id));
    const withoutEvidence = assessSwissPayrollEligibility({
      employee,
      settings,
      period: '2026-08',
      grossCents: 500_000,
      definitions,
      selectedIds,
    });
    expect(withoutEvidence.blockers.join(' ')).toContain(
      'convention plus favorable structurée',
    );

    const withEvidence = assessSwissPayrollEligibility({
      employee,
      settings: {
        ...settings,
        payroll: {
          ...settings.payroll,
          aanpEmployerCoverage: {
            enabled: true,
            reference: 'Police LAA 2026, clause 8',
            effectiveFrom: '2026-01-01',
            effectiveTo: '2026-12-31',
          },
        },
      },
      period: '2026-08',
      grossCents: 500_000,
      definitions,
      selectedIds,
    });
    expect(withEvidence.blockers.join(' ')).not.toContain(
      'convention plus favorable structurée',
    );
    expect(withEvidence.blockers.join(' ')).not.toContain(
      'source de chaque définition AANP employeur',
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

describe('miroir LPP 2026', () => {
  it('utilise seulement le salaire annuel LPP confirmé, jamais le brut mensuel multiplié par douze', () => {
    const result = assessSwissLppEligibility({
      employee: lppEmployee({ lppAnnualSalaryCents: 2_268_000 }),
      settings: lppSettings,
      period: '2026-08',
      definitions: [],
      selectedIds: new Set(),
    });
    expect(result.status).toContain('sous le seuil légal');
    expect(result.blockers.join(' ')).not.toContain('LPP est obligatoire');
    expect(result.annualSalaryCents).toBe(2_268_000);
  });

  it('bloque une LPP obligatoire sans définition liée au collaborateur', () => {
    const result = assessSwissLppEligibility({
      employee: lppEmployee(),
      settings: lppSettings,
      period: '2026-08',
      definitions: [],
      selectedIds: new Set(),
    });
    expect(result.status).toBe('Obligatoire · risque et épargne');
    expect(result.blockers.join(' ')).toContain('LPP est obligatoire');
    expect(result.coordinatedAnnualSalaryCents).toBe(5_354_000);
  });

  it('exige une évaluation annuelle explicite pour décider', () => {
    const result = assessSwissLppEligibility({
      employee: lppEmployee({
        lppAssessmentYear: null,
        lppAnnualSalaryCents: null,
      }),
      settings: lppSettings,
      period: '2026-08',
      definitions: [],
      selectedIds: new Set(),
    });
    expect(result.status).toBe('Évaluation annuelle requise');
    expect(result.blockers.join(' ')).toContain('salaire annuel LPP');
  });

  it('présente sans l’interdire un plan plus favorable avant l’âge légal', () => {
    const definition = { ...lppDefinition(), basisKind: 'custom' as const };
    const result = assessSwissLppEligibility({
      employee: lppEmployee({ birthDate: '2010-01-01' }),
      settings: lppSettings,
      period: '2026-08',
      definitions: [definition],
      selectedIds: new Set([definition.id]),
    });
    expect(result.status).toContain('Plan plus favorable');
    expect(result.blockers).toEqual([]);
    expect(result.warnings.join(' ')).toContain('plan plus favorable');
  });

  it('réserve la base coordonnée au salaire coordonné légal calculé', () => {
    const definition = lppDefinition();
    const result = assessSwissLppEligibility({
      employee: lppEmployee({ lppAnnualSalaryCents: 2_000_000 }),
      settings: lppSettings,
      period: '2026-08',
      definitions: [definition],
      selectedIds: new Set([definition.id]),
    });
    expect(result.blockers.join(' ')).toContain(
      'base « salaire coordonné » est réservée',
    );
  });

  it('borne le salaire coordonné légal sans inventer de taux de caisse', () => {
    const definition = lppDefinition();
    const result = assessSwissLppEligibility({
      employee: lppEmployee({ lppAnnualSalaryCents: 50_000_000 }),
      settings: lppSettings,
      period: '2026-08',
      definitions: [definition],
      selectedIds: new Set([definition.id]),
    });
    expect(result.coordinatedAnnualSalaryCents).toBe(6_426_000);
    expect(result.blockers).toEqual([]);
  });

  it('contrôle la fenêtre du règlement à la date de cotisation effective', () => {
    const definition = {
      ...lppDefinition(),
      effectiveTo: '2026-12-31',
    };
    const result = assessSwissLppEligibility({
      employee: lppEmployee(),
      settings: {
        ...lppSettings,
        payroll: {
          ...lppSettings.payroll,
          lppPlanEvidence: {
            ...lppSettings.payroll.lppPlanEvidence,
            effectiveTo: '2026-06-30',
          },
        },
      } as AppSettings,
      period: '2026-06',
      contributionDate: '2026-07-02',
      definitions: [definition],
      selectedIds: new Set([definition.id]),
    });
    expect(result.blockers.join(' ')).toContain(
      'date réglementaire 2026-07-02 sort de la fenêtre',
    );
  });

  it('exige la composante épargne dès l’année suivant le 24e anniversaire', () => {
    const risk = lppDefinition('e', 'risk');
    const result = assessSwissLppEligibility({
      employee: lppEmployee({ birthDate: '1990-06-15' }),
      settings: lppSettings,
      period: '2026-08',
      definitions: [risk],
      selectedIds: new Set([risk.id]),
    });
    expect(result.blockers.join(' ')).toContain('composante épargne');
  });

  it('accepte une exception de contrat court uniquement avec sa preuve', () => {
    const result = assessSwissLppEligibility({
      employee: lppEmployee({
        employmentContractKind: 'fixed',
        employmentStart: '2026-01-01',
        employmentEnd: '2026-03-31',
        lppExceptionCode: 'short_fixed_contract',
        lppExceptionEvidenceReference: 'Contrat signé C-2026-001',
      }),
      settings: lppSettings,
      period: '2026-03',
      definitions: [],
      selectedIds: new Set(),
    });
    expect(result.status).toBe('Exception documentée');
    expect(result.blockers).toEqual([]);
  });

  it('ne réintroduit pas l’avertissement fictif CHF 2’500 dérivé du mois', () => {
    const employee = lppEmployee({
      birthDate: '2010-01-01',
      contractualWeeklyMinutes: 400,
    });
    const result = assessSwissPayrollEligibility({
      employee,
      settings: lppSettings,
      period: '2026-08',
      grossCents: 100_000,
      definitions: [],
      selectedIds: new Set(),
    });
    expect(result.warnings.join(' ')).not.toContain('2’500');
    expect(result.facts.map((fact) => fact.label)).not.toContain(
      'Salaire annualisé',
    );
  });
});

describe('salaires de minime importance', () => {
  const employee = {
    id: 'minor-salary-employee',
    name: 'Petit salaire',
    birthDate: '1990-06-15',
    smallSalaryAssessmentYear: 2026,
    smallSalarySector: 'ordinary',
    smallSalaryEmployeeRequestedContributions: false,
    smallSalaryDecisionDate: '2026-01-05',
    smallSalaryOpeningGrossCents: 0,
    smallSalaryOpeningContributedBasisCents: 0,
    smallSalaryEvidenceReference: 'Décision signée 2026',
  } as Employee;

  it('applique la dispense ordinaire jusqu’à CHF 2’500 sans demande', () => {
    const result = assessSwissSmallSalaryEligibility({
      employee,
      assessmentYear: 2026,
      currentGrossCents: 50_000,
      recordedGrossBeforePeriodCents: 199_999,
      contributionDate: '2026-06-30',
      avsDefinitionsSelected: false,
      statutoryAvsLiable: true,
      retiredAllowanceKept: false,
    });
    expect(result.contributionsDue).toBe(false);
    expect(result.cumulativeGrossCents).toBe(249_999);
    expect(result.blockers).toEqual([]);
  });

  it('annonce le rattrapage sur le total au franchissement du seuil', () => {
    const result = assessSwissSmallSalaryEligibility({
      employee,
      assessmentYear: 2026,
      currentGrossCents: 50_001,
      recordedGrossBeforePeriodCents: 200_000,
      contributionDate: '2026-06-30',
      avsDefinitionsSelected: false,
      statutoryAvsLiable: true,
      retiredAllowanceKept: false,
    });
    expect(result.contributionsDue).toBe(true);
    expect(result.blockers.join(' ')).toContain('profil fédéral complet');
    expect(result.warnings.join(' ')).toContain('salaire annuel total');
  });

  it('conserve l’exception ménage pendant toute l’année des 25 ans', () => {
    const stillYouth = assessSwissSmallSalaryEligibility({
      employee: {
        ...employee,
        birthDate: '2001-01-01',
        smallSalarySector: 'private_household',
      },
      assessmentYear: 2026,
      currentGrossCents: 75_000,
      recordedGrossBeforePeriodCents: 0,
      contributionDate: '2026-06-30',
      avsDefinitionsSelected: false,
      statutoryAvsLiable: true,
      retiredAllowanceKept: false,
    });
    expect(stillYouth.contributionsDue).toBe(false);
    expect(stillYouth.thresholdCents).toBe(75_000);

    const afterYouthYear = assessSwissSmallSalaryEligibility({
      employee: {
        ...employee,
        birthDate: '2000-12-31',
        smallSalarySector: 'private_household',
      },
      assessmentYear: 2026,
      currentGrossCents: 1,
      recordedGrossBeforePeriodCents: 0,
      contributionDate: '2026-06-30',
      avsDefinitionsSelected: true,
      statutoryAvsLiable: true,
      retiredAllowanceKept: false,
    });
    expect(afterYouthYear.contributionsDue).toBe(true);
  });

  it('impose les cotisations dès le premier franc dans les arts et la culture', () => {
    const result = assessSwissSmallSalaryEligibility({
      employee: { ...employee, smallSalarySector: 'arts_culture' },
      assessmentYear: 2026,
      currentGrossCents: 1,
      recordedGrossBeforePeriodCents: 0,
      contributionDate: '2026-06-30',
      avsDefinitionsSelected: true,
      statutoryAvsLiable: true,
      retiredAllowanceKept: false,
    });
    expect(result.contributionsDue).toBe(true);
    expect(result.decision).toContain('premier franc');
  });

  it('explique la portée prospective d’une demande tardive', () => {
    const requestedEmployee = {
        ...employee,
        smallSalaryEmployeeRequestedContributions: true,
        smallSalaryDecisionDate: '2026-06-30',
      } as Employee;
    const beforeDecision = assessSwissSmallSalaryEligibility({
      employee: requestedEmployee,
      assessmentYear: 2026,
      currentGrossCents: 10_000,
      recordedGrossBeforePeriodCents: 50_000,
      contributionDate: '2026-05-31',
      avsDefinitionsSelected: false,
      statutoryAvsLiable: true,
      retiredAllowanceKept: false,
    });
    expect(beforeDecision.contributionsDue).toBe(false);

    const result = assessSwissSmallSalaryEligibility({
      employee: requestedEmployee,
      assessmentYear: 2026,
      currentGrossCents: 10_000,
      recordedGrossBeforePeriodCents: 50_000,
      contributionDate: '2026-07-31',
      avsDefinitionsSelected: true,
      statutoryAvsLiable: true,
      retiredAllowanceKept: false,
    });
    expect(result.warnings.join(' ')).toContain('prospectivement');
    expect(result.warnings.join(' ')).toContain('dépassement ultérieur');
  });

  it('refuse de cumuler la dispense et la franchise après l’âge de référence', () => {
    const result = assessSwissSmallSalaryEligibility({
      employee,
      assessmentYear: 2026,
      currentGrossCents: 10_000,
      recordedGrossBeforePeriodCents: 0,
      contributionDate: '2026-06-30',
      avsDefinitionsSelected: false,
      statutoryAvsLiable: true,
      retiredAllowanceKept: true,
    });
    expect(result.blockers.join(' ')).toContain('ne peut pas être cumulée');
  });

  it('ne bloque pas la décision absente avant le début de l’obligation AVS', () => {
    const underage = {
      ...employee,
      birthDate: '2010-01-01',
      smallSalaryAssessmentYear: null,
      smallSalarySector: null,
      smallSalaryEmployeeRequestedContributions: null,
      smallSalaryDecisionDate: '',
      smallSalaryOpeningGrossCents: null,
      smallSalaryOpeningContributedBasisCents: null,
      smallSalaryEvidenceReference: '',
      employmentStart: '2026-01-01',
      contractualWeeklyMinutes: 200,
    } as Employee;
    const result = assessSwissPayrollEligibility({
      employee: underage,
      settings: {
        payroll: {
          avsFund: 'Caisse',
          accidentInsurer: 'Assureur',
          pensionFund: '',
          dailyAllowanceInsurer: '',
          familyAllowanceFund: '',
        },
      } as AppSettings,
      period: '2026-01',
      grossCents: 20_000,
      definitions: [],
      selectedIds: new Set(),
    });
    expect(result.blockers.join(' ')).not.toContain(
      'Configurez la décision annuelle « salaire de minime importance »',
    );
  });

  it('autorise l’absence d’AAP quand l’exception LAA est structurée', () => {
    const result = assessSwissPayrollEligibility({
      employee: {
        ...employee,
        employmentStart: '2026-01-01',
        contractualWeeklyMinutes: 200,
      } as Employee,
      settings: {
        payroll: {
          avsFund: 'Caisse',
          accidentInsurer: 'Assureur',
          pensionFund: '',
          dailyAllowanceInsurer: '',
          familyAllowanceFund: '',
          laaSmallSalaryException: {
            enabled: true,
            assessmentYear: 2026,
            evidenceReference: 'Contrôle annuel signé LAA-2026',
            confirmedAllEmployeesOnlyMinorSalaries: true,
          },
        },
      } as AppSettings,
      period: '2026-02',
      grossCents: 20_000,
      definitions: [],
      selectedIds: new Set(),
    });
    expect(result.blockers.join(' ')).not.toContain(
      'prime accidents professionnels AAP doit être configurée',
    );
    expect(result.warnings.join(' ')).toContain(
      'tous les salariés concernés pendant l’année',
    );
    const laaFact = result.facts.find(
      (fact) => fact.label === 'Exception LAA entreprise',
    );
    expect(laaFact?.value).toContain(
      'contrôle global au moment de valider',
    );
    expect(laaFact?.value.toLowerCase()).not.toContain('prête');

    const withRealCoverage = assessSwissPayrollEligibility({
      employee: {
        ...employee,
        employmentStart: '2026-01-01',
        contractualWeeklyMinutes: 200,
      } as Employee,
      settings: {
        payroll: {
          avsFund: 'Caisse',
          accidentInsurer: 'Assureur',
          pensionFund: '',
          dailyAllowanceInsurer: '',
          familyAllowanceFund: '',
          laaSmallSalaryException: {
            enabled: true,
            assessmentYear: 2026,
            evidenceReference: 'Contrôle annuel signé LAA-2026',
            confirmedAllEmployeesOnlyMinorSalaries: true,
          },
        },
      } as AppSettings,
      period: '2026-02',
      grossCents: 20_000,
      definitions: [aap],
      selectedIds: new Set([aap.id]),
    });
    expect(withRealCoverage.blockers.join(' ')).not.toContain(
      'AAP est sélectionnée alors que l’exception',
    );
  });
});
