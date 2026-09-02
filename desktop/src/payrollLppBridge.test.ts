import { describe, expect, it } from 'vitest';

import {
  contributionFromRaw,
  payrollContributionDefinitionToRaw,
  payslipContributionFromRaw,
} from './bridge';
import type { PayrollContributionDefinition } from './types';

const lppDefinition: PayrollContributionDefinition = {
  id: 'lpp-definition-1',
  code: 'LPP_COMBINED_TEST',
  label: 'LPP combinée',
  category: 'lpp',
  side: 'employee',
  calculationKind: 'fixed',
  rateBp: null,
  fixedAmountCents: 10_000,
  annualCeilingCents: null,
  basisKind: 'coordinated',
  lppComponent: 'combined',
  lppEmployeeId: 'employee-1',
  source: 'Règlement LPP TEST-2026, art. 12',
  effectiveFrom: '2026-01-01',
  effectiveTo: '2026-12-31',
  active: true,
  liabilityAccountId: '',
  expenseAccountId: '',
};

describe('contrat bridge LPP V28', () => {
  it('envoie explicitement la composante et le salarié lié au moteur Rust', () => {
    expect(payrollContributionDefinitionToRaw(lppDefinition)).toMatchObject({
      lpp_component: 'combined',
      lpp_employee_id: 'employee-1',
      calculation_kind: 'fixed',
      fixed_amount_cents: 10_000,
      rate_bp: null,
    });
  });

  it('restaure les champs LPP des définitions et des snapshots de fiche', () => {
    const raw = payrollContributionDefinitionToRaw(lppDefinition);
    expect(contributionFromRaw(raw)).toMatchObject({
      lppComponent: 'combined',
      lppEmployeeId: 'employee-1',
    });
    expect(
      payslipContributionFromRaw({
        ...raw,
        id: 'snapshot-1',
        payslip_id: 'payslip-1',
        definition_id: 'lpp-definition-1',
        payslip_item_id: 'item-1',
        basis_cents: 3_354_000,
        amount_cents: 10_000,
        created_at: '2026-06-30T10:00:00Z',
      }),
    ).toMatchObject({
      lppComponent: 'combined',
      lppEmployeeId: 'employee-1',
    });
  });

  it('ne fabrique aucune qualification LPP pour les anciennes lignes nulles', () => {
    expect(contributionFromRaw({ ...payrollContributionDefinitionToRaw(lppDefinition), lpp_component: null, lpp_employee_id: null })).toMatchObject({
      lppComponent: null,
      lppEmployeeId: null,
    });
  });
});
