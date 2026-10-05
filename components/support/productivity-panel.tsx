'use client';
import { useState, type ReactNode } from 'react';
import { siteCount } from 'zentra:site-language';
import { Button } from '@/components/ui/button';
import { Check, ShieldCheck, CalendarClock, ArrowUpRight } from 'lucide-react';
import { CATEGORIES } from '@/lib/support/types';
import type { SenderPolicy } from '@/lib/support/sender-policies';
import { Choice, formatDate } from './controls';
import type { Mutate, SupportState, SupportTicket } from './model';
import type { Draft } from './solicitation-panel';
import { dispositionLabel } from './solicitation-panel';
const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <label className="support-field">
    <span>{label}</span>
    {children}
  </label>
);

export function DailyBrief({
  data,
  openConnections,
  openTicket,
}: {
  data: SupportState;
  openConnections: () => void;
  openTicket: (id: string) => void;
}) {
  const p = data.productivity;
  if (!p) return null;
  const due = p.followups.filter(
      (f) => f.state === 'open' && f.dueAt <= Date.now() / 1000,
    ),
    errors = p.health.filter((h) => h.lastError || h.checkError);
  return (
    <section className="support-daily" aria-label="Bilan du jour">
      <div>
        <h2>
          {data.user.name
            ? `Bonjour ${data.user.name.split(' ')[0]}.`
            : 'Bonjour.'}{' '}
          Voici votre journée.
        </h2>
        <p>
          {siteCount('sortedToday',p.daily.sorted)}
          {p.daily.quiet > 0
            ? <>, dont {siteCount('solicitations',p.daily.quiet)}</>
            : ''}
          .
          {p.daily.gestion && (
            <>
              {' '}
              {siteCount('invoices',p.daily.gestion.invoices)} et{' '}
              {p.daily.gestion.appointments} rendez-vous importés dans Gestion.
            </>
          )}{' '}
          {siteCount('pendingMessages',p.daily.pending)}
          {p.daily.gestion?.pending
            ? ` · ${p.daily.gestion.pending} élément(s) à vérifier dans Gestion`
            : ''}
          .
        </p>
      </div>
      <details>
        <summary>
          Suivis et réception
          {due.length
            ? <> · {siteCount('followups',due.length)}</>
            : ''}
          {errors.length ? ' · connexion à vérifier' : ''}
        </summary>
        {p.followups
          .filter((f) => f.state === 'open')
          .slice(0, 8)
          .map((f) => (
            <button
              className="support-followup-row"
              key={f.id}
              onClick={() => openTicket(f.ticketId)}
            >
              <CalendarClock size={17} />
              <span>
                <strong>{f.title}</strong>
                <small>
                  {formatDate(f.dueAt)} · {f.assignedTo}
                </small>
              </span>
              <ArrowUpRight size={16} />
            </button>
          ))}
        {!p.followups.some((f) => f.state === 'open') && (
          <p className="support-small">Aucun suivi en attente.</p>
        )}
        {p.health.map((h) => (
          <p className="support-small" key={h.id}>
            <strong>{h.label}</strong> ·{' '}
            {h.lastError || h.checkError
              ? 'Connexion à vérifier'
              : h.lastReceivedAt
                ? `Dernier message reçu ${formatDate(h.lastReceivedAt)}`
                : 'Aucun message reçu pour le moment'}
          </p>
        ))}
        <Button variant="ghost" onClick={openConnections}>
          Vérifier mes connexions
        </Button>
      </details>
    </section>
  );
}

export function ConnectionHealth({
  data,
  mutate,
  busy,
}: {
  data: SupportState;
  mutate: Mutate;
  busy: boolean;
}) {
  return (
    <section className="support-health" aria-label="État des connexions">
      <h2>Réception des messages</h2>
      {(data.productivity?.health || []).map((h) => (
        <div className="support-health-row" key={h.id}>
          <div>
            <h3>{h.label}</h3>
            <p>
              {h.lastError ||
                h.checkError ||
                (h.lastSyncAt || h.checkedAt
                  ? `Dernière vérification : ${formatDate(h.lastSyncAt || h.checkedAt!)}`
                  : 'Connexion pas encore vérifiée ici.')}
            </p>
            <small>
              {h.lastReceivedAt
                ? `Dernier message reçu : ${formatDate(h.lastReceivedAt)}`
                : 'Aucun message reçu dans Zentra.'}
            </small>
            {h.provider === 'api' && (
              <p className="support-small">
                La réception sera confirmée quand votre outil transmettra son
                premier message.
              </p>
            )}
          </div>
          {data.workspace?.canManage && h.provider !== 'api' && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void mutate({ action: 'checkConnection', connectionId: h.id })
              }
            >
              Vérifier maintenant
            </Button>
          )}
        </div>
      ))}
      {!data.productivity?.health.length && (
        <p>Connectez une messagerie pour suivre sa réception ici.</p>
      )}
    </section>
  );
}

