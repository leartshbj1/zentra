import type { DocumentLine, Invoice, Payment, Payslip, Project, Quote, TimeEntry } from './types';

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

export function formatMoney(cents: number | null | undefined): string {
  return new Intl.NumberFormat('fr-CH', {
    style: 'currency',
    currency: 'CHF',
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

export function documentTotals(lines: DocumentLine[]) {
  const netCents = lines.reduce((total, line) => total + Math.round(line.quantity * line.unitPriceCents), 0);
  const vatCents = lines.reduce(
    (total, line) => total + Math.round((line.quantity * line.unitPriceCents * line.vatRateBp) / 10_000),
    0,
  );
  return { netCents, vatCents, totalCents: netCents + vatCents };
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
  expenses: { projectId: string; netCents: number }[],
) {
  const issued = invoices.filter(
    (invoice) => invoice.projectId === project.id && invoice.status !== 'draft' && invoice.status !== 'cancelled',
  );
  const invoicedNet = issued.reduce((total, invoice) => total + documentTotals(invoice.lines).netCents, 0);
  const invoicedTotal = issued.reduce((total, invoice) => total + documentTotals(invoice.lines).totalCents, 0);
  const paid = issued.reduce((total, invoice) => total + invoicePaid(invoice.id, payments), 0);
  const projectEntries = entries.filter((entry) => entry.projectId === project.id);
  const minutes = projectEntries.reduce((total, entry) => total + entry.minutes, 0);
  const laborCost = projectEntries.reduce(
    (total, entry) => total + Math.round((entry.minutes * entry.hourlyCostCents) / 60),
    0,
  );
  const expenseNet = expenses
    .filter((expense) => expense.projectId === project.id)
    .reduce((total, expense) => total + expense.netCents, 0);
  return {
    invoicedNet,
    invoicedTotal,
    paid,
    minutes,
    laborCost,
    expenseNet,
    margin: invoicedNet - laborCost - expenseNet,
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
  const normalized = query.trim().toLocaleLowerCase('fr-CH');
  if (!normalized) return true;
  return values.join(' ').toLocaleLowerCase('fr-CH').includes(normalized);
}

export function countDocuments(quotes: Quote[], invoices: Invoice[]): number {
  return quotes.length + invoices.length;
}
