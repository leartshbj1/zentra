import type { DocumentLine, Invoice, Payment, Payslip, Project, PurchaseCostEvidence, Quote, SupplierCreditNote, SupplierInvoice, TimeEntry } from './types';

export function errorMessage(reason: unknown, fallback: string): string {
  if (typeof reason === 'string' && reason.trim()) return reason.trim();
  if (reason instanceof Error && reason.message.trim()) return reason.message.trim();
  if (reason && typeof reason === 'object' && 'message' in reason) {
    const message = (reason as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return fallback;
}

export function normalizeLicenseToken(value: string): string {
  return value.replace(/[\s\u200B-\u200D\u2060\uFEFF]/g, '');
}

export function formatMoney(cents: number | null | undefined, currency = 'CHF'): string {
  return new Intl.NumberFormat('fr-CH', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format((cents ?? 0) / 100);
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(`${value.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleDateString('fr-CH', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleString('fr-CH', { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatMinutes(minutes: number): string {
  const hours = Math.floor(Math.max(0, minutes) / 60);
  const rest = Math.max(0, minutes) % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${String(rest).padStart(2, '0')}`;
}

export function formatTimer(totalSeconds: number): string {
  const safe = Math.max(0, totalSeconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
}

export function centsFromInput(value: FormDataEntryValue | null): number {
  if (typeof value !== 'string' || value.trim() === '') return 0;
  const parsed = Number(value.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}

export function numberFromInput(value: FormDataEntryValue | null): number {
  if (typeof value !== 'string' || value.trim() === '') return 0;
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function roundBasisPoints(value: number, basisPoints: number): number {
  if (!value) return 0;
  const normalizedBasisPoints = Math.max(0, Math.min(10_000, Math.trunc(basisPoints)));
  const rounded = Math.floor((Math.abs(value) * normalizedBasisPoints + 5_000) / 10_000);
  return value < 0 ? -rounded : rounded;
}

export function documentLineTotals(line: DocumentLine) {
  const rawSubtotal = line.quantity * line.unitPriceCents;
  const subtotalCents = rawSubtotal < 0 ? -Math.round(-rawSubtotal) : Math.round(rawSubtotal);
  const discountCents = roundBasisPoints(subtotalCents, line.discountBp ?? 0);
  const netCents = subtotalCents - discountCents;
  const vatCents = roundBasisPoints(netCents, line.vatRateBp);
  return { subtotalCents, discountCents, netCents, vatCents, totalCents: netCents + vatCents };
}

export function documentTotals(lines: DocumentLine[]) {
  return lines.reduce(
    (totals, line) => {
      const current = documentLineTotals(line);
      totals.subtotalCents += current.subtotalCents;
      totals.discountCents += current.discountCents;
      totals.netCents += current.netCents;
      totals.vatCents += current.vatCents;
      totals.totalCents += current.totalCents;
      return totals;
    },
    { subtotalCents: 0, discountCents: 0, netCents: 0, vatCents: 0, totalCents: 0 },
  );
}

export function invoicePaid(invoiceId: string, payments: Payment[]): number {
  return payments
    .filter((payment) => payment.invoiceId === invoiceId)
    .reduce((total, payment) => total + payment.amountCents, 0);
}

export function invoiceCredited(invoiceId: string, invoices: Invoice[]): number {
  return invoices
    .filter(
      (invoice) =>
        invoice.type === 'credit_note' &&
        invoice.originalInvoiceId === invoiceId &&
        invoice.status !== 'draft' &&
        invoice.status !== 'cancelled',
    )
    .reduce(
      (total, invoice) =>
        total + Math.max(0, -documentTotals(invoice.lines).totalCents),
      0,
    );
}

export function invoiceOpenBalance(
  invoice: Invoice,
  invoices: Invoice[],
  payments: Payment[],
): number {
  return Math.max(
    0,
    documentTotals(invoice.lines).totalCents -
      invoicePaid(invoice.id, payments) -
      invoiceCredited(invoice.id, invoices),
  );
}

export function payslipTotals(payslip: Payslip) {
  const earnings = payslip.lines
    .filter((line) => line.kind === 'earning')
    .reduce((total, line) => total + line.amountCents, 0);
  const deductions = payslip.lines
    .filter((line) => line.kind === 'deduction')
    .reduce((total, line) => total + line.amountCents, 0);
  const employer = payslip.lines
    .filter((line) => line.kind === 'employer')
    .reduce((total, line) => total + line.amountCents, 0);
  const reimbursements = payslip.lines
    .filter((line) => line.kind === 'reimbursement')
    .reduce((total, line) => total + line.amountCents, 0);
  return { earnings, deductions, reimbursements, employer, net: earnings - deductions + reimbursements };
}

export function projectFinancials(
  project: Project,
  invoices: Invoice[],
  payments: Payment[],
  entries: TimeEntry[],
  expenses: ({ projectId?: string | null; netCents: number } & PurchaseCostEvidence)[],
  supplierInvoices: SupplierInvoice[] = [],
  supplierCreditNotes: SupplierCreditNote[] = [],
) {
  const issued = invoices.filter(
    (invoice) => invoice.projectId === project.id && invoice.status !== 'draft' && invoice.status !== 'cancelled',
  );
  const invoicedNet = issued.reduce((total, invoice) => total + documentTotals(invoice.lines).netCents, 0);
  const invoicedTotal = issued.reduce((total, invoice) => total + documentTotals(invoice.lines).totalCents, 0);
  const paid = issued.reduce((total, invoice) => total + invoicePaid(invoice.id, payments), 0);
  const currencyTotals = new Map<string, { net: number; total: number }>();
  for (const invoice of issued) {
    const currency = invoice.currency || 'CHF';
    const amounts = documentTotals(invoice.lines);
    const current = currencyTotals.get(currency) ?? { net: 0, total: 0 };
    currencyTotals.set(currency, { net: current.net + amounts.netCents, total: current.total + amounts.totalCents });
  }
  const requiresCurrencyConversion = [...currencyTotals.keys()].some((currency) => currency !== 'CHF');
  const revenueByCurrency = [...currencyTotals].sort(([left], [right]) => left.localeCompare(right));
  const projectEntries = entries.filter((entry) => entry.projectId === project.id);
  const minutes = projectEntries.reduce((total, entry) => total + entry.minutes, 0);
  const laborCost = projectEntries.reduce(
    (total, entry) => total + Math.round((entry.minutes * entry.hourlyCostCents) / 60),
    0,
  );
  const purchases = [
    ...expenses.filter((expense) => expense.projectId === project.id),
    ...supplierInvoices.filter((invoice) => invoice.documentStatus === 'validated')
      .flatMap((invoice) => invoice.lines.filter((line) => (line.projectId ?? invoice.projectId) === project.id)),
  ];
  const credits = supplierCreditNotes.filter((credit) => credit.status === 'validated')
    .flatMap((credit) => credit.items.filter((line) => line.projectId === project.id));
  const cost = (line: { netCents: number } & PurchaseCostEvidence) => line.costCents ?? line.netCents;
  const purchaseGrossCost = purchases.reduce((total, line) => total + cost(line), 0);
  const purchaseCreditCost = credits.reduce((total, line) => total + cost(line), 0);
  const expenseNet = purchaseGrossCost - purchaseCreditCost;
  const nonDeductibleVatCost = purchases.reduce((total, line) => total + cost(line) - line.netCents, 0)
    - credits.reduce((total, line) => total + cost(line) - line.netCents, 0);
  const purchaseCostReviewCount = [...purchases, ...credits].filter((line) => line.costReviewRequired).length;
  const marginUnavailableReason = requiresCurrencyConversion ? 'Conversion CHF requise'
    : purchaseCostReviewCount ? 'Coût des achats à contrôler' : null;
  return {
    hasActivity: Boolean(issued.length || projectEntries.length || purchases.length || credits.length),
    invoicedNet,
    invoicedTotal,
    paid,
    minutes,
    laborCost,
    expenseNet,
    purchaseGrossCost,
    purchaseCreditCost,
    nonDeductibleVatCost,
    purchaseCostReviewCount,
    marginUnavailableReason,
    invoicedNetLabel: revenueByCurrency.map(([currency, amount]) => formatMoney(amount.net, currency)).join(' · ') || formatMoney(0),
    invoicedTotalLabel: revenueByCurrency.map(([currency, amount]) => formatMoney(amount.total, currency)).join(' · ') || formatMoney(0),
    requiresCurrencyConversion,
    margin: marginUnavailableReason ? null : invoicedNet - laborCost - expenseNet,
  };
}

export function todayIso(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  return new Date(now.getTime() - offset * 60_000).toISOString().slice(0, 10);
}

export function addDaysIso(start: string, days: number): string {
  if (!start) return '';
  const date = new Date(`${start}T12:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

export function createId(): string {
  return crypto.randomUUID();
}

export function searchText(values: Array<string | null | undefined>, query: string): boolean {
  const normalize = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('fr-CH').replace(/\s+/g, ' ').trim();
  const normalized = normalize(query);
  if (!normalized) return true;
  return normalize(values.join(' ')).includes(normalized);
}

export function countDocuments(quotes: Quote[], invoices: Invoice[]): number {
  return quotes.length + invoices.length;
}