export function SenderRules({
  data,
  mutate,
  busy,
  initial,
}: {
  data: SupportState;
  mutate: Mutate;
  busy: boolean;
  initial?: { sender: string; subject: string; category: string };
}) {
  const [edit, setEdit] = useState<Partial<SenderPolicy>>({
      sender: initial?.sender || '',
      subject: initial?.subject || '',
      category: initial?.category || 'trusted',
    }),
    [saved, setSaved] = useState(false);
  const canManage = !!data.workspace?.canManage,
    policies = data.productivity?.policies || [];
  const change = (value: Partial<SenderPolicy>) => {
    setSaved(false);
    setEdit((e) => ({ ...e, ...value }));
  };
  return (
    <section className="support-rules" aria-label="Règles de votre équipe">
      <h2>Vos préférences de classement</h2>
      <p>
        Protégez un expéditeur ou choisissez la catégorie de ses prochains
        messages. Les règles ne s’appliquent qu’à cet espace.
      </p>
      {!canManage ? (
        <p>Un administrateur peut modifier les règles partagées.</p>
      ) : (
        <>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const r = await mutate({
                action: 'saveSenderPolicy',
                ...edit,
                enabled: edit.enabled !== 0,
              });
              if (r) {
                setSaved(true);
                setEdit({ sender: '', subject: '', category: 'trusted' });
              }
            }}
          >
            <div className="support-form-row">
              <Field label="Adresse de l’expéditeur">
                <input
                  type="email"
                  required
                  maxLength={254}
                  value={edit.sender || ''}
                  onChange={(e) => change({ sender: e.target.value })}
                />
              </Field>
              <Choice
                label="Action"
                value={edit.category || 'trusted'}
                onChange={(value) =>
                  change({
                    category: value,
                    ...(value === 'trusted' ? { subject: '' } : {}),
                  })
                }
                options={[
                  { value: 'trusted', label: 'Expéditeur fiable' },
                  ...Object.entries(CATEGORIES).map(([value, label]) => ({
                    value,
                    label,
                  })),
                ]}
              />
            </div>
            {edit.category !== 'trusted' && (
              <Field label="Seulement si l’objet contient (facultatif)">
                <input
                  value={edit.subject || ''}
                  maxLength={160}
                  minLength={3}
                  placeholder="Ex. renouvellement du contrat"
                  onChange={(e) => change({ subject: e.target.value })}
                />
              </Field>
            )}
            <div className="support-inline-actions">
              <Button type="submit" disabled={busy}>
                {edit.id ? 'Enregistrer la règle' : 'Ajouter la préférence'}
              </Button>
              {edit.id && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setEdit({ sender: '', subject: '', category: 'trusted' });
                    setSaved(false);
                  }}
                >
                  Annuler la modification
                </Button>
              )}
              {saved && (
                <span role="status">
                  <Check size={16} /> Préférence enregistrée
                </span>
              )}
            </div>
          </form>
          <div>
            {policies.map((p) => (
              <div className="support-rule-row" key={p.id}>
                <div>
                  <strong>{p.sender}</strong>
                  <p>
                    {p.category === 'trusted'
                      ? 'Expéditeur fiable'
                      : CATEGORIES[p.category as keyof typeof CATEGORIES]}
                    {p.subject ? ` · objet contenant « ${p.subject} »` : ''}
                    {!p.enabled ? ' · désactivée' : ''}
                  </p>
                </div>
                <div className="support-inline-actions">
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setEdit(p);
                      setSaved(false);
                    }}
                  >
                    Modifier
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void mutate({
                        action: 'saveSenderPolicy',
                        ...p,
                        enabled: !p.enabled,
                      })
                    }
                  >
                    {p.enabled ? 'Désactiver' : 'Activer'}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void mutate({
                        action: 'deleteSenderPolicy',
                        id: p.id,
                        revision: p.revision,
                      })
                    }
                  >
                    Supprimer
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

