'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  Clock,
  Plus,
  RotateCcw,
  Workflow,
  X,
} from 'lucide-react';
import type { WorkflowDefinition } from './automationWorkflowTypes';
import './AutomationControlCentre.css';
import { AutomationJournal } from './AutomationJournal';
import type { AutomationActivity } from './automation';
import type { BriefDestination } from './AutomationBrief';
import { useAppLanguage } from './language';
import { automationRunStatus } from './automationPresentation';

type Rule = {
  id: string;
  name: string;
  enabled: boolean;
  revision: number;
  definition: WorkflowDefinition;
};
type Run = {
  id: string;
  title: string;
  state: string;
  revision: number;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  dueAt: number;
  definition: WorkflowDefinition;
  result: {
    choice?: string;
    approvedChoice?: string;
    confidence?: number;
    message?: string;
    summary?: {
      subject: string;
      sender: string;
      excerpts: { text: string }[];
      attachments: string[];
      truncated: boolean;
    };
    steps?: {
      index: number;
      title: string;
      type: string;
      state: string;
      at: number;
    }[];
  };
};
type WorkItem = {
  id: string;
  title: string;
  body: string;
  kind: string;
  state: string;
  revision: number;
  assigned_to: string | null;
  created_at: number;
};
export type AutomationCentreState = {
  organizationId: string;
  canManage: boolean;
  canWork: boolean;
  rules: Rule[];
  runs: Run[];
  items: WorkItem[];
  templates: {
    id: string;
    name: string;
    description: string;
    definition: WorkflowDefinition;
  }[];
  members: { user_id: string; name: string; role: string }[];
};
type Requester = (body: Record<string, unknown>) => Promise<unknown>;
const modes = {
  shadow: 'Observer sans agir',
  suggest: 'Me demander de confirmer',
  automatic: 'Exécuter si la confiance suffit',
  notify: 'Exécuter puis notifier',
};
const actions = {
  task: 'Créer une tâche',
  notify: 'Notifier dans Automation',
  reply_draft: 'Préparer une réponse',
  summary: 'Résumé du message reçu',
  review: 'Demander une vérification',
};
const categories = {
  supplier_invoice: 'Facture fournisseur',
  quote: 'Devis',
  order: 'Commande',
  after_sales: 'SAV',
  appointment: 'Rendez-vous',
  complaint: 'Réclamation',
  administration: 'Administratif',
  human_resources: 'Ressources humaines',
  spam: 'Indésirable',
  bug: 'Problème technique',
  billing: 'Facturation',
  credit_note: 'Avoir',
  payment_reminder: 'Rappel de paiement',
  receipt: 'Reçu',
  product: 'Question produit',
  refund: 'Remboursement',
  shipping: 'Livraison',
  account: 'Compte et accès',
  other: 'Autre',
};
const date = (n: number) =>
  new Intl.DateTimeFormat('fr-CH', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(n * 1000);

export function AutomationControlCentre({
  organizationId,
  request, initialTab = 'review', embedded = false, hideNavigation = false, hideRules = false,
  activity, onOpen,
}: {
  organizationId: string;
  request: Requester;
  initialTab?: 'review' | 'work' | 'history' | 'rules';
  embedded?: boolean; hideNavigation?: boolean; hideRules?: boolean;
  activity?: AutomationActivity | null; onOpen?: (destination: BriefDestination) => void;
}) {
  const [data, setData] = useState<AutomationCentreState | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [tab, setTab] = useState<'review' | 'work' | 'history' | 'rules'>(initialTab);
  useEffect(() => { setTab(initialTab); setEditing(null); }, [initialTab]);
  const [editing, setEditing] = useState<Rule | null>(null),
    [notice, setNotice] = useState('');
  const api = useRef(request),
    alive = useRef(true),
    inflight = useRef(false),
    sequence = useRef(0),
    acting = useRef(false);
  api.current = request;
  const load = useCallback(async (force = false) => {
    if (inflight.current && !force) return;
    const requestNumber = ++sequence.current;
    inflight.current = true;
    try {
      const next = (await api.current({
        action: 'centre',
      })) as AutomationCentreState;
      if (alive.current && requestNumber === sequence.current && next.organizationId === organizationId) {
        setData(next);
        setError('');
      }
    } catch (e) {
      if (alive.current && requestNumber === sequence.current)
        setError(
          e instanceof Error
            ? e.message
            : 'Le centre Automation est indisponible. Réessayez.',
        );
    } finally {
      if (requestNumber === sequence.current) inflight.current = false;
    }
  }, [organizationId]);
  useEffect(() => {
    alive.current = true;
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') void load();
    }, 30000);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [load]);
  async function action(body: Record<string, unknown>) {
    if (acting.current) return false;
    acting.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api.current(body);
      if (alive.current) {
        setNotice('Modification enregistrée.');
        await load(true);
      }
      return true;
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : 'Réessayez.');
      return false;
    } finally {
      acting.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const review =
      data?.runs.filter((r) => r.state === 'review' || r.state === 'failed') ||
      [],
    work = data?.items.filter((i) => i.state === 'open') || [];
  return (
    <section className={`automation-centre${embedded ? " automation-centre--embedded" : ""}`} aria-label="Centre Automation">
      {!embedded && <header className="automation-centre__heading">
        <div>
          <h2>Votre centre Automation</h2>
          <p>Les actions de votre équipe, au même endroit.</p>
        </div>
        <button
          type="button"
          className="ac-quiet"
          onClick={() => void load()}
          disabled={busy}
          aria-label="Actualiser le centre Automation"
        >
          <RotateCcw size={18} />
        </button>
      </header>}
      {!hideNavigation && <nav
        className="automation-centre__tabs"
        aria-label="Vue du centre Automation"
      >
        {(
          [
            ['review', 'À vérifier', review.length],
            ['work', 'À faire', work.length],
            ['history', 'Historique', 0],
            ['rules', 'Règles', 0],
          ] as const
        ).filter(([id]) => !hideRules || id !== 'rules').map(([id, label, count]) => (
          <button
            key={id}
            type="button"
            aria-current={tab === id ? 'page' : undefined}
            onClick={() => {
              setTab(id);
              setEditing(null);
            }}
          >
            {label}
            {count > 0 && <span>{count}</span>}
          </button>
        ))}
      </nav>}
      {error && (
        <p className="ac-message" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="ac-message" role="status">
          {notice}
        </p>
      )}
      {!data && !error && <p role="status">Chargement du centre…</p>}
      {data && tab === 'review' && (
        <div className="ac-list">
          {review.length === 0 ? (
            <div className="ac-empty">
              <Check size={24} />
              <h3>Rien à vérifier</h3>
              <p>Les règles qui demandent votre accord apparaîtront ici.</p>
            </div>
          ) : (
            review.map((run) => (
              <RunRow
                key={run.id}
                run={run}
                canManage={data.canManage}
                busy={busy}
                act={action}
              />
            ))
          )}
          <p className="ac-footnote">
            Les factures et rendez-vous reçus conservent leurs contrôles dans
            les écrans de réception de Gestion.
          </p>
        </div>
      )}
      {data && tab === 'work' && (
        <div className="ac-list">
          {work.length === 0 ? (
            <div className="ac-empty">
              <Check size={24} />
              <h3>Tout est à jour</h3>
              <p>
                Les tâches, notifications et brouillons créés par vos règles
                apparaîtront ici.
              </p>
            </div>
          ) : (
            work.map((item) => (
              <article key={item.id} className="ac-item">
                <div className="ac-item__body">
                  <span className="ac-meta">
                    {actions[item.kind as keyof typeof actions] || 'Action'} ·{' '}
                    {date(item.created_at)}
                  </span>
                  <h3>{item.title}</h3>
                  {item.assigned_to && (
                    <p className="ac-meta">
                      Pour{' '}
                      {data.members.find((m) => m.user_id === item.assigned_to)
                        ?.name || 'un collaborateur'}
                    </p>
                  )}
                  <details className="ac-item__details"><summary>{item.kind === 'reply_draft' ? 'Relire la réponse' : 'Voir le détail'}</summary>
                  {item.kind === 'reply_draft' ? (
                    <ReplyDraft
                      item={item}
                      busy={busy || !data.canWork}
                      save={action}
                    />
                  ) : (
                    <p className="ac-preserve">{item.body}</p>
                  )}</details>
                </div>
                <div className="ac-actions">
                  <button
                    type="button"
                    onClick={() =>
                      void action({
                        action: 'work_item_update',
                        id: item.id,
                        revision: item.revision,
                        state: 'done',
                      })
                    }
                    disabled={busy || !data.canWork}
                  >
                    <Check size={16} />
                    {item.kind === 'notify' ? 'Lu' : 'Terminé'}
                  </button>
                  <button
                    type="button"
                    className="ac-quiet"
                    aria-label={`Écarter · ${item.title}`}
                    disabled={busy || !data.canWork}
                    onClick={() =>
                      void action({
                        action: 'work_item_update',
                        id: item.id,
                        revision: item.revision,
                        state: 'dismissed',
                      })
                    }
                  >
                    <X size={16} />
                  </button>
                </div>
              </article>
            ))
          )}
        </div>
      )}
      {data && tab === 'history' && embedded && <AutomationJournal runs={data.runs} activity={activity} openInvoices={onOpen ? () => onOpen('invoices') : undefined} renderRun={run => <RunRow run={run} canManage={data.canManage} busy={busy} act={action}/>}/>}
      {data && tab === 'history' && !embedded && (
        <div className="ac-list">
          {!data.runs.length ? (
            <div className="ac-empty">
              <Clock size={24} />
              <h3>L’historique commence avec vos règles</h3>
              <p>Chaque exécution indiquera ses étapes et son résultat réel.</p>
            </div>
          ) : (
            data.runs.map((run) => (
              <RunRow
                key={run.id}
                run={run}
                canManage={data.canManage}
                busy={busy}
                act={action}
              />
            ))
          )}
        </div>
      )}
      {data &&
        tab === 'rules' &&
        (editing ? (
          <RuleEditor
            rule={editing}
            members={data.members}
            busy={busy}
            request={api.current}
            onClose={() => setEditing(null)}
            onSave={async (value) => {
              if (acting.current) return;
              acting.current = true;
              setBusy(true);
              setError('');
              try {
                await api.current({ action: 'workflow_save', ...value });
                if (alive.current) {
                  setEditing(null);
                  setNotice(
                    'Règle enregistrée. Elle s’applique aux prochains messages classés.',
                  );
                  await load(true);
                }
              } catch (e) {
                if (alive.current)
                  setError(
                    e instanceof Error
                      ? e.message
                      : 'La règle n’a pas pu être enregistrée.',
                  );
              } finally {
                acting.current = false;
                if (alive.current) setBusy(false);
              }
            }}
          />
        ) : (
          <>
            <div className="ac-section">
              <h3>Vos règles</h3>
              <p>
                Déclencheur actuel : un message classé dans Support. Les actions
                créent des tâches, notifications ou brouillons dans ce centre.
              </p>
            </div>
            {data.rules.map((rule) => (
              <article className="ac-rule" key={rule.id}>
                <div>
                  <h4>{rule.name}</h4>
                  <p>
                    {rule.enabled ? modes[rule.definition.mode] : 'En pause'} ·{' '}
                    {rule.definition.actions.length} action
                    {rule.definition.actions.length > 1 ? 's' : ''}
                  </p>
                </div>
                {data.canManage && (
                  <button
                    className="ac-quiet"
                    type="button"
                    onClick={() => setEditing(structuredClone(rule))}
                  >
                    Modifier
                  </button>
                )}
              </article>
            ))}
            {data.canManage ? (
              <>
                <div className="ac-section">
                  <h3>Commencer avec un modèle</h3>
                  <p>Personnalisez-le et choisissez quand il peut agir.</p>
                </div>
                <div className="ac-templates">
                  {data.templates.map((template) => (
                    <button
                      type="button"
                      className="ac-template"
                      key={template.id}
                      onClick={() =>
                        setEditing({
                          id: '',
                          revision: 0,
                          enabled: false,
                          name: template.name,
                          definition: structuredClone(template.definition),
                        })
                      }
                    >
                      <Workflow size={20} />
                      <span>
                        <strong>{template.name}</strong>
                        <small>{template.description}</small>
                      </span>
                      <Plus size={18} />
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <p>
                Le titulaire ou un administrateur peut ajouter et modifier les
                règles de votre entreprise.
              </p>
            )}
          </>
        ))}
    </section>
  );
}
function ReplyDraft({
  item,
  busy,
  save,
}: {
  item: WorkItem;
  busy: boolean;
  save: (v: Record<string, unknown>) => Promise<unknown>;
}) {
  const [value, setValue] = useState(item.body),
    [copied, setCopied] = useState(false),
    [problem, setProblem] = useState('');
  const base = useRef({ body: item.body, revision: item.revision });
  useEffect(() => {
    if (value === base.current.body) {
      setValue(item.body);
      base.current = { body: item.body, revision: item.revision };
    }
  }, [item.body, item.revision, value]);
  const changed = value !== base.current.body,
    conflict = !busy && item.revision !== base.current.revision && changed;
  return (
    <div className="ac-draft">
      <label htmlFor={'draft-' + item.id}>Brouillon à relire</label>
      <textarea
        id={'draft-' + item.id}
        value={value}
        maxLength={8000}
        onChange={(e) => {
          setValue(e.target.value);
          setCopied(false);
        }}
        rows={6}
      />
      <div className="ac-actions">
        <button
          type="button"
          disabled={busy || !changed || conflict}
          onClick={() => {
            setProblem('');
            void save({
              action: 'work_item_update',
              id: item.id,
              revision: base.current.revision,
              body: value,
            })
              .then((saved) => {
                if (saved === false) {
                  setProblem(
                    'Le brouillon n’a pas été enregistré. Votre texte reste ici.',
                  );
                  return;
                }
                base.current = {
                  body: value,
                  revision: base.current.revision + 1,
                };
              })
              .catch(() =>
                setProblem(
                  'Le brouillon n’a pas été enregistré. Votre texte reste ici.',
                ),
              );
          }}
        >
          Enregistrer pour l’équipe
        </button>
        <button
          type="button"
          className="ac-quiet"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(value)
              .then(() => setCopied(true))
              .catch(() => setProblem('Sélectionnez le texte pour le copier.'));
          }}
        >
          {copied ? 'Copié' : 'Copier la réponse'}
        </button>
      </div>
      {conflict && (
        <p role="alert">
          Un collègue a modifié ce brouillon. Copiez votre texte avant de
          recharger sa version.
          <button
            className="ac-quiet"
            type="button"
            onClick={() => {
              setValue(item.body);
              base.current = { body: item.body, revision: item.revision };
            }}
          >
            Charger la version enregistrée
          </button>
        </p>
      )}
      {problem && <p role="alert">{problem}</p>}
      <small>Aucun message n’est envoyé automatiquement.</small>
    </div>
  );
}
function RunRow({
  run,
  canManage,
  busy,
  act,
}: {
  run: Run;
  canManage: boolean;
  busy: boolean;
  act: (v: Record<string, unknown>) => Promise<unknown>;
}) {
  const [choice, setChoice] = useState('');
  const language = useAppLanguage();
  return (
    <details className="ac-run">
      <summary>
        <span>
          <strong>{run.title}</strong>
          <small>{new Intl.DateTimeFormat(`${language}-CH`,{dateStyle:'short',timeStyle:'short',timeZone:'Europe/Zurich'}).format((run.updatedAt || run.createdAt)*1000)}</small>
        </span>
        <span className="ac-status" data-state={run.state}>
          {automationRunStatus(run.state, language)}
        </span>
        <ChevronDown size={16} />
      </summary>
      <div className="ac-run__detail">
        <p>{run.result.message}</p>
        {run.result.summary && (
          <details className="ac-source">
            <summary>Message reçu · {run.result.summary.subject}</summary>
            <p className="ac-meta">
              De {run.result.summary.sender || 'l’expéditeur du ticket'}
            </p>
            {run.result.summary.excerpts.map((e, i) => (
              <blockquote key={i}>{e.text}</blockquote>
            ))}
            {run.result.summary.attachments.length > 0 && (
              <p>
                Pièces jointes : {run.result.summary.attachments.join(', ')}
              </p>
            )}
            <small>
              Extraits du texte reçu
              {run.result.summary.truncated ? ', abrégés' : ''}. Vérifiez le
              message complet avant une décision.
            </small>
          </details>
        )}
        {typeof run.result.confidence === 'number' && (
          <p className="ac-meta">
            Confiance : {Math.round(run.result.confidence * 100)} % ·{' '}
            {run.attempts} essai{run.attempts > 1 ? 's' : ''}. Ce score ne
            garantit pas l’exactitude.
          </p>
        )}
        {run.dueAt > 0 && <p>Prochaine étape : {date(run.dueAt)}</p>}
        <ol>
          {run.definition.actions.map((a, index) => {
            const s = run.result.steps?.find((s) => s.index === index);
            return (
              <li key={index}>
                <strong>{actions[a.type]}</strong> ·{' '}
                {a.title.replace(
                  /\{\{objet\}\}/g,
                  () => run.result.summary?.subject || 'Message reçu',
                )}
                <span>
                  {s?.state === 'completed'
                    ? 'Créé'
                    : s?.state === 'skipped'
                      ? 'Branche non retenue'
                      : run.state === 'observed'
                        ? 'Simulation uniquement'
                        : 'En attente'}
                </span>
              </li>
            );
          })}
        </ol>
        {canManage && (
          <div className="ac-actions">
            {run.state === 'review' &&
              run.result.choice === 'uncertain' &&
              run.definition.decision && (
                <label>
                  Choisir la suite
                  <select
                    value={choice}
                    onChange={(e) => setChoice(e.target.value)}
                  >
                    <option value="">Choisir une branche</option>
                    <option value="yes">
                      Oui · {run.definition.decision.yes}
                    </option>
                    <option value="no">
                      Non · {run.definition.decision.no}
                    </option>
                  </select>
                </label>
              )}
            {run.state === 'review' && (
              <button
                disabled={
                  busy || (run.result.choice === 'uncertain' && !choice)
                }
                type="button"
                onClick={() =>
                  void act({
                    action: 'workflow_confirm',
                    id: run.id,
                    revision: run.revision,
                    choice: choice || undefined,
                  })
                }
              >
                Confirmer les actions
              </button>
            )}
            {run.state === 'failed' && (
              <button
                disabled={busy || run.attempts >= 5}
                type="button"
                onClick={() =>
                  void act({
                    action: 'workflow_retry',
                    id: run.id,
                    revision: run.revision,
                  })
                }
              >
                Réessayer
              </button>
            )}
            {['review', 'failed', 'waiting', 'queued'].includes(run.state) && (
              <button
                disabled={busy}
                className="ac-quiet"
                type="button"
                onClick={() =>
                  void act({
                    action: 'workflow_cancel',
                    id: run.id,
                    revision: run.revision,
                  })
                }
              >
                Annuler la suite
              </button>
            )}
            {run.state === 'completed' && (
              <button
                disabled={busy}
                className="ac-quiet"
                type="button"
                onClick={() =>
                  void act({
                    action: 'workflow_undo',
                    id: run.id,
                    revision: run.revision,
                  })
                }
              >
                Annuler les éléments inutilisés
              </button>
            )}
          </div>
        )}
      </div>
    </details>
  );
}
function RuleEditor({
  rule,
  members,
  busy,
  onSave,
  onClose,
  request,
}: {
  rule: Rule;
  members: AutomationCentreState['members'];
  busy: boolean;
  onSave: (v: Record<string, unknown>) => Promise<unknown>;
  onClose: () => void;
  request: Requester;
}) {
  const [draft, setDraft] = useState(rule),
    [preview, setPreview] = useState<{
      matched: boolean;
      message: string;
      actions: { title: string; body: string }[];
    } | null>(null),
    [problem, setProblem] = useState(''),
    [testing, setTesting] = useState(false);
  const d = draft.definition;
  const edit = (change: Partial<WorkflowDefinition>) => {
    setDraft({ ...draft, definition: { ...d, ...change } });
    setPreview(null);
  };
  const changeAction = (
    i: number,
    change: Partial<WorkflowDefinition['actions'][number]>,
  ) =>
    edit({
      actions: d.actions.map((a, n) => (n === i ? { ...a, ...change } : a)),
    });
  return (
    <form
      className="ac-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave({ ...draft, id: draft.id || undefined });
      }}
    >
      <div className="ac-editor__heading">
        <h3>{draft.id ? 'Modifier la règle' : 'Nouvelle règle'}</h3>
        <button
          type="button"
          className="ac-quiet"
          onClick={onClose}
          disabled={busy}
        >
          Fermer
        </button>
      </div>
      <label>
        Nom de la règle
        <input
          value={draft.name}
          maxLength={120}
          required
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
      </label>
      <fieldset>
        <legend>Quand</legend>
        <p className="ac-trigger">Un message est classé dans Zentra Support</p>
      </fieldset>
      <fieldset>
        <legend>Si</legend>
        <div className="ac-fields">
          <label>
            Catégorie
            <select
              value={d.conditions.category}
              onChange={(e) =>
                edit({
                  conditions: { ...d.conditions, category: e.target.value },
                })
              }
            >
              <option value="">Toutes les catégories</option>
              {Object.entries(categories).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Priorité
            <select
              value={d.conditions.priority}
              onChange={(e) =>
                edit({
                  conditions: { ...d.conditions, priority: e.target.value },
                })
              }
            >
              <option value="">Toutes les priorités</option>
              <option value="urgent">Urgente</option>
              <option value="high">Élevée</option>
              <option value="normal">Normale</option>
              <option value="low">Basse</option>
            </select>
          </label>
          <label>
            Expéditeur précis, facultatif
            <input
              type="email"
              value={d.conditions.sender}
              placeholder="contact@exemple.ch"
              onChange={(e) =>
                edit({
                  conditions: { ...d.conditions, sender: e.target.value },
                })
              }
            />
          </label>
        </div>
        <label className="ac-check">
          <input
            type="checkbox"
            checked={d.conditions.attachment}
            onChange={(e) =>
              edit({
                conditions: { ...d.conditions, attachment: e.target.checked },
              })
            }
          />
          Seulement avec une pièce jointe
        </label>
      </fieldset>
      <fieldset>
        <legend>Décision de Zentra</legend>
        <label className="ac-check">
          <input
            type="checkbox"
            checked={!!d.decision}
            onChange={(e) =>
              edit({
                decision: e.target.checked
                  ? { question: '', yes: '', no: '' }
                  : null,
                actions: d.actions.map((a) => ({ ...a, branch: 'always' })),
              })
            }
          />
          Ajouter une décision pour choisir une branche
        </label>
        {d.decision && (
          <div className="ac-fields">
            <label>
              Question
              <textarea
                rows={2}
                required
                value={d.decision.question}
                maxLength={500}
                onChange={(e) =>
                  edit({
                    decision: { ...d.decision!, question: e.target.value },
                  })
                }
              />
            </label>
            <label>
              Branche Oui
              <input
                required
                maxLength={200}
                value={d.decision.yes}
                onChange={(e) =>
                  edit({ decision: { ...d.decision!, yes: e.target.value } })
                }
              />
            </label>
            <label>
              Branche Non
              <input
                required
                maxLength={200}
                value={d.decision.no}
                onChange={(e) =>
                  edit({ decision: { ...d.decision!, no: e.target.value } })
                }
              />
            </label>
          </div>
        )}
        <p className="ac-help">
          Une réponse incertaine demande une validation. Cette décision ne
          valide jamais un paiement ni une décision RH.
        </p>
      </fieldset>
      <fieldset>
        <legend>Alors</legend>
        {d.actions.map((a, i) => (
          <div className="ac-action-editor" key={i}>
            <div className="ac-fields">
              <label>
                Action
                <select
                  value={a.type}
                  onChange={(e) =>
                    changeAction(i, { type: e.target.value as typeof a.type })
                  }
                >
                  {Object.entries(actions).map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              {d.decision && (
                <label>
                  Branche
                  <select
                    value={a.branch}
                    onChange={(e) =>
                      changeAction(i, {
                        branch: e.target.value as typeof a.branch,
                      })
                    }
                  >
                    <option value="always">Dans tous les cas</option>
                    <option value="yes">Si Oui</option>
                    <option value="no">Si Non</option>
                  </select>
                </label>
              )}
              <label>
                Titre
                <input
                  required
                  value={a.title}
                  maxLength={160}
                  onChange={(e) => changeAction(i, { title: e.target.value })}
                />
              </label>
              <label>
                Pour
                <select
                  value={a.assignedTo}
                  onChange={(e) =>
                    changeAction(i, { assignedTo: e.target.value })
                  }
                >
                  <option value="">Toute l’équipe</option>
                  {members.map((m) => (
                    <option key={m.user_id} value={m.user_id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Attendre, en heures
                <input
                  type="number"
                  min={0}
                  max={720}
                  step={1}
                  value={a.delayHours}
                  onChange={(e) =>
                    changeAction(i, { delayHours: Number(e.target.value) })
                  }
                />
              </label>
            </div>
            <label>
              {a.type === 'reply_draft'
                ? 'Modèle de réponse'
                : a.type === 'summary'
                  ? 'Note interne, facultative'
                  : 'Instructions'}
              <textarea
                rows={3}
                maxLength={4000}
                required={a.type === 'reply_draft'}
                value={a.body}
                onChange={(e) => changeAction(i, { body: e.target.value })}
              />
            </label>
            <p className="ac-help">
              Champs disponibles : {'{{objet}}'}, {'{{expediteur}}'},{' '}
              {'{{categorie}}'} et {'{{priorite}}'}.
            </p>
            {d.actions.length > 1 && (
              <button
                className="ac-quiet"
                type="button"
                onClick={() =>
                  edit({ actions: d.actions.filter((_, n) => n !== i) })
                }
              >
                Retirer cette action
              </button>
            )}
          </div>
        ))}
        {d.actions.length < 8 && (
          <button
            type="button"
            className="ac-quiet"
            onClick={() =>
              edit({
                actions: [
                  ...d.actions,
                  {
                    type: 'task',
                    title: 'Suivre · {{objet}}',
                    body: '',
                    delayHours: 0,
                    branch: 'always',
                    assignedTo: '',
                  },
                ],
              })
            }
          >
            <Plus size={16} />
            Ajouter une action
          </button>
        )}
      </fieldset>
      <fieldset>
        <legend>Autonomie</legend>
        <div className="ac-fields">
          <label>
            Comportement
            <select
              value={d.mode}
              onChange={(e) => edit({ mode: e.target.value as typeof d.mode })}
            >
              {Object.entries(modes).map(([v, label]) => (
                <option value={v} key={v}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Confiance minimale, en %
            <input
              type="number"
              min={80}
              max={100}
              step={1}
              value={Math.round(d.threshold * 100)}
              onChange={(e) =>
                edit({ threshold: Number(e.target.value) / 100 })
              }
            />
          </label>
        </div>
        <label className="ac-check">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
          />
          Activer pour les prochains messages
        </label>
        <p className="ac-help">
          Une règle arrêtée conserve son historique. Les demandes RH restent à
          confirmer. Les brouillons ne sont jamais envoyés.
        </p>
      </fieldset>
      <div className="ac-editor__footer">
        <button type="submit" disabled={busy}>
          Enregistrer la règle
        </button>
        <button
          type="button"
          className="ac-quiet"
          disabled={busy || testing}
          onClick={() => {
            setTesting(true);
            setProblem('');
            void request({
              action: 'workflow_preview',
              definition: d,
              sample: {
                subject: 'Demande de test',
                sender: d.conditions.sender || 'contact@exemple.ch',
                category: d.conditions.category || 'after_sales',
                priority: d.conditions.priority || 'normal',
                attachments: d.conditions.attachment ? ['document.pdf'] : [],
              },
            })
              .then((v) => setPreview(v as typeof preview))
              .catch((e) =>
                setProblem(
                  e instanceof Error ? e.message : 'Vérifiez la règle.',
                ),
              )
              .finally(() => setTesting(false));
          }}
        >
          Simuler avec un exemple
        </button>
      </div>
      {problem && <p role="alert">{problem}</p>}
      {preview && (
        <div className="ac-preview">
          <h4>
            Exemple fictif ·{' '}
            {preview.matched
              ? 'conditions remplies'
              : 'conditions non remplies'}
          </h4>
          <p>{preview.message}</p>
          {preview.actions.map((a, i) => (
            <div key={i}>
              <strong>{a.title}</strong>
              <p className="ac-preserve">{a.body}</p>
            </div>
          ))}
        </div>
      )}
    </form>
  );
}
