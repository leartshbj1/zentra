import { describe, expect, it } from 'vitest';
import {
  contractContribution,
  exactPayrollRate,
  missingFederalContributions,
} from './payrollContractPresets';
import { groupedPayrollHelp, payrollHelp } from './payrollHelp';
import {
  findPayrollOrganisations,
  PAYROLL_ORGANISATIONS,
} from './swissPayrollDirectory';

describe('répertoires de caisses suisses', () => {
  it('couvre les 26 caisses cantonales, les 64 entrées professionnelles et les 202 CAF actives du registre 2026', () => {
    expect(new Set(PAYROLL_ORGANISATIONS.map((item) => item.id)).size).toBe(
      PAYROLL_ORGANISATIONS.length,
    );
    expect(
      PAYROLL_ORGANISATIONS.filter(
        (item) => item.kind === 'avs' && item.canton,
      ),
    ).toHaveLength(26);
    expect(
      PAYROLL_ORGANISATIONS.filter(
        (item) => item.group === 'Caisses professionnelles',
      ),
    ).toHaveLength(64);
    expect(
      PAYROLL_ORGANISATIONS.filter(
        (item) => item.group === 'Caisses fédérales',
      ),
    ).toHaveLength(2);
    expect(findPayrollOrganisations('family', '')).toHaveLength(202);
    expect(findPayrollOrganisations('family', '002.202')).toHaveLength(0); // historical, no longer admitted in 2026
    expect(findPayrollOrganisations('accident', '')).toHaveLength(22);
  });
  it('sépare les assurances personnelles, les accidents et les organismes de paie', () => {
    expect(findPayrollOrganisations('daily', 'suva')).toHaveLength(0);
    expect(findPayrollOrganisations('accident', 'suva')[0].name).toBe(
      'Suva / CNA',
    );
    expect(findPayrollOrganisations('accident', 'visavis')[0].number).toBe(
      '10003',
    );
    expect(findPayrollOrganisations('avs', '', 'VD')[0].canton).toBe('VD');
    expect(
      findPayrollOrganisations('avs', 'geneve').some(
        (item) => item.canton === 'GE',
      ),
    ).toBe(true);
    expect(findPayrollOrganisations('avs', 'fer ciam')[0].number).toBe('106.1');
    expect(findPayrollOrganisations('family', 'CAF CFC')).not.toHaveLength(0);
    expect(findPayrollOrganisations('pension', 'inconnue')).toHaveLength(0);
  });
});
describe('aide de paie compréhensible', () => {
  it('regroupe les contrôles tout en conservant chaque explication originale', () => {
    const originals = [
      'La date de naissance manque; AVS impossible.',
      'small_salary_opening_gross_cents requis',
      'La base d’ouverture AC manque.',
    ];
    const groups = groupedPayrollHelp(originals);
    expect(groups).toHaveLength(2);
    expect(groups[0].target).toBe('person');
    expect(groups[1].target).toBe('history');
    expect(groups.flatMap((item) => item.messages)).toEqual(originals);
    expect(
      payrollHelp('SQLITE_BUSY: database locked').explanation,
    ).not.toContain('SQLITE');
    expect(
      payrollHelp('Le compte des salaires à payer est inactif').target,
    ).toBe('accounts');
    expect(
      payrollHelp('Le compte des salaires à payer est inactif').action,
    ).toBe('Corriger les comptes du salaire');
    expect(payrollHelp('Le compte de cotisation AVS est inactif').target).toBe(
      'advanced-contributions',
    );
  });
});
describe('préparation des primes depuis un contrat', () => {
  const base = {
    id: 'ed4d9d6e-0ba8-46f0-b80b-8ad09f2e699e',
    category: 'aap' as const,
    side: 'employer' as const,
    rate: '1.25',
    amountCents: 0,
    employeeId: 'employee',
    component: null,
    source: 'Police Suva QA 2026',
    from: '2026-01-01',
    to: '2026-12-31',
    liability: '',
    expense: '',
  };
  it('conserve un taux exact et refuse un arrondi silencieux', () => {
    expect(exactPayrollRate('1,25')).toBe(125);
    expect(exactPayrollRate('0.13')).toBe(13);
    for (const value of ['1.452', '', 'NaN', '1e2', '-1', '101', '0'])
      expect(() => exactPayrollRate(value)).toThrow();
  });
  it('complète les taux officiels sans doubler une couverture personnalisée ni réactiver une ligne', () => {
    const avs = {
      ...contractContribution(base),
      code: 'AVS_EMPLOYEE',
      category: 'avs_ai_apg' as const,
      side: 'employee' as const,
    };
    const ai = { ...avs, id: 'ai', code: 'AI_EMPLOYEE' };
    const ac = {
      ...avs,
      id: 'ac',
      code: 'AC_EMPLOYEE',
      category: 'ac' as const,
    };
    const profile = [avs, ai, ac];
    expect(missingFederalContributions(profile, [])).toEqual(profile);
    expect(
      missingFederalContributions(profile, [{ ...avs, active: false }]),
    ).toEqual([ai, ac]);
    expect(
      missingFederalContributions(profile, [
        { ...avs, code: 'AVS_AI_APG_COMBINE' },
      ]),
    ).toEqual([ac]);
    expect(missingFederalContributions(profile, profile)).toEqual([]);
  });
  it('prépare le plafond légal accidents avec une source et une période explicites', () => {
    expect(contractContribution(base)).toMatchObject({
      rateBp: 125,
      annualCeilingCents: 14820000,
      basisKind: 'ahv_salary',
      side: 'employer',
      lppEmployeeId: null,
      lppComponent: null,
      source: base.source,
    });
    expect(() => contractContribution({ ...base, side: 'employee' })).toThrow();
    expect(() =>
      contractContribution({ ...base, from: '2026-02-30' }),
    ).toThrow();
    expect(() => contractContribution({ ...base, to: '2027-12-31' })).toThrow();
  });
  it('ne déduit jamais une LPP universelle du salaire du mois', () => {
    const pension = contractContribution({
      ...base,
      category: 'lpp',
      side: 'employee',
      amountCents: 24550,
      component: 'risk',
      source: 'Règlement QA 2026',
    });
    expect(pension).toMatchObject({
      calculationKind: 'fixed',
      fixedAmountCents: 24550,
      rateBp: null,
      annualCeilingCents: null,
      lppEmployeeId: 'employee',
      lppComponent: 'risk',
    });
    expect(() => contractContribution({ ...base, category: 'lpp' })).toThrow();
    expect(
      contractContribution({ ...base, category: 'family_allowance' })
        .annualCeilingCents,
    ).toBeNull();
  });
});