export function MessageProductivity({
  ticket,
  data,
  mutate,
  busy,
  rule,
}: {
  ticket: SupportTicket;
  data: SupportState;
  mutate: Mutate;
  busy: boolean;
  rule: (sender: string, subject: string, category: string) => void;
}) {
  const p = data.productivity,
    readOnly = data.workspace?.role === 'read_only',
    solicitation = ticket.decision?.category === 'solicitation';
  const [title, setTitle] = useState(
      `Suivre : ${ticket.subject}`.slice(0, 160),
    ),
    [assigned, setAssigned] = useState(data.user.email),
    [date, setDate] = useState(''),
    [gestion, setGestion] = useState(false),
    [open, setOpen] = useState(false);
  const followup = p?.followups.find((f) => f.ticketId === ticket.id);
  return (
    <section
      className="support-message-tools"
      aria-label="Préférences et suivi"
    >
      <div className="support-inline-actions">
        {solicitation && (
          <Button
            variant="ghost"
            disabled={busy || readOnly}
            onClick={() =>
              void mutate({
                action: 'notSolicitation',
                ticketId: ticket.id,
                revision: ticket.revision,
              })
            }
          >
            Ce n’est pas du démarchage
          </Button>
        )}
        {ticket.senderEmail && data.workspace?.canManage && (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => rule(ticket.senderEmail!, '', 'trusted')}
          >
            <ShieldCheck size={16} /> Protéger cet expéditeur
          </Button>
        )}
        {ticket.senderEmail && data.workspace?.canManage && ticket.decision && (
          <Button
            variant="ghost"
            onClick={() =>
              rule(
                ticket.senderEmail!,
                ticket.subject,
                ticket.decision!.category,
              )
            }
          >
            Mémoriser ce classement
          </Button>
        )}
      </div>
      {solicitation && !followup && (
        <Button
          variant="outline"
          disabled={busy || readOnly}
          onClick={() => setOpen(!open)}
        >
          <CalendarClock size={16} /> Créer un suivi
        </Button>
      )}
      {followup && (
        <div className="support-followup-saved">
          <strong>{followup.title}</strong>
          <p>
            {followup.state === 'open'
              ? `Rappel ${formatDate(followup.dueAt)}`
              : 'Suivi terminé'}{' '}
            · {followup.assignedTo}
          </p>
          {followup.organizationId ? (
            <a
              href={`/compte/automation?organizationId=${encodeURIComponent(followup.organizationId)}&section=workflows`}
            >
              Ouvrir la tâche dans Automation <ArrowUpRight size={15} />
            </a>
          ) : (
            followup.state === 'open' && (
              <Button
                variant="ghost"
                disabled={busy || readOnly}
                onClick={() =>
                  void mutate({
                    action: 'completeFollowup',
                    id: followup.id,
                    revision: followup.revision,
                  })
                }
              >
                Marquer comme terminé
              </Button>
            )
          )}
        </div>
      )}
      {open && !followup && (
        <form
          className="support-followup-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await mutate({
              action: 'createFollowup',
              ticketId: ticket.id,
              revision: ticket.revision,
              title,
              assignedTo: assigned,
              dueAt: Math.floor(new Date(date).getTime() / 1000),
              gestion,
            });
            if (r) setOpen(false);
          }}
        >
          <Field label="À faire">
            <input
              required
              value={title}
              maxLength={160}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <div className="support-form-row">
            <Choice
              label="Responsable"
              value={assigned}
              onChange={setAssigned}
              options={(
                p?.members || [{ email: data.user.email, role: 'owner' }]
              ).map((m) => ({ value: m.email, label: m.email }))}
            />
            <Field label="Me le rappeler le">
              <input
                required
                type="datetime-local"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </Field>
          </div>
          {p?.canCreateGestion && (
            <label className="support-check">
              <input
                type="checkbox"
                checked={gestion}
                onChange={(e) => setGestion(e.target.checked)}
              />{' '}
              Créer aussi la tâche dans Gestion
            </label>
          )}
          <div className="support-inline-actions">
            <Button type="submit" disabled={busy || readOnly}>
              Enregistrer le suivi
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
            >
              Annuler
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

