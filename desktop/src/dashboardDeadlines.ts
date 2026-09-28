import type { Invoice } from './types';

/** Next unpaid due dates first; never reorder the shared workspace collection. */
export function dashboardDeadlines(invoices: Invoice[], limit = 5): Invoice[] {
  return invoices
    .filter(invoice => invoice.type !== 'credit_note' && ['issued', 'partially_paid'].includes(invoice.status))
    .sort((left, right) => (left.dueDate || '9999-12-31').localeCompare(right.dueDate || '9999-12-31'))
    .slice(0, limit);
}
