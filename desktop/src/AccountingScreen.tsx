import { useEffect, useState } from 'react';
import { Archive, BookOpen, CheckCircle2, Landmark, ListChecks, LockKeyhole, Plus, RefreshCw, RotateCcw, Scale, ShieldCheck, X } from 'lucide-react';
import { desktopApi } from './bridge';
import type { Account, AccountingPeriod, AccountingSettings, BalanceSheetReport, IncomeStatementReport, JournalEntry, JournalReport, LedgerReport, PeriodFilter, TrialBalanceReport, Workspace } from './types';
import { createId, formatDate, formatMoney, todayIso } from './utils';
import { Button, EmptyState, ErrorPanel, Field, SectionHeading, StatusBadge, submitForm } from './ui';
import { projectTerminology } from './terminology';

type Tab = 'journal' | 'ledger' | 'trial' | 'balance' | 'income' | 'accounts' | 'periods';
type JournalDraftLine = { id: string; accountId: string; debitCents: number; creditCents: number; memo: string; projectId: string; clientId: string; employeeId: string };

const emptyAccountingSettings: AccountingSettings = {
  enabled: false,
  arAccountId: '',
  revenueAccountId: '',
  vatPayableAccountId: '',
  bankAccountId: '',
  expenseAccountId: '',
  vatReceivableAccountId: '',
  wagesExpenseAccountId: '',
  wagesPayableAccountId: '',
  socialExpenseAccountId: '',
  socialPayableAccountId: '',
};

const mappingFields: Array<[keyof AccountingSettings, string]> = [
  ['arAccountId', 'Créances clients'],
  ['revenueAccountId', 'Produits de facturation'],
  ['vatPayableAccountId', 'TVA due'],
  ['bankAccountId', 'Banque'],
  ['expenseAccountId', 'Charges / dépenses'],
  ['vatReceivableAccountId', 'TVA préalable'],
  ['wagesExpenseAccountId', 'Charges de salaires'],
  ['wagesPayableAccountId', 'Salaires à payer'],
  ['socialExpenseAccountId', 'Charges sociales employeur'],
  ['socialPayableAccountId', 'Cotisations sociales à payer'],
];

const reportSections: Array<[Account['reportSection'], string]> = [
  ['current_assets', 'Actifs circulants'], ['fixed_assets', 'Actifs immobilisés'], ['short_term_liabilities', 'Dettes à court terme'], ['long_term_liabilities', 'Dettes à long terme'], ['equity', 'Fonds propres'], ['net_revenue', 'Chiffre d’affaires net'], ['cost_of_goods', 'Coût des marchandises / prestations'], ['personnel_expense', 'Charges de personnel'], ['other_operating_expense', 'Autres charges d’exploitation'], ['depreciation', 'Amortissements'], ['financial_result', 'Résultat financier'], ['non_operating_result', 'Résultat hors exploitation'], ['exceptional_result', 'Résultat exceptionnel'], ['taxes', 'Impôts'],
];

const newJournalLine = (): JournalDraftLine => ({ id: createId(), accountId: '', debitCents: 0, creditCents: 0, memo: '', projectId: '', clientId: '', employeeId: '' });

