'use client';
import { useRef, useState } from 'react';
import { BellOff, Check, Mail, Send, Undo2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Choice, Field } from './controls';
import {
  DEFAULT_REPLIES,
  REPLY_LANGUAGES,
  type ReplyIntent,
  type ReplyLanguage,
  type SolicitationSettings,
} from '@/lib/support/solicitation';
import type { Mutate, SupportState, SupportTicket } from './model';

export type Draft = {
  intent: ReplyIntent;
  language: ReplyLanguage;
  subject: string;
  body: string;
  fingerprint: string;
  target: {
    recipient: string;
    from: string;
    name: string;
    sourceVersion: string;
  } | null;
  enabled: boolean;
  unavailable: string;
  status: { intent: string; state: string } | null;
  revision: number;
};

export const dispositionLabel = (
  value?: { intent: string; state: string } | null,
) => {
  if (!value) return '';
  if (value.state === 'ignored') return 'Ignoré';
  if (value.state === 'accepted')
    return value.intent === 'stop' ? 'STOP accepté par la messagerie' : 'Réponse acceptée par la messagerie';
  if (value.state === 'uncertain' || value.state === 'submitting')
    return 'Envoi à vérifier';
  if (value.state === 'preparing') return 'Préparation en cours';
  return 'Envoi non effectué';
};
export function SolicitationActions({
  ticket,
  mutate,
  busy,
  readOnly,
  settings,
  demo,
}: {
  ticket: SupportTicket;
  mutate: Mutate;
  busy: boolean;
  readOnly: boolean;
  settings: () => void;
  demo: boolean;
}) {
  const [draft, setDraft] = useState<Draft | null>(null),
    [message, setMessage] = useState('');
  const subjectRef = useRef<HTMLInputElement>(null);
  const closed =
    !!ticket.solicitation &&
    ['accepted', 'submitting', 'uncertain', 'preparing'].includes(
      ticket.solicitation.state,
    );
  const stale = !!draft && draft.revision !== ticket.revision;
  async function prepare(intent: ReplyIntent) {
    setMessage('');
    const result = await mutate({
      action: 'previewSolicitationReply',
      ticketId: ticket.id,
      revision: ticket.revision,
      intent,
    });
    if (result?.draft) {
      setDraft({ ...(result.draft as Draft), revision: ticket.revision });
      requestAnimationFrame(() => subjectRef.current?.focus());
    }
  }
  return (
    <section
      className="support-solicitation-actions"
      aria-label="Actions de démarchage"
    >
      <div className="support-solicitation-caption">
        <Mail size={19} aria-hidden="true" />
        <div>
          <h3>À vous de choisir.</h3>
          <p>
            {ticket.state === 'review'
              ? 'Vérifiez qu’il s’agit bien d’une prospection avant de répondre.'
              : 'Une proposition. Aucune obligation.'}
          </p>
        </div>
      </div>
      {ticket.solicitation && (
        <p className="support-disposition" role="status">
          <Check size={16} aria-hidden="true" />
          {dispositionLabel(ticket.solicitation)}
        </p>
      )}
      {ticket.solicitation?.state === 'uncertain' && (
        <p className="support-small">
          Vérifiez les messages envoyés dans votre outil. Zentra ne renverra pas
          cette réponse pour éviter un doublon.
        </p>
      )}
      {ticket.solicitation?.state === 'accepted' && <p className="support-small">La messagerie a accepté la réponse. Sa livraison au destinataire n’est pas confirmée.</p>}
      {!draft && !closed && (
        <div className="support-solicitation-buttons">
          <Button
            variant="outline"
            disabled={busy || readOnly}
            onClick={() =>
              void mutate({
                action:
                  ticket.solicitation?.state === 'ignored'
                    ? 'restoreSolicitation'
                    : 'ignoreSolicitation',
                ticketId: ticket.id,
                revision: ticket.revision,
              })
            }
          >
            {ticket.solicitation?.state === 'ignored' ? (
              <>
                <Undo2 size={16} />
                Rétablir
              </>
            ) : (
              'Ignorer'
            )}
          </Button>
          <Button
            variant="outline"
            disabled={busy || readOnly}
            onClick={() => void prepare('interested')}
          >
            Intéressé
          </Button>
          <Button
            variant="outline"
            className="support-stop-button"
            disabled={busy || readOnly}
            onClick={() => void prepare('stop')}
          >
            STOP
          </Button>
        </div>
      )}
      {!draft && !closed && (
        <p className="support-small">
          Ignorer conserve le message. Les réponses sont à relire avant envoi.
        </p>
      )}
      {readOnly && (
        <p className="support-small">
          Votre accès permet de consulter ces messages. Un membre de l’équipe
          peut y répondre.
        </p>
      )}
      {draft && (
        <form
          className="support-reply-editor"
          onSubmit={async (e) => {
            e.preventDefault();
            const result = await mutate({
              action: 'sendSolicitationReply',
              ticketId: ticket.id,
              revision: draft.revision,
              intent: draft.intent,
              subject: draft.subject,
              body: draft.body,
              target: draft.target,
              fingerprint: draft.fingerprint,
              confirm: true,
            });
            if (result?.reply) {
              setDraft(null);
              setMessage(
                demo
                  ? 'Réponse simulée. Aucun e-mail envoyé.'
                  : (result.reply as { state: string }).state === 'accepted'
                    ? 'La messagerie a accepté votre réponse.'
                    : 'L’envoi reste à vérifier dans votre messagerie. Aucun renvoi automatique.',
              );
            }
          }}
        >
          <div className="support-reply-title">
            <h4>
              {draft.intent === 'stop'
                ? 'Demander l’arrêt du démarchage'
                : 'Répondre à cette proposition'}
            </h4>
            <Button
              type="button"
              variant="ghost"
              aria-label="Fermer la réponse"
              onClick={() => setDraft(null)}
              disabled={busy}
            >
              <X size={18} />
            </Button>
          </div>
          <dl className="support-reply-addresses">
            <div>
              <dt>À</dt>
              <dd>
                {draft.target?.recipient || 'À vérifier dans votre messagerie'}
              </dd>
            </div>
            <div>
              <dt>Depuis</dt>
              <dd>{draft.target?.from || 'Votre outil connecté'}</dd>
            </div>
          </dl>
          <Field
            ref={subjectRef}
            label="Objet de la réponse"
            value={draft.subject}
            maxLength={300}
            required
            readOnly={['Zendesk', 'Freshdesk'].includes(
              draft.target?.from || '',
            )}
            onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
          />
          <label className="support-field">
            Votre message
            <textarea
              rows={9}
              value={draft.body}
              maxLength={6000}
              required
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            />
          </label>
          <p className="support-small">
            {REPLY_LANGUAGES[draft.language]} · Modèle de votre entreprise,
            modifiable ici.
            {draft.intent === 'stop'
              ? ' Cette demande ne bloque pas techniquement l’expéditeur.'
              : ''}
          </p>
          {!draft.enabled && (
            <p className="support-small">
              Les réponses ne sont pas encore autorisées pour cet espace.{' '}
              <button type="button" onClick={settings}>
                Ouvrir les paramètres
              </button>
            </p>
          )}
          {draft.unavailable && (
            <p role="status" className="support-small">
              {draft.unavailable}
            </p>
          )}
          {stale && (
            <p role="alert">
              Ce message a changé. Conservez votre texte, puis rouvrez la
              réponse pour vérifier le destinataire.
            </p>
          )}
          <div className="support-reply-footer">
            <Button
              type="button"
              variant="ghost"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(draft.body);
                  setMessage('Texte copié.');
                } catch {
                  setMessage('Sélectionnez le texte pour le copier.');
                }
              }}
            >
              Copier le texte
            </Button>
            <Button
              className="support-primary"
              type="submit"
              disabled={
                busy ||
                readOnly ||
                stale ||
                !draft.enabled ||
                !draft.target ||
                !!draft.unavailable ||
                closed
              }
            >
              <Send size={16} />
              {busy
                ? 'Préparation…'
                : demo
                  ? 'Simuler l’envoi'
                  : 'Envoyer la réponse'}
            </Button>
          </div>
        </form>
      )}
      {message && (
        <p role="status" className="support-small">
          {message}
        </p>
      )}
    </section>
  );
}

