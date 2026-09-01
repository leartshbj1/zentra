import type { AccountingPeriod, BalanceSheetReport, IncomeStatementReport, PeriodFilter, TrialBalanceReport } from './types';

export type StatementScope = {
  dateFrom: string;
  dateTo: string;
  previousDateFrom: string;
  previousDateTo: string;
  comparisonLabel: string;
  comparisonSource: 'registered_period' | 'same_dates_previous_year';
  previousHasActivity: boolean;
};

export type ReportCurrency = {
  baseCurrency: string;
  currencies: string[];
  singleCurrency: boolean;
  exchangeRatesApplied: boolean;
};

export type ComparativeBalanceSheet = BalanceSheetReport & {
  exerciseFrom: string;
  scope: StatementScope;
  currency: ReportCurrency;
  previousAssetsCents: number;
  previousLiabilitiesCents: number;
  previousEquityCents: number;
  previousCurrentResultCents: number;
  unallocatedPriorResultsCents: number;
  previousUnallocatedPriorResultsCents: number;
  previousBalanced: boolean;
};

export type ComparativeIncomeStatement = IncomeStatementReport & {
  scope: StatementScope;
  currency: ReportCurrency;
  previousRevenueCents: number;
  previousExpenseCents: number;
  previousProfitCents: number;
};

export type ClosingCheck = {
  id: 'period' | 'currency' | 'trial' | 'balance' | 'carryforward' | 'comparison' | 'lock';
  state: 'ready' | 'warning' | 'blocked';
  label: string;
  detail: string;
};

export function buildClosingChecks(input: {
  filter: PeriodFilter;
  period?: AccountingPeriod;
  trial: TrialBalanceReport | null;
  balance: ComparativeBalanceSheet | null;
  income: ComparativeIncomeStatement | null;
}): ClosingCheck[] {
  const { filter, period, trial, balance, income } = input;
  const explicitExercise = Boolean(filter.dateFrom && filter.dateTo);
  const currencyReady = balance?.currency.baseCurrency === 'CHF'
    && balance.currency.singleCurrency
    && balance.currency.currencies.every((currency) => currency === 'CHF');
  const hasComparison = Boolean(balance?.scope.previousHasActivity || income?.scope.previousHasActivity);

  return [
    {
      id: 'period',
      state: explicitExercise ? 'ready' : 'blocked',
      label: 'Exercice délimité',
      detail: explicitExercise
        ? `${filter.dateFrom} au ${filter.dateTo}`
        : 'Sélectionnez un exercice ou saisissez ses deux dates avant une clôture.',
    },
    {
      id: 'currency',
      state: currencyReady ? 'ready' : 'blocked',
      label: 'Monnaie contrôlée',
      detail: currencyReady
        ? 'Toutes les écritures agrégées sont en CHF; aucun mélange de devises n’est masqué.'
        : 'Le dossier ne peut pas être validé si une devise étrangère est agrégée sans cours traçable.',
    },
    {
      id: 'trial',
      state: trial?.balanced ? 'ready' : 'blocked',
      label: 'Balance équilibrée',
      detail: trial?.balanced
        ? 'Le total des débits correspond au total des crédits.'
        : 'Un écart débit/crédit doit être corrigé avant la clôture.',
    },
    {
      id: 'balance',
      state: balance?.balanced ? 'ready' : 'blocked',
      label: 'Bilan équilibré',
      detail: balance?.balanced
        ? 'Actifs = dettes + fonds propres + résultats antérieurs non affectés + résultat de l’exercice.'
        : 'Le bilan révèle notamment une absence possible d’écriture de report ou de clôture.',
    },
    {
      id: 'carryforward',
      state: balance?.unallocatedPriorResultsCents === 0 ? 'ready' : 'warning',
      label: 'Affectation des résultats antérieurs',
      detail: balance?.unallocatedPriorResultsCents === 0
        ? 'Aucun résultat historique non affecté n’est détecté hors de l’exercice.'
        : 'Un résultat antérieur subsiste dans les comptes de charges/produits. Contrôlez son affectation aux fonds propres; Zentra ne la comptabilise pas automatiquement.',
    },
    {
      id: 'comparison',
      state: hasComparison ? 'ready' : 'warning',
      label: 'Comparatif précédent',
      detail: hasComparison
        ? 'Les valeurs de l’exercice précédent sont affichées en regard de l’exercice courant.'
        : 'Le comparatif est affiché à zéro car aucune écriture précédente n’a été trouvée.',
    },
    {
      id: 'lock',
      state: period?.status === 'closed' ? 'ready' : 'warning',
      label: 'Verrouillage de période',
      detail: period?.status === 'closed'
        ? 'La période est verrouillée contre les écritures ultérieures.'
        : 'Le dossier reste provisoire tant que la période n’est pas clôturée.',
    },
  ];
}

export function closingReadiness(checks: ClosingCheck[]): 'ready' | 'warning' | 'blocked' {
  if (checks.some((check) => check.state === 'blocked')) return 'blocked';
  if (checks.some((check) => check.state === 'warning')) return 'warning';
  return 'ready';
}
