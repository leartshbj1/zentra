import { useEffect, useRef, useState } from 'react';
import { Archive, BookOpen, CheckCircle2, FileCheck2, Landmark, ListChecks, LockKeyhole, Plus, ReceiptText, RefreshCw, RotateCcw, Scale, ShieldCheck, X } from 'lucide-react';
import { desktopApi } from './bridge';
import {
  accountingEntryFocusFilter,
  type AccountingEntryFocus,
} from './PaymentAccountingProofs';
import type { Account, AccountingContinuity, AccountingPeriod, AccountingSettings, BalanceSheetReport, IncomeStatementReport, JournalEntry, JournalReport, LedgerReport, PeriodFilter, StatementRow, TrialBalanceReport, Workspace } from './types';
import { createId, errorMessage, formatDate, formatMoney, todayIso } from './utils';
import { Button, EmptyState, ErrorPanel, Field, SectionHeading, StatusBadge, submitForm } from './ui';
import { projectTerminology } from './terminology';
import { ClosingFolder } from './ClosingFolder';
import { VatCenter } from './VatCenter';

type Tab = 'journal' | 'ledger' | 'trial' | 'balance' | 'income' | 'vat' | 'closing' | 'accounts' | 'periods';
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

const coreMappingFields: Array<[keyof AccountingSettings, string]> = [
  ['arAccountId', 'Créances clients'],
  ['revenueAccountId', 'Produits de facturation'],
  ['vatPayableAccountId', 'TVA due'],
  ['vatDeferredPayableAccountId', 'TVA à régulariser · contre-prestations reçues'],
  ['bankAccountId', 'Banque'],
  ['expenseAccountId', 'Charges / dépenses'],
  ['vatReceivableAccountId', 'TVA préalable'],
  ['supplierPayableAccountId', 'Dettes fournisseurs · requis pour valider les achats'],
];

const payrollMappingFields: Array<[keyof AccountingSettings, string]> = [
  ['wagesExpenseAccountId', 'Charges de salaires'],
  ['wagesPayableAccountId', 'Salaires à payer'],
  ['socialExpenseAccountId', 'Charges sociales employeur'],
  ['socialPayableAccountId', 'Cotisations sociales à payer'],
];

const reportSections: Array<[Account['reportSection'], string]> = [
  ['current_assets', 'Actifs circulants'], ['fixed_assets', 'Actifs immobilisés'], ['short_term_liabilities', 'Dettes à court terme'], ['long_term_liabilities', 'Dettes à long terme'], ['equity', 'Fonds propres'], ['net_revenue', 'Chiffre d’affaires net'], ['cost_of_goods', 'Coût des marchandises / prestations'], ['personnel_expense', 'Charges de personnel'], ['other_operating_expense', 'Autres charges d’exploitation'], ['depreciation', 'Amortissements'], ['financial_result', 'Résultat financier'], ['non_operating_result', 'Résultat hors exploitation'], ['exceptional_result', 'Résultat exceptionnel'], ['taxes', 'Impôts'],
];

const newJournalLine = (): JournalDraftLine => ({ id: createId(), accountId: '', debitCents: 0, creditCents: 0, memo: '', projectId: '', clientId: '', employeeId: '' });

