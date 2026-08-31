import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { convertFileSrc } from '@tauri-apps/api/core';
import {
  Archive,
  ArrowRight,
  Banknote,
  BarChart3,
  BookOpen,
  BriefcaseBusiness,
  Building2,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  CircleDollarSign,
  Clock3,
  Database,
  Download,
  FileCheck2,
  FileText,
  FolderKanban,
  FolderOpen,
  HardHat,
  Home,
  CircleHelp,
  LayoutDashboard,
  Landmark,
  ListChecks,
  LoaderCircle,
  LockKeyhole,
  Menu,
  MessageSquareWarning,
  MoreHorizontal,
  Package,
  Pause,
  Pencil,
  Play,
  Plus,
  Printer,
  Receipt,
  RefreshCw,
  Search,
  Scale,
  ScanLine,
  Send,
  Settings,
  ShieldCheck,
  TimerReset,
  TrendingUp,
  UserRound,
  Users,
  WalletCards,
  X,
} from 'lucide-react';
import { desktopApi } from './bridge';
import { BrandMark } from './BrandMark';
import { AccountingScreen } from './AccountingScreen';
import { AppUpdater } from './AppUpdater';
import { BusinessProfileFields } from './BusinessProfileEditor';
import { RemindersScreen } from './RemindersScreen';
import { PayrollContributionsPanel } from './PayrollContributionsPanel';
import { SwissPayrollRulesPanel } from './SwissPayrollRulesPanel';
import { DocumentEditor } from './DocumentEditor';
import { CatalogItemForm, CatalogScreen } from './CatalogScreen';
import { ExpenseForm, PurchasesScreen, SupplierForm } from './PurchasesScreen';
import { DetailedPayslipForm } from './DetailedPayslipForm';
import { GuidedTour, useGuidedTour, type TourView } from './GuidedTour';
import { PayrollImportWizard } from './PayrollImportWizard';
import type {
  Account,
  AccountingPeriod,
  AccountingSettings,
  AppSettings,
  BalanceSheetReport,
  Client,
  CatalogItem,
  DocumentLine,
  Employee,
  EntityKind,
  Expense,
  FrozenCustomer,
  FrozenIssuer,
  Invoice,
  IncomeStatementReport,
  JournalReport,
  LedgerReport,
  Payment,
  Payslip,
  PayslipContributionSnapshot,
  PayslipLine,
  PayrollCalculation,
  PayrollContributionDefinition,
  PayrollContributionSelection,
  PeriodFilter,
  Project,
  Quote,
  Reminder,
  ReminderHistory,
  ReminderSettings,
  ReminderTemplate,
  StoredSwissQrBill,
  Supplier,
  SwissQrBillInput,
  SwissQrPayload,
  TimeEntry,
  TrialBalanceReport,
  Workspace,
} from './types';
import {
  addDaysIso,
  centsFromInput,
  createId,
  documentTotals,
  documentLineTotals,
  errorMessage,
  formatDate,
  formatDateTime,
  formatMinutes,
  formatMoney,
  formatTimer,
  invoiceCredited,
  invoiceOpenBalance,
  invoicePaid,
  numberFromInput,
  payslipTotals,
  projectFinancials,
  searchText,
  todayIso,
} from './utils';
import { Button, EmptyState, ErrorPanel, Field, FormActions, Modal, SectionHeading, StatusBadge, submitForm } from './ui';
import { projectTerminology } from './terminology';
import { creationBlockReason, timerBlockReason, type WorkspacePrerequisites } from './workflowGuards';

type View = TourView;
type ModalState =
  | { type: 'client'; item?: Client }
  | { type: 'catalogItem'; item?: CatalogItem }
  | { type: 'supplier'; item?: Supplier }
  | { type: 'project'; item?: Project }
  | { type: 'document'; entity: 'quotes' | 'invoices'; item?: Quote | Invoice; quoteSource?: Quote }
  | { type: 'time'; item?: TimeEntry }
  | { type: 'employee'; item?: Employee }
  | { type: 'expense'; item?: Expense }
  | { type: 'payslip'; item?: Payslip }
  | { type: 'payrollImport' }
  | { type: 'payslipPayment'; payslip: Payslip }
  | { type: 'payment'; invoice: Invoice }
  | { type: 'qrPrint'; invoice: Invoice }
  | { type: 'timer' }
  | null;

type PrintTarget = { entity: 'quotes'; value: Quote } | { entity: 'invoices'; value: Invoice; qr?: StoredSwissQrBill } | { entity: 'payslips'; value: Payslip } | null;
type Notice = { tone: 'success' | 'warning' | 'error'; text: string };

const navigation: Array<{ id: View; label: string; icon: typeof LayoutDashboard; group?: string }> = [
  { id: 'dashboard', label: 'Tableau de bord', icon: LayoutDashboard },
  { id: 'projects', label: 'Chantiers / projets', icon: FolderKanban },
  { id: 'clients', label: 'Clients', icon: UserRound },
  { id: 'catalog', label: 'Produits & services', icon: Package },
  { id: 'quotes', label: 'Devis', icon: FileCheck2, group: 'Gestion' },
  { id: 'invoices', label: 'Factures', icon: Receipt },
  { id: 'reminders', label: 'Relances', icon: MessageSquareWarning },
  { id: 'time', label: 'Temps', icon: Clock3 },
  { id: 'team', label: 'Équipe & salaires', icon: Users },
  { id: 'expenses', label: 'Achats & fournisseurs', icon: WalletCards },
  { id: 'reports', label: 'Rapports', icon: BarChart3, group: 'Pilotage' },
  { id: 'accounting', label: 'Comptabilité', icon: Landmark },
  { id: 'settings', label: 'Paramètres', icon: Settings },
];

const viewTitles: Record<View, [string, string]> = {
  dashboard: ['Tableau de bord', 'Votre activité réelle, sans données de démonstration'],
  projects: ['Chantiers', 'Budget, durée, temps et rentabilité par chantier'],
  clients: ['Clients', 'Coordonnées et historique des travaux'],
  catalog: ['Produits & services', 'Références réutilisables pour vos devis et factures'],
  quotes: ['Devis', 'Offres, lignes détaillées et conversion en facture'],
  invoices: ['Factures', 'Émission, encaissements et soldes ouverts'],
  reminders: ['Relances', 'Échéances, niveaux et historique des actions locales'],
  time: ['Temps', 'Pointage réel et heures par chantier'],
  team: ['Équipe & salaires', 'Collaborateurs et fiches sans retenue estimée'],
  expenses: ['Achats & fournisseurs', 'Échéances, dépenses payées et annuaire local'],
  reports: ['Rapports', 'Rentabilité calculée à partir de vos saisies'],
  accounting: ['Comptabilité', 'Partie double, journaux et états financiers locaux'],
  settings: ['Paramètres', 'Entreprise, confidentialité et portabilité'],
};

export function WorkspaceApp({ workspace, setWorkspace, readOnly = false }: { workspace: Workspace; setWorkspace: Dispatch<SetStateAction<Workspace | null>>; readOnly?: boolean }) {
  const [view, setView] = useState<View>('dashboard');
  const [modal, setModal] = useState<ModalState>(null);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [timerSeconds, setTimerSeconds] = useState(0);
  const [printTarget, setPrintTarget] = useState<PrintTarget>(null);
  const reminderScanStarted = useRef(false);
  const guidedTour = useGuidedTour();
  const navigateTour = useCallback((nextView: TourView) => { setView(nextView); setSearch(''); setMenuOpen(false); }, []);
  const settings = workspace.settings!;
  const terminology = projectTerminology(settings.business.nogaSection);

  useEffect(() => {
    if (!workspace.activeTimer) { setTimerSeconds(0); return; }
    const update = () => setTimerSeconds(Math.max(0, Math.floor((Date.now() - new Date(workspace.activeTimer!.startedAt).getTime()) / 1000)));
    update();
    const interval = window.setInterval(update, 1000);
    return () => window.clearInterval(interval);
  }, [workspace.activeTimer]);

  useEffect(() => {
    if (readOnly) return;
    if (reminderScanStarted.current) return;
    reminderScanStarted.current = true;
    let active = true;
    void desktopApi.getReminderSettings().then(async (reminderSettings) => {
      if (reminderSettings.enabled) await desktopApi.generateDueReminders(todayIso());
    }).catch((reason) => {
      if (active) setNotice({ tone: 'error', text: errorMessage(reason, 'Le contrôle automatique local des échéances a échoué.') });
    });
    return () => { active = false; };
  }, [readOnly]);

  async function act(action: () => Promise<Workspace>, message: string, close = true) {
    if (readOnly) {
      setNotice({ tone: 'error', text: 'La licence doit être active pour modifier les données. Lecture, sauvegarde et export restent disponibles.' });
      return false;
    }
    setBusy(true);
    setNotice(null);
    try {
      setWorkspace(await action());
      setNotice({ tone: 'success', text: message });
      if (close) setModal(null);
      return true;
    } catch (reason) {
      setNotice({ tone: 'error', text: errorMessage(reason, 'L’action locale a échoué.') });
      return false;
    } finally {
      setBusy(false);
    }
  }

  function issueInvoice(item: Invoice) {
    const capacityError = item.type === 'credit_note' ? null : invoicePrintCapacityError(item);
    if (capacityError) {
      setNotice({ tone: 'error', text: capacityError });
      return;
    }
    if (!window.confirm('Émettre cette facture maintenant ? Le numéro, les lignes, le client, les dates et les montants seront figés. Toute correction ultérieure devra passer par un avoir et une nouvelle facture.')) return;
    void act(() => desktopApi.issueDocument('invoices', item.id, item.issueDate, item.dueDate), 'La facture a été émise, numérotée et verrouillée.', false);
  }

  async function convertAcceptedQuote(item: Quote) {
    const converted = await act(
      () => desktopApi.convertQuote(item),
      'La facture brouillon unique a été créée. Complétez ses dates de prestation puis contrôlez-la avant émission.',
      false,
    );
    if (converted) {
      setView('invoices');
      setSearch('');
      setMenuOpen(false);
    }
  }

  async function postPayslip(item: Payslip) {
    if (readOnly) {
      setNotice({ tone: 'error', text: 'La licence doit être active pour modifier les données. Lecture, sauvegarde et export restent disponibles.' });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const result = await desktopApi.postPayslip(item.id);
      setWorkspace(result.workspace);
      if (result.accountingFallbacks.length) {
        const details = result.accountingFallbacks.map((fallback) => {
          const accountKind = fallback.field === 'expense_account_id' ? 'charge' : 'dette';
          return `${fallback.contribution || 'Cotisation'} : compte de ${accountKind} général ${fallback.accountId}`;
        }).join(' · ');
        setNotice({
          tone: 'warning',
          text: `La fiche a été comptabilisée et verrouillée, mais ${result.accountingFallbacks.length} compte${result.accountingFallbacks.length > 1 ? 's' : ''} non figé${result.accountingFallbacks.length > 1 ? 's ont' : ' a'} été remplacé${result.accountingFallbacks.length > 1 ? 's' : ''} par ${result.accountingFallbacks.length > 1 ? 'des comptes généraux' : 'un compte général'} : ${details}. Vérifiez l’écriture comptable.`,
        });
      } else {
        setNotice({ tone: 'success', text: 'La fiche a été comptabilisée et verrouillée.' });
      }
    } catch (reason) {
      setNotice({ tone: 'error', text: errorMessage(reason, 'La comptabilisation locale de la fiche a échoué.') });
    } finally {
      setBusy(false);
    }
  }

  async function archive(entity: EntityKind, id: string, label: string) {
    if (!window.confirm(`Supprimer « ${label} » de l’espace local ? Cette action ne peut pas être annulée.`)) return;
    await act(() => desktopApi.archiveEntity(entity, id), `${label} a été supprimé.`, false);
  }

  async function archiveCatalogItem(item: CatalogItem) {
    if (!window.confirm(`Archiver « ${item.name} » ? La référence restera dans l’historique, mais ne sera plus proposée dans les nouveaux documents.`)) return;
    await act(() => desktopApi.archiveEntity('catalogItems', item.id), `${item.name} a été archivé.`, false);
  }

  async function restoreCatalogItem(item: CatalogItem) {
    await act(() => desktopApi.updateEntity('catalogItems', item.id, { archivedAt: null }), `${item.name} est de nouveau disponible.`, false);
  }

  async function archiveSupplier(item: Supplier) {
    if (!window.confirm(`Archiver « ${item.name} » ? Le fournisseur restera visible dans l’historique, mais ne sera plus proposé dans les nouveaux achats.`)) return;
    await act(() => desktopApi.archiveEntity('suppliers', item.id), `${item.name} a été archivé.`, false);
  }

  async function restoreSupplier(item: Supplier) {
    await act(() => desktopApi.updateEntity('suppliers', item.id, { archivedAt: null }), `${item.name} est de nouveau disponible.`, false);
  }

  async function markExpensePaid(item: Expense) {
    const paidAt = todayIso();
    if (!window.confirm(`Marquer l’achat « ${item.supplier || item.reference} » payé le ${formatDate(paidAt)} ? Si la comptabilité est activée, l’écriture correspondante sera créée et deviendra immuable.`)) return;
    await act(
      () => desktopApi.updateEntity('expenses', item.id, { paymentStatus: 'paid', paidAt }),
      'L’achat est marqué payé. Elyko crée l’écriture correspondante uniquement lorsque la comptabilité locale est activée.',
      false,
    );
  }

  const overdue = workspace.invoices.filter((invoice) => invoice.type !== 'credit_note' && ['issued', 'partially_paid'].includes(invoice.status) && invoice.dueDate && invoice.dueDate < todayIso());
  const title: [string, string] = view === 'projects'
    ? [terminology.pluralTitle, `Budget, durée, temps et rentabilité par ${terminology.singular}`]
    : view === 'time'
      ? viewTitles.time.map((value, index) => index ? `Pointage réel et heures par ${terminology.singular}` : value) as [string, string]
      : viewTitles[view];
  const timerProject = workspace.projects.find((project) => project.id === workspace.activeTimer?.projectId);
  const timerEmployee = workspace.employees.find((employee) => employee.id === workspace.activeTimer?.employeeId);
  const searchableView = ['projects', 'clients', 'catalog', 'quotes', 'invoices', 'time', 'team', 'expenses'].includes(view);
  const prerequisites: WorkspacePrerequisites = {
    clients: workspace.clients.length,
    projects: workspace.projects.length,
    trackableProjects: workspace.projects.filter((project) => project.status !== 'closed').length,
    activeEmployees: workspace.employees.filter((employee) => employee.active).length,
    costCategories: settings.work.costCategories.length,
  };
  const dashboardTimerBlock = timerBlockReason(prerequisites, Boolean(workspace.activeTimer));

  return (
    <div className="desktop-app">
      <aside className={`sidebar ${menuOpen ? 'is-open' : ''}`}>
        <div className="sidebar__brand"><BrandMark size={36} /><div><strong>Elyko</strong><small>Gestion locale</small></div><Button variant="ghost" size="icon" className="sidebar__close" onClick={() => setMenuOpen(false)}><X size={18} /></Button></div>
        <nav className="sidebar__nav">
          {navigation.map((item, index) => { const Icon = item.id === 'projects' && terminology.icon === 'hard-hat' ? HardHat : item.icon; const label = item.id === 'projects' ? `${terminology.moduleLabel} · ${terminology.pluralTitle}` : item.label; return <div key={item.id}>{item.group ? <p>{item.group}</p> : null}<button aria-current={view === item.id ? 'page' : undefined} className={view === item.id ? 'is-active' : ''} onClick={() => { setView(item.id); setSearch(''); setMenuOpen(false); }}><Icon size={17} /><span>{label}</span>{item.id === 'invoices' && overdue.length ? <em>{overdue.length}</em> : null}</button>{index === 2 ? <div className="sidebar__divider" /> : null}</div>; })}
        </nav>
        <div className="sidebar__local"><ShieldCheck size={17} /><div><strong>Données locales</strong><span>Sur cet ordinateur</span></div><i /></div>
      </aside>

      <main className="app-main">
        <header className="topbar">
          <div className="topbar__title"><Button variant="ghost" size="icon" className="menu-button" onClick={() => setMenuOpen(true)}><Menu size={20} /></Button><div><p>Elyko local</p><h1>{title[0]}</h1></div></div>
          <div className="topbar__tools">{searchableView ? <label className="global-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Rechercher dans cette vue" /></label> : null}<Button type="button" variant="ghost" size="small" className="tour-launcher" onClick={guidedTour.start}><CircleHelp size={16} /> Guide</Button><div className="company-avatar">{settings.organization.legalName.slice(0, 2).toUpperCase()}</div></div>
        </header>

        {workspace.activeTimer ? <div className="timer-ribbon"><span className="timer-ribbon__pulse" /><div><strong>Pointage en cours · {formatTimer(timerSeconds)}</strong><small>{timerProject?.name ?? terminology.singularTitle}{timerEmployee ? ` · ${timerEmployee.name}` : ''}</small></div><Button variant="dark" size="small" disabled={busy} onClick={() => void act(() => desktopApi.stopTimer(), 'Le pointage a été arrêté et enregistré.', false)}><Pause size={15} /> Arrêter</Button></div> : null}

        <div className="page-header"><div>{view === 'projects' ? <small className="module-kicker">Module Chantiers / projets</small> : null}<p>{title[1]}</p></div><div className="page-header__actions">{view === 'dashboard' ? <Button variant="secondary" disabled={Boolean(dashboardTimerBlock)} title={dashboardTimerBlock || 'Démarrer un pointage réel'} onClick={() => setModal({ type: 'timer' })}><Play size={16} /> Démarrer un pointage</Button> : null}{view !== 'settings' && view !== 'reports' && view !== 'dashboard' ? <CreateButton view={view} onClick={setModal} terminology={terminology} prerequisites={prerequisites} /> : null}</div></div>
        {notice ? <div className={`notice notice--${notice.tone} ${modal ? 'notice--floating' : ''}`} role={notice.tone === 'error' ? 'alert' : 'status'} aria-live={notice.tone === 'error' ? 'assertive' : 'polite'}><span>{notice.tone === 'success' ? <CheckCircle2 size={18} /> : notice.tone === 'warning' ? <MessageSquareWarning size={18} /> : <ShieldCheck size={18} />}{notice.text}</span><button type="button" onClick={() => setNotice(null)} aria-label="Fermer le message"><X size={15} /></button></div> : null}

        <section className="page-content" key={view}>
          {view === 'dashboard' ? <Dashboard workspace={workspace} onNavigate={setView} onCreate={setModal} /> : null}
          {view === 'projects' ? <ProjectsScreen workspace={workspace} query={search} onEdit={(item) => setModal({ type: 'project', item })} onCreate={() => setModal({ type: 'project' })} onArchive={(item) => void archive('projects', item.id, item.name)} /> : null}
          {view === 'clients' ? <ClientsScreen workspace={workspace} query={search} onEdit={(item) => setModal({ type: 'client', item })} onCreate={() => setModal({ type: 'client' })} onArchive={(item) => void archive('clients', item.id, item.company || item.name)} /> : null}
          {view === 'catalog' ? <CatalogScreen items={workspace.catalogItems} query={search} onQueryChange={setSearch} onCreate={() => setModal({ type: 'catalogItem' })} onEdit={(item) => setModal({ type: 'catalogItem', item })} onArchive={(item) => void archiveCatalogItem(item)} onRestore={(item) => void restoreCatalogItem(item)} /> : null}
          {view === 'quotes' ? <DocumentsScreen entity="quotes" workspace={workspace} query={search} busy={busy} onEdit={(item) => setModal({ type: 'document', entity: 'quotes', item })} onCreate={() => setModal({ type: 'document', entity: 'quotes' })} onIssue={(item) => void act(() => desktopApi.issueDocument('quotes', item.id, item.issueDate, item.validUntil), 'Le devis a été émis et numéroté.', false)} onStatus={(item, status) => void act(() => desktopApi.updateQuoteStatus(item.id, status), status === 'accepted' ? 'Le devis a été marqué accepté. Vous pouvez maintenant créer sa facture en un clic.' : status === 'refused' ? 'Le devis a été marqué refusé.' : 'Le devis a été marqué expiré.', false)} onConvert={(item) => void convertAcceptedQuote(item)} onPrint={(item) => setPrintTarget({ entity: 'quotes', value: item })} onArchive={(item) => void archive('quotes', item.id, item.title)} /> : null}
          {view === 'invoices' ? <DocumentsScreen entity="invoices" workspace={workspace} query={search} busy={busy} onEdit={(item) => setModal({ type: 'document', entity: 'invoices', item })} onCreate={() => setModal({ type: 'document', entity: 'invoices' })} onIssue={issueInvoice} onPayment={(item) => setModal({ type: 'payment', invoice: item })} onPrint={(item) => item.type === 'credit_note' ? setPrintTarget({ entity: 'invoices', value: item }) : setModal({ type: 'qrPrint', invoice: item })} onArchive={(item) => void archive('invoices', item.id, item.title)} /> : null}
          {view === 'reminders' ? <RemindersScreen workspace={workspace} /> : null}
          {view === 'time' ? <TimeScreen workspace={workspace} query={search} onCreate={() => setModal({ type: 'time' })} onEdit={(item) => setModal({ type: 'time', item })} onTimer={() => setModal({ type: 'timer' })} onArchive={(item) => void archive('timeEntries', item.id, `Pointage du ${formatDate(item.date)}`)} /> : null}
          {view === 'team' ? <TeamScreen workspace={workspace} query={search} onCreateEmployee={() => setModal({ type: 'employee' })} onEditEmployee={(item) => setModal({ type: 'employee', item })} onCreatePayslip={() => setModal({ type: 'payslip' })} onImportPayslips={() => setModal({ type: 'payrollImport' })} onEditPayslip={(item) => setModal({ type: 'payslip', item })} onPostPayslip={(item) => void postPayslip(item)} onPayPayslip={(item) => setModal({ type: 'payslipPayment', payslip: item })} onPrint={(item) => setPrintTarget({ entity: 'payslips', value: item })} onArchiveEmployee={(item) => void archive('employees', item.id, item.name)} onArchivePayslip={(item) => void archive('payslips', item.id, `Fiche ${item.period}`)} /> : null}
          {view === 'expenses' ? <PurchasesScreen workspace={workspace} query={search} onQueryChange={setSearch} busy={busy} onCreateExpense={() => setModal({ type: 'expense' })} onEditExpense={(item) => setModal({ type: 'expense', item })} onArchiveExpense={(item) => void archive('expenses', item.id, item.supplier || item.reference)} onMarkPaid={(item) => void markExpensePaid(item)} onCreateSupplier={() => setModal({ type: 'supplier' })} onEditSupplier={(item) => setModal({ type: 'supplier', item })} onArchiveSupplier={(item) => void archiveSupplier(item)} onRestoreSupplier={(item) => void restoreSupplier(item)} /> : null}
          {view === 'reports' ? <ReportsScreen workspace={workspace} /> : null}
          {view === 'accounting' ? <AccountingScreen workspace={workspace} /> : null}
          {view === 'settings' ? <SettingsScreen workspace={workspace} busy={busy} setBusy={setBusy} onWorkspace={setWorkspace} onNotice={setNotice} /> : null}
        </section>
      </main>

      {modal ? <WorkspaceModal state={modal} workspace={workspace} busy={busy} close={() => setModal(null)} act={act} onOpenAccounting={() => { setModal(null); setView('accounting'); setSearch(''); }} onQrReady={(invoice, qr) => { setModal(null); setPrintTarget({ entity: 'invoices', value: invoice, qr }); }} /> : null}
      {printTarget ? <PrintSheet target={printTarget} workspace={workspace} onClose={() => setPrintTarget(null)} /> : null}
      <GuidedTour open={guidedTour.open} onClose={guidedTour.close} onNavigate={navigateTour} />
    </div>
  );
}