export function AccountingScreen({ workspace }: { workspace: Workspace }) {
  const [tab, setTab] = useState<Tab>('journal');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [settings, setSettings] = useState<AccountingSettings>(emptyAccountingSettings);
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

  const activeAccounts = accounts.filter((account) => account.active);
  const debit = entryLines.reduce((sum, line) => sum + line.debitCents, 0);
  const credit = entryLines.reduce((sum, line) => sum + line.creditCents, 0);
  const selectedPeriod = periods.find((period) => period.id === periodId);
  const reportState = selectedPeriod?.status === 'closed' ? 'Clôturé' : 'Provisoire';

  async function run(action: () => Promise<void>, success?: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try { await action(); if (success) setNotice(success); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'La commande comptable locale a échoué.'); }
    finally { setBusy(false); }
  }

  async function loadBase() {
    const [nextAccounts, nextSettings, nextPeriods] = await Promise.all([desktopApi.listAccounts(), desktopApi.getAccountingSettings(), desktopApi.listAccountingPeriods()]);
    setAccounts(nextAccounts);
    setSettings(nextSettings);
    setPeriods(nextPeriods);
    if (!selectedAccountId && nextAccounts.length) setSelectedAccountId(nextAccounts[0].id);
  }

  async function refreshReports() {
    const [nextJournal, nextTrial, nextBalance, nextIncome] = await Promise.all([
      desktopApi.getJournal(filter), desktopApi.getTrialBalance(filter), desktopApi.getBalanceSheet(filter.dateTo), desktopApi.getIncomeStatement(filter),
    ]);
    setJournal(nextJournal); setTrial(nextTrial); setBalance(nextBalance); setIncome(nextIncome);
    if (selectedAccountId) setLedger(await desktopApi.getLedger(selectedAccountId, filter));
  }

  useEffect(() => { void run(async () => { await loadBase(); await refreshReports(); }); }, []);

  async function reloadAll(success?: string) { await run(async () => { await loadBase(); await refreshReports(); }, success); }

  function choosePeriod(id: string) {
    setPeriodId(id);
    const period = periods.find((item) => item.id === id);
    setFilter(period ? { dateFrom: period.dateFrom, dateTo: period.dateTo } : {});
  }

  async function saveAccount(form: FormData) {
    const accountType = String(form.get('accountType')) as Account['accountType'];
    const normalBalance = String(form.get('normalBalance')) as Account['normalBalance'];
    await run(async () => {
      await desktopApi.upsertAccount({ id: accountDraft?.id, code: String(form.get('code')), name: String(form.get('name')), accountType, normalBalance, reportSection: String(form.get('reportSection')) as Account['reportSection'], active: form.get('active') === 'on' });
      setAccountDraft(null); await loadBase(); await refreshReports();
    }, 'Le compte a été enregistré.');
  }

  async function saveMapping() {
    if (settings.enabled && mappingFields.some(([key]) => !String(settings[key]))) { setError('Sélectionnez explicitement chacun des dix comptes de liaison avant l’activation.'); return; }
    await run(async () => { await desktopApi.configureAccounting(settings); await loadBase(); }, 'La configuration comptable a été enregistrée.');
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
    ['journal', 'Journal', <BookOpen size={16} />], ['ledger', 'Grand livre', <ListChecks size={16} />], ['trial', 'Balance', <Scale size={16} />], ['balance', 'Bilan', <Landmark size={16} />], ['income', 'Résultat', <CheckCircle2 size={16} />], ['accounts', 'Plan & liaisons', <ShieldCheck size={16} />], ['periods', 'Exercices', <LockKeyhole size={16} />],
  ];

  return <div className="stack-layout accounting-screen">
    <section className="accounting-toolbar panel"><div className="tab-strip">{tabs.map(([id, label, icon]) => <button key={id} className={tab === id ? 'is-active' : ''} onClick={() => setTab(id)}>{icon}{label}</button>)}</div><div className="accounting-filters"><select value={periodId} onChange={(event) => choosePeriod(event.target.value)}><option value="">Période libre</option>{periods.map((period) => <option key={period.id} value={period.id}>{period.name} · {period.status === 'closed' ? 'clôturé' : 'ouvert'}</option>)}</select><input type="date" value={filter.dateFrom ?? ''} onChange={(event) => { setPeriodId(''); setFilter((current) => ({ ...current, dateFrom: event.target.value || undefined })); }} aria-label="Du" /><input type="date" value={filter.dateTo ?? ''} onChange={(event) => { setPeriodId(''); setFilter((current) => ({ ...current, dateTo: event.target.value || undefined })); }} aria-label="Au" /><span className={`report-state ${reportState === 'Clôturé' ? 'is-closed' : ''}`}>{reportState}</span><Button variant="secondary" size="small" disabled={busy} onClick={() => void run(refreshReports, 'Les états ont été actualisés.')}><RefreshCw size={15} /> Actualiser</Button></div></section>
    {error ? <ErrorPanel message={error} /> : null}{notice ? <div className="notice notice--success"><span><CheckCircle2 size={18} />{notice}</span><button onClick={() => setNotice('')}><X size={15} /></button></div> : null}

    {tab === 'journal' ? <section className="panel"><SectionHeading eyebrow="Partie double" title="Journal chronologique" description="Chaque écriture validée est immuable et équilibrée; une correction passe par une extourne traçable." action={<Button disabled={!settings.enabled || busy} onClick={() => setEntryOpen((value) => !value)}><Plus size={15} /> Saisir une écriture</Button>} />{!settings.enabled ? <div className="warning-card"><ShieldCheck size={18} /><div><strong>Comptabilité non activée</strong><p>Créez le plan comptable et sélectionnez les dix comptes de liaison.</p></div></div> : null}{entryOpen ? <form className="accounting-entry-form" onSubmit={submitForm(postEntry)}><div className="form-grid"><Field label="Date" required><input name="entryDate" type="date" defaultValue={todayIso()} required /></Field><Field label="Description" required wide><input name="description" required /></Field></div><JournalLinesEditor lines={entryLines} accounts={activeAccounts} workspace={workspace} onPatch={patchLine} onAdd={() => setEntryLines((current) => [...current, newJournalLine()])} onRemove={(id) => setEntryLines((current) => current.length > 2 ? current.filter((line) => line.id !== id) : current)} /><div className={`entry-balance ${debit === credit && debit > 0 ? 'is-balanced' : ''}`}><span>Débits {formatMoney(debit)}</span><span>Crédits {formatMoney(credit)}</span><strong>{debit === credit && debit > 0 ? 'Équilibrée' : `Écart ${formatMoney(Math.abs(debit - credit))}`}</strong></div><div className="form-actions"><Button type="button" variant="secondary" onClick={() => setEntryOpen(false)}>Annuler</Button><Button type="submit" disabled={busy || debit <= 0 || debit !== credit}>Comptabiliser</Button></div></form> : null}{reversalTarget ? <form className="accounting-entry-form reversal-form" onSubmit={submitForm(reverseEntry)}><div><strong>Extourner {reversalTarget.number}</strong><p>L’écriture originale restera intacte. Une nouvelle écriture inverse sera créée et liée.</p></div><div className="form-grid"><Field label="Date de l’extourne" required><input name="entryDate" type="date" min={reversalTarget.entryDate} defaultValue={todayIso()} required /></Field><Field label="Description"><input name="description" placeholder={`Extourne ${reversalTarget.number}`} /></Field></div><div className="form-actions"><Button type="button" variant="secondary" onClick={() => setReversalTarget(null)}>Annuler</Button><Button type="submit" disabled={busy}><RotateCcw size={15} /> Créer l’extourne</Button></div></form> : null}{journal?.entries.length ? <JournalTable report={journal} onReverse={setReversalTarget} /> : <EmptyState icon={<BookOpen />} title="Journal vide" text="Aucune écriture réelle n’a encore été comptabilisée pour cette période." />}</section> : null}

    {tab === 'ledger' ? <section className="panel"><SectionHeading eyebrow="Mouvements par compte" title="Grand livre" /><div className="ledger-picker"><Field label="Compte"><select value={selectedAccountId} onChange={(event) => { const id = event.target.value; setSelectedAccountId(id); if (id) void run(async () => setLedger(await desktopApi.getLedger(id, filter))); }}><option value="">Choisir un compte</option>{accounts.map((account) => <option value={account.id} key={account.id}>{account.code} · {account.name}</option>)}</select></Field></div>{ledger?.lines.length ? <><div className="summary-strip"><div><span>Débit</span><strong>{formatMoney(ledger.debitCents)}</strong></div><div><span>Crédit</span><strong>{formatMoney(ledger.creditCents)}</strong></div><div><span>Solde débiteur net</span><strong>{formatMoney(ledger.netDebitCents)}</strong></div></div><JournalLineTable lines={ledger.lines} /></> : <EmptyState icon={<ListChecks />} title="Aucun mouvement" text={selectedAccountId ? 'Ce compte ne présente aucun mouvement pour la période.' : 'Choisissez un compte du plan comptable.'} />}</section> : null}

    {tab === 'trial' ? <section className="panel"><SectionHeading eyebrow={reportState} title="Balance des comptes" description="Les totaux débit et crédit doivent être égaux." />{trial?.rows.length ? <div className="table-panel"><table><thead><tr><th>Compte</th><th>Débit mouvement</th><th>Crédit mouvement</th><th>Solde débiteur</th><th>Solde créditeur</th></tr></thead><tbody>{trial.rows.map((row) => <tr key={row.id}><td><strong>{row.code}</strong><small>{row.name}</small></td><td>{formatMoney(row.debitCents)}</td><td>{formatMoney(row.creditCents)}</td><td>{formatMoney(row.debitBalanceCents)}</td><td>{formatMoney(row.creditBalanceCents)}</td></tr>)}</tbody><tfoot><tr><th>Totaux</th><th>{formatMoney(trial.debitCents)}</th><th>{formatMoney(trial.creditCents)}</th><th colSpan={2}>{trial.balanced ? 'Balance équilibrée' : 'Écart à contrôler'}</th></tr></tfoot></table></div> : <EmptyState icon={<Scale />} title="Balance vide" text="Aucune écriture ne contribue à la période sélectionnée." />}</section> : null}

    {tab === 'balance' ? <FinancialStatement title="Bilan" state={reportState} rows={balance?.rows ?? []} summary={[['Actifs', balance?.assetsCents], ['Passifs', balance?.liabilitiesCents], ['Fonds propres', balance?.equityCents], ['Résultat courant', balance?.currentResultCents]]} balanced={balance?.balanced} /> : null}
    {tab === 'income' ? <FinancialStatement title="Compte de résultat" state={reportState} rows={income?.rows ?? []} summary={[['Produits', income?.revenueCents], ['Charges', income?.expenseCents], ['Résultat', income?.profitCents]]} /> : null}

    {tab === 'accounts' ? <div className="settings-layout"><section className="panel settings-card settings-card--wide"><SectionHeading eyebrow="Plan comptable" title="Comptes" description="Aucun compte n’est créé automatiquement." action={<Button onClick={() => setAccountDraft({ code: '', name: '' })}><Plus size={15} /> Nouveau compte</Button>} />{accountDraft ? <form className="account-inline-form" onSubmit={submitForm(saveAccount)}><Field label="Code" required><input name="code" defaultValue={accountDraft.code} required /></Field><Field label="Nom" required><input name="name" defaultValue={accountDraft.name} required /></Field><Field label="Type" required><select name="accountType" defaultValue={accountDraft.accountType ?? ''} required><option value="">Choisir</option><option value="asset">Actif</option><option value="liability">Passif</option><option value="equity">Fonds propres</option><option value="revenue">Produit</option><option value="expense">Charge</option></select></Field><Field label="Rubrique des états" required><select name="reportSection" defaultValue={accountDraft.reportSection ?? ''} required><option value="">Choisir</option>{reportSections.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><Field label="Solde normal" required><select name="normalBalance" defaultValue={accountDraft.normalBalance ?? ''} required><option value="">Choisir</option><option value="debit">Débit</option><option value="credit">Crédit</option></select></Field><label className="check-card"><input name="active" type="checkbox" defaultChecked={accountDraft.active ?? true} /><span><strong>Compte actif</strong></span></label><div className="form-actions"><Button type="button" variant="secondary" onClick={() => setAccountDraft(null)}>Annuler</Button><Button type="submit" disabled={busy}>Enregistrer</Button></div></form> : null}{accounts.length ? <div className="account-list">{accounts.map((account) => <article key={account.id}><div><strong>{account.code}</strong><span>{account.name}</span><small>{reportSections.find(([value]) => value === account.reportSection)?.[1] || account.reportSection} · solde {account.normalBalance}</small></div><StatusBadge status={account.active ? 'validated' : 'incomplete'} /><Button variant="ghost" size="small" onClick={() => setAccountDraft(account)}>Modifier</Button><Button variant="ghost" size="icon" onClick={() => { if (window.confirm(`Supprimer le compte ${account.code} ?`)) void run(async () => { await desktopApi.deleteAccount(account.id); await loadBase(); }, 'Le compte inutilisé a été supprimé.'); }}><Archive size={15} /></Button></article>)}</div> : <EmptyState title="Plan comptable vide" text="Créez vos comptes réels avant d’activer les écritures automatiques." />}</section><section className="panel settings-card settings-card--wide"><SectionHeading eyebrow="Automatisation" title="Comptes de liaison" description="Les dix liaisons sont obligatoires pour activer la comptabilité." /><label className="module-toggle module-toggle--compact"><input type="checkbox" checked={settings.enabled} onChange={(event) => setSettings((current) => ({ ...current, enabled: event.target.checked }))} /><span><Landmark size={19} /><strong>Comptabilité active</strong><small>{settings.enabled ? 'Les opérations seront comptabilisées' : 'Aucune écriture automatique'}</small></span></label><div className="form-grid">{mappingFields.map(([key, label]) => <Field key={key} label={label} required={settings.enabled}><select value={String(settings[key])} onChange={(event) => setSettings((current) => ({ ...current, [key]: event.target.value }))} required={settings.enabled}><option value="">Choisir un compte</option>{activeAccounts.map((account) => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}</select></Field>)}</div><Button disabled={busy} onClick={() => void saveMapping()}>Enregistrer les liaisons</Button></section></div> : null}

    {tab === 'periods' ? <AccountingPeriods periods={periods} busy={busy} onRefresh={async (message) => { await reloadAll(message); }} onError={setError} /> : null}
  </div>;
}

function JournalLinesEditor({ lines, accounts, workspace, onPatch, onAdd, onRemove }: { lines: JournalDraftLine[]; accounts: Account[]; workspace: Workspace; onPatch: (id: string, patch: Partial<JournalDraftLine>) => void; onAdd: () => void; onRemove: (id: string) => void }) {
  const terminology = projectTerminology(workspace.settings!.business.nogaSection);
  return <section className="journal-lines"><header><strong>Lignes de l’écriture</strong><Button type="button" variant="secondary" size="small" onClick={onAdd}><Plus size={14} /> Ajouter une ligne</Button></header>{lines.map((line) => <div key={line.id}><select value={line.accountId} onChange={(event) => onPatch(line.id, { accountId: event.target.value })} required><option value="">Compte</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}</select><input type="number" min="0" step="0.01" value={line.debitCents ? line.debitCents / 100 : ''} onChange={(event) => onPatch(line.id, { debitCents: Math.round((event.target.valueAsNumber || 0) * 100), creditCents: event.target.value ? 0 : line.creditCents })} placeholder="Débit CHF" /><input type="number" min="0" step="0.01" value={line.creditCents ? line.creditCents / 100 : ''} onChange={(event) => onPatch(line.id, { creditCents: Math.round((event.target.valueAsNumber || 0) * 100), debitCents: event.target.value ? 0 : line.debitCents })} placeholder="Crédit CHF" /><input value={line.memo} onChange={(event) => onPatch(line.id, { memo: event.target.value })} placeholder="Mémo" /><select value={line.projectId} onChange={(event) => onPatch(line.id, { projectId: event.target.value })}><option value="">Sans {terminology.singular}</option>{workspace.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select><select value={line.clientId} onChange={(event) => onPatch(line.id, { clientId: event.target.value })}><option value="">Sans client</option>{workspace.clients.map((client) => <option key={client.id} value={client.id}>{client.company || client.name}</option>)}</select><select value={line.employeeId} onChange={(event) => onPatch(line.id, { employeeId: event.target.value })}><option value="">Sans collaborateur</option>{workspace.employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}</select><Button type="button" variant="ghost" size="icon" onClick={() => onRemove(line.id)} disabled={lines.length <= 2}><Archive size={14} /></Button></div>)}</section>;
}

function JournalTable({ report, onReverse }: { report: JournalReport; onReverse: (entry: JournalEntry) => void }) {
  return <div className="journal-entry-list">{report.entries.map((entry) => { const alreadyReversed = report.entries.some((candidate) => candidate.reversalOf === entry.id); return <article key={entry.id}><header><div><strong>{entry.number}</strong><span>{formatDate(entry.entryDate)}</span></div><p>{entry.description}</p><small>{entry.reversalOf ? 'Écriture d’extourne' : entry.sourceType === 'manual' ? 'Saisie manuelle' : `Origine : ${entry.sourceType}`}</small>{!entry.reversalOf && !alreadyReversed ? <Button variant="ghost" size="small" onClick={() => onReverse(entry)}><RotateCcw size={14} /> Extourner</Button> : alreadyReversed ? <span className="locked-label"><CheckCircle2 size={13} /> Extournée</span> : null}</header><JournalLineTable lines={report.lines.filter((line) => line.journalEntryId === entry.id)} /></article>; })}</div>;
}

function JournalLineTable({ lines }: { lines: JournalReport['lines'] }) {
  return <div className="table-panel"><table><thead><tr><th>Date / pièce</th><th>Compte</th><th>Mémo</th><th>Débit</th><th>Crédit</th></tr></thead><tbody>{lines.map((line) => <tr key={line.id}><td>{formatDate(line.entryDate)}<small>{line.entryNumber}</small></td><td><strong>{line.accountCode}</strong><small>{line.accountName}</small></td><td>{line.memo || '—'}</td><td>{line.debitCents ? formatMoney(line.debitCents) : '—'}</td><td>{line.creditCents ? formatMoney(line.creditCents) : '—'}</td></tr>)}</tbody></table></div>;
}

function FinancialStatement({ title, state, rows, summary, balanced }: { title: string; state: string; rows: Array<{ id: string; code: string; name: string; accountType: string; reportSection: Account['reportSection']; debitCents: number; creditCents: number }>; summary: Array<[string, number | undefined]>; balanced?: boolean }) {
  return <section className="panel"><SectionHeading eyebrow={state} title={title} description="État calculé uniquement à partir des écritures comptabilisées, selon la rubrique de chaque compte." />{rows.length ? <><div className="summary-strip">{summary.map(([label, amount]) => <div key={label}><span>{label}</span><strong>{formatMoney(amount)}</strong></div>)}</div><div className="table-panel"><table><thead><tr><th>Compte</th><th>Rubrique</th><th>Débit</th><th>Crédit</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td><strong>{row.code}</strong><small>{row.name}</small></td><td>{reportSections.find(([value]) => value === row.reportSection)?.[1] || row.reportSection}</td><td>{formatMoney(row.debitCents)}</td><td>{formatMoney(row.creditCents)}</td></tr>)}</tbody></table></div>{balanced !== undefined ? <div className={`report-callout ${balanced ? '' : 'is-warning'}`}><Scale size={20} /><div><strong>{balanced ? 'Bilan équilibré' : 'Bilan non équilibré'}</strong><p>{balanced ? 'Actifs = passifs + fonds propres + résultat.' : 'Contrôlez le plan et les écritures avant clôture.'}</p></div></div> : null}</> : <EmptyState icon={<Landmark />} title={`${title} vide`} text="Aucune écriture ne permet encore de produire cet état." />}</section>;
}

