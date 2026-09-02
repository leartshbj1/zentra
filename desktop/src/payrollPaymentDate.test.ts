import { describe, expect, it } from 'vitest';

import { assessPayrollPaymentDate } from './payrollPaymentDate';
import type { Payslip, PayslipContributionSnapshot } from './types';

const contribution: PayslipContributionSnapshot = {
  id: 'snapshot-1',
  payslipId: 'payslip-1',
  definitionId: 'rate-2026',
  payslipItemId: 'line-1',
  label: 'Cotisation datée',
  category: 'other',
  side: 'employee',
  calculationKind: 'rate',
  basisKind: 'gross',
  basisCents: 500_000,
  yearToDateBasisCents: null,
  rateBp: 100,
  fixedAmountCents: null,
  annualCeilingCents: null,
  amountCents: 5_000,
  lppComponent: null,
  lppEmployeeId: null,
  source: 'Contrat contrôlé',
  effectiveFrom: '2026-01-01',
  effectiveTo: '2026-12-31',
  liabilityAccountId: '',
  expenseAccountId: '',
  createdAt: '2026-08-31T12:00:00Z',
};

function payslip(
  contributionDate: string,
  contributions: PayslipContributionSnapshot[] = [contribution],
): Payslip {
  return {
    id: 'payslip-1',
    employeeId: 'employee-1',
    period: '2026-08',
    status: 'posted',
    lines: [],
    paymentDate: '',
    notes: '',
    createdAt: '2026-08-31T12:00:00Z',
    snapshot: {
      capturedAt: '2026-08-31T12:00:00Z',
      contributionDate,
      issuer: {
        companyName: '',
        legalForm: '',
        ownerName: '',
        email: '',
        phone: '',
        addressLine1: '',
        addressLine2: '',
        buildingNumber: '',
        postalCode: '',
        city: '',
        canton: '',
        country: 'CH',
        uidNumber: '',
        vatNumber: '',
        vatRegistered: false,
        iban: '',
        bankName: '',
        currency: 'CHF',
        logoPath: '',
      },
      employee: {
        id: 'employee-1',
        employeeNumber: '',
        name: 'Employé test',
        role: '',
        address: '',
        avsNumber: '',
        iban: '',
        employmentRate: 100,
        employmentContractKind: null,
        lppAssessmentYear: null,
        lppAnnualSalaryCents: null,
        lppExceptionCode: null,
        lppExceptionEvidenceReference: '',
      },
      period: '2026-08',
      paymentDate: '',
      notes: '',
      items: [],
      contributions,
    },
  };
}

describe('assessPayrollPaymentDate', () => {
  it('allows a later payment inside the same frozen definition window', () => {
    expect(assessPayrollPaymentDate(payslip('2026-08-01'), '2026-09-30')).toEqual({
      blocked: false,
      overrideAllowed: false,
      reason: '',
      frozenContributionDate: '2026-08-01',
    });
  });

  it('blocks a 2026 to 2027 regulatory-year change', () => {
    const assessment = assessPayrollPaymentDate(
      payslip('2026-08-01'),
      '2027-01-02',
    );
    expect(assessment.blocked).toBe(true);
    expect(assessment.overrideAllowed).toBe(true);
    expect(assessment.reason).toContain('millésime réglementaire');
  });

  it('blocks a regulatory-year change even when the frozen list is empty', () => {
    const assessment = assessPayrollPaymentDate(
      payslip('2026-12-01', []),
      '2027-01-02',
    );
    expect(assessment.blocked).toBe(true);
    expect(assessment.overrideAllowed).toBe(true);
    expect(assessment.reason).toContain('millésime réglementaire');
  });

  it('blocks a date outside one persisted contribution window', () => {
    const assessment = assessPayrollPaymentDate(
      payslip('2026-08-01', [
        { ...contribution, effectiveTo: '2026-08-31' },
      ]),
      '2026-09-01',
    );
    expect(assessment.blocked).toBe(true);
    expect(assessment.overrideAllowed).toBe(true);
    expect(assessment.reason).toContain('Cotisation datée');
    expect(assessment.reason).toContain('Décomptabilisez');
  });

  it('derives the historical contribution date from period-01', () => {
    const legacy = payslip('');
    if (!legacy.snapshot) throw new Error('fixture snapshot missing');
    legacy.snapshot.contributionDate = '';
    legacy.snapshot.paymentDate = '';
    expect(
      assessPayrollPaymentDate(legacy, '2026-08-31').frozenContributionDate,
    ).toBe('2026-08-01');
  });

  it('classifies a missing immutable snapshot as non-overridable integrity loss', () => {
    const legacy = payslip('2026-08-01');
    legacy.snapshot = null;
    const assessment = assessPayrollPaymentDate(legacy, '2026-08-31');
    expect(assessment.blocked).toBe(true);
    expect(assessment.overrideAllowed).toBe(false);
    expect(assessment.reason).toContain('preuve');
  });
});