export function SolicitationPreferences({
  data,
  mutate,
  busy,
}: {
  data: SupportState;
  mutate: Mutate;
  busy: boolean;
}) {
  const w = data.workspace!;
  const [notifications, setNotifications] = useState(
      !!w.solicitationNotifications,
    ),
    [enabled, setEnabled] = useState(!!w.repliesEnabled);
  const [settings, setSettings] = useState<SolicitationSettings>(
    w.solicitationSettings || {
      language: 'auto',
      signature: '',
      templates: {},
    },
  );
  const [lang, setLang] = useState<ReplyLanguage>('fr'),
    [intent, setIntent] = useState<ReplyIntent>('interested'),
    [saved, setSaved] = useState(false);
  return (
    <div className="support-solicitation-settings">
      <div className="support-section-heading">
        <div>
          <h1>Le démarchage, à votre rythme.</h1>
          <p>Des messages rangés à part. Vous décidez quand les consulter.</p>
        </div>
        <BellOff size={27} aria-hidden="true" />
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (
            await mutate({
              action: 'solicitationSettings',
              notifications,
              repliesEnabled: enabled,
              settings,
            })
          )
            setSaved(true);
        }}
        onChange={() => setSaved(false)}
      >
        <fieldset disabled={!w.canManage || busy}>
          <legend className="sr-only">Préférences pour toute l’équipe</legend>
          <label className="support-preference-row">
            <span>
              <strong>Recevoir les alertes de démarchage</strong>
              <small>
                Dans Support ouvert, pour cet espace. Désactivé par défaut.
              </small>
            </span>
            <input
              type="checkbox"
              checked={notifications}
              onChange={(e) => setNotifications(e.target.checked)}
            />
          </label>
          <p className="support-small">
            Les notifications de votre messagerie ou logiciel d’origine gardent
            leurs propres réglages. Un classement incertain reste à vérifier.
          </p>
          <label className="support-preference-row">
            <span>
              <strong>Autoriser les réponses depuis Support</strong>
              <small>
                Les collaborateurs peuvent envoyer une réponse avec les
                connexions existantes, après confirmation.
              </small>
            </span>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
          </label>
          <p className="support-small">
            Aucun envoi automatique. Infomaniak utilise votre boîte connectée ;
            les autres outils utilisent leur fonction de réponse.
          </p>
          <div className="support-reply-personalization">
            <h2>Votre voix, votre signature.</h2>
            <div className="support-form-grid">
              <Choice
                label="Langue des réponses"
                value={settings.language}
                onChange={(v) => {
                  setSaved(false);
                  setSettings({
                    ...settings,
                    language: v as SolicitationSettings['language'],
                  });
                }}
                options={[
                  { value: 'auto', label: 'Langue du message reçu' },
                  ...Object.entries(REPLY_LANGUAGES).map(([value, label]) => ({
                    value,
                    label,
                  })),
                ]}
              />
              <Field
                label="Signature"
                value={settings.signature}
                maxLength={500}
                placeholder={w.name}
                onChange={(e) =>
                  setSettings({ ...settings, signature: e.target.value })
                }
              />
            </div>
            <details className="support-context-details">
              <summary>Personnaliser les modèles de réponse</summary>
              <div className="support-form-grid">
                <Choice
                  label="Langue du modèle"
                  value={lang}
                  onChange={(v) => setLang(v as ReplyLanguage)}
                  options={Object.entries(REPLY_LANGUAGES).map(
                    ([value, label]) => ({ value, label }),
                  )}
                />
                <Choice
                  label="Réponse"
                  value={intent}
                  onChange={(v) => setIntent(v as ReplyIntent)}
                  options={[
                    { value: 'interested', label: 'Intéressé' },
                    { value: 'stop', label: 'STOP' },
                  ]}
                />
              </div>
              <label className="support-field">
                Texte du modèle
                <textarea
                  rows={8}
                  maxLength={4000}
                  value={
                    settings.templates[lang]?.[intent] ??
                    DEFAULT_REPLIES[lang][intent]
                  }
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      templates: {
                        ...settings.templates,
                        [lang]: {
                          ...settings.templates[lang],
                          [intent]: e.target.value,
                        },
                      },
                    })
                  }
                />
              </label>
              <p className="support-small">
                Variables : <code>{'{{entreprise}}'}</code>,{' '}
                <code>{'{{objet}}'}</code> et <code>{'{{signature}}'}</code>.
              </p>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setSaved(false);
                  setSettings({
                    ...settings,
                    templates: {
                      ...settings.templates,
                      [lang]: {
                        ...settings.templates[lang],
                        [intent]: DEFAULT_REPLIES[lang][intent],
                      },
                    },
                  });
                }}
              >
                Rétablir ce modèle
              </Button>
            </details>
          </div>
          <Button
            type="submit"
            className="support-primary"
            disabled={busy || !w.canManage}
          >
            {busy ? 'Enregistrement…' : 'Enregistrer les préférences'}
          </Button>
        </fieldset>
        {!w.canManage && (
          <p className="support-small">
            Ces préférences sont communes à l’équipe. Un administrateur peut les
            modifier.
          </p>
        )}
        {saved && (
          <p role="status" className="support-disposition">
            <Check size={16} />
            Préférences enregistrées.
          </p>
        )}
      </form>
    </div>
  );
}
