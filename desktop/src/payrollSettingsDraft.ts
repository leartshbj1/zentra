import type { AppSettings } from './types';
import { pensionPlanIssue } from './payrollPension';
import { payrollDateValidity } from './payrollFieldLanguage';
import type { InterfaceMessage } from './language';

export type PayrollSettingsIssue = { field: string; message: string; presentation?: InterfaceMessage };
export function payrollSettingsDraft(current: AppSettings['payroll'], form: FormData, flags: { pension: boolean; smallSalary: boolean }) {
  const text = (name: string) => String(form.get(name) ?? '').trim();
  return {
    ...current,
    enabled: form.get('enabled') === 'on', fiduciaryValidated: form.get('fiduciaryValidated') === 'on',
    avsFund: text('avsFund'), accidentInsurer: text('accidentInsurer'), pensionFund: text('pensionFund'),
    dailyAllowanceInsurer: text('dailyAllowanceInsurer'), familyAllowanceFund: text('familyAllowanceFund'), payrollCanton: text('payrollCanton').toUpperCase(),
    aanpEmployerCoverage: { enabled: form.get('aanpEmployerCoverageEnabled') === 'on', reference: text('aanpEmployerCoverageReference'), effectiveFrom: text('aanpEmployerCoverageEffectiveFrom'), effectiveTo: text('aanpEmployerCoverageEffectiveTo') },
    laaSmallSalaryException: { enabled: flags.smallSalary, assessmentYear: /^\d{4}$/.test(text('laaSmallSalaryAssessmentYear')) ? Number(text('laaSmallSalaryAssessmentYear')) : null, evidenceReference: text('laaSmallSalaryEvidenceReference'), confirmedAllEmployeesOnlyMinorSalaries: form.get('laaSmallSalaryAllEmployeesConfirmed') === 'on' },
    lppPlanEvidence: flags.pension ? { contractNumber: text('lppPlanContractNumber'), regulationReference: text('lppPlanRegulationReference'), effectiveFrom: text('lppPlanEffectiveFrom'), effectiveTo: text('lppPlanEffectiveTo'), employerAggregateShareConfirmed: form.get('lppPlanEmployerShareConfirmed') === 'on' } : undefined,
  };
}

/** Explain the contract requirements before a write, using the same rules as the guided payslip setup. */
export function payrollSettingsIssue(payroll: AppSettings['payroll']): PayrollSettingsIssue | null {
  const coverage = payroll.aanpEmployerCoverage;
  if (coverage?.enabled) {
    if (!coverage.reference) return { field: 'aanpEmployerCoverageReference', message: 'Recopiez la référence de l’accord écrit qui confirme que l’entreprise paie la prime AANP.' };
    if (!coverage.effectiveFrom || payrollDateValidity(coverage.effectiveFrom, '', '').typeMismatch) return { field: 'aanpEmployerCoverageEffectiveFrom', message: 'Recopiez la date de début indiquée dans l’accord de prise en charge AANP.' };
    if (coverage.effectiveTo && (payrollDateValidity(coverage.effectiveTo, '', '').typeMismatch || coverage.effectiveTo < coverage.effectiveFrom)) return { field: 'aanpEmployerCoverageEffectiveTo', message: 'La fin de prise en charge AANP doit être une date valide postérieure ou égale au début.' };
  }
  if (payroll.lppPlanEvidence) {
    const issue = pensionPlanIssue(payroll);
    if (issue) return { ...issue, field: { pensionFund: 'pensionFund', contractNumber: 'lppPlanContractNumber', regulationReference: 'lppPlanRegulationReference', lppFrom: 'lppPlanEffectiveFrom', lppTo: 'lppPlanEffectiveTo', lppParity: 'lppPlanEmployerShareConfirmed' }[issue.field] };
  }
  const exception = payroll.laaSmallSalaryException;
  if (exception?.enabled) {
    if (!Number.isInteger(exception.assessmentYear) || (exception.assessmentYear ?? 0) < 2000 || (exception.assessmentYear ?? 0) > 9999) return { field: 'laaSmallSalaryAssessmentYear', message: 'Indiquez l’année concernée par la preuve de l’exception LAA, par exemple 2026.' };
    if (!exception.evidenceReference || exception.evidenceReference.length > 500) return { field: 'laaSmallSalaryEvidenceReference', message: 'Indiquez le document qui confirme l’exception LAA pour cette année.' };
    if (!exception.confirmedAllEmployeesOnlyMinorSalaries) return { field: 'laaSmallSalaryAllEmployeesConfirmed', message: 'Vérifiez tous les salariés concernés pendant l’année, y compris ceux qui ont quitté l’entreprise, puis cochez cette confirmation.' };
  }
  return null;
}
