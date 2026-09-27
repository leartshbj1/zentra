import { useEffect, useRef, useState } from 'react';
import { Check, Paperclip, Send } from 'lucide-react';
import { Button, ErrorPanel, Field, Modal } from './ui';
import { errorMessage } from './utils';
import { t, getAppLocale, useAppLanguage } from './language';
import {
  outgoingMail,
  mailInterfaceMessage,
  type MailPreview,
  type MailState,
  type MailTarget,
  type MailResult,
  type MailStatus,
} from './outgoingMail';
import { MailSettings, CompanyMailSignature } from './MailSettings';
import {
  MailChannelChoice,
  useSharedMail,
  type MailChannel,
} from './SharedMailSettings';
import './outgoing-mail.css';

function statusText(status: MailStatus) {
  return t(
    status === 'accepted'
      ? 'Accepté par le serveur'
      : status === 'rejected'
        ? 'Refusé par le serveur'
        : 'Envoi non confirmé — à vérifier avant de renvoyer',
  );
}

export function MailComposer({
  target,
  onClose,
  onSent,
}: {
  target: MailTarget;
  onClose: () => void;
  onSent?: () => void;
}) {
  return (
    <MailComposerSession
      key={`${target.entity}:${target.id}`}
      target={target}
      onClose={onClose}
      onSent={onSent}
    />
  );
}
function MailComposerSession({
  target,
  onClose,
  onSent,
}: {
  target: MailTarget;
  onClose: () => void;
  onSent?: () => void;
}) {
  useAppLanguage();
  const [preview, setPreview] = useState<MailPreview | null>(null),
    [state, setState] = useState<MailState | null>(null);
  const [recipient, setRecipient] = useState(''),
    [subject, setSubject] = useState(''),
    [body, setBody] = useState('');
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [sent, setSent] = useState(false),
    [settings, setSettings] = useState(false),
    [attempt, setAttempt] = useState(0);
  const [attempted, setAttempted] = useState(false),
    [historyWarning, setHistoryWarning] = useState(false),
    [resultStatus, setResultStatus] = useState<MailStatus | null>(null);
  const [chosenChannel, setChannel] = useState<MailChannel | null>(null);
  const flight = useRef(false),
    requestId = useRef(crypto.randomUUID()),
    active = useRef(true);
  const shared = useSharedMail(preview?.scope, target);
  const channel = chosenChannel ?? (!shared.state || shared.state.connection.connected ? 'company' : state?.connection.connected || !shared.state.available ? 'device' : 'company');
  const { entity, id } = target;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    let current = true;
    void Promise.all([outgoingMail.preview({ entity, id }), outgoingMail.state()])
      .then(([p, s]) => {
        if (!current) return;
        if (p.scope !== s.scope)
          throw new Error('L’entreprise a changé. Rouvrez cet e-mail.');
        setPreview(p);
        setError('');
        setState(s);
        setRecipient(p.recipient);
        setSubject(p.subject);
        setBody(p.body);
      })
      .catch((reason) => {
        if (current)
          setError(
            errorMessage(
              reason,
              'La messagerie n’a pas pu être ouverte. Réessayez.',
            ),
          );
      });
    return () => {
      current = false;
    };
  }, [entity, id, attempt]);
  const connected =
    channel === 'company'
      ? Boolean(
          shared.state?.connection.connected &&
          shared.state.canSend &&
          !shared.loading &&
          !shared.error,
        )
      : Boolean(state?.connection.connected);
  const sender =
    channel === 'company' ? shared.state?.connection : state?.connection;
  const history = [
    ...(preview?.history ?? []),
    ...(shared.state?.history ?? []).filter(
      (item) =>
        !preview?.history.some((local) => local.requestId === item.requestId),
    ),
  ]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, 10);
  async function returnToMessage() {
    setBusy(true);
    setError('');
    try {
      const [next, nextState] = await Promise.all([
        outgoingMail.preview(target),
        outgoingMail.state(),
      ]);
      if (!active.current) return;
      if (next.scope !== nextState.scope || next.scope !== preview?.scope)
        throw new Error('L’entreprise a changé. Rouvrez cet e-mail.');
      if (next.sourceRevision !== preview?.sourceRevision) {
        setRecipient(next.recipient);
        setSubject(next.subject);
        setBody(next.body);
      }
      setPreview(next);
      setState(nextState);
      await shared.refresh();
      if(active.current) setChannel(null);
    } catch (reason) {
      if (active.current)
        setError(
          errorMessage(
            reason,
            'La messagerie n’a pas pu être ouverte. Réessayez.',
          ),
        );
    } finally {
      if (active.current) {
        setSettings(false);
        setBusy(false);
      }
    }
  }
  function handleResult(result: MailResult) {
    setResultStatus(result.status);
    if (result.message) setError(result.message);
    if (result.status === 'accepted') {
      setHistoryWarning(Boolean(result.historyWarning));
      setSent(true);
      onSent?.();
    }
  }
  async function send() {
    if (
      flight.current ||
      attempted ||
      !preview ||
      preview.signatureLogoError ||
      !connected ||
      sent
    )
      return;
    flight.current = true;
    setBusy(true);
    setError('');
    setAttempted(true);
    setChannel(channel);
    try {
      const input = {
        requestId: requestId.current,
        scope: preview.scope,
        target,
        sourceRevision: preview.sourceRevision,
        recipient: recipient.trim(),
        subject,
        body,
      };
      const result =
        channel === 'company'
          ? await outgoingMail.sendShared(
              input,
              shared.state!.connection.connectionId!,
            )
          : await outgoingMail.send(input);
      if (active.current) handleResult(result);
    } catch (reason) {
      if (active.current)
        setError(
          errorMessage(
            reason,
            'L’envoi n’a pas pu être confirmé. Vérifiez votre messagerie avant de renvoyer.',
          ),
        );
    } finally {
      if (active.current) setBusy(false);
      flight.current = false;
    }
  }
  async function recover(id: string) {
    if (flight.current || !preview) return;
    flight.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await outgoingMail.recoverShared(preview.scope, id);
      if (!active.current) return;
      if (id === requestId.current) handleResult(result);
      const next = await outgoingMail.preview(target);
      if (!active.current) return;
      if (next.scope !== preview.scope)
        throw new Error('L’entreprise a changé. Rouvrez cet e-mail.');
      setPreview((current) =>
        current ? { ...current, history: next.history } : current,
      );
      await shared.refresh();
    } catch (reason) {
      if (active.current)
        setError(
          errorMessage(
            reason,
            'L’envoi n’a pas pu être confirmé. Vérifiez votre messagerie avant de renvoyer.',
          ),
        );
    } finally {
      if (active.current) setBusy(false);
      flight.current = false;
    }
  }
  return (
    <Modal
      title={
        sent
          ? t('E-mail transmis')
          : settings
            ? t('Votre messagerie')
            : t('Envoyer par e-mail')
      }
      onClose={onClose}
      dismissible={!busy}
    >
      <div className="mail-composer">
        {sent ? (
          <>
            <p className="mail-notice" role="status">
              <Check size={20} />
              {t(
                'Le serveur de votre messagerie a accepté l’e-mail pour {recipient}.',
                { recipient },
              )}
            </p>
            <p>
              {t(
                'Le PDF est joint. La réception par le destinataire n’est pas encore confirmée.',
              )}
            </p>
            {historyWarning && (
              <div className="mail-recovery">
                <p role="alert">
                  {t(
                    'L’historique local n’a pas pu être complété. L’e-mail a été accepté : ne le renvoyez pas pour cette raison.',
                  )}
                </p>
                {channel === 'company' && (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void recover(requestId.current)}
                  >
                    {t('Vérifier l’état de l’envoi')}
                  </Button>
                )}
                {error && <ErrorPanel message={mailInterfaceMessage(error)} />}
              </div>
            )}
            <Button type="button" disabled={busy} onClick={onClose}>
              {t('Terminer')}
            </Button>
          </>
        ) : settings ? (
          <>
            <MailSettings
              initialTab={
                connected
                  ? target.entity === 'quotes'
                    ? 'quotes'
                    : 'invoices'
                  : 'connection'
              }
              onBusyChange={setBusy}
            />
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => void returnToMessage()}
            >
              {t('Revenir au message')}
            </Button>
          </>
        ) : (
          <>
            {error && (
              <ErrorPanel
                message={mailInterfaceMessage(error)}
                onRetry={!preview ? () => setAttempt((n) => n + 1) : undefined}
              />
            )}
            {!preview && !error && (
              <p role="status">{t('Préparation de l’e-mail…')}</p>
            )}
            {preview && (
              <>
                <MailChannelChoice
                  compact
                  value={channel}
                  disabled={busy || attempted}
                  onChange={(next) => {
                setChannel(next);
                    setError('');
                  }}
                />
                {channel === 'company' && (
                  <>
                    {shared.loading && (
                      <p role="status">
                        {t('Ouverture de la messagerie partagée…')}
                      </p>
                    )}
                    {shared.error && (
                      <ErrorPanel
                        message={mailInterfaceMessage(shared.error)}
                        onRetry={
                          !busy && !attempted
                            ? () => void shared.refresh()
                            : undefined
                        }
                      />
                    )}
                    {shared.state?.available === false && (
                      <p>
                        {t(
                          'Connectez votre compte dans Paramètres → Compte et choisissez l’entreprise pour partager une adresse d’envoi.',
                        )}
                      </p>
                    )}
                    {shared.state?.connection.connected &&
                      !shared.state.canSend && (
                        <p>
                          {t(
                            'Votre compte ne peut pas envoyer les documents de cette entreprise. Vérifiez votre accès à Zentra Gestion avec un administrateur.',
                          )}
                        </p>
                      )}
                  </>
                )}
                {sender?.connected ? (
                  <p className="mail-from">
                    {t('De :')} <strong>{sender.fromName}</strong>
                    <span>{sender.fromEmail}</span>
                  </p>
                ) : (
                  !shared.loading &&
                  (channel === 'device' || shared.state?.available) && (
                    <div className="mail-connect-prompt">
                      <p>
                        {t(
                          'Connectez votre messagerie pour envoyer depuis votre adresse.',
                        )}
                      </p>
                      <Button
                        type="button"
                        disabled={busy || attempted}
                        onClick={() => setSettings(true)}
                      >
                        {t('Connecter ma messagerie')}
                      </Button>
                    </div>
                  )
                )}
                {history.length > 0 && (
                  <details className="mail-history">
                    <summary>{t('Historique des envois')}</summary>
                    {history.map((item, index) => (
                      <div
                        className="mail-history-row"
                        key={item.requestId ?? index}
                      >
                        <p>
                          {new Date(item.createdAt).toLocaleString(
                            getAppLocale(),
                          )}{' '}
                          · {item.recipient}
                          <br />
                          {statusText(item.status)}
                        </p>
                        {item.channel === 'company_mail' &&
                          item.requestId &&
                          item.status !== 'accepted' && (
                            <Button
                              type="button"
                              variant="secondary"
                              disabled={busy}
                              onClick={() => void recover(item.requestId!)}
                            >
                              {t('Vérifier l’état de l’envoi')}
                            </Button>
                          )}
                      </div>
                    ))}
                  </details>
                )}
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void send();
                  }}
                >
                  <fieldset
                    className="mail-fields mail-fields--single"
                    disabled={busy || attempted}
                  >
                    <Field
                      label={t('À')}
                      required
                      hint={
                        !preview.recipient
                          ? t('Ajoutez l’adresse du client pour cet envoi.')
                          : undefined
                      }
                    >
                      <input
                        type="email"
                        required
                        value={recipient}
                        onChange={(event) => setRecipient(event.target.value)}
                        autoComplete="email"
                      />
                    </Field>
                    <Field label={t('Objet')} required>
                      <input
                        required
                        maxLength={250}
                        value={subject}
                        onChange={(event) => setSubject(event.target.value)}
                      />
                    </Field>
                    <Field label={t('Message')} required>
                      <textarea
                        required
                        rows={10}
                        value={body}
                        onChange={(event) => setBody(event.target.value)}
                      />
                    </Field>
                  </fieldset>
                  {preview.signatureLogoDataUrl && (
                    <CompanyMailSignature logo={preview.signatureLogoDataUrl} />
                  )}
                  {preview.signatureLogoError && (
                    <div className="mail-signature-issue">
                      <p role="alert">
                        {mailInterfaceMessage(preview.signatureLogoError)}
                      </p>
                      {state?.canConfigure && (
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={busy || attempted}
                          onClick={() => setSettings(true)}
                        >
                          {t('Modifier les réglages des e-mails')}
                        </Button>
                      )}
                    </div>
                  )}
                  <p className="mail-attachment">
                    <Paperclip size={17} />
                    <span>{preview.attachmentName}</span>
                    <small>{t('PDF joint automatiquement')}</small>
                  </p>
                  <div className="mail-actions">
                    <Button
                      type="submit"
                      disabled={
                        busy ||
                        attempted ||
                        !connected ||
                        Boolean(preview.signatureLogoError)
                      }
                    >
                      <Send size={16} />
                      {busy ? t('Envoi en cours…') : t('Envoyer l’e-mail')}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={busy}
                      onClick={onClose}
                    >
                      {attempted ? t('Fermer') : t('Annuler')}
                    </Button>
                  </div>
                </form>
                {attempted && !busy && (
                  <div className="mail-recovery">
                    {resultStatus && (
                      <p role="status">{statusText(resultStatus)}</p>
                    )}
                    {channel === 'company' && (
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => void recover(requestId.current)}
                      >
                        {t('Vérifier l’état de l’envoi')}
                      </Button>
                    )}
                    <p className="mail-help">
                      {t(
                        'Aucun renvoi automatique. Après vérification, fermez puis rouvrez le message si vous devez préparer un nouvel envoi.',
                      )}
                    </p>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
