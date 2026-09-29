import { describe, expect, it, vi } from 'vitest';
import { desktopApi } from './bridge';
import { readAccountingReports } from './AccountingScreen';

const period = { dateFrom: '2026-04-01', dateTo: '2026-06-30' };
function fixture() {
  const statements = {
    journal: { entries: [{ id: 'J-42', debitCents: 98765 }], lines: [{ creditCents: 98765 }] },
    trial: { debitCents: 98765, creditCents: 98765, balanced: true },
    ledger: { account: { id: 'bank' }, openingDebitCents: 76543, debitCents: 22222 },
    balance: { assetsCents: 98765, currentResultCents: -1234, scope: { ...period, comparisonLabel: '2025' } },
    income: { revenueCents: 98765, expenseCents: 99999, profitCents: -1234, scope: { ...period, comparisonLabel: '2025' } },
  };
  const methods = {
    getJournal: vi.fn(async () => statements.journal), getTrialBalance: vi.fn(async () => statements.trial),
    getLedger: vi.fn(async () => statements.ledger), getBalanceSheet: vi.fn(async () => statements.balance),
    getIncomeStatement: vi.fn(async () => statements.income),
  };
  return { statements, methods, api: methods as unknown as typeof desktopApi };
}

describe('lectures comptables nécessaires à chaque vue', () => {
  it.each([
    ['overview', ['getIncomeStatement']], ['journal', ['getJournal']], ['ledger', ['getLedger']],
    ['trial', ['getTrialBalance']], ['balance', ['getBalanceSheet', 'getIncomeStatement']],
    ['income', ['getBalanceSheet', 'getIncomeStatement']],
    ['closing', ['getTrialBalance', 'getBalanceSheet', 'getIncomeStatement']],
    ['accounts', []], ['periods', []], ['assets', []], ['vat', []],
  ] as const)('%s ne charge que ses états et conserve leurs valeurs', async (tab, expected) => {
    const { api, methods, statements } = fixture();
    const result = await readAccountingReports({ tab, filter: period, accountId: 'bank' }, api);
    expect(Object.entries(methods).filter(([, method]) => method.mock.calls.length).map(([name]) => name)).toEqual(expected);
    for (const name of expected) expect(methods[name]).toHaveBeenCalledExactlyOnceWith(...(name === 'getLedger' ? ['bank', period] : [period]));
    for (const [key, value] of Object.entries(result.reports)) if (value !== null) expect(value).toBe(statements[key as keyof typeof statements]);
    expect(result.failures).toEqual([]);
  });

  it('préserve les états disponibles si un contrôle de clôture échoue, puis permet une nouvelle lecture', async () => {
    const { api, methods, statements } = fixture();
    methods.getBalanceSheet.mockRejectedValueOnce(new Error('lecture interrompue'));
    const selection = { tab: 'closing' as const, filter: period, accountId: 'bank' };
    const failed = await readAccountingReports(selection, api);
    expect(failed.reports).toMatchObject({ balance: null, income: statements.income, trial: statements.trial });
    expect(failed.failures.map(failure => failure.label)).toEqual(['bilan']);
    const retried = await readAccountingReports(selection, api);
    expect(retried.failures).toEqual([]);
    expect(retried.reports.balance).toBe(statements.balance);
    expect(methods.getBalanceSheet).toHaveBeenCalledTimes(2);
  });

  it('ne lit pas un grand livre sans compte et transmet les filtres ouverts sans inventer de dates', async () => {
    const { api, methods, statements } = fixture();
    expect((await readAccountingReports({ tab: 'ledger', filter: {}, accountId: '' }, api)).reports.ledger).toBeNull();
    expect(methods.getLedger).not.toHaveBeenCalled();
    const result = await readAccountingReports({ tab: 'income', filter: { dateTo: '2026-06-30' }, accountId: '' }, api);
    expect(methods.getIncomeStatement).toHaveBeenCalledExactlyOnceWith({ dateTo: '2026-06-30' });
    expect(result.reports.income?.scope).toBe(statements.income.scope);
  });
});