function CreateButton({ view, onClick, terminology, prerequisites }: { view: View; onClick: Dispatch<SetStateAction<ModalState>>; terminology: ReturnType<typeof projectTerminology>; prerequisites: WorkspacePrerequisites }) {
  const map: Partial<Record<View, [string, ModalState]>> = {
    projects: [`Nouveau ${terminology.singular}`, { type: 'project' }], clients: ['Nouveau client', { type: 'client' }], catalog: ['Nouvelle référence', { type: 'catalogItem' }], quotes: ['Nouveau devis', { type: 'document', entity: 'quotes' }], invoices: ['Nouvelle facture', { type: 'document', entity: 'invoices' }], time: ['Saisir des heures', { type: 'time' }], team: ['Nouveau collaborateur', { type: 'employee' }], expenses: ['Nouvel achat', { type: 'expense' }],
  };
  const current = map[view];
  const blockReason = current ? creationBlockReason(view as Parameters<typeof creationBlockReason>[0], prerequisites) : '';
  return current ? <Button disabled={Boolean(blockReason)} title={blockReason || current[0]} onClick={() => onClick(current[1])}><Plus size={16} /> {current[0]}</Button> : null;
}

function Dashboard({ workspace, onNavigate, onCreate }: { workspace: Workspace; onNavigate: (view: View) => void; onCreate: Dispatch<SetStateAction<ModalState>> }) {
  const terminology = projectTerminology(workspace.settings!.business.nogaSection);
  const ProjectIcon = terminology.icon === 'hard-hat' ? HardHat : FolderKanban;
  const prerequisites: WorkspacePrerequisites = {
    clients: workspace.clients.length,
    projects: workspace.projects.length,
    trackableProjects: workspace.projects.filter((project) => project.status !== 'closed').length,
    activeEmployees: workspace.employees.filter((employee) => employee.active).length,
    costCategories: workspace.settings!.work.costCategories.length,
  };
  const projectBlock = creationBlockReason('projects', prerequisites);
  const quoteBlock = creationBlockReason('quotes', prerequisites);
  const expenseBlock = creationBlockReason('expenses', prerequisites);
  const issued = workspace.invoices.filter((invoice) => invoice.status !== 'draft' && invoice.status !== 'cancelled');
  const invoiced = issued.reduce((total, invoice) => total + documentTotals(invoice.lines).totalCents, 0);
  const paid = issued.reduce((total, invoice) => total + invoicePaid(invoice.id, workspace.payments), 0);
  const minutes = workspace.timeEntries.reduce((total, entry) => total + entry.minutes, 0);
  const activeProjects = workspace.projects.filter((project) => ['in_progress', 'paused'].includes(project.status));
  const hasActivity = workspace.clients.length || workspace.projects.length || workspace.quotes.length || workspace.invoices.length || workspace.timeEntries.length;
  if (!hasActivity) return <FirstUseDashboard onCreate={onCreate} terminology={terminology} />;
  return (
    <div className="dashboard-grid">
      <div className="metric-grid">
        <MetricCard label="Facturé TTC" value={issued.length ? formatMoney(invoiced) : '—'} note={issued.length ? `${issued.length} facture${issued.length > 1 ? 's' : ''} émise${issued.length > 1 ? 's' : ''}` : 'Aucune facture émise'} icon={<CircleDollarSign />} tone="green" />
        <MetricCard label="Encaissé" value={workspace.payments.length ? formatMoney(paid) : '—'} note={workspace.payments.length ? `${workspace.payments.length} paiement${workspace.payments.length > 1 ? 's' : ''}` : 'Aucun paiement enregistré'} icon={<Banknote />} tone="amber" />
        <MetricCard label="Solde ouvert" value={issued.length ? formatMoney(Math.max(0, invoiced - paid)) : '—'} note={issued.length ? 'Sur les factures émises' : 'Pas encore calculable'} icon={<TrendingUp />} tone="blue" />
        <MetricCard label="Temps saisi" value={workspace.timeEntries.length ? formatMinutes(minutes) : '—'} note={workspace.timeEntries.length ? `${workspace.timeEntries.length} saisie${workspace.timeEntries.length > 1 ? 's' : ''}` : 'Aucune heure saisie'} icon={<Clock3 />} tone="violet" />
      </div>
      <section className="panel panel--span"><SectionHeading eyebrow="En cours" title={`${terminology.pluralTitle} actifs`} action={<Button variant="ghost" size="small" onClick={() => onNavigate('projects')}>Tous les {terminology.plural} <ArrowRight size={15} /></Button>} />{activeProjects.length ? <div className="dashboard-projects">{activeProjects.slice(0, 4).map((project) => { const client = workspace.clients.find((item) => item.id === project.clientId); const stats = projectFinancials(project, workspace.invoices, workspace.payments, workspace.timeEntries, workspace.expenses); return <article key={project.id}><div className="project-icon"><ProjectIcon size={18} /></div><div className="dashboard-projects__name"><strong>{project.name}</strong><span>{client?.company || client?.name || 'Client non renseigné'}</span></div><div><small>Facturé</small><strong>{stats.invoicedTotal ? formatMoney(stats.invoicedTotal) : '—'}</strong></div><div><small>Temps réel</small><strong>{stats.minutes ? formatMinutes(stats.minutes) : '—'}</strong></div><StatusBadge status={project.status} /></article>; })}</div> : <EmptyState title={`Aucun ${terminology.singular} actif`} text={`Les ${terminology.plural} planifiés ou terminés restent accessibles dans la liste complète.`} />}</section>
      <section className="panel"><SectionHeading eyebrow="À traiter" title="Échéances" />{workspace.invoices.filter((invoice) => invoice.type !== 'credit_note' && ['issued', 'partially_paid'].includes(invoice.status)).length ? <div className="deadline-list">{workspace.invoices.filter((invoice) => invoice.type !== 'credit_note' && ['issued', 'partially_paid'].includes(invoice.status)).slice(0, 5).map((invoice) => <button key={invoice.id} onClick={() => onNavigate('invoices')}><span><Receipt size={16} /></span><div><strong>{invoice.number || 'Facture non numérotée'}</strong><small>{invoice.title}</small></div><em>{formatDate(invoice.dueDate)}</em></button>)}</div> : <div className="compact-empty"><CheckCircle2 size={20} /><span>Aucune facture émise en attente.</span></div>}</section>
      <section className="panel"><SectionHeading eyebrow="Accès rapide" title="Nouvelle saisie" /><div className="quick-actions"><button onClick={() => onCreate({ type: 'client' })}><UserRound /><span>Client</span></button><button disabled={Boolean(projectBlock)} title={projectBlock || `Créer un ${terminology.singular}`} onClick={() => onCreate({ type: 'project' })}><ProjectIcon /><span>{terminology.singularTitle}</span></button><button disabled={Boolean(quoteBlock)} title={quoteBlock || 'Créer un devis'} onClick={() => onCreate({ type: 'document', entity: 'quotes' })}><FileCheck2 /><span>Devis</span></button><button disabled={Boolean(expenseBlock)} title={expenseBlock || 'Enregistrer un achat'} onClick={() => onCreate({ type: 'expense' })}><WalletCards /><span>Achat</span></button></div></section>
    </div>
  );
}

function FirstUseDashboard({ onCreate, terminology }: { onCreate: Dispatch<SetStateAction<ModalState>>; terminology: ReturnType<typeof projectTerminology> }) {
  return <div className="first-dashboard"><div className="first-dashboard__hero"><span><Building2 size={30} /></span><div><p className="eyebrow">Espace prêt</p><h2>Commencez avec vos vraies données.</h2><p>Votre configuration est enregistrée. Aucune activité fictive n’a été ajoutée.</p><Button size="large" onClick={() => onCreate({ type: 'client' })}><Plus size={17} /> Ajouter mon premier client</Button></div></div><div className="first-dashboard__steps"><article><em>1</em><div><strong>Ajoutez un client</strong><p>Identité et coordonnées de facturation.</p></div></article><article><em>2</em><div><strong>Créez son {terminology.singular}</strong><p>Budget, calendrier et temps prévu.</p></div></article><article><em>3</em><div><strong>Établissez le devis</strong><p>Lignes, TVA explicite et validité.</p></div></article><article><em>4</em><div><strong>Suivez le réel</strong><p>Heures, dépenses, factures et encaissements.</p></div></article></div></div>;
}

function MetricCard({ label, value, note, icon, tone }: { label: string; value: string; note: string; icon: React.ReactNode; tone: string }) { return <article className={`metric-card metric-card--${tone}`}><div className="metric-card__icon">{icon}</div><div><span>{label}</span><strong>{value}</strong><small>{note}</small></div></article>; }

function ProjectsScreen({ workspace, query, onEdit, onCreate, onArchive }: { workspace: Workspace; query: string; onEdit: (item: Project) => void; onCreate: () => void; onArchive: (item: Project) => void }) {
  const terminology = projectTerminology(workspace.settings!.business.nogaSection);
  const ProjectIcon = terminology.icon === 'hard-hat' ? HardHat : FolderKanban;
  const projects = workspace.projects.filter((project) => searchText([project.name, project.address, workspace.clients.find((client) => client.id === project.clientId)?.name], query));
  if (!workspace.projects.length) return <EmptyState icon={<ProjectIcon />} title={`Aucun ${terminology.singular}`} text={workspace.clients.length ? `Créez votre premier ${terminology.singular} à partir d’un client réel.` : `Ajoutez d’abord un client, puis créez son ${terminology.singular}.`} actionLabel={workspace.clients.length ? `Créer un ${terminology.singular}` : 'Ajoutez d’abord un client'} onAction={onCreate} disabled={!workspace.clients.length} />;
  return <div className="project-card-grid">{projects.map((project) => { const client = workspace.clients.find((item) => item.id === project.clientId); const stats = projectFinancials(project, workspace.invoices, workspace.payments, workspace.timeEntries, workspace.expenses); return <article className="project-card" key={project.id}><header><div className="project-card__icon"><ProjectIcon size={20} /></div><div><h3>{project.name}</h3><p>{client?.company || client?.name || 'Client non renseigné'}</p></div><StatusBadge status={project.status} /></header><p className="project-card__address">{project.address || 'Adresse non renseignée'}</p><div className="project-stats"><div><span>Facturé TTC</span><strong>{stats.invoicedTotal ? formatMoney(stats.invoicedTotal) : '—'}</strong></div><div><span>Temps réel</span><strong>{stats.minutes ? formatMinutes(stats.minutes) : '—'}</strong></div><div><span>Marge nette saisie</span><strong>{stats.invoicedNet || stats.laborCost || stats.expenseNet ? formatMoney(stats.margin) : '—'}</strong></div></div><div className="project-dates"><span><CalendarDays size={14} /> Prévu : {formatDate(project.plannedStart)} → {formatDate(project.plannedEnd)}</span><span>Réel : {formatDate(project.actualStart)} → {formatDate(project.actualEnd)}</span></div><footer><Button variant="secondary" size="small" onClick={() => onEdit(project)}><Pencil size={14} /> Modifier</Button><Button variant="ghost" size="small" onClick={() => onArchive(project)}><Archive size={14} /> Supprimer</Button></footer></article>; })}{!projects.length ? <div className="panel panel--span"><EmptyState title="Aucun résultat" text={`Modifiez votre recherche pour retrouver un ${terminology.singular}.`} /></div> : null}</div>;
}

