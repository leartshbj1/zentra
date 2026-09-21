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

const sections = [
  { id: 'inbox', label: 'Tickets', icon: Inbox },
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
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const [name, setName] = useState(''),
    [importOpen, setImportOpen] = useState(false),
    [connectionId, setConnection] = useState(''),
    [externalId, setExternalId] = useState('');
  const sequence = useRef(0),
    busyRef = useRef(false),
    dataRef = useRef(data),
    workspaceRef = useRef(workspaceId);
  dataRef.current = data;
  workspaceRef.current = workspaceId;
  useEffect(() => {
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
      options: { append?: boolean; workspace?: string; quiet?: boolean } = {},
    ) => {
      if (demo) return;
      const request = ++sequence.current,
        params = new URLSearchParams(),
        id = options.workspace ?? workspaceRef.current;
      if (id) params.set('workspace', id);
      if (query) params.set('search', query);
      if (filter) params.set('state', filter);
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
        if (request === sequence.current) setLoading(false);
      }
    },
    [demo, query, filter],
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
      if (result.workspaceId) {
        setWorkspace(result.workspaceId);
        await load({ workspace: result.workspaceId });
      } else await load();
      if (result.ticketId) {
        setSelected(result.ticketId);
        setTab('inbox');
        setFilter('');
        setSearch('');
      }
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
  const tickets = demo
    ? data.tickets.filter(
        (t) =>
          (!filter || t.state === filter) &&
          `${t.subject} ${t.externalId}`
            .toLowerCase()
            .includes(query.toLowerCase()),
      )
    : data.tickets;
  const ticket = data.tickets.find((t) => t.id === selected),
    connection = data.connections.find((c) => c.id === ticket?.connectionId),
    readOnly = data.workspace?.role === 'read_only';
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
                }}
              />
            </div>
            <TabsList
              aria-label="Sections de Zentra Support"
              className="support-nav"
            >
              {sections.map((s) => (
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
                {data.workspace.mode === 'automatic'
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
          <main className="support-main">
            {noticeView}
            {!demo &&
              data.billing &&
              !data.billing.active &&
              tab !== 'billing' && (
                <div className="support-notice">
                  <span>
                    Préparez votre connexion, puis choisissez une formule pour
                    activer le tri.
                  </span>
                  <Button variant="outline" onClick={() => setTab('billing')}>
                    Voir les formules
                  </Button>
                </div>
              )}
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
                      <p className="support-eyebrow">
                        LE BON TICKET. LA BONNE ÉQUIPE.
                      </p>
                      <h1>Votre support, bien orienté.</h1>
                      <p>
                        {data.workspace.mode === 'automatic'
                          ? 'Le tri s’occupe de l’ordre. Votre équipe s’occupe des clients.'
                          : 'Vérifiez vos premières décisions, puis activez le tri automatique.'}
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
                  {!data.workspace.aiReady && (
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
                  <div
                    className="support-filters"
                    aria-label="Filtrer les tickets"
                  >
                    {[
                      ['', 'Tous'],
                      ['review', 'À vérifier'],
                      ['error', 'À reprendre'],
                      ['ready', 'À appliquer'],
                      ['routed', 'Affectés'],
                      ['pending', 'En attente'],
                    ].map(([value, label]) => (
                      <Button
                        key={value}
                        variant="ghost"
                        aria-pressed={filter === value}
                        onClick={() => {
                          setFilter(value);
                          setSelected(null);
                        }}
                      >
                        {label}
                      </Button>
                    ))}
                  </div>
                  <div className="support-inbox-layout" data-detail={!!ticket}>
                    <section className="support-ticket-list">
                      <div className="support-list-heading">
                        <h2>Boîte de réception</h2>
                        <span>
                          {tickets.length}
                          {data.hasMore ? '+' : ''}
                        </span>
                      </div>
                      <label className="support-search">
                        <Search size={18} />
                        <input
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                          placeholder="Rechercher un ticket"
                          aria-label="Rechercher un ticket"
                        />
                      </label>
                      {tickets.map((t) => (
                        <button
                          key={t.id}
                          className={`support-ticket-row ${selected === t.id ? 'selected' : ''}`}
                          onClick={() => setSelected(t.id)}
                        >
                          <div>
                            <span>#{t.externalId}</span>
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
                          disabled={busy}
                          onClick={() => void load({ append: true })}
                        >
                          Voir les tickets précédents
                        </Button>
                      )}
                      {!tickets.length && (
                        <div className="support-empty">
                          <Inbox size={32} />
                          <h3>
                            {search || filter
                              ? 'Aucun ticket dans cette vue.'
                              : 'Votre boîte de réception est prête.'}
                          </h3>
                          <p>
                            {search || filter
                              ? 'Essayez un autre filtre ou un autre mot.'
                              : 'Les tickets apparaîtront automatiquement dès que votre outil sera connecté.'}
                          </p>
                          {!search && !filter && (
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
                    <section className="support-detail">
                      {ticket ? (
                        <>
                          <Button
                            className="support-mobile-back"
                            variant="ghost"
                            onClick={() => setSelected(null)}
                          >
                            <ArrowLeft size={18} /> Tous les tickets
                          </Button>
                          <div className="support-detail-heading">
                            <span>Ticket #{ticket.externalId}</span>
                            <span className="support-category">
                              {STATES[ticket.state]}
                            </span>
                          </div>
                          <h2>{ticket.subject}</h2>
                          <p className="support-sender">
                            {connection?.label || 'Connexion archivée'} ·{' '}
                            {formatDate(ticket.updatedAt)}
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
                              <>
                                <ReviewForm
                                  key={ticket.id}
                                  ticket={ticket}
                                  connection={connection}
                                  mutate={mutate}
                                  busy={busy}
                                  readOnly={!!readOnly}
                                />
                                {['pending', 'error', 'review', 'routed'].includes(
                                  ticket.state,
                                ) && (
                                  <Button
                                    variant="ghost"
                                    disabled={
                                      busy || !data.workspace.aiReady || demo
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
                              </>
                            )}
                        </>
                      ) : (
                        <div className="support-empty support-detail-empty">
                          <CircleHelp size={35} />
                          <h3>Une décision, en un coup d’œil.</h3>
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
              Le ticket sera analysé selon vos règles. En mode automatique, une
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
