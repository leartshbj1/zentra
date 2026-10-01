import { AccountingPeriodsPanel } from './AccountingPeriodsPanel';
import { FixedAssetsPanel } from './FixedAssetsPanel';
import type { PeriodDraft } from './accountingPeriods';
import { AccountingSetupPanel } from './AccountingSetupPanel';
import { AccountingSetupDialog } from './AccountingSetupDialog';
import { accountingMappingFields, accountingMappingIssues } from './accountingSetup';
import type { AccountingConfigurationResult } from './types';
import { PdfExportReceipt } from './PdfExportReceipt';
import type { PdfExportReceipt as Receipt } from './pdfExportDelivery';
import { useEffect, useId, useRef, useState } from 'react';
import { Archive, BookOpen, CheckCircle2, ChevronDown, FileCheck2, Landmark, ListChecks, LockKeyhole, Plus, ReceiptText, RefreshCw, RotateCcw, Scale, ShieldCheck, SlidersHorizontal, X } from 'lucide-react';
import { desktopApi } from './bridge';
import { SectionTabs } from './SectionTabs';
import { FinanceOverview } from './FinanceOverview';
import { t, useAppLanguage } from './language';
import { accountingExplanations, financePeriod } from './financeClarity';
import {
  accountingEntryFocusFilter,
  type AccountingEntryFocus,
} from './PaymentAccountingProofs';
import type { Account, AccountingContinuity, AccountingPeriod, AccountingSettings, BalanceSheetReport, IncomeStatementReport, JournalEntry, JournalReport, LedgerReport, PeriodFilter, StatementRow, TrialBalanceReport, Workspace } from './types';
import { createId, errorMessage, formatDate, formatMoney, todayIso } from './utils';
import { Button, EmptyState, ErrorPanel, Field, SectionHeading, StatusBadge, submitForm } from './ui';
import { projectTerminology } from './terminology';
import { ClosingFolder } from './ClosingFolder';
import { CustomerCreditAccountingIssues } from './CustomerCreditAccountingIssues';
import './AccountingScreen.css';
import { VatCenter } from './VatCenter';
import { JournalReversalDialog } from './JournalReversalDialog';
import {
  clearManualJournalAttempt,
  loadManualJournalAttempt,
  prepareManualJournalAttempt,
  type ManualJournalAttempt,
} from './accountingManualJournal';

type Tab = 'overview' | 'journal' | 'ledger' | 'trial' | 'balance' | 'income' | 'vat' | 'closing' | 'accounts' | 'periods' | 'assets';
type ReportSelection = { tab: Tab; filter: PeriodFilter; accountId: string };
type Reports = { journal: JournalReport | null; trial: TrialBalanceReport | null; ledger: LedgerReport | null; balance: BalanceSheetReport | null; income: IncomeStatementReport | null };
const emptyReports = (): Reports => ({ journal: null, trial: null, ledger: null, balance: null, income: null });

// No cross-tab cache: a later visit always reads current local accounting data.
// Both annual statements remain required by the shared PDF export control.
export async function readAccountingReports({ tab, filter, accountId }: ReportSelection, api = desktopApi) {
  const reports = emptyReports();
  const jobs: Array<{ label: string; read: () => Promise<void> }> = [];
  if (tab === 'journal') jobs.push({ label: 'journal', read: async () => { reports.journal = await api.getJournal(filter); } });
  if (tab === 'trial' || tab === 'closing') jobs.push({ label: 'balance des comptes', read: async () => { reports.trial = await api.getTrialBalance(filter); } });
  if (tab === 'ledger' && accountId) jobs.push({ label: 'grand livre', read: async () => { reports.ledger = await api.getLedger(accountId, filter); } });
  if (tab === 'balance' || tab === 'income' || tab === 'closing') jobs.push({ label: 'bilan', read: async () => { reports.balance = await api.getBalanceSheet(filter); } });
  if (tab === 'overview' || tab === 'balance' || tab === 'income' || tab === 'closing') jobs.push({ label: 'compte de résultat', read: async () => { reports.income = await api.getIncomeStatement(filter); } });
  const results = await Promise.allSettled(jobs.map(job => job.read()));
  const failures = results.flatMap((result, index) => result.status === 'rejected' ? [{ label: jobs[index].label, reason: result.reason as unknown }] : []);
  return { reports, failures };
}
type JournalDraftLine = { id: string; accountId: string; debitCents: number; creditCents: number; memo: string; projectId: string; clientId: string; employeeId: string };
type ActiveEntryFocus = {
  target: AccountingEntryFocus;
  outsidePaymentDate: boolean;
};

const emptyAccountingSettings: AccountingSettings = {
  enabled: false,
  arAccountId: '',
  revenueAccountId: '',
  vatPayableAccountId: '',
  vatDeferredPayableAccountId: '',
  bankAccountId: '',
  expenseAccountId: '',
  vatReceivableAccountId: '',
  wagesExpenseAccountId: '',
  wagesPayableAccountId: '',
  socialExpenseAccountId: '',
  socialPayableAccountId: '',
  supplierPayableAccountId: '',
};

const emptyContinuity: AccountingContinuity = {
  enabled: false,
  mappingReady: false,
  starterAvailable: true,
  journalEntryCount: 0,
  missingInvoices: 0,
  missingPayments: 0,
  missingExpenses: 0,
  missingSupplierInvoices: 0,
  missingSupplierPayments: 0,
  missingPayslips: 0,
  missingPayslipPayments: 0,
  undatedPayslipPayments: 0,
  payslipPaymentLinksMissing: 0,
  totalMissing: 0,
  closedHistoryRequiresOpening: 0,
  skippedCancelledInvoices: 0,
  cancelledInvoicePayments: 0,
  reversedSources: 0,
  cancelledActivePostings: 0,
  semanticPostingMismatches: 0,
  totalAnomalies: 0,
};

const reportSections: Array<[Account['reportSection'], string]> = [
  ['current_assets', 'Actifs circulants'], ['fixed_assets', 'Actifs immobilisés'], ['short_term_liabilities', 'Dettes à court terme'], ['long_term_liabilities', 'Dettes à long terme'], ['equity', 'Fonds propres'], ['net_revenue', 'Chiffre d’affaires net'], ['cost_of_goods', 'Coût des marchandises / prestations'], ['personnel_expense', 'Charges de personnel'], ['other_operating_expense', 'Autres charges d’exploitation'], ['depreciation', 'Amortissements'], ['financial_result', 'Résultat financier'], ['non_operating_result', 'Résultat hors exploitation'], ['exceptional_result', 'Résultat exceptionnel'], ['taxes', 'Impôts'],
];

const newJournalLine = (): JournalDraftLine => ({ id: createId(), accountId: '', debitCents: 0, creditCents: 0, memo: '', projectId: '', clientId: '', employeeId: '' });

