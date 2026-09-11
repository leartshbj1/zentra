import { describe, expect, it } from 'vitest';

import {
  parseSmallSalaryEmployeeForm,
  recordedSmallSalaryGrossBeforePeriod,
  smallSalaryReasonLabel,
  SmallSalaryFormError,
} from './smallSalaryAssessment';
import type { Payslip } from './types';

const completeDraft = {
  assessmentYear: '2026',
  sector: 'ordinary',
  employeeRequestedContributions: 'no',
  decisionDate: '2026-01-12',
  openingGross: '0',
  openingContributedBasis: '0',
  evidenceReference: 'Déclaration annuelle signée 2026-01-12',
};

describe('formulaire annuel des petits salaires', () => {
  it('conserve explicitement false et les ouvertures à zéro', () => {
    expect(parseSmallSalaryEmployeeForm(completeDraft)).toEqual({
      smallSalaryAssessmentYear: 2026,
      smallSalarySector: 'ordinary',
      smallSalaryEmployeeRequestedContributions: false,
      smallSalaryDecisionDate: '2026-01-12',
      smallSalaryOpeningGrossCents: 0,
      smallSalaryOpeningContributedBasisCents: 0,
      smallSalaryEvidenceReference:
        'Déclaration annuelle signée 2026-01-12',
    });
  });

  it('laisse un ancien dossier entièrement vide sans fabriquer de décision', () => {
    expect(
      parseSmallSalaryEmployeeForm({
        assessmentYear: '',
        sector: '',
        employeeRequestedContributions: '',
        decisionDate: '',
        openingGross: '',
        openingContributedBasis: '',
        evidenceReference: '',
      }),
    ).toMatchObject({
      smallSalaryAssessmentYear: null,
      smallSalarySector: null,
      smallSalaryEmployeeRequestedContributions: null,
      smallSalaryDecisionDate: '',
      smallSalaryOpeningGrossCents: null,
      smallSalaryOpeningContributedBasisCents: null,
      smallSalaryEvidenceReference: '',
    });
  });

  it('refuse un bloc partiel même si les montants nuls sont valides', () => {
    expect(() =>
      parseSmallSalaryEmployeeForm({
        ...completeDraft,
        employeeRequestedContributions: '',
      }),
    ).toThrow(/Complétez « Choix du collaborateur/);
  });

  it('exige une date civile réelle dans la même année', () => {
    expect(() =>
      parseSmallSalaryEmployeeForm({
        ...completeDraft,
        decisionDate: '2025-12-31',
      }),
    ).toThrow(/L’année choisie est 2026, mais la date saisie est le 31.12.2025/);
    expect(() =>
      parseSmallSalaryEmployeeForm({
        ...completeDraft,
        decisionDate: '2026-02-30',
      }),
    ).toThrow(/date valide dans le calendrier pour 2026/);
  });

  it('identifie le champ de date à ouvrir sans modifier le choix enregistré', () => {
    const draft = { ...completeDraft, decisionDate: '2025-12-31' };
    try {
      parseSmallSalaryEmployeeForm(draft);
      throw new Error('Expected date validation error');
    } catch (error) {
      expect(error).toBeInstanceOf(SmallSalaryFormError);
      expect(error).toMatchObject({ field: 'smallSalaryDecisionDate' });
      expect(draft.decisionDate).toBe('2025-12-31');
    }
  });

  it('refuse une base déjà cotisée supérieure au brut d’ouverture', () => {
    expect(() =>
      parseSmallSalaryEmployeeForm({
        ...completeDraft,
        openingGross: '500.00',
        openingContributedBasis: '500.01',
      }),
    ).toThrow(/ne peut pas dépasser/);
  });

  it('traduit les motifs exacts renvoyés par le moteur', () => {
    expect(smallSalaryReasonLabel('ordinary_minor_salary_exempt')).toContain(
      'Dispense ordinaire',
    );
    expect(
      smallSalaryReasonLabel(
        'private_household_youth_minor_salary_exempt',
      ),
    ).toContain('ménage privé');
  });

  it('cumule seulement les fiches antérieures validées, comptabilisées ou payées', () => {
    const payslip = (
      id: string,
      period: string,
      status: Payslip['status'],
      amountCents: number,
      employeeId = 'employee-1',
    ) =>
      ({
        id,
        employeeId,
        period,
        status,
        lines: [
          { id: `${id}-gross`, label: 'Brut', kind: 'earning', amountCents },
          { id: `${id}-deduction`, label: 'Retenue', kind: 'deduction', amountCents: 999_999 },
        ],
      }) as Payslip;
    const payslips = [
      payslip('validated', '2026-01', 'validated', 10_000),
      payslip('posted', '2026-02', 'posted', 20_000),
      payslip('paid', '2026-03', 'paid', 30_000),
      payslip('incomplete', '2026-04', 'incomplete', 400_000),
      payslip('draft', '2026-05', 'draft', 500_000),
      payslip('same-period', '2026-06', 'paid', 600_000),
      payslip('other-year', '2025-12', 'paid', 700_000),
      payslip('other-employee', '2026-01', 'paid', 800_000, 'employee-2'),
      payslip('excluded', '2026-01', 'paid', 900_000),
    ];
    expect(
      recordedSmallSalaryGrossBeforePeriod({
        payslips,
        employeeId: 'employee-1',
        period: '2026-06',
        excludedPayslipId: 'excluded',
      }),
    ).toBe(60_000);
  });
});
