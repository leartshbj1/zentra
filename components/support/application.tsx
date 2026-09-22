'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  BarChart3,
  CircleHelp,
  Inbox,
  Link2,
  Settings2,
  ShieldCheck,
  Search,
  Users,
  X,
  Plus,
  AlertCircle,
  CreditCard,
  Folder,
  CheckCheck,
  ChevronDown,
  Workflow,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { BrandWordmark } from '@/components/brand-mark';
import {
  CATEGORIES,
  PRIORITIES,
  LANGUAGES,
  type Decision,
} from '@/lib/support/types';
import {
  ConnectionsPanel,
  RoutingPanel,
  TeamPanel,
  InsightsPanel,
  ReviewForm,
} from './panels';
import { Choice, Field, formatDate } from './controls';
import { BillingPanel } from './billing-panel';
import {
  emptyState,
  demoState,
  STATES,
  type SupportState,
  type Mutate,
} from './model';

import { AutomationCompanySettings } from '@/components/automation/company-settings';
import '@/components/automation/automation.css';

const sections = [
  { id: 'inbox', label: 'Tickets', icon: Inbox },
  { id: 'automation', label: 'Automation', icon: Workflow },
  { id: 'routing', label: 'Routage', icon: Settings2 },
  { id: 'connections', label: 'Connexions', icon: Link2 },
  { id: 'insights', label: 'Résultats', icon: BarChart3 },
  { id: 'team', label: 'Équipe', icon: Users },
  { id: 'billing', label: 'Abonnement', icon: CreditCard },
];
export function SupportWorkspace({ demo = false }: { demo?: boolean }) {
  const [data, setData] = useState<SupportState>(() =>
      demo ? demoState() : emptyState,
    ),
    [loading, setLoading] = useState(!demo),
    [signedOut, setSignedOut] = useState(false);
  const [workspaceId, setWorkspace] = useState(''),
    [tab, setTab] = useState('inbox'),
    [selected, setSelected] = useState<string | null>(demo ? '1048' : null);
  const [search, setSearch] = useState(''),
    [query, setQuery] = useState(''),
    [filter, setFilter] = useState(''),
    [category, setCategory] = useState(''),
    [fetching, setFetching] = useState(false),
    [foldersOpen, setFoldersOpen] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const [name, setName] = useState(''),
    [importOpen, setImportOpen] = useState(false),
    [connectionId, setConnection] = useState(''),
    [externalId, setExternalId] = useState('');
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const ticketButtons = useRef(new Map<string, HTMLButtonElement>());
  const sequence = useRef(0),
    busyRef = useRef(false),
    dataRef = useRef(data),
    workspaceRef = useRef(workspaceId);
  dataRef.current = data;
  workspaceRef.current = workspaceId;
  useEffect(() => {
    if (demo && window.matchMedia('(max-width: 1100px)').matches)
      setSelected(null);
    if (!demo) {
      setWorkspace(
        new URLSearchParams(window.location.search).get('workspace') || '',
      );
      const section = new URLSearchParams(window.location.search).get(
        'section',
      );
      if (section && sections.some((s) => s.id === section)) setTab(section);
      const zendesk = new URLSearchParams(window.location.search).get(
        'zendesk',
      );
      if (zendesk)
        setNotice(
          zendesk === 'connecte'
            ? 'Zendesk est connecté. Ouvrez le guide de connexion pour activer la réception des tickets.'
            : 'L’autorisation Zendesk a été annulée. Vous pouvez la reprendre dans Connexions.',
        );
    }
  }, [demo]);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const load = useCallback(
    async (
      options: {
        append?: boolean;
        workspace?: string;
        quiet?: boolean;
        unfiltered?: boolean;
      } = {},
    ) => {
      if (demo) return;
      const request = ++sequence.current,
        params = new URLSearchParams(),
        id = options.workspace ?? workspaceRef.current;
      if (id) params.set('workspace', id);
      else { const org=new URLSearchParams(window.location.search).get('organizationId');if(org)params.set('organizationId',org); }
      if (query && !options.unfiltered) params.set('search', query);
      if (filter && !options.unfiltered) params.set('state', filter);
      if (category && !options.unfiltered) params.set('category', category);
      if (!options.quiet) setFetching(true);
      const last = dataRef.current.tickets.at(-1);
      if (options.append && last) {
        params.set('before', String(last.updatedAt));
        params.set('beforeId', last.id);
      }
      try {
        let response = await fetch(`/api/support?${params}`, {
          cache: 'no-store',
        });
        if (response.status === 401) {
          const refresh = await fetch('/api/auth/session', {
            cache: 'no-store',
          });
          if (refresh.ok)
            response = await fetch(`/api/support?${params}`, {
              cache: 'no-store',
            });
        }
        if (request !== sequence.current) return;
        if (response.status === 401) {
          setSignedOut(true);
          return;
        }
        const result = (await response.json().catch(() => {
          throw new Error(
            'Le service ne répond pas correctement. Rechargez la page puis réessayez.',
          );
        })) as SupportState & {
          error?: string;
        };
        if (!response.ok)
          throw new Error(
            result.error || 'Impossible de charger les tickets. Réessayez.',
          );
        setSignedOut(false);
        setData((previous) => ({
          ...emptyState,
          ...result,
          counts: { ...emptyState.counts, ...result.counts },
          tickets: options.append
            ? [
                ...previous.tickets,
                ...result.tickets.filter(
                  (t: { id: string }) =>
                    !previous.tickets.some((p) => p.id === t.id),
                ),
              ]
            : result.tickets || [],
        }));
        if (!options.quiet) setError('');
      } catch (e) {
        if (request === sequence.current)
          setError(
            e instanceof Error
              ? e.message
              : 'Connexion interrompue. Nous réessaierons automatiquement.',
          );
      } finally {
        if (request === sequence.current) {
          setLoading(false);
          setFetching(false);
        }
      }
    },
    [demo, query, filter, category],
  );
  useEffect(() => {
    void load();
  }, [load, workspaceId]);
  useEffect(() => {
    if (demo) return;
    const refresh = () => {
      if (!document.hidden && !busyRef.current) void load({ quiet: true });
    };
    const timer = setInterval(refresh, 15000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [demo, load]);
  const mailWorkspace =
    !demo &&
    data.workspace?.canManage &&
    data.connections.some((c) => c.provider === 'infomaniak')
      ? data.workspace.id
      : '';
  useEffect(() => {
    if (!mailWorkspace) return;
    let cancelled = false,
      inFlight = false;
    const receiveMail = async () => {
      if (cancelled || inFlight || busyRef.current) return;
      inFlight = true;
      try {
        await fetch('/api/support', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'syncMailboxes',
            workspaceId: mailWorkspace,
          }),
        });
        if (!cancelled) await load({ quiet: true });
      } catch {
        /* Keep the last successful sync visible; retry at the next tick. */
      } finally {
        inFlight = false;
      }
    };
    void receiveMail();
    const timer = setInterval(receiveMail, 60000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [mailWorkspace, load]);
  const mutate: Mutate = async (body) => {
    if (busyRef.current) return null;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (demo) {
        if (body.action === 'approve')
          setData((d) => ({
            ...d,
            tickets: d.tickets.map((t) =>
              t.id === body.ticketId
                ? {
                    ...t,
                    state: 'routed',
                    revision: t.revision + 1,
                    automatic: false,
                    decision: {
                      ...t.decision,
                      category: body.category,
                      priority: body.priority,
                      destination: body.destination,
                      manual: true,
                      reason:
                        'Validation simulée. Aucun outil externe n’a été modifié.',
                    } as Decision,
                  }
                : t,
            ),
            counts: { ...d.counts, review: Math.max(0, d.counts.review - 1) },
          }));
        else if (body.action === 'routes')
          setData((d) => ({
            ...d,
            connections: d.connections.map((c) =>
              c.id === body.connectionId
                ? { ...c, rules: body.rules as typeof c.rules }
                : c,
            ),
          }));
        else if (body.action === 'settings')
          setData((d) => ({
            ...d,
            workspace: d.workspace
              ? {
                  ...d.workspace,
                  name: String(body.name),
                  mode: String(body.mode),
                  threshold: Number(body.threshold),
                  baselineSeconds: Number(body.baselineSeconds),
                }
              : null,
          }));
        else {
          setNotice(
            'Connectez-vous à votre véritable espace pour utiliser cette fonction.',
          );
          return null;
        }
        setNotice('Modification simulée dans cette démonstration.');
        return { saved: true };
      }
      const response = await fetch('/api/support', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: data.workspace?.id, ...body }),
      });
      const result = (await response.json().catch(() => {
        throw new Error(
          'Le service ne répond pas correctement. Rechargez la page puis réessayez.',
        );
      })) as {
        error?: string;
        workspaceId?: string;
        ticketId?: string;
      } & Record<string, unknown>;
      if (!response.ok) {
        if (response.status === 401) setSignedOut(true);
        throw new Error(result.error || 'L’action n’a pas abouti. Réessayez.');
      }
      if (result.ticketId) {
        setTab('inbox');
        setFilter('');
        setCategory('');
        setSearch('');
        setQuery('');
        setFoldersOpen(false);
        await load({ unfiltered: true });
        setSelected(result.ticketId);
      } else if (result.workspaceId) {
        setWorkspace(result.workspaceId);
        await load({ workspace: result.workspaceId });
      } else await load();
      setNotice(
        body.action === 'approve'
          ? 'Décision enregistrée.'
          : body.action === 'connectMailbox'
            ? 'Boîte mail connectée. La réception automatique est prête.'
            : body.action === 'syncMailbox'
              ? result.syncing
                ? 'Une synchronisation est déjà en cours.'
                : result.paused
                  ? 'Le traitement de cet espace est en pause.'
                  : `${result.imported ?? 0} nouveau(x) mail(s) récupéré(s), ${result.processed ?? 0} analysé(s).`
              : 'Enregistré.',
      );
      return result;
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'L’action n’a pas abouti. Réessayez.',
      );
      return null;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const tickets = data.tickets.filter(
    (t) =>
      (!filter || t.state === filter) &&
      (!category || t.decision?.category === category) &&
      `${t.subject} ${t.externalId}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const ticket = tickets.find((t) => t.id === selected),
    connection = data.connections.find((c) => c.id === ticket?.connectionId),
    readOnly = data.workspace?.role === 'read_only';
  const folderName = category
    ? CATEGORIES[category as keyof typeof CATEGORIES]
    : filter
      ? STATES[filter]
      : 'Tous les tickets';
  const chooseFolder = (state: string, categoryValue = '') => {
    setFilter(state);
    setCategory(categoryValue);
    setSelected(null);
    setSearch('');
    setQuery('');
    setTab('inbox');
    setFoldersOpen(false);
  };
  const folderButton = (value: string, label: string) => (
    <button
      key={value}
      type="button"
      className="support-folder"
      aria-pressed={tab === 'inbox' && category === value}
      onClick={() => chooseFolder('', value)}
    >
      <Folder size={17} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
  const externalUrl =
    ticket && connection && connection.provider !== 'api'
      ? connection.provider === 'infomaniak'
        ? 'https://ksuite.infomaniak.com/mail'
        : `https://${connection.domain}/${connection.provider === 'zendesk' ? 'agent/tickets' : connection.provider === 'freshdesk' ? 'a/tickets' : 'app/ticket'}/${encodeURIComponent(ticket.externalId)}`
      : null;
  const noticeView = (
    <>
      {error && (
        <div className="support-notice support-error" role="alert">
          <AlertCircle size={19} />
          <span>{error}</span>
          <Button
            variant="ghost"
            aria-label="Fermer le message"
            onClick={() => setError('')}
          >
            <X size={16} />
          </Button>
        </div>
      )}
      {notice && (
        <div className="support-notice" role="status">
          <span>{notice}</span>
          <Button
            variant="ghost"
            aria-label="Fermer la confirmation"
            onClick={() => setNotice('')}
          >
            <X size={16} />
          </Button>
        </div>
      )}
    </>
  );
  return (
    <div className="support-app">
      <header className="support-topbar">
        <a href="/support" aria-label="Accueil Zentra Support">
          <BrandWordmark className="support-wordmark" />
        </a>
        <span className="support-product">Support</span>
        <span className="support-top-spacer" />
        <span className="support-mode">
          {demo ? 'Démonstration' : data.user.name}
        </span>
        <a href={demo ? '/support/espace' : '/compte'}>
          {demo ? 'Créer mon espace' : 'Mon compte'} <ArrowUpRight size={16} />
        </a>
      </header>
      {demo && (
        <div className="support-demo-note">
          Exemples fictifs. Essayez une validation : aucun ticket ni message
          n’est envoyé.
        </div>
      )}
      {loading ? (
        <div className="support-welcome" aria-live="polite">
          <Inbox size={32} />
          <h1>Ouverture de votre espace…</h1>
        </div>
      ) : signedOut ? (
        <main className="support-welcome">
          <p className="support-eyebrow">ZENTRA SUPPORT</p>
          <h1>
            Moins de tri.
            <br />
            Plus de temps pour vos clients.
          </h1>
          <p>
            Connectez votre outil de support. Zentra classe vos tickets, propose
            une priorité et les dirige vers la bonne équipe.
          </p>
          <div className="support-actions">
            <Button
              className="support-primary"
              nativeButton={false}
              render={
                <a
                  href={`/connexion?retour=${encodeURIComponent('/support/espace?' + new URLSearchParams({ section: tab, ...(workspaceId ? { workspace: workspaceId } : {}) }).toString())}`}
                />
              }
            >
              Ouvrir mon espace <ArrowUpRight size={18} />
            </Button>
            <Button
              variant="outline"
              nativeButton={false}
              render={<a href="/support/demo" />}
            >
              Explorer la démonstration
            </Button>
          </div>
          <p className="support-small">
            Zendesk · Freshdesk · Gorgias · Autres outils via API
          </p>
        </main>
      ) : !data.workspace ? (
        <main className="support-welcome">
          {noticeView}
          <p className="support-eyebrow">BIENVENUE</p>
          <h1>Votre support commence ici.</h1>
          <p>
            Créez votre espace, connectez votre outil, puis choisissez vos
            équipes. Les tickets suffisamment clairs seront affectés
            automatiquement.
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (await mutate({ action: 'createWorkspace', name }))
                setTab('connections');
            }}
          >
            <Field
              label="Nom de votre entreprise ou de votre équipe"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              minLength={2}
              maxLength={100}
              placeholder="Mon équipe support"
            />
            <Button className="support-primary" type="submit" disabled={busy}>
              {busy ? 'Création…' : 'Créer mon espace'}
            </Button>
          </form>
          <a href="/support/demo">
            Voir un exemple <ArrowUpRight size={16} />
          </a>
        </main>
      ) : (
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(String(v))}
          orientation="vertical"
          className="support-workspace"
        >
          <aside className="support-sidebar">
            <div className="support-workspace-picker">
              <Choice
                label="Votre espace"
                value={data.workspace.id}
                options={data.workspaces.map((w) => ({
                  value: w.id,
                  label: w.name,
                }))}
                onChange={(id) => {
                  setWorkspace(id);
                  setSelected(null);
                  setSearch('');
                  setFilter('');
                  setCategory('');
                  setQuery('');
                }}
              />
            </div>
            <button
              type="button"
              className="support-folder-toggle"
              aria-expanded={foldersOpen}
              aria-controls="support-folders"
              onClick={() => setFoldersOpen(!foldersOpen)}
            >
              <Folder size={18} />
              Dossiers
              <ChevronDown size={16} />
            </button>
            <nav
              id="support-folders"
              className="support-folders"
              data-open={foldersOpen}
              aria-label="Dossiers des tickets"
            >
              <p className="support-nav-label">Boîte de réception</p>
              {[
                { value: '', label: 'Tous les tickets', icon: Inbox },
                { value: 'review', label: 'À vérifier', icon: CircleHelp },
                { value: 'error', label: 'À reprendre', icon: AlertCircle },
                { value: 'routed', label: 'Affectés', icon: CheckCheck },
              ].map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  type="button"
                  className="support-folder"
                  aria-pressed={
                    tab === 'inbox' && filter === value && !category
                  }
                  onClick={() => chooseFolder(value)}
                >
                  <Icon size={17} aria-hidden="true" />
                  <span>{label}</span>
                </button>
              ))}
              <div className="support-category-folders">
                <p className="support-nav-label">Dossiers par catégorie</p>
                {Object.entries(CATEGORIES)
                  .filter(([key]) =>
                    [
                      'billing',
                      'supplier_invoice',
                      'appointment',
                      'quote',
                      'refund',
                    ].includes(key),
                  )
                  .map(([value, label]) => folderButton(value, label))}
                <details className="support-more-folders">
                  <summary>
                    Autres dossiers <ChevronDown size={14} aria-hidden="true" />
                  </summary>
                  {Object.entries(CATEGORIES)
                    .filter(
                      ([key]) =>
                        ![
                          'billing',
                          'supplier_invoice',
                          'appointment',
                          'quote',
                          'refund',
                        ].includes(key),
                    )
                    .map(([value, label]) => folderButton(value, label))}
                </details>
              </div>
            </nav>
            <p className="support-nav-label support-settings-label">
              Votre espace
            </p>
            <TabsList
              aria-label="Sections de Zentra Support"
              className="support-nav"
            >
              {sections.filter(s=>s.id!=='automation'||(!demo&&data.automation?.active&&data.gestion?.linked&&data.gestion.organizationId)).map((s) => (
                <TabsTrigger value={s.id} key={s.id}>
                  <s.icon size={19} />
                  {s.label}
                  {s.id === 'inbox' &&
                    (data.counts.review || data.counts.errors) > 0 && (
                      <span className="support-nav-count">
                        {(data.counts.review || 0) + (data.counts.errors || 0)}
                      </span>
                    )}
                </TabsTrigger>
              ))}
            </TabsList>
            <div className="support-sidebar-bottom">
              <ShieldCheck size={20} />
              <strong>Vous gardez la main.</strong>
              <p>
                {!demo && !data.automation?.enabled ? 'Le classement manuel est disponible.' : data.workspace.mode === 'automatic'
                  ? 'Le tri est automatique. Les cas ambigus vous sont confiés.'
                  : data.workspace.mode === 'paused'
                    ? 'Le tri est en pause.'
                    : 'Vous validez chaque affectation avant son application.'}
              </p>
              <a href="/confidentialite">
                Vos données <ArrowUpRight size={15} />
              </a>
            </div>
          </aside>
          <main
            className="support-main"
            data-reading={tab === 'inbox' && !!ticket}
          >
            {noticeView}
            {!demo &&
              data.billing &&
              !data.billing.active &&
              tab !== 'billing' && (
                <div className="support-notice">
                  <span>
                    Préparez votre connexion, puis choisissez une formule Support.
                  </span>
                  <Button variant="outline" onClick={() => setTab('billing')}>
                    Voir les formules
                  </Button>
                </div>
              )}
            <TabsContent value="automation">
              {data.automation?.active && data.gestion?.linked && data.gestion.organizationId ? <div className="automation-page support-automation-workspace"><h1>Automation</h1><AutomationCompanySettings key={data.gestion.organizationId} initialOrganization={data.gestion.organizationId} organizations={[{organizationId:data.gestion.organizationId,organizationName:data.gestion.organizationName||'Votre entreprise',role:data.gestion.role||'read_only'}]}/></div> : <p>Reliez une entreprise avec Automation dans Connexions.</p>}
            </TabsContent>
            <TabsContent value="inbox">
              {!demo && data.billing && !data.billing.active ? (
                <BillingPanel
                  billing={data.billing}
                  owner={data.workspace.role === 'owner'}
                  busy={busy}
                  mutate={mutate}
                />
              ) : (
                <>
                  <div className="support-page-heading">
                    <div>
                      <h1>{folderName}</h1>
                      <p>
                        {!demo && !data.automation?.enabled ? 'Le classement manuel est disponible.' : category
                          ? 'Les demandes de cette catégorie, réunies au même endroit.'
                          : filter === 'review'
                            ? 'Vérifiez la proposition de Zentra avant de la valider.'
                            : filter === 'error'
                              ? 'Retrouvez les demandes qui nécessitent une nouvelle tentative.'
                              : 'Vos demandes organisées, une décision à la fois.'}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      onClick={() => {
                        if (!data.connections.length) setTab('connections');
                        else {
                          setConnection(
                            data.connections.find((c) => c.provider !== 'api')
                              ?.id || '',
                          );
                          setImportOpen(true);
                        }
                      }}
                      disabled={readOnly}
                    >
                      <Plus size={17} />{' '}
                      {data.connections.length
                        ? 'Importer un ticket'
                        : 'Connecter un outil'}
                    </Button>
                  </div>
                  {!demo && data.billing?.active && !data.automation?.enabled && <div className="support-automation-access"><div><strong>{data.automation?.active ? 'Automation est en pause' : 'Disponible avec Zentra Automation'}</strong><p>{data.automation?.active ? 'Vos mails restent accessibles. Activez les fonctions souhaitées dans les réglages de cet espace.' : 'Automatisez vos tâches répétitives pour +15 CHF/mois.'}</p></div><a href={'/compte/automation'+(data.gestion?.organizationId?'?entreprise='+encodeURIComponent(data.gestion.organizationId):'')}>{data.automation?.active?'Régler Automation':'Ajouter Automation'}</a></div>}
                  {(demo || data.automation?.enabled) && !data.workspace.aiReady && (
                    <div className="support-setup">
                      <CircleHelp size={20} />
                      <span>
                        Le tri automatique est en cours d’activation par Zentra.
                        Vous pouvez déjà connecter votre outil.
                      </span>
                      {data.platformOwner && (
                        <a href="/support/admin">Administration</a>
                      )}
                    </div>
                  )}
                  <div className="support-inbox-toolbar">
                    <label className="support-search">
                      <Search size={18} aria-hidden="true" />
                      <input
                        value={search}
                        onChange={(e) => {
                          setSearch(e.target.value);
                          setSelected(null);
                        }}
                        placeholder="Rechercher un sujet ou un numéro…"
                        aria-label="Rechercher un ticket"
                        type="search"
                      />
                    </label>
                    <label className="support-state-filter">
                      <span>État</span>
                      <select
                        aria-label="Filtrer par état"
                        value={filter}
                        onChange={(e) => {
                          setFilter(e.target.value);
                          setSelected(null);
                        }}
                      >
                        <option value="">Tous les états</option>
                        {Object.entries(STATES).map(([value, label]) => (
                          <option value={value} key={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    {(search || filter || category) && (
                      <Button variant="ghost" onClick={() => chooseFolder('')}>
                        Tout afficher
                      </Button>
                    )}
                  </div>
                  <div className="support-inbox-layout" data-detail={!!ticket}>
                    <section
                      className="support-ticket-list"
                      aria-label="Liste des tickets"
                      aria-busy={fetching}
                    >
                      <div className="support-list-heading">
                        <h2 aria-live="polite">
                          {fetching ? 'Chargement…' : 'Demandes'}
                        </h2>
                        <span>
                          {tickets.length}
                          {data.hasMore ? '+' : ''}
                        </span>
                      </div>
                      {tickets.map((t) => (
                        <button
                          key={t.id}
                          className={`support-ticket-row ${selected === t.id ? 'selected' : ''}`}
                          aria-pressed={selected === t.id}
                          disabled={fetching}
                          ref={(node) => {
                            if (node) ticketButtons.current.set(t.id, node);
                            else ticketButtons.current.delete(t.id);
                          }}
                          onClick={() => {
                            setSelected(t.id);
                            requestAnimationFrame(() =>
                              detailHeading.current?.focus({
                                preventScroll: true,
                              }),
                            );
                          }}
                        >
                          <div>
                            <span
                              className="support-ticket-reference"
                              title={t.externalId}
                            >
                              #{t.externalId}
                            </span>
                            {t.decision && (
                              <span
                                className={`support-priority ${t.decision.priority === 'urgent' ? 'urgent' : ''}`}
                              >
                                {PRIORITIES[t.decision.priority]}
                              </span>
                            )}
                          </div>
                          <strong>{t.subject}</strong>
                          <p>{t.body}</p>
                          <footer>
                            <span className="support-category">
                              {t.decision
                                ? CATEGORIES[t.decision.category]
                                : 'À analyser'}
                            </span>
                            <span>{STATES[t.state] || t.state}</span>
                          </footer>
                        </button>
                      ))}
                      {data.hasMore && (
                        <Button
                          variant="ghost"
                          className="support-load-more"
                          disabled={busy || fetching}
                          onClick={() => void load({ append: true })}
                        >
                          Voir les tickets précédents
                        </Button>
                      )}
                      {!tickets.length && !fetching && (
                        <div className="support-empty">
                          <Inbox size={32} />
                          <h3>
                            {search || filter || category
                              ? 'Aucun ticket dans cette vue.'
                              : 'Votre boîte de réception est prête.'}
                          </h3>
                          <p>
                            {search || filter || category
                              ? 'Essayez un autre filtre ou un autre mot.'
                              : 'Les tickets apparaîtront automatiquement dès que votre outil sera connecté.'}
                          </p>
                          {!search && !filter && !category && (
                            <Button
                              variant="link"
                              onClick={() => setTab('connections')}
                            >
                              Configurer les connexions{' '}
                              <ArrowUpRight size={16} />
                            </Button>
                          )}
                        </div>
                      )}
                    </section>
                    <section
                      className="support-detail"
                      aria-label="Détail du ticket"
                    >
                      {ticket ? (
                        <>
                          <Button
                            className="support-mobile-back"
                            variant="ghost"
                            onClick={() => {
                              const id = selected;
                              setSelected(null);
                              requestAnimationFrame(() => {
                                if (id)
                                  ticketButtons.current
                                    .get(id)
                                    ?.focus({ preventScroll: true });
                              });
                            }}
                          >
                            <ArrowLeft size={18} /> Retour à la liste
                          </Button>
                          <div className="support-detail-heading">
                            <span>Ticket #{ticket.externalId}</span>
                            <span className="support-category">
                              {STATES[ticket.state]}
                            </span>
                          </div>
                          <h2 ref={detailHeading} tabIndex={-1}>
                            {ticket.subject}
                          </h2>
                          <p className="support-sender">
                            {connection?.label || 'Connexion archivée'} ·{' '}
                            <time dateTime={new Date(ticket.updatedAt * 1000).toISOString()} suppressHydrationWarning>{formatDate(ticket.updatedAt)}</time>
                          </p>
                          {externalUrl && !demo && (
                            <a
                              className="support-small"
                              href={externalUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Ouvrir dans mon outil <ArrowUpRight size={14} />
                            </a>
                          )}
                          <div className="support-message">{ticket.body}</div>
                          {ticket.error && (
                            <div className="support-notice support-error">
                              <span>{ticket.error}</span>
                              <Button
                                variant="link"
                                onClick={() => setTab('connections')}
                              >
                                Voir les connexions
                              </Button>
                            </div>
                          )}
                          {ticket.decision && (
                            <div className="support-decision">
                              <div>
                                <ShieldCheck size={21} />
                                <h3>
                                  {ticket.decision.manual
                                    ? 'Décision de votre équipe'
                                    : ticket.state === 'review'
                                      ? 'Un regard humain est nécessaire'
                                      : 'La décision de Zentra'}
                                </h3>
                              </div>
                              <dl>
                                <div>
                                  <dt>Catégorie</dt>
                                  <dd>
                                    {CATEGORIES[ticket.decision.category]}
                                  </dd>
                                </div>
                                <div>
                                  <dt>Équipe</dt>
                                  <dd>
                                    {connection?.directory.teams.find(
                                      (t) =>
                                        t.id ===
                                        ticket.decision?.destination?.teamId,
                                    )?.name || 'À choisir'}
                                  </dd>
                                </div>
                                <div>
                                  <dt>Priorité</dt>
                                  <dd>
                                    {PRIORITIES[ticket.decision.priority]}
                                  </dd>
                                </div>
                                {!ticket.decision.manual && (
                                  <div>
                                    <dt>Confiance{demo ? ' — exemple' : ''}</dt>
                                    <dd>
                                      {Math.round(
                                        ticket.decision.confidence * 100,
                                      )}{' '}
                                      %
                                    </dd>
                                  </div>
                                )}
                                {ticket.decision.signals &&
                                  !ticket.decision.manual && (
                                    <>
                                      <div>
                                        <dt>Langue détectée</dt>
                                        <dd>
                                          {ticket.decision.signals
                                            .languageConfidence >= 0.7
                                            ? LANGUAGES[
                                                ticket.decision.signals.language
                                              ]
                                            : 'À confirmer'}
                                        </dd>
                                      </div>
                                      <div>
                                        <dt>Insatisfaction exprimée</dt>
                                        <dd>
                                          {ticket.decision.signals
                                            .frustrationConfidence < 0.7
                                            ? 'À confirmer'
                                            : ticket.decision.signals
                                                  .frustration >= 1.6
                                              ? 'Forte'
                                              : ticket.decision.signals
                                                    .frustration >= 0.6
                                                ? 'Modérée'
                                                : 'Peu ou pas exprimée'}
                                        </dd>
                                      </div>
                                    </>
                                  )}
                              </dl>
                              <p>{ticket.decision.reason}</p>
                              {!ticket.decision.manual && (
                                <p>
                                  Ce score aide au tri ; il ne garantit pas
                                  l’exactitude.
                                </p>
                              )}
                            </div>
                          )}
                          {connection &&
                            ticket.state !== 'processing' &&
                            !readOnly && (
                              <details
                                className="support-review-disclosure"
                                key={ticket.id}
                                open={ticket.state !== 'routed'}
                              >
                                <summary>
                                  {ticket.state === 'routed'
                                    ? 'Modifier le classement'
                                    : 'Vérifier et valider'}
                                  <ChevronDown size={16} aria-hidden="true" />
                                </summary>
                                <ReviewForm
                                  key={ticket.id}
                                  ticket={ticket}
                                  connection={connection}
                                  mutate={mutate}
                                  busy={busy}
                                  readOnly={!!readOnly}
                                />
                                {[
                                  'pending',
                                  'error',
                                  'review',
                                  'routed',
                                ].includes(ticket.state) && (
                                  <Button
                                    variant="ghost"
                                    disabled={
                                      busy || !data.workspace.aiReady || demo || !data.automation?.enabled || readOnly
                                    }
                                    onClick={() =>
                                      mutate({
                                        action: 'retry',
                                        ticketId: ticket.id,
                                        revision: ticket.revision,
                                      })
                                    }
                                  >
                                    Relancer l’analyse
                                  </Button>
                                )}
                              </details>
                            )}
                        </>
                      ) : (
                        <div className="support-empty support-detail-empty">
                          <CircleHelp size={35} />
                          <h3>Sélectionnez une demande</h3>
                          <p>
                            Sélectionnez un ticket pour voir son contenu, sa
                            priorité et son affectation.
                          </p>
                        </div>
                      )}
                    </section>
                  </div>
                </>
              )}
            </TabsContent>
            <TabsContent value="routing">
              <RoutingPanel data={data} mutate={mutate} busy={busy} />
            </TabsContent>
            <TabsContent value="connections">
              <ConnectionsPanel
                data={data}
                mutate={mutate}
                busy={busy}
                demo={demo}
                error={error}
              />
            </TabsContent>
            <TabsContent value="insights">
              <InsightsPanel data={data} />
            </TabsContent>
            <TabsContent value="team">
              <TeamPanel data={data} mutate={mutate} busy={busy} />
            </TabsContent>
            <TabsContent value="billing">
              <BillingPanel
                billing={data.billing}
                owner={data.workspace.role === 'owner'}
                busy={busy}
                mutate={mutate}
                demo={demo}
              />
            </TabsContent>
          </main>
        </Tabs>
      )}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="support-dialog">
          <DialogHeader>
            <DialogTitle>Importer un ticket existant</DialogTitle>
            <DialogDescription>
              Avec Automation actif, le ticket est analysé selon vos règles. En mode automatique, une
              décision suffisamment fiable sera appliquée dans votre outil.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p className="support-notice support-error" role="alert">
              {error}
            </p>
          )}
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (
                await mutate({
                  action: 'importTicket',
                  connectionId,
                  externalId,
                })
              ) {
                setImportOpen(false);
                setExternalId('');
              }
            }}
          >
            <Choice
              label="Connexion"
              value={connectionId}
              onChange={setConnection}
              options={[
                { value: '', label: 'Choisir une connexion' },
                ...data.connections
                  .filter(
                    (c) => c.provider !== 'api' && c.provider !== 'infomaniak',
                  )
                  .map((c) => ({ value: c.id, label: c.label })),
              ]}
            />
            <Field
              label="Numéro du ticket dans votre outil"
              value={externalId}
              onChange={(e) => setExternalId(e.target.value)}
              required
              maxLength={100}
            />
            <Button
              className="support-primary"
              disabled={busy || !connectionId || demo}
              type="submit"
            >
              {busy ? 'Analyse…' : 'Importer et analyser'}
            </Button>
            {!data.connections.some(
              (c) => c.provider !== 'api' && c.provider !== 'infomaniak',
            ) && (
              <p>
                Avec une connexion API, envoyez le ticket depuis votre outil. Le
                guide se trouve dans Connexions.
              </p>
            )}
            {demo && (
              <a href="/support/espace">Configurer mon véritable espace</a>
            )}
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
