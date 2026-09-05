import type { Expense } from './types';

export function expenseRefundTotals(expense: Pick<Expense, 'refunds'>) {
  return (expense.refunds ?? []).reduce((totals, refund) => {
    const sign = refund.eventType === 'reverse' ? -1 : 1;
    return { netCents: totals.netCents + sign * refund.netCents, vatCents: totals.vatCents + sign * refund.vatCents, totalCents: totals.totalCents + sign * refund.totalCents, costCents: totals.costCents + sign * refund.costCents };
  }, { netCents: 0, vatCents: 0, totalCents: 0, costCents: 0 });
}
