import { describe, expect, it } from 'vitest';
import { pensionPlanIssue } from './payrollPension';
import { initialOnboardingSettings } from './onboardingDraft';
const payroll = { ...initialOnboardingSettings.payroll, pensionFund: 'Caisse de recette', lppPlanEvidence: {
  contractNumber: 'TEST-2026', regulationReference: 'Règlement de prévoyance 2026', effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31', employerAggregateShareConfirmed: true,
} };
describe('correction du contrat de pension à la source', () => {
  it('accepte un contrat complet qui couvre la date réellement utilisée', () => {
    expect(pensionPlanIssue(payroll, '2026-09-30')).toBeNull();
    expect(pensionPlanIssue(payroll, '2026-01-01')).toBeNull();
    expect(pensionPlanIssue(payroll, '2026-12-31')).toBeNull();
  });
  it.each([
    ['contractNumber', ' ', 'contractNumber'], ['regulationReference', 'test', 'regulationReference'],
    ['effectiveFrom', '2026-02-30', 'lppFrom'], ['effectiveTo', '2026-04-31', 'lppTo'],
    ['employerAggregateShareConfirmed', false, 'lppParity'],
  ] as const)('désigne le champ %s sans demander de recommencer le contrat', (key, value, field) => {
    expect(pensionPlanIssue({ ...payroll, lppPlanEvidence: { ...payroll.lppPlanEvidence, [key]: value } })?.field).toBe(field);
  });
  it('refuse une fin antérieure au début, un contrat expiré et un contrat futur', () => {
    expect(pensionPlanIssue({ ...payroll, lppPlanEvidence: { ...payroll.lppPlanEvidence, effectiveTo: '2025-12-31' } })?.field).toBe('lppTo');
    expect(pensionPlanIssue(payroll, '2027-01-01')).toMatchObject({ field: 'lppTo', message: expect.stringContaining('01.01.2027') });
    expect(pensionPlanIssue(payroll, '2025-12-31')?.field).toBe('lppFrom');
  });
  it('demande le nom de caisse et les éléments absents sans prétendre les connaître', () => {
    expect(pensionPlanIssue({ ...payroll, pensionFund: ' ' })?.field).toBe('pensionFund');
    expect(pensionPlanIssue({ ...payroll, lppPlanEvidence: undefined })?.field).toBe('contractNumber');
  });
});