type BatchRow = {
  ticketId: string;
  subject: string;
  revision: number;
  draft?: Draft;
  error?: string;
  reviewed?: boolean;
  result?: { reply?: { state: string; intent: string }; disposition?: string };
};
export function BatchSolicitations({
  tickets,
  mutate,
  busy,
  readOnly,
}: {
  tickets: SupportTicket[];
  mutate: Mutate;
  busy: boolean;
  readOnly: boolean;
}) {
  const [selected, setSelected] = useState<string[]>([]),
    [rows, setRows] = useState<BatchRow[]>([]),
    [message, setMessage] = useState('');
  const eligible = tickets.filter(
      (t) =>
        t.decision?.category === 'solicitation' &&
        !['accepted', 'uncertain', 'submitting', 'preparing'].includes(
          t.solicitation?.state || '',
        ),
    ),
    groups = new Map<string, SupportTicket[]>();
  for (const ticket of eligible) {
    const key = ticket.senderEmail || 'Expéditeur non disponible';
    groups.set(key, [...(groups.get(key) || []), ticket]);
  }
  const items = selected
    .map((id) => tickets.find((t) => t.id === id))
    .filter((t): t is SupportTicket => !!t)
    .map((t) => ({ ticketId: t.id, revision: t.revision }));
  function toggle(ids: string[], checked: boolean) {
    setRows([]);
    setMessage('');
    setSelected((s) =>
      checked
        ? [...new Set([...s, ...ids])].slice(0, 20)
        : s.filter((id) => !ids.includes(id)),
    );
  }
  async function prepare() {
    const r = await mutate({ action: 'previewSolicitationBatch', items });
    if (!r) return;
    const seen = new Set<string>();
    setRows(
      (
        r.results as {
          ticketId: string;
          result?: { draft: Draft };
          error?: string;
        }[]
      ).map((v) => {
        const ticket = tickets.find((t) => t.id === v.ticketId)!;
        let error = v.error;
        const to = v.result?.draft.target?.recipient?.toLowerCase();
        if (to && seen.has(to))
          error =
            'Même destinataire : une seule réponse sera préparée dans ce lot.';
        if (to) seen.add(to);
        return {
          ticketId: ticket.id,
          subject: ticket.subject,
          revision: ticket.revision,
          draft: v.result?.draft,
          error,
        };
      }),
    );
  }
  const sendable = rows.filter(
    (r) =>
      r.draft?.target &&
      r.draft.enabled &&
      !r.error &&
      !r.draft.unavailable &&
      !r.result &&
      !['accepted', 'submitting', 'uncertain', 'preparing'].includes(
        r.draft.status?.state || '',
      ),
  );
  async function send() {
    const r = await mutate({
      action: 'sendSolicitationBatch',
      confirm: true,
      items: sendable.map((v) => ({
        ...v.draft,
        ticketId: v.ticketId,
        revision: v.revision,
        intent: 'stop',
      })),
    });
    if (!r) return;
    const results = r.results as {
      ticketId: string;
      result?: BatchRow['result'];
      error?: string;
    }[];
    setRows((old) =>
      old.map((row) => {
        const v = results.find((v) => v.ticketId === row.ticketId);
        return v ? { ...row, ...v, reviewed: false } : row;
      }),
    );
    setMessage('Traitement terminé. Consultez le résultat de chaque réponse.');
  }
  return (
    <details className="support-batch">
      <summary>Traiter plusieurs propositions</summary>
      <p className="support-small">
        Jusqu’à 20 messages de la liste affichée. Ignorer les conserve dans
        Zentra et dans votre messagerie.
      </p>
      <label className="support-check">
        <input
          type="checkbox"
          checked={
            !!eligible.length &&
            eligible.slice(0, 20).every((t) => selected.includes(t.id))
          }
          onChange={(e) =>
            toggle(
              eligible.slice(0, 20).map((t) => t.id),
              e.target.checked,
            )
          }
          disabled={busy || readOnly}
        />{' '}
        Sélectionner les {Math.min(20, eligible.length)} premiers
      </label>
      <div className="support-batch-selection">
        {[...groups].map(([sender, list]) => (
          <details key={sender} open>
            <summary>
              {sender} · {list.length}
            </summary>
            {list.map((t) => (
              <label className="support-check" key={t.id}>
                <input
                  type="checkbox"
                  disabled={
                    busy ||
                    readOnly ||
                    (!selected.includes(t.id) && selected.length >= 20)
                  }
                  checked={selected.includes(t.id)}
                  onChange={(e) => toggle([t.id], e.target.checked)}
                />
                <span>{t.subject}</span>
              </label>
            ))}
          </details>
        ))}
      </div>
      <div className="support-inline-actions">
        <Button
          variant="outline"
          disabled={!items.length || busy || readOnly}
          onClick={async () => {
            const r = await mutate({
              action: 'ignoreSolicitationBatch',
              items,
            });
            if (r) {
              const results = r.results as {
                ticketId: string;
                error?: string;
              }[];
              setMessage(
                `${results.filter((v) => !v.error).length} message(s) ignoré(s).`,
              );
              setRows(
                results
                  .filter((v) => v.error)
                  .map((v) => ({
                    ...v,
                    subject:
                      tickets.find((t) => t.id === v.ticketId)?.subject || '',
                    revision: 0,
                  })),
              );
              setSelected([]);
            }
          }}
        >
          Ignorer la sélection
        </Button>
        <Button
          variant="outline"
          disabled={!items.length || busy || readOnly}
          onClick={() => void prepare()}
        >
          Préparer les réponses STOP
        </Button>
      </div>
      {message && <p role="status">{message}</p>}
      {rows.map((r, i) => (
        <section key={r.ticketId} className="support-batch-reply">
          <h3>{r.subject}</h3>
          {r.error ? (
            <p role="status">{r.error}</p>
          ) : r.result?.reply ? (
            <p role="status">
              {dispositionLabel(r.result.reply)}
              {r.result.reply.state === 'accepted'
                ? ' · livraison non confirmée'
                : ''}
            </p>
          ) : (
            r.draft && (
              <>
                <p className="support-small">
                  À : {r.draft.target?.recipient || 'Indisponible'}
                  <br />
                  De : {r.draft.target?.from || 'Indisponible'}
                </p>
                {r.draft.unavailable && <p>{r.draft.unavailable}</p>}
                {!r.draft.enabled && (
                  <p>
                    Un administrateur doit autoriser les réponses dans
                    Paramètres.
                  </p>
                )}
                <Field label="Objet de la réponse">
                  <input
                    value={r.draft.subject}
                    maxLength={300}
                    disabled={busy}
                    onChange={(e) =>
                      setRows((old) =>
                        old.map((v, j) =>
                          j === i
                            ? {
                                ...v,
                                reviewed: false,
                                draft: { ...v.draft!, subject: e.target.value },
                              }
                            : v,
                        ),
                      )
                    }
                  />
                </Field>
                <Field label="Texte de la réponse">
                  <textarea
                    value={r.draft.body}
                    rows={6}
                    maxLength={6000}
                    disabled={busy}
                    onChange={(e) =>
                      setRows((old) =>
                        old.map((v, j) =>
                          j === i
                            ? {
                                ...v,
                                reviewed: false,
                                draft: { ...v.draft!, body: e.target.value },
                              }
                            : v,
                        ),
                      )
                    }
                  />
                </Field>
                <label className="support-check">
                  <input
                    type="checkbox"
                    checked={!!r.reviewed}
                    disabled={busy || !sendable.includes(r)}
                    onChange={(e) =>
                      setRows((old) =>
                        old.map((v, j) =>
                          j === i ? { ...v, reviewed: e.target.checked } : v,
                        ),
                      )
                    }
                  />{' '}
                  J’ai vérifié ce destinataire et ce texte
                </label>
              </>
            )
          )}
        </section>
      ))}
      {!!rows.length && (
        <Button
          disabled={
            busy ||
            readOnly ||
            !sendable.length ||
            sendable.some((r) => !r.reviewed)
          }
          onClick={() => void send()}
        >
          Envoyer les {sendable.length} réponses vérifiées
        </Button>
      )}
    </details>
  );
}
