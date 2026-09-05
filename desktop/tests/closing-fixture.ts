// Browser-only closing scenarios. Native archive and accounting tests remain independent.
import { desktopApi } from '../src/bridge';
import type { AccountingPeriod, FiduciaryClosingReview, StatementRow } from '../src/types';

export function installClosingFixture() {
  const periods: AccountingPeriod[] = [2025, 2026].map((year) => ({ id: `year-${year}`, name: `Exercice ${year}`, dateFrom: `${year}-01-01`, dateTo: `${year}-12-31`, status: 'open', closedAt: '', createdAt: '', updatedAt: '' }));
  const reviews = new Map<string, FiduciaryClosingReview>();
  const consumed = new Set<string>();
  const attempts = (name: string, input: unknown) => {
    const key = `qa-closing-${name}`;
    const rows = JSON.parse(sessionStorage.getItem(key) || '[]'); rows.push(input);
    sessionStorage.setItem(key, JSON.stringify(rows));
  };
  async function hold(name: string) {
    if (sessionStorage.getItem(`qa-closing-hold-${name}`) !== '1') return;
    sessionStorage.setItem(`qa-closing-waiting-${name}`, '1');
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (sessionStorage.getItem(`qa-closing-hold-${name}`) === '1') return;
        clearInterval(timer); sessionStorage.removeItem(`qa-closing-waiting-${name}`); resolve();
      }, 30);
    });
  }
  const getContinuity = desktopApi.getAccountingContinuity;
  desktopApi.getAccountingContinuity = async () => ({ ...await getContinuity(), enabled: true, mappingReady: true, starterAvailable: false, journalEntryCount: 14 });
  desktopApi.listAccountingPeriods = async () => structuredClone(periods);
  const originalBalance = desktopApi.getBalanceSheet;
  const originalIncome = desktopApi.getIncomeStatement;
  const scope = (dateFrom = '2026-01-01', dateTo = '2026-12-31') => ({ dateFrom, dateTo, previousDateFrom: `${Number(dateFrom.slice(0, 4)) - 1}-01-01`, previousDateTo: `${Number(dateTo.slice(0, 4)) - 1}-12-31`, comparisonLabel: 'Exercice précédent', comparisonSource: 'registered_period' as const, previousHasActivity: true });
  function row(id: string, code: string, name: string, accountType: StatementRow['accountType'], reportSection: StatementRow['reportSection'], amountCents: number, previousAmountCents: number): StatementRow {
    const debit = accountType === 'asset' || accountType === 'expense';
    return { id, code, name, accountType, reportSection, amountCents, previousAmountCents, debitCents: debit ? amountCents : 0, creditCents: debit ? 0 : amountCents, previousDebitCents: debit ? previousAmountCents : 0, previousCreditCents: debit ? 0 : previousAmountCents };
  }
  desktopApi.getBalanceSheet = async (filter = {}) => ({ ...await originalBalance(filter), asOf: filter.dateTo || '2026-12-31', exerciseFrom: filter.dateFrom || '2026-01-01', scope: scope(filter.dateFrom, filter.dateTo), assetsCents: 12456789, liabilitiesCents: 2456789, equityCents: 2000000, currentResultCents: 8000000, previousAssetsCents: 9500000, previousLiabilitiesCents: 1500000, previousEquityCents: 2000000, previousCurrentResultCents: 6000000, sections: { current_assets: 12456789, short_term_liabilities: 2456789, equity: 2000000 }, previousSections: { current_assets: 9500000, short_term_liabilities: 1500000, equity: 2000000 }, rows: [row('bank', '1020', 'Banque', 'asset', 'current_assets', 12456789, 9500000), row('suppliers', '2000', 'Dettes fournisseurs', 'liability', 'short_term_liabilities', 2456789, 1500000), row('capital', '2800', 'Capital', 'equity', 'equity', 2000000, 2000000)] });
  desktopApi.getIncomeStatement = async (filter = {}) => ({ ...await originalIncome(filter), scope: scope(filter.dateFrom, filter.dateTo), revenueCents: 15000000, expenseCents: 7000000, profitCents: 8000000, previousRevenueCents: 12000000, previousExpenseCents: 6000000, previousProfitCents: 6000000, sections: { net_revenue: 15000000, cost_of_goods: 7000000 }, previousSections: { net_revenue: 12000000, cost_of_goods: 6000000 }, rows: [row('sales', '3200', 'Prestations', 'revenue', 'net_revenue', 15000000, 12000000), row('purchases', '4000', 'Marchandises', 'expense', 'cost_of_goods', 7000000, 6000000)] });
  const readBalance = desktopApi.getBalanceSheet;
  desktopApi.getBalanceSheet = async (filter) => {
    if (sessionStorage.getItem('qa-closing-fail-refresh') === '1') throw new Error('Lecture du bilan momentanément indisponible.');
    return readBalance(filter);
  };
  desktopApi.prepareFiduciaryPreClosing = async (filter) => {
    attempts('prepare', filter);
    const period = periods.find((item) => item.dateFrom === filter.dateFrom && item.dateTo === filter.dateTo);
    if (!period) throw new Error('Sélectionnez un exercice enregistré.');
    const blocked = sessionStorage.getItem('qa-closing-blocked') === '1';
    const review: FiduciaryClosingReview = {
      schema: 'elyko.fiduciary-pre-closing.v1', reviewId: crypto.randomUUID(), preparedAt: new Date().toISOString(), period: structuredClone(period), sourceSha256: 'a'.repeat(64), packageStatusIfExported: period.status === 'closed' ? 'FINAL' : 'DRAFT',
      checks: { readyForFinal: !blocked, journalBalanced: true, balanceSheetBalanced: true, auditChainValid: true, attachmentsTotal: 28, attachmentsVerified: blocked ? 27 : 28, attachmentIssues: blocked ? [{ attachmentId: 'missing', originalName: 'Facture-fournisseur-marchandises-pour-le-projet-de-renovation-du-batiment-principal.pdf', issue: 'missing_or_unreadable_file' }] : [], continuity: await desktopApi.getAccountingContinuity() },
      summary: { journalEntries: 14, journalLines: 40, accountsWithActivity: 5, debitCents: 50000000, creditCents: 50000000, profitCents: 8000000, assetsCents: 12456789, liabilitiesCents: 2456789, equityCents: 2000000 }, disclaimer: 'Recette locale simulée.',
    };
    reviews.set(review.reviewId, review);
    await hold('prepare');
    return structuredClone(review);
  };
  desktopApi.finalizeAccountingPeriodWithReview = async (periodId, reviewId) => {
    attempts('finalize', { periodId, reviewId });
    const review = reviews.get(reviewId)!;
    if (sessionStorage.getItem('qa-closing-stale') === '1') throw new Error('Les données ont changé depuis le contrôle. Préparez un nouveau contrôle.');
    if (!review.checks.readyForFinal || consumed.has(reviewId) || review.period.id !== periodId) throw new Error('Clôture refusée.');
    const period = periods.find((item) => item.id === periodId)!;
    period.status = 'closed'; period.closedAt = new Date().toISOString();
    await hold('finalize');
    return { schema: 'elyko.fiduciary-period-finalization.v1', reviewId, sourceSha256: review.sourceSha256, period: structuredClone(period) };
  };
  desktopApi.exportFiduciaryClosingZip = async (reviewId) => {
    attempts('export', { reviewId });
    const review = reviews.get(reviewId)!;
    if (consumed.has(reviewId)) throw new Error('Ce contrôle a déjà été exporté.');
    consumed.add(reviewId);
    const period = periods.find((item) => item.id === review.period.id)!;
    const fileName = `Dossier-comptable-${period.name.replaceAll(' ', '-')}-${period.status === 'closed' ? 'FINAL' : 'DRAFT'}.zip`;
    await hold('export');
    return { schema: 'elyko.fiduciary-package-export.v1', exportId: crypto.randomUUID(), reviewId, createdAt: new Date().toISOString(), period: structuredClone(period), packageStatus: period.status === 'closed' ? 'FINAL' : 'DRAFT', sourceSha256: review.sourceSha256, manifestSha256: 'b'.repeat(64), fileName, path: `C:\\Users\\Atelier du Léman\\Documents\\Zentra\\exports\\${fileName}`, fileCount: 47, disclaimer: '', deliveryWarning: sessionStorage.getItem('qa-closing-share-failure') === '1' ? 'Le dossier a été créé, mais le partage n’a pas abouti. Utilisez « Partager le dossier » pour réessayer.' : undefined };
  };
  desktopApi.shareExistingExport = async (path) => {
    attempts('share', { path });
    if (sessionStorage.getItem('qa-closing-share-failure') === '1') throw new Error('Le partage est momentanément indisponible. Le dossier existant est conservé.');
  };
}
