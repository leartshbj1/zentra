import type { Invoice } from './types';
import { addDaysIso } from './utils';
import { invoiceDateIssues, isSalesDate, type InvoiceDates } from './salesFormValidation';

export type PairedInvoiceFields = InvoiceDates & { notes: string };
export type PairedInvoiceStep = 'service' | 'payment' | 'review';
export const pairedDateStep = (field: keyof InvoiceDates): PairedInvoiceStep => field.startsWith('service') ? 'service' : 'payment';
export const pairedPaymentDays = (days: number) => Number.isInteger(days) && days >= 0 && days <= 365 ? days : 30;

export function initialPairedInvoiceFields(invoice: Invoice, days: number, today: string, readOnly = false): PairedInvoiceFields {
  const issueDate = invoice.issueDate || (readOnly ? '' : today);
  return {
    issueDate,
    dueDate: invoice.dueDate || (!readOnly && isSalesDate(issueDate) ? addDaysIso(issueDate, pairedPaymentDays(days)) : ''),
    serviceDateFrom: invoice.serviceDateFrom || '', serviceDateTo: invoice.serviceDateTo || '', notes: invoice.notes || '',
  };
}

/** Follow the suggested payment term until the user supplies a different due date. */
export function changePairedIssueDate(fields: PairedInvoiceFields, issueDate: string, days: number): PairedInvoiceFields {
  const suggested = isSalesDate(fields.issueDate) ? addDaysIso(fields.issueDate, pairedPaymentDays(days)) : '';
  const follow = !fields.dueDate || fields.dueDate === suggested;
  return { ...fields, issueDate, dueDate: follow && isSalesDate(issueDate) ? addDaysIso(issueDate, pairedPaymentDays(days)) : fields.dueDate };
}

/** Copy only service dates from the verified counterpart, never its payment dates or notes. */
export function pairedServiceReference(invoice: Invoice, invoices: Invoice[]): Invoice | null {
  const pair = invoice.billingPair;
  if (!pair || !invoice.quoteId || ![pair.depositInvoiceId, pair.balanceInvoiceId].includes(invoice.id)) return null;
  const id = invoice.id === pair.depositInvoiceId ? pair.balanceInvoiceId : pair.depositInvoiceId;
  const other = invoices.find(row => row.id === id && row.id !== invoice.id);
  if (!other || other.status === 'cancelled' || other.quoteId !== invoice.quoteId || other.clientId !== invoice.clientId || other.currency !== invoice.currency
    || other.billingPair?.depositInvoiceId !== pair.depositInvoiceId || other.billingPair.balanceInvoiceId !== pair.balanceInvoiceId) return null;
  if (invoiceDateIssues(other).some(issue => pairedDateStep(issue.field) === 'service')) return null;
  return other;
}