export function AccountingScreen({ workspace, onWorkspaceChange, focusEntry, onFocusHandled }: { workspace: Workspace; onWorkspaceChange: (workspace: Workspace) => void; focusEntry: AccountingEntryFocus | null; onFocusHandled: () => void }) {
  const payrollMappingsRequired = Boolean(workspace.settings?.payroll.enabled)
    || (workspace.payslips ?? []).some((payslip) => ['posted', 'paid'].includes(payslip.status));
  const mappingFields = payrollMappingsRequired
    ? [...coreMappingFields, ...payrollMappingFields]
    : coreMappingFields;
  const mappingCountLabel = payrollMappingsRequired ? 'douze' : 'huit';
  const mappingDescription = payrollMappingsRequired
    ? 'Les douze liaisons sont obligatoires, dont deux comptes de passif distincts pour séparer la TVA à régulariser de la TVA due lors des encaissements. Les périodes ouvertes sont rattrapées dans l’ordre; les exercices clôturés restent intacts.'
    : 'Huit liaisons hors paie sont obligatoires, dont deux comptes de passif distincts pour le mode TVA sur les encaissements. Les quatre comptes salaires et cotisations deviendront requis uniquement si la paie est activée; les exercices clôturés restent intacts.';
  const [tab, setTab] = useState<Tab>('journal');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [settings, setSettings] = useState<AccountingSettings>(emptyAccountingSettings);
  const [continuity, setContinuity] = useState<AccountingContinuity>(emptyContinuity);
  const [periods, setPeriods] = useState<AccountingPeriod[]>([]);
  const [filter, setFilter] = useState<PeriodFilter>({});
  const [periodId, setPeriodId] = useState('');
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [journal, setJournal] = useState<JournalReport | null>(null);
  const [ledger, setLedger] = useState<LedgerReport | null>(null);
  const [trial, setTrial] = useState<TrialBalanceReport | null>(null);
  const [balance, setBalance] = useState<BalanceSheetReport | null>(null);
  const [income, setIncome] = useState<IncomeStatementReport | null>(null);
  const [accountDraft, setAccountDraft] = useState<(Partial<Account> & Pick<Account, 'code' | 'name'>) | null>(null);
  const [entryOpen, setEntryOpen] = useState(false);
  const [reversalTarget, setReversalTarget] = useState<JournalEntry | null>(null);
  const [entryLines, setEntryLines] = useState<JournalDraftLine[]>([newJournalLine(), newJournalLine()]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [activeEntryFocus, setActiveEntryFocus] = useState<ActiveEntryFocus | null>(null);
  const reportRequest = useRef(0);
  const actionRequest = useRef(0);

  const activeAccounts = accounts.filter((account) => account.active);
  const debit = entryLines.reduce((sum, line) => sum + line.debitCents, 0);
  const credit = entryLines.reduce((sum, line) => sum + line.creditCents, 0);
  const selectedPeriod = periods.find((period) => period.id === periodId);
  const reportState = selectedPeriod?.status === 'closed' ? 'Clôturé' : 'Provisoire';
  const focusedEntryAvailable = Boolean(
    activeEntryFocus &&
      journal?.entries.some(
        (entry) => entry.id === activeEntryFocus.target.entryId,
      ),
  );

  async function run(action: () => Promise<void>, success?: string) {
    const request = ++actionRequest.current;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      if (request === actionRequest.current && success) setNotice(success);
    } catch (reason) {
      if (request === actionRequest.current) setError(errorMessage(reason, 'La commande comptable locale a échoué.'));
    } finally {
      if (request === actionRequest.current) setBusy(false);
    }
  }

  async function loadBase() {
    const [nextAccounts, nextSettings, nextPeriods, nextContinuity] = await Promise.all([desktopApi.listAccounts(), desktopApi.getAccountingSettings(), desktopApi.listAccountingPeriods(), desktopApi.getAccountingContinuity()]);
    setAccounts(nextAccounts);
    setSettings(nextSettings);
    setPeriods(nextPeriods);
    setContinuity(nextContinuity);
    const accountId = nextAccounts.some((account) => account.id === selectedAccountId)
      ? selectedAccountId
      : nextAccounts[0]?.id || '';
    if (selectedAccountId !== accountId) setSelectedAccountId(accountId);
    return accountId;
  }

  async function refreshReports(nextFilter: PeriodFilter = filter, accountId = selectedAccountId) {
    const request = ++reportRequest.current;
    try {
      const [nextJournal, nextTrial, nextLedger, nextBalance, nextIncome] = await Promise.allSettled([
        desktopApi.getJournal(nextFilter),
        desktopApi.getTrialBalance(nextFilter),
        accountId ? desktopApi.getLedger(accountId, nextFilter) : Promise.resolve(null),
        desktopApi.getBalanceSheet(nextFilter),
        desktopApi.getIncomeStatement(nextFilter),
      ]);
      if (request !== reportRequest.current) return;
      const failures: Array<{ label: string; reason: unknown }> = [];
      if (nextJournal.status === 'fulfilled') setJournal(nextJournal.value);
      else { setJournal(null); failures.push({ label: 'journal', reason: nextJournal.reason }); }
      if (nextTrial.status === 'fulfilled') setTrial(nextTrial.value);
      else { setTrial(null); failures.push({ label: 'balance des comptes', reason: nextTrial.reason }); }
      if (nextLedger.status === 'fulfilled') setLedger(nextLedger.value);
      else { setLedger(null); failures.push({ label: 'grand livre', reason: nextLedger.reason }); }
      if (nextBalance.status === 'fulfilled') setBalance(nextBalance.value);
      else { setBalance(null); failures.push({ label: 'bilan', reason: nextBalance.reason }); }
      if (nextIncome.status === 'fulfilled') setIncome(nextIncome.value);
      else { setIncome(null); failures.push({ label: 'compte de résultat', reason: nextIncome.reason }); }
      if (failures.length) {
        const labels = failures.map((failure) => failure.label).join(', ');
        throw new Error(`Certains états n’ont pas pu être actualisés (${labels}). Les autres résultats chargés restent affichés. ${errorMessage(failures[0].reason, 'Erreur locale non détaillée.')}`);
      }
    } catch (reason) {
      if (request === reportRequest.current) throw reason;
    }
  }

  useEffect(() => {
    if (focusEntry) return;
    void run(async () => {
      const accountId = await loadBase();
      await refreshReports(filter, accountId);
    });
  }, []);

  useEffect(() => {
    if (!focusEntry) return;
    const preferredFilter = accountingEntryFocusFilter(focusEntry);
    setTab('journal');
    setPeriodId('');
    setFilter(preferredFilter);
    setActiveEntryFocus({
      target: focusEntry,
      outsidePaymentDate:
        focusEntry.accountingState !== 'active' || !preferredFilter.dateFrom,
    });

    void run(async () => {
      const accountId = await loadBase();
      let resolvedFilter = preferredFilter;
      let targetJournal = await desktopApi.getJournal(resolvedFilter);
      let outsidePaymentDate =
        focusEntry.accountingState !== 'active' || !preferredFilter.dateFrom;

      if (
        !targetJournal.entries.some((entry) => entry.id === focusEntry.entryId) &&
        preferredFilter.dateFrom
      ) {
        resolvedFilter = {};
        targetJournal = await desktopApi.getJournal(resolvedFilter);
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
      setFilter(resolvedFilter);
      await refreshReports(resolvedFilter, accountId);
    }, `Écriture ${focusEntry.entryNumber} affichée dans le journal.`);
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

  async function reloadAll(success?: string) { await run(async () => { const accountId = await loadBase(); await refreshReports(filter, accountId); }, success); }

  function choosePeriod(id: string) {
    setPeriodId(id);
    const period = periods.find((item) => item.id === id);
    const nextFilter = period ? { dateFrom: period.dateFrom, dateTo: period.dateTo } : {};
    setFilter(nextFilter);
    void run(() => refreshReports(nextFilter), period ? `Les états de « ${period.name} » sont affichés.` : 'La période libre est affichée.');
  }

  function changeFreeFilter(patch: Partial<PeriodFilter>) {
    const nextFilter = { ...filter, ...patch };
    setPeriodId('');
    setFilter(nextFilter);
    void run(() => refreshReports(nextFilter));
  }

  async function saveAccount(form: FormData) {
    const accountType = String(form.get('accountType')) as Account['accountType'];
    const normalBalance = String(form.get('normalBalance')) as Account['normalBalance'];
    await run(async () => {
      await desktopApi.upsertAccount({ id: accountDraft?.id, code: String(form.get('code')), name: String(form.get('name')), accountType, normalBalance, reportSection: String(form.get('reportSection')) as Account['reportSection'], active: form.get('active') === 'on' });
      setAccountDraft(null); const accountId = await loadBase(); await refreshReports(filter, accountId);
    }, 'Le compte a été enregistré.');
  }

  async function saveMapping() {
    if (settings.enabled && mappingFields.some(([key]) => !String(settings[key]))) { setError(`Sélectionnez explicitement chacun des ${mappingCountLabel} comptes de liaison requis avant l’activation.`); return; }
    if (settings.enabled && settings.vatPayableAccountId === settings.vatDeferredPayableAccountId) { setError('Sélectionnez deux comptes de passif distincts pour « TVA due » et « TVA à régulariser ».'); return; }
    await run(async () => {
      const result = await desktopApi.configureAccounting(settings);
      const [accountId, nextWorkspace] = await Promise.all([loadBase(), desktopApi.loadWorkspace()]);
      onWorkspaceChange(nextWorkspace);
      await refreshReports(filter, accountId);
      const message = result.synchronization.requiresOpeningBalanceReview
        ? `Configuration enregistrée · ${result.synchronization.createdTotal} écriture${result.synchronization.createdTotal > 1 ? 's' : ''} de périodes ouvertes intégrée${result.synchronization.createdTotal > 1 ? 's' : ''}. ${result.synchronization.skippedClosedHistory} opération${result.synchronization.skippedClosedHistory > 1 ? 's' : ''} d’exercices clôturés n’ont pas été déplacées : leur reprise de soldes d’ouverture doit être validée.`
        : result.synchronization.createdTotal
        ? `Configuration enregistrée · ${result.synchronization.createdTotal} écriture${result.synchronization.createdTotal > 1 ? 's' : ''} historique${result.synchronization.createdTotal > 1 ? 's' : ''} rattrapée${result.synchronization.createdTotal > 1 ? 's' : ''} sans doublon.`
        : 'La configuration comptable a été enregistrée; aucune écriture historique ne manquait.';
      const unresolved = result.synchronization.remaining.totalAnomalies;
      setNotice(`${message}${unresolved ? ` ${unresolved} point${unresolved > 1 ? 's' : ''} de contrôle reste${unresolved > 1 ? 'nt' : ''} visible${unresolved > 1 ? 's' : ''} dans l’assistant de continuité.` : ''}`);
    });
  }

  async function installStarter() {
    if (!window.confirm('Créer et activer les 12 comptes essentiels Zentra ? Cette base n’est pas un plan comptable exhaustif et doit être contrôlée par votre fiduciaire.')) return;
    await run(async () => {
      const result = await desktopApi.installSwissAccountingStarter();
      const [accountId, nextWorkspace] = await Promise.all([loadBase(), desktopApi.loadWorkspace()]);
      onWorkspaceChange(nextWorkspace);
      await refreshReports(filter, accountId);
      const message = result.synchronization.requiresOpeningBalanceReview
        ? `Base essentielle activée · ${result.synchronization.createdTotal} écriture${result.synchronization.createdTotal > 1 ? 's' : ''} ouverte${result.synchronization.createdTotal > 1 ? 's' : ''} intégrée${result.synchronization.createdTotal > 1 ? 's' : ''}. ${result.synchronization.skippedClosedHistory} opération${result.synchronization.skippedClosedHistory > 1 ? 's' : ''} clôturée${result.synchronization.skippedClosedHistory > 1 ? 's' : ''} reste${result.synchronization.skippedClosedHistory > 1 ? 'nt' : ''} à reprendre via des soldes d’ouverture validés.`
        : result.synchronization.createdTotal
        ? `Base essentielle activée · ${result.synchronization.createdTotal} écriture${result.synchronization.createdTotal > 1 ? 's' : ''} historique${result.synchronization.createdTotal > 1 ? 's' : ''} intégrée${result.synchronization.createdTotal > 1 ? 's' : ''}.`
        : 'La base comptable essentielle est active. Faites valider le plan et les liaisons par votre fiduciaire.';
      const unresolved = result.synchronization.remaining.totalAnomalies;
      setNotice(`${message}${unresolved ? ` ${unresolved} point${unresolved > 1 ? 's' : ''} de contrôle reste${unresolved > 1 ? 'nt' : ''} visible${unresolved > 1 ? 's' : ''} dans l’assistant de continuité.` : ''}`);
    });
  }

  async function postEntry(form: FormData) {
    if (entryLines.length < 2 || debit <= 0 || debit !== credit || entryLines.some((line) => !line.accountId || (line.debitCents > 0) === (line.creditCents > 0))) { setError('Une écriture doit avoir au moins deux lignes, un seul côté par ligne et des débits égaux aux crédits.'); return; }
    await run(async () => {
      await desktopApi.postManualJournalEntry({ entryDate: String(form.get('entryDate')), description: String(form.get('description')), lines: entryLines });
      setEntryLines([newJournalLine(), newJournalLine()]); setEntryOpen(false); await refreshReports();
    }, 'L’écriture équilibrée a été comptabilisée.');
  }

  async function reverseEntry(form: FormData) {
    if (!reversalTarget) return;
    await run(async () => {
      await desktopApi.reverseJournalEntry(reversalTarget.id, String(form.get('entryDate')), String(form.get('description')));
      setReversalTarget(null);
      await refreshReports();
    }, `L’écriture ${reversalTarget.number} a été extournée par une nouvelle écriture inverse.`);
  }

  function patchLine(id: string, patch: Partial<JournalDraftLine>) { setEntryLines((current) => current.map((line) => line.id === id ? { ...line, ...patch } : line)); }

  const tabs: Array<[Tab, string, React.ReactNode]> = [
    ['journal', 'Journal', <BookOpen size={16} />], ['ledger', 'Grand livre', <ListChecks size={16} />], ['trial', 'Balance', <Scale size={16} />], ['balance', 'Bilan', <Landmark size={16} />], ['income', 'Résultat', <CheckCircle2 size={16} />], ['vat', 'TVA', <ReceiptText size={16} />], ['closing', 'Dossier de clôture', <FileCheck2 size={16} />], ['accounts', 'Plan & liaisons', <ShieldCheck size={16} />], ['periods', 'Exercices', <LockKeyhole size={16} />],
  ];

  return <div className="stack-layout accounting-screen">
    <section className="accounting-toolbar panel"><div className="tab-strip" role="tablist" aria-label="Sections de la comptabilité">{tabs.map(([id, label, icon]) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'is-active' : ''} onClick={() => setTab(id)}>{icon}{label}</button>)}</div><div className="accounting-filters"><select value={periodId} disabled={busy} aria-label="Exercice ou période comptable" onChange={(event) => choosePeriod(event.target.value)}><option value="">Période libre</option>{periods.map((period) => <option key={period.id} value={period.id}>{period.name} · {period.status === 'closed' ? 'clôturé' : 'ouvert'}</option>)}</select><input type="date" value={filter.dateFrom ?? ''} disabled={busy} onChange={(event) => changeFreeFilter({ dateFrom: event.target.value || undefined })} aria-label="Date de début de la période" /><input type="date" value={filter.dateTo ?? ''} disabled={busy} onChange={(event) => changeFreeFilter({ dateTo: event.target.value || undefined })} aria-label="Date de fin de la période" /><span className={`report-state ${reportState === 'Clôturé' ? 'is-closed' : ''}`} role="status" aria-live="polite">{busy ? 'Actualisation…' : reportState}</span><Button variant="secondary" size="small" disabled={busy} onClick={() => void run(() => refreshReports(), 'Les états ont été actualisés.')}><RefreshCw size={15} /> Actualiser</Button></div></section>
    {error ? <ErrorPanel message={error} /> : null}{notice ? <div className="notice notice--success" role="status" aria-live="polite"><span><CheckCircle2 size={18} />{notice}</span><button type="button" onClick={() => setNotice('')} aria-label="Fermer le message"><X size={15} /></button></div> : null}

    {tab === 'journal' && activeEntryFocus && focusedEntryAvailable ? <div className={`report-callout accounting-entry-focus ${activeEntryFocus.outsidePaymentDate ? 'is-warning' : ''}`} role="status"><BookOpen size={20} /><div><strong>Écriture {activeEntryFocus.target.entryNumber} liée à l’encaissement</strong><p>{activeEntryFocus.target.accountingState === 'reversed' ? 'L’écriture originale est mise en évidence et le journal reste en période libre afin de rendre toute la chaîne d’extournes visible. L’effet comptable net de cet encaissement est actuellement annulé.' : activeEntryFocus.target.accountingState === 'restored' ? `L’effet comptable net est rétabli après ${activeEntryFocus.target.reversalDepth ?? 'plusieurs'} extournes. Le journal reste en période libre afin de rendre toute la chaîne visible.` : activeEntryFocus.target.accountingState === 'unknown' ? 'Le lien existe, mais l’état ou la profondeur de sa chaîne d’extournes n’a pas pu être établi de façon fiable. Le journal reste en période libre pour permettre le contrôle.' : activeEntryFocus.outsidePaymentDate ? 'Le lien exact a été retrouvé en période libre, hors du jour indiqué par le paiement. Contrôlez la date depuis « Plan & liaisons ».' : `Le journal est limité au ${formatDate(activeEntryFocus.target.entryDate)} et l’écriture correspondante est mise en évidence ci-dessous.`}</p></div></div> : null}

    {tab === 'journal' ? <section className="panel"><SectionHeading eyebrow="Partie double" title="Journal chronologique" description="Chaque écriture validée est immuable et équilibrée; une correction passe par une extourne traçable." action={<Button disabled={!settings.enabled || busy} onClick={() => setEntryOpen((value) => !value)}><Plus size={15} /> Saisir une écriture</Button>} />{!settings.enabled ? <div className="warning-card"><ShieldCheck size={18} /><div><strong>Comptabilité non activée</strong><p>Créez le plan comptable et sélectionnez les {mappingCountLabel} comptes de liaison requis.</p></div></div> : null}{entryOpen ? <form className="accounting-entry-form" onSubmit={submitForm(postEntry)}><div className="form-grid"><Field label="Date" required><input name="entryDate" type="date" defaultValue={todayIso()} required /></Field><Field label="Description" required wide><input name="description" required /></Field></div><JournalLinesEditor lines={entryLines} accounts={activeAccounts} workspace={workspace} onPatch={patchLine} onAdd={() => setEntryLines((current) => [...current, newJournalLine()])} onRemove={(id) => setEntryLines((current) => current.length > 2 ? current.filter((line) => line.id !== id) : current)} /><div className={`entry-balance ${debit === credit && debit > 0 ? 'is-balanced' : ''}`}><span>Débits {formatMoney(debit)}</span><span>Crédits {formatMoney(credit)}</span><strong>{debit === credit && debit > 0 ? 'Équilibrée' : `Écart ${formatMoney(Math.abs(debit - credit))}`}</strong></div><div className="form-actions"><Button type="button" variant="secondary" onClick={() => setEntryOpen(false)}>Annuler</Button><Button type="submit" disabled={busy || debit <= 0 || debit !== credit}>Comptabiliser</Button></div></form> : null}{reversalTarget ? <form className="accounting-entry-form reversal-form" onSubmit={submitForm(reverseEntry)}><div><strong>Extourner {reversalTarget.number}</strong><p>L’écriture originale restera intacte. Une nouvelle écriture inverse sera créée et liée.</p></div><div className="form-grid"><Field label="Date de l’extourne" required><input name="entryDate" type="date" min={reversalTarget.entryDate} defaultValue={todayIso()} required /></Field><Field label="Description"><input name="description" placeholder={`Extourne ${reversalTarget.number}`} /></Field></div><div className="form-actions"><Button type="button" variant="secondary" onClick={() => setReversalTarget(null)}>Annuler</Button><Button type="submit" disabled={busy}><RotateCcw size={15} /> Créer l’extourne</Button></div></form> : null}{journal?.entries.length ? <JournalTable report={journal} onReverse={setReversalTarget} /> : <EmptyState icon={<BookOpen />} title="Journal vide" text="Aucune écriture réelle n’a encore été comptabilisée pour cette période." />}</section> : null}

    {tab === 'ledger' ? <section className="panel"><SectionHeading eyebrow={`Mouvements par compte · ${ledger?.currency.baseCurrency || 'CHF'}`} title="Grand livre" description="Le solde d’ouverture reprend toutes les écritures antérieures; chaque ligne montre ensuite le solde cumulé et la clôture de la période." /><div className="ledger-picker"><Field label="Compte"><select value={selectedAccountId} disabled={busy} onChange={(event) => { const id = event.target.value; setSelectedAccountId(id); if (id) void run(() => refreshReports(filter, id)); else setLedger(null); }}><option value="">Choisir un compte</option>{accounts.map((account) => <option value={account.id} key={account.id}>{account.code} · {account.name}</option>)}</select></Field></div>{ledger ? <><div className="summary-strip"><div><span>Solde d’ouverture</span><strong>{balanceSideLabel(ledger.openingDebitBalanceCents, ledger.openingCreditBalanceCents)}</strong></div><div><span>Débits de la période</span><strong>{formatMoney(ledger.debitCents)}</strong></div><div><span>Crédits de la période</span><strong>{formatMoney(ledger.creditCents)}</strong></div><div><span>Solde de clôture</span><strong>{balanceSideLabel(ledger.closingDebitBalanceCents, ledger.closingCreditBalanceCents)}</strong></div></div>{ledger.lines.length ? <JournalLineTable lines={ledger.lines} showRunningBalance /> : <div className="report-callout"><ListChecks size={20} /><div><strong>Aucun mouvement dans la période</strong><p>Le compte conserve néanmoins son solde d’ouverture de {balanceSideLabel(ledger.openingDebitBalanceCents, ledger.openingCreditBalanceCents)}.</p></div></div>}</> : <EmptyState icon={<ListChecks />} title="Aucun compte sélectionné" text="Choisissez un compte du plan comptable pour afficher son ouverture, ses mouvements et sa clôture." />}</section> : null}

    {tab === 'trial' ? <section className="panel"><SectionHeading eyebrow={`${reportState} · ${trial?.currency.baseCurrency || 'CHF'}`} title="Balance des comptes" description="Ouverture, mouvements et clôture sont présentés séparément. Les trois couples de totaux doivent rester équilibrés." />{trial?.rows.length ? <><div className={`report-callout ${trial.balanced ? '' : 'is-warning'}`}><Scale size={20} /><div><strong>{trial.balanced ? 'Ouverture, mouvements et clôture équilibrés' : 'Écart comptable à contrôler'}</strong><p>Ouverture {formatMoney(trial.openingDebitBalanceCents)} / {formatMoney(trial.openingCreditBalanceCents)} · mouvements {formatMoney(trial.debitCents)} / {formatMoney(trial.creditCents)} · clôture {formatMoney(trial.closingDebitBalanceCents)} / {formatMoney(trial.closingCreditBalanceCents)}.</p></div></div><div className="table-panel"><table><thead><tr><th>Compte</th><th>Ouverture débit</th><th>Ouverture crédit</th><th>Mouvements débit</th><th>Mouvements crédit</th><th>Clôture débit</th><th>Clôture crédit</th></tr></thead><tbody>{trial.rows.map((row) => <tr key={row.id}><td><strong>{row.code}</strong><small>{row.name}</small></td><td>{formatMoney(row.openingDebitBalanceCents)}</td><td>{formatMoney(row.openingCreditBalanceCents)}</td><td>{formatMoney(row.debitCents)}</td><td>{formatMoney(row.creditCents)}</td><td>{formatMoney(row.debitBalanceCents)}</td><td>{formatMoney(row.creditBalanceCents)}</td></tr>)}</tbody><tfoot><tr><th>Totaux</th><th>{formatMoney(trial.openingDebitBalanceCents)}</th><th>{formatMoney(trial.openingCreditBalanceCents)}</th><th>{formatMoney(trial.debitCents)}</th><th>{formatMoney(trial.creditCents)}</th><th>{formatMoney(trial.closingDebitBalanceCents)}</th><th>{formatMoney(trial.closingCreditBalanceCents)}</th></tr></tfoot></table></div></> : <EmptyState icon={<Scale />} title="Balance vide" text="Aucune écriture ne contribue à l’ouverture ni à la période sélectionnée." />}</section> : null}

    {tab === 'balance' ? <FinancialStatement title="Bilan" state={reportState} rows={balance?.rows ?? []} summary={[['Actifs', balance?.assetsCents, balance?.previousAssetsCents], ['Dettes', balance?.liabilitiesCents, balance?.previousLiabilitiesCents], ['Fonds propres', balance?.equityCents, balance?.previousEquityCents], ['Résultats antérieurs non affectés', balance?.unallocatedPriorResultsCents, balance?.previousUnallocatedPriorResultsCents], ['Résultat de l’exercice', balance?.currentResultCents, balance?.previousCurrentResultCents]]} comparisonLabel={balance?.scope.comparisonLabel} previousHasActivity={balance?.scope.previousHasActivity} currency={balance?.currency.baseCurrency} balanced={balance?.balanced} /> : null}
    {tab === 'income' ? <FinancialStatement title="Compte de résultat" state={reportState} rows={income?.rows ?? []} summary={[['Produits', income?.revenueCents, income?.previousRevenueCents], ['Charges', income?.expenseCents, income?.previousExpenseCents], ['Résultat', income?.profitCents, income?.previousProfitCents]]} comparisonLabel={income?.scope.comparisonLabel} previousHasActivity={income?.scope.previousHasActivity} currency={income?.currency.baseCurrency} /> : null}
    {tab === 'vat' ? <VatCenter filter={filter} workspace={workspace} /> : null}
    {tab === 'closing' ? <ClosingFolder filter={filter} period={selectedPeriod} trial={trial} balance={balance} income={income} onAccountingChanged={() => reloadAll('Les états et le statut de l’exercice ont été actualisés.')} /> : null}

    {tab === 'accounts' ? <div className="stack-layout">
      {continuity.closedHistoryRequiresOpening > 0 ? <div className="report-callout is-warning"><LockKeyhole size={20} /><div><strong>{continuity.closedHistoryRequiresOpening} opération{continuity.closedHistoryRequiresOpening > 1 ? 's' : ''} appartiennent à des exercices clôturés</strong><p>Zentra ne déplace jamais leur chiffre d’affaires, TVA ou charges dans l’exercice courant. Activez la chaîne future, puis faites valider les soldes d’ouverture par votre fiduciaire. {continuity.totalAnomalies > continuity.closedHistoryRequiresOpening ? `${continuity.totalAnomalies - continuity.closedHistoryRequiresOpening} autre(s) anomalie(s) restent aussi à traiter.` : ''}</p></div></div> : continuity.enabled && !continuity.mappingReady ? <div className="report-callout is-warning"><RefreshCw size={20} /><div><strong>Comptabilité active mais liaisons incomplètes</strong><p>Vérifiez les {mappingCountLabel} comptes actifs avant la prochaine opération financière.{continuity.totalAnomalies > 1 ? ` ${continuity.totalAnomalies - 1} autre(s) point(s) de continuité restent à traiter.` : ''}</p></div></div> : continuity.totalAnomalies > 0 ? <div className="report-callout is-warning"><RefreshCw size={20} /><div><strong>{continuity.totalAnomalies} anomalie{continuity.totalAnomalies > 1 ? 's' : ''} de continuité à traiter</strong><p>À intégrer dans une période ouverte : {continuity.totalMissing}. Écritures dont la date, le montant, la devise ou le compte lié diffèrent de la source : {continuity.semanticPostingMismatches}. Sources extournées ou incohérentes : {continuity.reversedSources + continuity.cancelledActivePostings}. Paiements liés à une facture annulée : {continuity.cancelledInvoicePayments}. Paiements de salaire sans date : {continuity.undatedPayslipPayments}. Liens de journal hérités à contrôler : {continuity.payslipPaymentLinksMissing}. Aucune correction n’est inventée silencieusement.</p></div></div> : continuity.enabled && continuity.mappingReady ? <div className="report-callout"><ShieldCheck size={20} /><div><strong>Chaîne comptable continue</strong><p>Aucune facture, dépense payée, paie ou transaction client ne manque dans le journal; leurs dates, montants, devises et comptes liés correspondent aux opérations d’origine.</p></div></div> : null}
      <div className="settings-layout"><section className="panel settings-card settings-card--wide"><SectionHeading eyebrow="Plan comptable" title="Comptes" description="Utilisez votre plan réel ou installez la base essentielle adaptée aux modules actifs, puis faites-la contrôler par votre fiduciaire." action={<div className="settings-inline-actions">{continuity.starterAvailable ? <Button variant="secondary" disabled={busy} onClick={() => void installStarter()}><Landmark size={15} /> Installer la base essentielle</Button> : null}<Button onClick={() => setAccountDraft({ code: '', name: '' })}><Plus size={15} /> Nouveau compte</Button></div>} />{accountDraft ? <form className="account-inline-form" onSubmit={submitForm(saveAccount)}><Field label="Code" required><input name="code" defaultValue={accountDraft.code} required /></Field><Field label="Nom" required><input name="name" defaultValue={accountDraft.name} required /></Field><Field label="Type" required><select name="accountType" defaultValue={accountDraft.accountType ?? ''} required><option value="">Choisir</option><option value="asset">Actif</option><option value="liability">Passif</option><option value="equity">Fonds propres</option><option value="revenue">Produit</option><option value="expense">Charge</option></select></Field><Field label="Rubrique des états" required><select name="reportSection" defaultValue={accountDraft.reportSection ?? ''} required><option value="">Choisir</option>{reportSections.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><Field label="Solde normal" required><select name="normalBalance" defaultValue={accountDraft.normalBalance ?? ''} required><option value="">Choisir</option><option value="debit">Débit</option><option value="credit">Crédit</option></select></Field><label className="check-card"><input name="active" type="checkbox" defaultChecked={accountDraft.active ?? true} /><span><strong>Compte actif</strong></span></label><div className="form-actions"><Button type="button" variant="secondary" onClick={() => setAccountDraft(null)}>Annuler</Button><Button type="submit" disabled={busy}>Enregistrer</Button></div></form> : null}{accounts.length ? <div className="account-list">{accounts.map((account) => <article key={account.id}><div><strong>{account.code}</strong><span>{account.name}</span><small>{reportSections.find(([value]) => value === account.reportSection)?.[1] || account.reportSection} · solde {account.normalBalance}</small></div><StatusBadge status={account.active ? 'validated' : 'incomplete'} /><Button variant="ghost" size="small" onClick={() => setAccountDraft(account)}>Modifier</Button><Button variant="ghost" size="icon" onClick={() => { if (window.confirm(`Supprimer le compte ${account.code} ?`)) void run(async () => { await desktopApi.deleteAccount(account.id); const accountId = await loadBase(); await refreshReports(filter, accountId); }, 'Le compte inutilisé a été supprimé.'); }}><Archive size={15} /></Button></article>)}</div> : <EmptyState title="Plan comptable vide" text="Installez la base essentielle ou créez votre plan réel avant d’activer les écritures automatiques." />}</section><section className="panel settings-card settings-card--wide"><SectionHeading eyebrow="Automatisation" title="Comptes de liaison" description={mappingDescription} /><label className="module-toggle module-toggle--compact"><input type="checkbox" checked={settings.enabled} disabled={continuity.enabled && continuity.journalEntryCount > 0} onChange={(event) => setSettings((current) => ({ ...current, enabled: event.target.checked }))} /><span><Landmark size={19} /><strong>Comptabilité active</strong><small>{continuity.enabled && continuity.journalEntryCount > 0 ? 'Verrouillée après la première écriture pour préserver la continuité' : settings.enabled ? continuity.mappingReady ? 'Chaque opération financière produit son écriture' : 'Vérifiez et enregistrez tous les comptes de liaison requis' : 'Activez-la avant d’encaisser ou de payer un achat'}</small></span></label><div className="form-grid">{mappingFields.map(([key, label]) => <Field key={key} label={label} required={settings.enabled}><select value={String(settings[key])} onChange={(event) => setSettings((current) => ({ ...current, [key]: event.target.value }))} required={settings.enabled}><option value="">Choisir un compte</option>{activeAccounts.map((account) => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}</select></Field>)}</div><Button disabled={busy} onClick={() => void saveMapping()}>Enregistrer et vérifier la continuité</Button></section></div>
    </div> : null}

    {tab === 'periods' ? <AccountingPeriods periods={periods} busy={busy} onRefresh={async (message) => { await reloadAll(message); }} onError={setError} /> : null}
  </div>;
}

function JournalLinesEditor({ lines, accounts, workspace, onPatch, onAdd, onRemove }: { lines: JournalDraftLine[]; accounts: Account[]; workspace: Workspace; onPatch: (id: string, patch: Partial<JournalDraftLine>) => void; onAdd: () => void; onRemove: (id: string) => void }) {
  const terminology = projectTerminology(workspace.settings!.business.nogaSection);
  return <section className="journal-lines"><header><strong>Lignes de l’écriture</strong><Button type="button" variant="secondary" size="small" onClick={onAdd}><Plus size={14} /> Ajouter une ligne</Button></header>{lines.map((line) => <div key={line.id}><select value={line.accountId} onChange={(event) => onPatch(line.id, { accountId: event.target.value })} required><option value="">Compte</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}</select><input type="number" min="0" step="0.01" value={line.debitCents ? line.debitCents / 100 : ''} onChange={(event) => onPatch(line.id, { debitCents: Math.round((event.target.valueAsNumber || 0) * 100), creditCents: event.target.value ? 0 : line.creditCents })} placeholder="Débit CHF" /><input type="number" min="0" step="0.01" value={line.creditCents ? line.creditCents / 100 : ''} onChange={(event) => onPatch(line.id, { creditCents: Math.round((event.target.valueAsNumber || 0) * 100), debitCents: event.target.value ? 0 : line.debitCents })} placeholder="Crédit CHF" /><input value={line.memo} onChange={(event) => onPatch(line.id, { memo: event.target.value })} placeholder="Mémo" /><select value={line.projectId} onChange={(event) => onPatch(line.id, { projectId: event.target.value })}><option value="">Sans {terminology.singular}</option>{workspace.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select><select value={line.clientId} onChange={(event) => onPatch(line.id, { clientId: event.target.value })}><option value="">Sans client</option>{workspace.clients.map((client) => <option key={client.id} value={client.id}>{client.company || client.name}</option>)}</select><select value={line.employeeId} onChange={(event) => onPatch(line.id, { employeeId: event.target.value })}><option value="">Sans collaborateur</option>{workspace.employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}</select><Button type="button" variant="ghost" size="icon" onClick={() => onRemove(line.id)} disabled={lines.length <= 2}><Archive size={14} /></Button></div>)}</section>;
}

function JournalTable({ report, onReverse }: { report: JournalReport; onReverse: (entry: JournalEntry) => void }) {
  return <div className="journal-entry-list">{report.entries.map((entry) => { const alreadyReversed = entry.hasReversal; const canReverse = !alreadyReversed; return <article key={entry.id} data-journal-entry-id={entry.id} tabIndex={-1}><header><div><strong>{entry.number}</strong><span>{formatDate(entry.entryDate)}</span></div><p>{entry.description}</p><small>{entry.reversalOf ? 'Écriture d’extourne' : entry.sourceType === 'manual' ? 'Saisie manuelle' : `Origine : ${entry.sourceType} · toute extourne automatique restera signalée jusqu’à correction métier`}</small>{canReverse ? <Button variant="ghost" size="small" onClick={() => onReverse(entry)}><RotateCcw size={14} /> Extourner</Button> : <span className="locked-label"><CheckCircle2 size={13} /> Extournée</span>}</header><JournalLineTable lines={report.lines.filter((line) => line.journalEntryId === entry.id)} /></article>; })}</div>;
}

function JournalLineTable({ lines, showRunningBalance = false }: { lines: JournalReport['lines']; showRunningBalance?: boolean }) {
  return <div className="table-panel"><table><thead><tr><th>Date / pièce</th><th>Compte</th><th>Mémo</th><th>Débit</th><th>Crédit</th>{showRunningBalance ? <th>Solde cumulé</th> : null}</tr></thead><tbody>{lines.map((line) => <tr key={line.id}><td>{formatDate(line.entryDate)}<small>{line.entryNumber}</small></td><td><strong>{line.accountCode}</strong><small>{line.accountName}</small></td><td>{line.memo || '—'}</td><td>{line.debitCents ? formatMoney(line.debitCents) : '—'}</td><td>{line.creditCents ? formatMoney(line.creditCents) : '—'}</td>{showRunningBalance ? <td>{balanceSideLabel(line.runningDebitBalanceCents ?? 0, line.runningCreditBalanceCents ?? 0)}</td> : null}</tr>)}</tbody></table></div>;
}

function balanceSideLabel(debitCents: number, creditCents: number) {
  if (debitCents > 0) return `Débiteur · ${formatMoney(debitCents)}`;
  if (creditCents > 0) return `Créditeur · ${formatMoney(creditCents)}`;
  return `Soldé · ${formatMoney(0)}`;
}

function FinancialStatement({ title, state, rows, summary, comparisonLabel, previousHasActivity, currency, balanced }: { title: string; state: string; rows: StatementRow[]; summary: Array<[string, number | undefined, number | undefined]>; comparisonLabel?: string; previousHasActivity?: boolean; currency?: string; balanced?: boolean }) {
  return <section className="panel"><SectionHeading eyebrow={`${state} · ${currency || 'CHF'}`} title={title} description="Les valeurs de l’exercice précédent figurent en regard des valeurs courantes. Les agrégations multi-devises sans cours traçable sont bloquées." />{rows.length ? <><div className="summary-strip">{summary.map(([label, amount, previous]) => <div key={label}><span>{label}</span><strong>{formatMoney(amount)}</strong><small>{comparisonLabel || 'Exercice précédent'} · {formatMoney(previous)}</small></div>)}</div><div className="table-panel"><table><thead><tr><th>Compte</th><th>Rubrique</th><th>Exercice sous revue</th><th>{comparisonLabel || 'Exercice précédent'}</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td><strong>{row.code}</strong><small>{row.name}</small></td><td>{reportSections.find(([value]) => value === row.reportSection)?.[1] || row.reportSection}</td><td>{formatMoney(row.amountCents)}</td><td>{formatMoney(row.previousAmountCents)}</td></tr>)}</tbody></table></div>{previousHasActivity === false ? <div className="report-callout is-warning"><FileCheck2 size={20} /><div><strong>Comparatif sans mouvements</strong><p>Les colonnes précédentes restent visibles à zéro; aucune écriture n’a été trouvée dans l’exercice comparatif.</p></div></div> : null}{balanced !== undefined ? <div className={`report-callout ${balanced ? '' : 'is-warning'}`}><Scale size={20} /><div><strong>{balanced ? 'Bilan équilibré' : 'Bilan non équilibré'}</strong><p>{balanced ? 'Actifs = dettes + fonds propres + résultats antérieurs non affectés + résultat de l’exercice.' : 'Contrôlez le plan, les reports et les écritures avant clôture.'}</p></div></div> : null}</> : <EmptyState icon={<Landmark />} title={`${title} vide`} text="Aucune écriture ne permet encore de produire cet état." />}</section>;
}

function AccountingPeriods({ periods, busy, onRefresh, onError }: { periods: AccountingPeriod[]; busy: boolean; onRefresh: (message: string) => Promise<void>; onError: (message: string) => void }) {
  const [editing, setEditing] = useState<AccountingPeriod | null>(null);
  const [creating, setCreating] = useState(false);
  async function save(form: FormData) {
    try { await desktopApi.upsertAccountingPeriod({ id: editing?.id, name: String(form.get('name')), dateFrom: String(form.get('dateFrom')), dateTo: String(form.get('dateTo')) }); setEditing(null); setCreating(false); await onRefresh('La période comptable a été enregistrée.'); }
    catch (reason) { onError(errorMessage(reason, 'La période n’a pas pu être enregistrée.')); }
  }
  return <section className="panel"><SectionHeading eyebrow="Exercices et périodes" title="Clôtures comptables" description="Créez vos exercices ici. La pré-clôture contrôlée et le verrouillage définitif se font dans « Dossier de clôture »." action={<Button onClick={() => { setEditing(null); setCreating(true); }}><Plus size={15} /> Nouvelle période</Button>} />{creating || editing ? <form className="account-inline-form" onSubmit={submitForm(save)}><Field label="Nom" required><input name="name" defaultValue={editing?.name} required /></Field><Field label="Du" required><input name="dateFrom" type="date" defaultValue={editing?.dateFrom} required /></Field><Field label="Au" required><input name="dateTo" type="date" defaultValue={editing?.dateTo} required /></Field><div className="form-actions"><Button type="button" variant="secondary" onClick={() => { setCreating(false); setEditing(null); }}>Annuler</Button><Button type="submit" disabled={busy}>Enregistrer</Button></div></form> : null}{periods.length ? <div className="period-list">{periods.map((period) => <article key={period.id}><div><strong>{period.name}</strong><span>{formatDate(period.dateFrom)} → {formatDate(period.dateTo)}</span>{period.closedAt ? <small>Clôturé le {formatDate(period.closedAt)}</small> : <small>Préparez le contrôle depuis le dossier de clôture.</small>}</div><StatusBadge status={period.status === 'closed' ? 'validated' : 'in_progress'} />{period.status === 'open' ? <Button variant="ghost" size="small" onClick={() => setEditing(period)}>Modifier</Button> : <span className="locked-label"><LockKeyhole size={14} /> Verrouillée</span>}</article>)}</div> : <EmptyState title="Aucune période comptable" text="Créez un exercice ou une période réelle; aucun calendrier n’est prérempli." />}</section>;
}
