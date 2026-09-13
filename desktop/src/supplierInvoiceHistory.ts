import type { SupplierCreditNote, SupplierInvoice, SupplierInvoicePayment } from './types';
import { isSalesDate } from './salesFormValidation';

export type SupplierInvoiceEvent = {
  id: string; kind: 'payment' | 'credit' | 'credit_reversal'; date: string | null; createdAt: string;
  amountCents: number; reference: string; note: string; method?: string; creditId?: string; journalEntryId?: string;
};

export function supplierInvoiceHistory(invoice: SupplierInvoice, credits: SupplierCreditNote[]): SupplierInvoiceEvent[] {
  const payments = (invoice.payments ?? []).map((payment: SupplierInvoicePayment): SupplierInvoiceEvent => ({
    id: `payment-${payment.id}`, kind: 'payment', date: isSalesDate(payment.date) ? payment.date : null,
    createdAt: payment.createdAt, amountCents: payment.amountCents, reference: payment.reference, note: payment.notes, method: payment.method, journalEntryId: payment.journalEntryId,
  }));
  const allocations = credits.flatMap(credit => (credit.allocations ?? []).filter(row => row.supplierInvoiceId === invoice.id).map((row): SupplierInvoiceEvent => ({
    id: `credit-${row.id}`, kind: row.eventType === 'reverse' ? 'credit_reversal' : 'credit', date: row.effectiveDate && isSalesDate(row.effectiveDate) ? row.effectiveDate : null,
    createdAt: row.createdAt, amountCents: row.amountCents, reference: credit.number || credit.reference, note: row.reason, creditId: credit.id,
  })));
  // A creation timestamp is only a tie-breaker, never a replacement settlement date.
  return [...payments, ...allocations].sort((left, right) => (right.date ?? '').localeCompare(left.date ?? '') || right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
}

export function supplierInvoiceDetailState(invoice: SupplierInvoice, credits: SupplierCreditNote[]) {
  const history = supplierInvoiceHistory(invoice, credits);
  const amounts = [invoice.totalCents, invoice.paidCents, invoice.creditedCents, invoice.balanceCents];
  const validAmounts = amounts.every(value => Number.isSafeInteger(value) && value >= 0);
  const validBalance = validAmounts && BigInt(invoice.totalCents) - BigInt(invoice.paidCents) - BigInt(invoice.creditedCents) === BigInt(invoice.balanceCents);
  const validHistoryAmounts = history.every(row => Number.isSafeInteger(row.amountCents) && row.amountCents > 0);
  const paymentSum = validHistoryAmounts ? history.filter(row => row.kind === 'payment').reduce((sum, row) => sum + BigInt(row.amountCents), 0n) : null;
  const creditSum = validHistoryAmounts ? history.filter(row => row.kind !== 'payment').reduce((sum, row) => sum + BigInt(row.amountCents) * (row.kind === 'credit_reversal' ? -1n : 1n), 0n) : null;
  const historyComplete = validAmounts && paymentSum === BigInt(invoice.paidCents) && creditSum === BigInt(invoice.creditedCents);
  return { history, validBalance, historyComplete, settled: validBalance && invoice.documentStatus === 'validated' && invoice.balanceCents === 0 };
}

export function supplierPaymentMethodSource(method: string): string | null {
  return ({ bank_transfer: 'Virement bancaire', card: 'Carte', cash: 'Espèces', other: 'Autre' } as Record<string, string>)[method] ?? null;
}