function ClientsScreen({ workspace, query, onEdit, onCreate, onArchive }: { workspace: Workspace; query: string; onEdit: (item: Client) => void; onCreate: () => void; onArchive: (item: Client) => void }) {
  const terminology = projectTerminology(workspace.settings!.business.nogaSection);
  const clients = workspace.clients.filter((client) => searchText([client.name, client.company, client.email, client.phone, client.address], query));
  if (!workspace.clients.length) return <EmptyState icon={<UserRound />} title="Aucun client" text="Ajoutez votre premier client. Aucun contact d’exemple n’est créé automatiquement." actionLabel="Ajouter un client" onAction={onCreate} />;
  return <div className="panel table-panel"><table><thead><tr><th>Client</th><th>Coordonnées</th><th>Adresse</th><th>{terminology.pluralTitle}</th><th aria-label="Actions" /></tr></thead><tbody>{clients.map((client) => <tr key={client.id}><td><div className="identity-cell"><span>{(client.company || client.name).slice(0, 2).toUpperCase()}</span><div><strong>{client.company || client.name}</strong>{client.company && client.name ? <small>{client.name}</small> : null}</div></div></td><td><strong className="table-subtle">{client.email || '—'}</strong><small>{client.phone || '—'}</small></td><td><span className="address-cell">{client.address || '—'}</span></td><td><span className="count-pill">{workspace.projects.filter((project) => project.clientId === client.id).length}</span></td><td><div className="row-actions"><Button variant="ghost" size="icon" onClick={() => onEdit(client)}><Pencil size={15} /></Button><Button variant="ghost" size="icon" onClick={() => onArchive(client)}><Archive size={15} /></Button></div></td></tr>)}</tbody></table>{!clients.length ? <EmptyState title="Aucun résultat" text="Aucun client ne correspond à cette recherche." /> : null}</div>;
}

type DocumentsProps =
  | { entity: 'quotes'; workspace: Workspace; query: string; busy: boolean; onEdit: (item: Quote) => void; onCreate: () => void; onIssue: (item: Quote) => void; onStatus: (item: Quote, status: 'accepted' | 'refused' | 'expired') => void; onConvert: (item: Quote) => void; onPrint: (item: Quote) => void; onArchive: (item: Quote) => void; onPayment?: never }
  | { entity: 'invoices'; workspace: Workspace; query: string; busy: boolean; onEdit: (item: Invoice) => void; onCreate: () => void; onIssue: (item: Invoice) => void; onPayment: (item: Invoice) => void; onPrint: (item: Invoice) => void; onArchive: (item: Invoice) => void; onConvert?: never; onStatus?: never };

type LooseDocumentsProps = { entity: 'quotes' | 'invoices'; onEdit: (item: Quote | Invoice) => void; onIssue: (item: Quote | Invoice) => void; onConvert: (item: Quote) => void; onPayment: (item: Invoice) => void; onPrint: (item: Quote | Invoice) => void; onArchive: (item: Quote | Invoice) => void };

function DocumentsScreen(sourceProps: DocumentsProps) {
  let entity: 'quotes' | 'invoices' = sourceProps.entity;
  const { workspace, query, busy, onCreate } = sourceProps;
  const documents = entity === 'quotes' ? workspace.quotes : workspace.invoices;
  const filtered = documents.filter((document) => searchText([document.number, document.title, workspace.clients.find((client) => client.id === document.clientId)?.name], query));
  if (!documents.length) {
    const hasClients = workspace.clients.length > 0;
    return <EmptyState icon={entity === 'quotes' ? <FileCheck2 /> : <Receipt />} title={entity === 'quotes' ? 'Aucun devis' : 'Aucune facture'} text={hasClients ? `Créez ${entity === 'quotes' ? 'un devis' : 'une facture'} avec vos propres lignes et montants.` : 'Ajoutez d’abord un client pour créer un document.'} actionLabel={hasClients ? entity === 'quotes' ? 'Créer un devis' : 'Créer une facture' : 'Ajoutez d’abord un client'} onAction={onCreate} disabled={!hasClients} />;
  }
  if (entity === 'quotes') {
    const props = sourceProps as Extract<DocumentsProps, { entity: 'quotes' }>;
    return <div className="panel table-panel"><table><thead><tr><th>Document</th><th>Client</th><th>Date</th><th>Montant TTC</th><th>Statut</th><th aria-label="Actions" /></tr></thead><tbody>{filtered.map((document) => {
      const quote = document as Quote;
      const client = workspace.clients.find((candidate) => candidate.id === quote.clientId);
      const converted = workspace.invoices.some((invoice) => invoice.quoteId === quote.id);
      return <tr key={quote.id}><td><div className="document-cell"><span><FileCheck2 size={16} /></span><div><strong>{quote.number || 'Numéro attribué à l’émission'}</strong><small>{quote.title}</small></div></div></td><td><strong className="table-subtle">{client?.company || client?.name || '—'}</strong></td><td><span>{formatDate(quote.issueDate)}</span><small>Valable au {formatDate(quote.validUntil)}</small></td><td><strong>{formatMoney(documentTotals(quote.lines).totalCents)}</strong></td><td><StatusBadge status={quote.status} />{converted ? <small>Facture créée</small> : null}</td><td><div className="document-actions"><Button variant="ghost" size="icon" onClick={() => props.onEdit(quote)} title={quote.status === 'draft' ? 'Modifier' : 'Consulter'} aria-label={quote.status === 'draft' ? `Modifier le devis ${quote.number || quote.title}` : `Consulter le devis ${quote.number || quote.title}`}><Pencil size={15} /></Button>{quote.status === 'draft' ? <><Button variant="ghost" size="icon" disabled={busy || !quote.lines.length} onClick={() => props.onIssue(quote)} title="Émettre" aria-label={`Émettre le devis ${quote.title}`}><CheckCircle2 size={16} /></Button><Button variant="ghost" size="icon" onClick={() => props.onArchive(quote)} title="Supprimer le brouillon" aria-label={`Supprimer le brouillon ${quote.title}`}><Archive size={15} /></Button></> : null}{quote.status === 'issued' ? <><Button variant="ghost" size="icon" disabled={busy} onClick={() => props.onStatus(quote, 'accepted')} title="Marquer accepté" aria-label={`Marquer le devis ${quote.number || quote.title} accepté`}><CheckCircle2 size={16} /></Button><Button variant="ghost" size="icon" disabled={busy} onClick={() => props.onStatus(quote, 'refused')} title="Marquer refusé" aria-label={`Marquer le devis ${quote.number || quote.title} refusé`}><X size={16} /></Button><Button variant="ghost" size="icon" disabled={busy} onClick={() => props.onStatus(quote, 'expired')} title="Marquer expiré" aria-label={`Marquer le devis ${quote.number || quote.title} expiré`}><Clock3 size={16} /></Button></> : null}{quote.status === 'accepted' && !converted ? <Button variant="secondary" size="small" className="quote-convert-button" disabled={busy} onClick={() => props.onConvert(quote)} title="Créer la facture brouillon unique"><ArrowRight size={15} /> Créer la facture</Button> : null}{quote.status !== 'draft' ? <Button variant="ghost" size="icon" onClick={() => props.onPrint(quote)} title="Imprimer" aria-label={`Imprimer le devis ${quote.number || quote.title}`}><Printer size={15} /></Button> : null}</div></td></tr>;
    })}</tbody></table>{!filtered.length ? <EmptyState title="Aucun résultat" text="Aucun devis ne correspond à cette recherche." /> : null}</div>;
  }
  const props = sourceProps as unknown as LooseDocumentsProps;
  entity = sourceProps.entity as 'quotes' | 'invoices';
  return <div className="panel table-panel"><table><thead><tr><th>Document</th><th>Client</th><th>Date</th><th>Montant TTC</th>{entity === 'invoices' ? <th>Encaissé</th> : null}<th>Statut</th><th aria-label="Actions" /></tr></thead><tbody>{filtered.map((item) => { const client = workspace.clients.find((candidate) => candidate.id === item.clientId); const totals = documentTotals(item.lines); const paid = entity === 'invoices' ? invoicePaid(item.id, workspace.payments) : 0; const invoice = entity === 'invoices' ? item as Invoice : null; return <tr key={item.id}><td><div className="document-cell"><span>{entity === 'quotes' ? <FileCheck2 size={16} /> : <Receipt size={16} />}</span><div><strong>{item.number || 'Numéro attribué à l’émission'}</strong><small>{item.title}</small></div></div></td><td><strong className="table-subtle">{client?.company || client?.name || '—'}</strong></td><td><span>{formatDate(item.issueDate)}</span><small>{entity === 'quotes' ? `Valable au ${formatDate((item as Quote).validUntil)}` : invoice?.type === 'credit_note' ? 'Avoir sans encaissement' : `Échéance ${formatDate(invoice?.dueDate ?? '')}`}</small></td><td><strong>{formatMoney(totals.totalCents)}</strong></td>{entity === 'invoices' ? <td><strong>{invoice?.type === 'credit_note' ? 'Non applicable' : paid ? formatMoney(paid) : '—'}</strong></td> : null}<td><StatusBadge status={item.status} /></td><td><div className="document-actions"><Button variant="ghost" size="icon" onClick={() => entity === 'quotes' ? props.onEdit(item as Quote) : props.onEdit(item as Invoice)} title={item.status === 'draft' ? 'Modifier' : 'Consulter'}><Pencil size={15} /></Button>{item.status === 'draft' ? <Button variant="ghost" size="icon" disabled={busy || !item.lines.length} onClick={() => entity === 'quotes' ? props.onIssue(item as Quote) : props.onIssue(item as Invoice)} title="Émettre"><CheckCircle2 size={16} /></Button> : null}{entity === 'quotes' && item.status === 'accepted' ? <Button variant="ghost" size="icon" disabled={busy} onClick={() => props.onConvert(item as Quote)} title="Créer la facture depuis le devis accepté"><ArrowRight size={16} /></Button> : null}{entity === 'invoices' && invoice?.type !== 'credit_note' && item.status !== 'draft' && item.status !== 'paid' && item.status !== 'cancelled' ? <Button variant="ghost" size="icon" onClick={() => props.onPayment(item as Invoice)} title="Enregistrer un paiement"><Banknote size={16} /></Button> : null}{item.status !== 'draft' ? <Button variant="ghost" size="icon" onClick={() => entity === 'quotes' ? props.onPrint(item as Quote) : props.onPrint(item as Invoice)} title="Imprimer"><Printer size={15} /></Button> : null}{item.status === 'draft' ? <Button variant="ghost" size="icon" onClick={() => entity === 'quotes' ? props.onArchive(item as Quote) : props.onArchive(item as Invoice)} title="Supprimer le brouillon"><Archive size={15} /></Button> : null}</div></td></tr>; })}</tbody></table>{!filtered.length ? <EmptyState title="Aucun résultat" text="Aucun document ne correspond à cette recherche." /> : null}</div>;
}

function TimeScreen({ workspace, query, onCreate, onEdit, onTimer, onArchive }: { workspace: Workspace; query: string; onCreate: () => void; onEdit: (item: TimeEntry) => void; onTimer: () => void; onArchive: (item: TimeEntry) => void }) {
  const terminology = projectTerminology(workspace.settings!.business.nogaSection);
  const entries = workspace.timeEntries.filter((entry) => searchText([entry.note, workspace.projects.find((project) => project.id === entry.projectId)?.name, workspace.employees.find((employee) => employee.id === entry.employeeId)?.name], query));
  const totalMinutes = entries.reduce((total, entry) => total + entry.minutes, 0);
  const totalCost = entries.reduce((total, entry) => total + Math.round((entry.minutes * entry.hourlyCostCents) / 60), 0);
  const prerequisites: WorkspacePrerequisites = {
    clients: workspace.clients.length,
    projects: workspace.projects.length,
    trackableProjects: workspace.projects.filter((project) => project.status !== 'closed').length,
    activeEmployees: workspace.employees.filter((employee) => employee.active).length,
    costCategories: workspace.settings!.work.costCategories.length,
  };
  const entryBlock = creationBlockReason('time', prerequisites);
  const timerBlock = timerBlockReason(prerequisites, Boolean(workspace.activeTimer));
  return <div className="stack-layout"><section className="time-hero"><div className="time-hero__icon"><TimerReset size={28} /></div><div><p className="eyebrow">Chronomètre local</p><h2>{workspace.activeTimer ? 'Un pointage est déjà en cours' : 'Mesurez le temps réellement passé.'}</h2><p>{workspace.activeTimer ? 'Arrêtez-le depuis la barre supérieure pour enregistrer la durée.' : timerBlock ? timerBlock : `Choisissez un ${terminology.singular} et un collaborateur. Le pointage continue tant que l’application reste active.`}</p></div><Button size="large" onClick={onTimer} disabled={Boolean(timerBlock)} title={timerBlock || 'Démarrer un pointage réel'}><Play size={17} /> Démarrer</Button></section><div className="summary-strip"><div><span>Temps affiché</span><strong>{entries.length ? formatMinutes(totalMinutes) : '—'}</strong></div><div><span>Coût de main-d’œuvre</span><strong>{entries.length ? formatMoney(totalCost) : '—'}</strong></div><div><span>Saisies</span><strong>{entries.length || '—'}</strong></div></div>{workspace.timeEntries.length ? <div className="panel table-panel"><table><thead><tr><th>Date</th><th>{terminology.singularTitle}</th><th>Collaborateur</th><th>Durée</th><th>Facturation</th><th>Coût</th><th>Statut</th><th /></tr></thead><tbody>{entries.map((entry) => { const project = workspace.projects.find((item) => item.id === entry.projectId); const employee = workspace.employees.find((item) => item.id === entry.employeeId); return <tr key={entry.id}><td>{formatDate(entry.date)}</td><td><strong>{project?.name || '—'}</strong></td><td>{employee?.name || '—'}</td><td><strong>{formatMinutes(entry.minutes)}</strong><small>Pause : {entry.breakMinutes} min</small></td><td><span className="category-pill">{entry.billable ? 'Facturable' : 'Interne'}</span>{entry.billable ? <small>{formatMoney(entry.billingRateCents)} / h</small> : null}</td><td>{formatMoney(Math.round((entry.minutes * entry.hourlyCostCents) / 60))}</td><td><StatusBadge status={entry.status} /></td><td><div className="row-actions"><Button variant="ghost" size="icon" onClick={() => onEdit(entry)}><Pencil size={15} /></Button><Button variant="ghost" size="icon" onClick={() => onArchive(entry)}><Archive size={15} /></Button></div></td></tr>; })}</tbody></table>{!entries.length ? <EmptyState title="Aucun résultat" text="Aucune saisie de temps ne correspond à la recherche." /> : null}</div> : <EmptyState icon={<Clock3 />} title="Aucune heure saisie" text={entryBlock || 'Démarrez un pointage ou saisissez une durée manuellement.'} actionLabel={entryBlock ? undefined : 'Saisir des heures'} onAction={entryBlock ? undefined : onCreate} />}</div>;
}

