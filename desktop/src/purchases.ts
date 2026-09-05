import { expenseRefundTotals } from './expenseRefunds';
import type {
  AccountingSettings,
  Expense,
  Project,
  Supplier,
  SupplierInvoice,
} from './types';
import { addDaysIso, searchText } from './utils';

export type PurchaseTab = 'draft' | 'pending' | 'partial' | 'paid' | 'suppliers';
export type SupplierVisibility = 'active' | 'archived' | 'all';

export function expensePaymentStatusFromRaw(value: unknown): Expense['paymentStatus'] {
  return value === 'paid' ? 'paid' : 'pending';
}

export function supplierInvoiceAccountingReady(
  accounting: AccountingSettings | null | undefined,
): boolean {
  return Boolean(
    accounting?.enabled &&
      accounting.expenseAccountId &&
      accounting.vatReceivableAccountId &&
      accounting.supplierPayableAccountId,
  );
}

export function activeSuppliers(suppliers: Supplier[]): Supplier[] {
  return suppliers.filter((supplier) => !supplier.archivedAt).sort(compareSuppliers);
}

export function selectableSuppliers(suppliers: Supplier[], currentSupplierId?: string | null): Supplier[] {
  const active = activeSuppliers(suppliers);
  const current = currentSupplierId ? suppliers.find((supplier) => supplier.id === currentSupplierId) : undefined;
  return current?.archivedAt && !active.some((supplier) => supplier.id === current.id) ? [current, ...active] : active;
}

export function filterSuppliers(
  suppliers: Supplier[],
  query: string,
  visibility: SupplierVisibility,
): Supplier[] {
  return suppliers
    .filter((supplier) => visibility === 'all' || (visibility === 'archived' ? Boolean(supplier.archivedAt) : !supplier.archivedAt))
    .filter((supplier) => searchText([supplier.name, supplier.contactName, supplier.email, supplier.phone, supplier.uidNumber, supplier.iban, supplier.address, supplier.notes], query))
    .sort(compareSuppliers);
}

export function filterPurchaseExpenses(
  expenses: Expense[],
  projects: Project[],
  query: string,
  status: Expense['paymentStatus'],
): Expense[] {
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  return expenses
    .filter((expense) => expense.paymentStatus === status)
    .filter((expense) => searchText([expense.supplier, expense.category, expense.reference, expense.note, expense.projectId ? projectNames.get(expense.projectId) : ''], query))
    .sort((left, right) => {
      if (status === 'pending') return (left.dueDate ?? '9999-12-31').localeCompare(right.dueDate ?? '9999-12-31') || right.date.localeCompare(left.date);
      return (right.paidAt ?? right.date).localeCompare(left.paidAt ?? left.date);
    });
}

export function filterSupplierInvoices(
  invoices: SupplierInvoice[],
  projects: Project[],
  query: string,
  status: Exclude<PurchaseTab, 'suppliers'>,
): SupplierInvoice[] {
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  return invoices
    .filter((invoice) => status === 'draft'
      ? invoice.documentStatus === 'draft'
      : invoice.documentStatus === 'validated' && invoice.paymentStatus === status)
    .filter((invoice) => searchText([
      invoice.supplierName,
      invoice.reference,
      invoice.note,
      invoice.projectId ? projectNames.get(invoice.projectId) : '',
      ...invoice.lines.flatMap((line) => [line.description, line.category]),
      ...invoice.payments.flatMap((payment) => [payment.method, payment.reference, payment.notes]),
    ], query))
    .sort((left, right) => {
      if (status === 'pending' || status === 'partial') {
        return left.dueDate.localeCompare(right.dueDate)
          || right.documentDate.localeCompare(left.documentDate);
      }
      if (status === 'paid') return right.updatedAt.localeCompare(left.updatedAt);
      return right.updatedAt.localeCompare(left.updatedAt);
    });
}

export function isExpenseOverdue(expense: Expense, today: string): boolean {
  return expense.paymentStatus === 'pending' && Boolean(expense.dueDate && expense.dueDate < today);
}

export function isSupplierInvoiceOverdue(invoice: SupplierInvoice, today: string): boolean {
  return invoice.documentStatus === 'validated'
    && invoice.paymentStatus !== 'paid'
    && invoice.balanceCents > 0
    && invoice.dueDate < today;
}

export function purchaseSummary(
  expenses: Expense[],
  today: string,
  supplierInvoices: SupplierInvoice[] = [],
) {
  const summary = expenses.reduce((current, expense) => {
    if (expense.paymentStatus === 'pending') {
      current.pendingCents += expense.totalCents;
      current.pendingCount += 1;
      if (isExpenseOverdue(expense, today)) {
        current.overdueCents += expense.totalCents;
        current.overdueCount += 1;
      }
    } else {
      current.paidCents += expense.totalCents - expenseRefundTotals(expense).totalCents;
      current.paidCount += 1;
    }
    return current;
  }, {
    draftCount: 0,
    partialCount: 0,
    pendingCents: 0,
    overdueCents: 0,
    paidCents: 0,
    pendingCount: 0,
    overdueCount: 0,
    paidCount: 0,
  });

  for (const invoice of supplierInvoices) {
    if (invoice.documentStatus === 'draft') {
      summary.draftCount += 1;
      continue;
    }
    summary.paidCents += invoice.paidCents;
    if (invoice.paymentStatus === 'paid') {
      summary.paidCount += 1;
      continue;
    }
    summary.pendingCents += invoice.balanceCents;
    summary.pendingCount += 1;
    if (invoice.paymentStatus === 'partial') summary.partialCount += 1;
    if (isSupplierInvoiceOverdue(invoice, today)) {
      summary.overdueCents += invoice.balanceCents;
      summary.overdueCount += 1;
    }
  }
  return summary;
}

export function supplierDueDate(expenseDate: string, supplier: Supplier | undefined, fallbackTermsDays: number): string {
  return addDaysIso(expenseDate, supplier?.paymentTermsDays ?? fallbackTermsDays);
}

export function supplierSnapshotForDraft(existing: Expense | undefined, selected: Supplier | undefined, manualName: string): string {
  if (existing && selected && existing.supplierId === selected.id) return existing.supplier;
  return selected?.name ?? manualName.trim();
}

function compareSuppliers(left: Supplier, right: Supplier): number {
  return left.name.localeCompare(right.name, 'fr-CH', { sensitivity: 'base' });
}