export function AccountingScreen({ workspace, onWorkspaceChange, focusEntry, onFocusHandled, readOnly=false, initialTab, onInitialTabHandled }: { workspace: Workspace; onWorkspaceChange: (workspace: Workspace) => void; focusEntry: AccountingEntryFocus | null; onFocusHandled: () => void; readOnly?:boolean; initialTab?: 'accounts' | 'periods'; onInitialTabHandled?: () => void }) {
  useAppLanguage();
  const payrollFallback = Boolean(workspace.settings?.payroll.enabled) || (workspace.payslips ?? []).some(payslip => ['posted', 'paid'].includes(payslip.status));
  const [tab, setCurrentTab] = useState<Tab>(initialTab || 'overview');
  useEffect(() => { if (initialTab) { setTab(initialTab); onInitialTabHandled?.(); } }, [initialTab, onInitialTabHandled]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [settings, setSettings] = useState<AccountingSettings>(emptyAccountingSettings);
  const [continuity, setContinuity] = useState<AccountingContinuity>(emptyContinuity);
  const [baseLoaded, setBaseLoaded] = useState(false);
  const [savedSettings, setSavedSettings] = useState<AccountingSettings>(emptyAccountingSettings);
  const [setupReview, setSetupReview] = useState<{ mode: 'starter' | 'mapping'; settings: AccountingSettings } | null>(null);
  const [manualPlanOpen, setManualPlanOpen] = useState(false);
  const [returnToClosing, setReturnToClosing] = useState(false);
  const mappingFields = accountingMappingFields(continuity.mappingRequirements, payrollFallback);
  const mappingCountLabel = String(mappingFields.filter(field => field.required).length);
  const [periods, setPeriods] = useState<AccountingPeriod[]>([]);
  const [filter, setFilter] = useState<PeriodFilter>(() => financePeriod('year', todayIso()));
  const [periodId, setPeriodId] = useState('');
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const filtersId = useId();
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [journal, setJournal] = useState<JournalReport | null>(null);
  const [ledger, setLedger] = useState<LedgerReport | null>(null);
  const [trial, setTrial] = useState<TrialBalanceReport | null>(null);
  const [balance, setBalance] = useState<BalanceSheetReport | null>(null);
  const [income, setIncome] = useState<IncomeStatementReport | null>(null);
  const [accountDraft, setAccountDraft] = useState<(Partial<Account> & Pick<Account, 'code' | 'name'>) | null>(null);
  const [entryOpen, setEntryOpen] = useState(false);
  const [reversalRefreshRequired,setReversalRefreshRequired]=useState(false);
  const [vatJournalFocus,setVatJournalFocus]=useState('');
  const [reversalTarget, setReversalTarget] = useState<JournalEntry | null>(null);
  const [entryLines, setEntryLines] = useState<JournalDraftLine[]>([newJournalLine(), newJournalLine()]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [exportedPdf, setExportedPdf] = useState<Receipt | null>(null);
  const [activeEntryFocus, setActiveEntryFocus] = useState<ActiveEntryFocus | null>(null);
  const reportRequest = useRef(0);
  const actionRequest = useRef(0);
  const blockingActions = useRef(0);
  const pdfSharePending = useRef(false);
  const latestActionPending = useRef(false);
  const baseReady = useRef(false);
  const selection = useRef<ReportSelection>({ tab, filter, accountId: selectedAccountId });
  const manualJournalAttempt = useRef<ManualJournalAttempt | null>(loadManualJournalAttempt());

  const activeAccounts = accounts.filter((account) => account.active);
  const debit = entryLines.reduce((sum, line) => sum + line.debitCents, 0);
  const credit = entryLines.reduce((sum, line) => sum + line.creditCents, 0);
  const selectedPeriod = periods.find((period) => period.id === periodId);
  const reportState = selectedPeriod?.status === 'closed' ? 'Clôturé' : 'Provisoire';
  const hasPeriodFilter = tab !== 'accounts' && tab !== 'periods' && tab !== 'assets';
  // Statements resolve their own exercise when a journal filter has open ends.
  // Always describe the dates actually returned with the displayed amounts.
  const statementScope = tab === 'balance' ? balance?.scope : (tab === 'overview' || tab === 'income') ? income?.scope : undefined;
  const displayFilter = !busy && statementScope ? statementScope : filter;
  const periodLabel = selectedPeriod?.name || (
    displayFilter.dateFrom && displayFilter.dateTo ? `${formatDate(displayFilter.dateFrom)} – ${formatDate(displayFilter.dateTo)}`
      : displayFilter.dateFrom ? t('Depuis le {date}', { date: formatDate(displayFilter.dateFrom) })
        : displayFilter.dateTo ? t('Jusqu’au {date}', { date: formatDate(displayFilter.dateTo) }) : t('Toutes les dates')
  );
  const focusedEntryAvailable = Boolean(
    activeEntryFocus &&
      journal?.entries.some(
        (entry) => entry.id === activeEntryFocus.target.entryId,
      ),
  );

  async function run(action: () => Promise<void>, success?: string, rethrow = false, reading = false) {
    const request = ++actionRequest.current;
    latestActionPending.current = true;
    if (!reading) blockingActions.current++;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      if (request === actionRequest.current && success) setNotice(success);
    } catch (reason) {
      if ((!reading || request === actionRequest.current) && !rethrow) setError(errorMessage(reason, 'La commande comptable locale a échoué.'));
      if (rethrow) throw reason;
    } finally {
      if (!reading) blockingActions.current--;
      if (request === actionRequest.current) latestActionPending.current = false;
      setBusy(latestActionPending.current || blockingActions.current > 0);
    }
  }

  function runRead(action: () => Promise<void>, success?: string) { return run(action, success, false, true); }

  function setPdfShareBusy(pending: boolean) {
    if (pdfSharePending.current === pending) return;
    pdfSharePending.current = pending;
    blockingActions.current += pending ? 1 : -1;
    setBusy(latestActionPending.current || blockingActions.current > 0);
  }

  function applyReports(reports: Reports) {
    setJournal(reports.journal); setTrial(reports.trial); setLedger(reports.ledger);
    setBalance(reports.balance); setIncome(reports.income);
  }

  function selectReports(patch: Partial<ReportSelection>) {
    selection.current = { ...selection.current, ...patch };
    // Invalidate immediately, including a pending journal lookup or base read.
    reportRequest.current++;
    applyReports(emptyReports());
    if (patch.tab !== undefined) setCurrentTab(patch.tab);
    if (patch.filter !== undefined) setFilter(patch.filter);
    if (patch.accountId !== undefined) setSelectedAccountId(patch.accountId);
  }

  function setTab(nextTab: Tab) {
    if (nextTab === selection.current.tab) return;
    selectReports({ tab: nextTab });
    if (activeEntryFocus) { setActiveEntryFocus(null); onFocusHandled(); }
    if (baseReady.current) void runRead(() => refreshReports());
  }

  async function loadBase(keepMappingDraft = false) {
    const [nextAccounts, nextSettings, nextPeriods, nextContinuity] = await Promise.all([desktopApi.listAccounts(), desktopApi.getAccountingSettings(), desktopApi.listAccountingPeriods(), desktopApi.getAccountingContinuity()]);
    setAccounts(nextAccounts);
    if (!keepMappingDraft) setSettings(nextSettings);
    setSavedSettings(nextSettings);
    setPeriods(nextPeriods);
    setContinuity(nextContinuity);
    setBaseLoaded(true);
    baseReady.current = true;
    const accountId = nextAccounts.some((account) => account.id === selection.current.accountId)
      ? selection.current.accountId
      : nextAccounts[0]?.id || '';
    selection.current = { ...selection.current, accountId };
    setSelectedAccountId(accountId);
    return accountId;
  }

  async function refreshReports() {
    const request = ++reportRequest.current;
    applyReports(emptyReports());
    const { reports, failures } = await readAccountingReports(selection.current);
    if (request !== reportRequest.current) return;
    applyReports(reports);
    if (failures.length) {
      const labels = failures.map((failure) => failure.label).join(', ');
      throw new Error(`Certains états n’ont pas pu être actualisés (${labels}). Les autres résultats chargés restent affichés. ${errorMessage(failures[0].reason, 'Erreur locale non détaillée.')}`);
    }
  }

  useEffect(() => {
    if (focusEntry) return;
    void runRead(async () => {
      await loadBase();
      await refreshReports();
    });
  }, []);

  useEffect(() => {
    if (!focusEntry) return;
    const preferredFilter = accountingEntryFocusFilter(focusEntry);
    selectReports({ tab: 'journal', filter: preferredFilter });
    const request = reportRequest.current;
    setPeriodId('');
    setActiveEntryFocus({
      target: focusEntry,
      outsidePaymentDate:
        focusEntry.accountingState !== 'active' || !preferredFilter.dateFrom,
    });

    void runRead(async () => {
      await loadBase();
      if (request !== reportRequest.current) { await refreshReports(); return; }
      let resolvedFilter = preferredFilter;
      let targetJournal = await desktopApi.getJournal(resolvedFilter);
      if (request !== reportRequest.current) return;
      let outsidePaymentDate =
        focusEntry.accountingState !== 'active' || !preferredFilter.dateFrom;

      if (
        !targetJournal.entries.some((entry) => entry.id === focusEntry.entryId) &&
        preferredFilter.dateFrom
      ) {
        resolvedFilter = {};
        targetJournal = await desktopApi.getJournal(resolvedFilter);
        if (request !== reportRequest.current) return;
        outsidePaymentDate = true;
      }

      if (!targetJournal.entries.some((entry) => entry.id === focusEntry.entryId)) {
        setActiveEntryFocus(null);
        onFocusHandled();
        throw new Error(
          `L’écriture ${focusEntry.entryNumber} liée à cet encaissement n’a pas été retrouvée dans le journal local. Ouvrez « Plan & liaisons » pour contrôler la continuité comptable.`,
        );
      }

      setActiveEntryFocus({ target: focusEntry, outsidePaymentDate });
      selectReports({ filter: resolvedFilter });
      // Reuse the exact journal already checked above, including its fallback.
      setJournal(targetJournal);
      setNotice(`Écriture ${focusEntry.entryNumber} affichée dans le journal.`);
    });
  }, [focusEntry]);

  useEffect(() => {
    const target = activeEntryFocus?.target;
    if (
      !target ||
      tab !== 'journal' ||
      !focusedEntryAvailable
    )
      return;

    let focusedNode: HTMLElement | null = null;
    const frame = window.requestAnimationFrame(() => {
      const node = Array.from(
        document.querySelectorAll<HTMLElement>('[data-journal-entry-id]'),
      ).find((candidate) => candidate.dataset.journalEntryId === target.entryId);
      if (!node || node.dataset.journalEntryId !== target.entryId) return;
      focusedNode = node;
      node.classList.add('is-targeted-entry');
      node.setAttribute('aria-current', 'true');
      const reduceMotion =
        window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      node.scrollIntoView({
        behavior: reduceMotion ? 'auto' : 'smooth',
        block: 'center',
      });
      node.focus({ preventScroll: true });
      onFocusHandled();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      focusedNode?.classList.remove('is-targeted-entry');
      focusedNode?.removeAttribute('aria-current');
    };
  }, [activeEntryFocus, focusedEntryAvailable, onFocusHandled, tab]);

  async function reloadAll(success?: string, rethrow = false) { await run(async () => { await loadBase(); await refreshReports(); }, success, rethrow); }

  async function retryReversalReports() {
    await run(async () => {
      await loadBase();
      // A view refresh may be superseded by navigation and ignore its failure.
      // Only this independent, successful read can clear the reversal guard.
      await desktopApi.getJournal(selection.current.filter);
      await refreshReports();
      setReversalRefreshRequired(false);
    }, 'Les états sont actualisés.');
  }

  function choosePeriod(id: string, nextTab = selection.current.tab) {
    setPeriodId(id);
    const period = periods.find((item) => item.id === id);
    const nextFilter = period ? { dateFrom: period.dateFrom, dateTo: period.dateTo } : {};
    selectReports({ filter: nextFilter, tab: nextTab });
    void runRead(() => refreshReports(), period ? `Les états de « ${period.name} » sont affichés.` : 'La période libre est affichée.');
  }

  async function refreshSavedPeriod(saved: PeriodDraft) {
    const nextFilter = { dateFrom: saved.dateFrom, dateTo: saved.dateTo };
    const request = reportRequest.current;
    await run(async () => {
      await loadBase();
      if (request === reportRequest.current) { setPeriodId(saved.id); selectReports({ filter: nextFilter }); }
      await refreshReports();
    }, 'L’exercice et ses états ont été actualisés.', true);
  }

  function openClosingPeriod(id: string) {
    if (busy) return;
    if (!periods.some(period => period.id === id)) { setError('Cet exercice n’est pas dans la liste chargée. Actualisez les données pour le retrouver.'); return; }
    setReturnToClosing(false); choosePeriod(id, 'closing');
  }

  function changeFreeFilter(patch: Partial<PeriodFilter>) {
    const nextFilter = { ...selection.current.filter, ...patch };
    setPeriodId('');
    selectReports({ filter: nextFilter });
    void runRead(() => refreshReports());
  }

  async function saveAccount(form: FormData) {
    const accountType = String(form.get('accountType')) as Account['accountType'];
    const normalBalance = String(form.get('normalBalance')) as Account['normalBalance'];
    await run(async () => {
      await desktopApi.upsertAccount({ id: accountDraft?.id, code: String(form.get('code')), name: String(form.get('name')), accountType, normalBalance, reportSection: String(form.get('reportSection')) as Account['reportSection'], active: form.get('active') === 'on' });
      setAccountDraft(null); await loadBase(true); await refreshReports();
    }, 'Le compte a été enregistré.');
  }

  async function commitAccountingSetup(): Promise<AccountingConfigurationResult> {
    if (!setupReview || busy || readOnly) throw new Error('La configuration ne peut pas être modifiée pour le moment.');
    const issue = setupReview.mode === 'mapping' ? accountingMappingIssues(setupReview.settings, accounts, mappingFields)[0] : null;
    if (issue) throw new Error(issue.message);
    if (setupReview.mode === 'starter' && !continuity.starterAvailable) throw new Error('Une configuration existe déjà. Revenez aux comptes pour la vérifier.');
    blockingActions.current++;
    setBusy(true); setError(''); setNotice('');
    try { return setupReview.mode === 'starter' ? await desktopApi.installSwissAccountingStarter() : await desktopApi.configureAccounting(setupReview.settings); }
    finally { blockingActions.current--; setBusy(latestActionPending.current || blockingActions.current > 0); }
  }

  async function refreshAccountingSetup(result: AccountingConfigurationResult) {
    blockingActions.current++;
    setBusy(true);
    try {
      const [, nextWorkspace] = await Promise.all([loadBase(), desktopApi.loadWorkspace()]);
      onWorkspaceChange(nextWorkspace);
      await refreshReports();
      const sync = result.synchronization;
      setNotice(`Configuration enregistrée · ${sync.createdTotal} écriture(s) intégrée(s).${sync.skippedClosedHistory ? ` ${sync.skippedClosedHistory} opération(s) de périodes fermées demandent une reprise de soldes d’ouverture.` : ''}${sync.remaining.totalAnomalies ? ` ${sync.remaining.totalAnomalies} point(s) restent à contrôler.` : ''}`);
    } finally { blockingActions.current--; setBusy(latestActionPending.current || blockingActions.current > 0); }
  }

  function openAccountDraft(draft: Partial<Account> & Pick<Account, 'code' | 'name'>) {
    setAccountDraft(draft); setManualPlanOpen(true);
    requestAnimationFrame(() => {
      const input = document.querySelector<HTMLInputElement>('.accounting-account-plan input[name="code"]');
      input?.focus({ preventScroll: true }); input?.closest('.account-inline-form')?.scrollIntoView({ block: 'start' });
    });
  }

  async function postEntry(form: FormData) {
    if (entryLines.length < 2 || debit <= 0 || debit !== credit || entryLines.some((line) => !line.accountId || (line.debitCents > 0) === (line.creditCents > 0))) { setError('Une écriture doit avoir au moins deux lignes, un seul côté par ligne et des débits égaux aux crédits.'); return; }
    const submission = {
      entryDate: String(form.get('entryDate')),
      description: String(form.get('description')),
      lines: entryLines,
    };
    await run(async () => {
      const attempt = await prepareManualJournalAttempt(
        manualJournalAttempt.current,
        submission,
      );
      manualJournalAttempt.current = attempt;
      await desktopApi.postManualJournalEntry({
        ...submission,
        requestId: attempt.requestId,
      });
      await refreshReports();
      clearManualJournalAttempt(attempt);
      manualJournalAttempt.current = null;
      setEntryLines([newJournalLine(), newJournalLine()]);
      setEntryOpen(false);
    }, 'L’écriture équilibrée a été comptabilisée.');
  }

  async function reverseEntry(date: string, description: string) {
    if (!reversalTarget || busy || reversalRefreshRequired) throw new Error('Actualisez le journal avant de poursuivre.');
    blockingActions.current++;
    setBusy(true); setError(''); setNotice('');
    try {
      await desktopApi.reverseJournalEntry(reversalTarget.id,date,description);
      setReversalTarget(null);
      setNotice(reversalTarget.reversalAction==='restore_expense' ? 'La dépense a été rétablie dans le journal. Aucun nouveau paiement bancaire n’a été envoyé.' : 'L’écriture inverse a été enregistrée.');
      try { await loadBase(); await refreshReports(); }
      catch(cause) { setReversalRefreshRequired(true); setError(errorMessage(cause,'La correction est enregistrée, mais la lecture du journal a échoué.')); }
    } finally { blockingActions.current--; setBusy(latestActionPending.current || blockingActions.current > 0); }
  }

  async function openLinkedJournal(entryId:string) {
    setActiveEntryFocus(null); setVatJournalFocus(entryId); setPeriodId(''); selectReports({ filter: {}, tab: 'journal' });
    await runRead(()=>refreshReports());
  }
  useEffect(()=>{
    if(!vatJournalFocus || tab!=='journal')return;
    let focusedNode:HTMLElement|undefined;
    const frame=requestAnimationFrame(()=>{
      const node=Array.from(document.querySelectorAll<HTMLElement>('[data-journal-entry-id]')).find(n=>n.dataset.journalEntryId===vatJournalFocus);
      focusedNode=node;
      node?.classList.add('is-targeted-entry');node?.focus({preventScroll:true});node?.scrollIntoView({block:'start'});
    });
    return ()=>{cancelAnimationFrame(frame);focusedNode?.classList.remove('is-targeted-entry');};
  },[vatJournalFocus,journal,tab]);

  function patchLine(id: string, patch: Partial<JournalDraftLine>) { setEntryLines((current) => current.map((line) => line.id === id ? { ...line, ...patch } : line)); }

  const tabs: Array<[Tab, string, React.ReactNode]> = [
    ['overview', t('Vue d’ensemble'), <Landmark size={16}/>],
    ['assets', t('Immobilisations'), <Archive size={16}/>],
    ['journal', t('Journal'), <BookOpen size={16} />], ['ledger', t('Grand livre'), <ListChecks size={16} />], ['trial', t('Balance'), <Scale size={16} />], ['balance', t('Bilan'), <Landmark size={16} />], ['income', t('Résultat'), <CheckCircle2 size={16} />], ['vat', t('TVA'), <ReceiptText size={16} />], ['closing', t('Dossier de clôture'), <FileCheck2 size={16} />], ['accounts', t('Plan & liaisons'), <ShieldCheck size={16} />], ['periods', t('Exercices'), <LockKeyhole size={16} />],
  ];
  const overviewPeriod = (['month', 'quarter', 'year'] as const).find(key => { const dates = financePeriod(key, todayIso()); return dates.dateFrom === displayFilter.dateFrom && dates.dateTo === displayFilter.dateTo; }) || 'custom';
  const everyday:Tab[]=['overview','income','vat','assets','closing'];
  const primaryTabs=tabs.filter(([id])=>everyday.includes(id));
  const advancedTab=tabs.find(([id])=>id===tab&&!everyday.includes(id));
  if(advancedTab)primaryTabs.push(advancedTab);

  async function exportAccounts() {
    await run(async () => {
      const result = await desktopApi.exportAnnualAccountsPdf({ dateFrom: balance?.scope.dateFrom || filter.dateFrom, dateTo: balance?.scope.dateTo || filter.dateTo });
      if (result) setExportedPdf(result);
      if (result) setNotice(`Bilan et résultat exportés en PDF (${result.pages} pages). ${result.closed ? 'Exercice clôturé.' : 'Document provisoire : l’exercice reste ouvert.'}`);
    });
  }

  return <div className={`stack-layout accounting-screen ${tab==='overview'?'accounting-screen--overview':''}`}>
    {hasPeriodFilter&&tab!=='overview'?<div className="finance-period-shortcuts" role="group" aria-label={t('Choisir une période rapidement')}>{([['month','Ce mois'],['quarter','Ce trimestre'],['year','Cette année'],['all','Toutes les dates']] as const).map(([key,label])=><button type="button" key={key} disabled={busy} onClick={()=>changeFreeFilter(financePeriod(key,todayIso()))}>{t(label)}</button>)}</div>:null}
    <section className={`accounting-toolbar panel ${hasPeriodFilter ? '' : 'accounting-toolbar--global'}`}>
      <div className="finance-navigation">
        <SectionTabs items={primaryTabs} mobileItems={tabs} value={tab} onChange={setTab} label={t('Section comptable')} />
        {tab === 'overview' ? <label className="finance-navigation__more finance-navigation__more--period">
          <span>{t('Période')}</span>
          <span className="finance-navigation__period-value" aria-hidden="true"><span>{t(({ month: 'Ce mois', quarter: 'Ce trimestre', year: 'Cette année', custom: 'Période personnalisée' } as const)[overviewPeriod])}</span><ChevronDown size={18}/></span>
          <select aria-label={t('Période de la vue d’ensemble')} disabled={busy} value={overviewPeriod} onChange={event => { if (event.target.value !== 'custom') changeFreeFilter(financePeriod(event.target.value as 'month' | 'quarter' | 'year' | 'all', todayIso())); }}>
            <option value="month">{t('Ce mois')}</option><option value="quarter">{t('Ce trimestre')}</option><option value="year">{t('Cette année')}</option><option value="custom" disabled>{t('Période personnalisée')}</option>
          </select>
        </label> : <label className="finance-navigation__more finance-navigation__more--tools"><span>{t('Comptabilité détaillée')}</span><select aria-label={t('Autres outils comptables')} value={everyday.includes(tab) ? '' : tab} onChange={event => { if (event.target.value) setTab(event.target.value as Tab); }}><option value="">{t('Choisir un outil…')}</option>{tabs.filter(([id]) => !everyday.includes(id)).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>}
      </div>
      <div className="accounting-period-bar" hidden={tab==='overview'}>
        {hasPeriodFilter && <>
          <button type="button" className="accounting-period-toggle" aria-expanded={filtersExpanded} aria-controls={filtersId} onClick={() => setFiltersExpanded((expanded) => !expanded)}>
            <SlidersHorizontal size={17} aria-hidden="true" /><span><span>{t('Période')}</span><strong>{periodLabel}</strong></span><ChevronDown size={16} aria-hidden="true" />
          </button>
          <span className={`report-state ${reportState === 'Clôturé' ? 'is-closed' : ''}`} role="status" aria-live="polite">{busy ? t('Actualisation…') : t(reportState)}</span>
        </>}
        <Button variant="secondary" size="small" disabled={busy} onClick={() => void reloadAll(t('Les états ont été actualisés.'))}><RefreshCw size={15} /> {t('Actualiser')}</Button>
      </div>
      {hasPeriodFilter && tab!=='overview' && <div id={filtersId} className="accounting-filters" data-expanded={filtersExpanded} onFocusCapture={() => setFiltersExpanded(true)}>
          <Field label={t('Exercice ou période')}><select value={periodId} disabled={busy} aria-label={t('Exercice ou période comptable')} onChange={(event) => choosePeriod(event.target.value)}><option value="">{t('Période libre')}</option>{periods.map((period) => <option key={period.id} value={period.id}>{period.name} · {period.status === 'closed' ? t('clôturé') : t('ouvert')}</option>)}</select></Field>
          <Field label={t('Du')}><input type="date" value={filter.dateFrom ?? ''} disabled={busy} onChange={(event) => changeFreeFilter({ dateFrom: event.target.value || undefined })} aria-label={t('Date de début de la période')} /></Field>
          <Field label={t('Au')}><input type="date" value={filter.dateTo ?? ''} disabled={busy} onChange={(event) => changeFreeFilter({ dateTo: event.target.value || undefined })} aria-label={t('Date de fin de la période')} /></Field>
      </div>}
    </section>
    {['balance', 'income', 'closing'].includes(tab) ? <section className="panel accounting-export-bar"><div><strong>Bilan et compte de résultat</strong><p>Présentation suisse, détails par rubrique et comparaison avec l’exercice précédent.</p></div><Button disabled={busy || !balance || !income} onClick={() => void exportAccounts()}><FileCheck2 size={17} /> Exporter le bilan PDF</Button></section> : null}
    {error ? <ErrorPanel message={error} onRetry={() => { if (!busy) void reloadAll(); }} /> : null}{notice ? <div className="notice notice--success" role="status" aria-live="polite"><span><CheckCircle2 size={18} />{notice}</span><button type="button" onClick={() => setNotice('')} aria-label="Fermer le message"><X size={15} /></button></div> : null}

    {exportedPdf && <PdfExportReceipt result={exportedPdf} disabled={busy} onBusyChange={setPdfShareBusy} />}
    {tab === 'overview' && !baseLoaded && busy ? <p role="status">{t('Chargement de la comptabilité…')}</p> : null}
    {tab === 'overview' && baseLoaded ? <FinanceOverview workspace={workspace} income={income} continuity={continuity} busy={busy} periodLabel={periodLabel} readOnly={readOnly} onSection={setTab} onWorkspaceChange={onWorkspaceChange} onInstallStarter={async () => { if (busy || readOnly) return; setTab('accounts'); setSetupReview({ mode: 'starter', settings: { ...settings } }); }}/> : null}
    {accountingExplanations[tab]?<aside className="finance-reading-note"><BookOpen size={19}/><div><h2>{accountingExplanations[tab].title}</h2><p>{accountingExplanations[tab].text}</p></div></aside>:null}
    {reversalRefreshRequired ? <div className="report-callout is-warning" role="status"><RefreshCw size={20}/><div><strong>Correction enregistrée · actualisation nécessaire</strong><p>Rechargez les états avant une nouvelle écriture.</p></div><Button disabled={busy} onClick={()=>void retryReversalReports()}>Actualiser les états</Button></div> : null}
    {tab === 'journal' && activeEntryFocus && focusedEntryAvailable ? <div className={`report-callout accounting-entry-focus ${activeEntryFocus.outsidePaymentDate ? 'is-warning' : ''}`} role="status"><BookOpen size={20} /><div><strong>Écriture {activeEntryFocus.target.entryNumber} liée à l’encaissement</strong><p>{activeEntryFocus.target.accountingState === 'reversed' ? 'L’écriture originale est mise en évidence et le journal reste en période libre afin de rendre toute la chaîne d’extournes visible. L’effet comptable net de cet encaissement est actuellement annulé.' : activeEntryFocus.target.accountingState === 'restored' ? `L’effet comptable net est rétabli après ${activeEntryFocus.target.reversalDepth ?? 'plusieurs'} extournes. Le journal reste en période libre afin de rendre toute la chaîne visible.` : activeEntryFocus.target.accountingState === 'unknown' ? 'Le lien existe, mais l’état ou la profondeur de sa chaîne d’extournes n’a pas pu être établi de façon fiable. Le journal reste en période libre pour permettre le contrôle.' : activeEntryFocus.outsidePaymentDate ? 'Le lien exact a été retrouvé en période libre, hors du jour indiqué par le paiement. Contrôlez la date depuis « Plan & liaisons ».' : `Le journal est limité au ${formatDate(activeEntryFocus.target.entryDate)} et l’écriture correspondante est mise en évidence ci-dessous.`}</p></div></div> : null}

    {tab === 'journal' ? <section className="panel"><SectionHeading eyebrow="Partie double" title="Journal chronologique" description="Chaque écriture validée est immuable et équilibrée; une correction passe par une extourne traçable." action={<Button disabled={!settings.enabled || busy || reversalRefreshRequired} onClick={() => setEntryOpen((value) => !value)}><Plus size={15} /> Saisir une écriture</Button>} />{!settings.enabled ? <div className="warning-card"><ShieldCheck size={18} /><div><strong>Comptabilité non activée</strong><p>Créez le plan comptable et sélectionnez les {mappingCountLabel} comptes de liaison requis.</p></div></div> : null}{entryOpen ? <form className="accounting-entry-form" onSubmit={submitForm(postEntry)}><div className="form-grid"><Field label="Date" required><input name="entryDate" type="date" defaultValue={todayIso()} required /></Field><Field label="Description" required wide><input name="description" required /></Field></div><JournalLinesEditor lines={entryLines} accounts={activeAccounts} workspace={workspace} onPatch={patchLine} onAdd={() => setEntryLines((current) => [...current, newJournalLine()])} onRemove={(id) => setEntryLines((current) => current.length > 2 ? current.filter((line) => line.id !== id) : current)} /><div className={`entry-balance ${debit === credit && debit > 0 ? 'is-balanced' : ''}`}><span>Débits {formatMoney(debit)}</span><span>Crédits {formatMoney(credit)}</span><strong>{debit === credit && debit > 0 ? 'Équilibrée' : `Écart ${formatMoney(Math.abs(debit - credit))}`}</strong></div><div className="form-actions"><Button type="button" variant="secondary" onClick={() => setEntryOpen(false)}>Annuler</Button><Button type="submit" disabled={busy || reversalRefreshRequired || debit <= 0 || debit !== credit}>Comptabiliser</Button></div></form> : null}{reversalTarget ? <JournalReversalDialog entry={reversalTarget} busy={busy} onClose={()=>setReversalTarget(null)} onConfirm={reverseEntry}/> : null}{journal?.entries.length ? <JournalTable report={journal} disabled={busy || reversalRefreshRequired} onReverse={setReversalTarget} /> : <EmptyState icon={<BookOpen />} title="Journal vide" text="Aucune écriture réelle n’a encore été comptabilisée pour cette période." />}</section> : null}

    {tab === 'ledger' ? <section className="panel"><SectionHeading eyebrow={`Mouvements par compte · ${ledger?.currency.baseCurrency || 'CHF'}`} title="Grand livre" description="Le solde d’ouverture reprend toutes les écritures antérieures; chaque ligne montre ensuite le solde cumulé et la clôture de la période." /><div className="ledger-picker"><Field label="Compte"><select value={selectedAccountId} disabled={busy} onChange={(event) => { selectReports({ accountId: event.target.value }); void runRead(() => refreshReports()); }}><option value="">Choisir un compte</option>{accounts.map((account) => <option value={account.id} key={account.id}>{account.code} · {account.name}</option>)}</select></Field></div>{ledger ? <><div className="summary-strip"><div><span>Solde d’ouverture</span><strong>{balanceSideLabel(ledger.openingDebitBalanceCents, ledger.openingCreditBalanceCents)}</strong></div><div><span>Débits de la période</span><strong>{formatMoney(ledger.debitCents)}</strong></div><div><span>Crédits de la période</span><strong>{formatMoney(ledger.creditCents)}</strong></div><div><span>Solde de clôture</span><strong>{balanceSideLabel(ledger.closingDebitBalanceCents, ledger.closingCreditBalanceCents)}</strong></div></div>{ledger.lines.length ? <JournalLineTable lines={ledger.lines} showRunningBalance /> : <div className="report-callout"><ListChecks size={20} /><div><strong>Aucun mouvement dans la période</strong><p>Le compte conserve néanmoins son solde d’ouverture de {balanceSideLabel(ledger.openingDebitBalanceCents, ledger.openingCreditBalanceCents)}.</p></div></div>}</> : <EmptyState icon={<ListChecks />} title="Aucun compte sélectionné" text="Choisissez un compte du plan comptable pour afficher son ouverture, ses mouvements et sa clôture." />}</section> : null}

    {tab === 'trial' ? <section className="panel"><SectionHeading eyebrow={`${reportState} · ${trial?.currency.baseCurrency || 'CHF'}`} title="Balance des comptes" description="Ouverture, mouvements et clôture sont présentés séparément. Les trois couples de totaux doivent rester équilibrés." />{trial?.rows.length ? <><div className={`report-callout ${trial.balanced ? '' : 'is-warning'}`}><Scale size={20} /><div><strong>{trial.balanced ? 'Ouverture, mouvements et clôture équilibrés' : 'Écart comptable à contrôler'}</strong><p>Ouverture {formatMoney(trial.openingDebitBalanceCents)} / {formatMoney(trial.openingCreditBalanceCents)} · mouvements {formatMoney(trial.debitCents)} / {formatMoney(trial.creditCents)} · clôture {formatMoney(trial.closingDebitBalanceCents)} / {formatMoney(trial.closingCreditBalanceCents)}.</p></div></div><div className="table-panel"><table data-apple-records><thead><tr><th>Compte</th><th>Ouverture débit</th><th>Ouverture crédit</th><th>Mouvements débit</th><th>Mouvements crédit</th><th>Clôture débit</th><th>Clôture crédit</th></tr></thead><tbody>{trial.rows.map((row) => <tr key={row.id}><td data-label={t('Compte')}><strong>{row.code}</strong><small>{row.name}</small></td><td data-label={t('Ouverture débit')}>{formatMoney(row.openingDebitBalanceCents)}</td><td data-label={t('Ouverture crédit')}>{formatMoney(row.openingCreditBalanceCents)}</td><td data-label={t('Mouvements débit')}>{formatMoney(row.debitCents)}</td><td data-label={t('Mouvements crédit')}>{formatMoney(row.creditCents)}</td><td data-label={t('Clôture débit')}>{formatMoney(row.debitBalanceCents)}</td><td data-label={t('Clôture crédit')}>{formatMoney(row.creditBalanceCents)}</td></tr>)}</tbody><tfoot><tr><th>Totaux</th><th data-label={t('Ouverture débit')}>{formatMoney(trial.openingDebitBalanceCents)}</th><th data-label={t('Ouverture crédit')}>{formatMoney(trial.openingCreditBalanceCents)}</th><th data-label={t('Mouvements débit')}>{formatMoney(trial.debitCents)}</th><th data-label={t('Mouvements crédit')}>{formatMoney(trial.creditCents)}</th><th data-label={t('Clôture débit')}>{formatMoney(trial.closingDebitBalanceCents)}</th><th data-label={t('Clôture crédit')}>{formatMoney(trial.closingCreditBalanceCents)}</th></tr></tfoot></table></div></> : <EmptyState icon={<Scale />} title="Balance vide" text="Aucune écriture ne contribue à l’ouverture ni à la période sélectionnée." />}</section> : null}

    {tab === 'balance' ? <FinancialStatement title="Bilan" state={reportState} rows={balance?.rows ?? []} summary={[['Actifs', balance?.assetsCents, balance?.previousAssetsCents], ['Dettes', balance?.liabilitiesCents, balance?.previousLiabilitiesCents], ['Fonds propres', balance?.equityCents, balance?.previousEquityCents], ['Résultats antérieurs non affectés', balance?.unallocatedPriorResultsCents, balance?.previousUnallocatedPriorResultsCents], ['Résultat de l’exercice', balance?.currentResultCents, balance?.previousCurrentResultCents]]} comparisonLabel={balance?.scope.comparisonLabel} previousHasActivity={balance?.scope.previousHasActivity} currency={balance?.currency.baseCurrency} balanced={balance?.balanced} /> : null}
    {tab === 'income' ? <FinancialStatement title="Compte de résultat" state={reportState} rows={income?.rows ?? []} summary={[['Produits', income?.revenueCents, income?.previousRevenueCents], ['Charges', income?.expenseCents, income?.previousExpenseCents], ['Résultat', income?.profitCents, income?.previousProfitCents]]} comparisonLabel={income?.scope.comparisonLabel} previousHasActivity={income?.scope.previousHasActivity} currency={income?.currency.baseCurrency} /> : null}
    {tab === 'assets' ? <FixedAssetsPanel workspace={workspace} readOnly={Boolean(readOnly)} onChanged={()=>reloadAll()} onSetup={()=>setTab('accounts')}/> : null}
    {tab === 'vat' ? <VatCenter filter={filter} workspace={workspace} readOnly={readOnly} onAccountingChanged={reloadAll} onOpenJournal={(id)=>void openLinkedJournal(id)} /> : null}
    {returnToClosing && tab !== 'closing' && <div className="report-callout"><FileCheck2 size={20} /><div><strong>Reprendre le contrôle de l’exercice</strong><p>Après vos corrections, préparez un nouveau contrôle avant toute clôture.</p></div><Button disabled={busy} onClick={() => { setReturnToClosing(false); setTab('closing'); }}>Revenir au dossier de clôture</Button></div>}
    {tab === 'closing' ? <ClosingFolder readOnly={readOnly} onNavigate={target => { setReturnToClosing(target !== 'periods'); setTab(target); }} filter={filter} period={selectedPeriod} loading={busy} trial={busy ? null : trial} balance={busy ? null : balance} income={busy ? null : income} onAccountingChanged={() => reloadAll('Les états et le statut de l’exercice ont été actualisés.', true)} /> : null}

    {tab === 'accounts' ? <div className="stack-layout">
      <CustomerCreditAccountingIssues issues={continuity.customerCreditIssues} busy={busy} onOpenJournal={(id)=>void openLinkedJournal(id)}/>
      {continuity.closedHistoryRequiresOpening > 0 ? <div className="report-callout is-warning"><LockKeyhole size={20} /><div><strong>{continuity.closedHistoryRequiresOpening} opération{continuity.closedHistoryRequiresOpening > 1 ? 's' : ''} appartiennent à des exercices clôturés</strong><p>Zentra ne déplace jamais leur chiffre d’affaires, TVA ou charges dans l’exercice courant. Activez la chaîne future, puis faites valider les soldes d’ouverture par votre fiduciaire. {continuity.totalAnomalies > continuity.closedHistoryRequiresOpening ? `${continuity.totalAnomalies - continuity.closedHistoryRequiresOpening} autre(s) anomalie(s) restent aussi à traiter.` : ''}</p></div></div> : continuity.enabled && !continuity.mappingReady ? <div className="report-callout is-warning"><RefreshCw size={20} /><div><strong>Comptabilité active mais liaisons incomplètes</strong><p>Vérifiez les {mappingCountLabel} comptes actifs avant la prochaine opération financière.{continuity.totalAnomalies > 1 ? ` ${continuity.totalAnomalies - 1} autre(s) point(s) de continuité restent à traiter.` : ''}</p></div></div> : continuity.totalAnomalies > 0 ? <div className="report-callout is-warning"><RefreshCw size={20} /><div><strong>{continuity.totalAnomalies} anomalie{continuity.totalAnomalies > 1 ? 's' : ''} de continuité à traiter</strong><p>À intégrer dans une période ouverte : {continuity.totalMissing}. Écritures dont la date, le montant, la devise ou le compte lié diffèrent de la source : {continuity.semanticPostingMismatches}. Sources extournées ou incohérentes : {continuity.reversedSources + continuity.cancelledActivePostings}. Paiements liés à une facture annulée : {continuity.cancelledInvoicePayments}. Paiements de salaire sans date : {continuity.undatedPayslipPayments}. Liens de journal hérités à contrôler : {continuity.payslipPaymentLinksMissing}. Aucune correction n’est inventée silencieusement.</p></div></div> : continuity.enabled && continuity.mappingReady ? <div className="report-callout"><ShieldCheck size={20} /><div><strong>Chaîne comptable continue</strong><p>Aucune facture, dépense payée, paie ou transaction client ne manque dans le journal; leurs dates, montants, devises et comptes liés correspondent aux opérations d’origine.</p></div></div> : null}
      <AccountingSetupPanel settings={settings} savedSettings={savedSettings} accounts={accounts} continuity={continuity} fields={mappingFields} busy={busy || readOnly} onChange={setSettings} onReview={() => setSetupReview({ mode: 'mapping', settings: { ...settings } })} onStarter={() => setSetupReview({ mode: 'starter', settings: { ...settings } })} onNewAccount={() => openAccountDraft({ code: '', name: '' })} />
      <details className="accounting-account-plan" open={manualPlanOpen} onToggle={event => setManualPlanOpen(event.currentTarget.open)}><summary>Voir et modifier le plan comptable ({accounts.length} comptes)</summary><section className="panel settings-card settings-card--wide"><SectionHeading eyebrow="Plan comptable" title="Comptes" description="Utilisez votre plan réel ou installez la base essentielle adaptée aux modules actifs, puis faites-la contrôler par votre fiduciaire." action={<div className="settings-inline-actions"><Button onClick={() => openAccountDraft({ code: '', name: '' })}><Plus size={15} /> Nouveau compte</Button></div>} />{accountDraft ? <form className="account-inline-form" onSubmit={submitForm(saveAccount)}><Field label="Code" required><input name="code" defaultValue={accountDraft.code} required /></Field><Field label="Nom" required><input name="name" defaultValue={accountDraft.name} required /></Field><Field label="Type" required><select name="accountType" defaultValue={accountDraft.accountType ?? ''} required><option value="">Choisir</option><option value="asset">Actif</option><option value="liability">Passif</option><option value="equity">Fonds propres</option><option value="revenue">Produit</option><option value="expense">Charge</option></select></Field><Field label="Rubrique des états" required><select name="reportSection" defaultValue={accountDraft.reportSection ?? ''} required><option value="">Choisir</option>{reportSections.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><Field label="Solde normal" required><select name="normalBalance" defaultValue={accountDraft.normalBalance ?? ''} required><option value="">Choisir</option><option value="debit">Débit</option><option value="credit">Crédit</option></select></Field><label className="check-card"><input name="active" type="checkbox" defaultChecked={accountDraft.active ?? true} /><span><strong>Compte actif</strong></span></label><div className="form-actions"><Button type="button" variant="secondary" onClick={() => setAccountDraft(null)}>Annuler</Button><Button type="submit" disabled={busy}>Enregistrer</Button></div></form> : null}{accounts.length ? <div className="account-list">{accounts.map((account) => <article key={account.id}><div><strong>{account.code}</strong><span>{account.name}</span><small>{reportSections.find(([value]) => value === account.reportSection)?.[1] || account.reportSection} · solde habituel {account.normalBalance === 'debit' ? 'débiteur' : 'créditeur'}</small></div><StatusBadge status={account.active ? 'validated' : 'incomplete'} /><Button variant="ghost" size="small" onClick={() => openAccountDraft(account)}>Modifier</Button><Button variant="ghost" size="icon" onClick={() => { if (window.confirm(`Supprimer le compte ${account.code} ?`)) void run(async () => { await desktopApi.deleteAccount(account.id); await loadBase(); await refreshReports(); }, 'Le compte inutilisé a été supprimé.'); }}><Archive size={15} /></Button></article>)}</div> : <EmptyState title="Plan comptable vide" text="Installez la base essentielle ou créez votre plan réel avant d’activer les écritures automatiques." />}</section></details>
    </div> : null}
    {setupReview && <AccountingSetupDialog mode={setupReview.mode} settings={setupReview.settings} accounts={accounts} fields={mappingFields} continuity={continuity} busy={busy} readOnly={readOnly} onClose={() => setSetupReview(null)} onCommit={commitAccountingSetup} onRefresh={refreshAccountingSetup} />}

    {tab === 'periods' ? <AccountingPeriodsPanel periods={periods} busy={busy} readOnly={readOnly} onRefresh={refreshSavedPeriod} onOpenClosing={openClosingPeriod} /> : null}
  </div>;
}

function JournalLinesEditor({ lines, accounts, workspace, onPatch, onAdd, onRemove }: { lines: JournalDraftLine[]; accounts: Account[]; workspace: Workspace; onPatch: (id: string, patch: Partial<JournalDraftLine>) => void; onAdd: () => void; onRemove: (id: string) => void }) {
  const terminology = projectTerminology(workspace.settings!.business.nogaSection);
  return <section className="journal-lines">
    <header><strong>Lignes de l’écriture</strong><Button type="button" variant="secondary" size="small" onClick={onAdd}><Plus size={16} /> Ajouter une ligne</Button></header>
    {lines.map((line, index) => <fieldset className="journal-line" key={line.id}>
      <legend>Ligne {index + 1}</legend>
      <div className="journal-line__main">
        <div className="journal-line__account"><Field label="Compte" required><select value={line.accountId} onChange={(event) => onPatch(line.id, { accountId: event.target.value })} required><option value="">Choisir un compte</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}</select></Field></div>
        <Field label="Débit CHF"><input type="number" inputMode="decimal" min="0" step="0.01" value={line.debitCents ? line.debitCents / 100 : ''} onChange={(event) => onPatch(line.id, { debitCents: Math.round((event.target.valueAsNumber || 0) * 100), creditCents: event.target.value ? 0 : line.creditCents })} placeholder="0.00" /></Field>
        <Field label="Crédit CHF"><input type="number" inputMode="decimal" min="0" step="0.01" value={line.creditCents ? line.creditCents / 100 : ''} onChange={(event) => onPatch(line.id, { creditCents: Math.round((event.target.valueAsNumber || 0) * 100), debitCents: event.target.value ? 0 : line.debitCents })} placeholder="0.00" /></Field>
        <Field label="Mémo" wide><input value={line.memo} onChange={(event) => onPatch(line.id, { memo: event.target.value })} placeholder="Précision sur cette ligne" /></Field>
      </div>
      <details className="journal-line__links" open={Boolean(line.projectId || line.clientId || line.employeeId) || undefined}>
        <summary>Rattacher à un {terminology.singular}, un client ou un collaborateur</summary>
        <div>
          <Field label={terminology.singular.charAt(0).toUpperCase() + terminology.singular.slice(1)}><select value={line.projectId} onChange={(event) => onPatch(line.id, { projectId: event.target.value })}><option value="">Sans {terminology.singular}</option>{workspace.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></Field>
          <Field label="Client"><select value={line.clientId} onChange={(event) => onPatch(line.id, { clientId: event.target.value })}><option value="">Sans client</option>{workspace.clients.map((client) => <option key={client.id} value={client.id}>{client.company || client.name}</option>)}</select></Field>
          <Field label="Collaborateur"><select value={line.employeeId} onChange={(event) => onPatch(line.id, { employeeId: event.target.value })}><option value="">Sans collaborateur</option>{workspace.employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></Field>
        </div>
      </details>
      <div className="journal-line__actions"><Button type="button" variant="ghost" size="small" onClick={() => onRemove(line.id)} disabled={lines.length <= 2} aria-label={`Supprimer la ligne ${index + 1}`}><X size={16} /> Supprimer la ligne</Button></div>
    </fieldset>)}
  </section>;
}

function JournalTable({ report, onReverse, disabled }: { report: JournalReport; onReverse: (entry: JournalEntry) => void; disabled: boolean }) {
  return <div className="journal-entry-list">{report.entries.map((entry) => { const alreadyReversed = entry.hasReversal; const canReverse = !entry.customerRecoveryProtected && !['customer_credit_settlement','customer_credit_recovery'].includes(entry.sourceType) && !alreadyReversed && entry.reversalAction !== 'blocked_expense' && entry.reversalAction !== 'blocked_refund' && !(entry.sourceType==='expense' && !entry.reversalAction); return <article key={entry.id} data-journal-entry-id={entry.id} tabIndex={-1}><header><div><strong>{entry.number}</strong><span>{formatDate(entry.entryDate)}</span></div><p>{entry.description}</p><small>{entry.reversalOf ? 'Écriture d’extourne' : entry.sourceType === 'manual' ? 'Saisie manuelle' : entry.customerRecoveryProtected ? 'Pièce liée à une reprise TVA documentée' : entry.sourceType === 'customer_credit_recovery' ? 'Reprise documentée de la TVA des avoirs' : entry.sourceType === 'customer_credit_settlement' ? 'Règlement d’avoir client · correction depuis l’avoir' : entry.sourceType === 'supplier_credit_refund' ? 'Remboursement fournisseur · correction depuis son avoir' : entry.sourceType === 'expense_refund' ? 'Remboursement de dépense · correction depuis l’achat' : `Origine : ${entry.sourceType} · toute extourne automatique restera signalée jusqu’à correction métier`}</small>{canReverse ? <Button variant="ghost" size="small" disabled={disabled} onClick={() => onReverse(entry)}><RotateCcw size={14} /> {entry.reversalAction==='restore_expense'?'Rétablir la dépense':'Extourner'}</Button> : <span className="locked-label"><CheckCircle2 size={13} /> {alreadyReversed?'Extournée':entry.customerRecoveryProtected?'Pièce de reprise conservée':entry.sourceType==='customer_credit_recovery'?'Preuve de reprise conservée':entry.sourceType==='customer_credit_settlement'?'Correction depuis l’avoir':entry.reversalAction==='blocked_refund'?(entry.sourceType === 'supplier_credit_refund' ? 'Remboursement lié à son avoir' : 'Remboursement lié à la dépense'):'Dépense liée au paiement'}</span>}</header><JournalLineTable lines={report.lines.filter((line) => line.journalEntryId === entry.id)} /></article>; })}</div>;
}

function JournalLineTable({ lines, showRunningBalance = false }: { lines: JournalReport['lines']; showRunningBalance?: boolean }) {
  return <div className="table-panel"><table data-apple-records><thead><tr><th>Date / pièce</th><th>Compte</th><th>Mémo</th><th>Débit</th><th>Crédit</th>{showRunningBalance ? <th>Solde cumulé</th> : null}</tr></thead><tbody>{lines.map((line) => <tr key={line.id}><td data-label={t('Date / pièce')}>{formatDate(line.entryDate)}<small>{line.entryNumber}</small></td><td data-label={t('Compte')}><strong>{line.accountCode}</strong><small>{line.accountName}</small></td><td data-label={t('Mémo')}>{line.memo || '—'}</td><td data-label={t('Débit')}>{line.debitCents ? formatMoney(line.debitCents) : '—'}</td><td data-label={t('Crédit')}>{line.creditCents ? formatMoney(line.creditCents) : '—'}</td>{showRunningBalance ? <td data-label={t('Solde cumulé')}>{balanceSideLabel(line.runningDebitBalanceCents ?? 0, line.runningCreditBalanceCents ?? 0)}</td> : null}</tr>)}</tbody></table></div>;
}

function balanceSideLabel(debitCents: number, creditCents: number) {
  if (debitCents > 0) return `Débiteur · ${formatMoney(debitCents)}`;
  if (creditCents > 0) return `Créditeur · ${formatMoney(creditCents)}`;
  return `Soldé · ${formatMoney(0)}`;
}

function FinancialStatement({ title, state, rows, summary, comparisonLabel, previousHasActivity, currency, balanced }: { title: string; state: string; rows: StatementRow[]; summary: Array<[string, number | undefined, number | undefined]>; comparisonLabel?: string; previousHasActivity?: boolean; currency?: string; balanced?: boolean }) {
  return <section className="panel"><SectionHeading eyebrow={`${state} · ${currency || 'CHF'}`} title={title} description="Les valeurs de l’exercice précédent figurent en regard des valeurs courantes. Les agrégations multi-devises sans cours traçable sont bloquées." />{rows.length ? <><div className="summary-strip">{summary.map(([label, amount, previous]) => <div key={label}><span>{label}</span><strong>{formatMoney(amount)}</strong><small>{comparisonLabel || 'Exercice précédent'} · {formatMoney(previous)}</small></div>)}</div><div className="table-panel"><table data-apple-records><thead><tr><th>Compte</th><th>Rubrique</th><th>Exercice sous revue</th><th>{comparisonLabel || 'Exercice précédent'}</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td data-label={t('Compte')}><strong>{row.code}</strong><small>{row.name}</small></td><td data-label={t('Rubrique')}>{reportSections.find(([value]) => value === row.reportSection)?.[1] || row.reportSection}</td><td data-label={t('Exercice sous revue')}>{formatMoney(row.amountCents)}</td><td data-label={comparisonLabel || t('Exercice précédent')}>{formatMoney(row.previousAmountCents)}</td></tr>)}</tbody></table></div>{previousHasActivity === false ? <div className="report-callout is-warning"><FileCheck2 size={20} /><div><strong>Comparatif sans mouvements</strong><p>Les colonnes précédentes restent visibles à zéro; aucune écriture n’a été trouvée dans l’exercice comparatif.</p></div></div> : null}{balanced !== undefined ? <div className={`report-callout ${balanced ? '' : 'is-warning'}`}><Scale size={20} /><div><strong>{balanced ? 'Bilan équilibré' : 'Bilan non équilibré'}</strong><p>{balanced ? 'Actifs = dettes + fonds propres + résultats antérieurs non affectés + résultat de l’exercice.' : 'Contrôlez le plan, les reports et les écritures avant clôture.'}</p></div></div> : null}</> : <EmptyState icon={<Landmark />} title={`${title} vide`} text="Aucune écriture ne permet encore de produire cet état." />}</section>;
}
