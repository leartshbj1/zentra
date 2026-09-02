import { describe, expect, it } from 'vitest';
import { contributionDraftPayload } from './PayrollContributionsPanel';

function baseForm(): FormData {
  const form = new FormData();
  form.set('code', ' lpp-risque ');
  form.set('label', 'Prime LPP risque');
  form.set('side', 'employee');
  form.set('rate', '9.99');
  form.set('fixedAmount', '245.50');
  form.set('annualCeiling', '999999');
  form.set('basisKind', 'coordinated');
  form.set('lppComponent', 'risk');
  form.set('lppEmployeeId', 'employee-42');
  form.set('source', ' Règlement LPP signé 2026 ');
  form.set('effectiveFrom', '2026-01-01');
  form.set('effectiveTo', '2026-12-31');
  form.set('active', 'yes');
  form.set('liabilityAccountId', 'liability-1');
  form.set('expenseAccountId', '');
  return form;
}

describe('payload du formulaire de cotisation', () => {
  it('force une LPP individuelle en montant fixe positif et supprime taux/plafond', () => {
    const payload = contributionDraftPayload(baseForm(), {
      category: 'lpp',
      calculationKind: 'rate',
    });
    expect(payload).toMatchObject({
      code: 'LPP-RISQUE',
      label: 'Prime LPP risque',
      category: 'lpp',
      calculationKind: 'fixed',
      rateBp: null,
      fixedAmountCents: 24_550,
      annualCeilingCents: null,
      basisKind: 'coordinated',
      lppComponent: 'risk',
      lppEmployeeId: 'employee-42',
      source: 'Règlement LPP signé 2026',
    });
  });

  it('envoie explicitement les champs LPP à null pour toute autre catégorie', () => {
    const form = baseForm();
    form.set('basisKind', 'gross');
    const payload = contributionDraftPayload(form, {
      category: 'ijm',
      calculationKind: 'rate',
    });
    expect(payload).toMatchObject({
      category: 'ijm',
      calculationKind: 'rate',
      rateBp: 999,
      fixedAmountCents: null,
      annualCeilingCents: 99_999_900,
      basisKind: 'gross',
      lppComponent: null,
      lppEmployeeId: null,
    });
  });
});