function TeamScreen({ workspace, query, onCreateEmployee, onEditEmployee, onCreatePayslip, onImportPayslips, onEditPayslip, onPostPayslip, onPayPayslip, onPrint, onArchiveEmployee, onArchivePayslip }: { workspace: Workspace; query: string; onCreateEmployee: () => void; onEditEmployee: (item: Employee) => void; onCreatePayslip: () => void; onImportPayslips: () => void; onEditPayslip: (item: Payslip) => void; onPostPayslip: (item: Payslip) => void; onPayPayslip: (item: Payslip) => void; onPrint: (item: Payslip) => void; onArchiveEmployee: (item: Employee) => void; onArchivePayslip: (item: Payslip) => void }) {
  const employees = workspace.employees.filter((employee) => searchText([employee.name, employee.role, employee.email], query));
  const payrollEnabled = workspace.settings?.payroll.enabled ?? false;
  return <div className="stack-layout"><SectionHeading title="Collaborateurs" description="Les coûts horaires sont utilisés uniquement lorsqu’ils ont été saisis." action={<Button onClick={onCreateEmployee}><Plus size={16} /> Nouveau collaborateur</Button>} />{workspace.employees.length ? <div className="employee-grid">{employees.map((employee) => <article className="employee-card" key={employee.id}><div className="employee-card__avatar">{employee.name.slice(0, 2).toUpperCase()}</div><div className="employee-card__main"><h3>{employee.name}</h3><p>{employee.role || 'Fonction non renseignée'} · {employee.salaryMode === 'monthly' ? 'salaire mensuel' : 'salaire horaire'}</p><div><span>Taux d’activité <strong>{employee.employmentRate ? `${employee.employmentRate} %` : '—'}</strong></span><span>Coût horaire <strong>{formatMoney(employee.hourlyCostCents)}</strong></span></div></div><footer><StatusBadge status={employee.active ? 'validated' : 'incomplete'} /><Button variant="ghost" size="icon" onClick={() => onEditEmployee(employee)}><Pencil size={15} /></Button><Button variant="ghost" size="icon" onClick={() => onArchiveEmployee(employee)}><Archive size={15} /></Button></footer></article>)}</div> : <EmptyState icon={<Users />} title="Aucun collaborateur" text="Ajoutez uniquement les personnes réellement employées ou suivies." actionLabel="Ajouter un collaborateur" onAction={onCreateEmployee} />}
    <section className="panel payroll-panel"><SectionHeading eyebrow="Paie locale assistée" title="Fiches de salaire" description="Importez les anciennes fiches, contrôlez les données détectées puis générez les suivantes depuis un modèle confirmé." action={payrollEnabled ? <div className="payroll-heading-actions"><Button variant="secondary" onClick={onImportPayslips}><ScanLine size={16} /> Importer des fiches{workspace.payrollImports.filter((item) => item.status === 'needs_review').length ? <em>{workspace.payrollImports.filter((item) => item.status === 'needs_review').length}</em> : null}</Button>{workspace.employees.length ? <Button onClick={onCreatePayslip}><Plus size={16} /> Nouvelle fiche</Button> : null}</div> : null} />{!payrollEnabled ? <div className="warning-card"><ShieldCheck size={20} /><div><strong>Module désactivé</strong><p>Activez la paie dans Paramètres puis renseignez les organismes et taux contrôlés.</p></div></div> : !workspace.settings?.payroll.fiduciaryValidated ? <div className="warning-card"><ShieldCheck size={20} /><div><strong>Configuration à faire valider</strong><p>Les fiches restent incomplètes jusqu’à confirmation du contrôle par votre fiduciaire.</p></div></div> : null}{workspace.payrollImports.some((item) => item.status === 'needs_review') ? <button className="payroll-review-banner" onClick={onImportPayslips}><span><ScanLine size={19} /><strong>{workspace.payrollImports.filter((item) => item.status === 'needs_review').length} document(s) à contrôler</strong></span><small>Reprendre l’assistant d’import <ArrowRight size={14} /></small></button> : null}{workspace.payslips.length ? <div className="payslip-list">{workspace.payslips.map((payslip) => { const employee = workspace.employees.find((item) => item.id === payslip.employeeId); const totals = payslipTotals(payslip); const locked = payslip.status === 'posted' || payslip.status === 'paid'; return <article key={payslip.id}><div><FileText size={17} /><span><strong>{employee?.name || 'Collaborateur'}</strong><small>Période {payslip.period}{payslip.status === 'paid' && payslip.paymentDate ? ` · payé le ${formatDate(payslip.paymentDate)}` : ''}</small></span></div><div><small>Brut saisi</small><strong>{formatMoney(totals.earnings)}</strong></div><div><small>Net calculé</small><strong>{formatMoney(totals.net)}</strong></div><StatusBadge status={payslip.status} label={payslip.status === 'incomplete' ? 'À contrôler' : undefined} /><div className="row-actions">{!locked ? <Button variant="ghost" size="icon" onClick={() => onEditPayslip(payslip)} title="Modifier"><Pencil size={15} /></Button> : null}{payslip.status === 'validated' ? <Button variant="secondary" size="small" onClick={() => { if (window.confirm(`Comptabiliser et verrouiller définitivement la fiche ${payslip.period} ?`)) onPostPayslip(payslip); }}><LockKeyhole size={14} /> Comptabiliser et verrouiller</Button> : null}{payslip.status === 'posted' ? <Button variant="secondary" size="small" onClick={() => onPayPayslip(payslip)}><Banknote size={14} /> Marquer payé</Button> : null}{['validated', 'posted', 'paid'].includes(payslip.status) ? <Button variant="ghost" size="icon" onClick={() => onPrint(payslip)} title="Imprimer"><Printer size={15} /></Button> : null}{!locked ? <Button variant="ghost" size="icon" onClick={() => onArchivePayslip(payslip)} title="Supprimer"><Archive size={15} /></Button> : null}</div></article>; })}</div> : payrollEnabled ? <div className="compact-empty"><FileText size={20} /><span>Aucune fiche de salaire créée. Importez un ancien document ou créez la première fiche.</span></div> : null}</section></div>;
}

function ReportsScreen({ workspace }: { workspace: Workspace }) {
  const terminology = projectTerminology(workspace.settings!.business.nogaSection);
  if (!workspace.projects.length) return <EmptyState icon={<BarChart3 />} title="Aucun rapport disponible" text={`Les rapports apparaissent après la création d’un ${terminology.singular}. Aucun graphique fictif n’est affiché.`} />;
  const rows = workspace.projects.map((project) => ({ project, stats: projectFinancials(project, workspace.invoices, workspace.payments, workspace.timeEntries, workspace.expenses) }));
  const withFinancialData = rows.filter((row) => row.stats.invoicedNet || row.stats.laborCost || row.stats.expenseNet);
  return <div className="stack-layout"><div className="report-callout"><BarChart3 size={24} /><div><strong>Calculs transparents</strong><p>Marge = facturation nette émise − coûts horaires saisis − dépenses nettes. Les brouillons sont exclus.</p></div></div>{withFinancialData.length ? <div className="report-grid">{withFinancialData.map(({ project, stats }) => <article className="report-card" key={project.id}><header><div><h3>{project.name}</h3><p>{formatMinutes(stats.minutes)} saisis</p></div><StatusBadge status={project.status} /></header><div className="report-card__figures"><div><span>Facturé net</span><strong>{formatMoney(stats.invoicedNet)}</strong></div><div><span>Main-d’œuvre</span><strong>{formatMoney(stats.laborCost)}</strong></div><div><span>Dépenses nettes</span><strong>{formatMoney(stats.expenseNet)}</strong></div></div><footer><span>Marge issue des saisies</span><strong className={stats.margin < 0 ? 'is-negative' : ''}>{formatMoney(stats.margin)}</strong></footer></article>)}</div> : <EmptyState title="Pas encore assez de données" text="Ajoutez une facture émise, des heures avec coût ou une dépense pour calculer la rentabilité. Aucun pourcentage n’est inventé." />}</div>;
}

function SettingsScreen({ workspace, busy, setBusy, onWorkspace, onNotice }: { workspace: Workspace; busy: boolean; setBusy: (value: boolean) => void; onWorkspace: Dispatch<SetStateAction<Workspace | null>>; onNotice: (value: Notice | null) => void }) {
  const [settings, setSettings] = useState<AppSettings>(workspace.settings!);
  const [vatDraft, setVatDraft] = useState('');
  const org = settings.organization;
  const billing = settings.billing;

  async function execute(action: () => Promise<Workspace>, success: string) {
    setBusy(true); onNotice(null);
    try { const next = await action(); onWorkspace(next); setSettings(next.settings!); onNotice({ tone: 'success', text: success }); }
    catch (reason) { onNotice({ tone: 'error', text: errorMessage(reason, 'L’action locale a échoué.') }); }
    finally { setBusy(false); }
  }

  async function backup() {
    setBusy(true); onNotice(null);
    try { const result = await desktopApi.createBackup(settings.backup.folder || undefined); onWorkspace(result.workspace); onNotice({ tone: 'success', text: `Sauvegarde créée : ${result.path}` }); }
    catch (reason) { onNotice({ tone: 'error', text: errorMessage(reason, 'La sauvegarde n’a pas pu être créée.') }); }
    finally { setBusy(false); }
  }

  async function restore() {
    const source = await desktopApi.chooseRestoreFile();
    if (!source || !window.confirm('Une sauvegarde de sécurité sera créée avant le remplacement. Restaurer le fichier sélectionné ?')) return;
    await execute(() => desktopApi.restoreBackup(source), 'La sauvegarde a été restaurée et contrôlée.');
  }

  async function exportJson() {
    setBusy(true); onNotice(null);
    try { const { path } = await desktopApi.exportData('json'); onNotice({ tone: 'success', text: `Export créé : ${path}` }); }
    catch (reason) { onNotice({ tone: 'error', text: errorMessage(reason, 'L’export n’a pas pu être créé.') }); }
    finally { setBusy(false); }
  }

  async function chooseBackupFolder() {
    const folder = await desktopApi.chooseBackupFolder();
    if (!folder) return;
    const next = { ...settings, backup: { ...settings.backup, folder } };
    setSettings(next);
    await execute(() => desktopApi.saveSettings(next), 'Le dossier de sauvegarde manuelle a été enregistré.');
  }

  async function chooseLogo() {
    const sourcePath = await desktopApi.chooseLogo();
    if (!sourcePath) return;
    await execute(async () => {
      const logoPath = await desktopApi.stageCompanyLogo(sourcePath);
      const next = { ...settings, organization: { ...settings.organization, logoPath } };
      return desktopApi.saveSettings(next);
    }, 'Le logo a été vérifié, copié dans les données locales et enregistré pour les documents.');
  }

  async function removeLogo() {
    const next = { ...settings, organization: { ...settings.organization, logoPath: undefined } };
    await execute(() => desktopApi.saveSettings(next), 'Le logo a été retiré des prochains documents. Les documents déjà émis restent figés.');
  }

  async function applySwissPayrollProfile2026() {
    setBusy(true); onNotice(null);
    try {
      const [profiles, existing] = await Promise.all([desktopApi.getPayrollRegulatoryProfiles(), desktopApi.listPayrollContributionDefinitions()]);
      const profile = profiles.find((item) => item.id === 'CH-2026');
      if (!profile) throw new Error('Le profil réglementaire CH-2026 n’est pas disponible dans cette version locale.');
      for (const definition of profile.definitions) {
        const current = existing.find((item) => item.code === definition.code);
        await desktopApi.upsertPayrollContributionDefinition({ ...definition, id: current?.id, liabilityAccountId: current?.liabilityAccountId ?? '', expenseAccountId: current?.expenseAccountId ?? '' });
      }
      onNotice({ tone: 'success', text: 'Le profil CH-2026 a été installé explicitement. Les cotisations dépendantes du client restent à configurer.' });
    } catch (reason) { onNotice({ tone: 'error', text: errorMessage(reason, 'Le profil réglementaire n’a pas pu être installé.') }); }
    finally { setBusy(false); }
  }

  return <div className="settings-layout">
    <section className="panel settings-card settings-card--wide"><SectionHeading eyebrow="Activité" title="Profil NOGA 2025 et terminologie" description="Le secteur adapte les libellés de projet, dossier ou chantier sans modifier vos données existantes." /><BusinessProfileFields profile={settings.business} onChange={(business) => setSettings((current) => ({ ...current, business }))} disabled={busy} /><div className="form-actions"><Button disabled={busy || !settings.business.nogaSection || !settings.business.nogaDivision || !settings.business.activityDescription.trim()} onClick={() => void execute(() => desktopApi.saveSettings(settings), 'Le profil d’activité et la terminologie ont été enregistrés.')}>Enregistrer le profil d’activité</Button></div></section>
    <section className="panel settings-card settings-card--wide"><SectionHeading eyebrow="Documents" title="Entreprise et facturation" description="Ces champs sont utilisés sur les documents officiels." /><form onSubmit={submitForm(async (form) => {
      const vatRegistered = form.get('vatRegistered') === 'on';
      if (vatRegistered && !billing.vatRatesBp.length) { onNotice({ tone: 'error', text: 'Ajoutez au moins un taux TVA explicite avant d’enregistrer.' }); return; }
      if (vatRegistered && !String(form.get('vatNumber')).trim()) { onNotice({ tone: 'error', text: 'Renseignez le numéro TVA avant d’enregistrer une entreprise assujettie.' }); return; }
      const country = String(form.get('country')).trim().toUpperCase();
      const next: AppSettings = { ...settings, organization: { ...org, legalName: String(form.get('legalName')), legalForm: String(form.get('legalForm')), contactName: String(form.get('contactName')), email: String(form.get('email')), phone: String(form.get('phone')), uidNumber: String(form.get('uidNumber')), vatNumber: String(form.get('vatNumber')), vatRegistered, address: { ...org.address, street: String(form.get('street')), buildingNumber: String(form.get('buildingNumber')), postalCode: String(form.get('postalCode')), city: String(form.get('city')), canton: String(form.get('canton')), country } }, billing: { ...billing, iban: String(form.get('iban')), accountHolder: String(form.get('accountHolder')), quotePrefix: String(form.get('quotePrefix')), invoicePrefix: String(form.get('invoicePrefix')), creditNotePrefix: String(form.get('creditNotePrefix')), paymentTermsDays: numberFromInput(form.get('paymentTermsDays')), quoteValidityDays: numberFromInput(form.get('quoteValidityDays')), defaultFooter: String(form.get('defaultFooter')) } };
      setSettings(next); await execute(() => desktopApi.saveSettings(next), 'Les paramètres ont été enregistrés localement.');
    })}><div className="company-logo-setting"><div className="company-logo-setting__preview">{org.logoPath ? <img src={convertFileSrc(org.logoPath)} alt={`Logo de ${org.legalName}`} /> : <Building2 size={30} />}</div><div className="company-logo-setting__copy"><strong>Logo de l’entreprise</strong><p>PNG, JPEG ou WebP · 8 Mo maximum. Elyko vérifie l’image puis en conserve une copie locale versionnée, incluse dans vos sauvegardes.</p><div className="settings-inline-actions"><Button type="button" variant="secondary" disabled={busy} onClick={() => void chooseLogo()}><FolderOpen size={16} /> {org.logoPath ? 'Remplacer le logo' : 'Choisir le logo'}</Button>{org.logoPath ? <Button type="button" variant="ghost" disabled={busy} onClick={() => void removeLogo()}><X size={16} /> Retirer</Button> : null}</div>{org.logoPath ? <span className="path-note"><ShieldCheck size={14} /> Copie locale · {org.logoPath.split(/[\\/]/).at(-1)}</span> : <span className="path-note">Aucun logo configuré.</span>}</div></div><div className="form-grid"><Field label="Raison sociale" required wide><input name="legalName" defaultValue={org.legalName} required /></Field><Field label="Forme juridique"><input name="legalForm" defaultValue={org.legalForm} /></Field><Field label="Responsable" required><input name="contactName" defaultValue={org.contactName} required /></Field><Field label="E-mail" required><input name="email" type="email" defaultValue={org.email} required /></Field><Field label="Téléphone"><input name="phone" defaultValue={org.phone} /></Field><Field label="Rue / case postale" required wide><input name="street" defaultValue={org.address.street} required /></Field><Field label="Numéro de bâtiment"><input name="buildingNumber" defaultValue={org.address.buildingNumber} /></Field><Field label="NPA" required><input name="postalCode" defaultValue={org.address.postalCode} required /></Field><Field label="Localité" required><input name="city" defaultValue={org.address.city} required /></Field><Field label="Canton" required><input name="canton" defaultValue={org.address.canton} required /></Field><Field label="Pays (code ISO, 2 lettres)" required><input name="country" defaultValue={org.address.country} minLength={2} maxLength={2} required /></Field><Field label="IDE / UID"><input name="uidNumber" defaultValue={org.uidNumber} /></Field><Field label="Numéro TVA" required={org.vatRegistered}><input name="vatNumber" defaultValue={org.vatNumber} required={org.vatRegistered} /></Field><label className="check-card"><input name="vatRegistered" type="checkbox" defaultChecked={org.vatRegistered} /><span><strong>Assujettie à la TVA</strong><small>Le numéro TVA et au moins un taux explicite sont alors obligatoires.</small></span></label><Field label="IBAN" required wide><input name="iban" defaultValue={billing.iban} required /></Field><Field label="Titulaire du compte" required wide><input name="accountHolder" defaultValue={billing.accountHolder} required /></Field><Field label="Préfixe devis" required><input name="quotePrefix" defaultValue={billing.quotePrefix} required /></Field><Field label="Préfixe factures" required><input name="invoicePrefix" defaultValue={billing.invoicePrefix} required /></Field><Field label="Préfixe avoirs" required><input name="creditNotePrefix" defaultValue={billing.creditNotePrefix} required /></Field><Field label="Délai de paiement (jours)" required><input name="paymentTermsDays" type="number" min="1" defaultValue={billing.paymentTermsDays || ''} required /></Field><Field label="Validité des devis (jours)" required><input name="quoteValidityDays" type="number" min="1" defaultValue={billing.quoteValidityDays || ''} required /></Field><Field label="Pied de page des documents" wide><textarea name="defaultFooter" rows={3} defaultValue={billing.defaultFooter} /></Field></div><div className="form-actions"><Button type="submit" disabled={busy}>Enregistrer l’entreprise</Button></div></form></section>

    <section className="panel settings-card"><SectionHeading eyebrow="QR-facture" title="Adresse structurée du créancier" description="Le numéro de bâtiment doit rester séparé de la rue." /><form onSubmit={submitForm(async (form) => { const next = { ...settings, organization: { ...settings.organization, address: { ...settings.organization.address, buildingNumber: String(form.get('buildingNumber')) } } }; setSettings(next); await execute(() => desktopApi.saveSettings(next), 'Le numéro de bâtiment a été enregistré pour les QR-factures.'); })}><Field label="Numéro de bâtiment"><input name="buildingNumber" defaultValue={org.address.buildingNumber} /></Field><div className="form-actions"><Button type="submit" disabled={busy}>Enregistrer l’adresse QR</Button></div></form></section>

    <section className="panel settings-card"><SectionHeading eyebrow="Fiscalité" title="Taux TVA" description="Aucun taux n’est ajouté automatiquement." /><div className="settings-rate-list">{billing.vatRatesBp.map((rate) => <div key={rate}><strong>{(rate / 100).toLocaleString('fr-CH')} %</strong><Button variant="ghost" size="icon" onClick={() => setSettings((current) => ({ ...current, billing: { ...current.billing, vatRatesBp: current.billing.vatRatesBp.filter((candidate) => candidate !== rate) } }))}><Archive size={15} /></Button></div>)}</div><div className="settings-inline-actions"><Field label="Nouveau taux (%)"><input type="number" min="0.01" step="0.01" value={vatDraft} onChange={(event) => setVatDraft(event.target.value)} /></Field><Button type="button" variant="secondary" disabled={!vatDraft || numberFromInput(vatDraft) <= 0} onClick={() => { const rate = Math.round(numberFromInput(vatDraft) * 100); if (!settings.billing.vatRatesBp.includes(rate)) setSettings((current) => ({ ...current, billing: { ...current.billing, vatRatesBp: [...current.billing.vatRatesBp, rate].sort((a, b) => a - b) } })); setVatDraft(''); }}><Plus size={15} /> Ajouter</Button></div><Button disabled={busy} onClick={() => void execute(() => desktopApi.saveSettings(settings), 'Les taux TVA ont été enregistrés.')}><CheckCircle2 size={16} /> Enregistrer les taux</Button></section>

    <section className="panel settings-card settings-card--wide"><SectionHeading eyebrow="Temps et coûts" title="Règles de travail" description="Ces valeurs restent explicites et modifiables." /><form onSubmit={submitForm(async (form) => { const categories = String(form.get('costCategories')).split('\n').map((value) => value.trim()).filter(Boolean); const next = { ...settings, work: { workWeekHours: numberFromInput(form.get('workWeekHours')), dailyHours: numberFromInput(form.get('dailyHours')), roundingMinutes: numberFromInput(form.get('roundingMinutes')), breakMinutes: numberFromInput(form.get('breakMinutes')), costCategories: categories } }; setSettings(next); await execute(() => desktopApi.saveSettings(next), 'Les règles de temps et de coûts ont été enregistrées.'); })}><div className="form-grid"><Field label="Heures par semaine" required><input name="workWeekHours" type="number" min="0.01" step="0.01" defaultValue={settings.work.workWeekHours || ''} required /></Field><Field label="Heures par jour" required><input name="dailyHours" type="number" min="0.01" step="0.01" defaultValue={settings.work.dailyHours || ''} required /></Field><Field label="Arrondi du pointage (minutes)" required hint="Saisissez 0 pour aucun arrondi."><input name="roundingMinutes" type="number" min="0" step="1" defaultValue={settings.work.roundingMinutes} required /></Field><Field label="Pause habituelle (minutes)" required hint="Chaque pointage reste modifiable."><input name="breakMinutes" type="number" min="0" step="1" defaultValue={settings.work.breakMinutes} required /></Field><Field label="Catégories de coûts" wide hint="Une catégorie par ligne."><textarea name="costCategories" rows={5} defaultValue={settings.work.costCategories.join('\n')} /></Field></div><div className="form-actions"><Button disabled={busy} type="submit">Enregistrer les règles</Button></div></form></section>

    <section className="panel settings-card settings-card--wide"><SectionHeading eyebrow="Référentiel officiel" title="Profil réglementaire CH-2026" description="Taux nationaux par part employé et employeur, fournis par le moteur local." /><div className="regulatory-profile"><div><strong>AVS 4,35 % · AI 0,7 % · APG 0,25 % · AC 1,1 %</strong><p>L’AC est plafonnée à CHF 148’200 par an. Le profil n’est jamais installé sans cette action explicite.</p><small>Source : tableau synoptique officiel AVS/AI, édition 2026.</small></div><Button type="button" variant="secondary" disabled={busy} onClick={() => void applySwissPayrollProfile2026()}>Installer le profil officiel</Button><a href="https://www.ahv-iv.ch/Portals/0/adam/AHV-IV/Ypzfdm2t_km4jeHFYxWRdA/Document/Tableau%20synoptique%2020-1.pdf" target="_blank" rel="noreferrer">Consulter la source officielle</a></div><div className="warning-card"><ShieldCheck size={18} /><div><strong>Configuration individuelle obligatoire</strong><p>LPP, AAP, AANP, IJM, allocations familiales et impôt à la source dépendent du client et du collaborateur : ajoutez-les explicitement.</p></div></div></section>

    <SwissPayrollRulesPanel settings={settings} />

    <PayrollContributionsPanel />

    <section className="panel settings-card settings-card--wide"><SectionHeading eyebrow="Paie" title="Organismes et validation" description="Les cotisations de calcul se configurent dans le moteur de paie ci-dessus; cette section conserve les organismes et la validation fiduciaire." /><form onSubmit={submitForm(async (form) => { const next = { ...settings, payroll: { ...settings.payroll, enabled: form.get('enabled') === 'on', fiduciaryValidated: form.get('fiduciaryValidated') === 'on', avsFund: String(form.get('avsFund')), accidentInsurer: String(form.get('accidentInsurer')), pensionFund: String(form.get('pensionFund')), dailyAllowanceInsurer: String(form.get('dailyAllowanceInsurer')), familyAllowanceFund: String(form.get('familyAllowanceFund')), payrollCanton: String(form.get('payrollCanton')) } }; setSettings(next); await execute(() => desktopApi.saveSettings(next), 'La configuration de paie a été enregistrée.'); })}><div className="form-grid"><label className="module-toggle module-toggle--compact"><input name="enabled" type="checkbox" defaultChecked={settings.payroll.enabled} /><span><Users size={19} /><strong>Module salaires</strong><small>Activer la création des fiches</small></span></label><label className="check-card"><input name="fiduciaryValidated" type="checkbox" defaultChecked={settings.payroll.fiduciaryValidated} /><span><strong>Configuration contrôlée par une fiduciaire</strong><small>À confirmer seulement après validation professionnelle.</small></span></label><Field label="Caisse AVS"><input name="avsFund" defaultValue={settings.payroll.avsFund} /></Field><Field label="Assureur accidents"><input name="accidentInsurer" defaultValue={settings.payroll.accidentInsurer} /></Field><Field label="Caisse de pension"><input name="pensionFund" defaultValue={settings.payroll.pensionFund} /></Field><Field label="Assureur indemnités journalières"><input name="dailyAllowanceInsurer" defaultValue={settings.payroll.dailyAllowanceInsurer} /></Field><Field label="Caisse d’allocations familiales"><input name="familyAllowanceFund" defaultValue={settings.payroll.familyAllowanceFund} /></Field><Field label="Canton de paie"><input name="payrollCanton" defaultValue={settings.payroll.payrollCanton} /></Field></div><div className="form-actions"><Button disabled={busy} type="submit">Enregistrer la paie</Button></div></form></section>

    <AppUpdater />
    <section className="panel settings-card"><SectionHeading eyebrow="Protection" title="Sauvegardes manuelles" description="Les nouvelles sauvegardes utilisent .elyko; les anciennes archives .hchantier restent importables." /><div className="security-status"><span><Database size={19} /></span><div><strong>Base locale</strong><p>Les données actives restent sur ce PC.</p></div><i /></div><div className="settings-actions"><Button variant="secondary" disabled={busy} onClick={() => void chooseBackupFolder()}><FolderOpen size={16} /> Choisir le dossier</Button><Button disabled={busy} onClick={() => void backup()}><Download size={16} /> Créer une sauvegarde</Button><Button variant="secondary" disabled={busy} onClick={() => void restore()}><RefreshCw size={16} /> Restaurer</Button></div>{settings.backup.folder ? <p className="path-note"><FolderOpen size={14} /> {settings.backup.folder}</p> : <p className="path-note">Aucun dossier préféré configuré.</p>}</section>
    <section className="panel settings-card"><SectionHeading eyebrow="Portabilité" title="Vos données vous appartiennent" /><p className="settings-copy">L’export JSON contient vos données en clair. Conservez-le dans un emplacement protégé.</p><div className="settings-actions"><Button variant="secondary" disabled={busy} onClick={() => void exportJson()}><FileText size={16} /> Exporter en JSON</Button><Button variant="ghost" disabled={busy} onClick={() => void desktopApi.openDataFolder()}><FolderOpen size={16} /> Ouvrir le dossier local</Button></div></section>
  </div>;
}

