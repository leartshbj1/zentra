import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import {
  Archive,
  ArrowRight,
  Banknote,
  BarChart3,
  Bell,
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
  LayoutDashboard,
  Menu,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  Printer,
  Receipt,
  RefreshCw,
  Search,
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
import type {
  AppSettings,
  Client,
  DocumentLine,
  Employee,
  EntityKind,
  Expense,
  Invoice,
  Payment,
  Payslip,
  PayslipLine,
  Project,
  Quote,
  TimeEntry,
  Workspace,
} from './types';
import {
  addDaysIso,
  centsFromInput,
  createId,
  documentTotals,
  formatDate,
  formatDateTime,
  formatMinutes,
  formatMoney,
  formatTimer,
  invoicePaid,
  numberFromInput,
  payslipTotals,
  projectFinancials,
  searchText,
  todayIso,
} from './utils';
import { Button, EmptyState, ErrorPanel, Field, FormActions, Modal, SectionHeading, StatusBadge, submitForm } from './ui';

type View = 'dashboard' | 'projects' | 'clients' | 'quotes' | 'invoices' | 'time' | 'team' | 'expenses' | 'reports' | 'settings';
type ModalState =
  | { type: 'client'; item?: Client }
  | { type: 'project'; item?: Project }
  | { type: 'document'; entity: 'quotes' | 'invoices'; item?: Quote | Invoice; quoteSource?: Quote }
  | { type: 'time'; item?: TimeEntry }
  | { type: 'employee'; item?: Employee }
  | { type: 'expense'; item?: Expense }
  | { type: 'payslip'; item?: Payslip }
  | { type: 'payment'; invoice: Invoice }
  | { type: 'timer' }
  | null;

type PrintTarget = { entity: 'quotes'; value: Quote } | { entity: 'invoices'; value: Invoice } | { entity: 'payslips'; value: Payslip } | null;

const navigation: Array<{ id: View; label: string; icon: typeof LayoutDashboard; group?: string }> = [
  { id: 'dashboard', label: 'Tableau de bord', icon: LayoutDashboard },
  { id: 'projects', label: 'Chantiers', icon: FolderKanban },
  { id: 'clients', label: 'Clients', icon: UserRound },
  { id: 'quotes', label: 'Devis', icon: FileCheck2, group: 'Gestion' },
  { id: 'invoices', label: 'Factures', icon: Receipt },
  { id: 'time', label: 'Temps', icon: Clock3 },
  { id: 'team', label: 'Équipe & salaires', icon: Users },
  { id: 'expenses', label: 'Dépenses', icon: WalletCards },
  { id: 'reports', label: 'Rapports', icon: BarChart3, group: 'Pilotage' },
  { id: 'settings', label: 'Paramètres', icon: Settings },
];

const viewTitles: Record<View, [string, string]> = {
  dashboard: ['Tableau de bord', 'Votre activité réelle, sans données de démonstration'],
  projects: ['Chantiers', 'Budget, durée, temps et rentabilité par chantier'],
  clients: ['Clients', 'Coordonnées et historique des travaux'],
  quotes: ['Devis', 'Offres, lignes détaillées et conversion en facture'],
  invoices: ['Factures', 'Émission, encaissements et soldes ouverts'],
  time: ['Temps', 'Pointage réel et heures par chantier'],
  team: ['Équipe & salaires', 'Collaborateurs et fiches sans retenue estimée'],
  expenses: ['Dépenses', 'Achats et coûts réellement engagés'],
  reports: ['Rapports', 'Rentabilité calculée à partir de vos saisies'],
  settings: ['Paramètres', 'Entreprise, confidentialité et portabilité'],
};

export function WorkspaceApp({ workspace, setWorkspace }: { workspace: Workspace; setWorkspace: Dispatch<SetStateAction<Workspace | null>> }) {
  const [view, setView] = useState<View>('dashboard');
  const [modal, setModal] = useState<ModalState>(null);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [timerSeconds, setTimerSeconds] = useState(0);
  const [printTarget, setPrintTarget] = useState<PrintTarget>(null);
  const settings = workspace.settings!;

  useEffect(() => {
    if (!workspace.activeTimer) { setTimerSeconds(0); return; }
    const update = () => setTimerSeconds(Math.max(0, Math.floor((Date.now() - new Date(workspace.activeTimer!.startedAt).getTime()) / 1000)));
    update();
    const interval = window.setInterval(update, 1000);
    return () => window.clearInterval(interval);
  }, [workspace.activeTimer]);

  useEffect(() => {
    if (!printTarget) return;
    const timeout = window.setTimeout(() => window.print(), 80);
    return () => window.clearTimeout(timeout);
  }, [printTarget]);

  async function act(action: () => Promise<Workspace>, message: string, close = true) {
    setBusy(true);
    setNotice(null);
    try {
      setWorkspace(await action());
      setNotice({ tone: 'success', text: message });
      if (close) setModal(null);
      return true;
    } catch (reason) {
      setNotice({ tone: 'error', text: reason instanceof Error ? reason.message : 'L’action locale a échoué.' });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function archive(entity: EntityKind, id: string, label: string) {
    if (!window.confirm(`Supprimer « ${label} » de l’espace local ? Cette action ne peut pas être annulée.`)) return;
    await act(() => desktopApi.archiveEntity(entity, id), `${label} a été supprimé.`, false);
  }

  const overdue = workspace.invoices.filter((invoice) => invoice.status === 'issued' && invoice.dueDate && invoice.dueDate < todayIso());
  const title = viewTitles[view];
  const timerProject = workspace.projects.find((project) => project.id === workspace.activeTimer?.projectId);
  const timerEmployee = workspace.employees.find((employee) => employee.id === workspace.activeTimer?.employeeId);

  return (
    <div className="desktop-app">
      <aside className={`sidebar ${menuOpen ? 'is-open' : ''}`}>
        <div className="sidebar__brand"><span><HardHat size={21} /></span><div><strong>HelviChantier</strong><small>Gestion locale</small></div><Button variant="ghost" size="icon" className="sidebar__close" onClick={() => setMenuOpen(false)}><X size={18} /></Button></div>
        <nav className="sidebar__nav">
          {navigation.map((item, index) => { const Icon = item.icon; return <div key={item.id}>{item.group ? <p>{item.group}</p> : null}<button className={view === item.id ? 'is-active' : ''} onClick={() => { setView(item.id); setSearch(''); setMenuOpen(false); }}><Icon size={17} /><span>{item.label}</span>{item.id === 'invoices' && overdue.length ? <em>{overdue.length}</em> : null}</button>{index === 2 ? <div className="sidebar__divider" /> : null}</div>; })}
        </nav>
        <div className="sidebar__local"><ShieldCheck size={17} /><div><strong>Données locales</strong><span>Sur cet ordinateur</span></div><i /></div>
        <div className="sidebar__plan"><span>Abonnement</span><strong>50 CHF <small>/ mois</small></strong><p>Vos données restent accessibles et exportables.</p></div>
      </aside>

      <main className="app-main">
        <header className="topbar">
          <div className="topbar__title"><Button variant="ghost" size="icon" className="menu-button" onClick={() => setMenuOpen(true)}><Menu size={20} /></Button><div><p>HelviChantier local</p><h1>{title[0]}</h1></div></div>
          <div className="topbar__tools"><label className="global-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Rechercher dans cette vue" /></label><button className="notification-button" aria-label="Notifications"><Bell size={18} />{overdue.length ? <span /> : null}</button><div className="company-avatar">{settings.organization.legalName.slice(0, 2).toUpperCase()}</div></div>
        </header>

        {workspace.activeTimer ? <div className="timer-ribbon"><span className="timer-ribbon__pulse" /><div><strong>Pointage en cours · {formatTimer(timerSeconds)}</strong><small>{timerProject?.name ?? 'Chantier'}{timerEmployee ? ` · ${timerEmployee.name}` : ''}</small></div><Button variant="dark" size="small" disabled={busy} onClick={() => void act(() => desktopApi.stopTimer(), 'Le pointage a été arrêté et enregistré.', false)}><Pause size={15} /> Arrêter</Button></div> : null}

        <div className="page-header"><div><p>{title[1]}</p></div><div className="page-header__actions">{view === 'dashboard' ? <Button variant="secondary" onClick={() => setModal({ type: 'timer' })}><Play size={16} /> Démarrer un pointage</Button> : null}{view !== 'settings' && view !== 'reports' && view !== 'dashboard' ? <CreateButton view={view} onClick={setModal} /> : null}</div></div>
        {notice ? <div className={`notice notice--${notice.tone}`}><span>{notice.tone === 'success' ? <CheckCircle2 size={18} /> : <ShieldCheck size={18} />}{notice.text}</span><button onClick={() => setNotice(null)}><X size={15} /></button></div> : null}

        <section className="page-content">
          {view === 'dashboard' ? <Dashboard workspace={workspace} onNavigate={setView} onCreate={setModal} /> : null}
          {view === 'projects' ? <ProjectsScreen workspace={workspace} query={search} onEdit={(item) => setModal({ type: 'project', item })} onCreate={() => setModal({ type: 'project' })} onArchive={(item) => void archive('projects', item.id, item.name)} /> : null}
          {view === 'clients' ? <ClientsScreen workspace={workspace} query={search} onEdit={(item) => setModal({ type: 'client', item })} onCreate={() => setModal({ type: 'client' })} onArchive={(item) => void archive('clients', item.id, item.company || item.name)} /> : null}
          {view === 'quotes' ? <DocumentsScreen entity="quotes" workspace={workspace} query={search} busy={busy} onEdit={(item) => setModal({ type: 'document', entity: 'quotes', item })} onCreate={() => setModal({ type: 'document', entity: 'quotes' })} onIssue={(item) => void act(() => desktopApi.issueDocument('quotes', item.id, item.issueDate, item.validUntil), 'Le devis a été émis et numéroté.', false)} onConvert={(item) => void act(() => desktopApi.convertQuote(item), 'Une facture brouillon a été créée à partir du devis.', false)} onPrint={(item) => setPrintTarget({ entity: 'quotes', value: item })} onArchive={(item) => void archive('quotes', item.id, item.title)} /> : null}
          {view === 'invoices' ? <DocumentsScreen entity="invoices" workspace={workspace} query={search} busy={busy} onEdit={(item) => setModal({ type: 'document', entity: 'invoices', item })} onCreate={() => setModal({ type: 'document', entity: 'invoices' })} onIssue={(item) => void act(() => desktopApi.issueDocument('invoices', item.id, item.issueDate, item.dueDate), 'La facture a été émise et numérotée.', false)} onPayment={(item) => setModal({ type: 'payment', invoice: item })} onPrint={(item) => setPrintTarget({ entity: 'invoices', value: item })} onArchive={(item) => void archive('invoices', item.id, item.title)} /> : null}
          {view === 'time' ? <TimeScreen workspace={workspace} query={search} onCreate={() => setModal({ type: 'time' })} onEdit={(item) => setModal({ type: 'time', item })} onTimer={() => setModal({ type: 'timer' })} onArchive={(item) => void archive('timeEntries', item.id, `Pointage du ${formatDate(item.date)}`)} /> : null}
          {view === 'team' ? <TeamScreen workspace={workspace} query={search} onCreateEmployee={() => setModal({ type: 'employee' })} onEditEmployee={(item) => setModal({ type: 'employee', item })} onCreatePayslip={() => setModal({ type: 'payslip' })} onEditPayslip={(item) => setModal({ type: 'payslip', item })} onPrint={(item) => setPrintTarget({ entity: 'payslips', value: item })} onArchiveEmployee={(item) => void archive('employees', item.id, item.name)} onArchivePayslip={(item) => void archive('payslips', item.id, `Fiche ${item.period}`)} /> : null}
          {view === 'expenses' ? <ExpensesScreen workspace={workspace} query={search} onCreate={() => setModal({ type: 'expense' })} onEdit={(item) => setModal({ type: 'expense', item })} onArchive={(item) => void archive('expenses', item.id, item.supplier)} /> : null}
          {view === 'reports' ? <ReportsScreen workspace={workspace} /> : null}
          {view === 'settings' ? <SettingsScreen workspace={workspace} busy={busy} setBusy={setBusy} onWorkspace={setWorkspace} onNotice={setNotice} /> : null}
        </section>
      </main>

      {modal ? <WorkspaceModal state={modal} workspace={workspace} busy={busy} close={() => setModal(null)} act={act} /> : null}
      {printTarget ? <PrintSheet target={printTarget} workspace={workspace} onClose={() => setPrintTarget(null)} /> : null}
    </div>
  );
}

function CreateButton({ view, onClick }: { view: View; onClick: Dispatch<SetStateAction<ModalState>> }) {
  const map: Partial<Record<View, [string, ModalState]>> = {
    projects: ['Nouveau chantier', { type: 'project' }], clients: ['Nouveau client', { type: 'client' }], quotes: ['Nouveau devis', { type: 'document', entity: 'quotes' }], invoices: ['Nouvelle facture', { type: 'document', entity: 'invoices' }], time: ['Saisir des heures', { type: 'time' }], team: ['Nouveau collaborateur', { type: 'employee' }], expenses: ['Nouvelle dépense', { type: 'expense' }],
  };
  const current = map[view];
  return current ? <Button onClick={() => onClick(current[1])}><Plus size={16} /> {current[0]}</Button> : null;
}

function Dashboard({ workspace, onNavigate, onCreate }: { workspace: Workspace; onNavigate: (view: View) => void; onCreate: Dispatch<SetStateAction<ModalState>> }) {
  const issued = workspace.invoices.filter((invoice) => invoice.status !== 'draft' && invoice.status !== 'cancelled');
  const invoiced = issued.reduce((total, invoice) => total + documentTotals(invoice.lines).totalCents, 0);
  const paid = issued.reduce((total, invoice) => total + invoicePaid(invoice.id, workspace.payments), 0);
  const minutes = workspace.timeEntries.reduce((total, entry) => total + entry.minutes, 0);
  const activeProjects = workspace.projects.filter((project) => ['in_progress', 'paused'].includes(project.status));
  const hasActivity = workspace.clients.length || workspace.projects.length || workspace.quotes.length || workspace.invoices.length || workspace.timeEntries.length;
  if (!hasActivity) return <FirstUseDashboard onCreate={onCreate} />;
  return (
    <div className="dashboard-grid">
      <div className="metric-grid">
        <MetricCard label="Facturé TTC" value={issued.length ? formatMoney(invoiced) : '—'} note={issued.length ? `${issued.length} facture${issued.length > 1 ? 's' : ''} émise${issued.length > 1 ? 's' : ''}` : 'Aucune facture émise'} icon={<CircleDollarSign />} tone="green" />
        <MetricCard label="Encaissé" value={workspace.payments.length ? formatMoney(paid) : '—'} note={workspace.payments.length ? `${workspace.payments.length} paiement${workspace.payments.length > 1 ? 's' : ''}` : 'Aucun paiement enregistré'} icon={<Banknote />} tone="amber" />
        <MetricCard label="Solde ouvert" value={issued.length ? formatMoney(Math.max(0, invoiced - paid)) : '—'} note={issued.length ? 'Sur les factures émises' : 'Pas encore calculable'} icon={<TrendingUp />} tone="blue" />
        <MetricCard label="Temps saisi" value={workspace.timeEntries.length ? formatMinutes(minutes) : '—'} note={workspace.timeEntries.length ? `${workspace.timeEntries.length} saisie${workspace.timeEntries.length > 1 ? 's' : ''}` : 'Aucune heure saisie'} icon={<Clock3 />} tone="violet" />
      </div>
      <section className="panel panel--span"><SectionHeading eyebrow="En cours" title="Chantiers actifs" action={<Button variant="ghost" size="small" onClick={() => onNavigate('projects')}>Tous les chantiers <ArrowRight size={15} /></Button>} />{activeProjects.length ? <div className="dashboard-projects">{activeProjects.slice(0, 4).map((project) => { const client = workspace.clients.find((item) => item.id === project.clientId); const stats = projectFinancials(project, workspace.invoices, workspace.payments, workspace.timeEntries, workspace.expenses); return <article key={project.id}><div className="project-icon"><HardHat size={18} /></div><div className="dashboard-projects__name"><strong>{project.name}</strong><span>{client?.company || client?.name || 'Client non renseigné'}</span></div><div><small>Facturé</small><strong>{stats.invoicedTotal ? formatMoney(stats.invoicedTotal) : '—'}</strong></div><div><small>Temps réel</small><strong>{stats.minutes ? formatMinutes(stats.minutes) : '—'}</strong></div><StatusBadge status={project.status} /></article>; })}</div> : <EmptyState title="Aucun chantier actif" text="Les chantiers planifiés ou terminés restent accessibles dans la liste complète." />}</section>
      <section className="panel"><SectionHeading eyebrow="À traiter" title="Échéances" />{workspace.invoices.filter((invoice) => invoice.status === 'issued').length ? <div className="deadline-list">{workspace.invoices.filter((invoice) => invoice.status === 'issued').slice(0, 5).map((invoice) => <button key={invoice.id} onClick={() => onNavigate('invoices')}><span><Receipt size={16} /></span><div><strong>{invoice.number || 'Facture non numérotée'}</strong><small>{invoice.title}</small></div><em>{formatDate(invoice.dueDate)}</em></button>)}</div> : <div className="compact-empty"><CheckCircle2 size={20} /><span>Aucune facture émise en attente.</span></div>}</section>
      <section className="panel"><SectionHeading eyebrow="Accès rapide" title="Nouvelle saisie" /><div className="quick-actions"><button onClick={() => onCreate({ type: 'client' })}><UserRound /><span>Client</span></button><button onClick={() => onCreate({ type: 'project' })}><HardHat /><span>Chantier</span></button><button onClick={() => onCreate({ type: 'document', entity: 'quotes' })}><FileCheck2 /><span>Devis</span></button><button onClick={() => onCreate({ type: 'expense' })}><WalletCards /><span>Dépense</span></button></div></section>
    </div>
  );
}

function FirstUseDashboard({ onCreate }: { onCreate: Dispatch<SetStateAction<ModalState>> }) {
  return <div className="first-dashboard"><div className="first-dashboard__hero"><span><Building2 size={30} /></span><div><p className="eyebrow">Espace prêt</p><h2>Commencez avec vos vraies données.</h2><p>Votre configuration est enregistrée. Aucune activité fictive n’a été ajoutée.</p><Button size="large" onClick={() => onCreate({ type: 'client' })}><Plus size={17} /> Ajouter mon premier client</Button></div></div><div className="first-dashboard__steps"><article><em>1</em><div><strong>Ajoutez un client</strong><p>Identité et coordonnées de facturation.</p></div></article><article><em>2</em><div><strong>Créez son chantier</strong><p>Budget, calendrier et temps prévu.</p></div></article><article><em>3</em><div><strong>Établissez le devis</strong><p>Lignes, TVA explicite et validité.</p></div></article><article><em>4</em><div><strong>Suivez le réel</strong><p>Heures, dépenses, factures et encaissements.</p></div></article></div></div>;
}

function MetricCard({ label, value, note, icon, tone }: { label: string; value: string; note: string; icon: React.ReactNode; tone: string }) { return <article className={`metric-card metric-card--${tone}`}><div className="metric-card__icon">{icon}</div><div><span>{label}</span><strong>{value}</strong><small>{note}</small></div></article>; }

function ProjectsScreen({ workspace, query, onEdit, onCreate, onArchive }: { workspace: Workspace; query: string; onEdit: (item: Project) => void; onCreate: () => void; onArchive: (item: Project) => void }) {
  const projects = workspace.projects.filter((project) => searchText([project.name, project.address, workspace.clients.find((client) => client.id === project.clientId)?.name], query));
  if (!workspace.projects.length) return <EmptyState icon={<FolderKanban />} title="Aucun chantier" text={workspace.clients.length ? 'Créez votre premier chantier à partir d’un client réel.' : 'Ajoutez d’abord un client, puis créez son chantier.'} actionLabel={workspace.clients.length ? 'Créer un chantier' : 'Ajoutez d’abord un client'} onAction={onCreate} disabled={!workspace.clients.length} />;
  return <div className="project-card-grid">{projects.map((project) => { const client = workspace.clients.find((item) => item.id === project.clientId); const stats = projectFinancials(project, workspace.invoices, workspace.payments, workspace.timeEntries, workspace.expenses); return <article className="project-card" key={project.id}><header><div className="project-card__icon"><HardHat size={20} /></div><div><h3>{project.name}</h3><p>{client?.company || client?.name || 'Client non renseigné'}</p></div><StatusBadge status={project.status} /></header><p className="project-card__address">{project.address || 'Adresse non renseignée'}</p><div className="project-stats"><div><span>Facturé TTC</span><strong>{stats.invoicedTotal ? formatMoney(stats.invoicedTotal) : '—'}</strong></div><div><span>Temps réel</span><strong>{stats.minutes ? formatMinutes(stats.minutes) : '—'}</strong></div><div><span>Marge nette saisie</span><strong>{stats.invoicedNet || stats.laborCost || stats.expenseNet ? formatMoney(stats.margin) : '—'}</strong></div></div><div className="project-dates"><span><CalendarDays size={14} /> Prévu : {formatDate(project.plannedStart)} → {formatDate(project.plannedEnd)}</span><span>Réel : {formatDate(project.actualStart)} → {formatDate(project.actualEnd)}</span></div><footer><Button variant="secondary" size="small" onClick={() => onEdit(project)}><Pencil size={14} /> Modifier</Button><Button variant="ghost" size="small" onClick={() => onArchive(project)}><Archive size={14} /> Supprimer</Button></footer></article>; })}{!projects.length ? <div className="panel panel--span"><EmptyState title="Aucun résultat" text="Modifiez votre recherche pour retrouver un chantier." /></div> : null}</div>;
}

function ClientsScreen({ workspace, query, onEdit, onCreate, onArchive }: { workspace: Workspace; query: string; onEdit: (item: Client) => void; onCreate: () => void; onArchive: (item: Client) => void }) {
  const clients = workspace.clients.filter((client) => searchText([client.name, client.company, client.email, client.phone, client.address], query));
  if (!workspace.clients.length) return <EmptyState icon={<UserRound />} title="Aucun client" text="Ajoutez votre premier client. Aucun contact d’exemple n’est créé automatiquement." actionLabel="Ajouter un client" onAction={onCreate} />;
  return <div className="panel table-panel"><table><thead><tr><th>Client</th><th>Coordonnées</th><th>Adresse</th><th>Chantiers</th><th aria-label="Actions" /></tr></thead><tbody>{clients.map((client) => <tr key={client.id}><td><div className="identity-cell"><span>{(client.company || client.name).slice(0, 2).toUpperCase()}</span><div><strong>{client.company || client.name}</strong>{client.company && client.name ? <small>{client.name}</small> : null}</div></div></td><td><strong className="table-subtle">{client.email || '—'}</strong><small>{client.phone || '—'}</small></td><td><span className="address-cell">{client.address || '—'}</span></td><td><span className="count-pill">{workspace.projects.filter((project) => project.clientId === client.id).length}</span></td><td><div className="row-actions"><Button variant="ghost" size="icon" onClick={() => onEdit(client)}><Pencil size={15} /></Button><Button variant="ghost" size="icon" onClick={() => onArchive(client)}><Archive size={15} /></Button></div></td></tr>)}</tbody></table>{!clients.length ? <EmptyState title="Aucun résultat" text="Aucun client ne correspond à cette recherche." /> : null}</div>;
}

type DocumentsProps =
  | { entity: 'quotes'; workspace: Workspace; query: string; busy: boolean; onEdit: (item: Quote) => void; onCreate: () => void; onIssue: (item: Quote) => void; onConvert: (item: Quote) => void; onPrint: (item: Quote) => void; onArchive: (item: Quote) => void; onPayment?: never }
  | { entity: 'invoices'; workspace: Workspace; query: string; busy: boolean; onEdit: (item: Invoice) => void; onCreate: () => void; onIssue: (item: Invoice) => void; onPayment: (item: Invoice) => void; onPrint: (item: Invoice) => void; onArchive: (item: Invoice) => void; onConvert?: never };

function DocumentsScreen(props: DocumentsProps) {
  const { entity, workspace, query, busy, onCreate } = props;
  const documents = entity === 'quotes' ? workspace.quotes : workspace.invoices;
  const filtered = documents.filter((document) => searchText([document.number, document.title, workspace.clients.find((client) => client.id === document.clientId)?.name], query));
  if (!documents.length) {
    const hasClients = workspace.clients.length > 0;
    return <EmptyState icon={entity === 'quotes' ? <FileCheck2 /> : <Receipt />} title={entity === 'quotes' ? 'Aucun devis' : 'Aucune facture'} text={hasClients ? `Créez ${entity === 'quotes' ? 'un devis' : 'une facture'} avec vos propres lignes et montants.` : 'Ajoutez d’abord un client pour créer un document.'} actionLabel={hasClients ? entity === 'quotes' ? 'Créer un devis' : 'Créer une facture' : 'Ajoutez d’abord un client'} onAction={onCreate} disabled={!hasClients} />;
  }
  return <div className="panel table-panel"><table><thead><tr><th>Document</th><th>Client</th><th>Date</th><th>Montant TTC</th>{entity === 'invoices' ? <th>Encaissé</th> : null}<th>Statut</th><th aria-label="Actions" /></tr></thead><tbody>{filtered.map((item) => { const client = workspace.clients.find((candidate) => candidate.id === item.clientId); const totals = documentTotals(item.lines); const paid = entity === 'invoices' ? invoicePaid(item.id, workspace.payments) : 0; return <tr key={item.id}><td><div className="document-cell"><span>{entity === 'quotes' ? <FileCheck2 size={16} /> : <Receipt size={16} />}</span><div><strong>{item.number || 'Numéro attribué à l’émission'}</strong><small>{item.title}</small></div></div></td><td><strong className="table-subtle">{client?.company || client?.name || '—'}</strong></td><td><span>{formatDate(item.issueDate)}</span><small>{entity === 'quotes' ? `Valable au ${formatDate((item as Quote).validUntil)}` : `Échéance ${formatDate((item as Invoice).dueDate)}`}</small></td><td><strong>{formatMoney(totals.totalCents)}</strong></td>{entity === 'invoices' ? <td><strong>{paid ? formatMoney(paid) : '—'}</strong></td> : null}<td><StatusBadge status={item.status} /></td><td><div className="document-actions"><Button variant="ghost" size="icon" onClick={() => entity === 'quotes' ? props.onEdit(item as Quote) : props.onEdit(item as Invoice)} title="Modifier"><Pencil size={15} /></Button>{item.status === 'draft' ? <Button variant="ghost" size="icon" disabled={busy || !item.lines.length} onClick={() => entity === 'quotes' ? props.onIssue(item as Quote) : props.onIssue(item as Invoice)} title="Émettre"><CheckCircle2 size={16} /></Button> : null}{entity === 'quotes' && ['issued', 'accepted'].includes(item.status) ? <Button variant="ghost" size="icon" disabled={busy} onClick={() => props.onConvert(item as Quote)} title="Convertir en facture"><ArrowRight size={16} /></Button> : null}{entity === 'invoices' && item.status !== 'draft' && item.status !== 'paid' && item.status !== 'cancelled' ? <Button variant="ghost" size="icon" onClick={() => props.onPayment(item as Invoice)} title="Enregistrer un paiement"><Banknote size={16} /></Button> : null}{item.status !== 'draft' ? <Button variant="ghost" size="icon" onClick={() => entity === 'quotes' ? props.onPrint(item as Quote) : props.onPrint(item as Invoice)} title="Imprimer"><Printer size={15} /></Button> : null}<Button variant="ghost" size="icon" onClick={() => entity === 'quotes' ? props.onArchive(item as Quote) : props.onArchive(item as Invoice)} title="Supprimer"><Archive size={15} /></Button></div></td></tr>; })}</tbody></table>{!filtered.length ? <EmptyState title="Aucun résultat" text="Aucun document ne correspond à cette recherche." /> : null}</div>;
}

function TimeScreen({ workspace, query, onCreate, onEdit, onTimer, onArchive }: { workspace: Workspace; query: string; onCreate: () => void; onEdit: (item: TimeEntry) => void; onTimer: () => void; onArchive: (item: TimeEntry) => void }) {
  const entries = workspace.timeEntries.filter((entry) => searchText([entry.note, workspace.projects.find((project) => project.id === entry.projectId)?.name, workspace.employees.find((employee) => employee.id === entry.employeeId)?.name], query));
  const totalMinutes = entries.reduce((total, entry) => total + entry.minutes, 0);
  const totalCost = entries.reduce((total, entry) => total + Math.round((entry.minutes * entry.hourlyCostCents) / 60), 0);
  const canTrack = workspace.projects.length > 0 && workspace.employees.length > 0;
  return <div className="stack-layout"><section className="time-hero"><div className="time-hero__icon"><TimerReset size={28} /></div><div><p className="eyebrow">Chronomètre local</p><h2>{workspace.activeTimer ? 'Un pointage est déjà en cours' : 'Mesurez le temps réellement passé.'}</h2><p>{workspace.activeTimer ? 'Arrêtez-le depuis la barre supérieure pour enregistrer la durée.' : canTrack ? 'Choisissez un chantier et un collaborateur. Le pointage continue tant que l’application reste active.' : 'Ajoutez au moins un chantier et un collaborateur pour utiliser le chronomètre.'}</p></div><Button size="large" onClick={onTimer} disabled={!canTrack || Boolean(workspace.activeTimer)}><Play size={17} /> Démarrer</Button></section><div className="summary-strip"><div><span>Temps affiché</span><strong>{entries.length ? formatMinutes(totalMinutes) : '—'}</strong></div><div><span>Coût de main-d’œuvre</span><strong>{entries.length ? formatMoney(totalCost) : '—'}</strong></div><div><span>Saisies</span><strong>{entries.length || '—'}</strong></div></div>{workspace.timeEntries.length ? <div className="panel table-panel"><table><thead><tr><th>Date</th><th>Chantier</th><th>Collaborateur</th><th>Durée</th><th>Coût</th><th>Statut</th><th /></tr></thead><tbody>{entries.map((entry) => { const project = workspace.projects.find((item) => item.id === entry.projectId); const employee = workspace.employees.find((item) => item.id === entry.employeeId); return <tr key={entry.id}><td>{formatDate(entry.date)}</td><td><strong>{project?.name || '—'}</strong></td><td>{employee?.name || '—'}</td><td><strong>{formatMinutes(entry.minutes)}</strong></td><td>{formatMoney(Math.round((entry.minutes * entry.hourlyCostCents) / 60))}</td><td><StatusBadge status={entry.status} /></td><td><div className="row-actions"><Button variant="ghost" size="icon" onClick={() => onEdit(entry)}><Pencil size={15} /></Button><Button variant="ghost" size="icon" onClick={() => onArchive(entry)}><Archive size={15} /></Button></div></td></tr>; })}</tbody></table>{!entries.length ? <EmptyState title="Aucun résultat" text="Aucune saisie de temps ne correspond à la recherche." /> : null}</div> : <EmptyState icon={<Clock3 />} title="Aucune heure saisie" text={canTrack ? 'Démarrez un pointage ou saisissez une durée manuellement.' : 'Un chantier et un collaborateur sont nécessaires pour saisir du temps.'} actionLabel={canTrack ? 'Saisir des heures' : undefined} onAction={canTrack ? onCreate : undefined} />}</div>;
}

function TeamScreen({ workspace, query, onCreateEmployee, onEditEmployee, onCreatePayslip, onEditPayslip, onPrint, onArchiveEmployee, onArchivePayslip }: { workspace: Workspace; query: string; onCreateEmployee: () => void; onEditEmployee: (item: Employee) => void; onCreatePayslip: () => void; onEditPayslip: (item: Payslip) => void; onPrint: (item: Payslip) => void; onArchiveEmployee: (item: Employee) => void; onArchivePayslip: (item: Payslip) => void }) {
  const employees = workspace.employees.filter((employee) => searchText([employee.name, employee.role, employee.email], query));
  const payrollEnabled = workspace.settings?.payroll.enabled ?? false;
  return <div className="stack-layout"><SectionHeading title="Collaborateurs" description="Les coûts horaires sont utilisés uniquement lorsqu’ils ont été saisis." action={<Button onClick={onCreateEmployee}><Plus size={16} /> Nouveau collaborateur</Button>} />{workspace.employees.length ? <div className="employee-grid">{employees.map((employee) => <article className="employee-card" key={employee.id}><div className="employee-card__avatar">{employee.name.slice(0, 2).toUpperCase()}</div><div className="employee-card__main"><h3>{employee.name}</h3><p>{employee.role || 'Fonction non renseignée'}</p><div><span>Taux d’activité <strong>{employee.employmentRate ? `${employee.employmentRate} %` : '—'}</strong></span><span>Coût horaire <strong>{employee.hourlyCostCents ? formatMoney(employee.hourlyCostCents) : '—'}</strong></span></div></div><footer><StatusBadge status={employee.active ? 'validated' : 'incomplete'} /><Button variant="ghost" size="icon" onClick={() => onEditEmployee(employee)}><Pencil size={15} /></Button><Button variant="ghost" size="icon" onClick={() => onArchiveEmployee(employee)}><Archive size={15} /></Button></footer></article>)}</div> : <EmptyState icon={<Users />} title="Aucun collaborateur" text="Ajoutez uniquement les personnes réellement employées ou suivies." actionLabel="Ajouter un collaborateur" onAction={onCreateEmployee} />}
    <section className="panel payroll-panel"><SectionHeading eyebrow="Paie locale" title="Fiches de salaire" description="Aucune retenue n’est estimée. Chaque ligne doit être saisie explicitement." action={payrollEnabled && workspace.employees.length ? <Button variant="secondary" onClick={onCreatePayslip}><Plus size={16} /> Nouvelle fiche</Button> : null} />{!payrollEnabled ? <div className="warning-card"><ShieldCheck size={20} /><div><strong>Module désactivé</strong><p>Activez la paie dans Paramètres puis renseignez les organismes et taux contrôlés.</p></div></div> : !workspace.settings?.payroll.fiduciaryValidated ? <div className="warning-card"><ShieldCheck size={20} /><div><strong>Configuration à faire valider</strong><p>Les fiches restent incomplètes jusqu’à confirmation du contrôle par votre fiduciaire.</p></div></div> : null}{workspace.payslips.length ? <div className="payslip-list">{workspace.payslips.map((payslip) => { const employee = workspace.employees.find((item) => item.id === payslip.employeeId); const totals = payslipTotals(payslip); return <article key={payslip.id}><div><FileText size={17} /><span><strong>{employee?.name || 'Collaborateur'}</strong><small>Période {payslip.period}</small></span></div><div><small>Brut saisi</small><strong>{formatMoney(totals.earnings)}</strong></div><div><small>Net calculé</small><strong>{formatMoney(totals.net)}</strong></div><StatusBadge status={payslip.status} /><div className="row-actions"><Button variant="ghost" size="icon" onClick={() => onEditPayslip(payslip)}><Pencil size={15} /></Button>{payslip.status === 'validated' ? <Button variant="ghost" size="icon" onClick={() => onPrint(payslip)}><Printer size={15} /></Button> : null}<Button variant="ghost" size="icon" onClick={() => onArchivePayslip(payslip)}><Archive size={15} /></Button></div></article>; })}</div> : payrollEnabled ? <div className="compact-empty"><FileText size={20} /><span>Aucune fiche de salaire créée.</span></div> : null}</section></div>;
}

function ExpensesScreen({ workspace, query, onCreate, onEdit, onArchive }: { workspace: Workspace; query: string; onCreate: () => void; onEdit: (item: Expense) => void; onArchive: (item: Expense) => void }) {
  const expenses = workspace.expenses.filter((expense) => searchText([expense.supplier, expense.category, expense.note, workspace.projects.find((project) => project.id === expense.projectId)?.name], query));
  const total = expenses.reduce((sum, item) => sum + item.totalCents, 0);
  if (!workspace.expenses.length) return <EmptyState icon={<WalletCards />} title="Aucune dépense" text={workspace.projects.length ? 'Enregistrez uniquement les achats et coûts réellement engagés.' : 'Créez un chantier avant d’enregistrer une dépense.'} actionLabel={workspace.projects.length ? 'Enregistrer une dépense' : undefined} onAction={workspace.projects.length ? onCreate : undefined} />;
  return <div className="stack-layout"><div className="summary-strip"><div><span>Total TTC affiché</span><strong>{formatMoney(total)}</strong></div><div><span>TVA saisie</span><strong>{formatMoney(expenses.reduce((sum, item) => sum + item.vatCents, 0))}</strong></div><div><span>Nombre de dépenses</span><strong>{expenses.length}</strong></div></div><div className="panel table-panel"><table><thead><tr><th>Date</th><th>Fournisseur</th><th>Chantier</th><th>Catégorie</th><th>Net</th><th>TVA</th><th>TTC</th><th /></tr></thead><tbody>{expenses.map((expense) => <tr key={expense.id}><td>{formatDate(expense.date)}</td><td><strong>{expense.supplier}</strong><small>{expense.note || '—'}</small></td><td>{workspace.projects.find((project) => project.id === expense.projectId)?.name || '—'}</td><td><span className="category-pill">{expense.category}</span></td><td>{formatMoney(expense.netCents)}</td><td>{formatMoney(expense.vatCents)}</td><td><strong>{formatMoney(expense.totalCents)}</strong></td><td><div className="row-actions"><Button variant="ghost" size="icon" onClick={() => onEdit(expense)}><Pencil size={15} /></Button><Button variant="ghost" size="icon" onClick={() => onArchive(expense)}><Archive size={15} /></Button></div></td></tr>)}</tbody></table>{!expenses.length ? <EmptyState title="Aucun résultat" text="Aucune dépense ne correspond à la recherche." /> : null}</div></div>;
}

function ReportsScreen({ workspace }: { workspace: Workspace }) {
  if (!workspace.projects.length) return <EmptyState icon={<BarChart3 />} title="Aucun rapport disponible" text="Les rapports apparaissent après la création d’un chantier. Aucun graphique fictif n’est affiché." />;
  const rows = workspace.projects.map((project) => ({ project, stats: projectFinancials(project, workspace.invoices, workspace.payments, workspace.timeEntries, workspace.expenses) }));
  const withFinancialData = rows.filter((row) => row.stats.invoicedNet || row.stats.laborCost || row.stats.expenseNet);
  return <div className="stack-layout"><div className="report-callout"><BarChart3 size={24} /><div><strong>Calculs transparents</strong><p>Marge = facturation nette émise − coûts horaires saisis − dépenses nettes. Les brouillons sont exclus.</p></div></div>{withFinancialData.length ? <div className="report-grid">{withFinancialData.map(({ project, stats }) => <article className="report-card" key={project.id}><header><div><h3>{project.name}</h3><p>{formatMinutes(stats.minutes)} saisis</p></div><StatusBadge status={project.status} /></header><div className="report-card__figures"><div><span>Facturé net</span><strong>{formatMoney(stats.invoicedNet)}</strong></div><div><span>Main-d’œuvre</span><strong>{formatMoney(stats.laborCost)}</strong></div><div><span>Dépenses nettes</span><strong>{formatMoney(stats.expenseNet)}</strong></div></div><footer><span>Marge issue des saisies</span><strong className={stats.margin < 0 ? 'is-negative' : ''}>{formatMoney(stats.margin)}</strong></footer></article>)}</div> : <EmptyState title="Pas encore assez de données" text="Ajoutez une facture émise, des heures avec coût ou une dépense pour calculer la rentabilité. Aucun pourcentage n’est inventé." />}</div>;
}

function SettingsScreen({ workspace, busy, setBusy, onWorkspace, onNotice }: { workspace: Workspace; busy: boolean; setBusy: (value: boolean) => void; onWorkspace: Dispatch<SetStateAction<Workspace | null>>; onNotice: (value: { tone: 'success' | 'error'; text: string } | null) => void }) {
  const [settings, setSettings] = useState<AppSettings>(workspace.settings!);
  const org = settings.organization;
  const billing = settings.billing;

  async function execute(action: () => Promise<Workspace>, success: string) {
    setBusy(true); onNotice(null);
    try { const next = await action(); onWorkspace(next); setSettings(next.settings!); onNotice({ tone: 'success', text: success }); }
    catch (reason) { onNotice({ tone: 'error', text: reason instanceof Error ? reason.message : 'L’action locale a échoué.' }); }
    finally { setBusy(false); }
  }

  async function backup() {
    setBusy(true); onNotice(null);
    try { const result = await desktopApi.createBackup(settings.backup.folder || undefined); onWorkspace(result.workspace); onNotice({ tone: 'success', text: `Sauvegarde créée : ${result.path}` }); }
    catch (reason) { onNotice({ tone: 'error', text: reason instanceof Error ? reason.message : 'La sauvegarde n’a pas pu être créée.' }); }
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
    catch (reason) { onNotice({ tone: 'error', text: reason instanceof Error ? reason.message : 'L’export n’a pas pu être créé.' }); }
    finally { setBusy(false); }
  }

  return <div className="settings-layout"><section className="panel settings-card settings-card--wide"><SectionHeading eyebrow="Documents" title="Entreprise et facturation" description="Ces champs sont utilisés sur les documents officiels." /><form onSubmit={submitForm(async (form) => {
    const next: AppSettings = { ...settings, organization: { ...org, legalName: String(form.get('legalName')), legalForm: String(form.get('legalForm')), contactName: String(form.get('contactName')), email: String(form.get('email')), phone: String(form.get('phone')), uidNumber: String(form.get('uidNumber')), vatRegistered: form.get('vatRegistered') === 'on', address: { ...org.address, street: String(form.get('street')), postalCode: String(form.get('postalCode')), city: String(form.get('city')), canton: String(form.get('canton')), country: String(form.get('country')) } }, billing: { ...billing, iban: String(form.get('iban')), accountHolder: String(form.get('accountHolder')), quotePrefix: String(form.get('quotePrefix')), invoicePrefix: String(form.get('invoicePrefix')), paymentTermsDays: numberFromInput(form.get('paymentTermsDays')), quoteValidityDays: numberFromInput(form.get('quoteValidityDays')) } };
    setSettings(next); await execute(() => desktopApi.saveSettings(next), 'Les paramètres ont été enregistrés localement.');
  })}><div className="form-grid"><Field label="Raison sociale" required wide><input name="legalName" defaultValue={org.legalName} required /></Field><Field label="Forme juridique"><input name="legalForm" defaultValue={org.legalForm} /></Field><Field label="Responsable" required><input name="contactName" defaultValue={org.contactName} required /></Field><Field label="E-mail" required><input name="email" type="email" defaultValue={org.email} required /></Field><Field label="Téléphone"><input name="phone" defaultValue={org.phone} /></Field><Field label="Adresse" required wide><input name="street" defaultValue={org.address.street} required /></Field><Field label="NPA" required><input name="postalCode" defaultValue={org.address.postalCode} required /></Field><Field label="Localité" required><input name="city" defaultValue={org.address.city} required /></Field><Field label="Canton" required><input name="canton" defaultValue={org.address.canton} required /></Field><Field label="Pays" required><input name="country" defaultValue={org.address.country} required /></Field><Field label="IDE / UID"><input name="uidNumber" defaultValue={org.uidNumber} /></Field><label className="check-card"><input name="vatRegistered" type="checkbox" defaultChecked={org.vatRegistered} /><span><strong>Assujettie à la TVA</strong><small>Les taux restent ceux explicitement configurés.</small></span></label><Field label="IBAN" required wide><input name="iban" defaultValue={billing.iban} required /></Field><Field label="Titulaire du compte" required wide><input name="accountHolder" defaultValue={billing.accountHolder} required /></Field><Field label="Préfixe devis" required><input name="quotePrefix" defaultValue={billing.quotePrefix} required /></Field><Field label="Préfixe factures" required><input name="invoicePrefix" defaultValue={billing.invoicePrefix} required /></Field><Field label="Délai de paiement" required><input name="paymentTermsDays" type="number" min="1" defaultValue={billing.paymentTermsDays || ''} required /></Field><Field label="Validité des devis" required><input name="quoteValidityDays" type="number" min="1" defaultValue={billing.quoteValidityDays || ''} required /></Field></div><div className="form-actions"><Button type="submit" disabled={busy}>Enregistrer les paramètres</Button></div></form></section>
    <section className="panel settings-card"><SectionHeading eyebrow="Paie" title="Contrôle fiduciaire" /><label className="module-toggle module-toggle--compact"><input type="checkbox" checked={settings.payroll.enabled} onChange={(event) => setSettings((current) => ({ ...current, payroll: { ...current.payroll, enabled: event.target.checked } }))} /><span><Users size={19} /><strong>Module salaires</strong><small>{settings.payroll.enabled ? 'Activé' : 'Désactivé'}</small></span></label><label className="check-card"><input type="checkbox" checked={settings.payroll.fiduciaryValidated} onChange={(event) => setSettings((current) => ({ ...current, payroll: { ...current.payroll, fiduciaryValidated: event.target.checked } }))} /><span><strong>Configuration contrôlée</strong><small>Confirmez uniquement après validation par votre fiduciaire.</small></span></label><Button variant="secondary" disabled={busy} onClick={() => void execute(() => desktopApi.saveSettings(settings), 'La configuration de paie a été enregistrée.')}><CheckCircle2 size={16} /> Enregistrer l’état</Button></section>
    <section className="panel settings-card"><SectionHeading eyebrow="Protection" title="Sauvegardes manuelles" /><div className="security-status"><span><Database size={19} /></span><div><strong>Base locale</strong><p>Les données actives restent sur ce PC.</p></div><i /></div><div className="settings-actions"><Button disabled={busy} onClick={() => void backup()}><Download size={16} /> Créer une sauvegarde</Button><Button variant="secondary" disabled={busy} onClick={() => void restore()}><RefreshCw size={16} /> Restaurer</Button></div>{settings.backup.folder ? <p className="path-note"><FolderOpen size={14} /> {settings.backup.folder}</p> : <p className="path-note">Aucun dossier préféré configuré.</p>}</section>
    <section className="panel settings-card"><SectionHeading eyebrow="Portabilité" title="Vos données vous appartiennent" /><p className="settings-copy">L’export JSON contient vos données en clair. Conservez-le dans un emplacement protégé.</p><div className="settings-actions"><Button variant="secondary" disabled={busy} onClick={() => void exportJson()}><FileText size={16} /> Exporter en JSON</Button><Button variant="ghost" disabled={busy} onClick={() => void desktopApi.openDataFolder()}><FolderOpen size={16} /> Ouvrir le dossier local</Button></div></section>
  </div>;
}

function WorkspaceModal({ state, workspace, busy, close, act }: { state: Exclude<ModalState, null>; workspace: Workspace; busy: boolean; close: () => void; act: (action: () => Promise<Workspace>, message: string, close?: boolean) => Promise<boolean> }) {
  if (state.type === 'client') return <ClientForm item={state.item} busy={busy} close={close} act={act} />;
  if (state.type === 'project') return <ProjectForm item={state.item} workspace={workspace} busy={busy} close={close} act={act} />;
  if (state.type === 'document') return <DocumentForm entity={state.entity} item={state.item} quoteSource={state.quoteSource} workspace={workspace} busy={busy} close={close} act={act} />;
  if (state.type === 'time') return <TimeForm item={state.item} workspace={workspace} busy={busy} close={close} act={act} />;
  if (state.type === 'employee') return <EmployeeForm item={state.item} busy={busy} close={close} act={act} />;
  if (state.type === 'expense') return <ExpenseForm item={state.item} workspace={workspace} busy={busy} close={close} act={act} />;
  if (state.type === 'payslip') return <PayslipForm item={state.item} workspace={workspace} busy={busy} close={close} act={act} />;
  if (state.type === 'payment') return <PaymentForm invoice={state.invoice} workspace={workspace} busy={busy} close={close} act={act} />;
  return <TimerForm workspace={workspace} busy={busy} close={close} act={act} />;
}

function ClientForm({ item, busy, close, act }: { item?: Client; busy: boolean; close: () => void; act: ActionRunner }) {
  return <Modal title={item ? 'Modifier le client' : 'Nouveau client'} description="Saisissez uniquement les coordonnées réelles à utiliser sur les documents." onClose={close}><form onSubmit={submitForm(async (form) => {
    const contactPerson = String(form.get('contactPerson'));
    const company = String(form.get('company'));
    const data = { name: company || contactPerson, contactPerson, company, email: String(form.get('email')), phone: String(form.get('phone')), addressLine1: String(form.get('address')), addressLine2: '', postalCode: '', city: '', canton: '', country: '', notes: String(form.get('notes')) };
    await act(() => item ? desktopApi.updateEntity('clients', item.id, data) : desktopApi.createEntity('clients', data), item ? 'Le client a été mis à jour.' : 'Le client a été ajouté.');
  })}><div className="form-grid"><Field label="Nom du contact" required><input name="contactPerson" defaultValue={item?.name} required autoFocus /></Field><Field label="Entreprise"><input name="company" defaultValue={item?.company} /></Field><Field label="E-mail"><input name="email" type="email" defaultValue={item?.email} /></Field><Field label="Téléphone"><input name="phone" defaultValue={item?.phone} /></Field><Field label="Adresse de facturation" wide><textarea name="address" rows={3} defaultValue={item?.address} /></Field><Field label="Notes internes" wide><textarea name="notes" rows={3} defaultValue={item?.notes} /></Field></div><FormActions onCancel={close} busy={busy} /></form></Modal>;
}

type ActionRunner = (action: () => Promise<Workspace>, message: string, close?: boolean) => Promise<boolean>;

function ProjectForm({ item, workspace, busy, close, act }: { item?: Project; workspace: Workspace; busy: boolean; close: () => void; act: ActionRunner }) {
  return <Modal title={item ? 'Modifier le chantier' : 'Nouveau chantier'} description="Les dates prévues et réelles restent distinctes pour un suivi honnête." onClose={close} wide><form onSubmit={submitForm(async (form) => {
    const data = { clientId: String(form.get('clientId')), code: '', name: String(form.get('name')), addressLine1: String(form.get('address')), addressLine2: '', postalCode: '', city: '', canton: '', status: String(form.get('status')), plannedStartDate: String(form.get('plannedStart')), plannedEndDate: String(form.get('plannedEnd')), actualStartDate: String(form.get('actualStart')), actualEndDate: String(form.get('actualEnd')), budgetCents: centsFromInput(form.get('budget')), plannedMinutes: Math.round(numberFromInput(form.get('plannedHours')) * 60), progress: 0, description: '', notes: String(form.get('notes')) };
    await act(() => item ? desktopApi.updateEntity('projects', item.id, data) : desktopApi.createEntity('projects', data), item ? 'Le chantier a été mis à jour.' : 'Le chantier a été créé.');
  })}><div className="form-grid"><Field label="Nom du chantier" required wide><input name="name" defaultValue={item?.name} required autoFocus /></Field><Field label="Client" required><select name="clientId" defaultValue={item?.clientId} required><option value="">Choisir un client</option>{workspace.clients.map((client) => <option value={client.id} key={client.id}>{client.company || client.name}</option>)}</select></Field><Field label="Statut" required><select name="status" defaultValue={item?.status ?? 'planned'}><option value="planned">Planifié</option><option value="in_progress">En cours</option><option value="paused">En pause</option><option value="completed">Terminé</option><option value="closed">Clôturé</option></select></Field><Field label="Adresse du chantier" wide><textarea name="address" rows={2} defaultValue={item?.address} /></Field><Field label="Début prévu"><input name="plannedStart" type="date" defaultValue={item?.plannedStart} /></Field><Field label="Fin prévue"><input name="plannedEnd" type="date" defaultValue={item?.plannedEnd} /></Field><Field label="Début réel"><input name="actualStart" type="date" defaultValue={item?.actualStart} /></Field><Field label="Fin réelle"><input name="actualEnd" type="date" defaultValue={item?.actualEnd} /></Field><Field label="Budget accepté (CHF)"><input name="budget" type="number" min="0" step="0.01" defaultValue={item?.budgetCents ? item.budgetCents / 100 : ''} /></Field><Field label="Temps prévu (heures)"><input name="plannedHours" type="number" min="0" step="0.01" defaultValue={item?.plannedMinutes ? item.plannedMinutes / 60 : ''} /></Field><Field label="Notes" wide><textarea name="notes" rows={3} defaultValue={item?.notes} /></Field></div><FormActions onCancel={close} busy={busy} /></form></Modal>;
}

function DocumentForm({ entity, item, quoteSource, workspace, busy, close, act }: { entity: 'quotes' | 'invoices'; item?: Quote | Invoice; quoteSource?: Quote; workspace: Workspace; busy: boolean; close: () => void; act: ActionRunner }) {
  const settings = workspace.settings!;
  const current = item ?? quoteSource;
  const [lines, setLines] = useState<DocumentLine[]>(current?.lines.map((line) => ({ ...line })) ?? [{ id: createId(), description: '', quantity: 0, unit: '', unitPriceCents: 0, vatRateBp: settings.organization.vatRegistered ? 0 : 0 }]);
  const [issueDate, setIssueDate] = useState(item?.issueDate || todayIso());
  const [dueDate, setDueDate] = useState(entity === 'quotes' ? (item as Quote | undefined)?.validUntil || addDaysIso(issueDate, settings.billing.quoteValidityDays) : (item as Invoice | undefined)?.dueDate || addDaysIso(issueDate, settings.billing.paymentTermsDays));
  const totals = documentTotals(lines);
  const isLocked = item?.status !== undefined && item.status !== 'draft';

  function updateLine(id: string, patch: Partial<DocumentLine>) { setLines((currentLines) => currentLines.map((line) => line.id === id ? { ...line, ...patch } : line)); }
  function removeLine(id: string) { setLines((currentLines) => currentLines.filter((line) => line.id !== id)); }

  return <Modal title={`${item ? 'Modifier' : 'Nouveau'} ${entity === 'quotes' ? 'devis' : 'facture'}`} description={isLocked ? 'Un document émis ne peut plus être modifié.' : 'Le numéro définitif sera attribué uniquement lors de l’émission.'} onClose={close} wide><form onSubmit={submitForm(async (form) => {
    if (!lines.length || lines.some((line) => !line.description.trim() || line.quantity <= 0 || !line.unit.trim() || line.unitPriceCents < 0 || (settings.organization.vatRegistered && line.vatRateBp <= 0))) return;
    const data: Record<string, unknown> = { clientId: String(form.get('clientId')), projectId: String(form.get('projectId')) || null, title: String(form.get('title')), status: item?.status ?? 'draft', issueDate, currency: 'CHF', subtotalCents: totals.netCents, discountCents: 0, vatCents: totals.vatCents, totalCents: totals.totalCents, notes: String(form.get('notes')), terms: settings.billing.defaultFooter };
    if (entity === 'quotes') data.validUntil = dueDate;
    else { data.dueDate = dueDate; data.type = String(form.get('type')); data.quoteId = quoteSource?.id ?? (item as Invoice | undefined)?.quoteId ?? null; data.paidCents = item ? invoicePaid(item.id, workspace.payments) : 0; }
    await act(() => desktopApi.saveDocument(entity, data, lines, item), item ? 'Le brouillon a été mis à jour.' : `${entity === 'quotes' ? 'Le devis' : 'La facture'} a été enregistré en brouillon.`);
  })}><fieldset disabled={busy || isLocked} className="document-form"><div className="form-grid"><Field label="Titre du document" required wide><input name="title" defaultValue={item?.title ?? quoteSource?.title} required autoFocus /></Field><Field label="Client" required><select name="clientId" defaultValue={item?.clientId ?? quoteSource?.clientId} required><option value="">Choisir un client</option>{workspace.clients.map((client) => <option value={client.id} key={client.id}>{client.company || client.name}</option>)}</select></Field><Field label="Chantier"><select name="projectId" defaultValue={item?.projectId ?? quoteSource?.projectId ?? ''}><option value="">Aucun chantier lié</option>{workspace.projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></Field>{entity === 'invoices' ? <Field label="Type"><select name="type" defaultValue={(item as Invoice | undefined)?.type ?? 'standard'}><option value="standard">Standard</option><option value="deposit">Acompte</option><option value="progress">Situation</option><option value="final">Finale</option><option value="credit_note">Avoir</option></select></Field> : null}<Field label="Date d’émission"><input type="date" value={issueDate} onChange={(event) => { setIssueDate(event.target.value); if (!item) setDueDate(addDaysIso(event.target.value, entity === 'quotes' ? settings.billing.quoteValidityDays : settings.billing.paymentTermsDays)); }} required /></Field><Field label={entity === 'quotes' ? 'Valable jusqu’au' : 'Échéance'}><input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} required /></Field></div><section className="line-editor"><header><div><strong>Lignes du document</strong><small>Quantités, unités, prix et TVA saisis explicitement.</small></div><Button type="button" variant="secondary" size="small" onClick={() => setLines((currentLines) => [...currentLines, { id: createId(), description: '', quantity: 0, unit: '', unitPriceCents: 0, vatRateBp: 0 }])}><Plus size={15} /> Ajouter une ligne</Button></header><div className="line-editor__head"><span>Description</span><span>Quantité</span><span>Unité</span><span>Prix unitaire</span><span>TVA</span><span /></div>{lines.map((line) => <div className="line-editor__row" key={line.id}><input value={line.description} onChange={(event) => updateLine(line.id, { description: event.target.value })} aria-label="Description" required /><input type="number" min="0.0001" step="0.0001" value={line.quantity || ''} onChange={(event) => updateLine(line.id, { quantity: event.target.valueAsNumber || 0 })} aria-label="Quantité" required /><input value={line.unit} onChange={(event) => updateLine(line.id, { unit: event.target.value })} aria-label="Unité" required /><label className="money-input"><input type="number" min="0" step="0.01" value={line.unitPriceCents ? line.unitPriceCents / 100 : ''} onChange={(event) => updateLine(line.id, { unitPriceCents: Math.round((event.target.valueAsNumber || 0) * 100) })} aria-label="Prix unitaire" required /><span>CHF</span></label>{settings.organization.vatRegistered ? <select value={line.vatRateBp || ''} onChange={(event) => updateLine(line.id, { vatRateBp: Number(event.target.value) })} aria-label="Taux TVA" required><option value="">Choisir</option>{settings.billing.vatRatesBp.map((rate) => <option value={rate} key={rate}>{(rate / 100).toLocaleString('fr-CH')} %</option>)}</select> : <span className="no-vat">Sans TVA</span>}<Button type="button" variant="ghost" size="icon" onClick={() => removeLine(line.id)} disabled={lines.length === 1}><TrashIcon /></Button></div>)}</section><div className="document-bottom"><Field label="Notes internes / texte complémentaire"><textarea name="notes" rows={4} defaultValue={item?.notes ?? quoteSource?.notes} /></Field><div className="document-totals"><div><span>Sous-total net</span><strong>{formatMoney(totals.netCents)}</strong></div><div><span>TVA</span><strong>{formatMoney(totals.vatCents)}</strong></div><div><span>Total TTC</span><strong>{formatMoney(totals.totalCents)}</strong></div></div></div></fieldset>{isLocked ? <div className="warning-card"><ShieldCheck size={19} /><div><strong>Document verrouillé</strong><p>Imprimez-le ou créez un document correctif pour préserver l’historique.</p></div></div> : <FormActions onCancel={close} busy={busy} submitLabel="Enregistrer le brouillon" />}</form></Modal>;
}

function TrashIcon() { return <Archive size={15} />; }

function TimeForm({ item, workspace, busy, close, act }: { item?: TimeEntry; workspace: Workspace; busy: boolean; close: () => void; act: ActionRunner }) {
  return <Modal title={item ? 'Modifier les heures' : 'Saisir des heures'} description="La durée et le coût proviennent uniquement de cette saisie et du collaborateur choisi." onClose={close}><form onSubmit={submitForm(async (form) => {
    const employee = workspace.employees.find((candidate) => candidate.id === String(form.get('employeeId')));
    const data = { projectId: String(form.get('projectId')), employeeId: String(form.get('employeeId')), date: String(form.get('date')), minutes: Math.round(numberFromInput(form.get('hours')) * 60), breakMinutes: 0, billable: true, billingRateCents: 0, costRateCents: employee?.hourlyCostCents ?? 0, note: String(form.get('note')), status: String(form.get('status')) };
    await act(() => item ? desktopApi.updateEntity('timeEntries', item.id, data) : desktopApi.createEntity('timeEntries', data), item ? 'La saisie de temps a été mise à jour.' : 'Les heures ont été enregistrées.');
  })}><div className="form-grid"><Field label="Chantier" required wide><select name="projectId" defaultValue={item?.projectId} required autoFocus><option value="">Choisir un chantier</option>{workspace.projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></Field><Field label="Collaborateur" required><select name="employeeId" defaultValue={item?.employeeId} required><option value="">Choisir un collaborateur</option>{workspace.employees.filter((employee) => employee.active).map((employee) => <option value={employee.id} key={employee.id}>{employee.name}</option>)}</select></Field><Field label="Date" required><input name="date" type="date" defaultValue={item?.date || todayIso()} required /></Field><Field label="Durée en heures" required><input name="hours" type="number" min="0.01" step="0.01" defaultValue={item?.minutes ? item.minutes / 60 : ''} required /></Field><Field label="Statut"><select name="status" defaultValue={item?.status ?? 'entered'}><option value="entered">Saisi</option><option value="approved">Approuvé</option><option value="locked">Verrouillé</option></select></Field><Field label="Note" wide><textarea name="note" rows={3} defaultValue={item?.note} /></Field></div><FormActions onCancel={close} busy={busy} /></form></Modal>;
}

function EmployeeForm({ item, busy, close, act }: { item?: Employee; busy: boolean; close: () => void; act: ActionRunner }) {
  const [salaryMode, setSalaryMode] = useState<Employee['salaryMode']>(item?.salaryMode ?? 'hourly');
  return <Modal title={item ? 'Modifier le collaborateur' : 'Nouveau collaborateur'} description="Aucun salaire, taux ou coût n’est prérempli." onClose={close} wide><form onSubmit={submitForm(async (form) => {
    const data = { employeeNumber: '', name: String(form.get('name')), role: String(form.get('role')), email: String(form.get('email')), phone: String(form.get('phone')), addressLine1: String(form.get('address')), addressLine2: '', postalCode: '', city: '', canton: '', birthDate: '', socialSecurityNumber: String(form.get('avsNumber')), iban: String(form.get('iban')), employmentStartDate: String(form.get('employmentStart')), employmentEndDate: String(form.get('employmentEnd')), employmentRate: numberFromInput(form.get('employmentRate')), hourlyRateCents: centsFromInput(form.get('hourlyCost')), monthlySalaryCents: salaryMode === 'monthly' ? centsFromInput(form.get('grossSalary')) : 0, status: form.get('active') === 'on' ? 'actif' : 'inactif', notes: '' };
    await act(() => item ? desktopApi.updateEntity('employees', item.id, data) : desktopApi.createEntity('employees', data), item ? 'Le collaborateur a été mis à jour.' : 'Le collaborateur a été ajouté.');
  })}><div className="form-grid"><Field label="Nom complet" required wide><input name="name" defaultValue={item?.name} required autoFocus /></Field><Field label="Fonction" required><input name="role" defaultValue={item?.role} required /></Field><Field label="Taux d’activité (%)" required><input name="employmentRate" type="number" min="0.01" max="100" step="0.01" defaultValue={item?.employmentRate || ''} required /></Field><Field label="E-mail"><input name="email" type="email" defaultValue={item?.email} /></Field><Field label="Téléphone"><input name="phone" defaultValue={item?.phone} /></Field><Field label="Adresse" wide><textarea name="address" rows={2} defaultValue={item?.address} /></Field><Field label="Numéro AVS"><input name="avsNumber" defaultValue={item?.avsNumber} /></Field><Field label="IBAN du collaborateur"><input name="iban" defaultValue={item?.iban} /></Field><Field label="Début du contrat"><input name="employmentStart" type="date" defaultValue={item?.employmentStart} /></Field><Field label="Fin du contrat"><input name="employmentEnd" type="date" defaultValue={item?.employmentEnd} /></Field><Field label="Mode de salaire"><select value={salaryMode} onChange={(event) => setSalaryMode(event.target.value as Employee['salaryMode'])}><option value="hourly">Horaire</option><option value="monthly">Mensuel</option></select></Field>{salaryMode === 'monthly' ? <Field label="Salaire mensuel brut (CHF)" required><input name="grossSalary" type="number" min="0" step="0.01" defaultValue={item?.grossSalaryCents ? item.grossSalaryCents / 100 : ''} required /></Field> : null}<Field label="Coût horaire chargé (CHF)" hint="Saisissez le coût réellement défini par l’entreprise." required><input name="hourlyCost" type="number" min="0" step="0.01" defaultValue={item?.hourlyCostCents ? item.hourlyCostCents / 100 : ''} required /></Field><label className="check-card"><input name="active" type="checkbox" defaultChecked={item?.active ?? true} /><span><strong>Collaborateur actif</strong><small>Disponible pour les nouvelles saisies de temps.</small></span></label></div><FormActions onCancel={close} busy={busy} /></form></Modal>;
}

function ExpenseForm({ item, workspace, busy, close, act }: { item?: Expense; workspace: Workspace; busy: boolean; close: () => void; act: ActionRunner }) {
  const [netCents, setNetCents] = useState(item?.netCents ?? 0);
  const [vatCents, setVatCents] = useState(item?.vatCents ?? 0);
  return <Modal title={item ? 'Modifier la dépense' : 'Nouvelle dépense'} description="Le montant net et la TVA sont saisis séparément : aucune ventilation n’est estimée." onClose={close}><form onSubmit={submitForm(async (form) => {
    const data = { projectId: String(form.get('projectId')), date: String(form.get('date')), supplier: String(form.get('supplier')), category: String(form.get('category')), reference: String(form.get('reference')), currency: 'CHF', netCents, vatCents, totalCents: netCents + vatCents, reimbursable: false, note: String(form.get('note')) };
    await act(() => item ? desktopApi.updateEntity('expenses', item.id, data) : desktopApi.createEntity('expenses', data), item ? 'La dépense a été mise à jour.' : 'La dépense a été enregistrée.');
  })}><div className="form-grid"><Field label="Chantier" required wide><select name="projectId" defaultValue={item?.projectId} required><option value="">Choisir un chantier</option>{workspace.projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></Field><Field label="Date" required><input name="date" type="date" defaultValue={item?.date || todayIso()} required /></Field><Field label="Fournisseur" required><input name="supplier" defaultValue={item?.supplier} required autoFocus /></Field><Field label="Catégorie" required><select name="category" defaultValue={item?.category} required><option value="">Choisir une catégorie</option>{workspace.settings?.work.costCategories.map((category) => <option value={category} key={category}>{category}</option>)}</select></Field><Field label="Référence"><input name="reference" /></Field><Field label="Montant net (CHF)" required><input type="number" min="0" step="0.01" value={netCents ? netCents / 100 : ''} onChange={(event) => setNetCents(Math.round((event.target.valueAsNumber || 0) * 100))} required /></Field><Field label="Montant TVA (CHF)" required><input type="number" min="0" step="0.01" value={vatCents ? vatCents / 100 : ''} onChange={(event) => setVatCents(Math.round((event.target.valueAsNumber || 0) * 100))} required /></Field><Field label="Total calculé"><output className="field-output">{formatMoney(netCents + vatCents)}</output></Field><Field label="Note" wide><textarea name="note" rows={3} defaultValue={item?.note} /></Field></div><FormActions onCancel={close} busy={busy} /></form></Modal>;
}

function PayslipForm({ item, workspace, busy, close, act }: { item?: Payslip; workspace: Workspace; busy: boolean; close: () => void; act: ActionRunner }) {
  const [lines, setLines] = useState<PayslipLine[]>(item?.lines.map((line) => ({ ...line })) ?? []);
  const totals = payslipTotals({ id: item?.id ?? '', employeeId: item?.employeeId ?? '', period: item?.period ?? '', status: item?.status ?? 'incomplete', lines, notes: item?.notes ?? '', createdAt: item?.createdAt ?? '' });
  function addLine(kind: PayslipLine['kind']) { setLines((current) => [...current, { id: createId(), label: '', kind, amountCents: 0 }]); }
  function updateLine(id: string, patch: Partial<PayslipLine>) { setLines((current) => current.map((line) => line.id === id ? { ...line, ...patch } : line)); }
  return <Modal title={item ? 'Modifier la fiche' : 'Nouvelle fiche de salaire'} description="Toutes les lignes sont explicites. Le logiciel n’ajoute aucune retenue automatique." onClose={close} wide><form onSubmit={submitForm(async (form) => {
    if (!lines.length || lines.some((line) => !line.label.trim() || line.amountCents < 0)) return;
    const status: Payslip['status'] = workspace.settings?.payroll.fiduciaryValidated && form.get('validated') === 'on' ? 'validated' : 'incomplete';
    const data = { employeeId: String(form.get('employeeId')), period: String(form.get('period')), status, grossCents: totals.earnings, deductionsCents: totals.deductions, netCents: totals.net, employerCostsCents: totals.employer, paymentDate: '', notes: String(form.get('notes')) };
    await act(() => desktopApi.savePayslip(data, lines, item), item ? 'La fiche a été mise à jour.' : 'La fiche a été créée avec les lignes saisies.');
  })}><div className="form-grid"><Field label="Collaborateur" required><select name="employeeId" defaultValue={item?.employeeId} required><option value="">Choisir un collaborateur</option>{workspace.employees.map((employee) => <option value={employee.id} key={employee.id}>{employee.name}</option>)}</select></Field><Field label="Période" required><input name="period" type="month" defaultValue={item?.period} required /></Field></div><section className="pay-lines"><header><div><strong>Éléments de la fiche</strong><small>Aucun montant n’est proposé par défaut.</small></div><div><Button type="button" variant="secondary" size="small" onClick={() => addLine('earning')}><Plus size={14} /> Gain</Button><Button type="button" variant="secondary" size="small" onClick={() => addLine('deduction')}><Plus size={14} /> Retenue</Button><Button type="button" variant="secondary" size="small" onClick={() => addLine('employer')}><Plus size={14} /> Charge employeur</Button></div></header>{lines.length ? <div className="pay-line-list">{lines.map((line) => <div key={line.id}><select value={line.kind} onChange={(event) => updateLine(line.id, { kind: event.target.value as PayslipLine['kind'] })}><option value="earning">Gain</option><option value="deduction">Retenue</option><option value="employer">Charge employeur</option></select><input value={line.label} onChange={(event) => updateLine(line.id, { label: event.target.value })} placeholder="Libellé" required /><label className="money-input"><input type="number" min="0" step="0.01" value={line.amountCents ? line.amountCents / 100 : ''} onChange={(event) => updateLine(line.id, { amountCents: Math.round((event.target.valueAsNumber || 0) * 100) })} required /><span>CHF</span></label><Button type="button" variant="ghost" size="icon" onClick={() => setLines((current) => current.filter((candidate) => candidate.id !== line.id))}><Archive size={15} /></Button></div>)}</div> : <div className="rate-empty">Ajoutez les gains, retenues et charges confirmés pour cette période.</div>}</section><div className="document-bottom"><Field label="Notes"><textarea name="notes" rows={3} defaultValue={item?.notes} /></Field><div className="document-totals"><div><span>Brut saisi</span><strong>{formatMoney(totals.earnings)}</strong></div><div><span>Retenues saisies</span><strong>{formatMoney(totals.deductions)}</strong></div><div><span>Net calculé</span><strong>{formatMoney(totals.net)}</strong></div></div></div>{workspace.settings?.payroll.fiduciaryValidated ? <label className="check-card"><input name="validated" type="checkbox" defaultChecked={item?.status === 'validated'} /><span><strong>Valider cette fiche</strong><small>Confirmez que les lignes de cette période ont été contrôlées.</small></span></label> : <div className="warning-card"><ShieldCheck size={18} /><div><strong>La fiche restera incomplète</strong><p>La configuration de paie n’est pas marquée comme contrôlée par une fiduciaire.</p></div></div>}<FormActions onCancel={close} busy={busy} /></form></Modal>;
}

function PaymentForm({ invoice, workspace, busy, close, act }: { invoice: Invoice; workspace: Workspace; busy: boolean; close: () => void; act: ActionRunner }) {
  const total = documentTotals(invoice.lines).totalCents;
  const alreadyPaid = invoicePaid(invoice.id, workspace.payments);
  const balance = Math.max(0, total - alreadyPaid);
  return <Modal title="Enregistrer un paiement" description={`${invoice.number || 'Facture'} · solde ouvert ${formatMoney(balance)}`} onClose={close}><form onSubmit={submitForm(async (form) => {
    const amountCents = centsFromInput(form.get('amount'));
    if (amountCents <= 0 || amountCents > balance) return;
    await act(() => desktopApi.addPayment(invoice.id, { amountCents, date: String(form.get('date')), method: String(form.get('method')), reference: String(form.get('reference')), notes: String(form.get('notes')) }), 'Le paiement a été enregistré et le solde recalculé.');
  })}><div className="payment-summary"><div><span>Total facture</span><strong>{formatMoney(total)}</strong></div><div><span>Déjà encaissé</span><strong>{formatMoney(alreadyPaid)}</strong></div><div><span>Solde</span><strong>{formatMoney(balance)}</strong></div></div><div className="form-grid"><Field label="Montant encaissé (CHF)" required><input name="amount" type="number" min="0.01" max={balance / 100} step="0.01" required autoFocus /></Field><Field label="Date" required><input name="date" type="date" defaultValue={todayIso()} required /></Field><Field label="Mode de paiement" required><input name="method" required /></Field><Field label="Référence"><input name="reference" /></Field><Field label="Note" wide><textarea name="notes" rows={2} /></Field></div><FormActions onCancel={close} busy={busy} submitLabel="Enregistrer le paiement" /></form></Modal>;
}

function TimerForm({ workspace, busy, close, act }: { workspace: Workspace; busy: boolean; close: () => void; act: ActionRunner }) {
  const [employeeId, setEmployeeId] = useState('');
  const employee = workspace.employees.find((item) => item.id === employeeId);
  return <Modal title="Démarrer un pointage" description="Le chronomètre utilise le coût horaire réellement configuré du collaborateur." onClose={close}><form onSubmit={submitForm(async (form) => {
    await act(() => desktopApi.startTimer({ projectId: String(form.get('projectId')), employeeId, note: String(form.get('note')), billable: true, billingRateCents: 0, costRateCents: employee?.hourlyCostCents ?? 0 }), 'Le pointage a démarré.');
  })}><div className="timer-modal-icon"><Play size={25} /></div><div className="form-grid"><Field label="Chantier" required wide><select name="projectId" required autoFocus><option value="">Choisir un chantier</option>{workspace.projects.filter((project) => project.status !== 'closed').map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></Field><Field label="Collaborateur" required wide><select value={employeeId} onChange={(event) => setEmployeeId(event.target.value)} required><option value="">Choisir un collaborateur</option>{workspace.employees.filter((item) => item.active).map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></Field><Field label="Note de travail" wide><textarea name="note" rows={3} /></Field></div>{employeeId ? <div className="info-strip"><Clock3 size={17} /><span>Coût horaire appliqué : {employee?.hourlyCostCents ? formatMoney(employee.hourlyCostCents) : 'aucun coût configuré'}.</span></div> : null}<FormActions onCancel={close} busy={busy} submitLabel="Démarrer le chronomètre" /></form></Modal>;
}

function PrintSheet({ target, workspace, onClose }: { target: Exclude<PrintTarget, null>; workspace: Workspace; onClose: () => void }) {
  const settings = workspace.settings!;
  if (target.entity === 'payslips') {
    const payslip = target.value;
    const employee = workspace.employees.find((item) => item.id === payslip.employeeId);
    const totals = payslipTotals(payslip);
    return <div className="print-preview"><div className="print-preview__toolbar"><strong>Aperçu d’impression</strong><span>Utilisez l’imprimante PDF de Windows pour enregistrer un PDF.</span><Button variant="secondary" onClick={() => window.print()}><Printer size={16} /> Imprimer</Button><Button variant="ghost" size="icon" onClick={onClose}><X size={18} /></Button></div><article className="print-sheet"><PrintHeader settings={settings} title="FICHE DE SALAIRE" number={payslip.period} /><section className="print-recipient"><span>COLLABORATEUR</span><strong>{employee?.name || '—'}</strong><p>{employee?.address || '—'}<br />{employee?.avsNumber || ''}</p></section><table className="print-table"><thead><tr><th>Élément</th><th>Type</th><th>Montant</th></tr></thead><tbody>{payslip.lines.map((line) => <tr key={line.id}><td>{line.label}</td><td>{line.kind === 'earning' ? 'Gain' : line.kind === 'deduction' ? 'Retenue' : 'Charge employeur'}</td><td>{formatMoney(line.amountCents)}</td></tr>)}</tbody></table><div className="print-totals"><div><span>Brut saisi</span><strong>{formatMoney(totals.earnings)}</strong></div><div><span>Retenues saisies</span><strong>{formatMoney(totals.deductions)}</strong></div><div className="print-totals__grand"><span>Net</span><strong>{formatMoney(totals.net)}</strong></div></div><footer className="print-footer"><p>{payslip.notes}</p><p>Document établi à partir des éléments explicitement configurés et saisis dans HelviChantier.</p></footer></article></div>;
  }
  const document = target.value;
  const client = workspace.clients.find((item) => item.id === document.clientId);
  const totals = documentTotals(document.lines);
  const isQuote = target.entity === 'quotes';
  const due = isQuote ? (document as Quote).validUntil : (document as Invoice).dueDate;
  return <div className="print-preview"><div className="print-preview__toolbar"><strong>Aperçu d’impression</strong><span>Vérifiez les informations avant impression.</span><Button variant="secondary" onClick={() => window.print()}><Printer size={16} /> Imprimer</Button><Button variant="ghost" size="icon" onClick={onClose}><X size={18} /></Button></div><article className="print-sheet"><PrintHeader settings={settings} title={isQuote ? 'DEVIS' : 'FACTURE'} number={document.number} /><div className="print-meta"><div><span>Émis le</span><strong>{formatDate(document.issueDate)}</strong></div><div><span>{isQuote ? 'Valable jusqu’au' : 'Échéance'}</span><strong>{formatDate(due)}</strong></div></div><section className="print-recipient"><span>DESTINATAIRE</span><strong>{client?.company || client?.name || '—'}</strong><p>{client?.address || '—'}<br />{client?.email || ''}</p></section><h2 className="print-title">{document.title}</h2><table className="print-table"><thead><tr><th>Description</th><th>Qté</th><th>Unité</th><th>Prix unitaire</th><th>TVA</th><th>Total net</th></tr></thead><tbody>{document.lines.map((line) => <tr key={line.id}><td>{line.description}</td><td>{line.quantity.toLocaleString('fr-CH')}</td><td>{line.unit}</td><td>{formatMoney(line.unitPriceCents)}</td><td>{settings.organization.vatRegistered ? `${(line.vatRateBp / 100).toLocaleString('fr-CH')} %` : '—'}</td><td>{formatMoney(Math.round(line.quantity * line.unitPriceCents))}</td></tr>)}</tbody></table><div className="print-totals"><div><span>Sous-total net</span><strong>{formatMoney(totals.netCents)}</strong></div><div><span>TVA</span><strong>{formatMoney(totals.vatCents)}</strong></div><div className="print-totals__grand"><span>Total TTC</span><strong>{formatMoney(totals.totalCents)}</strong></div></div><footer className="print-footer"><p>{document.notes}</p><p><strong>IBAN</strong> · {settings.billing.iban}<br />{settings.billing.defaultFooter}</p></footer></article></div>;
}

function PrintHeader({ settings, title, number }: { settings: AppSettings; title: string; number: string }) {
  const org = settings.organization;
  return <header className="print-header"><div><div className="print-brand"><HardHat size={24} /><span>HelviChantier</span></div><strong>{org.legalName}</strong><p>{org.address.street}<br />{org.address.postalCode} {org.address.city}<br />{org.uidNumber}</p></div><div><h1>{title}</h1><strong>{number || '—'}</strong></div></header>;
}
