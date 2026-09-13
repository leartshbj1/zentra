import { assessSwissPayrollEligibility, type PayrollEligibilityAssessment } from './payrollEligibility';
import { renderPayrollText, type PayrollPresentationRegistry } from './payrollPresentation';
import { getAppLanguage, t, type AppLanguage } from './language';

export type PayrollEligibilityView = PayrollEligibilityAssessment & { presentations: PayrollPresentationRegistry };
export function assessPayrollForDisplay(input: Parameters<typeof assessSwissPayrollEligibility>[0]): PayrollEligibilityView {
  const presentations: PayrollPresentationRegistry = new Map();
  return { ...assessSwissPayrollEligibility(input, presentations), presentations };
}
export function payrollEligibilityText(view: PayrollEligibilityView, original: string, language: AppLanguage = getAppLanguage()): string {
  const message = view.presentations.get(original);
  return message ? renderPayrollText(message, `${language}-CH`, (source, values) => t(source, values, language)) : t(original, undefined, language);
}