function WorkspaceModal({ state, workspace, busy, close, act, onOpenAccounting, onQrReady }: { state: Exclude<ModalState, null>; workspace: Workspace; busy: boolean; close: () => void; act: (action: () => Promise<Workspace>, message: string, close?: boolean) => Promise<boolean>; onOpenAccounting: () => void; onQrReady: (invoice: Invoice, qr: StoredSwissQrBill) => void }) {
  if (state.type === 'client') return <ClientForm item={state.item} busy={busy} close={close} act={act} />;
  if (state.type === 'catalogItem') return <CatalogItemForm item={state.item} settings={workspace.settings!} busy={busy} close={close} act={act} />;
  if (state.type === 'supplier') return <SupplierForm item={state.item} busy={busy} close={close} act={act} />;
  if (state.type === 'project') return <ProjectForm item={state.item} workspace={workspace} busy={busy} close={close} act={act} />;
  if (state.type === 'document') return <DocumentEditor entity={state.entity} item={state.item} quoteSource={state.quoteSource} workspace={workspace} busy={busy} close={close} act={act} />;
  if (state.type === 'time') return <TimeForm item={state.item} workspace={workspace} busy={busy} close={close} act={act} />;
  if (state.type === 'employee') return <EmployeeForm item={state.item} busy={busy} close={close} act={act} />;
  if (state.type === 'expense') return <ExpenseForm item={state.item} workspace={workspace} busy={busy} close={close} act={act} />;
  if (state.type === 'payslip') return <DetailedPayslipForm item={state.item} workspace={workspace} busy={busy} close={close} act={act} />;
  if (state.type === 'payrollImport') return <PayrollImportWizard workspace={workspace} close={close} act={act} />;
  if (state.type === 'payslipPayment') return <PayslipPaymentForm payslip={state.payslip} workspace={workspace} busy={busy} close={close} act={act} />;
  if (state.type === 'payment') return <PaymentForm invoice={state.invoice} workspace={workspace} busy={busy} close={close} act={act} onOpenAccounting={onOpenAccounting} />;
  if (state.type === 'qrPrint') return <QrPrintForm invoice={state.invoice} workspace={workspace} close={close} onReady={onQrReady} />;
  return <TimerForm workspace={workspace} busy={busy} close={close} act={act} />;
}

function ClientForm({ item, busy, close, act }: { item?: Client; busy: boolean; close: () => void; act: ActionRunner }) {
  return <Modal title={item ? 'Modifier le client' : 'Nouveau client'} description="Saisissez uniquement les coordonnées réelles à utiliser sur les documents." onClose={close}><form onSubmit={submitForm(async (form) => {
    const contactPerson = String(form.get('contactPerson'));
    const company = String(form.get('company'));
    const data = { name: company || contactPerson, contactPerson, company, email: String(form.get('email')), phone: String(form.get('phone')), addressLine1: String(form.get('street')), addressLine2: String(form.get('buildingNumber')), postalCode: String(form.get('postalCode')), city: String(form.get('city')), canton: String(form.get('canton')), country: String(form.get('country')).trim().toUpperCase(), notes: String(form.get('notes')) };
    await act(() => item ? desktopApi.updateEntity('clients', item.id, data) : desktopApi.createEntity('clients', data), item ? 'Le client a été mis à jour.' : 'Le client a été ajouté.');
  })}><div className="form-grid"><Field label="Nom du contact" required><input name="contactPerson" defaultValue={item?.name} required autoFocus /></Field><Field label="Entreprise"><input name="company" defaultValue={item?.company} /></Field><Field label="E-mail"><input name="email" type="email" defaultValue={item?.email} /></Field><Field label="Téléphone"><input name="phone" defaultValue={item?.phone} /></Field><Field label="Rue / case postale" required wide><input name="street" defaultValue={item?.addressLine1} required /></Field><Field label="Numéro de bâtiment"><input name="buildingNumber" defaultValue={item?.buildingNumber} /></Field><Field label="NPA" required><input name="postalCode" defaultValue={item?.postalCode} required /></Field><Field label="Localité" required><input name="city" defaultValue={item?.city} required /></Field><Field label="Canton"><input name="canton" defaultValue={item?.canton} /></Field><Field label="Pays (code ISO, 2 lettres)" required><input name="country" defaultValue={item?.country} minLength={2} maxLength={2} required /></Field><Field label="Notes internes" wide><textarea name="notes" rows={3} defaultValue={item?.notes} /></Field></div><FormActions onCancel={close} busy={busy} /></form></Modal>;
}

type ActionRunner = (action: () => Promise<Workspace>, message: string, close?: boolean) => Promise<boolean>;

function ProjectForm({ item, workspace, busy, close, act }: { item?: Project; workspace: Workspace; busy: boolean; close: () => void; act: ActionRunner }) {
  const terminology = projectTerminology(workspace.settings!.business.nogaSection);
  return <Modal title={item ? `Modifier le ${terminology.singular}` : `Nouveau ${terminology.singular}`} description="Les dates prévues et réelles restent distinctes pour un suivi honnête." onClose={close} wide><form onSubmit={submitForm(async (form) => {
    const data = { clientId: String(form.get('clientId')), code: '', name: String(form.get('name')), addressLine1: String(form.get('address')), addressLine2: '', postalCode: '', city: '', canton: '', status: String(form.get('status')), plannedStartDate: String(form.get('plannedStart')), plannedEndDate: String(form.get('plannedEnd')), actualStartDate: String(form.get('actualStart')), actualEndDate: String(form.get('actualEnd')), budgetCents: centsFromInput(form.get('budget')), plannedMinutes: Math.round(numberFromInput(form.get('plannedHours')) * 60), progress: 0, description: '', notes: String(form.get('notes')) };
    await act(() => item ? desktopApi.updateEntity('projects', item.id, data) : desktopApi.createEntity('projects', data), item ? `Le ${terminology.singular} a été mis à jour.` : `Le ${terminology.singular} a été créé.`);
  })}><div className="form-grid"><Field label={`Nom du ${terminology.singular}`} required wide><input name="name" defaultValue={item?.name} required autoFocus /></Field><Field label="Client" required><select name="clientId" defaultValue={item?.clientId} required><option value="">Choisir un client</option>{workspace.clients.map((client) => <option value={client.id} key={client.id}>{client.company || client.name}</option>)}</select></Field><Field label="Statut" required><select name="status" defaultValue={item?.status ?? 'planned'}><option value="planned">Planifié</option><option value="in_progress">En cours</option><option value="paused">En pause</option><option value="completed">Terminé</option><option value="closed">Clôturé</option></select></Field><Field label={`Adresse du ${terminology.singular}`} wide><textarea name="address" rows={2} defaultValue={item?.address} /></Field><Field label="Début prévu"><input name="plannedStart" type="date" defaultValue={item?.plannedStart} /></Field><Field label="Fin prévue"><input name="plannedEnd" type="date" defaultValue={item?.plannedEnd} /></Field><Field label="Début réel"><input name="actualStart" type="date" defaultValue={item?.actualStart} /></Field><Field label="Fin réelle"><input name="actualEnd" type="date" defaultValue={item?.actualEnd} /></Field><Field label="Budget accepté (CHF)"><input name="budget" type="number" min="0" step="0.01" defaultValue={item?.budgetCents ? item.budgetCents / 100 : ''} /></Field><Field label="Temps prévu (heures)"><input name="plannedHours" type="number" min="0" step="0.01" defaultValue={item?.plannedMinutes ? item.plannedMinutes / 60 : ''} /></Field><Field label="Notes" wide><textarea name="notes" rows={3} defaultValue={item?.notes} /></Field></div><FormActions onCancel={close} busy={busy} /></form></Modal>;
}


