import {
  Fragment,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
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
  ClipboardCheck,
  Clock3,
  CloudUpload,
  Database,
  Download,
  Eye,
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
  Mail,
  MapPin,
  MoreHorizontal,
  Package,
  Pause,
  Pencil,
  Play,
  Phone,
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
import { desktopApi, type CloudAccountState } from './bridge';
import { salesPdfSuggestedFileName } from './salesPdfExport';
import { BrandMark, BrandWordmark, CompanyAvatar } from './BrandMark';
import type { AgendaEventDraft } from './AgendaScreen';
import { agendaNavigationTarget, type AgendaItem } from './agenda';
import { APP_UPDATER_TARGET_ID, AppUpdater } from './AppUpdater';
import { CloudAccountPanel } from './CloudAccountPanel';
import { BusinessProfileFields } from './BusinessProfileEditor';
import {
  PaymentAccountingProofs,
  type AccountingEntryFocus,
} from './PaymentAccountingProofs';
import { PayrollContributionsPanel } from './PayrollContributionsPanel';
import { assessPayrollPaymentDate } from './payrollPaymentDate';
import { SwissPayrollRulesPanel } from './SwissPayrollRulesPanel';
import { DocumentEditor } from './DocumentEditor';
import {
  CatalogItemForm,
  CatalogScreen,
  StockMovementForm,
} from './CatalogScreen';
import {
  ExpenseForm,
  LegacyExpenseDetail,
  SupplierForm,
  SupplierInvoiceDetail,
  SupplierInvoiceForm,
  SupplierPaymentForm,
} from './PurchasesScreen';
import { DetailedPayslipForm } from './DetailedPayslipForm';
import { parseSmallSalaryEmployeeForm } from './smallSalaryAssessment';
import { GuidedTour, useGuidedTour, type TourView } from './GuidedTour';
import { GettingStartedChecklist } from './GettingStartedChecklist';
import {
  buildGettingStartedJourney,
  type GettingStartedAction,
} from './gettingStarted';
import {
  SETTINGS_READINESS_TARGETS,
  SetupReadinessCenter,
  buildSetupReadiness,
  confirmDeferredSetup,
} from './SetupReadinessCenter';

import { TimeBillingWizard } from './TimeBillingWizard';
import {
  DeliveryNotePrintPreview,
  SalesOrderPrintPreview,
  SalesOrdersScreen,
  SalesTabs,
  type SalesView,
} from './SalesOrdersScreen';
import {
  ProjectPlanningPanel,
  type ProjectMilestoneDraft,
  type ProjectTaskDraft,
} from './ProjectPlanningPanel';
import {
  processRecurrenceScheduleBatch,
  recurrenceSchedulesDue,
} from './recurrenceUi';
import type {
  Account,
  AccountingPeriod,
  AccountingSettings,
  AppSettings,
  BalanceSheetReport,
  Client,
  CatalogItem,
  DeliveryNote,
  DocumentLine,
  Employee,
  EntityKind,
  Expense,
  FrozenCustomer,
  FrozenIssuer,
  Invoice,
  InvoiceCorrectionWorkflow,
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
  ProjectMilestone,
  ProjectPlanningStatus,
  ProjectTask,
  Quote,
  Reminder,
  ReminderHistory,
  ReminderSettings,
  ReminderTemplate,
  SalesOrder,
  StockMovementType,
  StoredSwissQrBill,
  Supplier,
  SupplierInvoice,
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
import {
  Button,
  EmptyState,
  ErrorPanel,
  Field,
  FormActions,
  Modal,
  SectionHeading,
  StatusBadge,
  submitForm,
} from './ui';
import { projectTerminology } from './terminology';
import {
  COMPACT_NAVIGATION_QUERY,
  compactSidebarHidden,
} from './compactNavigation';
import {
  creationBlockReason,
  timerBlockReason,
  type WorkspacePrerequisites,
} from './workflowGuards';
import {
  availabilityForCatalogItem,
  quoteRequiresSalesOrder,
} from './orderFlow';
import {
  invoiceCorrectionWorkflowFor,
  invoiceModificationAction,
  reserveDocumentAction,
} from './documentUi';

const PayrollImportWizard = lazy(() =>
  import('./PayrollImportWizard').then((module) => ({
    default: module.PayrollImportWizard,
  })),
);
const AccountingScreen = lazy(() =>
  import('./AccountingScreen').then((module) => ({
    default: module.AccountingScreen,
  })),
);
const AgendaScreen = lazy(() =>
  import('./AgendaScreen').then((module) => ({
    default: module.AgendaScreen,
  })),
);
const RemindersScreen = lazy(() =>
  import('./RemindersScreen').then((module) => ({
    default: module.RemindersScreen,
  })),
);
const PurchaseOrdersScreen = lazy(() =>
  import('./PurchaseOrdersScreen').then((module) => ({
    default: module.PurchaseOrdersScreen,
  })),
);
const BankScreen = lazy(() =>
  import('./BankScreen').then((module) => ({
    default: module.BankScreen,
  })),
);

function ViewLoading({ label }: { label: string }) {
  return (
    <div className="settings-cloud-status" role="status">
      <LoaderCircle className="spin" size={20} />
      <span>{label}</span>
    </div>
  );
}

type View = TourView | 'orders' | 'agenda';
type ModalState =
  | { type: 'client'; item?: Client }
  | { type: 'clientDetail'; client: Client }
  | { type: 'catalogItem'; item?: CatalogItem }
  | {
      type: 'stockMovement';
      item: CatalogItem;
      movementType: StockMovementType;
      requestId: string;
      reservedMilli: number;
    }
  | { type: 'supplier'; item?: Supplier }
  | { type: 'project'; item?: Project }
  | {
      type: 'document';
      entity: 'quotes' | 'invoices';
      item?: Quote | Invoice;
      quoteSource?: Quote;
    }
  | { type: 'invoiceCorrection'; invoice: Invoice }
  | { type: 'time'; item?: TimeEntry }
  | { type: 'timeBilling' }
  | { type: 'employee'; item?: Employee }
  | { type: 'expense'; item?: Expense }
  | { type: 'legacyExpenseDetail'; expense: Expense }
  | { type: 'supplierInvoice'; item?: SupplierInvoice }
  | { type: 'supplierInvoiceDetail'; invoice: SupplierInvoice }
  | { type: 'supplierPayment'; invoice: SupplierInvoice }
  | { type: 'payslip'; item?: Payslip }
  | { type: 'payrollImport' }
  | { type: 'payslipPayment'; payslip: Payslip }
  | { type: 'payment'; invoice: Invoice }
  | { type: 'qrPrint'; invoice: Invoice }
  | { type: 'timer' }
  | null;

type PrintTarget =
  | { entity: 'quotes'; value: Quote }
  | { entity: 'invoices'; value: Invoice; qr?: StoredSwissQrBill }
  | { entity: 'sales_orders'; value: SalesOrder }
  | { entity: 'delivery_notes'; value: DeliveryNote; order: SalesOrder }
  | { entity: 'payslips'; value: Payslip }
  | null;
type Notice = { tone: 'success' | 'warning' | 'error'; text: string };

const navigation: Array<{
  id: View;
  label: string;
  icon: typeof LayoutDashboard;
  group?: string;
}> = [
  { id: 'dashboard', label: 'Tableau de bord', icon: LayoutDashboard },
  { id: 'agenda', label: 'Agenda', icon: CalendarDays },
  { id: 'projects', label: 'Chantiers / projets', icon: FolderKanban },
  { id: 'clients', label: 'Clients', icon: UserRound },
  { id: 'catalog', label: 'Produits & services', icon: Package },
  { id: 'quotes', label: 'Ventes', icon: BriefcaseBusiness, group: 'Gestion' },
  { id: 'reminders', label: 'Relances', icon: MessageSquareWarning },
  { id: 'time', label: 'Temps', icon: Clock3 },
  { id: 'team', label: 'Équipe & salaires', icon: Users },
  { id: 'expenses', label: 'Achats & fournisseurs', icon: WalletCards },
  { id: 'bank', label: 'Banque', icon: Banknote },
  { id: 'reports', label: 'Rapports', icon: BarChart3, group: 'Pilotage' },
  { id: 'accounting', label: 'Comptabilité', icon: Landmark },
  { id: 'settings', label: 'Paramètres', icon: Settings },
];

const viewTitles: Record<View, [string, string]> = {
  dashboard: [
    'Tableau de bord',
    'Votre activité réelle, sans données de démonstration',
  ],
  agenda: [
    'Agenda',
    'Rendez-vous et échéances réelles réunis au même endroit',
  ],
  projects: ['Chantiers', 'Budget, durée, temps et rentabilité par chantier'],
  clients: ['Clients', 'Coordonnées et historique des travaux'],
  catalog: [
    'Produits & services',
    'Références réutilisables pour vos devis et factures',
  ],
  quotes: ['Ventes', 'Devis, commandes, livraisons et factures sans ressaisie'],
  orders: ['Ventes', 'Commandes, réservations et livraisons partielles'],
  invoices: ['Ventes', 'Factures, encaissements et soldes ouverts'],
  reminders: [
    'Relances',
    'Échéances, niveaux et historique des actions locales',
  ],
  time: ['Temps', 'Pointage réel et heures par chantier'],
  team: ['Équipe & salaires', 'Collaborateurs et fiches sans retenue estimée'],
  expenses: [
    'Achats & fournisseurs',
    'Échéances, dépenses payées et annuaire local',
  ],
  bank: ['Banque', 'Import CAMT local et rapprochements confirmés'],
  reports: ['Rapports', 'Rentabilité calculée à partir de vos saisies'],
  accounting: [
    'Comptabilité',
    'Partie double, journaux et états financiers locaux',
  ],
  settings: ['Paramètres', 'Entreprise, confidentialité et portabilité'],
};

export function WorkspaceApp({
  workspace,
  setWorkspace,
  readOnly = false,
  readOnlySource = 'license',
  cloudAccount,
  onCloudAccountChange,
}: {
  workspace: Workspace;
  setWorkspace: Dispatch<SetStateAction<Workspace | null>>;
  readOnly?: boolean;
  readOnlySource?: 'license' | 'cloud';
  cloudAccount?: CloudAccountState | null;
  onCloudAccountChange?: (account: CloudAccountState) => void;
}) {
  const [view, setView] = useState<View>('dashboard');
  const [modal, setModal] = useState<ModalState>(null);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [compactNavigation, setCompactNavigation] = useState(() =>
    typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia(COMPACT_NAVIGATION_QUERY).matches,
  );
  const [orderToOpenId, setOrderToOpenId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [timerSeconds, setTimerSeconds] = useState(0);
  const [printTarget, setPrintTarget] = useState<PrintTarget>(null);
  const [accountingEntryFocus, setAccountingEntryFocus] =
    useState<AccountingEntryFocus | null>(null);
  const [reminderRefreshSignal, setReminderRefreshSignal] = useState(0);
  const [settingsFocusTarget, setSettingsFocusTarget] = useState<string | null>(
    null,
  );
  const [agendaPlanningTarget, setAgendaPlanningTarget] = useState<
    string | null
  >(null);
  const reminderScanInFlight = useRef(false);
  const reminderRequestIds = useRef(new Map<string, string>());
  const recurrenceScanInFlight = useRef(false);
  const recurrenceRequestIds = useRef(new Map<string, string>());
  const workspaceRef = useRef(workspace);
  const actionInFlight = useRef(false);
  const quoteOrderRequestIds = useRef(new Map<string, string>());
  const quoteRevisionInFlight = useRef(new Set<string>());
  const guidedTour = useGuidedTour();
  const sidebarHidden = compactSidebarHidden(compactNavigation, menuOpen);
  const readOnlyMutationMessage = readOnlySource === 'cloud'
    ? 'Votre rôle « Lecture seule » bloque les modifications sur ce poste. La consultation et les exports restent disponibles.'
    : 'La licence doit être active pour modifier les données. Lecture, sauvegarde et export restent disponibles.';

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(COMPACT_NAVIGATION_QUERY);
    const synchronize = () => setCompactNavigation(media.matches);
    synchronize();
    media.addEventListener('change', synchronize);
    return () => media.removeEventListener('change', synchronize);
  }, []);
  const navigateTour = useCallback((nextView: TourView) => {
    setAccountingEntryFocus(null);
    setView(nextView);
    setSearch('');
    setMenuOpen(false);
  }, []);
  const openAccountingEntry = useCallback((focus: AccountingEntryFocus) => {
    setAccountingEntryFocus(focus);
    setView('accounting');
    setSearch('');
    setMenuOpen(false);
  }, []);
  const clearAccountingEntryFocus = useCallback(
    () => setAccountingEntryFocus(null),
    [],
  );
  const openUpdater = useCallback(() => {
    setAccountingEntryFocus(null);
    setView('settings');
    setSearch('');
    setMenuOpen(false);
    setSettingsFocusTarget(APP_UPDATER_TARGET_ID);
  }, []);
  const settings = workspace.settings!;
  const terminology = projectTerminology(settings.business.nogaSection);
  const recurrenceScheduleSignal = workspace.recurrenceSchedules
    .map(
      (schedule) =>
        `${schedule.id}:${schedule.status}:${schedule.nextScheduledFor}:${schedule.updatedAt}`,
    )
    .join('|');

  function openAgendaItem(item: AgendaItem) {
    const target = agendaNavigationTarget(item);
    if (!target) return;
    setAccountingEntryFocus(null);
    setAgendaPlanningTarget(null);
    setView(target.route);
    setSearch('');
    setMenuOpen(false);
    if (target.source === 'task' || target.source === 'milestone') {
      setAgendaPlanningTarget(target.sourceId);
      return;
    }
    if (target.source === 'project') {
      const project = workspace.projects.find(
        (candidate) => candidate.id === target.sourceId,
      );
      if (project) setModal({ type: 'project', item: project });
      return;
    }
    if (target.source === 'invoice') {
      const invoice = workspace.invoices.find(
        (candidate) => candidate.id === target.sourceId,
      );
      if (invoice)
        setModal({ type: 'document', entity: 'invoices', item: invoice });
      return;
    }
    if (target.source === 'quote') {
      const quote = workspace.quotes.find(
        (candidate) => candidate.id === target.sourceId,
      );
      if (quote) setModal({ type: 'document', entity: 'quotes', item: quote });
      return;
    }
    if (target.source === 'supplier_invoice') {
      const invoice = workspace.supplierInvoices.find(
        (candidate) => candidate.id === target.sourceId,
      );
      if (invoice) setModal({ type: 'supplierInvoiceDetail', invoice });
      return;
    }
    if (target.source === 'payslip') {
      const payslip = workspace.payslips.find(
        (candidate) => candidate.id === target.sourceId,
      );
      if (payslip) setModal({ type: 'payslip', item: payslip });
    }
  }

  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);

  useEffect(() => {
    if (view !== 'settings' || !settingsFocusTarget) return;
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const target = document.getElementById(settingsFocusTarget);
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        target?.focus({ preventScroll: true });
        setSettingsFocusTarget(null);
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [settingsFocusTarget, view]);

  useEffect(() => {
    if (!workspace.activeTimer) {
      setTimerSeconds(0);
      return;
    }
    const update = () =>
      setTimerSeconds(
        Math.max(
          0,
          Math.floor(
            (Date.now() -
              new Date(workspace.activeTimer!.startedAt).getTime()) /
              1000,
          ),
        ),
      );
    update();
    const interval = window.setInterval(update, 1000);
    return () => window.clearInterval(interval);
  }, [workspace.activeTimer]);

  const runRecurrenceScan = useCallback(async () => {
    if (readOnly || recurrenceScanInFlight.current) return;
    if (
      typeof document !== 'undefined' &&
      document.visibilityState === 'hidden'
    )
      return;
    const throughDate = todayIso();
    const initialWorkspace = workspaceRef.current;
    const dueSchedules = recurrenceSchedulesDue(
      initialWorkspace.recurrenceSchedules,
      throughDate,
    );
    if (!dueSchedules.length) return;

    recurrenceScanInFlight.current = true;
    const previousOccurrenceIds = new Set(
      initialWorkspace.recurrenceOccurrences.map((item) => item.id),
    );
    try {
      const batch = await processRecurrenceScheduleBatch({
        schedules: dueSchedules,
        throughDate,
        requestIdFor: (schedule) => {
          const requestKey = `${schedule.id}:${throughDate}`;
          let requestId = recurrenceRequestIds.current.get(requestKey);
          if (!requestId) {
            requestId = createId();
            recurrenceRequestIds.current.set(requestKey, requestId);
          }
          return requestId;
        },
        generate: (input) => desktopApi.generateRecurrenceOccurrences(input),
        onSuccess: (nextWorkspace, schedule) => {
          workspaceRef.current = nextWorkspace;
          setWorkspace(nextWorkspace);
          recurrenceRequestIds.current.delete(`${schedule.id}:${throughDate}`);
        },
      });
      const latestWorkspace = batch.latestResult ?? initialWorkspace;
      const createdCount = latestWorkspace.recurrenceOccurrences.filter(
        (item) => !previousOccurrenceIds.has(item.id),
      ).length;
      const reviewCount = dueSchedules.filter((due) =>
        latestWorkspace.recurrenceSchedules.some(
          (item) =>
            item.id === due.id && item.status === 'review_required',
        ),
      ).length;
      const failureCount = batch.failures.length;
      if (failureCount > 0 && createdCount > 0) {
        setNotice({
          tone: 'warning',
          text: `${createdCount} facture${createdCount > 1 ? 's' : ''} brouillon ${createdCount > 1 ? 'ont' : 'a'} été préparée${createdCount > 1 ? 's' : ''} localement, mais ${failureCount} planification${failureCount > 1 ? 's ont' : ' a'} échoué. Les brouillons réussis sont conservés ; aucune facture n’a été émise.`,
        });
      } else if (failureCount > 0) {
        setNotice({
          tone: 'error',
          text: errorMessage(
            batch.failures[0]?.reason,
            `Le contrôle local de ${failureCount} planification${failureCount > 1 ? 's' : ''} a échoué. Aucune facture n’a été émise.`,
          ),
        });
      } else if (createdCount > 0) {
        setNotice({
          tone: reviewCount > 0 ? 'warning' : 'success',
          text: `${createdCount} facture${createdCount > 1 ? 's' : ''} brouillon ${createdCount > 1 ? 'ont' : 'a'} été préparée${createdCount > 1 ? 's' : ''} localement. Contrôlez chaque facture avant émission.${reviewCount > 0 ? ' Une planification exige une reprise explicite.' : ''}`,
        });
      } else if (reviewCount > 0) {
        setNotice({
          tone: 'warning',
          text: 'Une planification récurrente exige un contrôle avant de pouvoir reprendre.',
        });
      }
    } catch (reason) {
      setNotice({
        tone: 'error',
        text: errorMessage(
          reason,
          'Le contrôle local des documents récurrents a échoué. Aucune facture n’a été émise.',
        ),
      });
    } finally {
      recurrenceScanInFlight.current = false;
    }
  }, [readOnly, setWorkspace]);

  useEffect(() => {
    if (readOnly) return;
    const runWhenVisible = () => {
      if (
        typeof document === 'undefined' ||
        document.visibilityState === 'visible'
      )
        void runRecurrenceScan();
    };
    runWhenVisible();
    window.addEventListener('focus', runWhenVisible);
    document.addEventListener('visibilitychange', runWhenVisible);
    const interval = window.setInterval(runWhenVisible, 5 * 60 * 1000);
    return () => {
      window.removeEventListener('focus', runWhenVisible);
      document.removeEventListener('visibilitychange', runWhenVisible);
      window.clearInterval(interval);
    };
  }, [readOnly, recurrenceScheduleSignal, runRecurrenceScan]);

  const runReminderScan = useCallback(async () => {
    if (readOnly || reminderScanInFlight.current) return;
    if (
      typeof document !== 'undefined' &&
      document.visibilityState === 'hidden'
    )
      return;
    reminderScanInFlight.current = true;
    const asOf = todayIso();
    try {
      const reminderSettings = await desktopApi.getReminderSettings();
      if (!reminderSettings.enabled) return;
      let requestId = reminderRequestIds.current.get(asOf);
      if (!requestId) {
        requestId = createId();
        reminderRequestIds.current.set(asOf, requestId);
      }
      const result = await desktopApi.scanDueReminders(requestId, asOf);
      reminderRequestIds.current.delete(asOf);
      setReminderRefreshSignal((value) => value + 1);
      const reminderAnomalies = result.review.filter(
        (item) => item.reason !== 'already_open' && item.reason !== 'cycle_stopped',
      );
      if (reminderAnomalies.length) {
        setNotice({
          tone: 'error',
          text: `${reminderAnomalies.length} ancien${reminderAnomalies.length > 1 ? 's' : ''} cycle${reminderAnomalies.length > 1 ? 's' : ''} de relance exige${reminderAnomalies.length > 1 ? 'nt' : ''} un contrôle manuel. Aucune étape suivante n’a été créée.`,
        });
      } else if (result.created.length || result.cancelled.length) {
        setNotice({
          tone: 'success',
          text: `${result.created.length} relance${result.created.length > 1 ? 's' : ''} à valider et ${result.cancelled.length} arrêtée${result.cancelled.length > 1 ? 's' : ''} après règlement. Aucun message n’a été envoyé.`,
        });
      }
    } catch (reason) {
      setNotice({
        tone: 'error',
        text: errorMessage(
          reason,
          'Le contrôle automatique local des échéances a échoué. Aucun message n’a été envoyé.',
        ),
      });
    } finally {
      reminderScanInFlight.current = false;
    }
  }, [readOnly]);

  useEffect(() => {
    if (readOnly) return;
    const runWhenVisible = () => {
      if (
        typeof document === 'undefined' ||
        document.visibilityState === 'visible'
      )
        void runReminderScan();
    };
    runWhenVisible();
    window.addEventListener('focus', runWhenVisible);
    document.addEventListener('visibilitychange', runWhenVisible);
    const interval = window.setInterval(runWhenVisible, 5 * 60 * 1000);
    return () => {
      window.removeEventListener('focus', runWhenVisible);
      document.removeEventListener('visibilitychange', runWhenVisible);
      window.clearInterval(interval);
    };
  }, [readOnly, runReminderScan]);

  async function act(
    action: () => Promise<Workspace>,
    message: string,
    close = true,
    onError?: (reason: unknown) => void,
  ) {
    if (readOnly) {
      setNotice({
        tone: 'error',
        text: readOnlyMutationMessage,
      });
      return false;
    }
    if (actionInFlight.current) return false;
    actionInFlight.current = true;
    setBusy(true);
    setNotice(null);
    try {
      setWorkspace(await action());
      setNotice({ tone: 'success', text: message });
      if (close) setModal(null);
      return true;
    } catch (reason) {
      onError?.(reason);
      // Une commande locale peut avoir été validée juste avant qu'un
      // rafraîchissement échoue. Relire au mieux évite alors une interface
      // périmée et rend le prochain essai sûr.
      try {
        setWorkspace(await desktopApi.loadWorkspace());
      } catch {
        // Le message d'origine reste le plus utile lorsque la relecture échoue aussi.
      }
      setNotice({
        tone: 'error',
        text: errorMessage(reason, 'L’action locale a échoué.'),
      });
      return false;
    } finally {
      actionInFlight.current = false;
      setBusy(false);
    }
  }

  async function archiveInvoiceToCloud(item: Invoice, issuedNow = false) {
    setBusy(true);
    if (!issuedNow) setNotice(null);
    try {
      let result;
      try {
        result = await desktopApi.archiveInvoiceToCloud(item.id);
      } catch (reason) {
        const message = errorMessage(reason, 'Le coffre Zentra est indisponible.');
        if (!message.includes('motif de correction')) throw reason;
        const correctionReason = window.prompt(
          'Le PDF diffère de la version déjà archivée. Indiquez précisément le motif de cette nouvelle version :',
        );
        if (!correctionReason) throw new Error('Archivage annulé : motif requis.');
        result = await desktopApi.archiveInvoiceToCloud(
          item.id,
          correctionReason,
        );
      }
      setNotice({
        tone: 'success',
        text: result.alreadyStored
          ? `La version ${result.revision} est déjà intacte dans le coffre jusqu’au ${formatDate(result.retentionUntil)}.`
          : `Version ${result.revision} archivée avec empreinte SHA-256 jusqu’au ${formatDate(result.retentionUntil)}.`,
      });
    } catch (reason) {
      setNotice({
        tone: issuedNow ? 'warning' : 'error',
        text: `${issuedNow ? 'La facture a bien été émise localement, mais ' : ''}${errorMessage(
          reason,
          'le coffre Zentra n’a pas pu recevoir le PDF.',
        )}`,
      });
    } finally {
      setBusy(false);
    }
  }

  async function issueInvoice(item: Invoice) {
    if (
      !window.confirm(
        'Émettre cette facture maintenant ? Le numéro, les lignes, le client, les dates et les montants seront figés. Toute correction ultérieure devra passer par un avoir et une nouvelle facture.',
      )
    )
      return;
    const issued = await act(
      () =>
        desktopApi.issueDocument(
          'invoices',
          item.id,
          item.issueDate,
          item.dueDate,
        ),
      'La facture a été émise, numérotée et verrouillée.',
      false,
    );
    if (issued && cloudAccount?.status === 'connected') {
      await archiveInvoiceToCloud(item, true);
    }
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

  async function reviseQuote(item: Quote) {
    if (
      actionInFlight.current ||
      !reserveDocumentAction(quoteRevisionInFlight.current, item.id)
    )
      return;
    try {
      if (
        !window.confirm(
          `Créer une version modifiable de « ${item.number || item.title} » ? Le devis émis restera conservé dans l’historique et les documents déjà créés ne seront jamais réécrits.`,
        )
      )
        return;
      let revision: Quote | null = null;
      const revised = await act(
        async () => {
          const result = await desktopApi.createQuoteRevision(item.id);
          revision = result.workspace.quotes.find(
            (candidate) => candidate.id === result.revisionId,
          ) ?? null;
          return result.workspace;
        },
        `Le devis ${item.number || item.title} est conservé dans l’historique. Sa nouvelle version est prête à être modifiée.`,
        false,
      );
      if (revised && revision) {
        setModal({ type: 'document', entity: 'quotes', item: revision });
      }
    } finally {
      quoteRevisionInFlight.current.delete(item.id);
    }
  }

  async function convertAcceptedQuoteToOrder(item: Quote) {
    let requestId = quoteOrderRequestIds.current.get(item.id);
    if (!requestId) {
      requestId = createId();
      quoteOrderRequestIds.current.set(item.id, requestId);
    }
    let convertedWorkspace: Workspace | null = null;
    const converted = await act(
      async () => {
        const nextWorkspace = await desktopApi.convertQuoteToSalesOrder(
          requestId!,
          item.id,
        );
        convertedWorkspace = nextWorkspace;
        return nextWorkspace;
      },
      'Étape 1/2 : contrôlez puis confirmez la commande. Étape 2/2 : choisissez le rythme dans « Documents récurrents ».',
      false,
    );
    if (converted) {
      quoteOrderRequestIds.current.delete(item.id);
      const createdOrder = (
        convertedWorkspace as Workspace | null
      )?.salesOrders.find((order) => order.quoteId === item.id);
      setOrderToOpenId(createdOrder?.id ?? null);
      setView('orders');
      setSearch('');
      setMenuOpen(false);
    }
  }

  async function postPayslip(item: Payslip) {
    if (readOnly) {
      setNotice({
        tone: 'error',
        text: readOnlyMutationMessage,
      });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const result = await desktopApi.postPayslip(item.id);
      setWorkspace(result.workspace);
      if (result.accountingFallbacks.length) {
        const details = result.accountingFallbacks
          .map((fallback) => {
            const accountKind =
              fallback.field === 'expense_account_id' ? 'charge' : 'dette';
            return `${fallback.contribution || 'Cotisation'} : compte de ${accountKind} général ${fallback.accountId}`;
          })
          .join(' · ');
        setNotice({
          tone: 'warning',
          text: `La fiche a été comptabilisée et verrouillée, mais ${result.accountingFallbacks.length} compte${result.accountingFallbacks.length > 1 ? 's' : ''} non figé${result.accountingFallbacks.length > 1 ? 's ont' : ' a'} été remplacé${result.accountingFallbacks.length > 1 ? 's' : ''} par ${result.accountingFallbacks.length > 1 ? 'des comptes généraux' : 'un compte général'} : ${details}. Vérifiez l’écriture comptable.`,
        });
      } else {
        setNotice({
          tone: 'success',
          text: 'La fiche a été comptabilisée et verrouillée.',
        });
      }
    } catch (reason) {
      setNotice({
        tone: 'error',
        text: errorMessage(
          reason,
          'La comptabilisation locale de la fiche a échoué.',
        ),
      });
    } finally {
      setBusy(false);
    }
  }

  async function archive(entity: EntityKind, id: string, label: string) {
    if (
      !window.confirm(
        `Supprimer « ${label} » de l’espace local ? Cette action ne peut pas être annulée.`,
      )
    )
      return;
    await act(
      () => desktopApi.archiveEntity(entity, id),
      `${label} a été supprimé.`,
      false,
    );
  }

  async function abandonInvoiceCorrection(
    workflow: InvoiceCorrectionWorkflow,
  ) {
    const original = workspace.invoices.find(
      (item) => item.id === workflow.originalInvoiceId,
    );
    const originalLabel =
      original?.number || original?.title || 'la facture originale';
    if (
      !window.confirm(
        `Abandonner la correction de « ${originalLabel} » ? L’avoir brouillon et la facture de remplacement seront supprimés. La facture originale restera intacte.`,
      )
    )
      return;
    await act(
      () => desktopApi.abandonInvoiceCorrection(workflow.id),
      `La correction a été abandonnée. ${originalLabel} est restée intacte.`,
      false,
    );
  }

  async function deleteEmptyProject(item: Project) {
    const linked: Array<[string, number]> = [
      [
        'jalon',
        workspace.projectMilestones.filter((row) => row.projectId === item.id)
          .length,
      ],
      [
        'tâche',
        workspace.projectTasks.filter((row) => row.projectId === item.id)
          .length,
      ],
      [
        'saisie de temps',
        workspace.timeEntries.filter((row) => row.projectId === item.id).length,
      ],
      [
        'devis',
        workspace.quotes.filter((row) => row.projectId === item.id).length,
      ],
      [
        'commande',
        workspace.salesOrders.filter((row) => row.projectId === item.id).length,
      ],
      [
        'facture',
        workspace.invoices.filter((row) => row.projectId === item.id).length,
      ],
      [
        'dépense',
        workspace.expenses.filter((row) => row.projectId === item.id).length,
      ],
      [
        'facture fournisseur',
        workspace.supplierInvoices.filter((row) => row.projectId === item.id)
          .length,
      ],
    ];
    const used = linked.filter(([, count]) => count > 0);
    if (workspace.activeTimer?.projectId === item.id)
      used.push(['chronomètre actif', 1]);
    if (used.length) {
      setNotice({
        tone: 'error',
        text: `Ce ${terminology.singular} contient encore ${used
          .map(([label, count]) => `${count} ${label}${count > 1 ? 's' : ''}`)
          .join(
            ', ',
          )}. Pour protéger l’historique, il ne peut pas être supprimé. Passez-le au statut « Clôturé » depuis Modifier.`,
      });
      return;
    }
    if (
      !window.confirm(
        `Supprimer définitivement le ${terminology.singular} vide « ${item.name} » ?`,
      )
    )
      return;
    await act(
      () => desktopApi.archiveEntity('projects', item.id),
      `${item.name} a été supprimé.`,
      false,
    );
  }

  async function archiveCatalogItem(item: CatalogItem) {
    if (
      !window.confirm(
        `Archiver « ${item.name} » ? La référence restera dans l’historique, mais ne sera plus proposée dans les nouveaux documents.`,
      )
    )
      return;
    await act(
      () => desktopApi.archiveEntity('catalogItems', item.id),
      `${item.name} a été archivé.`,
      false,
    );
  }

  async function restoreCatalogItem(item: CatalogItem) {
    await act(
      () =>
        desktopApi.updateEntity('catalogItems', item.id, { archivedAt: null }),
      `${item.name} est de nouveau disponible.`,
      false,
    );
  }

  async function archiveClient(item: Client) {
    if (
      !window.confirm(
        `Archiver « ${item.company || item.name} » ? Son dossier, ses projets et ses documents resteront intacts, mais ce client ne sera plus proposé dans les nouvelles saisies.`,
      )
    )
      return;
    await act(
      () => desktopApi.archiveEntity('clients', item.id),
      `${item.company || item.name} a été archivé sans supprimer son historique.`,
      false,
    );
  }

  async function restoreClient(item: Client) {
    await act(
      () => desktopApi.updateEntity('clients', item.id, { archivedAt: null }),
      `${item.company || item.name} est de nouveau actif.`,
      false,
    );
  }

  async function archiveSupplier(item: Supplier) {
    if (
      !window.confirm(
        `Archiver « ${item.name} » ? Le fournisseur restera visible dans l’historique, mais ne sera plus proposé dans les nouveaux achats.`,
      )
    )
      return;
    await act(
      () => desktopApi.archiveEntity('suppliers', item.id),
      `${item.name} a été archivé.`,
      false,
    );
  }

  async function restoreSupplier(item: Supplier) {
    await act(
      () => desktopApi.updateEntity('suppliers', item.id, { archivedAt: null }),
      `${item.name} est de nouveau disponible.`,
      false,
    );
  }

  async function markExpensePaid(item: Expense) {
    const paidAt = todayIso();
    if (
      !window.confirm(
        `Marquer l’achat « ${item.supplier || item.reference} » payé le ${formatDate(paidAt)} ? L’achat et son écriture comptable seront enregistrés ensemble; l’action sera refusée si la comptabilité n’est pas prête.`,
      )
    )
      return;
    await act(
      () =>
        desktopApi.updateEntity('expenses', item.id, {
          paymentStatus: 'paid',
          paidAt,
        }),
      'L’achat est marqué payé et son écriture comptable a été créée dans la même transaction.',
      false,
    );
  }

  async function validateSupplierInvoice(item: SupplierInvoice) {
    const attachmentWarning = item.attachments.length
      ? ''
      : '\n\nAucun justificatif n’est joint. Vous pourrez toujours valider, mais le document original ne sera pas archivé avec cette facture.';
    if (
      !window.confirm(
        `Valider la facture fournisseur « ${item.reference || item.supplierName} » ? Le fournisseur, les lignes, les montants et les justificatifs seront figés, puis l’écriture comptable sera créée.${attachmentWarning}`,
      )
    )
      return;
    await act(
      () => desktopApi.validateSupplierInvoice(item.id),
      'La facture fournisseur a été validée, verrouillée et comptabilisée.',
      false,
    );
  }

  async function deleteSupplierInvoiceDraft(item: SupplierInvoice) {
    if (
      !window.confirm(
        `Supprimer définitivement le brouillon « ${item.reference || item.supplierName} » ?`,
      )
    )
      return;
    await act(
      () => desktopApi.deleteSupplierInvoiceDraft(item.id),
      'Le brouillon fournisseur a été supprimé.',
      false,
    );
  }

  const overdue = workspace.invoices.filter(
    (invoice) =>
      invoice.type !== 'credit_note' &&
      ['issued', 'partially_paid'].includes(invoice.status) &&
      invoice.dueDate &&
      invoice.dueDate < todayIso(),
  );
  const title: [string, string] =
    view === 'projects'
      ? [
          terminology.pluralTitle,
          `Budget, durée, temps et rentabilité par ${terminology.singular}`,
        ]
      : view === 'time'
        ? (viewTitles.time.map((value, index) =>
            index
              ? `Pointage réel et heures par ${terminology.singular}`
              : value,
          ) as [string, string])
        : viewTitles[view];
  const timerProject = workspace.projects.find(
    (project) => project.id === workspace.activeTimer?.projectId,
  );
  const timerTask = workspace.projectTasks.find(
    (task) => task.id === workspace.activeTimer?.taskId,
  );
  const timerEmployee = workspace.employees.find(
    (employee) => employee.id === workspace.activeTimer?.employeeId,
  );
  const searchableView = [
    'projects',
    'clients',
    'catalog',
    'quotes',
    'orders',
    'invoices',
    'time',
    'team',
    'expenses',
  ].includes(view);
  const prerequisites: WorkspacePrerequisites = {
    clients: workspace.clients.filter((client) => !client.archivedAt).length,
    projects: workspace.projects.length,
    trackableProjects: workspace.projects.filter(
      (project) => project.status !== 'closed',
    ).length,
    activeEmployees: workspace.employees.filter((employee) => employee.active)
      .length,
    activeSuppliers: workspace.suppliers.filter(
      (supplier) => !supplier.archivedAt,
    ).length,
    costCategories: settings.work.costCategories.length,
    billingSetupDeferred: settings.setupDeferred?.billing === true,
    workSetupDeferred: settings.setupDeferred?.work === true,
  };
  const dashboardTimerBlock = timerBlockReason(
    prerequisites,
    Boolean(workspace.activeTimer),
  );

  return (
    <div className="desktop-app">
      <aside
        id="primary-navigation"
        className={`sidebar ${menuOpen ? 'is-open' : ''}`}
        aria-hidden={sidebarHidden ? true : undefined}
        inert={sidebarHidden ? true : undefined}
      >
        <div className="sidebar__brand">
          <div className="sidebar__wordmark">
            <BrandWordmark />
            <small>Gestion locale</small>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="sidebar__close"
            onClick={() => setMenuOpen(false)}
            aria-label="Fermer la navigation"
            title="Fermer la navigation"
            aria-controls="primary-navigation"
          >
            <X size={18} />
          </Button>
        </div>
        <nav className="sidebar__nav">
          {navigation.map((item) => {
            const Icon =
              item.id === 'projects' && terminology.icon === 'hard-hat'
                ? HardHat
                : item.icon;
            const label =
              item.id === 'projects'
                ? `${terminology.moduleLabel} · ${terminology.pluralTitle}`
                : item.label;
            const active =
              item.id === 'quotes'
                ? view === 'quotes' || view === 'orders' || view === 'invoices'
                : view === item.id;
            return (
              <div key={item.id}>
                {item.group ? <p>{item.group}</p> : null}
                <button
                  aria-current={active ? 'page' : undefined}
                  className={active ? 'is-active' : ''}
                  onClick={() => {
                    setAccountingEntryFocus(null);
                    setView(item.id);
                    setSearch('');
                    setMenuOpen(false);
                  }}
                >
                  <Icon size={17} />
                  <span>{label}</span>
                  {(item.id === 'quotes' || item.id === 'reminders') &&
                  overdue.length ? (
                    <em>{overdue.length}</em>
                  ) : null}
                </button>
                {item.id === 'clients' ? <div className="sidebar__divider" /> : null}
              </div>
            );
          })}
        </nav>
        <div className="sidebar__local">
          <ShieldCheck size={17} />
          <div>
            <strong>Données locales</strong>
            <span>Sur cet ordinateur</span>
          </div>
          <i />
        </div>
      </aside>

      <main className="app-main">
        <header className="topbar">
          <div className="topbar__title">
            <Button
              variant="ghost"
              size="icon"
              className="menu-button"
              onClick={() => setMenuOpen(true)}
              aria-label="Ouvrir la navigation"
              title="Ouvrir la navigation"
              aria-controls="primary-navigation"
              aria-expanded={menuOpen}
            >
              <Menu size={20} />
            </Button>
            <div>
              <p>Zentra local</p>
              <h1>{title[0]}</h1>
            </div>
          </div>
          <div className="topbar__tools">
            {searchableView ? (
              <label className="global-search">
                <Search size={16} />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Rechercher dans cette vue"
                />
              </label>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="small"
              className="update-launcher"
              aria-label="Ouvrir les mises à jour de Zentra"
              title="Vérifier les mises à jour"
              onClick={openUpdater}
            >
              <RefreshCw size={16} /> <span>Mise à jour</span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="small"
              className="tour-launcher"
              aria-label="Ouvrir le guide complet"
              title="Ouvrir le guide complet"
              onClick={guidedTour.start}
            >
              <CircleHelp size={16} /> Guide
            </Button>
            <CompanyAvatar organization={settings.organization} />
          </div>
        </header>

        {readOnly && readOnlySource === 'cloud' ? (
          <div className="notice notice--warning" role="status">
            <span>
              <LockKeyhole size={18} />
              Accès « Lecture seule » : consultation et exports autorisés,
              modifications bloquées sur ce poste.
            </span>
          </div>
        ) : null}

        {workspace.activeTimer ? (
          <div className="timer-ribbon">
            <span className="timer-ribbon__pulse" />
            <div>
              <strong>Pointage en cours · {formatTimer(timerSeconds)}</strong>
              <small>
                {timerProject?.name ?? terminology.singularTitle}
                {timerTask ? ` · ${timerTask.title}` : ''}
                {timerEmployee ? ` · ${timerEmployee.name}` : ''}
              </small>
            </div>
            <Button
              variant="dark"
              size="small"
              disabled={busy}
              onClick={() =>
                void act(
                  () => desktopApi.stopTimer(),
                  'Le pointage a été arrêté et enregistré.',
                  false,
                )
              }
            >
              <Pause size={15} /> Arrêter
            </Button>
          </div>
        ) : null}

        <div className="page-header">
          <div>
            {view === 'projects' ? (
              <small className="module-kicker">
                Module Chantiers / projets
              </small>
            ) : null}
            <p>{title[1]}</p>
          </div>
          <div className="page-header__actions">
            {view === 'dashboard' ? (
              <Button
                variant="secondary"
                disabled={Boolean(dashboardTimerBlock)}
                title={dashboardTimerBlock || 'Démarrer un pointage réel'}
                onClick={() => setModal({ type: 'timer' })}
              >
                <Play size={16} /> Démarrer un pointage
              </Button>
            ) : null}
            {view !== 'settings' &&
            view !== 'reports' &&
            view !== 'dashboard' ? (
              <CreateButton
                view={view}
                onClick={setModal}
                terminology={terminology}
                prerequisites={prerequisites}
                readOnly={readOnly}
                readOnlyReason={readOnlyMutationMessage}
              />
            ) : null}
          </div>
        </div>
        {notice ? (
          <div
            className={`notice notice--${notice.tone} ${modal ? 'notice--floating' : ''}`}
            role={notice.tone === 'error' ? 'alert' : 'status'}
            aria-live={notice.tone === 'error' ? 'assertive' : 'polite'}
          >
            <span>
              {notice.tone === 'success' ? (
                <CheckCircle2 size={18} />
              ) : notice.tone === 'warning' ? (
                <MessageSquareWarning size={18} />
              ) : (
                <ShieldCheck size={18} />
              )}
              {notice.text}
            </span>
            <button
              type="button"
              onClick={() => setNotice(null)}
              aria-label="Fermer le message"
            >
              <X size={15} />
            </button>
          </div>
        ) : null}

        <section className="page-content" key={view}>
          {view === 'quotes' || view === 'orders' || view === 'invoices' ? (
            <SalesTabs
              active={view as SalesView}
              onChange={(next) => {
                setView(next);
                setSearch('');
              }}
            />
          ) : null}
          {view === 'dashboard' ? (
            <Dashboard
              workspace={workspace}
              readOnly={readOnly}
              onNavigate={setView}
              onCreate={setModal}
            />
          ) : null}
          {view === 'agenda' ? (
            <Suspense fallback={<ViewLoading label="Ouverture de l’agenda…" />}>
              <AgendaScreen
                workspace={workspace}
                busy={busy}
                readOnly={readOnly}
                onSave={(input: AgendaEventDraft) =>
                  act(
                    () => desktopApi.saveAgendaEvent(input),
                    input.isNew
                      ? 'Le rendez-vous a été ajouté à votre agenda.'
                      : 'Le rendez-vous a été mis à jour.',
                    false,
                  )
                }
                onDelete={(item) =>
                  act(
                    () => desktopApi.deleteAgendaEvent(item.id, item.updatedAt),
                    'Le rendez-vous a été supprimé.',
                    false,
                  )
                }
                onNavigate={openAgendaItem}
              />
            </Suspense>
          ) : null}
          {view === 'projects' ? (
            <ProjectsScreen
              workspace={workspace}
              query={search}
              busy={busy}
              readOnly={readOnly}
              onEdit={(item) => setModal({ type: 'project', item })}
              onCreate={() => setModal({ type: 'project' })}
              onArchive={(item) => void deleteEmptyProject(item)}
              onSaveTask={(input) =>
                act(
                  () => desktopApi.saveProjectTask(input),
                  input.id
                    ? 'La tâche a été mise à jour.'
                    : 'La tâche a été ajoutée au planning.',
                  false,
                )
              }
              onSaveMilestone={(input) =>
                act(
                  () => desktopApi.saveProjectMilestone(input),
                  input.id
                    ? 'Le jalon a été mis à jour.'
                    : 'Le jalon a été ajouté au projet.',
                  false,
                )
              }
              onSetTaskStatus={(item, status) =>
                act(
                  () => desktopApi.setProjectTaskStatus(item.id, status),
                  status === 'done'
                    ? 'La tâche est terminée.'
                    : status === 'in_progress'
                      ? 'La tâche est en cours.'
                      : status === 'cancelled'
                        ? 'La tâche a été annulée.'
                        : 'La tâche a été rouverte.',
                  false,
                )
              }
              onDeleteTask={async (item) => {
                if (
                  !window.confirm(
                    `Supprimer définitivement la tâche « ${item.title} » ?`,
                  )
                )
                  return false;
                return act(
                  () => desktopApi.deleteProjectTask(item.id),
                  'La tâche a été supprimée.',
                  false,
                );
              }}
              onDeleteMilestone={async (item) => {
                if (
                  !window.confirm(
                    `Supprimer définitivement le jalon « ${item.title} » ?`,
                  )
                )
                  return false;
                return act(
                  () => desktopApi.deleteProjectMilestone(item.id),
                  'Le jalon a été supprimé.',
                  false,
                );
              }}
              agendaPlanningTarget={agendaPlanningTarget}
              onAgendaPlanningTargetHandled={() =>
                setAgendaPlanningTarget(null)
              }
            />
          ) : null}
          {view === 'clients' ? (
            <ClientsScreen
              workspace={workspace}
              query={search}
              onOpen={(client) => setModal({ type: 'clientDetail', client })}
              onEdit={(item) => setModal({ type: 'client', item })}
              onCreate={() => setModal({ type: 'client' })}
              onArchive={(item) => void archiveClient(item)}
              onRestore={(item) => void restoreClient(item)}
            />
          ) : null}
          {view === 'catalog' ? (
            <CatalogScreen
              items={workspace.catalogItems}
              vatRatesBp={workspace.settings!.billing.vatRatesBp}
              movements={workspace.stockMovements}
              reservationEvents={workspace.stockReservationEvents}
              availabilityRows={workspace.stockAvailability}
              query={search}
              busy={busy}
              readOnly={readOnly}
              onQueryChange={setSearch}
              onCreate={() => setModal({ type: 'catalogItem' })}
              onEdit={(item) => setModal({ type: 'catalogItem', item })}
              onStockMovement={(item, movementType) =>
                setModal({
                  type: 'stockMovement',
                  item,
                  movementType,
                  requestId: createId(),
                  reservedMilli: availabilityForCatalogItem(
                    item,
                    workspace.stockReservationEvents,
                    workspace.stockAvailability,
                  ).reservedMilli,
                })
              }
              onArchive={(item) => void archiveCatalogItem(item)}
              onRestore={(item) => void restoreCatalogItem(item)}
              onImport={(rows, conflictPolicy) =>
                act(
                  () => desktopApi.importCatalogItems(rows, conflictPolicy),
                  `Catalogue importé : ${rows.length} référence${rows.length > 1 ? 's contrôlées' : ' contrôlée'}.`,
                  false,
                )
              }
            />
          ) : null}
          {view === 'quotes' ? (
            <DocumentsScreen
              entity="quotes"
              workspace={workspace}
              query={search}
              busy={busy}
              onEdit={(item) =>
                setModal({ type: 'document', entity: 'quotes', item })
              }
              onRevise={(item) => void reviseQuote(item)}
              onCreate={() => setModal({ type: 'document', entity: 'quotes' })}
              onIssue={(item) =>
                void act(
                  () =>
                    desktopApi.issueDocument(
                      'quotes',
                      item.id,
                      item.issueDate,
                      item.validUntil,
                    ),
                  'Le devis a été émis et numéroté.',
                  false,
                )
              }
              onStatus={(item, status) => {
                if (
                  status === 'cancelled' &&
                  !window.confirm(
                    `Annuler l’acceptation de « ${item.number || item.title} » ? Le devis restera dans l’historique.`,
                  )
                )
                  return;
                void act(
                  () => desktopApi.updateQuoteStatus(item.id, status),
                  status === 'accepted'
                    ? 'Le devis a été marqué accepté. Un produit passera par une commande et une livraison; un service peut être facturé directement.'
                    : status === 'refused'
                      ? 'Le devis a été marqué refusé.'
                      : status === 'expired'
                        ? 'Le devis a été marqué expiré.'
                        : 'L’acceptation a été annulée. Le devis reste conservé dans l’historique.',
                  false,
                );
              }}
              onConvert={(item) => void convertAcceptedQuote(item)}
              onCreateOrder={(item) => void convertAcceptedQuoteToOrder(item)}
              onPrint={(item) =>
                setPrintTarget({ entity: 'quotes', value: item })
              }
              onArchive={(item) => void archive('quotes', item.id, item.title)}
            />
          ) : null}
          {view === 'orders' ? (
            <SalesOrdersScreen
              workspace={workspace}
              query={search}
              busy={busy}
              readOnly={readOnly}
              act={act}
              openOrderId={orderToOpenId}
              onOpenOrderHandled={() => setOrderToOpenId(null)}
              onShowQuotes={() => {
                setView('quotes');
                setSearch('');
              }}
              onOpenInvoice={(invoice) =>
                setModal({
                  type: 'document',
                  entity: 'invoices',
                  item: invoice,
                })
              }
              onIssueInvoice={issueInvoice}
              onPrintOrder={(order) =>
                setPrintTarget({ entity: 'sales_orders', value: order })
              }
              onPrintDelivery={(note) => {
                const order = workspace.salesOrders.find(
                  (item) => item.id === note.salesOrderId,
                );
                if (order)
                  setPrintTarget({
                    entity: 'delivery_notes',
                    value: note,
                    order,
                  });
              }}
            />
          ) : null}
          {view === 'invoices' ? (
            <DocumentsScreen
              entity="invoices"
              workspace={workspace}
              query={search}
              busy={busy}
              onEdit={(item) =>
                setModal({ type: 'document', entity: 'invoices', item })
              }
              onCorrect={(item) =>
                setModal({ type: 'invoiceCorrection', invoice: item })
              }
              onAbandonCorrection={(workflow) =>
                void abandonInvoiceCorrection(workflow)
              }
              onArchiveCloud={(item) => void archiveInvoiceToCloud(item)}
              onCreate={() =>
                setModal({ type: 'document', entity: 'invoices' })
              }
              onIssue={issueInvoice}
              onPayment={(item) => setModal({ type: 'payment', invoice: item })}
              onOpenPaymentJournal={openAccountingEntry}
              onOpenOrder={(orderId) => {
                setOrderToOpenId(orderId);
                setView('orders');
                setSearch('');
                setNotice({
                  tone: 'warning',
                  text: 'Cette facture brouillon est pilotée depuis sa commande. Émission et suppression y restent contrôlées.',
                });
              }}
              onPrint={(item) =>
                item.type === 'credit_note'
                  ? setPrintTarget({ entity: 'invoices', value: item })
                  : setModal({ type: 'qrPrint', invoice: item })
              }
              onArchive={(item) =>
                void archive('invoices', item.id, item.title)
              }
            />
          ) : null}
          {view === 'reminders' ? (
            <Suspense
              fallback={<ViewLoading label="Ouverture des relances…" />}
            >
              <RemindersScreen
                readOnly={readOnly}
                refreshSignal={reminderRefreshSignal}
              />
            </Suspense>
          ) : null}
          {view === 'time' ? (
            <TimeScreen
              workspace={workspace}
              query={search}
              onCreate={() => setModal({ type: 'time' })}
              onEdit={(item) => setModal({ type: 'time', item })}
              onTimer={() => setModal({ type: 'timer' })}
              onBill={() => setModal({ type: 'timeBilling' })}
              onArchive={(item) =>
                void archive(
                  'timeEntries',
                  item.id,
                  `Pointage du ${formatDate(item.date)}`,
                )
              }
            />
          ) : null}
          {view === 'team' ? (
            <TeamScreen
              workspace={workspace}
              query={search}
              onCreateEmployee={() => setModal({ type: 'employee' })}
              onEditEmployee={(item) => setModal({ type: 'employee', item })}
              onCreatePayslip={() => setModal({ type: 'payslip' })}
              onImportPayslips={() => setModal({ type: 'payrollImport' })}
              onEditPayslip={(item) => setModal({ type: 'payslip', item })}
              onPostPayslip={(item) => void postPayslip(item)}
              onPayPayslip={(item) =>
                setModal({ type: 'payslipPayment', payslip: item })
              }
              onPrint={(item) =>
                setPrintTarget({ entity: 'payslips', value: item })
              }
              onArchiveEmployee={(item) =>
                void archive('employees', item.id, item.name)
              }
              onArchivePayslip={(item) =>
                void archive('payslips', item.id, `Fiche ${item.period}`)
              }
            />
          ) : null}
          {view === 'expenses' ? (
            <Suspense fallback={<ViewLoading label="Ouverture des achats…" />}>
              <PurchaseOrdersScreen
                workspace={workspace}
                query={search}
                onQueryChange={setSearch}
                busy={busy}
                readOnly={readOnly}
                runAction={act}
                onCreateSupplierInvoice={() =>
                  setModal({ type: 'supplierInvoice' })
                }
                onOpenSupplierInvoice={(invoice) =>
                  setModal({ type: 'supplierInvoiceDetail', invoice })
                }
                onEditSupplierInvoice={(item) =>
                  setModal({ type: 'supplierInvoice', item })
                }
                onValidateSupplierInvoice={(item) =>
                  void validateSupplierInvoice(item)
                }
                onDeleteSupplierInvoiceDraft={(item) =>
                  void deleteSupplierInvoiceDraft(item)
                }
                onRecordSupplierPayment={(invoice) =>
                  setModal({ type: 'supplierPayment', invoice })
                }
                onOpenLegacyExpense={(expense) =>
                  setModal({ type: 'legacyExpenseDetail', expense })
                }
                onEditLegacyExpense={(item) =>
                  setModal({ type: 'expense', item })
                }
                onArchiveLegacyExpense={(item) =>
                  void archive(
                    'expenses',
                    item.id,
                    item.supplier || item.reference,
                  )
                }
                onMarkLegacyExpensePaid={(item) => void markExpensePaid(item)}
                onCreateSupplier={() => setModal({ type: 'supplier' })}
                onEditSupplier={(item) => setModal({ type: 'supplier', item })}
                onArchiveSupplier={(item) => void archiveSupplier(item)}
                onRestoreSupplier={(item) => void restoreSupplier(item)}
                onOpenAccounting={() => {
                  setView('accounting');
                  setSearch('');
                }}
              />
            </Suspense>
          ) : null}
          {view === 'bank' ? (
            <Suspense fallback={<ViewLoading label="Ouverture de la banque…" />}>
              <BankScreen
                workspace={workspace}
                readOnly={readOnly}
                onWorkspaceChange={(next) => setWorkspace(next)}
                onOpenAccounting={() => {
                  setView('accounting');
                  setSearch('');
                }}
              />
            </Suspense>
          ) : null}
          {view === 'reports' ? <ReportsScreen workspace={workspace} /> : null}
          {view === 'accounting' ? (
            <Suspense
              fallback={<ViewLoading label="Ouverture de la comptabilité…" />}
            >
              <AccountingScreen
                workspace={workspace}
                onWorkspaceChange={setWorkspace}
                focusEntry={accountingEntryFocus}
                onFocusHandled={clearAccountingEntryFocus}
              />
            </Suspense>
          ) : null}
          {view === 'settings' ? (
            <SettingsScreen
              workspace={workspace}
              busy={busy}
              setBusy={setBusy}
              onWorkspace={setWorkspace}
              onNotice={setNotice}
              onCloudAccountChange={onCloudAccountChange}
              onOpenAccounting={() => {
                setView('accounting');
                setSearch('');
              }}
            />
          ) : null}
        </section>
      </main>

      {modal ? (
        <WorkspaceModal
          state={modal}
          workspace={workspace}
          busy={busy}
          close={() => setModal(null)}
          replace={setModal}
          act={act}
          onOpenInvoices={() => {
            setModal(null);
            setView('invoices');
            setSearch('');
          }}
          onOpenAccounting={() => {
            setModal(null);
            setView('accounting');
            setSearch('');
          }}
          onQrReady={(invoice, qr) => {
            setModal(null);
            setPrintTarget({ entity: 'invoices', value: invoice, qr });
          }}
        />
      ) : null}
      {printTarget ? (
        <PrintSheet
          target={printTarget}
          workspace={workspace}
          onClose={() => setPrintTarget(null)}
        />
      ) : null}
      <GuidedTour
        open={guidedTour.open}
        mode={guidedTour.mode}
        onClose={guidedTour.close}
        onNavigate={navigateTour}
      />
    </div>
  );
}

function CreateButton({
  view,
  onClick,
  terminology,
  prerequisites,
  readOnly,
  readOnlyReason,
}: {
  view: View;
  onClick: Dispatch<SetStateAction<ModalState>>;
  terminology: ReturnType<typeof projectTerminology>;
  prerequisites: WorkspacePrerequisites;
  readOnly: boolean;
  readOnlyReason: string;
}) {
  const map: Partial<Record<View, [string, ModalState]>> = {
    projects: [`Nouveau ${terminology.singular}`, { type: 'project' }],
    clients: ['Nouveau client', { type: 'client' }],
    catalog: ['Nouvelle référence', { type: 'catalogItem' }],
    quotes: ['Nouveau devis', { type: 'document', entity: 'quotes' }],
    invoices: ['Nouvelle facture', { type: 'document', entity: 'invoices' }],
    time: ['Saisir des heures', { type: 'time' }],
    team: ['Nouveau collaborateur', { type: 'employee' }],
    expenses: ['Facture fournisseur', { type: 'supplierInvoice' }],
  };
  const current = map[view];
  const blockReason = readOnly
    ? readOnlyReason
    : current
      ? creationBlockReason(
          view as Parameters<typeof creationBlockReason>[0],
          prerequisites,
        )
      : '';
  return current ? (
    <Button
      disabled={Boolean(blockReason)}
      title={blockReason || current[0]}
      onClick={() => onClick(current[1])}
    >
      <Plus size={16} /> {current[0]}
    </Button>
  ) : null;
}

function Dashboard({
  workspace,
  readOnly,
  onNavigate,
  onCreate,
}: {
  workspace: Workspace;
  readOnly: boolean;
  onNavigate: (view: View) => void;
  onCreate: Dispatch<SetStateAction<ModalState>>;
}) {
  const terminology = projectTerminology(
    workspace.settings!.business.nogaSection,
  );
  const ProjectIcon = terminology.icon === 'hard-hat' ? HardHat : FolderKanban;
  const prerequisites: WorkspacePrerequisites = {
    clients: workspace.clients.filter((client) => !client.archivedAt).length,
    projects: workspace.projects.length,
    trackableProjects: workspace.projects.filter(
      (project) => project.status !== 'closed',
    ).length,
    activeEmployees: workspace.employees.filter((employee) => employee.active)
      .length,
    activeSuppliers: workspace.suppliers.filter(
      (supplier) => !supplier.archivedAt,
    ).length,
    costCategories: workspace.settings!.work.costCategories.length,
    billingSetupDeferred: workspace.settings!.setupDeferred?.billing === true,
    workSetupDeferred: workspace.settings!.setupDeferred?.work === true,
  };
  const projectBlock = creationBlockReason('projects', prerequisites);
  const quoteBlock = creationBlockReason('quotes', prerequisites);
  const expenseBlock = creationBlockReason('expenses', prerequisites);
  const gettingStarted = buildGettingStartedJourney(workspace);
  const issued = workspace.invoices.filter(
    (invoice) => invoice.status !== 'draft' && invoice.status !== 'cancelled',
  );
  const invoiced = issued.reduce(
    (total, invoice) => total + documentTotals(invoice.lines).totalCents,
    0,
  );
  const paid = issued.reduce(
    (total, invoice) => total + invoicePaid(invoice.id, workspace.payments),
    0,
  );
  const minutes = workspace.timeEntries.reduce(
    (total, entry) => total + entry.minutes,
    0,
  );
  const activeProjects = workspace.projects.filter((project) =>
    ['in_progress', 'paused'].includes(project.status),
  );
  const hasActivity =
    workspace.clients.length ||
    workspace.projects.length ||
    workspace.quotes.length ||
    workspace.invoices.length ||
    workspace.timeEntries.length;

  function runGettingStartedAction(action: GettingStartedAction) {
    if (readOnly) {
      onNavigate(action.view);
      return;
    }
    if (action.kind === 'create_client') {
      onCreate({ type: 'client' });
      return;
    }
    if (action.kind === 'create_project') {
      onCreate({ type: 'project' });
      return;
    }
    if (action.kind === 'create_quote') {
      onCreate({ type: 'document', entity: 'quotes' });
      return;
    }
    if (action.kind === 'review_invoice' && action.entityId) {
      const invoice = workspace.invoices.find((item) => item.id === action.entityId);
      if (invoice) {
        onCreate({ type: 'document', entity: 'invoices', item: invoice });
        return;
      }
    }
    if (action.kind === 'record_payment' && action.entityId) {
      const invoice = workspace.invoices.find((item) => item.id === action.entityId);
      if (invoice) {
        onCreate({ type: 'payment', invoice });
        return;
      }
    }
    onNavigate(action.view);
  }

  if (!hasActivity)
    return (
      <GettingStartedChecklist
        workspace={workspace}
        readOnly={readOnly}
        onAction={runGettingStartedAction}
      />
    );
  return (
    <div className="dashboard-grid">
      {!gettingStarted.complete ? (
        <GettingStartedChecklist
          workspace={workspace}
          readOnly={readOnly}
          onAction={runGettingStartedAction}
        />
      ) : null}
      <div className="metric-grid">
        <MetricCard
          label="Facturé TTC"
          value={issued.length ? formatMoney(invoiced) : '—'}
          note={
            issued.length
              ? `${issued.length} facture${issued.length > 1 ? 's' : ''} émise${issued.length > 1 ? 's' : ''}`
              : 'Aucune facture émise'
          }
          icon={<CircleDollarSign />}
          tone="green"
        />
        <MetricCard
          label="Encaissé"
          value={workspace.payments.length ? formatMoney(paid) : '—'}
          note={
            workspace.payments.length
              ? `${workspace.payments.length} paiement${workspace.payments.length > 1 ? 's' : ''}`
              : 'Aucun paiement enregistré'
          }
          icon={<Banknote />}
          tone="amber"
        />
        <MetricCard
          label="Solde ouvert"
          value={
            issued.length ? formatMoney(Math.max(0, invoiced - paid)) : '—'
          }
          note={
            issued.length ? 'Sur les factures émises' : 'Pas encore calculable'
          }
          icon={<TrendingUp />}
          tone="blue"
        />
        <MetricCard
          label="Temps saisi"
          value={workspace.timeEntries.length ? formatMinutes(minutes) : '—'}
          note={
            workspace.timeEntries.length
              ? `${workspace.timeEntries.length} saisie${workspace.timeEntries.length > 1 ? 's' : ''}`
              : 'Aucune heure saisie'
          }
          icon={<Clock3 />}
          tone="violet"
        />
      </div>
      <section className="panel panel--span">
        <SectionHeading
          eyebrow="En cours"
          title={`${terminology.pluralTitle} actifs`}
          action={
            <Button
              variant="ghost"
              size="small"
              onClick={() => onNavigate('projects')}
            >
              Tous les {terminology.plural} <ArrowRight size={15} />
            </Button>
          }
        />
        {activeProjects.length ? (
          <div className="dashboard-projects">
            {activeProjects.slice(0, 4).map((project) => {
              const client = workspace.clients.find(
                (item) => item.id === project.clientId,
              );
              const stats = projectFinancials(
                project,
                workspace.invoices,
                workspace.payments,
                workspace.timeEntries,
                workspace.expenses,
                workspace.supplierInvoices,
              );
              return (
                <article key={project.id}>
                  <div className="project-icon">
                    <ProjectIcon size={18} />
                  </div>
                  <div className="dashboard-projects__name">
                    <strong>{project.name}</strong>
                    <span>
                      {client?.company ||
                        client?.name ||
                        'Client non renseigné'}
                    </span>
                  </div>
                  <div>
                    <small>Facturé</small>
                    <strong>
                      {stats.invoicedTotal
                        ? formatMoney(stats.invoicedTotal)
                        : '—'}
                    </strong>
                  </div>
                  <div>
                    <small>Temps réel</small>
                    <strong>
                      {stats.minutes ? formatMinutes(stats.minutes) : '—'}
                    </strong>
                  </div>
                  <StatusBadge status={project.status} />
                </article>
              );
            })}
          </div>
        ) : (
          <EmptyState
            title={`Aucun ${terminology.singular} actif`}
            text={`Les ${terminology.plural} planifiés ou terminés restent accessibles dans la liste complète.`}
          />
        )}
      </section>
      <section className="panel">
        <SectionHeading eyebrow="À traiter" title="Échéances" />
        {workspace.invoices.filter(
          (invoice) =>
            invoice.type !== 'credit_note' &&
            ['issued', 'partially_paid'].includes(invoice.status),
        ).length ? (
          <div className="deadline-list">
            {workspace.invoices
              .filter(
                (invoice) =>
                  invoice.type !== 'credit_note' &&
                  ['issued', 'partially_paid'].includes(invoice.status),
              )
              .slice(0, 5)
              .map((invoice) => (
                <button key={invoice.id} onClick={() => onNavigate('invoices')}>
                  <span>
                    <Receipt size={16} />
                  </span>
                  <div>
                    <strong>{invoice.number || 'Facture non numérotée'}</strong>
                    <small>{invoice.title}</small>
                  </div>
                  <em>{formatDate(invoice.dueDate)}</em>
                </button>
              ))}
          </div>
        ) : (
          <div className="compact-empty">
            <CheckCircle2 size={20} />
            <span>Aucune facture émise en attente.</span>
          </div>
        )}
      </section>
      <section className="panel">
        <SectionHeading eyebrow="Accès rapide" title="Nouvelle saisie" />
        <div className="quick-actions">
          <button onClick={() => onCreate({ type: 'client' })}>
            <UserRound />
            <span>Client</span>
          </button>
          <button
            disabled={Boolean(projectBlock)}
            title={projectBlock || `Créer un ${terminology.singular}`}
            onClick={() => onCreate({ type: 'project' })}
          >
            <ProjectIcon />
            <span>{terminology.singularTitle}</span>
          </button>
          <button
            disabled={Boolean(quoteBlock)}
            title={quoteBlock || 'Créer un devis'}
            onClick={() => onCreate({ type: 'document', entity: 'quotes' })}
          >
            <FileCheck2 />
            <span>Devis</span>
          </button>
          <button
            disabled={Boolean(expenseBlock)}
            title={expenseBlock || 'Créer une facture fournisseur'}
            onClick={() => onCreate({ type: 'supplierInvoice' })}
          >
            <WalletCards />
            <span>Facture fournisseur</span>
          </button>
        </div>
      </section>
    </div>
  );
}

function MetricCard({
  label,
  value,
  note,
  icon,
  tone,
}: {
  label: string;
  value: string;
  note: string;
  icon: React.ReactNode;
  tone: string;
}) {
  return (
    <article className={`metric-card metric-card--${tone}`}>
      <div className="metric-card__icon">{icon}</div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{note}</small>
      </div>
    </article>
  );
}

function ProjectsScreen({
  workspace,
  query,
  busy,
  readOnly,
  onEdit,
  onCreate,
  onArchive,
  onSaveTask,
  onSaveMilestone,
  onSetTaskStatus,
  onDeleteTask,
  onDeleteMilestone,
  agendaPlanningTarget,
  onAgendaPlanningTargetHandled,
}: {
  workspace: Workspace;
  query: string;
  busy: boolean;
  readOnly: boolean;
  onEdit: (item: Project) => void;
  onCreate: () => void;
  onArchive: (item: Project) => void;
  onSaveTask: (input: ProjectTaskDraft) => Promise<boolean>;
  onSaveMilestone: (input: ProjectMilestoneDraft) => Promise<boolean>;
  onSetTaskStatus: (
    item: ProjectTask,
    status: ProjectPlanningStatus,
  ) => Promise<boolean>;
  onDeleteTask: (item: ProjectTask) => Promise<boolean>;
  onDeleteMilestone: (item: ProjectMilestone) => Promise<boolean>;
  agendaPlanningTarget: string | null;
  onAgendaPlanningTargetHandled: () => void;
}) {
  const [mode, setMode] = useState<'overview' | 'planning'>('overview');
  const [planningTarget, setPlanningTarget] = useState<string | null>(
    agendaPlanningTarget,
  );
  useEffect(() => {
    if (!agendaPlanningTarget) return;
    setPlanningTarget(agendaPlanningTarget);
    setMode('planning');
    onAgendaPlanningTargetHandled();
  }, [agendaPlanningTarget, onAgendaPlanningTargetHandled]);
  const terminology = projectTerminology(
    workspace.settings!.business.nogaSection,
  );
  const ProjectIcon = terminology.icon === 'hard-hat' ? HardHat : FolderKanban;
  const projects = workspace.projects.filter((project) =>
    searchText(
      [
        project.name,
        project.address,
        workspace.clients.find((client) => client.id === project.clientId)
          ?.name,
      ],
      query,
    ),
  );
  const hasActiveClient = workspace.clients.some(
    (client) => !client.archivedAt,
  );
  if (!workspace.projects.length)
    return (
      <EmptyState
        icon={<ProjectIcon />}
        title={`Aucun ${terminology.singular}`}
        text={
          hasActiveClient
            ? `Créez votre premier ${terminology.singular} à partir d’un client réel.`
            : `Ajoutez ou réactivez d’abord un client, puis créez son ${terminology.singular}.`
        }
        actionLabel={
          hasActiveClient
            ? `Créer un ${terminology.singular}`
            : 'Ajoutez d’abord un client'
        }
        onAction={onCreate}
        disabled={!hasActiveClient}
      />
    );
  return (
    <div className="stack-layout">
      <section
        className="project-view-switch panel"
        aria-label="Vue des projets"
      >
        <div>
          <span>Une seule base, deux vues</span>
          <strong>
            {mode === 'overview'
              ? 'Rentabilité et durée'
              : 'Prochaines actions et échéances'}
          </strong>
        </div>
        <div role="group" aria-label="Choisir la vue">
          <button
            type="button"
            className={mode === 'overview' ? 'is-active' : ''}
            aria-pressed={mode === 'overview'}
            onClick={() => setMode('overview')}
          >
            <BarChart3 size={15} /> Vue d’ensemble
          </button>
          <button
            type="button"
            className={mode === 'planning' ? 'is-active' : ''}
            aria-pressed={mode === 'planning'}
            onClick={() => setMode('planning')}
          >
            <ListChecks size={15} /> Tâches & jalons
          </button>
        </div>
      </section>

      {mode === 'planning' ? (
        <ProjectPlanningPanel
          workspace={workspace}
          query={query}
          busy={busy}
          readOnly={readOnly}
          onSaveTask={onSaveTask}
          onSaveMilestone={onSaveMilestone}
          onSetTaskStatus={onSetTaskStatus}
          onDeleteTask={onDeleteTask}
          onDeleteMilestone={onDeleteMilestone}
          focusItemId={planningTarget}
          onFocusItemHandled={() => setPlanningTarget(null)}
        />
      ) : (
        <div className="project-card-grid">
          {projects.map((project) => {
            const client = workspace.clients.find(
              (item) => item.id === project.clientId,
            );
            const stats = projectFinancials(
              project,
              workspace.invoices,
              workspace.payments,
              workspace.timeEntries,
              workspace.expenses,
              workspace.supplierInvoices,
            );
            const projectTasks = workspace.projectTasks.filter(
              (task) =>
                task.projectId === project.id && task.status !== 'cancelled',
            );
            const completedTasks = projectTasks.filter(
              (task) => task.status === 'done',
            ).length;
            return (
              <article className="project-card" key={project.id}>
                <header>
                  <div className="project-card__icon">
                    <ProjectIcon size={20} />
                  </div>
                  <div>
                    <h3>{project.name}</h3>
                    <p>
                      {client?.company ||
                        client?.name ||
                        'Client non renseigné'}
                    </p>
                  </div>
                  <StatusBadge status={project.status} />
                </header>
                <p className="project-card__address">
                  {project.address || 'Adresse non renseignée'}
                </p>
                <div className="project-stats">
                  <div>
                    <span>Facturé TTC</span>
                    <strong>
                      {stats.invoicedTotal
                        ? formatMoney(stats.invoicedTotal)
                        : '—'}
                    </strong>
                  </div>
                  <div>
                    <span>Temps réel</span>
                    <strong>
                      {stats.minutes ? formatMinutes(stats.minutes) : '—'}
                    </strong>
                  </div>
                  <div>
                    <span>Marge nette saisie</span>
                    <strong>
                      {stats.invoicedNet || stats.laborCost || stats.expenseNet
                        ? formatMoney(stats.margin)
                        : '—'}
                    </strong>
                  </div>
                </div>
                <div className="project-dates">
                  <span>
                    <CalendarDays size={14} /> Prévu :{' '}
                    {formatDate(project.plannedStart)} →{' '}
                    {formatDate(project.plannedEnd)}
                  </span>
                  <span>
                    Réel : {formatDate(project.actualStart)} →{' '}
                    {formatDate(project.actualEnd)}
                  </span>
                  <span>
                    <ListChecks size={14} /> Planning : {completedTasks}/
                    {projectTasks.length} tâche
                    {projectTasks.length > 1 ? 's' : ''} terminée
                    {completedTasks > 1 ? 's' : ''}
                  </span>
                </div>
                <footer>
                  <Button
                    variant="secondary"
                    size="small"
                    onClick={() => onEdit(project)}
                  >
                    <Pencil size={14} /> Modifier
                  </Button>
                  <Button
                    variant="ghost"
                    size="small"
                    onClick={() => onArchive(project)}
                  >
                    <Archive size={14} /> Supprimer
                  </Button>
                </footer>
              </article>
            );
          })}
          {!projects.length ? (
            <div className="panel panel--span">
              <EmptyState
                title="Aucun résultat"
                text={`Modifiez votre recherche pour retrouver un ${terminology.singular}.`}
              />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function ClientsScreen({
  workspace,
  query,
  onOpen,
  onEdit,
  onCreate,
  onArchive,
  onRestore,
}: {
  workspace: Workspace;
  query: string;
  onOpen: (item: Client) => void;
  onEdit: (item: Client) => void;
  onCreate: () => void;
  onArchive: (item: Client) => void;
  onRestore: (item: Client) => void;
}) {
  const terminology = projectTerminology(
    workspace.settings!.business.nogaSection,
  );
  const [visibility, setVisibility] = useState<'active' | 'archived'>('active');
  const activeCount = workspace.clients.filter(
    (client) => !client.archivedAt,
  ).length;
  const archivedCount = workspace.clients.length - activeCount;
  const clients = workspace.clients.filter(
    (client) =>
      (visibility === 'archived'
        ? Boolean(client.archivedAt)
        : !client.archivedAt) &&
      searchText(
        [
          client.name,
          client.company,
          client.email,
          client.phone,
          client.address,
        ],
        query,
      ),
  );
  if (!workspace.clients.length)
    return (
      <EmptyState
        icon={<UserRound />}
        title="Aucun client"
        text="Ajoutez votre premier client. Aucun contact d’exemple n’est créé automatiquement."
        actionLabel="Ajouter un client"
        onAction={onCreate}
      />
    );
  return (
    <div className="stack-layout">
      <div
        className="client-directory-toolbar"
        role="group"
        aria-label="État des clients"
      >
        <button
          type="button"
          className={visibility === 'active' ? 'is-active' : ''}
          onClick={() => setVisibility('active')}
        >
          Actifs <span>{activeCount}</span>
        </button>
        <button
          type="button"
          className={visibility === 'archived' ? 'is-active' : ''}
          onClick={() => setVisibility('archived')}
        >
          Archivés <span>{archivedCount}</span>
        </button>
        <p>Archiver conserve tout l’historique commercial et comptable.</p>
      </div>
      <div className="panel table-panel">
        <table>
          <thead>
            <tr>
              <th>Client</th>
              <th>Coordonnées</th>
              <th>Adresse</th>
              <th>{terminology.pluralTitle}</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {clients.map((client) => {
              return (
                <tr key={client.id}>
                  <td>
                    <div className="identity-cell">
                      <span>
                        {(client.company || client.name)
                          .slice(0, 2)
                          .toUpperCase()}
                      </span>
                      <div>
                        <strong>{client.company || client.name}</strong>
                        {client.company && client.name ? (
                          <small>{client.name}</small>
                        ) : null}
                        {client.archivedAt ? (
                          <small>
                            Archivé le {formatDate(client.archivedAt)}
                          </small>
                        ) : null}
                      </div>
                    </div>
                  </td>
                  <td>
                    <strong className="table-subtle">
                      {client.email || '—'}
                    </strong>
                    <small>{client.phone || '—'}</small>
                  </td>
                  <td>
                    <span className="address-cell">
                      {client.address || '—'}
                    </span>
                  </td>
                  <td>
                    <span className="count-pill">
                      {
                        workspace.projects.filter(
                          (project) => project.clientId === client.id,
                        ).length
                      }
                    </span>
                  </td>
                  <td>
                    <div className="row-actions">
                      <Button
                        variant="secondary"
                        size="small"
                        onClick={() => onOpen(client)}
                      >
                        <Eye size={14} /> Dossier
                      </Button>
                      {client.archivedAt ? (
                        <Button
                          variant="ghost"
                          size="small"
                          onClick={() => onRestore(client)}
                        >
                          <RefreshCw size={14} /> Réactiver
                        </Button>
                      ) : (
                        <>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => onEdit(client)}
                            title="Modifier le client"
                            aria-label={`Modifier ${client.company || client.name}`}
                          >
                            <Pencil size={15} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Archiver sans supprimer l’historique"
                            onClick={() => onArchive(client)}
                            aria-label={`Archiver ${client.company || client.name}`}
                          >
                            <Archive size={15} />
                          </Button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!clients.length ? (
          <EmptyState
            title={
              visibility === 'archived'
                ? 'Aucun client archivé'
                : 'Aucun client actif'
            }
            text={
              query
                ? 'Aucun client ne correspond à cette recherche.'
                : visibility === 'archived'
                  ? 'Les clients archivés apparaîtront ici sans perdre leur historique.'
                  : 'Ajoutez un client ou réactivez une fiche archivée.'
            }
          />
        ) : null}
      </div>
    </div>
  );
}

function ClientDetail({
  client,
  workspace,
  close,
  onEdit,
}: {
  client: Client;
  workspace: Workspace;
  close: () => void;
  onEdit: () => void;
}) {
  const terminology = projectTerminology(
    workspace.settings!.business.nogaSection,
  );
  const projects = workspace.projects.filter(
    (project) => project.clientId === client.id,
  );
  const quotes = workspace.quotes.filter(
    (quote) => quote.clientId === client.id,
  );
  const invoices = workspace.invoices.filter(
    (invoice) => invoice.clientId === client.id,
  );
  const issuedInvoices = invoices.filter(
    (invoice) =>
      invoice.type !== 'credit_note' &&
      !['draft', 'cancelled'].includes(invoice.status),
  );
  const invoicedCents = invoices
    .filter((invoice) => !['draft', 'cancelled'].includes(invoice.status))
    .reduce(
      (total, invoice) => total + documentTotals(invoice.lines).totalCents,
      0,
    );
  const paidCents = issuedInvoices.reduce(
    (total, invoice) => total + invoicePaid(invoice.id, workspace.payments),
    0,
  );
  const openCents = issuedInvoices.reduce(
    (total, invoice) =>
      total + invoiceOpenBalance(invoice, invoices, workspace.payments),
    0,
  );
  const overdue = issuedInvoices.filter(
    (invoice) =>
      invoiceOpenBalance(invoice, invoices, workspace.payments) > 0 &&
      invoice.dueDate &&
      invoice.dueDate < todayIso(),
  );
  const documents = [
    ...quotes.map((quote) => ({
      id: quote.id,
      kind: 'Devis',
      number: quote.number || 'Brouillon',
      title: quote.title,
      date: quote.issueDate,
      status: quote.status,
      totalCents: documentTotals(quote.lines).totalCents,
    })),
    ...invoices.map((invoice) => ({
      id: invoice.id,
      kind: invoice.type === 'credit_note' ? 'Avoir' : 'Facture',
      number: invoice.number || 'Brouillon',
      title: invoice.title,
      date: invoice.issueDate,
      status: invoice.status,
      totalCents: documentTotals(invoice.lines).totalCents,
    })),
  ].sort((left, right) => right.date.localeCompare(left.date));

  return (
    <Modal
      title={client.company || client.name}
      description="Dossier client local : coordonnées, activité commerciale, projets et soldes ouverts réunis au même endroit."
      onClose={close}
      wide
    >
      <div className="client-360-identity">
        <div className="client-360-avatar">
          {(client.company || client.name).slice(0, 2).toUpperCase()}
        </div>
        <div>
          <strong>{client.company || client.name}</strong>
          {client.company && client.name ? <p>{client.name}</p> : null}
          <div className="client-360-links">
            {client.email ? (
              <a href={`mailto:${client.email}`}>
                <Mail size={14} /> {client.email}
              </a>
            ) : (
              <span>
                <Mail size={14} /> E-mail non renseigné
              </span>
            )}
            {client.phone ? (
              <a href={`tel:${client.phone}`}>
                <Phone size={14} /> {client.phone}
              </a>
            ) : (
              <span>
                <Phone size={14} /> Téléphone non renseigné
              </span>
            )}
            {client.address ? (
              <span>
                <MapPin size={14} /> {client.address.replace(/\n/g, ' · ')}
              </span>
            ) : null}
          </div>
        </div>
        <Button variant="secondary" size="small" onClick={onEdit}>
          <Pencil size={14} /> Modifier la fiche
        </Button>
      </div>
      <div className="client-360-metrics">
        <article>
          <span>Facturé net des avoirs</span>
          <strong>{invoices.length ? formatMoney(invoicedCents) : '—'}</strong>
          <small>
            {issuedInvoices.length} facture
            {issuedInvoices.length > 1 ? 's' : ''} émise
            {issuedInvoices.length > 1 ? 's' : ''}
          </small>
        </article>
        <article>
          <span>Encaissé</span>
          <strong>{paidCents ? formatMoney(paidCents) : '—'}</strong>
          <small>Paiements enregistrés</small>
        </article>
        <article className={openCents ? 'is-attention' : ''}>
          <span>Solde ouvert</span>
          <strong>
            {issuedInvoices.length ? formatMoney(openCents) : '—'}
          </strong>
          <small>
            {overdue.length
              ? `${overdue.length} facture${overdue.length > 1 ? 's' : ''} échue${overdue.length > 1 ? 's' : ''}`
              : 'Aucune échéance dépassée'}
          </small>
        </article>
        <article>
          <span>{terminology.pluralTitle}</span>
          <strong>{projects.length || '—'}</strong>
          <small>
            {
              projects.filter((project) =>
                ['in_progress', 'paused'].includes(project.status),
              ).length
            }{' '}
            actif
            {projects.filter((project) =>
              ['in_progress', 'paused'].includes(project.status),
            ).length > 1
              ? 's'
              : ''}
          </small>
        </article>
      </div>
      <div className="client-360-grid">
        <section>
          <header>
            <strong>{terminology.pluralTitle}</strong>
            <small>{projects.length} au total</small>
          </header>
          {projects.length ? (
            <div className="client-360-projects">
              {projects.map((project) => {
                const stats = projectFinancials(
                  project,
                  workspace.invoices,
                  workspace.payments,
                  workspace.timeEntries,
                  workspace.expenses,
                  workspace.supplierInvoices,
                );
                return (
                  <article key={project.id}>
                    <div>
                      <strong>{project.name}</strong>
                      <small>
                        {formatDate(project.plannedStart)} →{' '}
                        {formatDate(project.plannedEnd)}
                      </small>
                    </div>
                    <StatusBadge status={project.status} />
                    <span>
                      {stats.minutes
                        ? formatMinutes(stats.minutes)
                        : 'Aucun temps'}
                    </span>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="client-360-empty">
              Aucun {terminology.singular} lié.
            </div>
          )}
        </section>
        <section>
          <header>
            <strong>Documents récents</strong>
            <small>
              {quotes.length} devis · {invoices.length} facture
              {invoices.length > 1 ? 's' : ''}
            </small>
          </header>
          {documents.length ? (
            <div className="client-360-documents">
              {documents.slice(0, 8).map((document) => (
                <article key={`${document.kind}-${document.id}`}>
                  <span>{document.kind}</span>
                  <div>
                    <strong>{document.number}</strong>
                    <small>{document.title || formatDate(document.date)}</small>
                  </div>
                  <strong>{formatMoney(document.totalCents)}</strong>
                  <StatusBadge status={document.status} />
                </article>
              ))}
            </div>
          ) : (
            <div className="client-360-empty">Aucun devis ni facture.</div>
          )}
        </section>
      </div>
      {client.notes ? (
        <div className="info-strip">
          <FileText size={16} />
          <span>{client.notes}</span>
        </div>
      ) : null}
      <div className="form-actions">
        <Button variant="secondary" onClick={close}>
          Fermer
        </Button>
      </div>
    </Modal>
  );
}

type DocumentsProps =
  | {
      entity: 'quotes';
      workspace: Workspace;
      query: string;
      busy: boolean;
      onEdit: (item: Quote) => void;
      onCreate: () => void;
      onIssue: (item: Quote) => void;
      onStatus: (
        item: Quote,
        status: 'accepted' | 'refused' | 'expired' | 'cancelled',
      ) => void;
      onRevise: (item: Quote) => void;
      onConvert: (item: Quote) => void;
      onCreateOrder: (item: Quote) => void;
      onPrint: (item: Quote) => void;
      onArchive: (item: Quote) => void;
      onPayment?: never;
      onOpenPaymentJournal?: never;
    }
  | {
      entity: 'invoices';
      workspace: Workspace;
      query: string;
      busy: boolean;
      onEdit: (item: Invoice) => void;
      onCreate: () => void;
      onIssue: (item: Invoice) => void;
      onPayment: (item: Invoice) => void;
      onOpenPaymentJournal: (focus: AccountingEntryFocus) => void;
      onOpenOrder: (orderId: string) => void;
      onPrint: (item: Invoice) => void;
      onArchive: (item: Invoice) => void;
      onCorrect: (item: Invoice) => void;
      onAbandonCorrection: (workflow: InvoiceCorrectionWorkflow) => void;
      onArchiveCloud: (item: Invoice) => void;
      onConvert?: never;
      onStatus?: never;
      onRevise?: never;
    };

type LooseDocumentsProps = {
  entity: 'quotes' | 'invoices';
  onEdit: (item: Quote | Invoice) => void;
  onIssue: (item: Quote | Invoice) => void;
  onConvert: (item: Quote) => void;
  onCreateOrder: (item: Quote) => void;
  onPayment: (item: Invoice) => void;
  onOpenPaymentJournal: (focus: AccountingEntryFocus) => void;
  onOpenOrder: (orderId: string) => void;
  onPrint: (item: Quote | Invoice) => void;
  onArchive: (item: Quote | Invoice) => void;
  onCorrect: (item: Invoice) => void;
  onAbandonCorrection: (workflow: InvoiceCorrectionWorkflow) => void;
  onArchiveCloud: (item: Invoice) => void;
};

function DocumentsScreen(sourceProps: DocumentsProps) {
  let entity: 'quotes' | 'invoices' = sourceProps.entity;
  const { workspace, query, busy, onCreate } = sourceProps;
  const documents = entity === 'quotes' ? workspace.quotes : workspace.invoices;
  const filtered = documents.filter((document) =>
    searchText(
      [
        document.number,
        document.title,
        workspace.clients.find((client) => client.id === document.clientId)
          ?.name,
      ],
      query,
    ),
  );
  if (!documents.length) {
    return (
      <EmptyState
        icon={entity === 'quotes' ? <FileCheck2 /> : <Receipt />}
        title={entity === 'quotes' ? 'Aucun devis' : 'Aucune facture'}
        text={`Créez ${entity === 'quotes' ? 'un devis' : 'une facture'} avec vos propres lignes et montants. Vous pourrez ajouter le client directement pendant la saisie.`}
        actionLabel={entity === 'quotes' ? 'Créer un devis' : 'Créer une facture'}
        onAction={onCreate}
      />
    );
  }
  if (entity === 'quotes') {
    const props = sourceProps as Extract<DocumentsProps, { entity: 'quotes' }>;
    return (
      <div className="panel table-panel">
        <table>
          <thead>
            <tr>
              <th>Document</th>
              <th>Client</th>
              <th>Date</th>
              <th>Montant TTC</th>
              <th>Statut</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((document) => {
              const quote = document as Quote;
              const client = workspace.clients.find(
                (candidate) => candidate.id === quote.clientId,
              );
              const converted = workspace.invoices.some(
                (invoice) => invoice.quoteId === quote.id,
              );
              const convertedOrder = workspace.salesOrders.some(
                (order) => order.quoteId === quote.id,
              );
              const requiresOrder = quoteRequiresSalesOrder(
                quote,
                workspace.catalogItems,
              );
              return (
                <tr key={quote.id}>
                  <td>
                    <div className="document-cell">
                      <span>
                        <FileCheck2 size={16} />
                      </span>
                      <div>
                        <strong>
                          {quote.number || 'Numéro attribué à l’émission'}
                        </strong>
                        <small>{quote.title}</small>
                      </div>
                    </div>
                  </td>
                  <td>
                    <strong className="table-subtle">
                      {client?.company || client?.name || '—'}
                    </strong>
                  </td>
                  <td>
                    <span>{formatDate(quote.issueDate)}</span>
                    <small>Valable au {formatDate(quote.validUntil)}</small>
                  </td>
                  <td>
                    <strong>
                      {formatMoney(documentTotals(quote.lines).totalCents)}
                    </strong>
                  </td>
                  <td>
                    <StatusBadge status={quote.status} />
                    {converted ? <small>Facture créée</small> : null}
                    {convertedOrder ? <small>Commande créée</small> : null}
                  </td>
                  <td>
                    <div className="document-actions">
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={busy}
                        onClick={() =>
                          quote.status === 'draft'
                            ? props.onEdit(quote)
                            : props.onRevise(quote)
                        }
                        title={
                          quote.status === 'draft'
                            ? 'Modifier'
                            : 'Créer une version modifiable'
                        }
                        aria-label={
                          quote.status === 'draft'
                            ? `Modifier le devis ${quote.number || quote.title}`
                            : `Créer une version modifiable du devis ${quote.number || quote.title}`
                        }
                      >
                        <Pencil size={15} />
                      </Button>
                      {quote.status === 'draft' ? (
                        <>
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled={busy || !quote.lines.length}
                            onClick={() => props.onIssue(quote)}
                            title="Émettre"
                            aria-label={`Émettre le devis ${quote.title}`}
                          >
                            <CheckCircle2 size={16} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => props.onArchive(quote)}
                            title="Supprimer le brouillon"
                            aria-label={`Supprimer le brouillon ${quote.title}`}
                          >
                            <Archive size={15} />
                          </Button>
                        </>
                      ) : null}
                      {quote.status === 'issued' ? (
                        <>
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled={busy}
                            onClick={() => props.onStatus(quote, 'accepted')}
                            title="Marquer accepté"
                            aria-label={`Marquer le devis ${quote.number || quote.title} accepté`}
                          >
                            <CheckCircle2 size={16} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled={busy}
                            onClick={() => props.onStatus(quote, 'refused')}
                            title="Marquer refusé"
                            aria-label={`Marquer le devis ${quote.number || quote.title} refusé`}
                          >
                            <X size={16} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled={busy}
                            onClick={() => props.onStatus(quote, 'expired')}
                            title="Marquer expiré"
                            aria-label={`Marquer le devis ${quote.number || quote.title} expiré`}
                          >
                            <Clock3 size={16} />
                          </Button>
                        </>
                      ) : null}
                      {quote.status === 'accepted' &&
                      !converted &&
                      !convertedOrder ? (
                        <>
                        <Button
                          variant="ghost"
                          size="small"
                          className="quote-convert-button"
                          disabled={busy}
                          onClick={() => props.onStatus(quote, 'cancelled')}
                          title="Annuler l’acceptation sans supprimer le devis"
                        >
                          <X size={15} /> Annuler l’acceptation
                        </Button>
                        {requiresOrder ? (
                          <Button
                            variant="secondary"
                            size="small"
                            className="quote-convert-button"
                            disabled={busy}
                            onClick={() => props.onCreateOrder(quote)}
                            title="Créer la commande client et préparer la réservation"
                          >
                            <ArrowRight size={15} /> Créer la commande
                          </Button>
                        ) : (
                          <>
                            <Button
                              variant="secondary"
                              size="small"
                              className="quote-convert-button"
                              disabled={busy}
                              onClick={() => props.onConvert(quote)}
                              title="Créer une facture brouillon unique"
                            >
                              <ArrowRight size={15} /> Créer la facture
                            </Button>
                            <Button
                              variant="ghost"
                              size="small"
                              className="quote-convert-button"
                              disabled={busy}
                              onClick={() => props.onCreateOrder(quote)}
                              title="Créer une commande modèle pour planifier des factures récurrentes"
                            >
                              <CalendarDays size={15} /> Planifier
                            </Button>
                          </>
                        )}
                        </>
                      ) : null}
                      {quote.status !== 'draft' ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => props.onPrint(quote)}
                          title="Imprimer"
                          aria-label={`Imprimer le devis ${quote.number || quote.title}`}
                        >
                          <Printer size={15} />
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!filtered.length ? (
          <EmptyState
            title="Aucun résultat"
            text="Aucun devis ne correspond à cette recherche."
          />
        ) : null}
      </div>
    );
  }
  const props = sourceProps as unknown as LooseDocumentsProps;
  entity = sourceProps.entity as 'quotes' | 'invoices';
  return (
    <div className="panel table-panel">
      <table>
        <thead>
          <tr>
            <th>Document</th>
            <th>Client</th>
            <th>Date</th>
            <th>Montant TTC</th>
            {entity === 'invoices' ? <th>Encaissé</th> : null}
            <th>Statut</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {filtered.map((item) => {
            const client = workspace.clients.find(
              (candidate) => candidate.id === item.clientId,
            );
            const totals = documentTotals(item.lines);
            const paid =
              entity === 'invoices'
                ? invoicePaid(item.id, workspace.payments)
                : 0;
            const invoice = entity === 'invoices' ? (item as Invoice) : null;
            const linkedOrderBatch = invoice
              ? workspace.salesOrderInvoiceBatches.find(
                  (batch) => batch.invoiceId === invoice.id,
                )
              : undefined;
            const linkedOrderDraftBatch =
              item.status === 'draft' ? linkedOrderBatch : undefined;
            const correctionWorkflow = invoice
              ? invoiceCorrectionWorkflowFor(
                  invoice.id,
                  workspace.invoiceCorrectionWorkflows,
                )
              : undefined;
            const correctionCredit = correctionWorkflow
              ? workspace.invoices.find(
                  (candidate) =>
                    candidate.id === correctionWorkflow.creditNoteId,
                )
              : undefined;
            const correctionReplacement = correctionWorkflow
              ? workspace.invoices.find(
                  (candidate) =>
                    candidate.id === correctionWorkflow.replacementInvoiceId,
                )
              : undefined;
            const correctionCanBeAbandoned = Boolean(
              correctionWorkflow &&
                correctionCredit?.status === 'draft' &&
                !correctionCredit.number &&
                correctionReplacement?.status === 'draft' &&
                !correctionReplacement.number,
            );
            const modificationAction = invoice
              ? invoiceModificationAction(
                  invoice,
                  correctionWorkflow,
                  workspace.invoices,
                )
              : null;
            const modificationUsesReplacement = Boolean(
              modificationAction && modificationAction.invoice.id !== item.id,
            );
            return (
              <tr key={item.id}>
                <td>
                  <div className="document-cell">
                    <span>
                      {entity === 'quotes' ? (
                        <FileCheck2 size={16} />
                      ) : (
                        <Receipt size={16} />
                      )}
                    </span>
                    <div>
                      <strong>
                        {item.number || 'Numéro attribué à l’émission'}
                      </strong>
                      <small>{item.title}</small>
                    </div>
                  </div>
                </td>
                <td>
                  <strong className="table-subtle">
                    {client?.company || client?.name || '—'}
                  </strong>
                </td>
                <td>
                  <span>{formatDate(item.issueDate)}</span>
                  <small>
                    {entity === 'quotes'
                      ? `Valable au ${formatDate((item as Quote).validUntil)}`
                      : invoice?.type === 'credit_note'
                        ? 'Avoir sans encaissement'
                        : invoice?.type === 'deposit'
                          ? invoice.depositPercentageBp
                            ? `Acompte ${(invoice.depositPercentageBp / 100).toLocaleString('fr-CH')} % · échéance ${formatDate(invoice.dueDate)}`
                            : `Facture d’acompte · échéance ${formatDate(invoice.dueDate)}`
                        : `Échéance ${formatDate(invoice?.dueDate ?? '')}`}
                  </small>
                </td>
                <td>
                  <strong>{formatMoney(totals.totalCents)}</strong>
                </td>
                {entity === 'invoices' ? (
                  <td>
                    <strong>
                      {invoice?.type === 'credit_note'
                        ? 'Non applicable'
                        : paid
                          ? formatMoney(paid)
                          : '—'}
                    </strong>
                    {invoice?.type !== 'credit_note' ? (
                      <PaymentAccountingProofs
                        invoiceId={item.id}
                        payments={workspace.payments}
                        onOpenJournal={props.onOpenPaymentJournal}
                      />
                    ) : null}
                  </td>
                ) : null}
                <td>
                  <StatusBadge status={item.status} />
                  {linkedOrderDraftBatch ? (
                    <small>Géré depuis la commande</small>
                  ) : null}
                  {correctionWorkflow ? (
                    <small>Correction liée</small>
                  ) : null}
                </td>
                <td>
                  <div className="document-actions">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        if (linkedOrderDraftBatch) {
                          props.onOpenOrder(linkedOrderDraftBatch.salesOrderId);
                          return;
                        }
                        entity === 'quotes'
                          ? props.onEdit(item as Quote)
                          : props.onEdit(item as Invoice);
                      }}
                      title={
                        linkedOrderDraftBatch
                          ? 'Voir la commande liée · brouillon non modifiable'
                          : item.status === 'draft'
                            ? 'Modifier'
                            : 'Consulter'
                      }
                    >
                      {linkedOrderDraftBatch ? (
                        <ClipboardCheck size={15} />
                      ) : (
                        <Pencil size={15} />
                      )}
                    </Button>
                    {item.status === 'draft' && !linkedOrderDraftBatch ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={busy || !item.lines.length}
                        onClick={() =>
                          entity === 'quotes'
                            ? props.onIssue(item as Quote)
                            : props.onIssue(item as Invoice)
                        }
                        title="Émettre"
                      >
                        <CheckCircle2 size={16} />
                      </Button>
                    ) : null}
                    {entity === 'quotes' && item.status === 'accepted' ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={busy}
                        onClick={() => props.onConvert(item as Quote)}
                        title="Créer la facture depuis le devis accepté"
                      >
                        <ArrowRight size={16} />
                      </Button>
                    ) : null}
                    {entity === 'invoices' &&
                    invoice?.type !== 'credit_note' &&
                    item.status !== 'draft' &&
                    item.status !== 'cancelled' ? (
                      <Button
                        variant="secondary"
                        size="small"
                        disabled={busy}
                        onClick={() => {
                          if (!modificationAction) return;
                          if (
                            modificationAction.kind === 'edit' ||
                            modificationAction.kind === 'view'
                          ) {
                            props.onEdit(modificationAction.invoice);
                          } else {
                            props.onCorrect(modificationAction.invoice);
                          }
                        }}
                        title={
                          modificationUsesReplacement
                            ? modificationAction?.kind === 'view'
                              ? 'Consulter la facture de remplacement annulée'
                              : 'Continuer depuis la facture de remplacement existante'
                            : 'Modifier avec une trace comptable sans réécrire l’original'
                        }
                      >
                        <Pencil size={14} />
                        {modificationUsesReplacement
                          ? modificationAction?.kind === 'edit'
                            ? 'Ouvrir la version modifiable'
                            : modificationAction?.kind === 'view'
                              ? 'Voir la version annulée'
                              : 'Modifier la version récente'
                          : 'Modifier'}
                      </Button>
                    ) : null}
                    {entity === 'invoices' &&
                    correctionWorkflow &&
                    correctionCanBeAbandoned ? (
                      <Button
                        variant="secondary"
                        size="small"
                        disabled={busy}
                        onClick={() =>
                          props.onAbandonCorrection(correctionWorkflow)
                        }
                        title="Supprimer les deux brouillons de correction sans toucher à l’original"
                      >
                        <X size={14} /> Abandonner la correction
                      </Button>
                    ) : null}
                    {entity === 'invoices' &&
                    invoice?.type !== 'credit_note' &&
                    item.status !== 'draft' &&
                    item.status !== 'paid' &&
                    item.status !== 'cancelled' ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => props.onPayment(item as Invoice)}
                        title="Enregistrer un paiement"
                      >
                        <Banknote size={16} />
                      </Button>
                    ) : null}
                    {item.status !== 'draft' ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() =>
                          entity === 'quotes'
                            ? props.onPrint(item as Quote)
                            : props.onPrint(item as Invoice)
                        }
                        title="Imprimer"
                      >
                        <Printer size={15} />
                      </Button>
                    ) : null}
                    {entity === 'invoices' &&
                    item.status !== 'draft' &&
                    item.status !== 'cancelled' ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={busy}
                        onClick={() => props.onArchiveCloud(item as Invoice)}
                        title="Archiver le PDF dans le coffre Zentra"
                        aria-label={`Archiver ${item.number || item.title} dans le coffre Zentra`}
                      >
                        <CloudUpload size={15} />
                      </Button>
                    ) : null}
                    {item.status === 'draft' &&
                    !linkedOrderDraftBatch &&
                    !correctionWorkflow ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() =>
                          entity === 'quotes'
                            ? props.onArchive(item as Quote)
                            : props.onArchive(item as Invoice)
                        }
                        title="Supprimer le brouillon"
                      >
                        <Archive size={15} />
                      </Button>
                    ) : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!filtered.length ? (
        <EmptyState
          title="Aucun résultat"
          text="Aucun document ne correspond à cette recherche."
        />
      ) : null}
    </div>
  );
}

function TimeScreen({
  workspace,
  query,
  onCreate,
  onEdit,
  onTimer,
  onBill,
  onArchive,
}: {
  workspace: Workspace;
  query: string;
  onCreate: () => void;
  onEdit: (item: TimeEntry) => void;
  onTimer: () => void;
  onBill: () => void;
  onArchive: (item: TimeEntry) => void;
}) {
  const terminology = projectTerminology(
    workspace.settings!.business.nogaSection,
  );
  const entries = workspace.timeEntries.filter((entry) =>
    searchText(
      [
        entry.note,
        workspace.projects.find((project) => project.id === entry.projectId)
          ?.name,
        workspace.projectTasks.find((task) => task.id === entry.taskId)?.title,
        workspace.employees.find((employee) => employee.id === entry.employeeId)
          ?.name,
      ],
      query,
    ),
  );
  const totalMinutes = entries.reduce(
    (total, entry) => total + entry.minutes,
    0,
  );
  const totalCost = entries.reduce(
    (total, entry) =>
      total + Math.round((entry.minutes * entry.hourlyCostCents) / 60),
    0,
  );
  const prerequisites: WorkspacePrerequisites = {
    clients: workspace.clients.filter((client) => !client.archivedAt).length,
    projects: workspace.projects.length,
    trackableProjects: workspace.projects.filter(
      (project) => project.status !== 'closed',
    ).length,
    activeEmployees: workspace.employees.filter((employee) => employee.active)
      .length,
    activeSuppliers: workspace.suppliers.filter(
      (supplier) => !supplier.archivedAt,
    ).length,
    costCategories: workspace.settings!.work.costCategories.length,
    billingSetupDeferred: workspace.settings!.setupDeferred?.billing === true,
    workSetupDeferred: workspace.settings!.setupDeferred?.work === true,
  };
  const entryBlock = creationBlockReason('time', prerequisites);
  const timerBlock = timerBlockReason(
    prerequisites,
    Boolean(workspace.activeTimer),
  );
  const readyToBill = workspace.timeEntries.filter(
    (entry) =>
      entry.status === 'approved' &&
      entry.billable &&
      (entry.billingRateCents ?? 0) > 0 &&
      entry.billingStatus === 'unbilled',
  ).length;
  return (
    <div className="stack-layout">
      <section className="time-hero">
        <div className="time-hero__icon">
          <TimerReset size={28} />
        </div>
        <div>
          <p className="eyebrow">Chronomètre local</p>
          <h2>
            {workspace.activeTimer
              ? 'Un pointage est déjà en cours'
              : 'Mesurez puis facturez le temps réel.'}
          </h2>
          <p>
            {workspace.activeTimer
              ? 'Arrêtez-le depuis la barre supérieure pour enregistrer la durée.'
              : timerBlock
                ? timerBlock
                : `Choisissez un ${terminology.singular} et un collaborateur. Les heures approuvées peuvent ensuite devenir une facture brouillon sans ressaisie.`}
          </p>
        </div>
        <div className="time-hero__actions">
          <Button
            variant="secondary"
            size="large"
            onClick={onBill}
            disabled={!readyToBill}
            title={
              readyToBill
                ? `${readyToBill} saisie(s) prête(s)`
                : 'Approuvez d’abord une heure facturable avec un tarif'
            }
          >
            <Receipt size={17} /> Facturer les heures
            {readyToBill ? <em>{readyToBill}</em> : null}
          </Button>
          <Button
            size="large"
            onClick={onTimer}
            disabled={Boolean(timerBlock)}
            title={timerBlock || 'Démarrer un pointage réel'}
          >
            <Play size={17} /> Démarrer
          </Button>
        </div>
      </section>
      <div className="summary-strip">
        <div>
          <span>Temps affiché</span>
          <strong>{entries.length ? formatMinutes(totalMinutes) : '—'}</strong>
        </div>
        <div>
          <span>Coût de main-d’œuvre</span>
          <strong>{entries.length ? formatMoney(totalCost) : '—'}</strong>
        </div>
        <div>
          <span>Prêt à facturer</span>
          <strong>{readyToBill || '—'}</strong>
        </div>
      </div>
      {workspace.timeEntries.length ? (
        <div className="panel table-panel">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>{terminology.singularTitle}</th>
                <th>Collaborateur</th>
                <th>Durée</th>
                <th>Facturation</th>
                <th>Coût</th>
                <th>Validation</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const project = workspace.projects.find(
                  (item) => item.id === entry.projectId,
                );
                const employee = workspace.employees.find(
                  (item) => item.id === entry.employeeId,
                );
                const task = workspace.projectTasks.find(
                  (item) => item.id === entry.taskId,
                );
                const linked = entry.billingStatus !== 'unbilled';
                const billingLabel =
                  entry.billingStatus === 'billed'
                    ? `Facturée${entry.billingInvoiceNumber ? ` · ${entry.billingInvoiceNumber}` : ''}`
                    : entry.billingStatus === 'reserved'
                      ? 'Réservée dans un brouillon'
                      : entry.billable
                        ? entry.status === 'approved'
                          ? 'À facturer'
                          : 'À approuver'
                        : 'Interne';
                return (
                  <tr key={entry.id}>
                    <td>{formatDate(entry.date)}</td>
                    <td>
                      <strong>{project?.name || '—'}</strong>
                      {task ? <small>Tâche : {task.title}</small> : null}
                    </td>
                    <td>{employee?.name || '—'}</td>
                    <td>
                      <strong>{formatMinutes(entry.minutes)}</strong>
                      <small>Pause : {entry.breakMinutes} min</small>
                    </td>
                    <td>
                      <span
                        className={`category-pill billing-pill billing-pill--${entry.billingStatus}`}
                      >
                        {billingLabel}
                      </span>
                      {entry.billable ? (
                        <small>{formatMoney(entry.billingRateCents)} / h</small>
                      ) : null}
                    </td>
                    <td>
                      {formatMoney(
                        Math.round(
                          (entry.minutes * entry.hourlyCostCents) / 60,
                        ),
                      )}
                    </td>
                    <td>
                      <StatusBadge status={entry.status} />
                    </td>
                    <td>
                      <div className="row-actions">
                        <Button
                          variant="ghost"
                          size="icon"
                          disabled={linked}
                          title={
                            linked
                              ? 'Cette heure est liée à une facture'
                              : 'Modifier'
                          }
                          onClick={() => onEdit(entry)}
                        >
                          <Pencil size={15} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          disabled={linked}
                          title={
                            linked
                              ? 'Supprimez le brouillon de facture pour libérer cette heure'
                              : 'Supprimer'
                          }
                          onClick={() => onArchive(entry)}
                        >
                          <Archive size={15} />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!entries.length ? (
            <EmptyState
              title="Aucun résultat"
              text="Aucune saisie de temps ne correspond à la recherche."
            />
          ) : null}
        </div>
      ) : (
        <EmptyState
          icon={<Clock3 />}
          title="Aucune heure saisie"
          text={
            entryBlock ||
            'Démarrez un pointage ou saisissez une durée manuellement.'
          }
          actionLabel={entryBlock ? undefined : 'Saisir des heures'}
          onAction={entryBlock ? undefined : onCreate}
        />
      )}
    </div>
  );
}

function TeamScreen({
  workspace,
  query,
  onCreateEmployee,
  onEditEmployee,
  onCreatePayslip,
  onImportPayslips,
  onEditPayslip,
  onPostPayslip,
  onPayPayslip,
  onPrint,
  onArchiveEmployee,
  onArchivePayslip,
}: {
  workspace: Workspace;
  query: string;
  onCreateEmployee: () => void;
  onEditEmployee: (item: Employee) => void;
  onCreatePayslip: () => void;
  onImportPayslips: () => void;
  onEditPayslip: (item: Payslip) => void;
  onPostPayslip: (item: Payslip) => void;
  onPayPayslip: (item: Payslip) => void;
  onPrint: (item: Payslip) => void;
  onArchiveEmployee: (item: Employee) => void;
  onArchivePayslip: (item: Payslip) => void;
}) {
  const employees = workspace.employees.filter((employee) =>
    searchText([employee.name, employee.role, employee.email], query),
  );
  const payrollEnabled = workspace.settings?.payroll.enabled ?? false;
  const legacyPaymentToRepair = workspace.payslips.find(
    (payslip) =>
      payslip.status === 'paid' &&
      (!payslip.paymentDate || !payslip.paymentJournalEntryId),
  );
  if (legacyPaymentToRepair)
    return (
      <div className="stack-layout">
        <SectionHeading
          title="Collaborateurs et salaires"
          description="Une reprise contrôlée est nécessaire avant de poursuivre la paie."
        />
        <div className="warning-card">
          <RefreshCw size={20} />
          <div>
            <strong>Ancien paiement de salaire à régulariser</strong>
            <p>
              La fiche {legacyPaymentToRepair.period} est marquée payée, mais sa
              date ou son lien comptable manque. Indiquez la date réelle; Zentra
              créera ou reliera l’écriture sans modifier les montants
              historiques.
            </p>
          </div>
          <Button
            variant="secondary"
            onClick={() => onPayPayslip(legacyPaymentToRepair)}
          >
            Régulariser le paiement
          </Button>
        </div>
      </div>
    );
  return (
    <div className="stack-layout">
      <SectionHeading
        title="Collaborateurs"
        description="Les coûts horaires sont utilisés uniquement lorsqu’ils ont été saisis."
        action={
          <Button onClick={onCreateEmployee}>
            <Plus size={16} /> Nouveau collaborateur
          </Button>
        }
      />
      {workspace.employees.length ? (
        <div className="employee-grid">
          {employees.map((employee) => (
            <article className="employee-card" key={employee.id}>
              <div className="employee-card__avatar">
                {employee.name.slice(0, 2).toUpperCase()}
              </div>
              <div className="employee-card__main">
                <h3>{employee.name}</h3>
                <p>
                  {employee.role || 'Fonction non renseignée'} ·{' '}
                  {employee.salaryMode === 'monthly'
                    ? 'salaire mensuel'
                    : 'salaire horaire'}
                </p>
                <div>
                  <span>
                    Taux d’activité{' '}
                    <strong>
                      {employee.employmentRate
                        ? `${employee.employmentRate} %`
                        : '—'}
                    </strong>
                  </span>
                  <span>
                    Coût horaire{' '}
                    <strong>{formatMoney(employee.hourlyCostCents)}</strong>
                  </span>
                </div>
              </div>
              <footer>
                <StatusBadge
                  status={employee.active ? 'validated' : 'incomplete'}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onEditEmployee(employee)}
                >
                  <Pencil size={15} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onArchiveEmployee(employee)}
                >
                  <Archive size={15} />
                </Button>
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<Users />}
          title="Aucun collaborateur"
          text="Ajoutez uniquement les personnes réellement employées ou suivies."
          actionLabel="Ajouter un collaborateur"
          onAction={onCreateEmployee}
        />
      )}
      <section className="panel payroll-panel">
        <SectionHeading
          eyebrow="Paie locale assistée"
          title="Fiches de salaire"
          description="Importez les anciennes fiches, contrôlez les données détectées puis générez les suivantes depuis un modèle confirmé."
          action={
            payrollEnabled ? (
              <div className="payroll-heading-actions">
                <Button variant="secondary" onClick={onImportPayslips}>
                  <ScanLine size={16} /> Importer des fiches
                  {workspace.payrollImports.filter(
                    (item) => item.status === 'needs_review',
                  ).length ? (
                    <em>
                      {
                        workspace.payrollImports.filter(
                          (item) => item.status === 'needs_review',
                        ).length
                      }
                    </em>
                  ) : null}
                </Button>
                {workspace.employees.length ? (
                  <Button onClick={onCreatePayslip}>
                    <Plus size={16} /> Nouvelle fiche
                  </Button>
                ) : null}
              </div>
            ) : null
          }
        />
        {!payrollEnabled ? (
          <div className="warning-card">
            <ShieldCheck size={20} />
            <div>
              <strong>Module désactivé</strong>
              <p>
                Activez la paie dans Paramètres puis renseignez les organismes
                et taux contrôlés.
              </p>
            </div>
          </div>
        ) : !workspace.settings?.payroll.fiduciaryValidated ? (
          <div className="warning-card">
            <ShieldCheck size={20} />
            <div>
              <strong>Configuration à faire valider</strong>
              <p>
                Les fiches restent incomplètes jusqu’à confirmation du contrôle
                par votre fiduciaire.
              </p>
            </div>
          </div>
        ) : null}
        {workspace.payrollImports.some(
          (item) => item.status === 'needs_review',
        ) ? (
          <button className="payroll-review-banner" onClick={onImportPayslips}>
            <span>
              <ScanLine size={19} />
              <strong>
                {
                  workspace.payrollImports.filter(
                    (item) => item.status === 'needs_review',
                  ).length
                }{' '}
                document(s) à contrôler
              </strong>
            </span>
            <small>
              Reprendre l’assistant d’import <ArrowRight size={14} />
            </small>
          </button>
        ) : null}
        {workspace.payslips.length ? (
          <div className="payslip-list">
            {workspace.payslips.map((payslip) => {
              const employee = workspace.employees.find(
                (item) => item.id === payslip.employeeId,
              );
              const totals = payslipTotals(payslip);
              const locked =
                payslip.status === 'posted' || payslip.status === 'paid';
              return (
                <article key={payslip.id}>
                  <div>
                    <FileText size={17} />
                    <span>
                      <strong>{employee?.name || 'Collaborateur'}</strong>
                      <small>
                        Période {payslip.period}
                        {payslip.status === 'paid' && payslip.paymentDate
                          ? ` · payé le ${formatDate(payslip.paymentDate)}`
                          : ''}
                      </small>
                    </span>
                  </div>
                  <div>
                    <small>Brut saisi</small>
                    <strong>{formatMoney(totals.earnings)}</strong>
                  </div>
                  <div>
                    <small>Net calculé</small>
                    <strong>{formatMoney(totals.net)}</strong>
                  </div>
                  <StatusBadge
                    status={payslip.status}
                    label={
                      payslip.status === 'incomplete'
                        ? 'À contrôler'
                        : undefined
                    }
                  />
                  <div className="row-actions">
                    {!locked ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => onEditPayslip(payslip)}
                        title="Modifier"
                      >
                        <Pencil size={15} />
                      </Button>
                    ) : null}
                    {payslip.status === 'validated' ? (
                      <Button
                        variant="secondary"
                        size="small"
                        onClick={() => {
                          if (
                            window.confirm(
                              `Comptabiliser et verrouiller définitivement la fiche ${payslip.period} ?`,
                            )
                          )
                            onPostPayslip(payslip);
                        }}
                      >
                        <LockKeyhole size={14} /> Comptabiliser et verrouiller
                      </Button>
                    ) : null}
                    {payslip.status === 'posted' ? (
                      <Button
                        variant="secondary"
                        size="small"
                        onClick={() => onPayPayslip(payslip)}
                      >
                        <Banknote size={14} /> Marquer payé
                      </Button>
                    ) : null}
                    {['validated', 'posted', 'paid'].includes(
                      payslip.status,
                    ) ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => onPrint(payslip)}
                        title="Imprimer"
                      >
                        <Printer size={15} />
                      </Button>
                    ) : null}
                    {!locked ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => onArchivePayslip(payslip)}
                        title="Supprimer"
                      >
                        <Archive size={15} />
                      </Button>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        ) : payrollEnabled ? (
          <div className="compact-empty">
            <FileText size={20} />
            <span>
              Aucune fiche de salaire créée. Importez un ancien document ou
              créez la première fiche.
            </span>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function ReportsScreen({ workspace }: { workspace: Workspace }) {
  const terminology = projectTerminology(
    workspace.settings!.business.nogaSection,
  );
  if (!workspace.projects.length)
    return (
      <EmptyState
        icon={<BarChart3 />}
        title="Aucun rapport disponible"
        text={`Les rapports apparaissent après la création d’un ${terminology.singular}. Aucun graphique fictif n’est affiché.`}
      />
    );
  const rows = workspace.projects.map((project) => ({
    project,
    stats: projectFinancials(
      project,
      workspace.invoices,
      workspace.payments,
      workspace.timeEntries,
      workspace.expenses,
      workspace.supplierInvoices,
    ),
  }));
  const withFinancialData = rows.filter(
    (row) =>
      row.stats.invoicedNet || row.stats.laborCost || row.stats.expenseNet,
  );
  return (
    <div className="stack-layout">
      <div className="report-callout">
        <BarChart3 size={24} />
        <div>
          <strong>Calculs transparents</strong>
          <p>
            Marge = facturation nette émise − coûts horaires saisis − dépenses
            nettes. Les brouillons sont exclus.
          </p>
        </div>
      </div>
      {withFinancialData.length ? (
        <div className="report-grid">
          {withFinancialData.map(({ project, stats }) => (
            <article className="report-card" key={project.id}>
              <header>
                <div>
                  <h3>{project.name}</h3>
                  <p>{formatMinutes(stats.minutes)} saisis</p>
                </div>
                <StatusBadge status={project.status} />
              </header>
              <div className="report-card__figures">
                <div>
                  <span>Facturé net</span>
                  <strong>{formatMoney(stats.invoicedNet)}</strong>
                </div>
                <div>
                  <span>Main-d’œuvre</span>
                  <strong>{formatMoney(stats.laborCost)}</strong>
                </div>
                <div>
                  <span>Dépenses nettes</span>
                  <strong>{formatMoney(stats.expenseNet)}</strong>
                </div>
              </div>
              <footer>
                <span>Marge issue des saisies</span>
                <strong className={stats.margin < 0 ? 'is-negative' : ''}>
                  {formatMoney(stats.margin)}
                </strong>
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          title="Pas encore assez de données"
          text="Ajoutez une facture émise, des heures avec coût ou une dépense pour calculer la rentabilité. Aucun pourcentage n’est inventé."
        />
      )}
    </div>
  );
}

function SettingsScreen({
  workspace,
  busy,
  setBusy,
  onWorkspace,
  onNotice,
  onOpenAccounting,
  onCloudAccountChange,
}: {
  workspace: Workspace;
  busy: boolean;
  setBusy: (value: boolean) => void;
  onWorkspace: Dispatch<SetStateAction<Workspace | null>>;
  onNotice: (value: Notice | null) => void;
  onOpenAccounting: () => void;
  onCloudAccountChange?: (account: CloudAccountState) => void;
}) {
  const [settings, setSettings] = useState<AppSettings>(workspace.settings!);
  const [vatDraft, setVatDraft] = useState('');
  const storedLppPlan = settings.payroll.lppPlanEvidence;
  const [lppPlanEnabled, setLppPlanEnabled] = useState(
    Boolean(storedLppPlan),
  );
  const storedLaaSmallSalaryException =
    settings.payroll.laaSmallSalaryException;
  const [laaSmallSalaryExceptionEnabled, setLaaSmallSalaryExceptionEnabled] =
    useState(Boolean(storedLaaSmallSalaryException?.enabled));
  const org = settings.organization;
  const billing = settings.billing;
  const accountingReadiness = buildSetupReadiness(workspace, settings).steps.find(
    (item) => item.id === 'accounting',
  )!;

  function navigateToSetting(targetId: string) {
    const target = document.getElementById(targetId);
    if (!(target instanceof HTMLElement)) return;
    const reducedMotion = window.matchMedia?.(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    target.scrollIntoView({
      behavior: reducedMotion ? 'auto' : 'smooth',
      block: 'start',
    });
    target.focus({ preventScroll: true });
  }

  async function execute(action: () => Promise<Workspace>, success: string) {
    setBusy(true);
    onNotice(null);
    try {
      const next = await action();
      onWorkspace(next);
      setSettings(next.settings!);
      onNotice({ tone: 'success', text: success });
    } catch (reason) {
      onNotice({
        tone: 'error',
        text: errorMessage(reason, 'L’action locale a échoué.'),
      });
    } finally {
      setBusy(false);
    }
  }

  async function backup() {
    setBusy(true);
    onNotice(null);
    try {
      const result = await desktopApi.createBackup(
        settings.backup.folder || undefined,
      );
      onWorkspace(result.workspace);
      onNotice({ tone: 'success', text: `Sauvegarde créée : ${result.path}` });
    } catch (reason) {
      onNotice({
        tone: 'error',
        text: errorMessage(reason, 'La sauvegarde n’a pas pu être créée.'),
      });
    } finally {
      setBusy(false);
    }
  }

  async function restore() {
    const source = await desktopApi.chooseRestoreFile();
    if (
      !source ||
      !window.confirm(
        'Une sauvegarde de sécurité sera créée avant le remplacement. Restaurer le fichier sélectionné ?',
      )
    )
      return;
    await execute(
      () => desktopApi.restoreBackup(source),
      'La sauvegarde a été restaurée et contrôlée.',
    );
  }

  async function exportPortableData(format: 'json' | 'csv') {
    setBusy(true);
    onNotice(null);
    try {
      const { path } = await desktopApi.exportData(format);
      onNotice({
        tone: 'success',
        text: `${format === 'json' ? 'Export JSON' : 'Archive de listes CSV'} créée : ${path}`,
      });
    } catch (reason) {
      onNotice({
        tone: 'error',
        text: errorMessage(
          reason,
          format === 'json'
            ? 'L’export JSON n’a pas pu être créé.'
            : 'L’archive CSV n’a pas pu être créée.',
        ),
      });
    } finally {
      setBusy(false);
    }
  }

  async function chooseBackupFolder() {
    const folder = await desktopApi.chooseBackupFolder();
    if (!folder) return;
    const next = { ...settings, backup: { ...settings.backup, folder } };
    setSettings(next);
    await execute(
      () => desktopApi.saveSettings(next),
      'Le dossier de sauvegarde manuelle a été enregistré.',
    );
  }

  async function chooseLogo() {
    let sourcePath: string | null;
    try {
      sourcePath = await desktopApi.chooseLogo();
    } catch (reason) {
      onNotice({
        tone: 'error',
        text: errorMessage(reason, 'Le sélecteur du logo n’a pas pu être ouvert.'),
      });
      return;
    }
    if (!sourcePath) return;
    await execute(async () => {
      const logoPath = await desktopApi.stageCompanyLogo(sourcePath);
      const next = {
        ...settings,
        organization: { ...settings.organization, logoPath },
      };
      return desktopApi.saveSettings(next);
    }, 'Le logo a été vérifié, copié dans les données locales et enregistré pour les documents.');
  }

  async function removeLogo() {
    const next = {
      ...settings,
      organization: { ...settings.organization, logoPath: undefined },
    };
    await execute(
      () => desktopApi.saveSettings(next),
      'Le logo a été retiré des prochains documents. Les documents déjà émis restent figés.',
    );
  }

  async function applySwissPayrollProfile2026() {
    setBusy(true);
    onNotice(null);
    try {
      const [profiles, existing] = await Promise.all([
        desktopApi.getPayrollRegulatoryProfiles(),
        desktopApi.listPayrollContributionDefinitions(),
      ]);
      const profile = profiles.find((item) => item.id === 'CH-2026');
      if (!profile)
        throw new Error(
          'Le profil réglementaire CH-2026 n’est pas disponible dans cette version locale.',
        );
      for (const definition of profile.definitions) {
        const current = existing.find((item) => item.code === definition.code);
        await desktopApi.upsertPayrollContributionDefinition({
          ...definition,
          id: current?.id,
          liabilityAccountId: current?.liabilityAccountId ?? '',
          expenseAccountId: current?.expenseAccountId ?? '',
        });
      }
      onNotice({
        tone: 'success',
        text: 'Le profil CH-2026 a été installé explicitement. Les cotisations dépendantes du client restent à configurer.',
      });
    } catch (reason) {
      onNotice({
        tone: 'error',
        text: errorMessage(
          reason,
          'Le profil réglementaire n’a pas pu être installé.',
        ),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-layout">
      <SetupReadinessCenter
        workspace={workspace}
        settings={settings}
        onNavigate={navigateToSetting}
      />
      <CloudAccountPanel onAccountChange={onCloudAccountChange} />
      <section className="panel settings-card settings-card--wide">
        <SectionHeading
          eyebrow="Activité"
          title="Profil NOGA 2025 et terminologie"
          description="Le secteur adapte les libellés de projet, dossier ou chantier sans modifier vos données existantes."
        />
        <BusinessProfileFields
          profile={settings.business}
          onChange={(business) =>
            setSettings((current) => ({ ...current, business }))
          }
          disabled={busy}
        />
        <div className="form-actions">
          <Button
            disabled={
              busy ||
              !settings.business.nogaSection ||
              !settings.business.nogaDivision ||
              !settings.business.activityDescription.trim()
            }
            onClick={() =>
              void execute(
                () => desktopApi.saveSettings(settings),
                'Le profil d’activité et la terminologie ont été enregistrés.',
              )
            }
          >
            Enregistrer le profil d’activité
          </Button>
        </div>
      </section>
      <section
        id={SETTINGS_READINESS_TARGETS.identity}
        className="panel settings-card settings-card--wide settings-scroll-target"
        tabIndex={-1}
      >
        <SectionHeading
          eyebrow="Documents"
          title="Entreprise et facturation"
          description="Ces champs sont utilisés sur les documents officiels."
        />
        <form
          onSubmit={submitForm(async (form) => {
            const vatRegistered = form.get('vatRegistered') === 'on';
            if (vatRegistered && !billing.vatRatesBp.length) {
              onNotice({
                tone: 'error',
                text: 'Ajoutez au moins un taux TVA explicite avant d’enregistrer.',
              });
              return;
            }
            if (vatRegistered && !String(form.get('vatNumber')).trim()) {
              onNotice({
                tone: 'error',
                text: 'Renseignez le numéro TVA avant d’enregistrer une entreprise assujettie.',
              });
              return;
            }
            const country = String(form.get('country')).trim().toUpperCase();
            const next = confirmDeferredSetup({
              ...settings,
              organization: {
                ...org,
                legalName: String(form.get('legalName')),
                legalForm: String(form.get('legalForm')),
                contactName: String(form.get('contactName')),
                email: String(form.get('email')),
                phone: String(form.get('phone')),
                uidNumber: String(form.get('uidNumber')),
                vatNumber: String(form.get('vatNumber')),
                vatRegistered,
                address: {
                  ...org.address,
                  street: String(form.get('street')),
                  buildingNumber: String(form.get('buildingNumber')),
                  postalCode: String(form.get('postalCode')),
                  city: String(form.get('city')),
                  canton: String(form.get('canton')),
                  country,
                },
              },
              billing: {
                ...billing,
                iban: String(form.get('iban')),
                accountHolder: String(form.get('accountHolder')),
                quotePrefix: String(form.get('quotePrefix')),
                invoicePrefix: String(form.get('invoicePrefix')),
                creditNotePrefix: String(form.get('creditNotePrefix')),
                paymentTermsDays: numberFromInput(form.get('paymentTermsDays')),
                quoteValidityDays: numberFromInput(
                  form.get('quoteValidityDays'),
                ),
                defaultFooter: String(form.get('defaultFooter')),
              },
            }, 'billing');
            await execute(
              () => desktopApi.saveSettings(next),
              'Les paramètres ont été enregistrés localement.',
            );
          })}
        >
          <div className="company-logo-setting">
            <div className="company-logo-setting__preview">
              {org.logoPath ? (
                <img
                  src={convertFileSrc(org.logoPath)}
                  alt={`Logo de ${org.legalName}`}
                />
              ) : (
                <Building2 size={30} />
              )}
            </div>
            <div className="company-logo-setting__copy">
              <strong>Logo de l’entreprise</strong>
              <p>
                PNG, JPEG ou WebP · 16 à 4096 px par côté · 8 Mo maximum.
                Zentra contrôle le contenu puis en conserve une copie locale
                immuable, incluse dans vos sauvegardes.
              </p>
              <div className="settings-inline-actions">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void chooseLogo()}
                >
                  <FolderOpen size={16} />{' '}
                  {org.logoPath ? 'Remplacer le logo' : 'Choisir le logo'}
                </Button>
                {org.logoPath ? (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void removeLogo()}
                  >
                    <X size={16} /> Retirer
                  </Button>
                ) : null}
              </div>
              {org.logoPath ? (
                <span className="path-note">
                  <ShieldCheck size={14} /> Copie locale ·{' '}
                  {org.logoPath.split(/[\\/]/).at(-1)}
                </span>
              ) : (
                <span className="path-note">Aucun logo configuré.</span>
              )}
            </div>
          </div>
          <div className="form-grid">
            <Field label="Raison sociale" required wide>
              <input name="legalName" defaultValue={org.legalName} required />
            </Field>
            <Field label="Forme juridique">
              <input name="legalForm" defaultValue={org.legalForm} />
            </Field>
            <Field label="Responsable" required>
              <input
                name="contactName"
                defaultValue={org.contactName}
                required
              />
            </Field>
            <Field label="E-mail" required>
              <input
                name="email"
                type="email"
                defaultValue={org.email}
                required
              />
            </Field>
            <Field label="Téléphone">
              <input name="phone" defaultValue={org.phone} />
            </Field>
            <Field label="Rue / case postale" required wide>
              <input name="street" defaultValue={org.address.street} required />
            </Field>
            <Field label="Numéro de bâtiment">
              <input
                name="buildingNumber"
                defaultValue={org.address.buildingNumber}
              />
            </Field>
            <Field label="NPA" required>
              <input
                name="postalCode"
                defaultValue={org.address.postalCode}
                required
              />
            </Field>
            <Field label="Localité" required>
              <input name="city" defaultValue={org.address.city} required />
            </Field>
            <Field label="Canton" required>
              <input name="canton" defaultValue={org.address.canton} required />
            </Field>
            <Field label="Pays (code ISO, 2 lettres)" required>
              <input
                name="country"
                defaultValue={org.address.country}
                minLength={2}
                maxLength={2}
                required
              />
            </Field>
            <div
              id={SETTINGS_READINESS_TARGETS.billing}
              className="settings-form-subheading settings-scroll-target"
              tabIndex={-1}
            >
              <p className="eyebrow">Facturation</p>
              <h3>Banque, numérotation et TVA</h3>
              <span>
                Ces données alimentent les devis, factures, avoirs et
                QR-factures créés localement.
              </span>
            </div>
            <Field label="IDE / UID">
              <input name="uidNumber" defaultValue={org.uidNumber} />
            </Field>
            <Field label="Numéro TVA" required={org.vatRegistered}>
              <input
                name="vatNumber"
                defaultValue={org.vatNumber}
                required={org.vatRegistered}
              />
            </Field>
            <label className="check-card">
              <input
                name="vatRegistered"
                type="checkbox"
                defaultChecked={org.vatRegistered}
              />
              <span>
                <strong>Assujettie à la TVA</strong>
                <small>
                  Le numéro TVA et au moins un taux explicite sont alors
                  obligatoires.
                </small>
              </span>
            </label>
            <Field label="IBAN" required wide>
              <input name="iban" defaultValue={billing.iban} required />
            </Field>
            <Field label="Titulaire du compte" required wide>
              <input
                name="accountHolder"
                defaultValue={billing.accountHolder}
                required
              />
            </Field>
            <Field label="Préfixe devis" required>
              <input
                name="quotePrefix"
                defaultValue={billing.quotePrefix}
                required
              />
            </Field>
            <Field label="Préfixe factures" required>
              <input
                name="invoicePrefix"
                defaultValue={billing.invoicePrefix}
                required
              />
            </Field>
            <Field label="Préfixe avoirs" required>
              <input
                name="creditNotePrefix"
                defaultValue={billing.creditNotePrefix}
                required
              />
            </Field>
            <Field label="Délai de paiement (jours)" required>
              <input
                name="paymentTermsDays"
                type="number"
                min="1"
                defaultValue={billing.paymentTermsDays || ''}
                required
              />
            </Field>
            <Field label="Validité des devis (jours)" required>
              <input
                name="quoteValidityDays"
                type="number"
                min="1"
                defaultValue={billing.quoteValidityDays || ''}
                required
              />
            </Field>
            <Field label="Pied de page des documents" wide>
              <textarea
                name="defaultFooter"
                rows={3}
                defaultValue={billing.defaultFooter}
              />
            </Field>
          </div>
          <div className="form-actions">
            <Button type="submit" disabled={busy}>
              Enregistrer l’entreprise
            </Button>
          </div>
        </form>
      </section>

      <section className="panel settings-card">
        <SectionHeading
          eyebrow="QR-facture"
          title="Adresse structurée du créancier"
          description="Le numéro de bâtiment doit rester séparé de la rue."
        />
        <form
          onSubmit={submitForm(async (form) => {
            const next = {
              ...settings,
              organization: {
                ...settings.organization,
                address: {
                  ...settings.organization.address,
                  buildingNumber: String(form.get('buildingNumber')),
                },
              },
            };
            setSettings(next);
            await execute(
              () => desktopApi.saveSettings(next),
              'Le numéro de bâtiment a été enregistré pour les QR-factures.',
            );
          })}
        >
          <Field label="Numéro de bâtiment">
            <input
              name="buildingNumber"
              defaultValue={org.address.buildingNumber}
            />
          </Field>
          <div className="form-actions">
            <Button type="submit" disabled={busy}>
              Enregistrer l’adresse QR
            </Button>
          </div>
        </form>
      </section>

      <section className="panel settings-card">
        <SectionHeading
          eyebrow="Fiscalité"
          title="Taux TVA"
          description="Aucun taux n’est ajouté automatiquement."
        />
        <div className="settings-rate-list">
          {billing.vatRatesBp.map((rate) => (
            <div key={rate}>
              <strong>{(rate / 100).toLocaleString('fr-CH')} %</strong>
              <Button
                variant="ghost"
                size="icon"
                onClick={() =>
                  setSettings((current) => ({
                    ...current,
                    billing: {
                      ...current.billing,
                      vatRatesBp: current.billing.vatRatesBp.filter(
                        (candidate) => candidate !== rate,
                      ),
                    },
                  }))
                }
              >
                <Archive size={15} />
              </Button>
            </div>
          ))}
        </div>
        <div className="settings-inline-actions">
          <Field label="Nouveau taux (%)">
            <input
              type="number"
              min="0.01"
              step="0.01"
              value={vatDraft}
              onChange={(event) => setVatDraft(event.target.value)}
            />
          </Field>
          <Button
            type="button"
            variant="secondary"
            disabled={!vatDraft || numberFromInput(vatDraft) <= 0}
            onClick={() => {
              const rate = Math.round(numberFromInput(vatDraft) * 100);
              if (!settings.billing.vatRatesBp.includes(rate))
                setSettings((current) => ({
                  ...current,
                  billing: {
                    ...current.billing,
                    vatRatesBp: [...current.billing.vatRatesBp, rate].sort(
                      (a, b) => a - b,
                    ),
                  },
                }));
              setVatDraft('');
            }}
          >
            <Plus size={15} /> Ajouter
          </Button>
        </div>
        <Button
          disabled={busy}
          onClick={() =>
            void execute(
              () => desktopApi.saveSettings(settings),
              'Les taux TVA ont été enregistrés.',
            )
          }
        >
          <CheckCircle2 size={16} /> Enregistrer les taux
        </Button>
      </section>

      <section
        id={SETTINGS_READINESS_TARGETS.accounting}
        className="panel settings-card settings-card--wide settings-scroll-target"
        tabIndex={-1}
      >
        <SectionHeading
          eyebrow="Comptabilité"
          title="Activation et comptes de liaison"
          description="Le centre lit l’activation et toutes les liaisons réellement enregistrées dans la base locale."
          action={
            <Button type="button" variant="secondary" onClick={onOpenAccounting}>
              <Landmark size={16} /> Ouvrir la comptabilité
            </Button>
          }
        />
        <div
          className={`settings-readiness-status ${accountingReadiness.ready ? 'is-ready' : 'is-incomplete'}`}
          role="status"
        >
          <span>
            {accountingReadiness.ready ? (
              <CheckCircle2 size={20} aria-hidden="true" />
            ) : (
              <Landmark size={20} aria-hidden="true" />
            )}
          </span>
          <div>
            <strong>
              {accountingReadiness.ready
                ? 'Comptabilité préparée'
                : 'Comptabilité à compléter'}
            </strong>
            <p>{accountingReadiness.summary}</p>
          </div>
        </div>
        <p className="settings-copy">
          Ce statut décrit uniquement la configuration technique. Il ne valide
          ni le plan comptable, ni les écritures, ni leur traitement fiscal.
        </p>
      </section>

      <section
        id={SETTINGS_READINESS_TARGETS.work}
        className="panel settings-card settings-card--wide settings-scroll-target"
        tabIndex={-1}
      >
        <SectionHeading
          eyebrow="Temps et coûts"
          title="Règles de travail"
          description="Ces valeurs restent explicites et modifiables."
        />
        <form
          onSubmit={submitForm(async (form) => {
            const categories = String(form.get('costCategories'))
              .split('\n')
              .map((value) => value.trim())
              .filter(Boolean);
            const next = confirmDeferredSetup({
              ...settings,
              work: {
                workWeekHours: numberFromInput(form.get('workWeekHours')),
                dailyHours: numberFromInput(form.get('dailyHours')),
                roundingMinutes: numberFromInput(form.get('roundingMinutes')),
                breakMinutes: numberFromInput(form.get('breakMinutes')),
                costCategories: categories,
              },
            }, 'work');
            await execute(
              () => desktopApi.saveSettings(next),
              'Les règles de temps et de coûts ont été enregistrées.',
            );
          })}
        >
          <div className="form-grid">
            <Field label="Heures par semaine" required>
              <input
                name="workWeekHours"
                type="number"
                min="0.01"
                step="0.01"
                defaultValue={settings.work.workWeekHours || ''}
                required
              />
            </Field>
            <Field label="Heures par jour" required>
              <input
                name="dailyHours"
                type="number"
                min="0.01"
                step="0.01"
                defaultValue={settings.work.dailyHours || ''}
                required
              />
            </Field>
            <Field
              label="Arrondi du pointage (minutes)"
              required
              hint="Saisissez 0 pour aucun arrondi."
            >
              <input
                name="roundingMinutes"
                type="number"
                min="0"
                step="1"
                defaultValue={settings.work.roundingMinutes}
                required
              />
            </Field>
            <Field
              label="Pause habituelle (minutes)"
              required
              hint="Chaque pointage reste modifiable."
            >
              <input
                name="breakMinutes"
                type="number"
                min="0"
                step="1"
                defaultValue={settings.work.breakMinutes}
                required
              />
            </Field>
            <Field
              label="Catégories de coûts"
              wide
              hint="Une catégorie par ligne."
            >
              <textarea
                name="costCategories"
                rows={5}
                defaultValue={settings.work.costCategories.join('\n')}
              />
            </Field>
          </div>
          <div className="form-actions">
            <Button disabled={busy} type="submit">
              Enregistrer les règles
            </Button>
          </div>
        </form>
      </section>

      <section className="panel settings-card settings-card--wide">
        <SectionHeading
          eyebrow="Référentiel officiel"
          title="Profil réglementaire CH-2026"
          description="Taux nationaux par part employé et employeur, fournis par le moteur local."
        />
        <div className="regulatory-profile">
          <div>
            <strong>AVS 4,35 % · AI 0,7 % · APG 0,25 % · AC 1,1 %</strong>
            <p>
              L’AC est plafonnée à CHF 148’200 par an. Le profil n’est jamais
              installé sans cette action explicite.
            </p>
            <small>
              Source : tableau synoptique officiel AVS/AI, édition 2026.
            </small>
          </div>
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => void applySwissPayrollProfile2026()}
          >
            Installer le profil officiel
          </Button>
          <a
            href="https://www.ahv-iv.ch/Portals/0/adam/AHV-IV/Ypzfdm2t_km4jeHFYxWRdA/Document/Tableau%20synoptique%2020-1.pdf"
            target="_blank"
            rel="noreferrer"
          >
            Consulter la source officielle
          </a>
        </div>
        <div className="warning-card">
          <ShieldCheck size={18} />
          <div>
            <strong>Configuration individuelle obligatoire</strong>
            <p>
              LPP, AAP, AANP, IJM, allocations familiales et impôt à la source
              dépendent du client et du collaborateur : ajoutez-les
              explicitement.
            </p>
          </div>
        </div>
      </section>

      <SwissPayrollRulesPanel settings={settings} />

      <PayrollContributionsPanel />

      <section
        id={SETTINGS_READINESS_TARGETS.payroll}
        className="panel settings-card settings-card--wide settings-scroll-target"
        tabIndex={-1}
      >
        <SectionHeading
          eyebrow="Paie"
          title="Organismes et validation"
          description="Les cotisations de calcul se configurent dans le moteur de paie ci-dessus; cette section conserve les organismes et la validation fiduciaire."
        />
        <form
          onSubmit={submitForm(async (form) => {
            const aanpEmployerCoverage = {
              enabled: form.get('aanpEmployerCoverageEnabled') === 'on',
              reference: String(form.get('aanpEmployerCoverageReference')).trim(),
              effectiveFrom: String(form.get('aanpEmployerCoverageEffectiveFrom')).trim(),
              effectiveTo: String(form.get('aanpEmployerCoverageEffectiveTo')).trim(),
            };
            if (
              aanpEmployerCoverage.enabled &&
              (!aanpEmployerCoverage.reference ||
                !/^\d{4}-\d{2}-\d{2}$/.test(aanpEmployerCoverage.effectiveFrom))
            ) {
              throw new Error(
                'La prise en charge AANP employeur exige une référence écrite et une date de début.',
              );
            }
            if (
              aanpEmployerCoverage.enabled &&
              aanpEmployerCoverage.effectiveTo &&
              (aanpEmployerCoverage.effectiveTo < aanpEmployerCoverage.effectiveFrom ||
                !/^\d{4}-\d{2}-\d{2}$/.test(aanpEmployerCoverage.effectiveTo))
            ) {
              throw new Error(
                'La fin de prise en charge AANP doit être une date valide postérieure ou égale au début.',
              );
            }
            const laaSmallSalaryAssessmentYearText = String(
              form.get('laaSmallSalaryAssessmentYear') ?? '',
            ).trim();
            const laaSmallSalaryException = {
              enabled: laaSmallSalaryExceptionEnabled,
              assessmentYear: laaSmallSalaryAssessmentYearText
                ? numberFromInput(form.get('laaSmallSalaryAssessmentYear'))
                : null,
              evidenceReference: String(
                form.get('laaSmallSalaryEvidenceReference') ?? '',
              ).trim(),
              confirmedAllEmployeesOnlyMinorSalaries:
                form.get('laaSmallSalaryAllEmployeesConfirmed') === 'on',
            };
            if (
              laaSmallSalaryException.enabled &&
              (!/^\d{4}$/.test(laaSmallSalaryAssessmentYearText) ||
                !Number.isInteger(laaSmallSalaryException.assessmentYear) ||
                (laaSmallSalaryException.assessmentYear ?? 0) < 2000 ||
                (laaSmallSalaryException.assessmentYear ?? 0) > 9999 ||
                !laaSmallSalaryException.evidenceReference ||
                laaSmallSalaryException.evidenceReference.length > 500 ||
                !laaSmallSalaryException.confirmedAllEmployeesOnlyMinorSalaries)
            )
              throw new Error(
                'L’exception LAA exige une année, une preuve et la confirmation explicite que tous les salariés concernés pendant l’année restent dans le régime des petits salaires.',
              );
            const lppPlanEvidence = lppPlanEnabled
              ? {
                  contractNumber: String(
                    form.get('lppPlanContractNumber'),
                  ).trim(),
                  regulationReference: String(
                    form.get('lppPlanRegulationReference'),
                  ).trim(),
                  effectiveFrom: String(
                    form.get('lppPlanEffectiveFrom'),
                  ).trim(),
                  effectiveTo: String(
                    form.get('lppPlanEffectiveTo'),
                  ).trim(),
                  employerAggregateShareConfirmed:
                    form.get('lppPlanEmployerShareConfirmed') === 'on',
                }
              : undefined;
            if (
              lppPlanEvidence &&
              (!lppPlanEvidence.contractNumber ||
                !lppPlanEvidence.regulationReference ||
                !/^\d{4}-\d{2}-\d{2}$/.test(
                  lppPlanEvidence.effectiveFrom,
                ) ||
                !/^\d{4}-\d{2}-\d{2}$/.test(
                  lppPlanEvidence.effectiveTo,
                ) ||
                !lppPlanEvidence.employerAggregateShareConfirmed)
            )
              throw new Error(
                'Le plan LPP exige le numéro de contrat, la référence du règlement, sa date de début et l’attestation de la part employeur agrégée.',
              );
            if (
              lppPlanEvidence &&
              lppPlanEvidence.effectiveTo < lppPlanEvidence.effectiveFrom
            )
              throw new Error(
                'La fin du règlement LPP doit être une date valide postérieure ou égale au début.',
              );
            const next = {
              ...settings,
              payroll: {
                ...settings.payroll,
                enabled: form.get('enabled') === 'on',
                fiduciaryValidated: form.get('fiduciaryValidated') === 'on',
                avsFund: String(form.get('avsFund')),
                accidentInsurer: String(form.get('accidentInsurer')),
                pensionFund: String(form.get('pensionFund')),
                dailyAllowanceInsurer: String(
                  form.get('dailyAllowanceInsurer'),
                ),
                familyAllowanceFund: String(form.get('familyAllowanceFund')),
                payrollCanton: String(form.get('payrollCanton')),
                aanpEmployerCoverage,
                lppPlanEvidence,
                laaSmallSalaryException,
              },
            };
            setSettings(next);
            await execute(
              () => desktopApi.saveSettings(next),
              'La configuration de paie a été enregistrée.',
            );
          })}
        >
          <div className="form-grid">
            <label className="module-toggle module-toggle--compact">
              <input
                name="enabled"
                type="checkbox"
                defaultChecked={settings.payroll.enabled}
              />
              <span>
                <Users size={19} />
                <strong>Module salaires</strong>
                <small>Activer la création des fiches</small>
              </span>
            </label>
            <label className="check-card">
              <input
                name="fiduciaryValidated"
                type="checkbox"
                defaultChecked={settings.payroll.fiduciaryValidated}
              />
              <span>
                <strong>Configuration contrôlée par une fiduciaire</strong>
                <small>
                  À confirmer seulement après validation professionnelle.
                </small>
              </span>
            </label>
            <Field label="Caisse AVS">
              <input name="avsFund" defaultValue={settings.payroll.avsFund} />
            </Field>
            <Field label="Assureur accidents">
              <input
                name="accidentInsurer"
                defaultValue={settings.payroll.accidentInsurer}
              />
            </Field>
            <label className="check-card">
              <input
                name="aanpEmployerCoverageEnabled"
                type="checkbox"
                defaultChecked={settings.payroll.aanpEmployerCoverage?.enabled}
              />
              <span>
                <strong>Prime AANP prise en charge par l’employeur</strong>
                <small>Uniquement avec une convention plus favorable écrite.</small>
              </span>
            </label>
            <Field
              label="Référence de la convention AANP"
              hint="Le même texte devra être utilisé comme source de la définition AANP employeur."
              wide
            >
              <input
                name="aanpEmployerCoverageReference"
                maxLength={500}
                defaultValue={settings.payroll.aanpEmployerCoverage?.reference ?? ''}
              />
            </Field>
            <Field label="Début de prise en charge AANP">
              <input
                name="aanpEmployerCoverageEffectiveFrom"
                type="date"
                defaultValue={settings.payroll.aanpEmployerCoverage?.effectiveFrom ?? ''}
              />
            </Field>
            <Field label="Fin de prise en charge AANP" hint="Facultatif.">
              <input
                name="aanpEmployerCoverageEffectiveTo"
                type="date"
                defaultValue={settings.payroll.aanpEmployerCoverage?.effectiveTo ?? ''}
              />
            </Field>
            <label className="check-card field--wide">
              <input
                name="laaSmallSalaryExceptionEnabled"
                type="checkbox"
                checked={laaSmallSalaryExceptionEnabled}
                onChange={(event) =>
                  setLaaSmallSalaryExceptionEnabled(event.target.checked)
                }
              />
              <span>
                <strong>Demander l’exception LAA annuelle des petits salaires</strong>
                <small>
                  Non cochée par défaut. Le moteur vérifie tous les salariés
                  concernés pendant l’année et bloque l’exception dès qu’un
                  dossier, un secteur ou un cumul ne la permet pas.
                </small>
              </span>
            </label>
            {laaSmallSalaryExceptionEnabled ? (
              <section className="settings-evidence-section field--wide">
                <div className="form-grid">
                  <Field label="Année de l’exception LAA" required>
                    <input
                      name="laaSmallSalaryAssessmentYear"
                      type="number"
                      min="2000"
                      max="9999"
                      step="1"
                      defaultValue={
                        storedLaaSmallSalaryException?.assessmentYear ?? ''
                      }
                      required
                    />
                  </Field>
                  <Field
                    label="Référence de la preuve LAA"
                    hint="Ex. contrôle annuel signé, décision de l’assureur ou dossier de la fiduciaire."
                    required
                  >
                    <input
                      name="laaSmallSalaryEvidenceReference"
                      maxLength={500}
                      defaultValue={
                        storedLaaSmallSalaryException?.evidenceReference ?? ''
                      }
                      required
                    />
                  </Field>
                  <label className="check-card field--wide">
                    <input
                      name="laaSmallSalaryAllEmployeesConfirmed"
                      type="checkbox"
                      defaultChecked={
                        storedLaaSmallSalaryException
                          ?.confirmedAllEmployeesOnlyMinorSalaries ?? false
                      }
                      required
                    />
                    <span>
                      <strong>
                        Tous les salariés concernés pendant l’année ont été
                        contrôlés
                      </strong>
                      <small>
                        Je confirme avoir vérifié aussi les personnes sorties
                        de l’entreprise pendant l’année. Cette déclaration ne
                        remplace pas le contrôle automatique et peut être
                        refusée par le moteur.
                      </small>
                    </span>
                  </label>
                </div>
              </section>
            ) : null}
            <Field label="Caisse de pension">
              <input
                name="pensionFund"
                defaultValue={settings.payroll.pensionFund}
              />
            </Field>
            <label className="check-card field--wide">
              <input
                name="lppPlanEnabled"
                type="checkbox"
                checked={lppPlanEnabled}
                onChange={(event) =>
                  setLppPlanEnabled(event.target.checked)
                }
              />
              <span>
                <strong>Configurer le règlement LPP de l’entreprise</strong>
                <small>
                  Activez seulement avec le contrat et le règlement réels de
                  la caisse. Aucun taux n’est inventé.
                </small>
              </span>
            </label>
            {lppPlanEnabled ? (
              <>
                <Field label="Numéro du contrat LPP" required>
                  <input
                    name="lppPlanContractNumber"
                    maxLength={200}
                    defaultValue={storedLppPlan?.contractNumber ?? ''}
                    required
                  />
                </Field>
                <Field
                  label="Référence exacte du règlement LPP"
                  hint="Recopiez cette référence comme source de chaque définition LPP."
                  required
                  wide
                >
                  <input
                    name="lppPlanRegulationReference"
                    maxLength={500}
                    defaultValue={storedLppPlan?.regulationReference ?? ''}
                    required
                  />
                </Field>
                <Field label="Début d’effet du règlement LPP" required>
                  <input
                    name="lppPlanEffectiveFrom"
                    type="date"
                    defaultValue={storedLppPlan?.effectiveFrom ?? ''}
                    required
                  />
                </Field>
                <Field label="Fin d’effet du règlement LPP" required>
                  <input
                    name="lppPlanEffectiveTo"
                    type="date"
                    defaultValue={storedLppPlan?.effectiveTo ?? ''}
                    required
                  />
                </Field>
                <label className="check-card field--wide">
                  <input
                    name="lppPlanEmployerShareConfirmed"
                    type="checkbox"
                    defaultChecked={
                      storedLppPlan?.employerAggregateShareConfirmed ?? false
                    }
                    required
                  />
                  <span>
                    <strong>
                      Part employeur agrégée contrôlée dans le règlement
                    </strong>
                    <small>
                      Je confirme que le total des contributions employeur est
                      au moins égal au total des contributions des salariés,
                      selon le règlement réel du plan.
                    </small>
                  </span>
                </label>
              </>
            ) : null}
            <Field label="Assureur indemnités journalières">
              <input
                name="dailyAllowanceInsurer"
                defaultValue={settings.payroll.dailyAllowanceInsurer}
              />
            </Field>
            <Field label="Caisse d’allocations familiales">
              <input
                name="familyAllowanceFund"
                defaultValue={settings.payroll.familyAllowanceFund}
              />
            </Field>
            <Field label="Canton de paie">
              <input
                name="payrollCanton"
                defaultValue={settings.payroll.payrollCanton}
              />
            </Field>
          </div>
          <div className="form-actions">
            <Button disabled={busy} type="submit">
              Enregistrer la paie
            </Button>
          </div>
        </form>
      </section>

      <AppUpdater />
      <section
        id={SETTINGS_READINESS_TARGETS.backup}
        className="panel settings-card settings-scroll-target"
        tabIndex={-1}
      >
        <SectionHeading
          eyebrow="Protection"
          title="Sauvegardes manuelles"
          description="Les nouvelles sauvegardes utilisent .zentra; les archives .elyko et .hchantier restent importables."
        />
        <div className="security-status">
          <span>
            <Database size={19} />
          </span>
          <div>
            <strong>Base locale</strong>
            <p>Les données actives restent sur cet ordinateur.</p>
          </div>
          <i />
        </div>
        <label className="check-card settings-backup-confirmation">
          <input
            type="checkbox"
            checked={settings.backup.recoveryConfirmed}
            disabled={busy}
            onChange={(event) =>
              setSettings((current) => ({
                ...current,
                backup: {
                  ...current.backup,
                  recoveryConfirmed: event.target.checked,
                },
              }))
            }
          />
          <span>
            <strong>Stratégie de récupération confirmée</strong>
            <small>
              Je conserverai au moins une sauvegarde récente dans un
              emplacement distinct et sûr.
            </small>
          </span>
        </label>
        <div className="settings-actions">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void chooseBackupFolder()}
          >
            <FolderOpen size={16} /> Choisir le dossier
          </Button>
          <Button disabled={busy} onClick={() => void backup()}>
            <Download size={16} /> Créer une sauvegarde
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void restore()}
          >
            <RefreshCw size={16} /> Restaurer
          </Button>
          <Button
            variant="ghost"
            disabled={busy || !settings.backup.folder}
            onClick={() => {
              const next = confirmDeferredSetup(settings, 'backup');
              void execute(
                () => desktopApi.saveSettings(next),
                'La stratégie de sauvegarde a été enregistrée.',
              );
            }}
          >
            <CheckCircle2 size={16} /> Enregistrer la stratégie
          </Button>
        </div>
        {settings.backup.folder ? (
          <p className="path-note">
            <FolderOpen size={14} /> {settings.backup.folder}
          </p>
        ) : (
          <p className="path-note">Aucun dossier préféré configuré.</p>
        )}
      </section>
      <section className="panel settings-card">
        <SectionHeading
          eyebrow="Portabilité"
          title="Vos données vous appartiennent"
        />
        <p className="settings-copy">
          Le JSON conserve la structure complète. L’archive CSV regroupe les
          listes métier dans des fichiers lisibles par un tableur, sans copier
          les PDF, images, jetons ou documents de paie en cours d’analyse. Ces
          exports restent en clair&nbsp;: conservez-les dans un emplacement
          protégé.
        </p>
        <div className="settings-actions">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void exportPortableData('json')}
          >
            <FileText size={16} /> Exporter en JSON
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void exportPortableData('csv')}
          >
            <FileText size={16} /> Exporter les listes CSV
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => void desktopApi.openDataFolder()}
          >
            <FolderOpen size={16} /> Ouvrir le dossier local
          </Button>
        </div>
      </section>
    </div>
  );
}

function InvoiceCorrectionModal({
  invoice,
  busy,
  close,
  replace,
  act,
}: {
  invoice: Invoice;
  busy: boolean;
  close: () => void;
  replace: Dispatch<SetStateAction<ModalState>>;
  act: (
    action: () => Promise<Workspace>,
    message: string,
    close?: boolean,
  ) => Promise<boolean>;
}) {
  const [localError, setLocalError] = useState('');
  return (
    <Modal
      title={`Modifier ${invoice.number || 'la facture'}`}
      description="Même payée, la facture peut être modifiée. Zentra conserve l’original et prépare automatiquement la trace de correction."
      onClose={close}
    >
      <form
        onSubmit={submitForm(async (form) => {
          const reason = String(form.get('reason') ?? '').trim();
          if (reason.length < 5) {
            setLocalError('Décrivez le motif en au moins 5 caractères.');
            return;
          }
          setLocalError('');
          let nextWorkspace: Workspace | null = null;
          let replacementInvoiceId = '';
          const created = await act(
            async () => {
              const result = await desktopApi.createInvoiceCorrection(
                invoice.id,
                reason,
              );
              nextWorkspace = result.workspace;
              replacementInvoiceId = result.replacementInvoiceId;
              return result.workspace;
            },
            'La version modifiable est prête. Corrigez-la, puis émettez d’abord l’avoir et ensuite la nouvelle facture.',
            false,
          );
          if (!created || !nextWorkspace || !replacementInvoiceId) return;
          const replacement = (nextWorkspace as Workspace).invoices.find(
            (candidate) => candidate.id === replacementInvoiceId,
          );
          if (!replacement) {
            setLocalError(
              'Les brouillons ont été créés, mais la facture de remplacement doit être rouverte depuis la liste.',
            );
            return;
          }
          replace({
            type: 'document',
            entity: 'invoices',
            item: replacement,
          });
        })}
      >
        <div className="correction-flow">
          <div className="correction-flow__step">
            <span>1</span>
            <div>
              <strong>Original conservé</strong>
              <p>
                {invoice.number} et son paiement ne sont ni effacés ni réécrits.
              </p>
            </div>
          </div>
          <div className="correction-flow__step">
            <span>2</span>
            <div>
              <strong>Avoir intégral préparé</strong>
              <p>Il annule les montants avec sa propre numérotation et sa propre écriture.</p>
            </div>
          </div>
          <div className="correction-flow__step">
            <span>3</span>
            <div>
              <strong>Nouvelle facture modifiable</strong>
              <p>Zentra l’ouvre ensuite pour corriger les lignes, dates ou informations.</p>
            </div>
          </div>
        </div>
        <Field label="Motif durable de la correction" required wide>
          <textarea
            name="reason"
            minLength={5}
            maxLength={1_000}
            rows={4}
            placeholder="Ex. quantité facturée incorrecte et description à préciser"
            required
          />
        </Field>
        <div className="warning-card">
          <ShieldCheck size={18} />
          <div>
            <strong>Ordre contrôlé</strong>
            <p>
              La facture de remplacement ne pourra être émise qu’après l’avoir
              intégral. Pour une facture déjà payée, contrôlez ensuite la
              compensation ou le remboursement avec votre fiduciaire.
            </p>
          </div>
        </div>
        {localError ? <p className="form-error" role="alert">{localError}</p> : null}
        <FormActions
          onCancel={close}
          busy={busy}
          submitLabel="Créer la version modifiable"
        />
      </form>
    </Modal>
  );
}

function WorkspaceModal({
  state,
  workspace,
  busy,
  close,
  replace,
  act,
  onOpenInvoices,
  onOpenAccounting,
  onQrReady,
}: {
  state: Exclude<ModalState, null>;
  workspace: Workspace;
  busy: boolean;
  close: () => void;
  replace: Dispatch<SetStateAction<ModalState>>;
  act: (
    action: () => Promise<Workspace>,
    message: string,
    close?: boolean,
  ) => Promise<boolean>;
  onOpenInvoices: () => void;
  onOpenAccounting: () => void;
  onQrReady: (invoice: Invoice, qr: StoredSwissQrBill) => void;
}) {
  if (state.type === 'client')
    return <ClientForm item={state.item} busy={busy} close={close} act={act} />;
  if (state.type === 'clientDetail')
    return (
      <ClientDetail
        client={state.client}
        workspace={workspace}
        close={close}
        onEdit={() => replace({ type: 'client', item: state.client })}
      />
    );
  if (state.type === 'catalogItem')
    return (
      <CatalogItemForm
        item={state.item}
        settings={workspace.settings!}
        busy={busy}
        close={close}
        act={act}
      />
    );
  if (state.type === 'stockMovement')
    return (
      <StockMovementForm
        item={state.item}
        movementType={state.movementType}
        requestId={state.requestId}
        reservedMilli={state.reservedMilli}
        busy={busy}
        close={close}
        act={act}
      />
    );
  if (state.type === 'supplier')
    return (
      <SupplierForm item={state.item} busy={busy} close={close} act={act} />
    );
  if (state.type === 'project')
    return (
      <ProjectForm
        item={state.item}
        workspace={workspace}
        busy={busy}
        close={close}
        act={act}
      />
    );
  if (state.type === 'document')
    return (
      <DocumentEditor
        entity={state.entity}
        item={state.item}
        quoteSource={state.quoteSource}
        workspace={workspace}
        busy={busy}
        readOnlyReason={
          state.entity === 'invoices' &&
          state.item?.status === 'draft' &&
          workspace.salesOrderInvoiceBatches.some(
            (batch) => batch.invoiceId === state.item?.id,
          )
            ? 'Cette facture brouillon est générée depuis une commande client. Consultez-la ici; utilisez la fiche commande pour l’émettre ou supprimer le brouillon avec un motif.'
            : undefined
        }
        close={close}
        act={act}
      />
    );
  if (state.type === 'invoiceCorrection')
    return (
      <InvoiceCorrectionModal
        invoice={state.invoice}
        busy={busy}
        close={close}
        replace={replace}
        act={act}
      />
    );
  if (state.type === 'time')
    return (
      <TimeForm
        item={state.item}
        workspace={workspace}
        busy={busy}
        close={close}
        act={act}
      />
    );
  if (state.type === 'timeBilling')
    return (
      <TimeBillingWizard
        workspace={workspace}
        busy={busy}
        close={close}
        act={act}
        onCreated={onOpenInvoices}
      />
    );
  if (state.type === 'employee')
    return (
      <EmployeeForm item={state.item} busy={busy} close={close} act={act} />
    );
  if (state.type === 'expense')
    return (
      <ExpenseForm
        item={state.item}
        workspace={workspace}
        busy={busy}
        close={close}
        act={act}
        onOpenAccounting={onOpenAccounting}
      />
    );
  if (state.type === 'legacyExpenseDetail')
    return (
      <LegacyExpenseDetail
        expense={state.expense}
        workspace={workspace}
        close={close}
      />
    );
  if (state.type === 'supplierInvoice')
    return (
      <SupplierInvoiceForm
        item={state.item}
        workspace={workspace}
        busy={busy}
        close={close}
        act={act}
      />
    );
  if (state.type === 'supplierInvoiceDetail')
    return (
      <SupplierInvoiceDetail
        invoice={state.invoice}
        workspace={workspace}
        busy={busy}
        close={close}
        onPayment={() =>
          replace({ type: 'supplierPayment', invoice: state.invoice })
        }
      />
    );
  if (state.type === 'supplierPayment')
    return (
      <SupplierPaymentForm
        invoice={state.invoice}
        busy={busy}
        close={close}
        act={act}
      />
    );
  if (state.type === 'payslip')
    return (
      <DetailedPayslipForm
        item={state.item}
        workspace={workspace}
        busy={busy}
        close={close}
        act={act}
      />
    );
  if (state.type === 'payrollImport')
    return (
      <Suspense
        fallback={(
          <div className="settings-cloud-status" role="status">
            <LoaderCircle className="spin" size={20} />
            <span>Ouverture de l’import de fiches de salaire…</span>
          </div>
        )}
      >
        <PayrollImportWizard workspace={workspace} close={close} act={act} />
      </Suspense>
    );
  if (state.type === 'payslipPayment')
    return (
      <PayslipPaymentForm
        payslip={state.payslip}
        workspace={workspace}
        busy={busy}
        close={close}
        act={act}
      />
    );
  if (state.type === 'payment')
    return (
      <PaymentForm
        invoice={state.invoice}
        workspace={workspace}
        busy={busy}
        close={close}
        act={act}
        onOpenAccounting={onOpenAccounting}
      />
    );
  if (state.type === 'qrPrint')
    return (
      <QrPrintForm
        invoice={state.invoice}
        workspace={workspace}
        close={close}
        onReady={onQrReady}
      />
    );
  return (
    <TimerForm workspace={workspace} busy={busy} close={close} act={act} />
  );
}

function ClientForm({
  item,
  busy,
  close,
  act,
}: {
  item?: Client;
  busy: boolean;
  close: () => void;
  act: ActionRunner;
}) {
  return (
    <Modal
      title={item ? 'Modifier le client' : 'Nouveau client'}
      description="Saisissez uniquement les coordonnées réelles à utiliser sur les documents."
      onClose={close}
    >
      <form
        onSubmit={submitForm(async (form) => {
          const contactPerson = String(form.get('contactPerson'));
          const company = String(form.get('company'));
          const data = {
            name: company || contactPerson,
            contactPerson,
            company,
            email: String(form.get('email')),
            phone: String(form.get('phone')),
            addressLine1: String(form.get('street')),
            addressLine2: String(form.get('buildingNumber')),
            postalCode: String(form.get('postalCode')),
            city: String(form.get('city')),
            canton: String(form.get('canton')),
            country: String(form.get('country')).trim().toUpperCase(),
            notes: String(form.get('notes')),
          };
          await act(
            () =>
              item
                ? desktopApi.updateEntity('clients', item.id, data)
                : desktopApi.createEntity('clients', data),
            item ? 'Le client a été mis à jour.' : 'Le client a été ajouté.',
          );
        })}
      >
        <div className="form-grid">
          <Field label="Nom du contact" required>
            <input
              name="contactPerson"
              defaultValue={item?.name}
              required
              autoFocus
            />
          </Field>
          <Field label="Entreprise">
            <input name="company" defaultValue={item?.company} />
          </Field>
          <Field label="E-mail">
            <input name="email" type="email" defaultValue={item?.email} />
          </Field>
          <Field label="Téléphone">
            <input name="phone" defaultValue={item?.phone} />
          </Field>
          <Field label="Rue / case postale" required wide>
            <input name="street" defaultValue={item?.addressLine1} required />
          </Field>
          <Field label="Numéro de bâtiment">
            <input name="buildingNumber" defaultValue={item?.buildingNumber} />
          </Field>
          <Field label="NPA" required>
            <input name="postalCode" defaultValue={item?.postalCode} required />
          </Field>
          <Field label="Localité" required>
            <input name="city" defaultValue={item?.city} required />
          </Field>
          <Field label="Canton">
            <input name="canton" defaultValue={item?.canton} />
          </Field>
          <Field label="Pays (code ISO, 2 lettres)" required>
            <input
              name="country"
              defaultValue={item?.country}
              minLength={2}
              maxLength={2}
              required
            />
          </Field>
          <Field label="Notes internes" wide>
            <textarea name="notes" rows={3} defaultValue={item?.notes} />
          </Field>
        </div>
        <FormActions onCancel={close} busy={busy} />
      </form>
    </Modal>
  );
}

type ActionRunner = (
  action: () => Promise<Workspace>,
  message: string,
  close?: boolean,
) => Promise<boolean>;

function ProjectForm({
  item,
  workspace,
  busy,
  close,
  act,
}: {
  item?: Project;
  workspace: Workspace;
  busy: boolean;
  close: () => void;
  act: ActionRunner;
}) {
  const terminology = projectTerminology(
    workspace.settings!.business.nogaSection,
  );
  return (
    <Modal
      title={
        item
          ? `Modifier le ${terminology.singular}`
          : `Nouveau ${terminology.singular}`
      }
      description="Les dates prévues et réelles restent distinctes pour un suivi honnête."
      onClose={close}
      wide
    >
      <form
        onSubmit={submitForm(async (form) => {
          const data = {
            clientId: String(form.get('clientId')),
            code: '',
            name: String(form.get('name')),
            addressLine1: String(form.get('address')),
            addressLine2: '',
            postalCode: '',
            city: '',
            canton: '',
            status: String(form.get('status')),
            plannedStartDate: String(form.get('plannedStart')),
            plannedEndDate: String(form.get('plannedEnd')),
            actualStartDate: String(form.get('actualStart')),
            actualEndDate: String(form.get('actualEnd')),
            budgetCents: centsFromInput(form.get('budget')),
            plannedMinutes: Math.round(
              numberFromInput(form.get('plannedHours')) * 60,
            ),
            description: '',
            notes: String(form.get('notes')),
          };
          await act(
            () =>
              item
                ? desktopApi.updateEntity('projects', item.id, data)
                : desktopApi.createEntity('projects', data),
            item
              ? `Le ${terminology.singular} a été mis à jour.`
              : `Le ${terminology.singular} a été créé.`,
          );
        })}
      >
        <div className="form-grid">
          <Field label={`Nom du ${terminology.singular}`} required wide>
            <input name="name" defaultValue={item?.name} required autoFocus />
          </Field>
          <Field label="Client" required>
            <select name="clientId" defaultValue={item?.clientId} required>
              <option value="">Choisir un client</option>
              {workspace.clients
                .filter(
                  (client) =>
                    !client.archivedAt || client.id === item?.clientId,
                )
                .map((client) => (
                  <option value={client.id} key={client.id}>
                    {client.company || client.name}
                    {client.archivedAt ? ' · archivé' : ''}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Statut" required>
            <select name="status" defaultValue={item?.status ?? 'planned'}>
              <option value="planned">Planifié</option>
              <option value="in_progress">En cours</option>
              <option value="paused">En pause</option>
              <option value="completed">Terminé</option>
              <option value="closed">Clôturé</option>
            </select>
          </Field>
          <Field label={`Adresse du ${terminology.singular}`} wide>
            <textarea name="address" rows={2} defaultValue={item?.address} />
          </Field>
          <Field label="Début prévu">
            <input
              name="plannedStart"
              type="date"
              defaultValue={item?.plannedStart}
            />
          </Field>
          <Field label="Fin prévue">
            <input
              name="plannedEnd"
              type="date"
              defaultValue={item?.plannedEnd}
            />
          </Field>
          <Field label="Début réel">
            <input
              name="actualStart"
              type="date"
              defaultValue={item?.actualStart}
            />
          </Field>
          <Field label="Fin réelle">
            <input
              name="actualEnd"
              type="date"
              defaultValue={item?.actualEnd}
            />
          </Field>
          <Field label="Budget accepté (CHF)">
            <input
              name="budget"
              type="number"
              min="0"
              step="0.01"
              defaultValue={item?.budgetCents ? item.budgetCents / 100 : ''}
            />
          </Field>
          <Field label="Temps prévu (heures)">
            <input
              name="plannedHours"
              type="number"
              min="0"
              step="0.01"
              defaultValue={
                item?.plannedMinutes ? item.plannedMinutes / 60 : ''
              }
            />
          </Field>
          <Field label="Notes" wide>
            <textarea name="notes" rows={3} defaultValue={item?.notes} />
          </Field>
        </div>
        <FormActions onCancel={close} busy={busy} />
      </form>
    </Modal>
  );
}

function TimeForm({
  item,
  workspace,
  busy,
  close,
  act,
}: {
  item?: TimeEntry;
  workspace: Workspace;
  busy: boolean;
  close: () => void;
  act: ActionRunner;
}) {
  const terminology = projectTerminology(
    workspace.settings!.business.nogaSection,
  );
  const [billable, setBillable] = useState<'' | 'yes' | 'no'>(
    item ? (item.billable ? 'yes' : 'no') : '',
  );
  const [projectId, setProjectId] = useState(item?.projectId ?? '');
  const [taskId, setTaskId] = useState(item?.taskId ?? '');
  const availableTasks = workspace.projectTasks.filter(
    (task) =>
      task.projectId === projectId &&
      ((!['done', 'cancelled'].includes(task.status) &&
        workspace.projects.some((project) => project.id === task.projectId)) ||
        task.id === item?.taskId),
  );
  return (
    <Modal
      title={item ? 'Modifier les heures' : 'Saisir des heures'}
      description="La durée et le coût proviennent uniquement de cette saisie et du collaborateur choisi."
      onClose={close}
    >
      <form
        onSubmit={submitForm(async (form) => {
          const data = {
            projectId: String(form.get('projectId')),
            taskId: String(form.get('taskId')) || null,
            employeeId: String(form.get('employeeId')),
            date: String(form.get('date')),
            minutes: Math.round(numberFromInput(form.get('hours')) * 60),
            breakMinutes: numberFromInput(form.get('breakMinutes')),
            billable: billable === 'yes',
            billingRateCents:
              billable === 'yes' ? centsFromInput(form.get('billingRate')) : 0,
            costRateCents: centsFromInput(form.get('costRate')),
            note: String(form.get('note')),
            status: String(form.get('status')),
          };
          await act(
            () =>
              item
                ? desktopApi.updateEntity('timeEntries', item.id, data)
                : desktopApi.createEntity('timeEntries', data),
            item
              ? 'La saisie de temps a été mise à jour.'
              : 'Les heures ont été enregistrées.',
          );
        })}
      >
        <div className="form-grid">
          <Field label={terminology.singularTitle} required wide>
            <select
              name="projectId"
              value={projectId}
              onChange={(event) => {
                setProjectId(event.target.value);
                setTaskId('');
              }}
              required
              autoFocus
            >
              <option value="">Choisir un {terminology.singular}</option>
              {workspace.projects
                .filter(
                  (project) =>
                    project.status !== 'closed' ||
                    project.id === item?.projectId,
                )
                .map((project) => (
                  <option value={project.id} key={project.id}>
                    {project.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field
            label="Tâche liée"
            hint="Facultatif : relie ces heures à une action précise du planning."
            wide
          >
            <select
              name="taskId"
              value={taskId}
              onChange={(event) => setTaskId(event.target.value)}
              disabled={!projectId}
            >
              <option value="">Sans tâche précise</option>
              {availableTasks.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Collaborateur" required>
            <select name="employeeId" defaultValue={item?.employeeId} required>
              <option value="">Choisir un collaborateur</option>
              {workspace.employees
                .filter(
                  (employee) =>
                    employee.active || employee.id === item?.employeeId,
                )
                .map((employee) => (
                  <option value={employee.id} key={employee.id}>
                    {employee.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Date" required>
            <input
              name="date"
              type="date"
              defaultValue={item?.date || todayIso()}
              required
            />
          </Field>
          <Field label="Durée travaillée (heures)" required>
            <input
              name="hours"
              type="number"
              min="0.01"
              step="0.01"
              defaultValue={item?.minutes ? item.minutes / 60 : ''}
              required
            />
          </Field>
          <Field label="Pause non travaillée (minutes)" required>
            <input
              name="breakMinutes"
              type="number"
              min="0"
              step="1"
              defaultValue={item ? item.breakMinutes : ''}
              required
            />
          </Field>
          <Field label="Temps facturable au client ?" required>
            <select
              value={billable}
              onChange={(event) =>
                setBillable(event.target.value as '' | 'yes' | 'no')
              }
              required
            >
              <option value="">Choisir</option>
              <option value="yes">Oui, facturable</option>
              <option value="no">Non, interne</option>
            </select>
          </Field>
          {billable === 'yes' ? (
            <Field label="Tarif de facturation (CHF/h)" required>
              <input
                name="billingRate"
                type="number"
                min="0"
                step="0.01"
                defaultValue={
                  item?.billingRateCents ? item.billingRateCents / 100 : ''
                }
                required
              />
            </Field>
          ) : null}
          <Field
            label="Coût horaire appliqué (CHF/h)"
            required
            hint={`Saisissez le coût confirmé pour ce ${terminology.singular}.`}
          >
            <input
              name="costRate"
              type="number"
              min="0"
              step="0.01"
              defaultValue={item ? item.hourlyCostCents / 100 : ''}
              required
            />
          </Field>
          <Field label="Statut" required>
            <select name="status" defaultValue={item?.status ?? ''} required>
              <option value="">Choisir le statut</option>
              <option value="entered">Saisi</option>
              <option value="approved">Approuvé</option>
              <option value="locked">Verrouillé</option>
            </select>
          </Field>
          <Field label="Note" wide>
            <textarea name="note" rows={3} defaultValue={item?.note} />
          </Field>
        </div>
        <FormActions onCancel={close} busy={busy} />
      </form>
    </Modal>
  );
}

function EmployeeForm({
  item,
  busy,
  close,
  act,
}: {
  item?: Employee;
  busy: boolean;
  close: () => void;
  act: ActionRunner;
}) {
  const [salaryMode, setSalaryMode] = useState<Employee['salaryMode'] | ''>(
    item?.salaryMode ?? '',
  );
  const [employmentContractKind, setEmploymentContractKind] = useState<
    'indefinite' | 'fixed' | ''
  >(item?.employmentContractKind ?? '');
  const [lppExceptionCode, setLppExceptionCode] = useState<
    '' | 'short_fixed_contract' | 'other_legal'
  >(item?.lppExceptionCode ?? '');
  const [smallSalarySector, setSmallSalarySector] = useState<
    '' | NonNullable<Employee['smallSalarySector']>
  >(item?.smallSalarySector ?? '');
  return (
    <Modal
      title={item ? 'Modifier le collaborateur' : 'Nouveau collaborateur'}
      description="Aucun salaire, taux ou coût n’est prérempli."
      onClose={close}
      wide
    >
      <form
        onSubmit={submitForm(async (form) => {
          const allowanceChoice = String(form.get('avsAllowanceWaived') ?? '');
          const contractualHours = String(
            form.get('contractualWeeklyHours') ?? '',
          ).trim();
          const acOpeningYear = String(form.get('acOpeningYear') ?? '').trim();
          const acOpeningBasis = String(
            form.get('acOpeningBasis') ?? '',
          ).trim();
          const laaOpeningYear = String(
            form.get('laaOpeningYear') ?? '',
          ).trim();
          const laaOpeningBasis = String(
            form.get('laaOpeningBasis') ?? '',
          ).trim();
          const lppAssessmentYear = String(
            form.get('lppAssessmentYear') ?? '',
          ).trim();
          const lppAnnualSalary = String(
            form.get('lppAnnualSalary') ?? '',
          ).trim();
          const lppExceptionEvidenceReference = String(
            form.get('lppExceptionEvidenceReference') ?? '',
          ).trim();
          const smallSalaryFields = parseSmallSalaryEmployeeForm({
            assessmentYear: String(
              form.get('smallSalaryAssessmentYear') ?? '',
            ),
            sector: String(form.get('smallSalarySector') ?? ''),
            employeeRequestedContributions: String(
              form.get('smallSalaryEmployeeRequestedContributions') ?? '',
            ),
            decisionDate: String(form.get('smallSalaryDecisionDate') ?? ''),
            openingGross: String(
              form.get('smallSalaryOpeningGross') ?? '',
            ),
            openingContributedBasis: String(
              form.get('smallSalaryOpeningContributedBasis') ?? '',
            ),
            evidenceReference: String(
              form.get('smallSalaryEvidenceReference') ?? '',
            ),
          });
          if (Boolean(lppAssessmentYear) !== Boolean(lppAnnualSalary))
            throw new Error(
              'L’année et le salaire annuel LPP doivent être confirmés ensemble, zéro compris.',
            );
          if (Boolean(acOpeningYear) !== Boolean(acOpeningBasis))
            throw new Error(
              'L’année et la base d’ouverture AC doivent être confirmées ensemble, zéro compris.',
            );
          if (Boolean(laaOpeningYear) !== Boolean(laaOpeningBasis))
            throw new Error(
              'L’année et la base d’ouverture LAA doivent être confirmées ensemble, zéro compris.',
            );
          if (
            employmentContractKind === 'fixed' &&
            (!String(form.get('employmentStart')) ||
              !String(form.get('employmentEnd')))
          )
            throw new Error(
              'Un contrat à durée déterminée exige ses dates de début et de fin.',
            );
          if (
            Boolean(lppExceptionCode) !==
            Boolean(lppExceptionEvidenceReference)
          )
            throw new Error(
              'Une exception LPP exige son motif et la référence de la preuve.',
            );
          const data = {
            employeeNumber: String(form.get('employeeNumber')),
            name: String(form.get('name')),
            role: String(form.get('role')),
            email: String(form.get('email')),
            phone: String(form.get('phone')),
            addressLine1: String(form.get('addressLine1')),
            addressLine2: String(form.get('addressLine2')),
            postalCode: String(form.get('postalCode')),
            city: String(form.get('city')),
            canton: String(form.get('canton')),
            country: String(form.get('country')).trim().toUpperCase(),
            birthDate: String(form.get('birthDate')),
            socialSecurityNumber: String(form.get('avsNumber')),
            iban: String(form.get('iban')),
            employmentStartDate: String(form.get('employmentStart')),
            employmentEndDate: String(form.get('employmentEnd')),
            employmentContractKind: employmentContractKind || null,
            referenceAgeDate:
              String(form.get('referenceAgeDate') ?? '') || null,
            avsAllowanceWaived: allowanceChoice
              ? allowanceChoice === 'yes'
              : null,
            ...smallSalaryFields,
            employmentRate: numberFromInput(form.get('employmentRate')),
            contractualWeeklyMinutes: contractualHours
              ? Math.round(
                  numberFromInput(form.get('contractualWeeklyHours')) * 60,
                )
              : null,
            acOpeningYear: acOpeningYear
              ? numberFromInput(form.get('acOpeningYear'))
              : null,
            acOpeningBasisCents: acOpeningBasis
              ? centsFromInput(form.get('acOpeningBasis'))
              : null,
            laaOpeningYear: laaOpeningYear
              ? numberFromInput(form.get('laaOpeningYear'))
              : null,
            laaOpeningBasisCents: laaOpeningBasis
              ? centsFromInput(form.get('laaOpeningBasis'))
              : null,
            lppAssessmentYear: lppAssessmentYear
              ? numberFromInput(form.get('lppAssessmentYear'))
              : null,
            lppAnnualSalaryCents: lppAnnualSalary
              ? centsFromInput(form.get('lppAnnualSalary'))
              : null,
            lppExceptionCode: lppExceptionCode || null,
            lppExceptionEvidenceReference:
              lppExceptionEvidenceReference || null,
            hourlyRateCents: centsFromInput(form.get('hourlyCost')),
            monthlySalaryCents:
              salaryMode === 'monthly'
                ? centsFromInput(form.get('grossSalary'))
                : 0,
            status: String(form.get('status')),
            notes: String(form.get('notes')),
          };
          await act(
            () =>
              item
                ? desktopApi.updateEntity('employees', item.id, data)
                : desktopApi.createEntity('employees', data),
            item
              ? 'Le collaborateur a été mis à jour.'
              : 'Le collaborateur a été ajouté.',
          );
        })}
      >
        <div className="form-grid">
          <Field label="Nom complet" required wide>
            <input name="name" defaultValue={item?.name} required autoFocus />
          </Field>
          <Field label="Numéro de collaborateur">
            <input name="employeeNumber" defaultValue={item?.employeeNumber} />
          </Field>
          <Field label="Fonction" required>
            <input name="role" defaultValue={item?.role} required />
          </Field>
          <Field label="Taux d’activité (%)" required>
            <input
              name="employmentRate"
              type="number"
              min="0.01"
              max="100"
              step="0.01"
              defaultValue={item?.employmentRate || ''}
              required
            />
          </Field>
          <Field
            label="Horaire AANP confirmé (h/semaine)"
            hint="Saisissez l’horaire contractuel régulier ou, pour un horaire irrégulier, une moyenne hebdomadaire représentative documentée. Laissez vide tant que cette moyenne n’est pas confirmée: la décision AANP restera bloquée."
          >
            <input
              name="contractualWeeklyHours"
              type="number"
              min="0.01"
              max="168"
              step="0.01"
              defaultValue={
                item?.contractualWeeklyMinutes
                  ? item.contractualWeeklyMinutes / 60
                  : ''
              }
            />
          </Field>
          <Field label="E-mail">
            <input name="email" type="email" defaultValue={item?.email} />
          </Field>
          <Field label="Téléphone">
            <input name="phone" defaultValue={item?.phone} />
          </Field>
          <Field label="Rue / case postale" wide>
            <input name="addressLine1" defaultValue={item?.addressLine1} />
          </Field>
          <Field label="Numéro de bâtiment">
            <input name="addressLine2" defaultValue={item?.addressLine2} />
          </Field>
          <Field label="NPA">
            <input name="postalCode" defaultValue={item?.postalCode} />
          </Field>
          <Field label="Localité">
            <input name="city" defaultValue={item?.city} />
          </Field>
          <Field label="Canton">
            <input name="canton" defaultValue={item?.canton} />
          </Field>
          <Field label="Pays (code ISO, 2 lettres)">
            <input
              name="country"
              minLength={2}
              maxLength={2}
              defaultValue={item?.country}
            />
          </Field>
          <Field label="Date de naissance">
            <input
              name="birthDate"
              type="date"
              defaultValue={item?.birthDate}
            />
          </Field>
          <Field label="Numéro AVS">
            <input name="avsNumber" defaultValue={item?.avsNumber} />
          </Field>
          <Field label="IBAN du collaborateur">
            <input name="iban" defaultValue={item?.iban} />
          </Field>
          <Field label="Début du contrat">
            <input
              name="employmentStart"
              type="date"
              defaultValue={item?.employmentStart}
            />
          </Field>
          <Field label="Fin du contrat">
            <input
              name="employmentEnd"
              type="date"
              defaultValue={item?.employmentEnd}
            />
          </Field>
          <Field
            label="Nature du contrat pour la LPP"
            hint="Confirmez la nature réelle du contrat. Zentra ne la déduit ni des dates ni du salaire."
          >
            <select
              name="employmentContractKind"
              value={employmentContractKind}
              onChange={(event) =>
                setEmploymentContractKind(
                  event.target.value as 'indefinite' | 'fixed' | '',
                )
              }
            >
              <option value="">À confirmer</option>
              <option value="indefinite">Durée indéterminée</option>
              <option value="fixed">Durée déterminée</option>
            </select>
          </Field>
          <Field
            label="Année d’évaluation LPP"
            hint="À confirmer avec le salaire annuel LPP, pour chaque année contrôlée."
          >
            <input
              name="lppAssessmentYear"
              type="number"
              min="2000"
              max="9999"
              step="1"
              defaultValue={item?.lppAssessmentYear ?? ''}
            />
          </Field>
          <Field
            label="Salaire annuel LPP confirmé (CHF)"
            hint="Montant annuel déterminant confirmé; saisissez 0 si la valeur réelle est zéro. Le brut du mois n’est jamais annualisé automatiquement."
          >
            <input
              name="lppAnnualSalary"
              type="number"
              min="0"
              step="0.01"
              defaultValue={
                item?.lppAnnualSalaryCents === null ||
                item?.lppAnnualSalaryCents === undefined
                  ? ''
                  : item.lppAnnualSalaryCents / 100
              }
            />
          </Field>
          <Field
            label="Exception LPP documentée"
            hint="Laissez vide sans exception. Toute exception doit être confirmée par une pièce réelle."
          >
            <select
              name="lppExceptionCode"
              value={lppExceptionCode}
              onChange={(event) =>
                setLppExceptionCode(
                  event.target.value as
                    | ''
                    | 'short_fixed_contract'
                    | 'other_legal',
                )
              }
            >
              <option value="">Aucune exception</option>
              <option value="short_fixed_contract">
                Contrat déterminé de trois mois au maximum
              </option>
              <option value="other_legal">
                Autre exception légale confirmée
              </option>
            </select>
          </Field>
          {lppExceptionCode ? (
            <Field
              label="Référence de la preuve d’exception LPP"
              hint="Ex. contrat signé, article du règlement ou décision écrite de la caisse."
              required
              wide
            >
              <input
                name="lppExceptionEvidenceReference"
                maxLength={500}
                defaultValue={item?.lppExceptionEvidenceReference ?? ''}
                required
              />
            </Field>
          ) : null}
          <div className="info-strip field--wide">
            <ShieldCheck size={17} />
            <span>
              Ces données servent uniquement à qualifier l’assujettissement
              LPP 2026 et le salaire coordonné indicatif. Les montants de
              cotisation doivent toujours venir du règlement réel de la caisse.
            </span>
          </div>
          <Field
            label="Année d’ouverture AC"
            hint="Année du cumul importé. À confirmer chaque année, même lorsque le montant est zéro."
          >
            <input
              name="acOpeningYear"
              type="number"
              min="2000"
              max="9999"
              step="1"
              defaultValue={item?.acOpeningYear ?? ''}
            />
          </Field>
          <Field
            label="Base AC avant Zentra (CHF)"
            hint="Base déjà acquise hors Zentra durant l’année indiquée. Saisissez 0 pour confirmer qu’il n’y en a aucune."
          >
            <input
              name="acOpeningBasis"
              type="number"
              min="0"
              step="0.01"
              defaultValue={
                item?.acOpeningBasisCents === null ||
                item?.acOpeningBasisCents === undefined
                  ? ''
                  : item.acOpeningBasisCents / 100
              }
            />
          </Field>
          <Field
            label="Année d’ouverture LAA"
            hint="Année du gain assuré accidents déjà acquis. À confirmer chaque année, même lorsque le montant est zéro."
          >
            <input
              name="laaOpeningYear"
              type="number"
              min="2000"
              max="9999"
              step="1"
              defaultValue={item?.laaOpeningYear ?? ''}
            />
          </Field>
          <Field
            label="Base LAA avant Zentra (CHF)"
            hint="Gain assuré LAA déjà acquis hors Zentra durant l’année indiquée. Saisissez 0 pour confirmer qu’il n’y en a aucun."
          >
            <input
              name="laaOpeningBasis"
              type="number"
              min="0"
              step="0.01"
              defaultValue={
                item?.laaOpeningBasisCents === null ||
                item?.laaOpeningBasisCents === undefined
                  ? ''
                  : item.laaOpeningBasisCents / 100
              }
            />
          </Field>
          <Field
            label="Date confirmée d’atteinte de l’âge de référence"
            hint="Renseignez uniquement la date confirmée par la caisse ou la fiduciaire. L’AC reste due pendant ce mois; l’exemption et la franchise AVS commencent le mois civil suivant. Zentra ne déduit jamais cette date du sexe."
          >
            <input
              name="referenceAgeDate"
              type="date"
              defaultValue={item?.referenceAgeDate}
            />
          </Field>
          <Field
            label="Franchise AVS après l’âge de référence"
            hint="CHF 16’800/an, soit CHF 1’400 par mois civil entier ou entamé dès le mois suivant, sauf renonciation confirmée."
          >
            <select
              name="avsAllowanceWaived"
              defaultValue={
                item?.avsAllowanceWaived === null ||
                item?.avsAllowanceWaived === undefined
                  ? ''
                  : item.avsAllowanceWaived
                    ? 'yes'
                    : 'no'
              }
            >
              <option value="">Choix à confirmer</option>
              <option value="no">Franchise conservée</option>
              <option value="yes">Renonciation confirmée</option>
            </select>
          </Field>
          <section className="employee-small-salary-section field--wide">
            <header>
              <ShieldCheck size={18} />
              <div>
                <strong>Décision annuelle · salaires de minime importance</strong>
                <p>
                  Documentez les faits réels une fois par année. Zentra
                  recalcule ensuite le cumul depuis la base locale; cette
                  section n’est pas une attestation de conformité.
                </p>
              </div>
            </header>
            <div className="form-grid">
              <Field
                label="Année d’évaluation"
                hint="Complétez toute la section pour l’année contrôlée, ou laissez-la entièrement vide."
              >
                <input
                  name="smallSalaryAssessmentYear"
                  type="number"
                  min="2000"
                  max="9999"
                  step="1"
                  defaultValue={item?.smallSalaryAssessmentYear ?? ''}
                />
              </Field>
              <Field
                label="Secteur déterminant"
                hint="Le ménage privé et les arts/culture suivent des règles renforcées."
              >
                <select
                  name="smallSalarySector"
                  value={smallSalarySector}
                  onChange={(event) =>
                    setSmallSalarySector(
                      event.target.value as
                        | ''
                        | NonNullable<Employee['smallSalarySector']>,
                    )
                  }
                >
                  <option value="">À confirmer</option>
                  <option value="ordinary">Secteur ordinaire</option>
                  <option value="private_household">Ménage privé</option>
                  <option value="arts_culture">Arts et culture</option>
                </select>
              </Field>
              <Field
                label="Demande du salarié"
                hint="Confirmez oui ou non. Une demande peut passer de non à oui pour l’avenir avec une nouvelle date; elle ne peut pas être retirée après coup."
              >
                <select
                  name="smallSalaryEmployeeRequestedContributions"
                  defaultValue={
                    item?.smallSalaryEmployeeRequestedContributions == null
                      ? ''
                      : item.smallSalaryEmployeeRequestedContributions
                        ? 'yes'
                        : 'no'
                  }
                >
                  <option value="">À confirmer</option>
                  <option
                    value="no"
                    disabled={
                      item?.smallSalaryEmployeeRequestedContributions === true
                    }
                  >
                    Non, aucune demande
                  </option>
                  <option value="yes">Oui, demande confirmée</option>
                </select>
              </Field>
              <Field
                label="Date de la décision/demande"
                hint="Date réelle de la décision annuelle ou, si le salarié demande ensuite les cotisations, date prospective de cette demande."
              >
                <input
                  name="smallSalaryDecisionDate"
                  type="date"
                  defaultValue={item?.smallSalaryDecisionDate ?? ''}
                />
              </Field>
              <Field
                label="Brut versé avant Zentra (CHF)"
                hint="Brut déjà payé durant cette année hors Zentra; saisissez 0 si aucun."
              >
                <input
                  name="smallSalaryOpeningGross"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={
                    item?.smallSalaryOpeningGrossCents == null
                      ? ''
                      : item.smallSalaryOpeningGrossCents / 100
                  }
                />
              </Field>
              <Field
                label="Base déjà cotisée avant Zentra (CHF)"
                hint="Part du brut d’ouverture déjà soumise; saisissez 0 si aucune."
              >
                <input
                  name="smallSalaryOpeningContributedBasis"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={
                    item?.smallSalaryOpeningContributedBasisCents == null
                      ? ''
                      : item.smallSalaryOpeningContributedBasisCents / 100
                  }
                />
              </Field>
              <Field
                label="Référence de la preuve"
                hint="Ex. déclaration du salarié datée, décompte précédent ou contrôle écrit de la caisse."
                wide
              >
                <input
                  name="smallSalaryEvidenceReference"
                  maxLength={500}
                  defaultValue={item?.smallSalaryEvidenceReference ?? ''}
                />
              </Field>
            </div>
            <div className="employee-small-salary-section__rules">
              <p>
                <strong>Secteur ordinaire.</strong> Jusqu’à CHF 2’500 par an,
                aucune cotisation sans demande; au dépassement, le rattrapage
                porte sur le salaire annuel total.
              </p>
              <p>
                <strong>Ménage privé et arts/culture.</strong> Cotisations dès
                le premier franc, sauf en ménage privé jusqu’au 31 décembre
                suivant le 25e anniversaire et jusqu’à CHF 750, sans demande du
                salarié.
              </p>
              <p>
                <strong>Décision et franchise.</strong> Une demande tardive ne
                s’applique que prospectivement à compter de sa date et ne
                rattrape pas les salaires déjà payés sous le seuil. Un
                dépassement ultérieur rend toutefois le salaire annuel total
                cotisable. Les cotisations versées ne sont pas remboursables et
                la dispense ne se cumule pas avec la franchise AVS après l’âge
                de référence.
              </p>
              <p>
                <strong>Après une fiche payée.</strong> L’année, le secteur et
                les ouvertures restent figés. Seul le passage de « non » à
                « oui » est admis, avec une date postérieure aux versements
                antérieurs; le retour de « oui » à « non » est refusé par le
                moteur.
              </p>
            </div>
          </section>
          <Field label="Type de rémunération" required>
            <select
              value={salaryMode}
              onChange={(event) =>
                setSalaryMode(event.target.value as Employee['salaryMode'] | '')
              }
              required
            >
              <option value="">Choisir le type</option>
              <option value="hourly">Salaire horaire</option>
              <option value="monthly">Salaire mensuel</option>
            </select>
          </Field>
          {salaryMode === 'monthly' ? (
            <Field label="Salaire mensuel brut (CHF)" required>
              <input
                name="grossSalary"
                type="number"
                min="0"
                step="0.01"
                defaultValue={
                  item?.grossSalaryCents ? item.grossSalaryCents / 100 : ''
                }
                required
              />
            </Field>
          ) : null}
          <Field
            label="Coût horaire chargé (CHF)"
            hint="Saisissez le coût réellement défini par l’entreprise."
            required
          >
            <input
              name="hourlyCost"
              type="number"
              min="0"
              step="0.01"
              defaultValue={item ? item.hourlyCostCents / 100 : ''}
              required
            />
          </Field>
          <Field label="Statut du collaborateur" required>
            <select
              name="status"
              defaultValue={item ? (item.active ? 'actif' : 'inactif') : ''}
              required
            >
              <option value="">Choisir le statut</option>
              <option value="actif">Actif</option>
              <option value="inactif">Inactif</option>
            </select>
          </Field>
          <Field label="Notes internes" wide>
            <textarea name="notes" rows={3} defaultValue={item?.notes} />
          </Field>
        </div>
        <FormActions onCancel={close} busy={busy} />
      </form>
    </Modal>
  );
}

function PayslipForm({
  item,
  workspace,
  busy,
  close,
  act,
}: {
  item?: Payslip;
  workspace: Workspace;
  busy: boolean;
  close: () => void;
  act: ActionRunner;
}) {
  const [lines, setLines] = useState<PayslipLine[]>(
    item?.lines.map((line) => ({ ...line })) ?? [],
  );
  const totals = payslipTotals({
    id: item?.id ?? '',
    employeeId: item?.employeeId ?? '',
    period: item?.period ?? '',
    status: item?.status ?? 'incomplete',
    lines,
    paymentDate: item?.paymentDate ?? '',
    notes: item?.notes ?? '',
    createdAt: item?.createdAt ?? '',
  });
  function addLine(kind: PayslipLine['kind']) {
    setLines((current) => [
      ...current,
      { id: createId(), label: '', kind, amountCents: 0 },
    ]);
  }
  function updateLine(id: string, patch: Partial<PayslipLine>) {
    setLines((current) =>
      current.map((line) => (line.id === id ? { ...line, ...patch } : line)),
    );
  }
  return (
    <Modal
      title={item ? 'Modifier la fiche' : 'Nouvelle fiche de salaire'}
      description="Toutes les lignes sont explicites. Le logiciel n’ajoute aucune retenue automatique."
      onClose={close}
      wide
    >
      <form
        onSubmit={submitForm(async (form) => {
          if (
            !lines.length ||
            lines.some((line) => !line.label.trim() || line.amountCents < 0)
          )
            return;
          const status: Payslip['status'] =
            workspace.settings?.payroll.fiduciaryValidated &&
            form.get('validated') === 'on'
              ? 'validated'
              : 'incomplete';
          const data = {
            employeeId: String(form.get('employeeId')),
            period: String(form.get('period')),
            status,
            grossCents: totals.earnings,
            deductionsCents: totals.deductions,
            netCents: totals.net,
            employerCostsCents: totals.employer,
            paymentDate: '',
            notes: String(form.get('notes')),
          };
          await act(
            () => desktopApi.savePayslip(data, lines, item),
            item
              ? 'La fiche a été mise à jour.'
              : 'La fiche a été créée avec les lignes saisies.',
          );
        })}
      >
        <div className="form-grid">
          <Field label="Collaborateur" required>
            <select name="employeeId" defaultValue={item?.employeeId} required>
              <option value="">Choisir un collaborateur</option>
              {workspace.employees.map((employee) => (
                <option value={employee.id} key={employee.id}>
                  {employee.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Période" required>
            <input
              name="period"
              type="month"
              defaultValue={item?.period}
              required
            />
          </Field>
        </div>
        <section className="pay-lines">
          <header>
            <div>
              <strong>Éléments de la fiche</strong>
              <small>Aucun montant n’est proposé par défaut.</small>
            </div>
            <div>
              <Button
                type="button"
                variant="secondary"
                size="small"
                onClick={() => addLine('earning')}
              >
                <Plus size={14} /> Gain
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="small"
                onClick={() => addLine('reimbursement')}
              >
                <Plus size={14} /> Remboursement
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="small"
                onClick={() => addLine('deduction')}
              >
                <Plus size={14} /> Retenue
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="small"
                onClick={() => addLine('employer')}
              >
                <Plus size={14} /> Charge employeur
              </Button>
            </div>
          </header>
          {lines.length ? (
            <div className="pay-line-list">
              {lines.map((line) => (
                <div key={line.id}>
                  <select
                    value={line.kind}
                    onChange={(event) =>
                      updateLine(line.id, {
                        kind: event.target.value as PayslipLine['kind'],
                      })
                    }
                  >
                    <option value="earning">Gain soumis au brut</option>
                    <option value="reimbursement">
                      Remboursement hors brut
                    </option>
                    <option value="deduction">Retenue</option>
                    <option value="employer">Charge employeur</option>
                  </select>
                  <input
                    value={line.label}
                    onChange={(event) =>
                      updateLine(line.id, { label: event.target.value })
                    }
                    placeholder="Libellé"
                    required
                  />
                  <label className="money-input">
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={line.amountCents ? line.amountCents / 100 : ''}
                      onChange={(event) =>
                        updateLine(line.id, {
                          amountCents: Math.round(
                            (event.target.valueAsNumber || 0) * 100,
                          ),
                        })
                      }
                      required
                    />
                    <span>CHF</span>
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() =>
                      setLines((current) =>
                        current.filter((candidate) => candidate.id !== line.id),
                      )
                    }
                  >
                    <Archive size={15} />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <div className="rate-empty">
              Ajoutez les gains, remboursements, retenues et charges confirmés
              pour cette période.
            </div>
          )}
        </section>
        <div className="document-bottom">
          <Field label="Notes">
            <textarea name="notes" rows={3} defaultValue={item?.notes} />
          </Field>
          <div className="document-totals">
            <div>
              <span>Brut saisi</span>
              <strong>{formatMoney(totals.earnings)}</strong>
            </div>
            <div>
              <span>Remboursements hors brut</span>
              <strong>{formatMoney(totals.reimbursements)}</strong>
            </div>
            <div>
              <span>Retenues saisies</span>
              <strong>{formatMoney(totals.deductions)}</strong>
            </div>
            <div>
              <span>Net calculé</span>
              <strong>{formatMoney(totals.net)}</strong>
            </div>
          </div>
        </div>
        {workspace.settings?.payroll.fiduciaryValidated ? (
          <label className="check-card">
            <input
              name="validated"
              type="checkbox"
              defaultChecked={item?.status === 'validated'}
            />
            <span>
              <strong>Valider cette fiche</strong>
              <small>
                Confirmez que les lignes de cette période ont été contrôlées.
              </small>
            </span>
          </label>
        ) : (
          <div className="warning-card">
            <ShieldCheck size={18} />
            <div>
              <strong>La fiche restera incomplète</strong>
              <p>
                La configuration de paie n’est pas marquée comme contrôlée par
                une fiduciaire.
              </p>
            </div>
          </div>
        )}
        <FormActions onCancel={close} busy={busy} />
      </form>
    </Modal>
  );
}

function PaymentForm({
  invoice,
  workspace,
  busy,
  close,
  act,
  onOpenAccounting,
}: {
  invoice: Invoice;
  workspace: Workspace;
  busy: boolean;
  close: () => void;
  act: ActionRunner;
  onOpenAccounting: () => void;
}) {
  const [requestId] = useState(() => createId());
  const [accountingState, setAccountingState] = useState<
    'loading' | 'enabled' | 'disabled' | 'error'
  >('loading');
  const total = documentTotals(invoice.lines).totalCents;
  const alreadyPaid = invoicePaid(invoice.id, workspace.payments);
  const credited = invoiceCredited(invoice.id, workspace.invoices);
  const balance = invoiceOpenBalance(
    invoice,
    workspace.invoices,
    workspace.payments,
  );

  useEffect(() => {
    let active = true;
    void desktopApi
      .getAccountingSettings()
      .then((settings) => {
        if (active)
          setAccountingState(settings.enabled ? 'enabled' : 'disabled');
      })
      .catch(() => {
        if (active) setAccountingState('error');
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <Modal
      title="Enregistrer un paiement"
      description={`${invoice.number || 'Facture'} · solde ouvert ${formatMoney(balance)}`}
      onClose={close}
    >
      <form
        onSubmit={submitForm(async (form) => {
          if (accountingState !== 'enabled') return;
          const amountCents = centsFromInput(form.get('amount'));
          if (amountCents <= 0 || amountCents > balance) return;
          await act(
            () =>
              desktopApi.addPayment(invoice.id, {
                requestId,
                amountCents,
                date: String(form.get('date')),
                method: String(form.get('method')),
                reference: String(form.get('reference')),
                notes: String(form.get('notes')),
              }),
            'Le paiement, le nouveau solde et l’écriture banque contre débiteurs ont été enregistrés ensemble.',
          );
        })}
      >
        <div className="payment-summary">
          <div>
            <span>Total facture</span>
            <strong>{formatMoney(total)}</strong>
          </div>
          <div>
            <span>Avoirs déduits</span>
            <strong>{formatMoney(credited)}</strong>
          </div>
          <div>
            <span>Déjà encaissé</span>
            <strong>{formatMoney(alreadyPaid)}</strong>
          </div>
          <div>
            <span>Solde</span>
            <strong>{formatMoney(balance)}</strong>
          </div>
        </div>
        {accountingState === 'enabled' ? (
          <div className="info-strip">
            <Landmark size={17} />
            <span>
              Le paiement et l’écriture banque contre débiteurs seront
              enregistrés ensemble dans une transaction locale.
            </span>
          </div>
        ) : accountingState === 'disabled' ? (
          <div className="warning-card">
            <Landmark size={18} />
            <div>
              <strong>Comptabilité requise avant l’encaissement</strong>
              <p>
                Zentra ne modifiera ni le solde ni la facture sans écriture
                comptable. Activez les liaisons; les anciennes factures seront
                rattrapées sans doublon.
              </p>
              <Button
                type="button"
                variant="secondary"
                size="small"
                onClick={onOpenAccounting}
              >
                Configurer la comptabilité
              </Button>
            </div>
          </div>
        ) : accountingState === 'error' ? (
          <div className="warning-card">
            <MessageSquareWarning size={18} />
            <div>
              <strong>État comptable non vérifié</strong>
              <p>
                L’encaissement reste bloqué pour éviter une facture payée sans
                écriture.
              </p>
            </div>
          </div>
        ) : (
          <div className="info-strip">
            <LoaderCircle className="spin" size={17} />
            <span>Vérification de la chaîne comptable locale…</span>
          </div>
        )}
        <div className="form-grid">
          <Field label="Montant encaissé (CHF)" required>
            <input
              name="amount"
              type="number"
              min="0.01"
              max={balance / 100}
              step="0.01"
              required
              autoFocus
            />
          </Field>
          <Field label="Date" required>
            <input name="date" type="date" defaultValue={todayIso()} required />
          </Field>
          <Field label="Mode de paiement" required>
            <input name="method" required />
          </Field>
          <Field label="Référence">
            <input name="reference" />
          </Field>
          <Field label="Note" wide>
            <textarea name="notes" rows={2} />
          </Field>
        </div>
        <FormActions
          onCancel={close}
          busy={busy}
          disabled={accountingState !== 'enabled'}
          submitLabel="Enregistrer le paiement"
        />
      </form>
    </Modal>
  );
}

function PayslipPaymentForm({
  payslip,
  workspace,
  busy,
  close,
  act,
}: {
  payslip: Payslip;
  workspace: Workspace;
  busy: boolean;
  close: () => void;
  act: ActionRunner;
}) {
  const employee = workspace.employees.find(
    (item) => item.id === payslip.employeeId,
  );
  const net = payslipTotals(payslip).net;
  const repairingLegacy = payslip.status === 'paid';
  const [paymentDate, setPaymentDate] = useState(
    payslip.paymentDate || todayIso(),
  );
  const [regulatoryOverrideConfirmed, setRegulatoryOverrideConfirmed] =
    useState(false);
  const [regulatoryOverrideReason, setRegulatoryOverrideReason] = useState('');
  const paymentDateAssessment = useMemo(
    () => assessPayrollPaymentDate(payslip, paymentDate),
    [paymentDate, payslip],
  );
  const requiresRegulatoryOverride =
    repairingLegacy &&
    paymentDateAssessment.blocked &&
    paymentDateAssessment.overrideAllowed;
  return (
    <Modal
      title={
        repairingLegacy
          ? 'Régulariser un paiement historique'
          : 'Payer la fiche de salaire'
      }
      description={`${employee?.name || 'Collaborateur'} · ${payslip.period}`}
      onClose={close}
    >
      <form
        onSubmit={submitForm(async (form) => {
          if (!repairingLegacy && paymentDateAssessment.blocked)
            throw new Error(paymentDateAssessment.reason);
          if (
            requiresRegulatoryOverride &&
            (!regulatoryOverrideConfirmed ||
              regulatoryOverrideReason.trim().length < 10)
          )
            throw new Error(
              'Confirmez la dérogation et décrivez précisément le motif de cette régularisation historique.',
            );
          await act(
            () =>
              desktopApi.payPayslip(
                payslip.id,
                paymentDate,
                String(form.get('reference')),
                requiresRegulatoryOverride
                  ? regulatoryOverrideReason
                  : undefined,
              ),
            repairingLegacy
              ? 'Le paiement historique a été relié à son écriture comptable sans modifier la fiche de salaire.'
              : 'Le salaire a été marqué payé et l’écriture banque contre salaires dus a été créée.',
          );
        })}
      >
        <div className="payment-summary">
          <div>
            <span>Collaborateur</span>
            <strong>{employee?.name || '—'}</strong>
          </div>
          <div>
            <span>Période</span>
            <strong>{payslip.period}</strong>
          </div>
          <div>
            <span>Net payé</span>
            <strong>{formatMoney(net)}</strong>
          </div>
          <div>
            <span>État</span>
            <strong>
              {repairingLegacy
                ? 'Paiement historique à relier'
                : 'Comptabilisé'}
            </strong>
          </div>
        </div>
        <div className="form-grid">
          <Field
            label={
              repairingLegacy ? 'Date réelle du paiement' : 'Date du paiement'
            }
            required
          >
            <input
              name="paymentDate"
              type="date"
              value={paymentDate}
              onChange={(event) => setPaymentDate(event.target.value)}
              required
              autoFocus
            />
          </Field>
          <Field
            label="Référence bancaire"
            hint="Facultative, mais recommandée pour le rapprochement."
          >
            <input
              name="reference"
              defaultValue={payslip.paymentReference || ''}
              maxLength={200}
            />
          </Field>
        </div>
        {paymentDateAssessment.blocked ? (
          <ErrorPanel
            message={
              repairingLegacy
                ? paymentDateAssessment.overrideAllowed
                  ? `${paymentDateAssessment.reason} Le salaire est déjà marqué payé : une régularisation reste possible uniquement avec une dérogation explicite et auditée.`
                  : `${paymentDateAssessment.reason} Cette anomalie d’intégrité ne peut pas être contournée. Restaurez une sauvegarde fiable ou faites reconstruire la preuve avant de poursuivre.`
                : paymentDateAssessment.reason
            }
          />
        ) : null}
        {requiresRegulatoryOverride ? (
          <div className="stack-layout payroll-regulatory-override">
            <Field
              label="Motif précis de la régularisation"
              hint="10 à 500 caractères. Ce motif sera conservé dans le journal d’audit."
              required
            >
              <textarea
                value={regulatoryOverrideReason}
                onChange={(event) =>
                  setRegulatoryOverrideReason(event.target.value)
                }
                minLength={10}
                maxLength={500}
                rows={3}
                required
              />
            </Field>
            <label className="check-card">
              <input
                type="checkbox"
                checked={regulatoryOverrideConfirmed}
                onChange={(event) =>
                  setRegulatoryOverrideConfirmed(event.target.checked)
                }
              />
              <span>
                <strong>Je confirme cette dérogation historique</strong>
                <small>
                  J’ai vérifié la date réelle et j’accepte que l’écart au calcul
                  réglementaire figé soit tracé sans modifier les montants de
                  la fiche.
                </small>
              </span>
            </label>
          </div>
        ) : null}
        <div className="info-strip">
          <Landmark size={17} />
          <span>
            {repairingLegacy
              ? 'Zentra conserve les montants historiques et crée ou retrouve uniquement le lien comptable manquant. La date déjà enregistrée ne peut pas être remplacée.'
              : 'Cette action débite les salaires à payer, crédite la banque et verrouille définitivement la date et la référence.'}
          </span>
        </div>
        <FormActions
          onCancel={close}
          busy={busy}
          disabled={
            (paymentDateAssessment.blocked &&
              (!repairingLegacy || !paymentDateAssessment.overrideAllowed)) ||
            (requiresRegulatoryOverride &&
              (!regulatoryOverrideConfirmed ||
                regulatoryOverrideReason.trim().length < 10))
          }
          submitLabel={
            repairingLegacy
              ? 'Régulariser le paiement'
              : 'Confirmer le paiement'
          }
        />
      </form>
    </Modal>
  );
}

function TimerForm({
  workspace,
  busy,
  close,
  act,
}: {
  workspace: Workspace;
  busy: boolean;
  close: () => void;
  act: ActionRunner;
}) {
  const terminology = projectTerminology(
    workspace.settings!.business.nogaSection,
  );
  const [projectId, setProjectId] = useState('');
  const [taskId, setTaskId] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [billable, setBillable] = useState<'' | 'yes' | 'no'>('');
  const employee = workspace.employees.find((item) => item.id === employeeId);
  const availableTasks = workspace.projectTasks.filter(
    (task) =>
      task.projectId === projectId &&
      (task.status === 'todo' || task.status === 'in_progress'),
  );
  return (
    <Modal
      title="Démarrer un pointage"
      description="Choisissez le projet, éventuellement une tâche, puis le collaborateur. Le coût horaire vient de sa fiche réelle."
      onClose={close}
    >
      <form
        onSubmit={submitForm(async (form) => {
          await act(
            () =>
              desktopApi.startTimer({
                projectId,
                taskId: taskId || null,
                employeeId,
                note: String(form.get('note')),
                billable: billable === 'yes',
                billingRateCents:
                  billable === 'yes'
                    ? centsFromInput(form.get('billingRate'))
                    : 0,
                costRateCents: employee?.hourlyCostCents ?? 0,
              }),
            'Le pointage a démarré.',
          );
        })}
      >
        <div className="timer-modal-icon">
          <Play size={25} />
        </div>
        <div className="form-grid">
          <Field label={terminology.singularTitle} required wide>
            <select
              name="projectId"
              value={projectId}
              onChange={(event) => {
                setProjectId(event.target.value);
                setTaskId('');
              }}
              required
              autoFocus
            >
              <option value="">Choisir un {terminology.singular}</option>
              {workspace.projects
                .filter((project) => project.status !== 'closed')
                .map((project) => (
                  <option value={project.id} key={project.id}>
                    {project.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field
            label="Tâche liée"
            hint="Facultatif : le temps sera rattaché à cette tâche à l’arrêt."
            wide
          >
            <select
              value={taskId}
              onChange={(event) => setTaskId(event.target.value)}
              disabled={!projectId}
            >
              <option value="">Sans tâche précise</option>
              {availableTasks.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Collaborateur" required wide>
            <select
              value={employeeId}
              onChange={(event) => setEmployeeId(event.target.value)}
              required
            >
              <option value="">Choisir un collaborateur</option>
              {workspace.employees
                .filter((item) => item.active)
                .map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Temps facturable au client ?" required>
            <select
              value={billable}
              onChange={(event) =>
                setBillable(event.target.value as '' | 'yes' | 'no')
              }
              required
            >
              <option value="">Choisir</option>
              <option value="yes">Oui, facturable</option>
              <option value="no">Non, interne</option>
            </select>
          </Field>
          {billable === 'yes' ? (
            <Field label="Tarif de facturation (CHF/h)" required>
              <input
                name="billingRate"
                type="number"
                min="0"
                step="0.01"
                required
              />
            </Field>
          ) : null}
          <Field label="Note de travail" wide>
            <textarea name="note" rows={3} />
          </Field>
        </div>
        {employeeId ? (
          <div className="info-strip">
            <Clock3 size={17} />
            <span>
              Coût horaire appliqué :{' '}
              {formatMoney(employee?.hourlyCostCents ?? 0)}. Cette valeur
              provient de la fiche du collaborateur.
            </span>
          </div>
        ) : null}
        <FormActions
          onCancel={close}
          busy={busy}
          submitLabel="Démarrer le chronomètre"
        />
      </form>
    </Modal>
  );
}

function settingsForSnapshot(
  current: AppSettings,
  issuer?: FrozenIssuer,
  terms?: string,
): AppSettings {
  if (!issuer) return current;
  return {
    ...current,
    organization: {
      ...current.organization,
      legalName: issuer.companyName,
      legalForm: issuer.legalForm,
      contactName: issuer.ownerName,
      email: issuer.email,
      phone: issuer.phone,
      uidNumber: issuer.uidNumber,
      vatNumber: issuer.vatNumber,
      vatRegistered: issuer.vatRegistered,
      logoPath: issuer.logoPath || undefined,
      address: {
        street: issuer.addressLine1,
        buildingNumber: issuer.buildingNumber,
        postalCode: issuer.postalCode,
        city: issuer.city,
        canton: issuer.canton,
        country: issuer.country,
      },
    },
    billing: {
      ...current.billing,
      iban: issuer.iban,
      accountHolder: issuer.bankName || issuer.companyName,
      defaultFooter: terms ?? current.billing.defaultFooter,
    },
  };
}

function clientForSnapshot(
  customer: FrozenCustomer | undefined,
  current?: Client,
): Client | undefined {
  if (!customer?.id && !customer?.name && !customer?.company) return current;
  const address = [
    customer.addressLine1,
    customer.addressLine2,
    [customer.postalCode, customer.city].filter(Boolean).join(' '),
    customer.canton,
    customer.country,
  ]
    .filter(Boolean)
    .join('\n');
  return {
    id: customer.id,
    name: customer.contactPerson || customer.name,
    company: customer.company,
    email: customer.email,
    phone: customer.phone,
    address,
    addressLine1: customer.addressLine1,
    addressLine2: customer.addressLine2,
    buildingNumber: customer.addressLine2,
    postalCode: customer.postalCode,
    city: customer.city,
    canton: customer.canton,
    country: customer.country,
    uidNumber: '',
    notes: '',
  };
}

function quoteForPrint(quote: Quote): Quote {
  const frozen = quote.snapshot;
  if (!frozen) return quote;
  return {
    ...quote,
    number: frozen.document.number,
    clientId: frozen.document.clientId,
    projectId: frozen.document.projectId,
    title: frozen.document.title,
    issueDate: frozen.document.issueDate,
    validUntil: frozen.document.validUntil,
    currency: frozen.document.currency,
    lines: frozen.items,
    notes: frozen.document.notes,
  };
}

function invoiceForPrint(invoice: Invoice): Invoice {
  const frozen = invoice.snapshot;
  if (!frozen) return invoice;
  return {
    ...invoice,
    number: frozen.document.number,
    clientId: frozen.document.clientId,
    projectId: frozen.document.projectId,
    quoteId: frozen.document.quoteId,
    originalInvoiceId: frozen.document.originalInvoiceId,
    title: frozen.document.title,
    issueDate: frozen.document.issueDate,
    dueDate: frozen.document.dueDate,
    serviceDateFrom: frozen.document.serviceDateFrom,
    serviceDateTo: frozen.document.serviceDateTo,
    currency: frozen.document.currency,
    lines: frozen.items,
    notes: frozen.document.notes,
  };
}

function QrPrintForm({
  invoice,
  workspace,
  close,
  onReady,
}: {
  invoice: Invoice;
  workspace: Workspace;
  close: () => void;
  onReady: (invoice: Invoice, qr: StoredSwissQrBill) => void;
}) {
  const printedInvoice = invoiceForPrint(invoice);
  const settings = settingsForSnapshot(
    workspace.settings!,
    invoice.snapshot?.issuer,
    invoice.snapshot?.document.terms,
  );
  const client = clientForSnapshot(
    invoice.snapshot?.customer,
    workspace.clients.find((item) => item.id === printedInvoice.clientId),
  );
  const initialStored = invoice.snapshot?.qrBill ?? invoice.qrBill ?? null;
  const [stored, setStored] = useState<StoredSwissQrBill | null>(initialStored);
  const [loadingStored, setLoadingStored] = useState(!initialStored);
  const [referenceType, setReferenceType] = useState<
    SwissQrBillInput['referenceType'] | ''
  >(initialStored?.input.referenceType ?? '');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const amountCents = documentTotals(printedInvoice.lines).totalCents;
  const qrCurrency = printedInvoice.currency === 'CHF' || printedInvoice.currency === 'EUR'
    ? printedInvoice.currency
    : null;
  // Le champ `street` peut contenir address_line1 puis address_line2 séparés
  // par un retour à la ligne dans les anciens profils. Le payload SPC exige la
  // rue canonique uniquement; le complément ne doit jamais y être concaténé.
  const creditorStreet = settings.organization.address.street
    .split(/\r?\n/, 1)[0]
    .trim();

  useEffect(() => {
    if (initialStored) return;
    let active = true;
    void desktopApi
      .getInvoiceQrBill(invoice.id)
      .then((value) => {
        if (active) {
          setStored(value);
          setReferenceType(value?.input.referenceType ?? '');
        }
      })
      .catch((reason) => {
        if (active)
          setErrors([
            errorMessage(reason, 'La QR-facture figée n’a pas pu être relue.'),
          ]);
      })
      .finally(() => {
        if (active) setLoadingStored(false);
      });
    return () => {
      active = false;
    };
  }, [initialStored, invoice.id]);

  if (loadingStored)
    return (
      <Modal
        title="QR-facture suisse"
        description="Recherche de la version enregistrée localement."
        onClose={close}
      >
        <div className="compact-empty">
          <LoaderCircle className="spin" size={20} />
          <span>Chargement de la QR-facture…</span>
        </div>
      </Modal>
    );

  if (stored?.frozenAt) {
    const input = stored.input;
    return (
      <Modal
        title="QR-facture suisse figée"
        description="La réimpression utilise exactement le payload enregistré et audité pour cette facture."
        onClose={close}
        wide
      >
        <div className="qr-preflight">
          <section>
            <span>CRÉANCIER FIGÉ</span>
            <strong>{input.creditor.name}</strong>
            <p>
              {input.creditor.street} {input.creditor.buildingNumber}
              <br />
              {input.creditor.postalCode} {input.creditor.city} ·{' '}
              {input.creditor.country}
            </p>
          </section>
          <section>
            <span>DÉBITEUR FIGÉ</span>
            <strong>{input.debtor?.name || '—'}</strong>
            <p>
              {input.debtor ? (
                <>
                  {input.debtor.street} {input.debtor.buildingNumber}
                  <br />
                  {input.debtor.postalCode} {input.debtor.city} ·{' '}
                  {input.debtor.country}
                </>
              ) : (
                'Non renseigné'
              )}
            </p>
          </section>
          <section>
            <span>PAYLOAD FIGÉ</span>
            <strong>{formatMoney(input.amountCents)}</strong>
            <p>
              {stored.referenceType} ·{' '}
              {stored.frozenAt
                ? `figé le ${formatDateTime(stored.frozenAt)}`
                : 'figé localement'}
            </p>
          </section>
        </div>
        <div className="info-strip">
          <LockKeyhole size={17} />
          <span>
            Le compte, les adresses, le montant, la référence et les
            informations supplémentaires ne peuvent plus être modifiés. Une
            correction exige un document correctif.
          </span>
        </div>
        {errors.length ? <ErrorPanel message={errors.join(' ')} /> : null}
        <div className="form-actions">
          <Button variant="secondary" onClick={close}>
            Fermer
          </Button>
          <Button onClick={() => onReady(invoice, stored)}>
            <Printer size={16} /> Ouvrir l’aperçu figé
          </Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={stored ? 'Mettre à jour la QR-facture brouillon' : 'Créer la QR-facture suisse'}
      description={stored ? 'Cette QR reste modifiable tant que la facture est brouillon. Elle sera revalidée et figée lors de l’émission.' : 'La QR est enregistrée comme brouillon, puis revalidée et figée lors de l’émission de la facture.'}
      onClose={close}
      wide
    >
      <form
        onSubmit={submitForm(async (form) => {
          if (!client || !referenceType) return;
          if (!qrCurrency) {
            setErrors(['La QR-facture suisse accepte uniquement les devises CHF et EUR.']);
            return;
          }
          const input: SwissQrBillInput = {
            iban: settings.billing.iban,
            creditor: {
              name:
                settings.billing.accountHolder ||
                settings.organization.legalName,
              street: creditorStreet,
              buildingNumber:
                settings.organization.address.buildingNumber ?? '',
              postalCode: settings.organization.address.postalCode,
              city: settings.organization.address.city,
              country: settings.organization.address.country.toUpperCase(),
            },
            amountCents,
            currency: qrCurrency,
            debtor: {
              name: client.company || client.name,
              street: client.addressLine1 ?? '',
              buildingNumber:
                client.buildingNumber ?? client.addressLine2 ?? '',
              postalCode: client.postalCode ?? '',
              city: client.city ?? '',
              country: (client.country ?? '').toUpperCase(),
            },
            referenceType,
            reference:
              referenceType === 'NON'
                ? ''
                : String(form.get('reference')).replace(/\s/g, ''),
            unstructuredMessage: String(form.get('message')),
            billInformation: String(form.get('billInformation')),
            alternativeProcedures: [],
          };
          setBusy(true);
          setErrors([]);
          setWarnings([]);
          try {
            const validation = await desktopApi.validateSwissQrBill(input);
            setWarnings(validation.warnings);
            if (!validation.valid) {
              setErrors(validation.errors);
              return;
            }
            const saved = await desktopApi.saveInvoiceQrBill(
              invoice.id,
              validation.normalized,
            );
            setStored(saved);
            onReady(invoice, saved);
          } catch (reason) {
            setErrors([
              errorMessage(
                reason,
                'La QR-facture n’a pas pu être enregistrée.',
              ),
            ]);
          } finally {
            setBusy(false);
          }
        })}
      >
        <div className="qr-preflight">
          <section>
            <span>CRÉANCIER DU SNAPSHOT</span>
            <strong>
              {settings.billing.accountHolder ||
                settings.organization.legalName}
            </strong>
            <p>
              {creditorStreet}{' '}
              {settings.organization.address.buildingNumber}
              <br />
              {settings.organization.address.postalCode}{' '}
              {settings.organization.address.city} ·{' '}
              {settings.organization.address.country || 'Pays manquant'}
            </p>
          </section>
          <section>
            <span>DÉBITEUR DU SNAPSHOT</span>
            <strong>
              {client?.company || client?.name || 'Client introuvable'}
            </strong>
            <p>
              {client?.addressLine1 || 'Rue manquante'} {client?.buildingNumber}
              <br />
              {client?.postalCode || 'NPA manquant'}{' '}
              {client?.city || 'Localité manquante'} ·{' '}
              {client?.country || 'Pays manquant'}
            </p>
          </section>
          <section>
            <span>MONTANT FIGÉ</span>
            <strong>{formatMoney(amountCents)}</strong>
            <p>{settings.billing.iban || 'IBAN manquant'}</p>
          </section>
        </div>
        <div className="form-grid">
          <Field label="Type de référence" required>
            <select
              value={referenceType}
              onChange={(event) =>
                setReferenceType(
                  event.target.value as SwissQrBillInput['referenceType'] | '',
                )
              }
              required
            >
              <option value="">Choisir selon votre IBAN</option>
              <option value="QRR">QRR · référence QR 27 chiffres</option>
              <option value="SCOR">SCOR · Creditor Reference ISO 11649</option>
              <option value="NON">NON · sans référence structurée</option>
            </select>
          </Field>
          {referenceType !== '' && referenceType !== 'NON' ? (
            <Field
              label={
                referenceType === 'QRR'
                  ? 'Référence QR (27 chiffres)'
                  : 'Creditor Reference (RF…)'
              }
              required
            >
              <input name="reference" defaultValue={stored?.input.reference ?? ''} required />
            </Field>
          ) : null}
          <Field
            label="Message non structuré"
            wide
            hint="La longueur est contrôlée selon la norme SIX."
          >
            <textarea name="message" rows={3} defaultValue={stored?.input.unstructuredMessage ?? ''} />
          </Field>
          <Field
            label="Informations de facture structurées"
            wide
            hint="Facultatif; ne renseignez que si votre format est conforme."
          >
            <input name="billInformation" defaultValue={stored?.input.billInformation ?? ''} />
          </Field>
        </div>
        {errors.length ? (
          <div className="qr-validation qr-validation--error">
            <strong>Enregistrement bloqué</strong>
            {errors.map((error) => (
              <p key={error}>{error}</p>
            ))}
          </div>
        ) : null}
        {warnings.length ? (
          <div className="qr-validation">
            <strong>Avertissements</strong>
            {warnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </div>
        ) : null}
        <div className="info-strip">
          <LockKeyhole size={17} />
          <span>
            Tant que la facture est brouillon, ce payload peut être régénéré.
            À l’émission, Zentra le compare au total, à la devise et aux parties,
            puis le fige pour toutes les réimpressions.
          </span>
        </div>
        <FormActions
          onCancel={close}
          busy={busy}
          submitLabel={stored ? 'Mettre à jour et ouvrir l’aperçu' : 'Enregistrer et ouvrir l’aperçu'}
        />
      </form>
    </Modal>
  );
}

function SalesPdfExportControl({
  entity,
  documentId,
  suggestedFileName,
  idleMessage,
}: {
  entity: 'quotes' | 'invoices';
  documentId: string;
  suggestedFileName: string;
  idleMessage: string;
}) {
  const [exporting, setExporting] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [failed, setFailed] = useState(false);

  const exportPdf = async () => {
    if (exporting) return;
    setExporting(true);
    setFailed(false);
    setFeedback('');
    try {
      const result = await desktopApi.exportSalesDocumentPdf(
        entity,
        documentId,
        suggestedFileName,
      );
      if (result) {
        setFeedback(
          `${result.finalDocument ? 'PDF final' : 'PDF brouillon'} enregistré (${result.pages} ${result.pages > 1 ? 'pages' : 'page'}) : ${result.path}`,
        );
      }
    } catch (reason) {
      setFailed(true);
      setFeedback(
        errorMessage(
          reason,
          "Le PDF local n'a pas pu être généré. Vérifiez les données du document et le chemin choisi.",
        ),
      );
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <span
        role={failed ? 'alert' : 'status'}
        title={feedback || idleMessage}
        style={{
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {feedback || idleMessage}
      </span>
      <Button
        variant="secondary"
        disabled={exporting}
        onClick={() => void exportPdf()}
      >
        {exporting ? (
          <LoaderCircle className="spin" size={16} />
        ) : (
          <Download size={16} />
        )}{' '}
        {exporting ? 'Génération…' : 'Exporter le PDF'}
      </Button>
    </>
  );
}

function PrintSheet({
  target,
  workspace,
  onClose,
}: {
  target: Exclude<PrintTarget, null>;
  workspace: Workspace;
  onClose: () => void;
}) {
  if (target.entity === 'delivery_notes')
    return (
      <DeliveryNotePrintPreview
        note={target.value}
        order={target.order}
        workspace={workspace}
        onClose={onClose}
      />
    );
  if (target.entity === 'sales_orders')
    return (
      <SalesOrderPrintPreview
        order={target.value}
        workspace={workspace}
        onClose={onClose}
      />
    );
  if (target.entity === 'invoices')
    return (
      <InvoicePrintSheet
        invoice={target.value}
        qr={target.qr}
        workspace={workspace}
        onClose={onClose}
      />
    );
  if (target.entity === 'payslips')
    return (
      <PayslipPrintSheet
        payslip={target.value}
        workspace={workspace}
        onClose={onClose}
      />
    );
  const source = target.value as Quote;
  const document = quoteForPrint(source);
  const settings = settingsForSnapshot(
    workspace.settings!,
    source.snapshot?.issuer,
    source.snapshot?.document.terms ?? source.terms,
  );
  const client = clientForSnapshot(
    source.snapshot?.customer,
    workspace.clients.find((item) => item.id === document.clientId),
  );
  const totals = documentTotals(document.lines);
  const isQuote = true;
  const due = document.validUntil;
  return (
    <div className="print-preview">
      <div className="print-preview__toolbar">
        <strong>Aperçu d’impression</strong>
        <SalesPdfExportControl
          entity="quotes"
          documentId={source.id}
          suggestedFileName={salesPdfSuggestedFileName(
            'quotes',
            document.number,
          )}
          idleMessage="PDF local A4 déterministe · vérifiez les informations avant export."
        />
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X size={18} />
        </Button>
      </div>
      <article className="print-sheet">
        <PrintHeader
          settings={settings}
          title={isQuote ? 'DEVIS' : 'FACTURE'}
          number={document.number}
        />
        <div className="print-meta">
          <div>
            <span>Émis le</span>
            <strong>{formatDate(document.issueDate)}</strong>
          </div>
          <div>
            <span>{isQuote ? 'Valable jusqu’au' : 'Échéance'}</span>
            <strong>{formatDate(due)}</strong>
          </div>
        </div>
        <section className="print-recipient">
          <span>DESTINATAIRE</span>
          <strong>{client?.company || client?.name || '—'}</strong>
          <p>
            {client?.address || '—'}
            <br />
            {client?.email || ''}
          </p>
        </section>
        <h2 className="print-title">{document.title}</h2>
        <table className="print-table">
          <thead>
            <tr>
              <th>Description</th>
              <th>Qté</th>
              <th>Unité</th>
              <th>Prix unitaire</th>
              <th>Remise</th>
              <th>TVA</th>
              <th>Total net</th>
            </tr>
          </thead>
          <tbody>
            {document.lines.map((line) => (
              <tr key={line.id}>
                <td>{line.description}</td>
                <td>{line.quantity.toLocaleString('fr-CH')}</td>
                <td>{line.unit}</td>
                <td>{formatMoney(line.unitPriceCents)}</td>
                <td>
                  {line.discountBp
                    ? `${(line.discountBp / 100).toLocaleString('fr-CH')} %`
                    : '—'}
                </td>
                <td>
                  {settings.organization.vatRegistered
                    ? `${(line.vatRateBp / 100).toLocaleString('fr-CH')} %`
                    : '—'}
                </td>
                <td>{formatMoney(documentLineTotals(line).netCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="print-totals">
          <div>
            <span>Sous-total avant remise</span>
            <strong>{formatMoney(totals.subtotalCents)}</strong>
          </div>
          {totals.discountCents ? (
            <div>
              <span>Remises</span>
              <strong>− {formatMoney(totals.discountCents)}</strong>
            </div>
          ) : null}
          <div>
            <span>Total net</span>
            <strong>{formatMoney(totals.netCents)}</strong>
          </div>
          <div>
            <span>TVA</span>
            <strong>{formatMoney(totals.vatCents)}</strong>
          </div>
          <div className="print-totals__grand">
            <span>Total TTC</span>
            <strong>{formatMoney(totals.totalCents)}</strong>
          </div>
        </div>
        <footer className="print-footer">
          <p>{document.notes}</p>
          <p>
            <strong>IBAN</strong> · {settings.billing.iban}
            <br />
            {settings.billing.defaultFooter}
          </p>
        </footer>
      </article>
    </div>
  );
}

function PayslipPrintSheet({
  payslip,
  workspace,
  onClose,
}: {
  payslip: Payslip;
  workspace: Workspace;
  onClose: () => void;
}) {
  const frozen = payslip.snapshot;
  const [contributions, setContributions] = useState<
    PayslipContributionSnapshot[] | null
  >(frozen?.contributions ?? null);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState('');
  const settings = settingsForSnapshot(workspace.settings!, frozen?.issuer);
  const employee =
    frozen?.employee ??
    workspace.employees.find((item) => item.id === payslip.employeeId);
  const printedPayslip = frozen
    ? {
        ...payslip,
        period: frozen.period,
        paymentDate:
          payslip.status === 'paid' && payslip.paymentDate
            ? payslip.paymentDate
            : frozen.paymentDate,
        notes: frozen.notes,
        lines: frozen.items,
      }
    : payslip;
  const totals = payslipTotals(printedPayslip);

  useEffect(() => {
    if (frozen) return;
    let active = true;
    void desktopApi
      .getPayslipContributions(payslip.id)
      .then((rows) => {
        if (active) setContributions(rows);
      })
      .catch((reason) => {
        if (active)
          setError(
            errorMessage(
              reason,
              'Les cotisations figées n’ont pas pu être chargées.',
            ),
          );
      });
    return () => {
      active = false;
    };
  }, [frozen, payslip.id]);

  const snapshots = new Map(
    (contributions ?? []).map((contribution) => [
      contribution.payslipItemId,
      contribution,
    ]),
  );
  const orderedLines = (
    ['earning', 'reimbursement', 'deduction', 'employer'] as const
  ).flatMap((kind) =>
    printedPayslip.lines.filter((line) => line.kind === kind),
  );
  const statusText = frozen
    ? `Document final figé le ${formatDateTime(frozen.capturedAt)}`
    : 'Aperçu à contrôler · non comptabilisé';
  const exportPdf = async () => {
    setExporting(true);
    setExportMessage('');
    try {
      const safeEmployee = (employee?.name || 'collaborateur')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9_-]+/g, '-')
        .replace(/^-|-$/g, '');
      const result = await desktopApi.exportPayslipPdf(
        payslip.id,
        `Fiche-salaire_${printedPayslip.period}_${safeEmployee}.pdf`,
      );
      if (result)
        setExportMessage(
          result.finalDocument
            ? `PDF final enregistré : ${result.path}`
            : `PDF de contrôle enregistré : ${result.path}`,
        );
    } catch (reason) {
      setError(errorMessage(reason, "Le PDF local n'a pas pu être généré."));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="print-preview">
      <div className="print-preview__toolbar">
        <strong>Aperçu de la fiche détaillée</strong>
        <span>
          {error ||
            exportMessage ||
            (contributions === null
              ? 'Chargement des valeurs figées…'
              : statusText)}
        </span>
        <Button
          disabled={contributions === null || Boolean(error) || exporting}
          onClick={() => void exportPdf()}
        >
          {exporting ? (
            <LoaderCircle className="spin" size={16} />
          ) : (
            <Download size={16} />
          )}{' '}
          {exporting ? 'Génération…' : 'Exporter le PDF'}
        </Button>
        <Button
          variant="secondary"
          disabled={contributions === null || Boolean(error)}
          onClick={() => window.print()}
        >
          <Printer size={16} /> Imprimer
        </Button>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X size={18} />
        </Button>
      </div>
      {error ? <ErrorPanel message={error} /> : null}
      <article
        className={`print-sheet print-payslip ${frozen ? 'print-payslip--final' : 'print-payslip--review'}`}
      >
        <PrintHeader
          settings={settings}
          title="FICHE DE SALAIRE"
          number={printedPayslip.period}
        />
        <div
          className={`payslip-document-state ${frozen ? 'is-final' : 'is-review'}`}
        >
          <ShieldCheck size={15} />
          <strong>{statusText}</strong>
        </div>
        <div className="print-meta print-payslip-meta">
          <div>
            <span>Période</span>
            <strong>{printedPayslip.period}</strong>
          </div>
          <div>
            <span>Date de paiement</span>
            <strong>{formatDate(printedPayslip.paymentDate)}</strong>
          </div>
          <div>
            <span>N° employé</span>
            <strong>{employee?.employeeNumber || '—'}</strong>
          </div>
          <div>
            <span>Taux d’activité</span>
            <strong>
              {employee?.employmentRate ? `${employee.employmentRate} %` : '—'}
            </strong>
          </div>
        </div>
        <section className="print-recipient print-payslip-recipient">
          <span>COLLABORATEUR</span>
          <strong>{employee?.name || '—'}</strong>
          <p>
            {employee?.role || 'Fonction non renseignée'}
            <br />
            {employee?.address || 'Adresse non renseignée'}
            <br />
            N° AVS · {employee?.avsNumber || 'non renseigné'}
            <br />
            IBAN · {employee?.iban || 'non renseigné'}
          </p>
        </section>
        <table className="print-table print-payroll-table">
          <thead>
            <tr>
              <th>Élément</th>
              <th>Part / type</th>
              <th>Base</th>
              <th>Calcul figé</th>
              <th>Montant</th>
            </tr>
          </thead>
          <tbody>
            {orderedLines.map((line, index) => {
              const snapshot = snapshots.get(line.id);
              const previous = orderedLines[index - 1];
              const group =
                line.kind === 'earning'
                  ? 'Rémunération'
                  : line.kind === 'reimbursement'
                    ? 'Remboursements hors brut'
                    : line.kind === 'deduction'
                      ? 'Retenues employé'
                      : 'Cotisations employeur · information';
              return (
                <Fragment key={line.id}>
                  {!previous || previous.kind !== line.kind ? (
                    <tr className="payroll-print-group">
                      <td colSpan={5}>{group}</td>
                    </tr>
                  ) : null}
                  <tr>
                    <td>
                      <strong>{line.label}</strong>
                      {snapshot ? (
                        <small>
                          {snapshot.source}
                          <br />
                          Effet {formatDate(snapshot.effectiveFrom)}
                          {snapshot.effectiveTo
                            ? ` → ${formatDate(snapshot.effectiveTo)}`
                            : ''}
                        </small>
                      ) : (
                        <small>Saisie contrôlée</small>
                      )}
                    </td>
                    <td>
                      {snapshot
                        ? snapshot.side === 'employee'
                          ? 'Part employé'
                          : 'Part employeur'
                        : line.kind === 'earning'
                          ? 'Gain'
                          : line.kind === 'reimbursement'
                            ? 'Remboursement hors brut'
                            : line.kind === 'deduction'
                              ? 'Retenue manuelle'
                              : 'Charge manuelle'}
                    </td>
                    <td>
                      {snapshot ? (
                        <>
                          {formatMoney(snapshot.basisCents)}
                          {snapshot.annualCeilingCents ? (
                            <small>
                              Cumul avant période{' '}
                              {formatMoney(snapshot.yearToDateBasisCents)}
                              <br />
                              Plafond annuel{' '}
                              {formatMoney(snapshot.annualCeilingCents)}
                            </small>
                          ) : null}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      {snapshot
                        ? snapshot.calculationKind === 'rate'
                          ? `${((snapshot.rateBp ?? 0) / 100).toLocaleString('fr-CH')} %`
                          : `Fixe ${formatMoney(snapshot.fixedAmountCents)}`
                        : 'Montant saisi'}
                    </td>
                    <td>{formatMoney(line.amountCents)}</td>
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
        <div className="print-totals">
          <div>
            <span>Salaire brut</span>
            <strong>{formatMoney(totals.earnings)}</strong>
          </div>
          <div>
            <span>Remboursements hors brut</span>
            <strong>{formatMoney(totals.reimbursements)}</strong>
          </div>
          <div>
            <span>Retenues employé</span>
            <strong>{formatMoney(totals.deductions)}</strong>
          </div>
          <div>
            <span>Charges employeur</span>
            <strong>{formatMoney(totals.employer)}</strong>
          </div>
          <div className="print-totals__grand">
            <span>Net à payer</span>
            <strong>{formatMoney(totals.net)}</strong>
          </div>
        </div>
        <footer className="print-footer">
          <p>{printedPayslip.notes}</p>
          <p>
            {frozen
              ? 'Les valeurs et sources ont été figées lors de la comptabilisation.'
              : 'Document de contrôle : validez puis comptabilisez la fiche pour obtenir la version finale figée.'}
          </p>
        </footer>
      </article>
    </div>
  );
}

function PrintHeader({
  settings,
  title,
  number,
}: {
  settings: AppSettings;
  title: string;
  number: string;
}) {
  const org = settings.organization;
  return (
    <header className="print-header">
      <div>
        <div className="print-brand">
          {org.logoPath ? (
            <img src={convertFileSrc(org.logoPath)} alt="" />
          ) : (
            <BrandMark size={24} />
          )}
          <span>Zentra</span>
        </div>
        <strong>{org.legalName}</strong>
        <p>
          {org.address.street} {org.address.buildingNumber}
          <br />
          {org.address.postalCode} {org.address.city}
          {org.uidNumber ? (
            <>
              <br />
              IDE {org.uidNumber}
            </>
          ) : null}
          {org.vatRegistered && org.vatNumber ? (
            <>
              <br />
              N° TVA {org.vatNumber}
            </>
          ) : null}
        </p>
      </div>
      <div>
        <h1>{title}</h1>
        <strong>{number || '—'}</strong>
      </div>
    </header>
  );
}

function vatBreakdown(lines: DocumentLine[]) {
  const groups = new Map<
    number,
    { rateBp: number; baseCents: number; vatCents: number }
  >();
  for (const line of lines) {
    const totals = documentLineTotals(line);
    const baseCents = totals.netCents;
    const current = groups.get(line.vatRateBp) ?? {
      rateBp: line.vatRateBp,
      baseCents: 0,
      vatCents: 0,
    };
    current.baseCents += baseCents;
    current.vatCents += totals.vatCents;
    groups.set(line.vatRateBp, current);
  }
  return [...groups.values()].sort((a, b) => a.rateBp - b.rateBp);
}

function InvoicePrintSheet({
  invoice: sourceInvoice,
  qr,
  workspace,
  onClose,
}: {
  invoice: Invoice;
  qr?: StoredSwissQrBill;
  workspace: Workspace;
  onClose: () => void;
}) {
  const invoice = invoiceForPrint(sourceInvoice);
  const settings = settingsForSnapshot(
    workspace.settings!,
    sourceInvoice.snapshot?.issuer,
    sourceInvoice.snapshot?.document.terms ?? sourceInvoice.terms,
  );
  const client = clientForSnapshot(
    sourceInvoice.snapshot?.customer,
    workspace.clients.find((item) => item.id === invoice.clientId),
  );
  const totals = documentTotals(invoice.lines);
  const originalSource = invoice.originalInvoiceId
    ? workspace.invoices.find((item) => item.id === invoice.originalInvoiceId)
    : undefined;
  const original = originalSource ? invoiceForPrint(originalSource) : undefined;
  const vatGroups = vatBreakdown(invoice.lines);
  const servicePeriod =
    invoice.serviceDateFrom === invoice.serviceDateTo
      ? formatDate(invoice.serviceDateFrom)
      : `${formatDate(invoice.serviceDateFrom)} → ${formatDate(invoice.serviceDateTo)}`;
  const exportDescription = sourceInvoice.snapshot
    ? `Document figé le ${formatDateTime(sourceInvoice.snapshot.capturedAt)} · pagination A4 automatique.`
    : qr
      ? 'QR-facture validée localement · pagination A4 automatique.'
      : invoice.type === 'credit_note'
        ? 'Avoir sans section de paiement · pagination A4 automatique.'
        : 'Facture sans section QR · pagination A4 automatique.';
  return (
    <div className="print-preview">
      <div className="print-preview__toolbar">
        <strong>Aperçu d’impression</strong>
        <SalesPdfExportControl
          entity="invoices"
          documentId={sourceInvoice.id}
          suggestedFileName={salesPdfSuggestedFileName(
            'invoices',
            invoice.number,
            invoice.type === 'credit_note',
          )}
          idleMessage={exportDescription}
        />
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X size={18} />
        </Button>
      </div>
      <article className={`print-sheet ${qr ? 'print-sheet--qr' : ''}`}>
        <div className="print-invoice-body">
          <PrintHeader
            settings={settings}
            title={
              invoice.type === 'credit_note'
                ? 'AVOIR'
                : invoice.type === 'deposit'
                  ? 'FACTURE D’ACOMPTE'
                  : 'FACTURE'
            }
            number={invoice.number}
          />
          <div className="print-meta">
            <div>
              <span>Émis le</span>
              <strong>{formatDate(invoice.issueDate)}</strong>
            </div>
            <div>
              <span>Prestation</span>
              <strong>{servicePeriod}</strong>
            </div>
            {invoice.type !== 'credit_note' ? (
              <div>
                <span>Échéance</span>
                <strong>{formatDate(invoice.dueDate)}</strong>
              </div>
            ) : (
              <div>
                <span>Facture corrigée</span>
                <strong>{original?.number || '—'}</strong>
              </div>
            )}
            {invoice.type === 'deposit' && invoice.depositPercentageBp ? (
              <div>
                <span>Acompte</span>
                <strong>
                  {(invoice.depositPercentageBp / 100).toLocaleString('fr-CH')} %
                </strong>
              </div>
            ) : null}
          </div>
          <section className="print-recipient">
            <span>DESTINATAIRE</span>
            <strong>{client?.company || client?.name || '—'}</strong>
            <p>
              {client?.address || '—'}
              <br />
              {client?.email || ''}
            </p>
          </section>
          <h2 className="print-title">{invoice.title}</h2>
          <table className="print-table">
            <thead>
              <tr>
                <th>Description</th>
                <th>Qté</th>
                <th>Unité</th>
                <th>Prix unitaire</th>
                <th>Remise</th>
                <th>TVA</th>
                <th>Total net</th>
              </tr>
            </thead>
            <tbody>
              {invoice.lines.map((line) => (
                <tr key={line.id}>
                  <td>{line.description}</td>
                  <td>{line.quantity.toLocaleString('fr-CH')}</td>
                  <td>{line.unit}</td>
                  <td>{formatMoney(line.unitPriceCents)}</td>
                  <td>
                    {line.discountBp
                      ? `${(line.discountBp / 100).toLocaleString('fr-CH')} %`
                      : '—'}
                  </td>
                  <td>
                    {settings.organization.vatRegistered
                      ? `${(line.vatRateBp / 100).toLocaleString('fr-CH')} %`
                      : 'Sans TVA'}
                  </td>
                  <td>{formatMoney(documentLineTotals(line).netCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="print-totals">
            <div>
              <span>Sous-total avant remise</span>
              <strong>{formatMoney(totals.subtotalCents)}</strong>
            </div>
            {totals.discountCents ? (
              <div>
                <span>Remises</span>
                <strong>− {formatMoney(totals.discountCents)}</strong>
              </div>
            ) : null}
            <div>
              <span>Total net</span>
              <strong>{formatMoney(totals.netCents)}</strong>
            </div>
            {settings.organization.vatRegistered ? (
              vatGroups.map((group) => (
                <div key={group.rateBp}>
                  <span>
                    TVA {(group.rateBp / 100).toLocaleString('fr-CH')} % sur{' '}
                    {formatMoney(group.baseCents)}
                  </span>
                  <strong>{formatMoney(group.vatCents)}</strong>
                </div>
              ))
            ) : (
              <div>
                <span>TVA</span>
                <strong>Non assujetti</strong>
              </div>
            )}
            <div className="print-totals__grand">
              <span>
                {invoice.type === 'credit_note'
                  ? 'Total de l’avoir'
                  : invoice.type === 'deposit'
                    ? invoice.depositPercentageBp
                      ? `Acompte ${(invoice.depositPercentageBp / 100).toLocaleString('fr-CH')} % · total TTC`
                      : 'Acompte · total TTC'
                  : 'Total TTC'}
              </span>
              <strong>{formatMoney(totals.totalCents)}</strong>
            </div>
          </div>
          <footer className="print-footer">
            <p>{invoice.notes}</p>
            <p>
              {invoice.type === 'credit_note'
                ? 'Cet avoir réduit la créance; aucun paiement ne doit être enregistré.'
                : settings.billing.defaultFooter}
            </p>
          </footer>
        </div>
        {qr ? <SwissQrPaymentSection input={qr.input} payload={qr} /> : null}
      </article>
    </div>
  );
}

function SwissQrPaymentSection({
  input,
  payload,
}: {
  input: SwissQrBillInput;
  payload: SwissQrPayload;
}) {
  const amount =
    input.amountCents === undefined
      ? ''
      : `${Math.trunc(input.amountCents / 100)
          .toString()
          .replace(
            /\B(?=(\d{3})+(?!\d))/g,
            ' ',
          )}.${String(Math.abs(input.amountCents) % 100).padStart(2, '0')}`;
  const groupedIban = input.iban
    .replace(/\s/g, '')
    .replace(/(.{4})/g, '$1 ')
    .trim();
  const groupedReference =
    input.referenceType === 'QRR'
      ? [
          input.reference.slice(0, 2),
          ...(input.reference.slice(2).match(/.{1,5}/g) ?? []),
        ]
          .filter(Boolean)
          .join(' ')
      : (input.reference
          .replace(/\s/g, '')
          .match(/.{1,4}/g)
          ?.join(' ') ?? '');
  const address = (party: SwissQrBillInput['creditor']) => (
    <>
      {party.name}
      <br />
      {party.street} {party.buildingNumber}
      <br />
      {party.postalCode} {party.city}
      <br />
      {party.country}
    </>
  );
  const extraInformation = [
    input.unstructuredMessage,
    input.billInformation,
  ].filter(Boolean);
  return (
    <section className="swiss-qr-section">
      <div className="qr-separator">
        <span>✂</span>
      </div>
      <section className="qr-receipt">
        <h2>Récépissé</h2>
        <div className="qr-copy">
          <strong>Compte / Payable à</strong>
          <p>
            {groupedIban}
            <br />
            {address(input.creditor)}
          </p>
        </div>
        {groupedReference ? (
          <div className="qr-copy">
            <strong>Référence</strong>
            <p>{groupedReference}</p>
          </div>
        ) : null}
        {input.debtor ? (
          <div className="qr-copy">
            <strong>Payable par</strong>
            <p>{address(input.debtor)}</p>
          </div>
        ) : null}
        <div className="qr-amount-small">
          <span>
            Monnaie
            <br />
            <strong>{input.currency}</strong>
          </span>
          <span>
            Montant
            <br />
            <strong>{amount}</strong>
          </span>
        </div>
        <strong className="qr-acceptance">Point de dépôt</strong>
      </section>
      <span className="qr-vertical-separator" aria-hidden="true">
        ✂
      </span>
      <section className="qr-payment">
        <h2>Section paiement</h2>
        <div className="qr-payment-grid">
          <div className="qr-code-wrap">
            <QRCodeSVG
              value={payload.payload}
              level="M"
              size={174}
              marginSize={0}
            />
            <span className="swiss-cross" aria-hidden="true">
              <i />
              <b />
            </span>
          </div>
          <div>
            <div className="qr-copy">
              <strong>Compte / Payable à</strong>
              <p>
                {groupedIban}
                <br />
                {address(input.creditor)}
              </p>
            </div>
            {groupedReference ? (
              <div className="qr-copy">
                <strong>Référence</strong>
                <p>{groupedReference}</p>
              </div>
            ) : null}
            {extraInformation.length ? (
              <div className="qr-copy">
                <strong>Informations supplémentaires</strong>
                <p>
                  {extraInformation.map((value, index) => (
                    <span key={`${value}-${index}`}>
                      {index ? <br /> : null}
                      {value}
                    </span>
                  ))}
                </p>
              </div>
            ) : null}
            {input.debtor ? (
              <div className="qr-copy">
                <strong>Payable par</strong>
                <p>{address(input.debtor)}</p>
              </div>
            ) : null}
          </div>
        </div>
        <div className="qr-amount">
          <span>
            Monnaie
            <br />
            <strong>{input.currency}</strong>
          </span>
          <span>
            Montant
            <br />
            <strong>{amount}</strong>
          </span>
        </div>
      </section>
    </section>
  );
}
