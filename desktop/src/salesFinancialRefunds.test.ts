import { expect, it } from 'vitest';
import type { CustomerCreditSettlement, Invoice, Payment } from './types';
import { salesContributions, salesMetricRows, salesTotalsByCurrency, turnoverByCurrency } from './salesFinancials';

type Expected = { currency: string; paidCents: number; openCents: number; invoicedCents: number };
export type Case = { name: string; invoices: Invoice[]; payments: Payment[]; expected: Expected[]; omissionExpected: boolean; note: string };

function invoice(id: string, net: number, extra: Partial<Invoice> = {}): Invoice {
  return {
    id, number: `FICTIF-${id}`, clientId: 'client-fictif', projectId: null,
    quoteId: null, originalInvoiceId: null, title: 'Document fictif fermé', type: 'standard',
    issueDate: '2026-02-01', dueDate: '2026-03-01', serviceDateFrom: '', serviceDateTo: '',
    currency: 'CHF', status: 'issued', lines: [{ id: `line-${id}`, description: 'Ligne fictive', quantity: 1, unit: 'pce', unitPriceCents: net, vatRateBp: 810 }],
    notes: '', terms: '', depositPercentageBp: null, depositBasisLines: null,
    createdAt: '2026-02-01T00:00:00Z', creditedCents: 0, ...extra,
  };
}
function payment(id: string, invoiceId: string, amountCents: number): Payment {
  return { id, invoiceId, amountCents, date: '2026-02-15', method: 'bank', reference: `FICTIF-${id}` };
}
function event(id: string, creditNoteId: string, eventType: CustomerCreditSettlement['eventType'], amountCents: number, invoiceId: string | null = null, reversesId: string | null = null): CustomerCreditSettlement {
  return {
    id, requestId: `request-${id}`, creditNoteId, eventType, amountCents, invoiceId,
    date: reversesId ? '2026-04-02' : '2026-04-01', reference: `FICTIF-${id}`,
    reason: 'Témoin synthétique fermé', reversesId,
    bankAccountId: invoiceId === null ? 'bank-fictif' : null,
    journalEntryId: `journal-${id}`, journalValid: true,
  };
}
const expected = (paidCents: number, openCents: number, invoicedCents: number, currency = 'CHF'): Expected => ({ currency, paidCents, openCents, invoicedCents });

function modernFull(refunded = false, reversed = false, currency = 'CHF') {
  const sale = invoice(`sale-${currency}`, 10000, { status: 'paid', currency });
  const credit = invoice(`credit-${currency}`, -1000, { type: 'credit_note', originalInvoiceId: sale.id, issueDate: '2026-03-01', currency });
  const refund = event(`refund-${currency}`, credit.id, 'refund', 1081);
  credit.creditSettlements = refunded ? [refund, ...(reversed ? [event(`reverse-${currency}`, credit.id, 'reverse_refund', 1081, null, refund.id)] : [])] : [];
  credit.customerCredit = { allocatedCents: 0, refundedCents: refunded && !reversed ? 1081 : 0, remainingCents: refunded && !reversed ? 0 : 1081 };
  return { invoices: [sale, credit], payments: [payment(`receipt-${currency}`, sale.id, 10810)] };
}
function partial(refunded = false, reversedApply = false) {
  const sale = invoice('partial-sale', 10000, { status: reversedApply ? 'partially_paid' : 'paid', creditedCents: reversedApply ? 0 : 5405 });
  const credit = invoice('partial-credit', -7500, { type: 'credit_note', originalInvoiceId: sale.id, issueDate: '2026-03-01' });
  const apply = event('apply', credit.id, 'apply', 5405, sale.id);
  const applicationEvents = [apply, ...(reversedApply ? [event('reverse-apply', credit.id, 'reverse_apply', 5405, sale.id, apply.id)] : [])];
  // The real bridge attaches applications to BOTH documents (same event IDs).
  sale.creditSettlements = applicationEvents;
  credit.creditSettlements = [...applicationEvents, ...(refunded ? [event('partial-refund', credit.id, 'refund', 2703)] : [])];
  credit.customerCredit = { allocatedCents: reversedApply ? 0 : 5405, refundedCents: refunded ? 2703 : 0, remainingCents: reversedApply ? 8108 : refunded ? 0 : 2703 };
  return { invoices: [sale, credit], payments: [payment('partial-receipt', sale.id, 5405)] };
}
function legacy() {
  const sale = invoice('legacy-sale', 20000, { status: 'paid', creditedCents: undefined });
  const credit = invoice('legacy-credit', -2000, { type: 'credit_note', originalInvoiceId: sale.id, issueDate: '2026-03-01', creditedCents: undefined });
  return { invoices: [sale, credit], payments: [payment('legacy-receipt', sale.id, 21620), payment('legacy-signed-refund', sale.id, -2162)] };
}

