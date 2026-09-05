import type { Invoice, Payment } from './types';
import { documentTotals, formatMoney, invoiceOpenBalance, invoicePaid } from './utils';

export type SalesCurrencyTotal = { currency: string; invoicedCents: number; paidCents: number; openCents: number };

/** Never add different currencies without an explicit conversion rate. */
export function salesTotalsByCurrency(invoices: Invoice[], payments: Payment[]): SalesCurrencyTotal[] {
  const totals = new Map<string, SalesCurrencyTotal>();
  for (const invoice of invoices) {
    if (['draft', 'cancelled'].includes(invoice.status)) continue;
    const currency = invoice.currency || 'CHF';
    const total = totals.get(currency) ?? { currency, invoicedCents: 0, paidCents: 0, openCents: 0 };
    total.invoicedCents += documentTotals(invoice.lines).totalCents;
    if (invoice.type !== 'credit_note') {
      total.paidCents += invoicePaid(invoice.id, payments);
      total.openCents += invoiceOpenBalance(invoice, invoices, payments);
    }
    totals.set(currency, total);
  }
  return [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

export function formatSalesTotals(totals: SalesCurrencyTotal[], field: 'invoicedCents' | 'paidCents' | 'openCents'): string {
  return totals.map((total) => formatMoney(total[field], total.currency)).join(' · ') || '—';
}
