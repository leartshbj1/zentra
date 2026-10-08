import type { AccountRole } from '../account-security';
import { minorInteger, validDate } from './accounting/ledger';
import { validateErpRequest } from './erp-request';
import { invoiceBalance } from './invoicing';
import { decimalToMoney } from './money';
import type { ErpCommand, ErpState } from './runtime-types';

export interface BrowserInvoiceDraft { estimateId: string; date: string; accountingDate: string; dueDate: string; periodId: string }
export interface BrowserCustomerPaymentDraft { invoiceId: string; amount: string; paymentDate: string; accountingDate: string; periodId: string; reference: string }
export const emptyBrowserInvoice = (): BrowserInvoiceDraft => ({ estimateId: '', date: '', accountingDate: '', dueDate: '', periodId: '' });
export const emptyBrowserCustomerPayment = (): BrowserCustomerPaymentDraft => ({ invoiceId: '', amount: '', paymentDate: '', accountingDate: '', periodId: '', reference: '' });
/** Presentation eligibility only; actual financial authority remains on the server. */
export const canUseBrowserSales = (role: AccountRole): boolean => ['owner', 'admin', 'accountant'].includes(role);
function workspace(organizationId: string, state: ErpState) {
  if (state.configuration.organizationId !== organizationId || state.configuration.country !== 'US' || state.configuration.currency !== 'USD') throw new TypeError('Invalid sales workspace');
}
function date(value: string) { if (typeof value !== 'string' || value.startsWith('0000-') || !validDate(value)) throw new TypeError('Invalid civil date'); }
function period(state: ErpState, periodId: string, accountingDate: string) {
  date(accountingDate);
  const found = state.ledger.periods.find(item => item.id === periodId);
  if (!found || found.status !== 'open' || accountingDate < found.start || accountingDate > found.end) throw new TypeError('Choose an open accounting period');
}
function checked<T extends ErpCommand>(organizationId: string, command: T): T {
  return validateErpRequest({ idempotencyKey: 'workbench-sales-validation', expectedRevision: 0, command }, organizationId).command as T;
}
/** No tax assessment, seller identity, number or authority comes from the form. */
export function buildBrowserInvoiceCommand(organizationId: string, state: ErpState, draft: BrowserInvoiceDraft, id: string, issuanceAvailable: boolean): Extract<ErpCommand, { type: 'issue_invoice' }> {
  workspace(organizationId, state);
  if (issuanceAvailable !== true) throw new TypeError('Trusted tax determination unavailable');
  const estimate = state.estimates.find(item => item.id === draft.estimateId && item.organizationId === organizationId && item.status === 'accepted');
  if (!estimate || state.invoices.some(item => item.sourceEstimateId === estimate.id)) throw new TypeError('Choose an unissued accepted estimate');
  date(draft.date); date(draft.dueDate); period(state, draft.periodId, draft.accountingDate);
  if (draft.dueDate < draft.date) throw new TypeError('Invalid due date');
  return checked(organizationId, { type: 'issue_invoice', id, estimateId: estimate.id, expectedEstimateRevision: estimate.revision, date: draft.date, accountingDate: draft.accountingDate, dueDate: draft.dueDate, periodId: draft.periodId });
}
/** Records a payment already received. It never initiates a bank transaction. */
export function buildBrowserCustomerPaymentCommand(organizationId: string, state: ErpState, draft: BrowserCustomerPaymentDraft, id: string): Extract<ErpCommand, { type: 'record_payment' }> {
  workspace(organizationId, state);
  const invoice = state.invoices.find(item => item.id === draft.invoiceId && item.organizationId === organizationId);
  if (!invoice) throw new TypeError('Choose an issued invoice');
  date(draft.paymentDate); period(state, draft.periodId, draft.accountingDate);
  if (typeof draft.amount !== 'string' || !/^[0-9]{1,36}(?:\.[0-9]{1,2})?$/.test(draft.amount)) throw new TypeError('Invalid USD amount');
  const amount = decimalToMoney('USD', draft.amount), minor = minorInteger(amount.minorUnits);
  if (minor <= BigInt(0) || minor > minorInteger(invoiceBalance(invoice).minorUnits)) throw new TypeError('Payment exceeds balance or is zero');
  if (typeof draft.reference !== 'string' || !draft.reference.trim() || draft.reference.length > 500 || Array.from(draft.reference).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new TypeError('Invalid payment reference');
  return checked(organizationId, { type: 'record_payment', id, invoiceId: invoice.id, amountMinor: amount.minorUnits, paymentDate: draft.paymentDate, accountingDate: draft.accountingDate, periodId: draft.periodId, reference: draft.reference.trim() });
}
