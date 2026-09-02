import { describe, expect, it } from 'vitest';

import {
  employeeSmallSalaryFieldsFromRaw,
  payrollSmallSalaryAssessmentFromRaw,
  toBackendData,
} from './bridge';

const validAssessment = {
  assessment_year: 2026,
  sector: 'ordinary',
  employee_requested_contributions: false,
  decision_date: '2026-01-12',
  threshold_cents: 250_000,
  opening_gross_cents: 100_000,
  opening_contributed_basis_cents: 0,
  prior_gross_cents: 120_000,
  prior_contributed_basis_cents: 0,
  current_gross_cents: 50_000,
  cumulative_gross_cents: 270_000,
  contributions_due: true,
  statutory_contribution_basis_cents: 270_000,
  statutory_catchup_basis_cents: 220_000,
  reason_code: 'ordinary_threshold_exceeded',
  evidence_reference: 'Preuve locale',
};

const validEmployeeFields = {
  small_salary_assessment_year: 2026,
  small_salary_sector: 'ordinary',
  small_salary_employee_requested_contributions: false,
  small_salary_decision_date: '2026-01-12',
  small_salary_opening_gross_cents: 0,
  small_salary_opening_contributed_basis_cents: 0,
  small_salary_evidence_reference: 'Preuve locale',
};

describe('contrat bridge petits salaires', () => {
  it('restaure false et zéro sans les confondre avec une absence', () => {
    expect(
      employeeSmallSalaryFieldsFromRaw({
        ...validEmployeeFields,
      }),
    ).toEqual({
      smallSalaryAssessmentYear: 2026,
      smallSalarySector: 'ordinary',
      smallSalaryEmployeeRequestedContributions: false,
      smallSalaryDecisionDate: '2026-01-12',
      smallSalaryOpeningGrossCents: 0,
      smallSalaryOpeningContributedBasisCents: 0,
      smallSalaryEvidenceReference: 'Preuve locale',
    });
  });

  it('accepte aussi l’encodage booléen SQLite exact 0/1', () => {
    expect(
      employeeSmallSalaryFieldsFromRaw({
        ...validEmployeeFields,
        small_salary_employee_requested_contributions: 0,
      }).smallSalaryEmployeeRequestedContributions,
    ).toBe(false);
    expect(
      employeeSmallSalaryFieldsFromRaw({
        ...validEmployeeFields,
        small_salary_employee_requested_contributions: 1,
      }).smallSalaryEmployeeRequestedContributions,
    ).toBe(true);
  });

  it('conserve un ancien dossier lorsque les sept champs sont absents', () => {
    expect(employeeSmallSalaryFieldsFromRaw({})).toEqual({
      smallSalaryAssessmentYear: null,
      smallSalarySector: null,
      smallSalaryEmployeeRequestedContributions: null,
      smallSalaryDecisionDate: '',
      smallSalaryOpeningGrossCents: null,
      smallSalaryOpeningContributedBasisCents: null,
      smallSalaryEvidenceReference: '',
    });
  });

  it('rejette les champs collaborateur partiels ou de type invalide', () => {
    expect(() =>
      employeeSmallSalaryFieldsFromRaw({
        ...validEmployeeFields,
        small_salary_assessment_year: '2026',
      }),
    ).toThrow(/small_salary_assessment_year/);
    expect(() =>
      employeeSmallSalaryFieldsFromRaw({
        ...validEmployeeFields,
        small_salary_employee_requested_contributions: '0',
      }),
    ).toThrow(/small_salary_employee_requested_contributions/);
    expect(() =>
      employeeSmallSalaryFieldsFromRaw({
        ...validEmployeeFields,
        small_salary_opening_gross_cents: '0',
      }),
    ).toThrow(/small_salary_opening_gross_cents/);
    const {
      small_salary_evidence_reference: _missing,
      ...partialEmployeeFields
    } = validEmployeeFields;
    expect(() =>
      employeeSmallSalaryFieldsFromRaw(partialEmployeeFields),
    ).toThrow(/sept champs/);
  });

  it('envoie les sept champs sous leurs noms snake_case exacts', () => {
    expect(
      toBackendData({
        smallSalaryAssessmentYear: 2026,
        smallSalarySector: 'ordinary',
        smallSalaryEmployeeRequestedContributions: false,
        smallSalaryDecisionDate: '2026-01-12',
        smallSalaryOpeningGrossCents: 0,
        smallSalaryOpeningContributedBasisCents: 0,
        smallSalaryEvidenceReference: 'Preuve locale',
      }),
    ).toEqual({
      small_salary_assessment_year: 2026,
      small_salary_sector: 'ordinary',
      small_salary_employee_requested_contributions: false,
      small_salary_decision_date: '2026-01-12',
      small_salary_opening_gross_cents: 0,
      small_salary_opening_contributed_basis_cents: 0,
      small_salary_evidence_reference: 'Preuve locale',
    });
  });

  it('mappe le cumul, la décision et les deux assiettes calculées', () => {
    expect(
      payrollSmallSalaryAssessmentFromRaw(validAssessment),
    ).toMatchObject({
      employeeRequestedContributions: false,
      decisionDate: '2026-01-12',
      cumulativeGrossCents: 270_000,
      contributionsDue: true,
      statutoryContributionBasisCents: 270_000,
      statutoryCatchupBasisCents: 220_000,
      reasonCode: 'ordinary_threshold_exceeded',
    });
  });

  it('conserve uniquement null comme absence explicite', () => {
    expect(payrollSmallSalaryAssessmentFromRaw(null)).toBeNull();
    expect(() => payrollSmallSalaryAssessmentFromRaw(undefined)).toThrow(
      /Contrat de calcul des petits salaires invalide/,
    );
  });

  it('rejette un objet partiel au lieu de fabriquer des zéros', () => {
    expect(() =>
      payrollSmallSalaryAssessmentFromRaw({ sector: 'ordinary' }),
    ).toThrow(/assessment_year/);
    const { statutory_contribution_basis_cents: _missing, ...partial } =
      validAssessment;
    expect(() => payrollSmallSalaryAssessmentFromRaw(partial)).toThrow(
      /statutory_contribution_basis_cents/,
    );
  });

  it('rejette les types et incohérences du payload moteur', () => {
    expect(() =>
      payrollSmallSalaryAssessmentFromRaw({
        ...validAssessment,
        employee_requested_contributions: 0,
      }),
    ).toThrow(/employee_requested_contributions/);
    expect(() =>
      payrollSmallSalaryAssessmentFromRaw({
        ...validAssessment,
        cumulative_gross_cents: 0,
      }),
    ).toThrow(/cumulative_gross_cents/);
    expect(() =>
      payrollSmallSalaryAssessmentFromRaw({
        ...validAssessment,
        decision_date: '2026-02-30',
      }),
    ).toThrow(/decision_date/);
  });
});
