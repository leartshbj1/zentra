import { describe, expect, it } from 'vitest';
import {
  assessSwissPayrollInsuranceReadiness as assessSwissPayrollInsuranceReadinessForDate,
  SWISS_FEDERAL_SOCIAL_INSURANCE_2026_SOURCE,
  SWISS_LAA_ANNUAL_CEILING_CENTS_2026,
  swissPayrollReferenceDate,
} from './swissPayrollInsuranceReadiness';
import { initialOnboardingSettings } from './onboardingDraft';
import type { PayrollContributionDefinition } from './types';

const assessSwissPayrollInsuranceReadiness = (
  input: Parameters<typeof assessSwissPayrollInsuranceReadinessForDate>[0],
) => assessSwissPayrollInsuranceReadinessForDate({
  ...input,
  asOf: input.asOf ?? '2026-06-30',
});

function definition(
  category: PayrollContributionDefinition['category'],
  side: PayrollContributionDefinition['side'],
  patch: Partial<PayrollContributionDefinition> = {},
): PayrollContributionDefinition {
  return {
    id: `${category}-${side}-${patch.code ?? 'default'}`,
    code: patch.code ?? `${category}_${side}`.toUpperCase(),
    label: patch.label ?? category,
    category,
    side,
    calculationKind: 'rate',
    rateBp: 100,
    fixedAmountCents: null,
    annualCeilingCents: category === 'aap' || category === 'aanp'
      ? SWISS_LAA_ANNUAL_CEILING_CENTS_2026
      : null,
    basisKind: 'ahv_salary',
    lppComponent: null,
    lppEmployeeId: null,
    source: patch.source ?? 'Police 2026 / classe 1',
    effectiveFrom: '2026-01-01',
    effectiveTo: '2026-12-31',
    active: true,
    liabilityAccountId: '',
    expenseAccountId: '',
    ...patch,
  };
}

function settings() {
  return {
    ...initialOnboardingSettings,
    payroll: {
      ...initialOnboardingSettings.payroll,
      enabled: true,
      accidentInsurer: 'Assureur LAA',
      familyAllowanceFund: 'CAF cantonale',
      payrollCanton: 'VD',
    },
  };
}

