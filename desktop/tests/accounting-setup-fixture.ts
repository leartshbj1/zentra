import { desktopApi } from '../src/bridge';
import type { Account, AccountingConfigurationResult, AccountingContinuity, AccountingSettings, Workspace } from '../src/types';

// Synthetic data for the browser harness. Native posting is checked separately.
export function installAccountingSetupFixture(workspace: Workspace) {
  const params = new URLSearchParams(location.search);
  const starter = params.get('accountingSetup') === 'starter';
  const payroll = params.has('setupPayroll'), deferredVat = params.has('setupReceived');
  workspace.settings.payroll.enabled = payroll;
  const specs = [
    ['ar', '1100', 'Créances clients', 'asset'], ['revenue', '3200', 'Ventes de prestations', 'revenue'],
    ['bank', '1020', 'Banque de l’entreprise', 'asset'], ['expense', '6000', 'Autres charges', 'expense'],
    ['supplier', '2000', 'Fournisseurs', 'liability'], ['vatDue', '2200', 'TVA due', 'liability'],
    ['vatInput', '1170', 'TVA préalable', 'asset'], ['vatDeferred', '2201', 'TVA en attente', 'liability'],
    ['wagesCost', '5000', 'Salaires', 'expense'], ['wagesDue', '2001', 'Salaires dus', 'liability'],
    ['socialCost', '5700', 'Charges sociales', 'expense'], ['socialDue', '2270', 'Assurances sociales', 'liability'],
  ];
  const allAccounts: Account[] = specs.map(([id, code, name, type]) => ({ id, code, name, accountType: type as Account['accountType'], normalBalance: type === 'asset' || type === 'expense' ? 'debit' : 'credit', reportSection: type === 'asset' ? 'current_assets' : type === 'liability' ? 'short_term_liabilities' : type === 'expense' ? 'other_operating_expense' : 'net_revenue', active: true }));
  const complete: AccountingSettings = { enabled: true, arAccountId: 'ar', revenueAccountId: 'revenue', bankAccountId: 'bank', expenseAccountId: 'expense', supplierPayableAccountId: 'supplier', vatPayableAccountId: 'vatDue', vatReceivableAccountId: 'vatInput', vatDeferredPayableAccountId: deferredVat ? 'vatDeferred' : '', wagesExpenseAccountId: 'wagesCost', wagesPayableAccountId: 'wagesDue', socialExpenseAccountId: 'socialCost', socialPayableAccountId: 'socialDue' };
  const state = {
    settings: starter ? Object.fromEntries(Object.keys(complete).map(key => [key, key === 'enabled' ? false : ''])) as AccountingSettings : { ...complete, arAccountId: 'expense', expenseAccountId: '' },
    accounts: starter ? [] : [...allAccounts, { ...allAccounts[0], id: 'inactive', name: 'Ancien compte inactif', active: false }],
    saved: false, writes: [] as { mode: string; settings?: AccountingSettings }[], reads: 0,
  };
  const previous = sessionStorage.getItem('qa-accounting-setup');
  if (previous) Object.assign(state, JSON.parse(previous));
  const persist = () => sessionStorage.setItem('qa-accounting-setup', JSON.stringify(state));
  const continuity = (): AccountingContinuity => ({
    mappingRequirements: { payroll, deferredVat }, enabled: state.settings.enabled, mappingReady: state.saved,
    starterAvailable: starter && !state.saved, journalEntryCount: state.saved ? 2 : 0,
    missingInvoices: state.saved ? 0 : 2, missingPayments: 0, missingExpenses: 0, missingSupplierInvoices: 0, missingSupplierPayments: 0, missingPayslips: 0, missingPayslipPayments: 0, undatedPayslipPayments: 0, payslipPaymentLinksMissing: 0,
    totalMissing: state.saved ? 0 : 2, closedHistoryRequiresOpening: 1, skippedCancelledInvoices: 0, cancelledInvoicePayments: 0, reversedSources: 0, cancelledActivePostings: 0, semanticPostingMismatches: 0, totalAnomalies: state.saved ? 1 : 3,
  });
  function read() { state.reads++; persist(); if (sessionStorage.getItem('qa-setup-block-reads')) throw new Error('Lecture de recette interrompue. Les réglages sont conservés.'); }
  desktopApi.listAccounts = async () => { read(); return structuredClone(state.accounts); };
  desktopApi.getAccountingSettings = async () => { read(); return structuredClone(state.settings); };
  desktopApi.getAccountingContinuity = async () => { read(); return continuity(); };
  desktopApi.loadWorkspace = async () => { read(); workspace.accounts = structuredClone(state.accounts); workspace.accountingSettings = structuredClone(state.settings); return structuredClone(workspace); };
  desktopApi.saveSettings = async settings => { workspace.settings = structuredClone(settings); return structuredClone(workspace); };
  const originalJournal = desktopApi.getJournal;
  desktopApi.getJournal = async (...args) => { if (sessionStorage.getItem('qa-setup-block-reports')) throw new Error('Journal de recette temporairement indisponible.'); return originalJournal(...args); };
  desktopApi.getLedger = async accountId => ({ account: structuredClone(state.accounts.find(row => row.id === accountId)!), lines: [], currency: { baseCurrency: 'CHF', currencies: ['CHF'], singleCurrency: true, exchangeRatesApplied: false }, openingDebitCents: 0, openingCreditCents: 0, openingDebitBalanceCents: 0, openingCreditBalanceCents: 0, openingNetDebitCents: 0, debitCents: 0, creditCents: 0, movementNetDebitCents: 0, netDebitCents: 0, closingDebitBalanceCents: 0, closingCreditBalanceCents: 0, closingNetDebitCents: 0 });
  desktopApi.upsertAccount = async input => { const account = { ...input, id: input.id || 'new-account' }; state.accounts = [...state.accounts.filter(row => row.id !== account.id), account]; persist(); return account; };
  async function commit(mode: 'starter' | 'mapping', settings?: AccountingSettings): Promise<AccountingConfigurationResult> {
    state.writes.push({ mode, settings: settings && structuredClone(settings) }); persist();
    if (sessionStorage.getItem('qa-setup-hold-write')) await new Promise<void>(resolve => Object.assign(window, { __qaReleaseSetup: resolve }));
    if (sessionStorage.getItem('qa-setup-refuse-write')) throw new Error('Ce compte a changé depuis votre ouverture. Vérifiez les comptes choisis puis réessayez.');
    if (mode === 'starter' && state.saved) throw new Error('La base existe déjà.');
    state.settings = structuredClone(settings || { ...complete, vatDeferredPayableAccountId: 'vatDeferred' });
    if (mode === 'starter') state.accounts = structuredClone(allAccounts);
    state.saved = true; persist();
    if (sessionStorage.getItem('qa-setup-recover')) sessionStorage.setItem('qa-setup-block-reads', '1');
    return { settings: structuredClone(state.settings), synchronization: { createdTotal: 2, createdInvoices: 2, createdPayments: 0, createdExpenses: 0, createdPayslips: 0, createdPayslipPayments: 0, skippedClosedHistory: 1, requiresOpeningBalanceReview: true, remaining: continuity() } };
  }
  desktopApi.configureAccounting = settings => commit('mapping', settings);
  desktopApi.installSwissAccountingStarter = () => commit('starter');
  persist();
}