export function fixtures(): Case[] {
  const modern = modernFull(true);
  const historical = legacy();
  const euros = modernFull(true, false, 'EUR');
  return [
    { name: 'issued-credit-without-cash-refund', ...modernFull(), expected: [expected(10810, 0, 9729)], omissionExpected: false, note: 'Issuing an unapplied credit changes invoiced/turnover, not recorded cash.' },
    { name: 'modern-refund', ...modern, expected: [expected(9729, 0, 9729)], omissionExpected: true, note: 'Positive refund 1081 is an outgoing cash contribution; invoice receipt 10810 remains unchanged.' },
    { name: 'modern-refund-reversed', ...modernFull(true, true), expected: [expected(10810, 0, 9729)], omissionExpected: false, note: 'Positive reverse_refund 1081 cancels its linked positive refund; credit itself remains issued.' },
    { name: 'compensation-with-no-fictitious-cash', ...partial(), expected: [expected(5405, 0, 2702)], omissionExpected: false, note: 'Native test uses 10000 HT sale, 5405 paid, 7500 HT credit = 8108 TTC: apply 5405 and credit remaining 2703. Duplicate application representation must contribute zero cash.' },
    { name: 'compensation-then-refund', ...partial(true), expected: [expected(2702, 0, 2702)], omissionExpected: true, note: 'Same native scenario, refund remaining 2703: 5405 - 2703 = 2702; do not subtract apply or credit face value again.' },
    { name: 'compensation-reversed', ...partial(false, true), expected: [expected(5405, 5405, 2702)], omissionExpected: false, note: 'reverse_apply restores invoice receivable, not cash; both application events appear on both documents.' },
    { name: 'historical-signed-payment-preserved', ...historical, expected: [expected(19458, 0, 19458)], omissionExpected: false, note: 'Compatibility of already supplied signed Payment values only; current native payment API rejects non-positive new payments. No modern event is manufactured from this legacy row.' },
    { name: 'independent-modern-and-historical-facts', invoices: [...modern.invoices, ...historical.invoices], payments: [...modern.payments, ...historical.payments], expected: [expected(29187, 0, 29187)], omissionExpected: true, note: 'Distinct documents and event IDs; preserve historical -2162 exactly once and include only modern refund -1081 once.' },
    { name: 'currency-separation', invoices: [...modern.invoices, ...euros.invoices], payments: [...modern.payments, ...euros.payments], expected: [expected(9729, 0, 9729), expected(9729, 0, 9729, 'EUR')], omissionExpected: true, note: 'Same amounts in separate CHF/EUR ledgers are not duplicates and must never be added across currencies.' },
  ];
}

it.each(fixtures())('$name keeps cash, credits, receivables and currency aligned', ({ invoices, payments, expected: totals }) => {
  const before = structuredClone({ invoices, payments });
  expect(salesTotalsByCurrency(invoices, payments)).toEqual(totals);
  const rows = salesContributions(invoices, payments);
  for (const total of totals) {
    for (const field of ['paidCents', 'openCents', 'invoicedCents'] as const) {
      expect(rows.filter(row => row.currency === total.currency).reduce((sum, row) => sum + row[field], 0)).toBe(total[field]);
    }
  }
  expect({ invoices, payments }).toEqual(before);
});

it('keeps the cash detail on the exact credit note, independent of the annual turnover filter', () => {
  const { invoices, payments } = modernFull(true);
  const credit = invoices[1];
  credit.issueDate = '2025-12-31';
  credit.creditSettlements![0].date = '2026-04-01';
  const row = salesMetricRows(invoices, payments, 'paidCents', 2026).find(item => item.invoice.id === credit.id);
  expect(row).toMatchObject({ paidCents: -1081, openCents: 0, currency: 'CHF' });
  expect(row?.invoice).toBe(credit);
  expect(turnoverByCurrency(invoices, 2026)).toEqual([{ currency: 'CHF', netCents: 10000 }]);
  expect(salesMetricRows(invoices, payments, 'paidCents', 2026).reduce((sum, item) => sum + item.paidCents, 0)).toBe(9729);
});

it('counts one canonical event ID once without adding the credit balance or requiring a valid journal', () => {
  const { invoices, payments } = modernFull(true);
  const credit = invoices[1];
  const refund = { ...credit.creditSettlements![0], journalEntryId: null, journalValid: false };
  credit.creditSettlements = [refund, { ...refund }];
  // An extra representation on another document is not a second cash event.
  invoices[0].creditSettlements = [{ ...refund }];
  expect(credit.customerCredit?.refundedCents).toBe(1081);
  expect(salesTotalsByCurrency(invoices, payments)).toEqual([expected(9729, 0, 9729)]);
  const refundRows = salesMetricRows(invoices, payments, 'paidCents', 2026).filter(row => row.paidCents < 0);
  expect(refundRows).toHaveLength(1);
  expect(refundRows[0].invoice).toBe(credit);
});
