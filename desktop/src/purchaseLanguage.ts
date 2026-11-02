import { getAppLanguage, t, type AppLanguage } from './language';
import type { PurchaseIssue } from './supplierInvoicePreparation';

export function purchaseIssueText(issue: PurchaseIssue, language: AppLanguage = getAppLanguage()): string {
  const message = t(issue.message, undefined, language);
  return issue.line ? t('Ligne {number} : {message}', { number: issue.line, message }, language) : message;
}

