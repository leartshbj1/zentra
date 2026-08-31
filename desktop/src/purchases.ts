import type { Expense, Project, Supplier } from './types';
import { addDaysIso, searchText } from './utils';

export type PurchaseTab = 'pending' | 'paid' | 'suppliers';
export type SupplierVisibility = 'active' | 'archived' | 'all';

export function expensePaymentStatusFromRaw(value: unknown): Expense['paymentStatus'] {
  return value === 'pending' ? 'pending' : 'paid';
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

export function isExpenseOverdue(expense: Expense, today: string): boolean {
  return expense.paymentStatus === 'pending' && Boolean(expense.dueDate && expense.dueDate < today);
}

export function purchaseSummary(expenses: Expense[], today: string) {
  return expenses.reduce((summary, expense) => {
    if (expense.paymentStatus === 'pending') {
      summary.pendingCents += expense.totalCents;
      summary.pendingCount += 1;
      if (isExpenseOverdue(expense, today)) {
        summary.overdueCents += expense.totalCents;
        summary.overdueCount += 1;
      }
    } else {
      summary.paidCents += expense.totalCents;
      summary.paidCount += 1;
    }
    return summary;
  }, { pendingCents: 0, overdueCents: 0, paidCents: 0, pendingCount: 0, overdueCount: 0, paidCount: 0 });
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
