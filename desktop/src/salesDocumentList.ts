import type { Invoice, Quote } from './types';
import { invoiceOpenBalance, searchText } from './utils';
import type { Payment } from './types';

export function matchesSalesDocumentSearch(document: Quote | Invoice, clientName: string, query: string): boolean {
  if (searchText([document.number, document.title, clientName], query)) return true;
  const reference = 'qrBill' in document ? document.qrBill?.input.reference : '';
  const compactQuery = query.replace(/\s/g, '').toUpperCase();
  return Boolean(reference && compactQuery && reference.replace(/\s/g, '').toUpperCase().includes(compactQuery));
}

export function matchesSalesDocumentStatus(document: Quote | Invoice, status: string, invoices: Invoice[], payments: Payment[], today: string): boolean {
  if (status === 'all') return true;
  if (status !== 'overdue' && status !== 'open') return document.status === status;
  if (!('dueDate' in document) || document.type === 'credit_note' || ['draft', 'cancelled'].includes(document.status)) return false;
  if (invoiceOpenBalance(document, invoices, payments) <= 0) return false;
  return status === 'open' || Boolean(document.dueDate && document.dueDate < today);
}