function TimeForm({ item, workspace, busy, close, act }: { item?: TimeEntry; workspace: Workspace; busy: boolean; close: () => void; act: ActionRunner }) {
  const terminology = projectTerminology(workspace.settings!.business.nogaSection);
  const [billable, setBillable] = useState<'' | 'yes' | 'no'>(item ? item.billable ? 'yes' : 'no' : '');
  return <Modal title={item ? 'Modifier les heures' : 'Saisir des heures'} description="La durée et le coût proviennent uniquement de cette saisie et du collaborateur choisi." onClose={close}><form onSubmit={submitForm(async (form) => {
    const data = { projectId: String(form.get('projectId')), employeeId: String(form.get('employeeId')), date: String(form.get('date')), minutes: Math.round(numberFromInput(form.get('hours')) * 60), breakMinutes: numberFromInput(form.get('breakMinutes')), billable: billable === 'yes', billingRateCents: billable === 'yes' ? centsFromInput(form.get('billingRate')) : 0, costRateCents: centsFromInput(form.get('costRate')), note: String(form.get('note')), status: String(form.get('status')) };
    await act(() => item ? desktopApi.updateEntity('timeEntries', item.id, data) : desktopApi.createEntity('timeEntries', data), item ? 'La saisie de temps a été mise à jour.' : 'Les heures ont été enregistrées.');
  })}><div className="form-grid"><Field label={terminology.singularTitle} required wide><select name="projectId" defaultValue={item?.projectId} required autoFocus><option value="">Choisir un {terminology.singular}</option>{workspace.projects.filter((project) => project.status !== 'closed' || project.id === item?.projectId).map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></Field><Field label="Collaborateur" required><select name="employeeId" defaultValue={item?.employeeId} required><option value="">Choisir un collaborateur</option>{workspace.employees.filter((employee) => employee.active || employee.id === item?.employeeId).map((employee) => <option value={employee.id} key={employee.id}>{employee.name}</option>)}</select></Field><Field label="Date" required><input name="date" type="date" defaultValue={item?.date || todayIso()} required /></Field><Field label="Durée travaillée (heures)" required><input name="hours" type="number" min="0.01" step="0.01" defaultValue={item?.minutes ? item.minutes / 60 : ''} required /></Field><Field label="Pause non travaillée (minutes)" required><input name="breakMinutes" type="number" min="0" step="1" defaultValue={item ? item.breakMinutes : ''} required /></Field><Field label="Temps facturable au client ?" required><select value={billable} onChange={(event) => setBillable(event.target.value as '' | 'yes' | 'no')} required><option value="">Choisir</option><option value="yes">Oui, facturable</option><option value="no">Non, interne</option></select></Field>{billable === 'yes' ? <Field label="Tarif de facturation (CHF/h)" required><input name="billingRate" type="number" min="0" step="0.01" defaultValue={item?.billingRateCents ? item.billingRateCents / 100 : ''} required /></Field> : null}<Field label="Coût horaire appliqué (CHF/h)" required hint={`Saisissez le coût confirmé pour ce ${terminology.singular}.`}><input name="costRate" type="number" min="0" step="0.01" defaultValue={item ? item.hourlyCostCents / 100 : ''} required /></Field><Field label="Statut" required><select name="status" defaultValue={item?.status ?? ''} required><option value="">Choisir le statut</option><option value="entered">Saisi</option><option value="approved">Approuvé</option><option value="locked">Verrouillé</option></select></Field><Field label="Note" wide><textarea name="note" rows={3} defaultValue={item?.note} /></Field></div><FormActions onCancel={close} busy={busy} /></form></Modal>;
}

function EmployeeForm({ item, busy, close, act }: { item?: Employee; busy: boolean; close: () => void; act: ActionRunner }) {
  const [salaryMode, setSalaryMode] = useState<Employee['salaryMode'] | ''>(item?.salaryMode ?? '');
  return <Modal title={item ? 'Modifier le collaborateur' : 'Nouveau collaborateur'} description="Aucun salaire, taux ou coût n’est prérempli." onClose={close} wide><form onSubmit={submitForm(async (form) => {
    const allowanceChoice = String(form.get('avsAllowanceWaived') ?? '');
    const contractualHours = String(form.get('contractualWeeklyHours') ?? '').trim();
    const acOpeningYear = String(form.get('acOpeningYear') ?? '').trim();
    const acOpeningBasis = String(form.get('acOpeningBasis') ?? '').trim();
    const data = { employeeNumber: String(form.get('employeeNumber')), name: String(form.get('name')), role: String(form.get('role')), email: String(form.get('email')), phone: String(form.get('phone')), addressLine1: String(form.get('addressLine1')), addressLine2: String(form.get('addressLine2')), postalCode: String(form.get('postalCode')), city: String(form.get('city')), canton: String(form.get('canton')), country: String(form.get('country')).trim().toUpperCase(), birthDate: String(form.get('birthDate')), socialSecurityNumber: String(form.get('avsNumber')), iban: String(form.get('iban')), employmentStartDate: String(form.get('employmentStart')), employmentEndDate: String(form.get('employmentEnd')), referenceAgeDate: String(form.get('referenceAgeDate') ?? '') || null, avsAllowanceWaived: allowanceChoice ? allowanceChoice === 'yes' : null, employmentRate: numberFromInput(form.get('employmentRate')), contractualWeeklyMinutes: contractualHours ? Math.round(numberFromInput(form.get('contractualWeeklyHours')) * 60) : null, acOpeningYear: acOpeningYear ? numberFromInput(form.get('acOpeningYear')) : null, acOpeningBasisCents: acOpeningBasis ? centsFromInput(form.get('acOpeningBasis')) : null, hourlyRateCents: centsFromInput(form.get('hourlyCost')), monthlySalaryCents: salaryMode === 'monthly' ? centsFromInput(form.get('grossSalary')) : 0, status: String(form.get('status')), notes: String(form.get('notes')) };
    await act(() => item ? desktopApi.updateEntity('employees', item.id, data) : desktopApi.createEntity('employees', data), item ? 'Le collaborateur a été mis à jour.' : 'Le collaborateur a été ajouté.');
  })}><div className="form-grid"><Field label="Nom complet" required wide><input name="name" defaultValue={item?.name} required autoFocus /></Field><Field label="Numéro de collaborateur"><input name="employeeNumber" defaultValue={item?.employeeNumber} /></Field><Field label="Fonction" required><input name="role" defaultValue={item?.role} required /></Field><Field label="Taux d’activité (%)" required><input name="employmentRate" type="number" min="0.01" max="100" step="0.01" defaultValue={item?.employmentRate || ''} required /></Field><Field label="Horaire contractuel (h/semaine)" hint="Valeur réelle chez cet employeur; elle décide la couverture AANP au seuil de 8 h."><input name="contractualWeeklyHours" type="number" min="0.01" max="168" step="0.01" defaultValue={item?.contractualWeeklyMinutes ? item.contractualWeeklyMinutes / 60 : ''} /></Field><Field label="E-mail"><input name="email" type="email" defaultValue={item?.email} /></Field><Field label="Téléphone"><input name="phone" defaultValue={item?.phone} /></Field><Field label="Rue / case postale" wide><input name="addressLine1" defaultValue={item?.addressLine1} /></Field><Field label="Numéro de bâtiment"><input name="addressLine2" defaultValue={item?.addressLine2} /></Field><Field label="NPA"><input name="postalCode" defaultValue={item?.postalCode} /></Field><Field label="Localité"><input name="city" defaultValue={item?.city} /></Field><Field label="Canton"><input name="canton" defaultValue={item?.canton} /></Field><Field label="Pays (code ISO, 2 lettres)"><input name="country" minLength={2} maxLength={2} defaultValue={item?.country} /></Field><Field label="Date de naissance"><input name="birthDate" type="date" defaultValue={item?.birthDate} /></Field><Field label="Numéro AVS"><input name="avsNumber" defaultValue={item?.avsNumber} /></Field><Field label="IBAN du collaborateur"><input name="iban" defaultValue={item?.iban} /></Field><Field label="Début du contrat"><input name="employmentStart" type="date" defaultValue={item?.employmentStart} /></Field><Field label="Fin du contrat"><input name="employmentEnd" type="date" defaultValue={item?.employmentEnd} /></Field><Field label="Année d’ouverture AC" hint="Année du cumul importé. À confirmer chaque année, même lorsque le montant est zéro."><input name="acOpeningYear" type="number" min="2000" max="9999" step="1" defaultValue={item?.acOpeningYear ?? ''} /></Field><Field label="Base AC avant Elyko (CHF)" hint="Base déjà acquise hors Elyko durant l’année indiquée. Saisissez 0 pour confirmer qu’il n’y en a aucune."><input name="acOpeningBasis" type="number" min="0" step="0.01" defaultValue={item?.acOpeningBasisCents === null || item?.acOpeningBasisCents === undefined ? '' : item.acOpeningBasisCents / 100} /></Field><Field label="Date confirmée d’atteinte de l’âge de référence" hint="Renseignez uniquement la date confirmée par la caisse ou la fiduciaire. L’AC reste due pendant ce mois; l’exemption et la franchise AVS commencent le mois civil suivant. Elyko ne déduit jamais cette date du sexe."><input name="referenceAgeDate" type="date" defaultValue={item?.referenceAgeDate} /></Field><Field label="Franchise AVS après l’âge de référence" hint="CHF 16’800/an, soit CHF 1’400 par mois civil entier ou entamé dès le mois suivant, sauf renonciation confirmée."><select name="avsAllowanceWaived" defaultValue={item?.avsAllowanceWaived === null || item?.avsAllowanceWaived === undefined ? '' : item.avsAllowanceWaived ? 'yes' : 'no'}><option value="">Choix à confirmer</option><option value="no">Franchise conservée</option><option value="yes">Renonciation confirmée</option></select></Field><Field label="Type de rémunération" required><select value={salaryMode} onChange={(event) => setSalaryMode(event.target.value as Employee['salaryMode'] | '')} required><option value="">Choisir le type</option><option value="hourly">Salaire horaire</option><option value="monthly">Salaire mensuel</option></select></Field>{salaryMode === 'monthly' ? <Field label="Salaire mensuel brut (CHF)" required><input name="grossSalary" type="number" min="0" step="0.01" defaultValue={item?.grossSalaryCents ? item.grossSalaryCents / 100 : ''} required /></Field> : null}<Field label="Coût horaire chargé (CHF)" hint="Saisissez le coût réellement défini par l’entreprise." required><input name="hourlyCost" type="number" min="0" step="0.01" defaultValue={item ? item.hourlyCostCents / 100 : ''} required /></Field><Field label="Statut du collaborateur" required><select name="status" defaultValue={item ? item.active ? 'actif' : 'inactif' : ''} required><option value="">Choisir le statut</option><option value="actif">Actif</option><option value="inactif">Inactif</option></select></Field><Field label="Notes internes" wide><textarea name="notes" rows={3} defaultValue={item?.notes} /></Field></div><FormActions onCancel={close} busy={busy} /></form></Modal>;
}

function PayslipForm({ item, workspace, busy, close, act }: { item?: Payslip; workspace: Workspace; busy: boolean; close: () => void; act: ActionRunner }) {
  const [lines, setLines] = useState<PayslipLine[]>(item?.lines.map((line) => ({ ...line })) ?? []);
  const totals = payslipTotals({ id: item?.id ?? '', employeeId: item?.employeeId ?? '', period: item?.period ?? '', status: item?.status ?? 'incomplete', lines, paymentDate: item?.paymentDate ?? '', notes: item?.notes ?? '', createdAt: item?.createdAt ?? '' });
  function addLine(kind: PayslipLine['kind']) { setLines((current) => [...current, { id: createId(), label: '', kind, amountCents: 0 }]); }
  function updateLine(id: string, patch: Partial<PayslipLine>) { setLines((current) => current.map((line) => line.id === id ? { ...line, ...patch } : line)); }
  return <Modal title={item ? 'Modifier la fiche' : 'Nouvelle fiche de salaire'} description="Toutes les lignes sont explicites. Le logiciel n’ajoute aucune retenue automatique." onClose={close} wide><form onSubmit={submitForm(async (form) => {
    if (!lines.length || lines.some((line) => !line.label.trim() || line.amountCents < 0)) return;
    const status: Payslip['status'] = workspace.settings?.payroll.fiduciaryValidated && form.get('validated') === 'on' ? 'validated' : 'incomplete';
    const data = { employeeId: String(form.get('employeeId')), period: String(form.get('period')), status, grossCents: totals.earnings, deductionsCents: totals.deductions, netCents: totals.net, employerCostsCents: totals.employer, paymentDate: '', notes: String(form.get('notes')) };
    await act(() => desktopApi.savePayslip(data, lines, item), item ? 'La fiche a été mise à jour.' : 'La fiche a été créée avec les lignes saisies.');
    })}><div className="form-grid"><Field label="Collaborateur" required><select name="employeeId" defaultValue={item?.employeeId} required><option value="">Choisir un collaborateur</option>{workspace.employees.map((employee) => <option value={employee.id} key={employee.id}>{employee.name}</option>)}</select></Field><Field label="Période" required><input name="period" type="month" defaultValue={item?.period} required /></Field></div><section className="pay-lines"><header><div><strong>Éléments de la fiche</strong><small>Aucun montant n’est proposé par défaut.</small></div><div><Button type="button" variant="secondary" size="small" onClick={() => addLine('earning')}><Plus size={14} /> Gain</Button><Button type="button" variant="secondary" size="small" onClick={() => addLine('reimbursement')}><Plus size={14} /> Remboursement</Button><Button type="button" variant="secondary" size="small" onClick={() => addLine('deduction')}><Plus size={14} /> Retenue</Button><Button type="button" variant="secondary" size="small" onClick={() => addLine('employer')}><Plus size={14} /> Charge employeur</Button></div></header>{lines.length ? <div className="pay-line-list">{lines.map((line) => <div key={line.id}><select value={line.kind} onChange={(event) => updateLine(line.id, { kind: event.target.value as PayslipLine['kind'] })}><option value="earning">Gain soumis au brut</option><option value="reimbursement">Remboursement hors brut</option><option value="deduction">Retenue</option><option value="employer">Charge employeur</option></select><input value={line.label} onChange={(event) => updateLine(line.id, { label: event.target.value })} placeholder="Libellé" required /><label className="money-input"><input type="number" min="0" step="0.01" value={line.amountCents ? line.amountCents / 100 : ''} onChange={(event) => updateLine(line.id, { amountCents: Math.round((event.target.valueAsNumber || 0) * 100) })} required /><span>CHF</span></label><Button type="button" variant="ghost" size="icon" onClick={() => setLines((current) => current.filter((candidate) => candidate.id !== line.id))}><Archive size={15} /></Button></div>)}</div> : <div className="rate-empty">Ajoutez les gains, remboursements, retenues et charges confirmés pour cette période.</div>}</section><div className="document-bottom"><Field label="Notes"><textarea name="notes" rows={3} defaultValue={item?.notes} /></Field><div className="document-totals"><div><span>Brut saisi</span><strong>{formatMoney(totals.earnings)}</strong></div><div><span>Remboursements hors brut</span><strong>{formatMoney(totals.reimbursements)}</strong></div><div><span>Retenues saisies</span><strong>{formatMoney(totals.deductions)}</strong></div><div><span>Net calculé</span><strong>{formatMoney(totals.net)}</strong></div></div></div>{workspace.settings?.payroll.fiduciaryValidated ? <label className="check-card"><input name="validated" type="checkbox" defaultChecked={item?.status === 'validated'} /><span><strong>Valider cette fiche</strong><small>Confirmez que les lignes de cette période ont été contrôlées.</small></span></label> : <div className="warning-card"><ShieldCheck size={18} /><div><strong>La fiche restera incomplète</strong><p>La configuration de paie n’est pas marquée comme contrôlée par une fiduciaire.</p></div></div>}<FormActions onCancel={close} busy={busy} /></form></Modal>;
}

function PaymentForm({ invoice, workspace, busy, close, act, onOpenAccounting }: { invoice: Invoice; workspace: Workspace; busy: boolean; close: () => void; act: ActionRunner; onOpenAccounting: () => void }) {
  const [requestId] = useState(() => createId());
  const [accountingState, setAccountingState] = useState<'loading' | 'enabled' | 'disabled' | 'error'>('loading');
  const total = documentTotals(invoice.lines).totalCents;
  const alreadyPaid = invoicePaid(invoice.id, workspace.payments);
  const credited = invoiceCredited(invoice.id, workspace.invoices);
  const balance = invoiceOpenBalance(invoice, workspace.invoices, workspace.payments);

  useEffect(() => {
    let active = true;
    void desktopApi.getAccountingSettings()
      .then((settings) => { if (active) setAccountingState(settings.enabled ? 'enabled' : 'disabled'); })
      .catch(() => { if (active) setAccountingState('error'); });
    return () => { active = false; };
  }, []);

  return <Modal title="Enregistrer un paiement" description={`${invoice.number || 'Facture'} · solde ouvert ${formatMoney(balance)}`} onClose={close}><form onSubmit={submitForm(async (form) => {
    const amountCents = centsFromInput(form.get('amount'));
    if (amountCents <= 0 || amountCents > balance) return;
    await act(() => desktopApi.addPayment(invoice.id, { requestId, amountCents, date: String(form.get('date')), method: String(form.get('method')), reference: String(form.get('reference')), notes: String(form.get('notes')) }), 'Le paiement a été enregistré, le solde recalculé et l’écriture comptable générée si la comptabilité est activée.');
  })}><div className="payment-summary"><div><span>Total facture</span><strong>{formatMoney(total)}</strong></div><div><span>Avoirs déduits</span><strong>{formatMoney(credited)}</strong></div><div><span>Déjà encaissé</span><strong>{formatMoney(alreadyPaid)}</strong></div><div><span>Solde</span><strong>{formatMoney(balance)}</strong></div></div>{accountingState === 'enabled' ? <div className="info-strip"><Landmark size={17} /><span>Le paiement et l’écriture banque contre débiteurs seront enregistrés ensemble dans une transaction locale.</span></div> : accountingState === 'disabled' ? <div className="warning-card"><Landmark size={18} /><div><strong>Comptabilité non activée</strong><p>Le solde de la facture sera mis à jour, mais aucune écriture ne peut être générée tant que les comptes ne sont pas configurés.</p><Button type="button" variant="secondary" size="small" onClick={onOpenAccounting}>Configurer la comptabilité</Button></div></div> : accountingState === 'error' ? <div className="warning-card"><MessageSquareWarning size={18} /><div><strong>État comptable non vérifié</strong><p>Contrôlez la configuration comptable avant l’encaissement si vous exigez une écriture automatique.</p></div></div> : <div className="info-strip"><LoaderCircle className="spin" size={17} /><span>Vérification de la chaîne comptable locale…</span></div>}<div className="form-grid"><Field label="Montant encaissé (CHF)" required><input name="amount" type="number" min="0.01" max={balance / 100} step="0.01" required autoFocus /></Field><Field label="Date" required><input name="date" type="date" defaultValue={todayIso()} required /></Field><Field label="Mode de paiement" required><input name="method" required /></Field><Field label="Référence"><input name="reference" /></Field><Field label="Note" wide><textarea name="notes" rows={2} /></Field></div><FormActions onCancel={close} busy={busy} submitLabel="Enregistrer le paiement" /></form></Modal>;
}

function PayslipPaymentForm({ payslip, workspace, busy, close, act }: { payslip: Payslip; workspace: Workspace; busy: boolean; close: () => void; act: ActionRunner }) {
  const employee = workspace.employees.find((item) => item.id === payslip.employeeId);
  const net = payslipTotals(payslip).net;
  return <Modal title="Payer la fiche de salaire" description={`${employee?.name || 'Collaborateur'} · ${payslip.period}`} onClose={close}><form onSubmit={submitForm(async (form) => {
    await act(() => desktopApi.payPayslip(payslip.id, String(form.get('paymentDate')), String(form.get('reference'))), 'Le salaire a été marqué payé et l’écriture banque contre salaires dus a été créée.');
  })}><div className="payment-summary"><div><span>Collaborateur</span><strong>{employee?.name || '—'}</strong></div><div><span>Période</span><strong>{payslip.period}</strong></div><div><span>Net à payer</span><strong>{formatMoney(net)}</strong></div><div><span>État</span><strong>Comptabilisé</strong></div></div><div className="form-grid"><Field label="Date du paiement" required><input name="paymentDate" type="date" defaultValue={todayIso()} required autoFocus /></Field><Field label="Référence bancaire" hint="Facultative, mais recommandée pour le rapprochement."><input name="reference" maxLength={200} /></Field></div><div className="info-strip"><Landmark size={17} /><span>Cette action débite les salaires à payer, crédite la banque et verrouille définitivement la date et la référence.</span></div><FormActions onCancel={close} busy={busy} submitLabel="Confirmer le paiement" /></form></Modal>;
}

function TimerForm({ workspace, busy, close, act }: { workspace: Workspace; busy: boolean; close: () => void; act: ActionRunner }) {
  const terminology = projectTerminology(workspace.settings!.business.nogaSection);
  const [employeeId, setEmployeeId] = useState('');
  const [billable, setBillable] = useState<'' | 'yes' | 'no'>('');
  const employee = workspace.employees.find((item) => item.id === employeeId);
  return <Modal title="Démarrer un pointage" description="Le chronomètre utilise le coût horaire réellement configuré du collaborateur." onClose={close}><form onSubmit={submitForm(async (form) => {
    await act(() => desktopApi.startTimer({ projectId: String(form.get('projectId')), employeeId, note: String(form.get('note')), billable: billable === 'yes', billingRateCents: billable === 'yes' ? centsFromInput(form.get('billingRate')) : 0, costRateCents: employee?.hourlyCostCents ?? 0 }), 'Le pointage a démarré.');
  })}><div className="timer-modal-icon"><Play size={25} /></div><div className="form-grid"><Field label={terminology.singularTitle} required wide><select name="projectId" required autoFocus><option value="">Choisir un {terminology.singular}</option>{workspace.projects.filter((project) => project.status !== 'closed').map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></Field><Field label="Collaborateur" required wide><select value={employeeId} onChange={(event) => setEmployeeId(event.target.value)} required><option value="">Choisir un collaborateur</option>{workspace.employees.filter((item) => item.active).map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></Field><Field label="Temps facturable au client ?" required><select value={billable} onChange={(event) => setBillable(event.target.value as '' | 'yes' | 'no')} required><option value="">Choisir</option><option value="yes">Oui, facturable</option><option value="no">Non, interne</option></select></Field>{billable === 'yes' ? <Field label="Tarif de facturation (CHF/h)" required><input name="billingRate" type="number" min="0" step="0.01" required /></Field> : null}<Field label="Note de travail" wide><textarea name="note" rows={3} /></Field></div>{employeeId ? <div className="info-strip"><Clock3 size={17} /><span>Coût horaire appliqué : {formatMoney(employee?.hourlyCostCents ?? 0)}. Cette valeur provient de la fiche du collaborateur.</span></div> : null}<FormActions onCancel={close} busy={busy} submitLabel="Démarrer le chronomètre" /></form></Modal>;
}

function settingsForSnapshot(current: AppSettings, issuer?: FrozenIssuer, terms?: string): AppSettings {
  if (!issuer) return current;
  return { ...current, organization: { ...current.organization, legalName: issuer.companyName, legalForm: issuer.legalForm, contactName: issuer.ownerName, email: issuer.email, phone: issuer.phone, uidNumber: issuer.uidNumber, vatNumber: issuer.vatNumber, vatRegistered: issuer.vatRegistered, logoPath: issuer.logoPath || undefined, address: { street: issuer.addressLine1, buildingNumber: issuer.buildingNumber, postalCode: issuer.postalCode, city: issuer.city, canton: issuer.canton, country: issuer.country } }, billing: { ...current.billing, iban: issuer.iban, accountHolder: issuer.bankName || issuer.companyName, defaultFooter: terms ?? current.billing.defaultFooter } };
}

function clientForSnapshot(customer: FrozenCustomer | undefined, current?: Client): Client | undefined {
  if (!customer?.id && !customer?.name && !customer?.company) return current;
  const address = [customer.addressLine1, customer.addressLine2, [customer.postalCode, customer.city].filter(Boolean).join(' '), customer.canton, customer.country].filter(Boolean).join('\n');
  return { id: customer.id, name: customer.contactPerson || customer.name, company: customer.company, email: customer.email, phone: customer.phone, address, addressLine1: customer.addressLine1, addressLine2: customer.addressLine2, buildingNumber: customer.addressLine2, postalCode: customer.postalCode, city: customer.city, canton: customer.canton, country: customer.country, uidNumber: '', notes: '' };
}

function quoteForPrint(quote: Quote): Quote {
  const frozen = quote.snapshot;
  if (!frozen) return quote;
  return { ...quote, number: frozen.document.number, clientId: frozen.document.clientId, projectId: frozen.document.projectId, title: frozen.document.title, issueDate: frozen.document.issueDate, validUntil: frozen.document.validUntil, lines: frozen.items, notes: frozen.document.notes };
}

function invoiceForPrint(invoice: Invoice): Invoice {
  const frozen = invoice.snapshot;
  if (!frozen) return invoice;
  return { ...invoice, number: frozen.document.number, clientId: frozen.document.clientId, projectId: frozen.document.projectId, quoteId: frozen.document.quoteId, originalInvoiceId: frozen.document.originalInvoiceId, title: frozen.document.title, issueDate: frozen.document.issueDate, dueDate: frozen.document.dueDate, serviceDateFrom: frozen.document.serviceDateFrom, serviceDateTo: frozen.document.serviceDateTo, lines: frozen.items, notes: frozen.document.notes };
}

function invoicePrintCapacityError(source: Invoice): string | null {
  const invoice = invoiceForPrint(source);
  const descriptionRows = invoice.lines.reduce((sum, line) => sum + Math.max(1, Math.ceil(line.description.trim().length / 62)), 0);
  const vatRows = vatBreakdown(invoice.lines).length;
  const noteRows = Math.ceil((invoice.notes?.length ?? 0) / 88);
  const estimatedMillimetres = 82 + descriptionRows * 6 + vatRows * 5 + noteRows * 4;
  return estimatedMillimetres > 178 ? 'Cette facture est trop longue pour tenir de façon sûre au-dessus de la bande QR de 105 mm. Réduisez ou regroupez les lignes, puis réémettez un document adapté; l’impression est bloquée pour éviter toute troncature.' : null;
}

function QrPrintForm({ invoice, workspace, close, onReady }: { invoice: Invoice; workspace: Workspace; close: () => void; onReady: (invoice: Invoice, qr: StoredSwissQrBill) => void }) {
  const printedInvoice = invoiceForPrint(invoice);
  const settings = settingsForSnapshot(workspace.settings!, invoice.snapshot?.issuer, invoice.snapshot?.document.terms);
  const client = clientForSnapshot(invoice.snapshot?.customer, workspace.clients.find((item) => item.id === printedInvoice.clientId));
  const initialStored = invoice.snapshot?.qrBill ?? invoice.qrBill ?? null;
  const [stored, setStored] = useState<StoredSwissQrBill | null>(initialStored);
  const [loadingStored, setLoadingStored] = useState(!initialStored);
  const [referenceType, setReferenceType] = useState<SwissQrBillInput['referenceType'] | ''>('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const amountCents = documentTotals(printedInvoice.lines).totalCents;
  const capacityError = invoicePrintCapacityError(invoice);

  useEffect(() => {
    if (initialStored) return;
    let active = true;
    void desktopApi.getInvoiceQrBill(invoice.id)
      .then((value) => { if (active) setStored(value); })
      .catch((reason) => { if (active) setErrors([errorMessage(reason, 'La QR-facture figée n’a pas pu être relue.')]); })
      .finally(() => { if (active) setLoadingStored(false); });
    return () => { active = false; };
  }, [initialStored, invoice.id]);

  if (loadingStored) return <Modal title="QR-facture suisse" description="Recherche de la version enregistrée localement." onClose={close}><div className="compact-empty"><LoaderCircle className="spin" size={20} /><span>Chargement de la QR-facture…</span></div></Modal>;

  if (stored) {
    const input = stored.input;
    return <Modal title="QR-facture suisse figée" description="La réimpression utilise exactement le payload enregistré et audité pour cette facture." onClose={close} wide>{capacityError ? <div className="qr-validation qr-validation--error"><strong>Impression bloquée</strong><p>{capacityError}</p></div> : null}<div className="qr-preflight"><section><span>CRÉANCIER FIGÉ</span><strong>{input.creditor.name}</strong><p>{input.creditor.street} {input.creditor.buildingNumber}<br />{input.creditor.postalCode} {input.creditor.city} · {input.creditor.country}</p></section><section><span>DÉBITEUR FIGÉ</span><strong>{input.debtor?.name || '—'}</strong><p>{input.debtor ? <>{input.debtor.street} {input.debtor.buildingNumber}<br />{input.debtor.postalCode} {input.debtor.city} · {input.debtor.country}</> : 'Non renseigné'}</p></section><section><span>PAYLOAD FIGÉ</span><strong>{formatMoney(input.amountCents)}</strong><p>{stored.referenceType} · {stored.frozenAt ? `figé le ${formatDateTime(stored.frozenAt)}` : 'figé localement'}</p></section></div><div className="info-strip"><LockKeyhole size={17} /><span>Le compte, les adresses, le montant, la référence et les informations supplémentaires ne peuvent plus être modifiés. Une correction exige un document correctif.</span></div>{errors.length ? <ErrorPanel message={errors.join(' ')} /> : null}<div className="form-actions"><Button variant="secondary" onClick={close}>Fermer</Button><Button disabled={Boolean(capacityError)} onClick={() => onReady(invoice, stored)}><Printer size={16} /> Ouvrir l’aperçu figé</Button></div></Modal>;
  }

  return <Modal title="Créer la QR-facture suisse" description="Cette première version sera validée, enregistrée et figée localement pour toutes les réimpressions." onClose={close} wide><form onSubmit={submitForm(async (form) => {
    if (!client || !referenceType || capacityError) return;
    const input: SwissQrBillInput = {
      iban: settings.billing.iban,
      creditor: { name: settings.billing.accountHolder || settings.organization.legalName, street: settings.organization.address.street, buildingNumber: settings.organization.address.buildingNumber ?? '', postalCode: settings.organization.address.postalCode, city: settings.organization.address.city, country: settings.organization.address.country.toUpperCase() },
      amountCents,
      currency: 'CHF',
      debtor: { name: client.company || client.name, street: client.addressLine1 ?? '', buildingNumber: client.buildingNumber ?? client.addressLine2 ?? '', postalCode: client.postalCode ?? '', city: client.city ?? '', country: (client.country ?? '').toUpperCase() },
      referenceType,
      reference: referenceType === 'NON' ? '' : String(form.get('reference')).replace(/\s/g, ''),
      unstructuredMessage: String(form.get('message')),
      billInformation: String(form.get('billInformation')),
      alternativeProcedures: [],
    };
    setBusy(true); setErrors([]); setWarnings([]);
    try {
      const validation = await desktopApi.validateSwissQrBill(input);
      setWarnings(validation.warnings);
      if (!validation.valid) { setErrors(validation.errors); return; }
      const saved = await desktopApi.saveInvoiceQrBill(invoice.id, validation.normalized);
      setStored(saved);
      onReady(invoice, saved);
    } catch (reason) { setErrors([errorMessage(reason, 'La QR-facture n’a pas pu être enregistrée.')]); }
    finally { setBusy(false); }
  })}>{capacityError ? <div className="qr-validation qr-validation--error"><strong>Impression bloquée</strong><p>{capacityError}</p></div> : null}<div className="qr-preflight"><section><span>CRÉANCIER DU SNAPSHOT</span><strong>{settings.billing.accountHolder || settings.organization.legalName}</strong><p>{settings.organization.address.street} {settings.organization.address.buildingNumber}<br />{settings.organization.address.postalCode} {settings.organization.address.city} · {settings.organization.address.country || 'Pays manquant'}</p></section><section><span>DÉBITEUR DU SNAPSHOT</span><strong>{client?.company || client?.name || 'Client introuvable'}</strong><p>{client?.addressLine1 || 'Rue manquante'} {client?.buildingNumber}<br />{client?.postalCode || 'NPA manquant'} {client?.city || 'Localité manquante'} · {client?.country || 'Pays manquant'}</p></section><section><span>MONTANT FIGÉ</span><strong>{formatMoney(amountCents)}</strong><p>{settings.billing.iban || 'IBAN manquant'}</p></section></div><div className="form-grid"><Field label="Type de référence" required><select value={referenceType} onChange={(event) => setReferenceType(event.target.value as SwissQrBillInput['referenceType'] | '')} required disabled={Boolean(capacityError)}><option value="">Choisir selon votre IBAN</option><option value="QRR">QRR · référence QR 27 chiffres</option><option value="SCOR">SCOR · Creditor Reference ISO 11649</option><option value="NON">NON · sans référence structurée</option></select></Field>{referenceType !== '' && referenceType !== 'NON' ? <Field label={referenceType === 'QRR' ? 'Référence QR (27 chiffres)' : 'Creditor Reference (RF…)'} required><input name="reference" required /></Field> : null}<Field label="Message non structuré" wide hint="La longueur est contrôlée selon la norme SIX."><textarea name="message" rows={3} /></Field><Field label="Informations de facture structurées" wide hint="Facultatif; ne renseignez que si votre format est conforme."><input name="billInformation" /></Field></div>{errors.length ? <div className="qr-validation qr-validation--error"><strong>Enregistrement bloqué</strong>{errors.map((error) => <p key={error}>{error}</p>)}</div> : null}{warnings.length ? <div className="qr-validation"><strong>Avertissements</strong>{warnings.map((warning) => <p key={warning}>{warning}</p>)}</div> : null}<div className="info-strip"><LockKeyhole size={17} /><span>Après validation, le payload SPC sera figé et réutilisé à l’identique; aucune donnée QR ne sera régénérée librement.</span></div><FormActions onCancel={close} busy={busy || Boolean(capacityError)} submitLabel="Valider, figer et ouvrir l’aperçu" /></form></Modal>;
}

function PrintSheet({ target, workspace, onClose }: { target: Exclude<PrintTarget, null>; workspace: Workspace; onClose: () => void }) {
  if (target.entity === 'invoices') return <InvoicePrintSheet invoice={target.value} qr={target.qr} workspace={workspace} onClose={onClose} />;
  if (target.entity === 'payslips') return <PayslipPrintSheet payslip={target.value} workspace={workspace} onClose={onClose} />;
  const source = target.value as Quote;
  const document = quoteForPrint(source);
  const settings = settingsForSnapshot(workspace.settings!, source.snapshot?.issuer, source.snapshot?.document.terms);
  const client = clientForSnapshot(source.snapshot?.customer, workspace.clients.find((item) => item.id === document.clientId));
  const totals = documentTotals(document.lines);
  const isQuote = true;
  const due = document.validUntil;
  return <div className="print-preview"><div className="print-preview__toolbar"><strong>Aperçu d’impression</strong><span>Vérifiez les informations avant impression.</span><Button variant="secondary" onClick={() => window.print()}><Printer size={16} /> Imprimer</Button><Button variant="ghost" size="icon" onClick={onClose}><X size={18} /></Button></div><article className="print-sheet"><PrintHeader settings={settings} title={isQuote ? 'DEVIS' : 'FACTURE'} number={document.number} /><div className="print-meta"><div><span>Émis le</span><strong>{formatDate(document.issueDate)}</strong></div><div><span>{isQuote ? 'Valable jusqu’au' : 'Échéance'}</span><strong>{formatDate(due)}</strong></div></div><section className="print-recipient"><span>DESTINATAIRE</span><strong>{client?.company || client?.name || '—'}</strong><p>{client?.address || '—'}<br />{client?.email || ''}</p></section><h2 className="print-title">{document.title}</h2><table className="print-table"><thead><tr><th>Description</th><th>Qté</th><th>Unité</th><th>Prix unitaire</th><th>Remise</th><th>TVA</th><th>Total net</th></tr></thead><tbody>{document.lines.map((line) => <tr key={line.id}><td>{line.description}</td><td>{line.quantity.toLocaleString('fr-CH')}</td><td>{line.unit}</td><td>{formatMoney(line.unitPriceCents)}</td><td>{line.discountBp ? `${(line.discountBp / 100).toLocaleString('fr-CH')} %` : '—'}</td><td>{settings.organization.vatRegistered ? `${(line.vatRateBp / 100).toLocaleString('fr-CH')} %` : '—'}</td><td>{formatMoney(documentLineTotals(line).netCents)}</td></tr>)}</tbody></table><div className="print-totals"><div><span>Sous-total avant remise</span><strong>{formatMoney(totals.subtotalCents)}</strong></div>{totals.discountCents ? <div><span>Remises</span><strong>− {formatMoney(totals.discountCents)}</strong></div> : null}<div><span>Total net</span><strong>{formatMoney(totals.netCents)}</strong></div><div><span>TVA</span><strong>{formatMoney(totals.vatCents)}</strong></div><div className="print-totals__grand"><span>Total TTC</span><strong>{formatMoney(totals.totalCents)}</strong></div></div><footer className="print-footer"><p>{document.notes}</p><p><strong>IBAN</strong> · {settings.billing.iban}<br />{settings.billing.defaultFooter}</p></footer></article></div>;
}

function PayslipPrintSheet({ payslip, workspace, onClose }: { payslip: Payslip; workspace: Workspace; onClose: () => void }) {
  const frozen = payslip.snapshot;
  const [contributions, setContributions] = useState<PayslipContributionSnapshot[] | null>(frozen?.contributions ?? null);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState('');
  const settings = settingsForSnapshot(workspace.settings!, frozen?.issuer);
  const employee = frozen?.employee ?? workspace.employees.find((item) => item.id === payslip.employeeId);
  const printedPayslip = frozen ? { ...payslip, period: frozen.period, paymentDate: payslip.status === 'paid' && payslip.paymentDate ? payslip.paymentDate : frozen.paymentDate, notes: frozen.notes, lines: frozen.items } : payslip;
  const totals = payslipTotals(printedPayslip);

  useEffect(() => {
    if (frozen) return;
    let active = true;
    void desktopApi.getPayslipContributions(payslip.id)
      .then((rows) => { if (active) setContributions(rows); })
      .catch((reason) => { if (active) setError(errorMessage(reason, 'Les cotisations figées n’ont pas pu être chargées.')); });
    return () => { active = false; };
  }, [frozen, payslip.id]);

  const snapshots = new Map((contributions ?? []).map((contribution) => [contribution.payslipItemId, contribution]));
  const orderedLines = (['earning', 'reimbursement', 'deduction', 'employer'] as const).flatMap((kind) => printedPayslip.lines.filter((line) => line.kind === kind));
  const statusText = frozen ? `Document final figé le ${formatDateTime(frozen.capturedAt)}` : 'Aperçu à contrôler · non comptabilisé';
  const exportPdf = async () => {
    setExporting(true);
    setExportMessage('');
    try {
      const safeEmployee = (employee?.name || 'collaborateur').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '');
      const result = await desktopApi.exportPayslipPdf(payslip.id, `Fiche-salaire_${printedPayslip.period}_${safeEmployee}.pdf`);
      if (result) setExportMessage(result.finalDocument ? `PDF final enregistré : ${result.path}` : `PDF de contrôle enregistré : ${result.path}`);
    } catch (reason) {
      setError(errorMessage(reason, "Le PDF local n'a pas pu être généré."));
    } finally {
      setExporting(false);
    }
  };

  return <div className="print-preview">
    <div className="print-preview__toolbar">
      <strong>Aperçu de la fiche détaillée</strong>
      <span>{error || exportMessage || (contributions === null ? 'Chargement des valeurs figées…' : statusText)}</span>
      <Button disabled={contributions === null || Boolean(error) || exporting} onClick={() => void exportPdf()}>{exporting ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />} {exporting ? 'Génération…' : 'Exporter le PDF'}</Button>
      <Button variant="secondary" disabled={contributions === null || Boolean(error)} onClick={() => window.print()}><Printer size={16} /> Imprimer</Button>
      <Button variant="ghost" size="icon" onClick={onClose}><X size={18} /></Button>
    </div>
    {error ? <ErrorPanel message={error} /> : null}
    <article className={`print-sheet print-payslip ${frozen ? 'print-payslip--final' : 'print-payslip--review'}`}>
      <PrintHeader settings={settings} title="FICHE DE SALAIRE" number={printedPayslip.period} />
      <div className={`payslip-document-state ${frozen ? 'is-final' : 'is-review'}`}><ShieldCheck size={15} /><strong>{statusText}</strong></div>
      <div className="print-meta print-payslip-meta">
        <div><span>Période</span><strong>{printedPayslip.period}</strong></div>
        <div><span>Date de paiement</span><strong>{formatDate(printedPayslip.paymentDate)}</strong></div>
        <div><span>N° employé</span><strong>{employee?.employeeNumber || '—'}</strong></div>
        <div><span>Taux d’activité</span><strong>{employee?.employmentRate ? `${employee.employmentRate} %` : '—'}</strong></div>
      </div>
      <section className="print-recipient print-payslip-recipient">
        <span>COLLABORATEUR</span><strong>{employee?.name || '—'}</strong>
        <p>{employee?.role || 'Fonction non renseignée'}<br />{employee?.address || 'Adresse non renseignée'}<br />N° AVS · {employee?.avsNumber || 'non renseigné'}<br />IBAN · {employee?.iban || 'non renseigné'}</p>
      </section>
      <table className="print-table print-payroll-table"><thead><tr><th>Élément</th><th>Part / type</th><th>Base</th><th>Calcul figé</th><th>Montant</th></tr></thead><tbody>{orderedLines.map((line, index) => { const snapshot = snapshots.get(line.id); const previous = orderedLines[index - 1]; const group = line.kind === 'earning' ? 'Rémunération' : line.kind === 'reimbursement' ? 'Remboursements hors brut' : line.kind === 'deduction' ? 'Retenues employé' : 'Cotisations employeur · information'; return <Fragment key={line.id}>{!previous || previous.kind !== line.kind ? <tr className="payroll-print-group"><td colSpan={5}>{group}</td></tr> : null}<tr><td><strong>{line.label}</strong>{snapshot ? <small>{snapshot.source}<br />Effet {formatDate(snapshot.effectiveFrom)}{snapshot.effectiveTo ? ` → ${formatDate(snapshot.effectiveTo)}` : ''}</small> : <small>Saisie contrôlée</small>}</td><td>{snapshot ? snapshot.side === 'employee' ? 'Part employé' : 'Part employeur' : line.kind === 'earning' ? 'Gain' : line.kind === 'reimbursement' ? 'Remboursement hors brut' : line.kind === 'deduction' ? 'Retenue manuelle' : 'Charge manuelle'}</td><td>{snapshot ? <>{formatMoney(snapshot.basisCents)}{snapshot.annualCeilingCents ? <small>Cumul avant période {formatMoney(snapshot.yearToDateBasisCents)}<br />Plafond annuel {formatMoney(snapshot.annualCeilingCents)}</small> : null}</> : '—'}</td><td>{snapshot ? snapshot.calculationKind === 'rate' ? `${((snapshot.rateBp ?? 0) / 100).toLocaleString('fr-CH')} %` : `Fixe ${formatMoney(snapshot.fixedAmountCents)}` : 'Montant saisi'}</td><td>{formatMoney(line.amountCents)}</td></tr></Fragment>; })}</tbody></table>
      <div className="print-totals"><div><span>Salaire brut</span><strong>{formatMoney(totals.earnings)}</strong></div><div><span>Remboursements hors brut</span><strong>{formatMoney(totals.reimbursements)}</strong></div><div><span>Retenues employé</span><strong>{formatMoney(totals.deductions)}</strong></div><div><span>Charges employeur</span><strong>{formatMoney(totals.employer)}</strong></div><div className="print-totals__grand"><span>Net à payer</span><strong>{formatMoney(totals.net)}</strong></div></div>
      <footer className="print-footer"><p>{printedPayslip.notes}</p><p>{frozen ? 'Les valeurs et sources ont été figées lors de la comptabilisation.' : 'Document de contrôle : validez puis comptabilisez la fiche pour obtenir la version finale figée.'}</p></footer>
    </article>
  </div>;
}

function PrintHeader({ settings, title, number }: { settings: AppSettings; title: string; number: string }) {
  const org = settings.organization;
  return <header className="print-header"><div><div className="print-brand">{org.logoPath ? <img src={convertFileSrc(org.logoPath)} alt="" /> : <BrandMark size={24} />}<span>Elyko</span></div><strong>{org.legalName}</strong><p>{org.address.street} {org.address.buildingNumber}<br />{org.address.postalCode} {org.address.city}{org.uidNumber ? <><br />IDE {org.uidNumber}</> : null}{org.vatRegistered && org.vatNumber ? <><br />N° TVA {org.vatNumber}</> : null}</p></div><div><h1>{title}</h1><strong>{number || '—'}</strong></div></header>;
}

function vatBreakdown(lines: DocumentLine[]) {
  const groups = new Map<number, { rateBp: number; baseCents: number; vatCents: number }>();
  for (const line of lines) {
    const totals = documentLineTotals(line);
    const baseCents = totals.netCents;
    const current = groups.get(line.vatRateBp) ?? { rateBp: line.vatRateBp, baseCents: 0, vatCents: 0 };
    current.baseCents += baseCents;
    current.vatCents += totals.vatCents;
    groups.set(line.vatRateBp, current);
  }
  return [...groups.values()].sort((a, b) => a.rateBp - b.rateBp);
}

function InvoicePrintSheet({ invoice: sourceInvoice, qr, workspace, onClose }: { invoice: Invoice; qr?: StoredSwissQrBill; workspace: Workspace; onClose: () => void }) {
  const invoice = invoiceForPrint(sourceInvoice);
  const settings = settingsForSnapshot(workspace.settings!, sourceInvoice.snapshot?.issuer, sourceInvoice.snapshot?.document.terms);
  const client = clientForSnapshot(sourceInvoice.snapshot?.customer, workspace.clients.find((item) => item.id === invoice.clientId));
  const totals = documentTotals(invoice.lines);
  const originalSource = invoice.originalInvoiceId ? workspace.invoices.find((item) => item.id === invoice.originalInvoiceId) : undefined;
  const original = originalSource ? invoiceForPrint(originalSource) : undefined;
  const vatGroups = vatBreakdown(invoice.lines);
  const servicePeriod = invoice.serviceDateFrom === invoice.serviceDateTo ? formatDate(invoice.serviceDateFrom) : `${formatDate(invoice.serviceDateFrom)} → ${formatDate(invoice.serviceDateTo)}`;
  const capacityError = invoicePrintCapacityError(sourceInvoice);
  return <div className="print-preview"><div className="print-preview__toolbar"><strong>Aperçu d’impression</strong><span>{capacityError || (sourceInvoice.snapshot ? `Document figé le ${formatDateTime(sourceInvoice.snapshot.capturedAt)}` : qr ? 'QR-facture validée localement.' : invoice.type === 'credit_note' ? 'Avoir sans section de paiement.' : 'Facture sans section QR.')}</span><Button variant="secondary" disabled={Boolean(capacityError)} onClick={() => window.print()}><Printer size={16} /> Imprimer</Button><Button variant="ghost" size="icon" onClick={onClose}><X size={18} /></Button></div>{capacityError ? <ErrorPanel message={capacityError} /> : null}<article className={`print-sheet ${qr ? 'print-sheet--qr' : ''}`}><div className="print-invoice-body"><PrintHeader settings={settings} title={invoice.type === 'credit_note' ? 'AVOIR' : 'FACTURE'} number={invoice.number} /><div className="print-meta"><div><span>Émis le</span><strong>{formatDate(invoice.issueDate)}</strong></div><div><span>Prestation</span><strong>{servicePeriod}</strong></div>{invoice.type !== 'credit_note' ? <div><span>Échéance</span><strong>{formatDate(invoice.dueDate)}</strong></div> : <div><span>Facture corrigée</span><strong>{original?.number || '—'}</strong></div>}</div><section className="print-recipient"><span>DESTINATAIRE</span><strong>{client?.company || client?.name || '—'}</strong><p>{client?.address || '—'}<br />{client?.email || ''}</p></section><h2 className="print-title">{invoice.title}</h2><table className="print-table"><thead><tr><th>Description</th><th>Qté</th><th>Unité</th><th>Prix unitaire</th><th>Remise</th><th>TVA</th><th>Total net</th></tr></thead><tbody>{invoice.lines.map((line) => <tr key={line.id}><td>{line.description}</td><td>{line.quantity.toLocaleString('fr-CH')}</td><td>{line.unit}</td><td>{formatMoney(line.unitPriceCents)}</td><td>{line.discountBp ? `${(line.discountBp / 100).toLocaleString('fr-CH')} %` : '—'}</td><td>{settings.organization.vatRegistered ? `${(line.vatRateBp / 100).toLocaleString('fr-CH')} %` : 'Sans TVA'}</td><td>{formatMoney(documentLineTotals(line).netCents)}</td></tr>)}</tbody></table><div className="print-totals"><div><span>Sous-total avant remise</span><strong>{formatMoney(totals.subtotalCents)}</strong></div>{totals.discountCents ? <div><span>Remises</span><strong>− {formatMoney(totals.discountCents)}</strong></div> : null}<div><span>Total net</span><strong>{formatMoney(totals.netCents)}</strong></div>{settings.organization.vatRegistered ? vatGroups.map((group) => <div key={group.rateBp}><span>TVA {(group.rateBp / 100).toLocaleString('fr-CH')} % sur {formatMoney(group.baseCents)}</span><strong>{formatMoney(group.vatCents)}</strong></div>) : <div><span>TVA</span><strong>Non assujetti</strong></div>}<div className="print-totals__grand"><span>{invoice.type === 'credit_note' ? 'Total de l’avoir' : 'Total TTC'}</span><strong>{formatMoney(totals.totalCents)}</strong></div></div><footer className="print-footer"><p>{invoice.notes}</p><p>{invoice.type === 'credit_note' ? 'Cet avoir réduit la créance; aucun paiement ne doit être enregistré.' : settings.billing.defaultFooter}</p></footer></div>{qr ? <SwissQrPaymentSection input={qr.input} payload={qr} /> : null}</article></div>;
}

function SwissQrPaymentSection({ input, payload }: { input: SwissQrBillInput; payload: SwissQrPayload }) {
  const amount = input.amountCents === undefined ? '' : `${Math.trunc(input.amountCents / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}.${String(Math.abs(input.amountCents) % 100).padStart(2, '0')}`;
  const groupedIban = input.iban.replace(/\s/g, '').replace(/(.{4})/g, '$1 ').trim();
  const groupedReference = input.referenceType === 'QRR'
    ? [input.reference.slice(0, 2), ...input.reference.slice(2).match(/.{1,5}/g) ?? []].filter(Boolean).join(' ')
    : input.reference.replace(/\s/g, '').match(/.{1,4}/g)?.join(' ') ?? '';
  const address = (party: SwissQrBillInput['creditor']) => <>{party.name}<br />{party.street} {party.buildingNumber}<br />{party.postalCode} {party.city}<br />{party.country}</>;
  const extraInformation = [input.unstructuredMessage, input.billInformation].filter(Boolean);
  return <section className="swiss-qr-section"><div className="qr-separator"><span>✂</span></div><section className="qr-receipt"><h2>Récépissé</h2><div className="qr-copy"><strong>Compte / Payable à</strong><p>{groupedIban}<br />{address(input.creditor)}</p></div>{groupedReference ? <div className="qr-copy"><strong>Référence</strong><p>{groupedReference}</p></div> : null}{input.debtor ? <div className="qr-copy"><strong>Payable par</strong><p>{address(input.debtor)}</p></div> : null}<div className="qr-amount-small"><span>Monnaie<br /><strong>{input.currency}</strong></span><span>Montant<br /><strong>{amount}</strong></span></div><strong className="qr-acceptance">Point de dépôt</strong></section><span className="qr-vertical-separator" aria-hidden="true">✂</span><section className="qr-payment"><h2>Section paiement</h2><div className="qr-payment-grid"><div className="qr-code-wrap"><QRCodeSVG value={payload.payload} level="M" size={174} marginSize={0} /><span className="swiss-cross" aria-hidden="true"><i /><b /></span></div><div><div className="qr-copy"><strong>Compte / Payable à</strong><p>{groupedIban}<br />{address(input.creditor)}</p></div>{groupedReference ? <div className="qr-copy"><strong>Référence</strong><p>{groupedReference}</p></div> : null}{extraInformation.length ? <div className="qr-copy"><strong>Informations supplémentaires</strong><p>{extraInformation.map((value, index) => <span key={`${value}-${index}`}>{index ? <br /> : null}{value}</span>)}</p></div> : null}{input.debtor ? <div className="qr-copy"><strong>Payable par</strong><p>{address(input.debtor)}</p></div> : null}</div></div><div className="qr-amount"><span>Monnaie<br /><strong>{input.currency}</strong></span><span>Montant<br /><strong>{amount}</strong></span></div></section></section>;
}
