import type { Invoice, Payment } from './types';
import { documentTotals, formatMoney } from './utils';

export type SalesCurrencyTotal = { currency: string; invoicedCents: number; paidCents: number; openCents: number };
export type SalesContribution = SalesCurrencyTotal & { invoice: Invoice; netCents: number };
export type SalesMetric = 'invoicedCents' | 'paidCents' | 'openCents' | 'netCents';

/** Shared invoice contributions keep the dashboard and its detail exactly aligned. */
export function salesContributions(invoices: Invoice[], payments: Payment[]): SalesContribution[] {
  const paidByInvoice = new Map<string, number>();
  const legacyCredits = new Map<string, number>();
  const firstInvoiceById = new Map<string, Invoice>();
  const documents = invoices.map(invoice => ['draft','cancelled'].includes(invoice.status) ? {totalCents:0,netCents:0} : documentTotals(invoice.lines));
  const amounts = documents.map((document,index) => ['draft', 'cancelled'].includes(invoices[index].status) ? 0 : document.totalCents);
  for (const payment of payments) paidByInvoice.set(payment.invoiceId, (paidByInvoice.get(payment.invoiceId) ?? 0) + payment.amountCents);
  invoices.forEach((invoice, index) => {
    if (!firstInvoiceById.has(invoice.id)) firstInvoiceById.set(invoice.id, invoice);
    if (invoice.type === 'credit_note' && !['draft', 'cancelled'].includes(invoice.status) && invoice.originalInvoiceId != null) {
      legacyCredits.set(invoice.originalInvoiceId, (legacyCredits.get(invoice.originalInvoiceId) ?? 0) + Math.max(0, -amounts[index]));
    }
  });
  const rows: SalesContribution[] = [];
  for (const [index, invoice] of invoices.entries()) {
    if (['draft', 'cancelled'].includes(invoice.status)) continue;
    const currency = invoice.currency || 'CHF';
    const total: SalesContribution = { invoice, currency, invoicedCents: amounts[index], netCents: documents[index].netCents, paidCents: 0, openCents: 0 };
    if (invoice.type !== 'credit_note') {
      const paid = paidByInvoice.get(invoice.id) ?? 0;
      const credited = firstInvoiceById.get(invoice.id)?.creditedCents ?? legacyCredits.get(invoice.id) ?? 0;
      total.paidCents += paid;
      total.openCents += Math.max(0, amounts[index] - paid - credited);
    }
    rows.push(total);
  }
  return rows;
}

/** Never add different currencies without an explicit conversion rate. */
export function salesTotalsByCurrency(invoices: Invoice[], payments: Payment[]): SalesCurrencyTotal[] {
  const totals = new Map<string, SalesCurrencyTotal>();
  for (const row of salesContributions(invoices, payments)) {
    const total = totals.get(row.currency) ?? {currency: row.currency, invoicedCents: 0, paidCents: 0, openCents: 0};
    total.invoicedCents += row.invoicedCents;
    total.paidCents += row.paidCents;
    total.openCents += row.openCents;
    totals.set(row.currency, total);
  }
  return [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

export function salesMetricRows(invoices: Invoice[], payments: Payment[], metric: SalesMetric, year: number) {
  return salesContributions(invoices, payments)
    .filter(row => metric === 'netCents' ? row.invoice.issueDate.startsWith(`${year}-`) : metric === 'invoicedCents' || row[metric] !== 0)
    .sort((a,b) => b.invoice.issueDate.localeCompare(a.invoice.issueDate) || b.invoice.number.localeCompare(a.invoice.number));
}

export function formatSalesTotals(totals: SalesCurrencyTotal[], field: 'invoicedCents' | 'paidCents' | 'openCents'): string {
  return totals.map((total) => formatMoney(total[field], total.currency)).join(' · ') || '—';
}

/** Management revenue: issued document lines already contain deposit deductions and negative credit lines. */
export function turnoverByCurrency(invoices: Invoice[], year = new Date().getFullYear()) {
  const totals = new Map<string, number>();
  for (const invoice of invoices) {
    if (['draft', 'cancelled'].includes(invoice.status) || !invoice.issueDate.startsWith(`${year}-`)) continue;
    const currency = invoice.currency || 'CHF';
    totals.set(currency, (totals.get(currency) ?? 0) + documentTotals(invoice.lines).netCents);
  }
  return [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([currency, netCents]) => ({currency, netCents}));
}
export function turnoverLabel(invoices: Invoice[], year = new Date().getFullYear()) {
  return turnoverByCurrency(invoices, year).map(row => formatMoney(row.netCents, row.currency)).join(' · ') || formatMoney(0);
}