describe('assessSwissPayrollInsuranceReadiness', () => {
  it('dérive la date réglementaire du jour local sans référence médiane figée', () => {
    expect(swissPayrollReferenceDate(new Date(2026, 8, 2, 12))).toBe('2026-09-02');
  });

  it('exige AAP, AANP et CAF pour un salarié actif à au moins huit heures', () => {
    const result = assessSwissPayrollInsuranceReadiness({
      settings: settings(),
      definitions: [],
      employees: [{ active: true, contractualWeeklyMinutes: 480 }],
    });

    expect(result.aap.complete).toBe(false);
    expect(result.aanp.required).toBe(true);
    expect(result.aanp.issues.join(' ')).toContain('prime AANP');
    expect(result.familyAllowance.issues.join(' ')).toContain('taux employeur');
  });

  it('accepte les primes LAA contractuelles complètes et la CAF employeur', () => {
    const result = assessSwissPayrollInsuranceReadiness({
      settings: settings(),
      definitions: [
        definition('aap', 'employer'),
        definition('aanp', 'employee'),
        definition('family_allowance', 'employer'),
      ],
      employees: [{ active: true, contractualWeeklyMinutes: 900 }],
    });

    expect(result.aap.complete).toBe(true);
    expect(result.aanp.complete).toBe(true);
    expect(result.familyAllowance.complete).toBe(true);
  });

  it('refuse une CAF fixe, hors salaire AVS, plafonnée ou sans source exploitable', () => {
    for (const row of [
      definition('family_allowance', 'employer', {
        calculationKind: 'fixed', rateBp: null, fixedAmountCents: 2_000,
      }),
      definition('family_allowance', 'employer', { basisKind: 'gross' }),
      definition('family_allowance', 'employer', { annualCeilingCents: 10_000_000 }),
      definition('family_allowance', 'employer', { source: 'CAF' }),
    ]) {
      const result = assessSwissPayrollInsuranceReadiness({
        settings: settings(),
        definitions: [row],
        employees: [{ active: true, contractualWeeklyMinutes: 200 }],
        asOf: '2026-06-30',
      });
      expect(result.familyAllowance.complete).toBe(false);
    }
  });

  it('refuse un plafond, une base ou un côté AAP dangereux', () => {
    const result = assessSwissPayrollInsuranceReadiness({
      settings: settings(),
      definitions: [definition('aap', 'employee', {
        annualCeilingCents: 10_000_000,
        basisKind: 'gross',
      })],
      employees: [{ active: true, contractualWeeklyMinutes: 200 }],
    });

    expect(result.aap.complete).toBe(false);
    expect(result.aap.issues.join(' ')).toContain('CHF 148’200');
    expect(result.aap.issues.join(' ')).toContain('charge de l’employeur');
    expect(result.aap.issues.join(' ')).toContain('base personnalisée');
  });

  it('n’exige pas AANP sous huit heures mais bloque une durée inconnue', () => {
    const below = assessSwissPayrollInsuranceReadiness({
      settings: settings(),
      definitions: [definition('aap', 'employer'), definition('family_allowance', 'employer')],
      employees: [{ active: true, contractualWeeklyMinutes: 479 }],
    });
    expect(below.aanp.required).toBe(false);
    expect(below.aanp.complete).toBe(true);

    const unknown = assessSwissPayrollInsuranceReadiness({
      settings: settings(),
      definitions: [],
      employees: [{ active: true, contractualWeeklyMinutes: null }],
    });
    expect(unknown.aanp.required).toBeNull();
    expect(unknown.aanp.complete).toBe(false);
    expect(unknown.aanp.issues[0]).toContain('moyenne hebdomadaire');

    const zeroHourContract = assessSwissPayrollInsuranceReadiness({
      settings: settings(),
      definitions: [],
      employees: [{ active: true, contractualWeeklyMinutes: 0 }],
      asOf: '2026-06-30',
    });
    expect(zeroHourContract.aanp.required).toBeNull();
    expect(zeroHourContract.aanp.complete).toBe(false);
  });

  it('contrôle une part AANP employeur contre la convention structurée', () => {
    const source = 'Convention plus favorable, art. 4';
    const configured = settings();
    configured.payroll.aanpEmployerCoverage = {
      enabled: true,
      reference: source,
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-12-31',
    };
    const result = assessSwissPayrollInsuranceReadiness({
      settings: configured,
      definitions: [
        definition('aap', 'employer'),
        definition('aanp', 'employer', { source }),
        definition('family_allowance', 'employer'),
      ],
      employees: [{ active: true, contractualWeeklyMinutes: 600 }],
    });
    expect(result.aanp.complete).toBe(true);

    configured.payroll.aanpEmployerCoverage.reference = 'Autre référence';
    expect(assessSwissPayrollInsuranceReadiness({
      settings: configured,
      definitions: [definition('aanp', 'employer', { source })],
      employees: [{ active: true, contractualWeeklyMinutes: 600 }],
    }).aanp.complete).toBe(false);
  });

  it('maintient IJM incomplète tant que toutes les clauses de police ne sont pas structurées', () => {
    const empty = assessSwissPayrollInsuranceReadiness({
      settings: settings(),
      definitions: [],
      employees: [],
    });
    expect(empty.dailyAllowance.required).toBeNull();
    expect(empty.dailyAllowance.complete).toBe(false);
    expect(empty.dailyAllowance.issues).toEqual([]);

    const configured = settings();
    configured.payroll.dailyAllowanceInsurer = 'Assureur IJM';
    const missingRate = assessSwissPayrollInsuranceReadiness({
      settings: configured,
      definitions: [],
      employees: [],
    });
    expect(missingRate.dailyAllowance.complete).toBe(false);
    expect(missingRate.dailyAllowance.issues.join(' ')).toContain('primes IJM');

    const partialPolicy = assessSwissPayrollInsuranceReadiness({
      settings: configured,
      definitions: [definition('ijm', 'employee')],
      employees: [],
      asOf: '2026-06-30',
    });
    expect(partialPolicy.dailyAllowance.complete).toBe(false);
    expect(partialPolicy.dailyAllowance.issues.join(' ')).toContain('numéro de police');
  });

  it('lie la retenue CAF Valais au tableau qui publie réellement le taux', () => {
    const configured = settings();
    configured.payroll.payrollCanton = 'VS';
    const base = [
      definition('aap', 'employer'),
      definition('family_allowance', 'employer'),
    ];
    const wrongEvidence = definition('family_allowance', 'employee', {
      code: 'CAF_VS_EMPLOYEE',
      rateBp: 13,
      source: 'https://www.ahv-iv.ch/tableau-des-montants-cantonaux.pdf',
    });
    const wrong = assessSwissPayrollInsuranceReadiness({
      settings: configured,
      definitions: [...base, wrongEvidence],
      employees: [{ active: true, contractualWeeklyMinutes: 200 }],
    });
    expect(wrong.familyAllowance.complete).toBe(false);

    const exactEvidence = { ...wrongEvidence, source: SWISS_FEDERAL_SOCIAL_INSURANCE_2026_SOURCE };
    const correct = assessSwissPayrollInsuranceReadiness({
      settings: configured,
      definitions: [...base, exactEvidence],
      employees: [{ active: true, contractualWeeklyMinutes: 200 }],
    });
    expect(correct.familyAllowance.complete).toBe(true);

    const wrongBasis = assessSwissPayrollInsuranceReadiness({
      settings: configured,
      definitions: [...base, { ...exactEvidence, basisKind: 'gross' }],
      employees: [{ active: true, contractualWeeklyMinutes: 200 }],
      asOf: '2026-06-30',
    });
    expect(wrongBasis.familyAllowance.complete).toBe(false);
  });

  it('évalue seulement les définitions applicables à la date demandée', () => {
    const expired = definition('family_allowance', 'employer', {
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-06-30',
    });
    const result = assessSwissPayrollInsuranceReadiness({
      settings: settings(),
      definitions: [expired],
      employees: [{ active: true, contractualWeeklyMinutes: 200 }],
      asOf: '2026-09-02',
    });
    expect(result.familyAllowance.complete).toBe(false);
    expect(result.familyAllowance.issues.join(' ')).toContain('taux employeur');
  });
});
