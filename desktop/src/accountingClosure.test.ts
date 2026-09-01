import { describe, expect, it } from 'vitest';
import { buildClosingChecks, closingReadiness, type ComparativeBalanceSheet, type ComparativeIncomeStatement } from './accountingClosure';

const scope = {
  dateFrom: '2026-01-01', dateTo: '2026-12-31', previousDateFrom: '2025-01-01', previousDateTo: '2025-12-31',
  comparisonLabel: 'Exercice 2025', comparisonSource: 'same_dates_previous_year' as const, previousHasActivity: true,
};
const currency = { baseCurrency: 'CHF', currencies: ['CHF'], singleCurrency: true, exchangeRatesApplied: false };

describe('dossier de clôture', () => {
  it('est prêt uniquement si les contrôles bloquants sont satisfaits', () => {
    const balance = { balanced: true, scope, currency, unallocatedPriorResultsCents: 0 } as ComparativeBalanceSheet;
    const income = { scope, currency } as ComparativeIncomeStatement;
    const checks = buildClosingChecks({
      filter: { dateFrom: '2026-01-01', dateTo: '2026-12-31' },
      period: { id: 'p', name: '2026', dateFrom: '2026-01-01', dateTo: '2026-12-31', status: 'closed', closedAt: '', createdAt: '', updatedAt: '' },
      trial: {
        rows: [],
        currency,
        openingDebitBalanceCents: 0,
        openingCreditBalanceCents: 0,
        debitCents: 0,
        creditCents: 0,
        closingDebitBalanceCents: 0,
        closingCreditBalanceCents: 0,
        balanced: true,
      }, balance, income,
    });
    expect(closingReadiness(checks)).toBe('ready');
  });

  it('bloque si les dates, la devise ou l’équilibre manquent', () => {
    const balance = { balanced: false, scope, currency: { ...currency, currencies: ['CHF', 'EUR'], singleCurrency: false } } as ComparativeBalanceSheet;
    const checks = buildClosingChecks({ filter: {}, trial: null, balance, income: null });
    expect(closingReadiness(checks)).toBe('blocked');
    expect(checks.filter((check) => check.state === 'blocked').map((check) => check.id)).toEqual(expect.arrayContaining(['period', 'currency', 'trial', 'balance']));
  });
});
