'use client';
import { useState } from 'react';
import { ConnectionWizard } from './connection-wizard';
import { GestionLink } from './gestion-link';
import { Check, Copy, KeyRound, Link2, Plus, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  CATEGORIES,
  PRIORITIES,
  type Category,
  type Priority,
  type Rules,
} from '@/lib/support/types';
import { Choice, Field, formatDate } from './controls';
import {
  PROVIDERS,
  type Mutate,
  type SupportConnection,
  type SupportState,
  type SupportTicket,
} from './model';

export function ReviewForm({
  ticket,
  connection,
  mutate,
  busy,
  readOnly,
}: {
  ticket: SupportTicket;
  connection?: SupportConnection;
  mutate: Mutate;
  busy: boolean;
  readOnly: boolean;
}) {
  const [category, setCategory] = useState(
      ticket.decision?.category || 'other',
    ),
    [priority, setPriority] = useState(ticket.decision?.priority || 'normal');
  const [teamId, setTeam] = useState(
      ticket.decision?.destination?.teamId || '',
    ),
    [agentId, setAgent] = useState(ticket.decision?.destination?.agentId || ''),
    [revision, setRevision] = useState(ticket.revision);
  const stale = revision !== ticket.revision;
  return (
    <form
      className="support-review-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (
          await mutate({
            action: 'approve',
            ticketId: ticket.id,
            revision,
            category,
            priority,
            destination: { teamId, agentId },
          })
        )
          setRevision(revision + 1);
      }}
    >
      <h3>
        {ticket.state === 'routed'
          ? 'Corriger l’affectation'
          : 'Valider l’affectation'}
      </h3>
      {stale && (
        <div className="support-notice">
          Ce ticket a changé.{' '}
          <Button
            type="button"
            variant="link"
            onClick={() => {
              setCategory(ticket.decision?.category || 'other');
              setPriority(ticket.decision?.priority || 'normal');
              setTeam(ticket.decision?.destination?.teamId || '');
              setAgent(ticket.decision?.destination?.agentId || '');
              setRevision(ticket.revision);
            }}
          >
            Recharger la décision
          </Button>
        </div>
      )}
      <div className="support-form-grid">
        <Choice
          label="Catégorie"
          value={category}
          onChange={(v) => setCategory(v as Category)}
          options={Object.entries(CATEGORIES).map(([value, label]) => ({
            value,
            label,
          }))}
        />
        <Choice
          label="Priorité"
          value={priority}
          onChange={(v) => setPriority(v as Priority)}
          options={Object.entries(PRIORITIES).map(([value, label]) => ({
            value,
            label,
          }))}
        />
        <Choice
          label="Équipe"
          value={teamId}
          onChange={(v) => {
            setTeam(v);
            setAgent('');
          }}
          options={[
            { value: '', label: 'Choisir une équipe' },
            ...(connection?.directory.teams || []).map((t) => ({
              value: t.id,
              label: t.name,
            })),
          ]}
        />
        <Choice
          label="Agent"
          value={agentId}
          onChange={setAgent}
          options={[
            { value: '', label: 'Laisser l’équipe répartir' },
            ...(connection?.directory.agents || []).map((a) => ({
              value: a.id,
              label: a.name,
            })),
          ]}
        />
      </div>
      <Button
        className="support-primary"
        type="submit"
        disabled={busy || readOnly || stale || !teamId || !connection}
      >
        <Check size={17} />{' '}
        {connection?.provider === 'api'
          ? 'Valider pour mon connecteur'
          : connection?.provider === 'infomaniak'
            ? 'Classer dans Zentra Support'
            : 'Appliquer dans mon outil'}
      </Button>
    </form>
  );
}

