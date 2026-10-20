import type { Account } from './types';

export type CostCenter = { id: string; code: string; name: string; archivedAt: string | null };
export type CostCenterAssignment = { kind: 'project' | 'employee' | 'account'; targetId: string; costCenterId: string };
export type BudgetLine = { month: number; accountId: string; costCenterId: string; amountCents: number };
export type ActualLine = { month: number; accountId: string; costCenterId: string; debitCents: number; creditCents: number };
export type BudgetReport = { year: number; budget: BudgetLine[]; actual: ActualLine[]; entriesWaitingForRate: number };
/** 'all' : toute l'entreprise ; '' : lignes sans centre ; sinon l'id d'un centre. */
export type CenterFilter = string;

export type BudgetComparisonRow = {
  account: Pick<Account, 'id' | 'code' | 'name' | 'accountType'>;
  budgetYear: number;
  budgetToDate: number;
  actualToDate: number;
  /** Positif = mieux que prévu (plus de produits, moins de charges). */
  gap: number;
};
export type BudgetTotals = { budgetToDate: number; actualToDate: number };
export type BudgetComparison = { rows: BudgetComparisonRow[]; revenue: BudgetTotals; expense: BudgetTotals; result: BudgetTotals };

const matches = (filter: CenterFilter, center: string) => filter === 'all' || filter === center;

/** Montant annuel réparti sur douze mois ; les centimes restants vont aux premiers mois. */
export function spreadYearly(totalCents: number): number[] {
  const total = Math.max(0, Math.round(totalCents));
  const base = Math.floor(total / 12), rest = total - base * 12;
  return Array.from({ length: 12 }, (_, index) => base + (index < rest ? 1 : 0));
}

/** Réel signé : produits = crédit − débit, charges = débit − crédit. */
export function signedActual(line: Pick<ActualLine, 'debitCents' | 'creditCents'>, type: string): number {
  return type === 'revenue' ? line.creditCents - line.debitCents : line.debitCents - line.creditCents;
}

export function compareBudget(accounts: readonly Pick<Account, 'id' | 'code' | 'name' | 'accountType'>[], report: Pick<BudgetReport, 'budget' | 'actual'>, filter: CenterFilter, throughMonth: number): BudgetComparison {
  const rows: BudgetComparisonRow[] = [];
  const totals = { revenue: { budgetToDate: 0, actualToDate: 0 }, expense: { budgetToDate: 0, actualToDate: 0 } };
  for (const account of [...accounts].filter(row => row.accountType === 'revenue' || row.accountType === 'expense').sort((a, b) => a.code.localeCompare(b.code))) {
    const budget = report.budget.filter(line => line.accountId === account.id && matches(filter, line.costCenterId));
    const actual = report.actual.filter(line => line.accountId === account.id && matches(filter, line.costCenterId));
    if (!budget.length && !actual.length) continue;
    const budgetYear = budget.reduce((sum, line) => sum + line.amountCents, 0);
    const budgetToDate = budget.filter(line => line.month <= throughMonth).reduce((sum, line) => sum + line.amountCents, 0);
    const actualToDate = actual.filter(line => line.month <= throughMonth).reduce((sum, line) => sum + signedActual(line, account.accountType), 0);
    const gap = account.accountType === 'revenue' ? actualToDate - budgetToDate : budgetToDate - actualToDate;
    rows.push({ account, budgetYear, budgetToDate, actualToDate, gap });
    const bucket = totals[account.accountType as 'revenue' | 'expense'];
    bucket.budgetToDate += budgetToDate;
    bucket.actualToDate += actualToDate;
  }
  return {
    rows,
    revenue: totals.revenue,
    expense: totals.expense,
    result: { budgetToDate: totals.revenue.budgetToDate - totals.expense.budgetToDate, actualToDate: totals.revenue.actualToDate - totals.expense.actualToDate },
  };
}

/** Budget proposé d'après le réel d'une année, ajusté d'un pourcentage et arrondi au franc. */
export function budgetFromActual(accounts: readonly Pick<Account, 'id' | 'accountType'>[], actual: readonly ActualLine[], filter: CenterFilter, percent: number): Map<string, number[]> {
  const result = new Map<string, number[]>();
  for (const account of accounts.filter(row => row.accountType === 'revenue' || row.accountType === 'expense')) {
    const months = Array.from({ length: 12 }, (_, index) => {
      const cents = actual.filter(line => line.accountId === account.id && line.month === index + 1 && matches(filter, line.costCenterId))
        .reduce((sum, line) => sum + signedActual(line, account.accountType), 0);
      return Math.max(0, Math.round(cents * (100 + percent) / 100 / 100) * 100);
    });
    if (months.some(value => value > 0)) result.set(account.id, months);
  }
  return result;
}

/** Charges au-dessus du budget depuis janvier : plus de 10 % et au moins CHF 500. */
export function budgetOverruns(comparison: BudgetComparison): BudgetComparisonRow[] {
  return comparison.rows.filter(row => row.account.accountType === 'expense' && row.budgetToDate > 0
    && row.actualToDate - row.budgetToDate >= 50_000 && row.actualToDate * 10 > row.budgetToDate * 11);
}

/** Centre d'un projet, d'une personne ou d'un compte. */
export function assignedCenter(assignments: readonly CostCenterAssignment[], kind: CostCenterAssignment['kind'], targetId: string): string {
  return assignments.find(row => row.kind === kind && row.targetId === targetId)?.costCenterId ?? '';
}

/** « 12'000 », « 12 000.50 » ou « 12000,5 » → centimes ; vide → 0. */
export function parseBudgetAmount(text: string): number | null {
  const value = text.replace(/[\s'’]/g, '').replace(',', '.');
  if (!value) return 0;
  if (value.length > 15 || !/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}
