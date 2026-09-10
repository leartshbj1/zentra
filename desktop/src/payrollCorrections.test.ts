import { describe, expect, it } from 'vitest';
import { payrollHelp, groupedPayrollHelp } from './payrollHelp';
import { payrollDestination } from './payrollNavigation';
import { pensionPlanComplete } from './payrollPension';
import type { PayrollSettings } from './types';

describe('orientation vers le bon réglage de paie', () => {
  it.each([
    [
      'Confirmez ensemble l’année d’évaluation et le salaire annuel LPP sur la fiche collaborateur, zéro compris.',
      'pension-person',
      'person',
    ],
    [
      'L’évaluation salariale LPP du collaborateur porte sur 2025; confirmez-la pour 2026.',
      'pension-person',
      'person',
    ],
    [
      'La caisse de pension manque pour la cotisation LPP sélectionnée.',
      'pension-plan',
      'insurance',
    ],
    [
      'Le plan LPP exige le numéro de contrat, la référence du règlement, sa période d’effet et l’attestation de la part employeur agrégée.',
      'pension-plan',
      'insurance',
    ],
    [
      'La date réglementaire 2026-09-30 sort de la fenêtre du règlement LPP QA.',
      'pension-plan',
      'insurance',
    ],
    [
      'La source de chaque définition LPP doit correspondre exactement à la référence du règlement conservée dans les paramètres.',
      'pension-contributions',
      'contributions',
    ],
    [
      'La couverture LPP obligatoire doit inclure la composante risque.',
      'pension-contributions',
      'contributions',
    ],
    [
      'Une cotisation LPP sélectionnée appartient à un autre collaborateur.',
      'pension-contributions',
      'contributions',
    ],
    [
      'Le contrat déterminé de trois mois au maximum exige une exception LPP documentée sur la fiche collaborateur.',
      'situation',
      'person',
    ],
    [
      'La date de naissance est obligatoire et doit être valide pour contrôler la LPP.',
      'person',
      'person',
    ],
    ['Le compte des salaires à payer est inactif.', 'accounts', 'accounts'],
    [
      'Le compte de cotisation AVS est inactif',
      'advanced-contributions',
      'advanced-contributions',
    ],
    [
      'source_tax: référence du barème manquante',
      'advanced-contributions',
      'advanced-contributions',
    ],
  ])('%s', (message, target, section) => {
    const help = payrollHelp(message);
    expect(help.target).toBe(target);
    expect(help.action).not.toBe('');
    expect(payrollDestination(help.target).section).toBe(section);
  });
  it('ne fusionne pas les trois étapes pension sous un bouton ambigu', () => {
    const errors = [
      'salaire annuel LPP manquant',
      'La caisse de pension manque.',
      'La couverture LPP obligatoire doit inclure la composante risque.',
    ];
    expect(groupedPayrollHelp(errors).map((h) => h.target)).toEqual([
      'pension-person',
      'pension-plan',
      'pension-contributions',
    ]);
    expect(groupedPayrollHelp(errors).flatMap((h) => h.messages)).toEqual(
      errors,
    );
  });
});
describe('contrat pension guidé', () => {
  const payroll = {
    pensionFund: 'Fondation de recette',
    lppPlanEvidence: {
      contractNumber: 'QA-2026',
      regulationReference: 'Règlement QA 2026',
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-12-31',
      employerAggregateShareConfirmed: true,
    },
  } as PayrollSettings;
  it('ne confond pas le nom de la caisse et un contrat complet', () => {
    expect(
      pensionPlanComplete({ ...payroll, lppPlanEvidence: undefined }),
    ).toBe(false);
    expect(pensionPlanComplete(payroll, '2026-09')).toBe(true);
    expect(pensionPlanComplete(payroll, '2027-01')).toBe(false);
    for (const patch of [
      { regulationReference: '' },
      { effectiveFrom: '2026-02-30' },
      { effectiveTo: '2025-12-31' },
      { employerAggregateShareConfirmed: false },
    ])
      expect(
        pensionPlanComplete({
          ...payroll,
          lppPlanEvidence: { ...payroll.lppPlanEvidence!, ...patch },
        }),
      ).toBe(false);
  });
});
