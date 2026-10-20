import { describe, expect, it } from 'vitest';
import { parseBudgetAmount, assignedCenter, budgetFromActual, budgetOverruns, compareBudget, spreadYearly, type ActualLine, type BudgetLine } from './budget';

const accounts = [
  { id: 'rev', code: '3000', name: 'Prestations', accountType: 'revenue' as const },
  { id: 'rent', code: '6000', name: 'Loyer', accountType: 'expense' as const },
  { id: 'mat', code: '4000', name: 'Matériel', accountType: 'expense' as const },
  { id: 'bank', code: '1020', name: 'Banque', accountType: 'asset' as const },
];
const budget = (accountId: string, costCenterId: string, amountCents: number, months = 12): BudgetLine[] =>
  Array.from({ length: months }, (_, index) => ({ month: index + 1, accountId, costCenterId, amountCents }));
const actual = (month: number, accountId: string, costCenterId: string, debitCents: number, creditCents = 0): ActualLine => ({ month, accountId, costCenterId, debitCents, creditCents });

describe('budget', () => {
  it('spreads a yearly amount without losing a cent', () => {
    expect(spreadYearly(1_200_000)).toEqual(Array(12).fill(100_000));
    const odd = spreadYearly(1_000_005);
    expect(odd.reduce((a, b) => a + b, 0)).toBe(1_000_005);
    expect(odd.slice(0, 6)).toEqual(Array(6).fill(83_334));
    expect(odd[11]).toBe(83_333);
  });

  it('compares the year to date by account and centre', () => {
    const report = {
      budget: [...budget('rev', '', 1_000_000), ...budget('rent', 'admin', 200_000), ...budget('mat', 'atelier', 150_000)],
      actual: [actual(1, 'rev', '', 0, 900_000), actual(2, 'rev', 'atelier', 50_000, 1_300_000), actual(1, 'rent', 'admin', 200_000), actual(2, 'rent', 'admin', 200_000),
        actual(2, 'mat', 'atelier', 420_000), actual(3, 'mat', 'atelier', 999_999), actual(1, 'bank', '', 1, 0)],
    };
    const all = compareBudget(accounts, report, 'all', 2);
    expect(all.rows.map(row => row.account.code)).toEqual(['3000', '4000', '6000']);
    const revenue = all.rows[0];
    expect(revenue).toMatchObject({ budgetYear: 12_000_000, budgetToDate: 2_000_000, actualToDate: 2_150_000, gap: 150_000 });
    const material = all.rows[1];
    expect(material).toMatchObject({ budgetToDate: 300_000, actualToDate: 420_000, gap: -120_000 });
    expect(all.result).toEqual({ budgetToDate: 2_000_000 - 700_000, actualToDate: 2_150_000 - 820_000 });
    const workshop = compareBudget(accounts, report, 'atelier', 2);
    expect(workshop.rows.map(row => [row.account.code, row.actualToDate])).toEqual([['3000', 1_250_000], ['4000', 420_000]]);
    expect(compareBudget(accounts, report, '', 2).rows.map(row => row.account.code)).toEqual(['3000']);
  });

  it('flags expenses more than 10 % and CHF 500 over budget', () => {
    const report = { budget: [...budget('mat', '', 150_000), ...budget('rent', '', 200_000)], actual: [actual(1, 'mat', '', 360_000), actual(1, 'rent', '', 219_000)] };
    expect(budgetOverruns(compareBudget(accounts, report, 'all', 2)).map(row => row.account.id)).toEqual(['mat']);
  });

  it('prepares next year from this year, rounded to the franc', () => {
    const proposal = budgetFromActual(accounts, [actual(1, 'rent', '', 200_000), actual(2, 'rev', '', 0, 1_000_050), actual(3, 'mat', 'atelier', 10_000)], 'all', 3);
    expect(proposal.get('rent')?.[0]).toBe(206_000);
    expect(proposal.get('rev')?.[1]).toBe(1_030_100);
    expect(proposal.has('bank')).toBe(false);
    expect(budgetFromActual(accounts, [actual(3, 'mat', 'atelier', 10_000)], 'admin', 0).size).toBe(0);
  });

  it('reads Swiss amounts', () => {
    expect(parseBudgetAmount("12'000")).toBe(1_200_000);
    expect(parseBudgetAmount('12 000,5')).toBe(1_200_050);
    expect(parseBudgetAmount('')).toBe(0);
    expect(parseBudgetAmount('-5')).toBeNull();
    expect(parseBudgetAmount('1.234')).toBeNull();
  });

  it('finds the centre of a project', () => {
    expect(assignedCenter([{ kind: 'project', targetId: 'p1', costCenterId: 'c1' }], 'project', 'p1')).toBe('c1');
    expect(assignedCenter([], 'employee', 'e1')).toBe('');
  });
});