export function ConnectionsPanel({
  data,
  mutate,
  busy,
  demo,
  error,
}: {
  data: SupportState;
  mutate: Mutate;
  busy: boolean;
  demo: boolean;
  error?: string;
}) {
  const [open, setOpen] = useState(false);
  const [hook, setHook] = useState<{ id: string; token: string } | null>(null),
    [guide, setGuide] = useState<string | null>(null),
    [copied, setCopied] = useState(''),
    [disconnect, setDisconnect] = useState<SupportConnection | null>(null);
  const manage = !!data.workspace?.canManage;
  async function copy(text: string, name: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(name);
    } catch {
      setCopied('Sélectionnez le texte pour le copier.');
    }
  }
  return (
    <div className="support-panels">
      <div className="support-section-heading">
        <div>
          <h2>Vos mails et outils, connectés.</h2>
          <p>
            Connectez votre boîte mail ou votre logiciel de support pour trier
            les demandes.
          </p>
        </div>
        <Button
          className="support-primary"
          onClick={() => setOpen(true)}
          disabled={!manage}
        >
          <Plus size={18} /> Ajouter une connexion
        </Button>
      </div>
      <GestionLink key={data.workspace?.id} data={data} mutate={mutate} busy={busy} demo={demo}/>
      {data.connections.length === 0 && (
        <div className="support-empty support-card">
          <Link2 size={30} />
          <h3>Choisissez votre première connexion.</h3>
          <p>
            Commencez par choisir votre boîte mail ou votre logiciel pour voir
            les connexions disponibles.
          </p>
          <Button
            className="support-primary"
            onClick={() => setOpen(true)}
            disabled={!manage}
          >
            Connecter mon support
          </Button>
        </div>
      )}
      {data.connections.map((c) => (
        <section className="support-card" key={c.id}>
          <div className="support-card-heading">
            <div>
              <p className="support-eyebrow">{PROVIDERS[c.provider]}</p>
              <h3>{c.label}</h3>
              <p>
                {c.domain || 'Connexion API personnalisée'} ·{' '}
                {c.directory.teams.length} équipe(s)
              </p>
            </div>
            <span className="support-category">
              {data.tickets.some((t) => t.connectionId === c.id)
                ? 'Tickets reçus'
                : 'En attente du premier ticket'}
            </span>
          </div>
          <div className="support-actions">
            {c.provider !== 'infomaniak' && (
              <Button
                variant="outline"
                onClick={() => setGuide(guide === c.id ? null : c.id)}
              >
                Guide de connexion
              </Button>
            )}
            {c.provider === 'infomaniak' && (
              <Button
                variant="outline"
                disabled={busy || !manage || demo}
                onClick={() =>
                  mutate({ action: 'syncMailbox', connectionId: c.id })
                }
              >
                <RefreshCw size={15} /> Synchroniser maintenant
              </Button>
            )}
            {c.provider !== 'api' && c.provider !== 'infomaniak' && (
              <Button
                variant="outline"
                disabled={busy || !manage}
                onClick={() =>
                  mutate({ action: 'refreshDirectory', connectionId: c.id })
                }
              >
                <RefreshCw size={15} /> Équipes
              </Button>
            )}
            <Button
              variant="ghost"
              disabled={!manage}
              onClick={() => setDisconnect(c)}
            >
              Déconnecter
            </Button>
          </div>
          {c.provider === 'infomaniak' &&
            (() => {
              const mailbox = data.mailboxes?.find(
                (m) => m.connectionId === c.id,
              );
              return (
                <div className="support-integration-guide">
                  <h4>Réception et tri automatiques</h4>
                  <p>
                    Les nouveaux mails de la boîte de réception sont récupérés
                    environ toutes les cinq minutes, puis classés dans Zentra
                    Support. Les cas incertains et les mails avec pièces jointes
                    restent à vérifier.
                  </p>
                  {!data.mailSync?.background && (
                    <p className="support-notice">
                      Gardez votre espace Support ouvert : la réception
                      automatique fonctionne pendant son ouverture. La réception
                      lorsque la page est fermée n’est pas encore active.
                    </p>
                  )}
                  <p className="support-small">
                    {mailbox?.lastSyncAt
                      ? `Dernière récupération : ${formatDate(mailbox.lastSyncAt)}`
                      : 'En attente de la première récupération.'}{' '}
                    Le classement se fait dans Support ; les dossiers Infomaniak
                    restent inchangés.
                  </p>
                  {mailbox?.lastError && (
                    <p role="alert" className="support-notice support-error">
                      {mailbox.lastError}
                    </p>
                  )}
                  <Button
                    variant="ghost"
                    disabled={busy || !manage}
                    onClick={() => setOpen(true)}
                  >
                    Remplacer la clé de connexion
                  </Button>
                </div>
              );
            })()}
          {guide === c.id && c.provider !== 'infomaniak' && (
            <div className="support-integration-guide">
              <p className="support-eyebrow">3 · DERNIÈRE ÉTAPE</p>
              <h4>Recevoir les tickets automatiquement</h4>
              <p>
                La connexion est vérifiée. Activez maintenant l’envoi des
                nouveaux tickets dans votre logiciel, puis choisissez vos
                équipes dans Routage.
              </p>
              <ol>
                <li>
                  Dans{' '}
                  {c.provider === 'api'
                    ? 'votre outil, Make ou n8n'
                    : PROVIDERS[c.provider]}
                  , créez une notification HTTP (webhook) lors de la création
                  d’un ticket.{' '}
                  {c.provider === 'zendesk' &&
                    'Utilisez un déclencheur dédié et évitez les déclencheurs qui réagissent à toute modification du ticket.'}
                </li>
                <li>
                  Choisissez <strong>POST</strong>, le format{' '}
                  <strong>JSON</strong> et cette adresse :
                </li>
              </ol>
              <div className="support-copy">
                <code>
                  {demo
                    ? 'Adresse disponible après connexion de votre outil.'
                    : c.hookUrl}
                </code>
                <Button
                  variant="ghost"
                  aria-label="Copier l’adresse"
                  disabled={demo}
                  onClick={() => copy(c.hookUrl, 'Adresse copiée')}
                >
                  <Copy size={16} />
                </Button>
              </div>
              <p>
                Ajoutez l’en-tête <code>Authorization: Bearer VOTRE_CLÉ</code>.
                La clé est affichée une seule fois.
              </p>
              <Button
                variant="outline"
                disabled={!manage || busy || demo}
                onClick={async () => {
                  const result = await mutate({
                    action: 'rotateHook',
                    connectionId: c.id,
                  });
                  if (result?.hookToken)
                    setHook({ id: c.id, token: String(result.hookToken) });
                }}
              >
                <KeyRound size={15} /> Générer une nouvelle clé de webhook
              </Button>
              <p className="support-small">
                Une nouvelle clé remplace immédiatement l’ancienne.
              </p>
              {hook?.id === c.id && (
                <div className="support-copy">
                  <code>{hook.token}</code>
                  <Button
                    variant="ghost"
                    aria-label="Copier la clé du webhook"
                    onClick={() => copy(hook.token, 'Clé copiée')}
                  >
                    <Copy size={16} />
                  </Button>
                </div>
              )}
              <p>Corps JSON à envoyer :</p>
              <pre>
                {c.provider === 'api'
                  ? JSON.stringify(
                      {
                        ticketId: '1234',
                        subject: 'Objet du ticket',
                        body: 'Message du client',
                        version: '1',
                      },
                      null,
                      2,
                    )
                  : JSON.stringify(
                      {
                        ticketId:
                          c.provider === 'zendesk'
                            ? '{{ticket.id}}'
                            : c.provider === 'freshdesk'
                              ? '{{ticket.id}}'
                              : 'IDENTIFIANT_DYNAMIQUE_DU_TICKET',
                      },
                      null,
                      2,
                    )}
              </pre>
              <p>
                En cas d’erreur temporaire, votre outil doit réessayer avec le
                même identifiant. Un ticket identique ne sera pas affecté deux
                fois.
              </p>
              {c.provider === 'api' && (
                <>
                  <h4>Appliquer puis confirmer</h4>
                  <p>
                    La réponse contient la catégorie, la priorité et l’équipe.
                    Appliquez ces valeurs dans votre outil. Vous pouvez
                    récupérer les décisions en attente par <strong>GET</strong>{' '}
                    sur la même adresse avec le même en-tête.
                  </p>
                  <p>Après application, confirmez par POST :</p>
                  <pre>
                    {JSON.stringify(
                      {
                        action: 'acknowledge',
                        ticketId: 'ID_ZENTRA_REÇU',
                        revision: 2,
                        status: 'applied',
                      },
                      null,
                      2,
                    )}
                  </pre>
                  <p>
                    Utilisez l’identifiant Zentra et la révision renvoyés, pas
                    ces valeurs d’exemple. Sans confirmation, le ticket reste «
                    À appliquer ».
                  </p>
                </>
              )}
              {c.provider !== 'api' && (
                <p>
                  <a
                    target="_blank"
                    rel="noreferrer"
                    href={
                      c.provider === 'zendesk'
                        ? 'https://developer.zendesk.com/documentation/webhooks/'
                        : c.provider === 'freshdesk'
                          ? 'https://support.freshdesk.com/support/solutions/articles/132589-using-webhooks-in-automation-rules'
                          : 'https://developers.gorgias.com/docs/sync-gorgias-data-with-a-database'
                    }
                  >
                    Documentation de {PROVIDERS[c.provider]} ↗
                  </a>
                </p>
              )}
              <p className="support-small">
                Les tickets sont traités côté serveur, même lorsque cette page
                est fermée. Une erreur reste visible dans « À reprendre ».
              </p>
              {copied && <p role="status">{copied}</p>}
            </div>
          )}
        </section>
      ))}
      {open && (
        <ConnectionWizard
          open={open}
          onOpenChange={setOpen}
          data={data}
          mutate={mutate}
          busy={busy}
          demo={demo}
          error={error}
          onConnected={(result) => {
            setGuide(String(result.connectionId));
            if (result.hookToken)
              setHook({
                id: String(result.connectionId),
                token: String(result.hookToken),
              });
          }}
        />
      )}
      <Dialog
        open={!!disconnect}
        onOpenChange={(open) => {
          if (!open) setDisconnect(null);
        }}
      >
        <DialogContent className="support-dialog">
          <DialogHeader>
            <DialogTitle>Déconnecter {disconnect?.label} ?</DialogTitle>
            <DialogDescription>
              La clé enregistrée et l’accès du webhook seront supprimés.
              L’historique des tickets sera conservé.
            </DialogDescription>
          </DialogHeader>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={async () => {
              if (
                disconnect &&
                (await mutate({
                  action: 'disconnect',
                  connectionId: disconnect.id,
                }))
              )
                setDisconnect(null);
            }}
          >
            Déconnecter cet outil
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function RoutingPanel({
  data,
  mutate,
  busy,
}: {
  data: SupportState;
  mutate: Mutate;
  busy: boolean;
}) {
  return (
    <div className="support-panels">
      <div className="support-section-heading">
        <div>
          <h2>À chaque demande, son équipe.</h2>
          <p>
            Choisissez les destinations. Zentra reconnaît la demande et applique
            vos règles.
          </p>
        </div>
      </div>
      {!data.connections.length && (
        <div className="support-card support-empty">
          <h3>Connectez d’abord votre outil.</h3>
          <p>Ses équipes apparaîtront ici automatiquement.</p>
        </div>
      )}
      {data.connections.map((c) => (
        <ConnectionRules
          key={c.id}
          connection={c}
          mutate={mutate}
          busy={busy}
          readOnly={!data.workspace?.canManage}
        />
      ))}
      {data.workspace && (
        <WorkspaceSettings
          key={data.workspace.id}
          data={data}
          mutate={mutate}
          busy={busy}
        />
      )}
    </div>
  );
}
function ConnectionRules({
  connection: c,
  mutate,
  busy,
  readOnly,
}: {
  connection: SupportConnection;
  mutate: Mutate;
  busy: boolean;
  readOnly: boolean;
}) {
  const [rules, setRules] = useState<Rules>(c.rules),
    [teams, setTeams] = useState(c.directory.teams);
  return (
    <form
      className="support-card"
      onSubmit={(e) => {
        e.preventDefault();
        void mutate({
          action: 'routes',
          connectionId: c.id,
          rules,
          teams: c.provider === 'api' ? teams : undefined,
        });
      }}
    >
      <h3>{c.label}</h3>
      {c.provider === 'api' && (
        <details className="support-disclosure">
          <summary>Définir les équipes de mon outil</summary>
          {teams.map((t, i) => (
            <div className="support-form-grid" key={i}>
              <Field
                label="Identifiant dans votre outil"
                value={t.id}
                onChange={(e) =>
                  setTeams(
                    teams.map((x, n) =>
                      n === i ? { ...x, id: e.target.value } : x,
                    ),
                  )
                }
              />
              <Field
                label="Nom de l’équipe"
                value={t.name}
                onChange={(e) =>
                  setTeams(
                    teams.map((x, n) =>
                      n === i ? { ...x, name: e.target.value } : x,
                    ),
                  )
                }
              />
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            disabled={readOnly || teams.length >= 100}
            onClick={() =>
              setTeams([
                ...teams,
                { id: `equipe-${teams.length + 1}`, name: '' },
              ])
            }
          >
            Ajouter une équipe
          </Button>
        </details>
      )}
      <div className="support-rules">
        {Object.entries(CATEGORIES).map(([key, label]) => (
          <div className="support-rule" key={key}>
            <strong>{label}</strong>
            <Choice
              label={`Équipe · ${label}`}
              value={rules[key as Category]?.teamId || ''}
              onChange={(teamId) =>
                setRules({ ...rules, [key]: teamId ? { teamId } : undefined })
              }
              disabled={readOnly}
              options={[
                { value: '', label: 'Validation humaine' },
                ...teams
                  .filter((t) => t.id && t.name)
                  .map((t) => ({ value: t.id, label: t.name })),
              ]}
            />
            <Choice
              label={`Agent · ${label}`}
              value={rules[key as Category]?.agentId || ''}
              onChange={(agentId) =>
                setRules({
                  ...rules,
                  [key]: {
                    teamId: rules[key as Category]?.teamId || '',
                    agentId,
                  },
                })
              }
              disabled={readOnly || !rules[key as Category]?.teamId}
              options={[
                { value: '', label: 'Répartition par l’équipe' },
                ...c.directory.agents.map((a) => ({
                  value: a.id,
                  label: a.name,
                })),
              ]}
            />
          </div>
        ))}
      </div>
      <Button
        className="support-primary"
        type="submit"
        disabled={busy || readOnly}
      >
        Enregistrer le routage
      </Button>
      <p className="support-small">
        La catégorie « Autre » reste toujours à vérifier. Une affectation déjà
        faite par une personne n’est pas remplacée automatiquement.
      </p>
    </form>
  );
}
function WorkspaceSettings({
  data,
  mutate,
  busy,
}: {
  data: SupportState;
  mutate: Mutate;
  busy: boolean;
}) {
  const w = data.workspace!,
    [mode, setMode] = useState(w.mode),
    [threshold, setThreshold] = useState(w.threshold),
    [baseline, setBaseline] = useState(w.baselineSeconds),
    [triageContext, setTriageContext] = useState(w.triageContext),
    [name, setName] = useState(w.name);
  return (
    <form
      className="support-card"
      onSubmit={(e) => {
        e.preventDefault();
        void mutate({
          action: 'settings',
          name,
          mode,
          threshold,
          baselineSeconds: baseline,
          triageContext,
        });
      }}
    >
      <h3>Votre niveau d’autonomie</h3>
      <div className="support-form-grid">
        <Field
          label="Nom de l’espace"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
          required
        />
        <Choice
          label="Fonctionnement"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'review', label: 'Tout valider avant affectation' },
            {
              value: 'automatic',
              label: 'Automatique si confiance suffisante',
            },
          ]}
        />
        <Field
          label="Seuil de confiance du modèle (%)"
          type="number"
          min={50}
          max={100}
          value={threshold}
          onChange={(e) => setThreshold(Number(e.target.value))}
          required
        />
        <Field
          label="Temps de tri manuel estimé par ticket (secondes)"
          type="number"
          min={5}
          max={900}
          value={baseline}
          onChange={(e) => setBaseline(Number(e.target.value))}
          required
        />
      </div>
      <p className="support-small">
        En mode automatique, catégorie et priorité doivent atteindre le seuil.
        Les nouveaux tickets sont alors affectés sans clic de votre part. Les
        cas ambigus restent à vérifier. Ajustez le seuil selon vos résultats.
      </p>
      <details className="support-context-details">
        <summary>Préciser mon activité (facultatif)</summary>
        <label className="support-field">
          Vos produits et votre vocabulaire
          <textarea
            value={triageContext}
            onChange={(e) => setTriageContext(e.target.value)}
            maxLength={2000}
            rows={4}
            disabled={!w.canManage}
            placeholder="Ex. : boutique de vêtements. Un échange signifie remplacer la taille, sans remboursement."
          />
        </label>
        <p className="support-small">
          Décrivez votre activité et les termes spécifiques. Les destinataires
          restent ceux choisis dans vos règles de routage.
        </p>
      </details>
      <Button
        className="support-primary"
        disabled={busy || !w.canManage}
        type="submit"
      >
        Enregistrer
      </Button>
    </form>
  );
}

export function TeamPanel({
  data,
  mutate,
  busy,
}: {
  data: SupportState;
  mutate: Mutate;
  busy: boolean;
}) {
  const [email, setEmail] = useState(''),
    [role, setRole] = useState('member'),
    [link, setLink] = useState(''),
    [remove, setRemove] = useState<{ id: string; email: string } | null>(null);
  return (
    <div className="support-panels">
      <div className="support-section-heading">
        <div>
          <h2>Un espace partagé.</h2>
          <p>Votre équipe peut consulter et valider les décisions ensemble.</p>
        </div>
      </div>
      <section className="support-card">
        <h3>Accès à cet espace</h3>
        <p className="support-small">
          Les équipes et agents qui reçoivent les tickets sont ceux de votre
          outil. Les accès ci-dessous concernent Zentra Support.
        </p>
        {data.members.map((m) => (
          <div className="support-member" key={m.id}>
            <div>
              <strong>{m.email}</strong>
              <span>
                {m.role === 'admin'
                  ? 'Administrateur'
                  : m.role === 'read_only'
                    ? 'Lecture seule'
                    : 'Validation des tickets'}
              </span>
            </div>
            {data.workspace?.role === 'owner' && (
              <Button variant="ghost" onClick={() => setRemove(m)}>
                Retirer
              </Button>
            )}
          </div>
        ))}
        {!data.members.length && <p>Aucun accès collaborateur ajouté.</p>}
        {data.workspace?.role === 'owner' && (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const result = await mutate({ action: 'invite', email, role });
              if (result) {
                setLink(String(result.inviteUrl));
                setEmail('');
              }
            }}
          >
            <div className="support-form-grid">
              <Field
                label="E-mail du collaborateur"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
              <Choice
                label="Rôle"
                value={role}
                onChange={setRole}
                options={[
                  {
                    value: 'member',
                    label: 'Valider et réaffecter les tickets',
                  },
                  {
                    value: 'admin',
                    label: 'Gérer aussi les connexions et règles',
                  },
                  { value: 'read_only', label: 'Consulter uniquement' },
                ]}
              />
            </div>
            <Button className="support-primary" disabled={busy} type="submit">
              Ajouter l’accès
            </Button>
            <p className="support-small">
              Partagez ensuite le lien. La personne doit se connecter avec cette
              adresse e-mail vérifiée. Aucun e-mail n’est envoyé
              automatiquement.
            </p>
          </form>
        )}
        {link && (
          <div className="support-copy">
            <input
              aria-label="Lien d’accès à partager"
              readOnly
              value={link}
              onFocus={(e) => e.target.select()}
            />
          </div>
        )}
      </section>
      <Dialog
        open={!!remove}
        onOpenChange={(open) => {
          if (!open) setRemove(null);
        }}
      >
        <DialogContent className="support-dialog">
          <DialogHeader>
            <DialogTitle>Retirer cet accès ?</DialogTitle>
            <DialogDescription>
              {remove?.email} ne pourra plus ouvrir cet espace.
            </DialogDescription>
          </DialogHeader>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={async () => {
              if (
                remove &&
                (await mutate({ action: 'revokeMember', memberId: remove.id }))
              )
                setRemove(null);
            }}
          >
            Retirer l’accès
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function InsightsPanel({ data }: { data: SupportState }) {
  const counts = data.counts,
    minutes = Math.round(
      ((counts.automatic || 0) * (data.workspace?.baselineSeconds || 60)) / 60,
    );
  return (
    <div className="support-panels">
      <div className="support-section-heading">
        <div>
          <h2>Le temps rendu à votre équipe.</h2>
          <p>Résultats des tickets reçus durant les 30 derniers jours.</p>
        </div>
      </div>
      <div className="support-metrics">
        <section className="support-card">
          <span>Tri économisé — estimation</span>
          <strong>
            {minutes} <small>min</small>
          </strong>
          <p>
            {counts.automatic || 0} affectations automatiques non corrigées ×{' '}
            {data.workspace?.baselineSeconds || 60} secondes.
          </p>
        </section>
        <section className="support-card">
          <span>Tickets affectés</span>
          <strong>{counts.routed || 0}</strong>
          <p>Sur {counts.total || 0} tickets reçus.</p>
        </section>
        <section className="support-card">
          <span>Réaffectations validées</span>
          <strong>{counts.corrections || 0}</strong>
          <p>Corrections effectuées depuis Zentra Support.</p>
        </section>
      </div>
      <p className="support-small">
        L’objectif est de réduire de 20 à 30 % le temps consacré au support. Ce
        gain reste à mesurer sur votre activité ; ces estimations de tri ne
        prouvent pas un gain sur l’ensemble du support.
      </p>
      <section className="support-card">
        <h3>Journal des décisions</h3>
        {data.events.length ? (
          data.events.map((e) => (
            <div className="support-event" key={e.id}>
              <span>{formatDate(e.createdAt)}</span>
              <p>
                {e.detail}
                <small>{e.actor}</small>
              </p>
            </div>
          ))
        ) : (
          <p>Les premières décisions apparaîtront ici.</p>
        )}
      </section>
    </div>
  );
}