function AccountingPeriods({ periods, busy, onRefresh, onError }: { periods: AccountingPeriod[]; busy: boolean; onRefresh: (message: string) => Promise<void>; onError: (message: string) => void }) {
  const [editing, setEditing] = useState<AccountingPeriod | null>(null);
  const [creating, setCreating] = useState(false);
  async function save(form: FormData) {
    try { await desktopApi.upsertAccountingPeriod({ id: editing?.id, name: String(form.get('name')), dateFrom: String(form.get('dateFrom')), dateTo: String(form.get('dateTo')) }); setEditing(null); setCreating(false); await onRefresh('La période comptable a été enregistrée.'); }
    catch (reason) { onError(reason instanceof Error ? reason.message : 'La période n’a pas pu être enregistrée.'); }
  }
  return <section className="panel"><SectionHeading eyebrow="Exercices et périodes" title="Clôtures comptables" description="Une période clôturée ne peut pas être rouverte et bloque toute nouvelle écriture dans ses dates." action={<Button onClick={() => { setEditing(null); setCreating(true); }}><Plus size={15} /> Nouvelle période</Button>} />{creating || editing ? <form className="account-inline-form" onSubmit={submitForm(save)}><Field label="Nom" required><input name="name" defaultValue={editing?.name} required /></Field><Field label="Du" required><input name="dateFrom" type="date" defaultValue={editing?.dateFrom} required /></Field><Field label="Au" required><input name="dateTo" type="date" defaultValue={editing?.dateTo} required /></Field><div className="form-actions"><Button type="button" variant="secondary" onClick={() => { setCreating(false); setEditing(null); }}>Annuler</Button><Button type="submit" disabled={busy}>Enregistrer</Button></div></form> : null}{periods.length ? <div className="period-list">{periods.map((period) => <article key={period.id}><div><strong>{period.name}</strong><span>{formatDate(period.dateFrom)} → {formatDate(period.dateTo)}</span>{period.closedAt ? <small>Clôturé le {formatDate(period.closedAt)}</small> : null}</div><StatusBadge status={period.status === 'closed' ? 'validated' : 'in_progress'} />{period.status === 'open' ? <><Button variant="ghost" size="small" onClick={() => setEditing(period)}>Modifier</Button><Button variant="secondary" size="small" onClick={() => { if (!window.confirm(`Clôturer définitivement « ${period.name} » ? Aucune écriture ne pourra ensuite être ajoutée dans cette période.`)) return; void (async () => { try { await desktopApi.closeAccountingPeriod(period.id); await onRefresh('La période a été clôturée définitivement.'); } catch (reason) { onError(reason instanceof Error ? reason.message : 'La clôture a échoué.'); } })(); }}><LockKeyhole size={14} /> Clôturer</Button></> : <span className="locked-label"><LockKeyhole size={14} /> Verrouillée</span>}</article>)}</div> : <EmptyState title="Aucune période comptable" text="Créez un exercice ou une période réelle; aucun calendrier n’est prérempli." />}</section>;
}
