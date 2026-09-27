import { useEffect, useRef, useState } from 'react';
import { Check, Mail } from 'lucide-react';
import { Button, ErrorPanel, Field } from './ui';
import { errorMessage } from './utils';
import {
  mailConnectionInput,
  mailTemplateError,
  mailVariables,
  outgoingMail,
  type MailConnection,
  type MailState,
} from './outgoingMail';
import { t, useAppLanguage } from './language';
import { mailInterfaceMessage } from './outgoingMail';
import {
  MailChannelChoice,
  SharedMailSettings,
  type MailChannel,
} from './SharedMailSettings';
import './outgoing-mail.css';

const emptyConnection: MailConnection = {
  host: 'mail.infomaniak.com',
  port: 465,
  security: 'tls',
  username: '',
  fromEmail: '',
  fromName: '',
  password: '',
};
export function MailSettings({
  companyName = '',
  companyEmail = '',
  readOnly = false,
  initialTab = 'connection',
  embedded = false,
  onSaved,
  onBusyChange,
}: {
  companyName?: string;
  companyEmail?: string;
  readOnly?: boolean;
  initialTab?: 'connection' | 'quotes' | 'invoices';
  embedded?: boolean;
  onSaved?: () => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
}) {
  useAppLanguage();
  const [state, setState] = useState<MailState | null>(null);
  const [connection, setConnection] = useState<MailConnection>({
    ...emptyConnection,
    fromName: companyName,
    username: companyEmail,
    fromEmail: companyEmail,
  });
  const [tab, setTab] = useState<'connection' | 'quotes' | 'invoices'>(
    initialTab,
  );
  const [provider, setProvider] = useState('infomaniak');
  const [channel, setChannel] = useState<MailChannel>('company');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  const flight = useRef(false);
  const field = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const focused = useRef<'subject' | 'body'>('body');
  useEffect(() => {
    let active = true;
    void outgoingMail
      .state()
      .then((value) => {
        if (!active) return;
        setState(value);
        setConnection((current) =>
          mailConnectionInput({
            ...current,
            ...value.connection,
            password: '',
          }),
        );
        if (value.connection.connected)
          setProvider(
            value.connection.host === 'mail.infomaniak.com'
              ? 'infomaniak'
              : 'smtp',
          );
      })
      .catch((reason) => {
        if (active)
          setError(
            errorMessage(
              reason,
              'La messagerie n’a pas pu être ouverte. Réessayez.',
            ),
          );
      });
    return () => {
      active = false;
    };
  }, [attempt]);
  const locked = busy || readOnly || !state?.canConfigure;
  async function perform(action: () => Promise<void>) {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (reason) {
      setError(
        errorMessage(
          reason,
          'La messagerie n’a pas pu être ouverte. Réessayez.',
        ),
      );
    } finally {
      setBusy(false);
      flight.current = false;
    }
  }
  function patch(patch: Partial<MailConnection>) {
    setConnection((value) => ({ ...value, ...patch }));
    setNotice('');
  }
  function insertVariable(key: string) {
    if (!state || tab === 'connection') return;
    setNotice('');
    const name = focused.current,
      current = state.templates[tab][name],
      element = field.current;
    const start = element?.selectionStart ?? current.length,
      end = element?.selectionEnd ?? start;
    const token = `{${key}}`,
      next = current.slice(0, start) + token + current.slice(end);
    setState({
      ...state,
      templates: {
        ...state.templates,
        [tab]: { ...state.templates[tab], [name]: next },
      },
    });
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(start + token.length, start + token.length);
    });
  }
  return (
    <section className="mail-settings">
      {!embedded && (
        <header>
          <h2>{t('Vos e-mails, depuis Zentra.')}</h2>
          <p>
            {t(
              'Devis, factures et relances avec votre adresse professionnelle.',
            )}
          </p>
        </header>
      )}
      <nav className="mail-tabs" aria-label={t('Réglages des e-mails')}>
        {(
          [
            ['connection', 'Messagerie'],
            ['quotes', 'Devis'],
            ['invoices', 'Factures'],
          ] as const
        ).map(([id, label]) => (
          <Button
            type="button"
            key={id}
            variant={tab === id ? 'primary' : 'ghost'}
            aria-pressed={tab === id}
            disabled={busy}
            onClick={() => {
              setTab(id);
              setError('');
              setNotice('');
            }}
          >
            {t(label)}
          </Button>
        ))}
      </nav>
      {error && (
        <ErrorPanel
          message={mailInterfaceMessage(error)}
          onRetry={
            !state
              ? () => {
                  setError('');
                  setAttempt((n) => n + 1);
                }
              : undefined
          }
        />
      )}
      {notice && (
        <p className="mail-notice" role="status">
          <Check size={17} />
          {t(notice)}
        </p>
      )}
      {!state && !error && (
        <p role="status">{t('Ouverture de la messagerie…')}</p>
      )}
      {state && !state.canConfigure && (
        <p>{t('Un administrateur peut modifier ces réglages.')}</p>
      )}
      {state && tab === 'connection' && (
        <MailChannelChoice
          value={channel}
          onChange={setChannel}
          disabled={busy}
        />
      )}
      {state && tab === 'connection' && channel === 'company' && (
        <SharedMailSettings
          key={state.scope}
          scope={state.scope}
          companyName={companyName || connection.fromName}
          companyEmail={companyEmail || connection.fromEmail}
          readOnly={readOnly || !state.canConfigure}
          onBusy={setBusy}
        />
      )}
      {state && tab === 'connection' && channel === 'device' && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!locked)
              void perform(async () => {
                const result = await outgoingMail.connect(
                  state.scope,
                  connection,
                );
                setState({ ...state, connection: result });
                setConnection((value) => ({ ...value, password: '' }));
                setNotice(
                  'Connexion vérifiée et enregistrée. Aucun e-mail de test n’a été envoyé.',
                );
              });
          }}
        >
          <div className="mail-connection-state">
            <Mail size={20} />
            <div>
              <strong>
                {state.connection.connected
                  ? state.connection.fromEmail
                  : t('Connecter une messagerie')}
              </strong>
              <span>
                {state.connection.connected
                  ? t('Connectée sur cet appareil')
                  : t(
                      'Connexion chiffrée · mot de passe dans le coffre de cet appareil',
                    )}
              </span>
            </div>
          </div>
          <fieldset disabled={locked} className="mail-fields">
            <Field label={t('Fournisseur de messagerie')}>
              <select
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value);
                  if (e.target.value === 'infomaniak')
                    patch({
                      host: 'mail.infomaniak.com',
                      port: 465,
                      security: 'tls',
                    });
                }}
              >
                <option value="infomaniak">Infomaniak</option>
                <option value="smtp">{t('Autre messagerie · SMTP')}</option>
              </select>
            </Field>
            <Field label={t('Nom de l’expéditeur')} required>
              <input
                value={connection.fromName}
                maxLength={200}
                onChange={(e) => patch({ fromName: e.target.value })}
                required
                autoComplete="organization"
              />
            </Field>
            <Field label={t('Adresse d’envoi')} required>
              <input
                type="email"
                value={connection.fromEmail}
                onChange={(e) =>
                  patch({
                    fromEmail: e.target.value,
                    ...(connection.username === connection.fromEmail
                      ? { username: e.target.value }
                      : {}),
                  })
                }
                required
                autoComplete="email"
              />
            </Field>
            <Field label={t('Identifiant SMTP')} required>
              <input
                value={connection.username}
                onChange={(e) => patch({ username: e.target.value })}
                required
                autoComplete="username"
              />
            </Field>
            <Field
              label={t('Mot de passe de la boîte mail')}
              required={!state.connection.connected}
              hint={
                state.connection.connected
                  ? t('Laissez vide pour conserver le mot de passe enregistré.')
                  : t(
                      'Selon le fournisseur, utilisez le mot de passe de la boîte ou un mot de passe d’application.',
                    )
              }
            >
              <input
                type="password"
                value={connection.password}
                onChange={(e) => patch({ password: e.target.value })}
                required={!state.connection.connected}
                autoComplete="new-password"
              />
            </Field>
            {provider === 'smtp' && (
              <>
                <Field label={t('Serveur SMTP')} required>
                  <input
                    value={connection.host}
                    onChange={(e) => patch({ host: e.target.value.trim() })}
                    placeholder="smtp.votre-fournisseur.ch"
                    required
                  />
                </Field>
                <Field label={t('Chiffrement')}>
                  <select
                    value={connection.security}
                    onChange={(e) =>
                      patch({
                        security: e.target.value as 'tls' | 'starttls',
                        port: e.target.value === 'tls' ? 465 : 587,
                      })
                    }
                  >
                    <option value="tls">{t('TLS · port 465')}</option>
                    <option value="starttls">{t('STARTTLS · port 587')}</option>
                  </select>
                </Field>
                <Field label={t('Port')} required>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={connection.port}
                    onChange={(e) => patch({ port: Number(e.target.value) })}
                    required
                  />
                </Field>
              </>
            )}
          </fieldset>
          <div className="mail-actions">
            <Button type="submit" disabled={locked}>
              {busy
                ? t('Vérification…')
                : state.connection.connected
                  ? t('Vérifier et enregistrer')
                  : t('Connecter ma messagerie')}
            </Button>
            {state.connection.connected && (
              <Button
                type="button"
                variant="ghost"
                disabled={locked}
                onClick={() =>
                  void perform(async () => {
                    await outgoingMail.disconnect(state.scope);
                    setState({ ...state, connection: { connected: false } });
                    setConnection((value) => ({ ...value, password: '' }));
                    setNotice('Messagerie déconnectée sur cet appareil.');
                  })
                }
              >
                {t('Déconnecter')}
              </Button>
            )}
          </div>
          <p className="mail-help">
            {t(
              'À connecter une fois sur chaque appareil. Les modèles des documents suivent l’entreprise ; le mot de passe reste sur cet appareil. Les comptes nécessitant uniquement OAuth ne sont pas pris en charge par SMTP avec mot de passe.',
            )}
          </p>
        </form>
      )}
      {state && tab !== 'connection' && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!locked)
              void perform(async () => {
                const issue =
                  mailTemplateError(state.templates.quotes) ||
                  mailTemplateError(state.templates.invoices);
                if (issue) throw new Error(issue);
                await outgoingMail.saveTemplates(
                  state.scope,
                  state.templates,
                  state.signature ?? { includeCompanyLogo: false },
                );
                setNotice('Modèles enregistrés pour l’entreprise.');
                await onSaved?.();
              });
          }}
        >
          <p>
            {t(
              'Préparé pour chaque client. Vous pourrez toujours modifier le message avant l’envoi.',
            )}
          </p>
          <fieldset
            className="mail-fields mail-fields--single"
            disabled={locked}
          >
            <Field label={t('Objet')} required>
              <input
                value={state.templates[tab].subject}
                maxLength={250}
                onFocus={(e) => {
                  focused.current = 'subject';
                  field.current = e.currentTarget;
                }}
                onChange={(e) => {
                  setNotice('');
                  setState({
                    ...state,
                    templates: {
                      ...state.templates,
                      [tab]: {
                        ...state.templates[tab],
                        subject: e.target.value,
                      },
                    },
                  });
                }}
                required
              />
            </Field>
            <Field label={t('Message')} required>
              <textarea
                value={state.templates[tab].body}
                rows={10}
                onFocus={(e) => {
                  focused.current = 'body';
                  field.current = e.currentTarget;
                }}
                onChange={(e) => {
                  setNotice('');
                  setState({
                    ...state,
                    templates: {
                      ...state.templates,
                      [tab]: { ...state.templates[tab], body: e.target.value },
                    },
                  });
                }}
                required
              />
            </Field>
          </fieldset>
          <div
            className="mail-variables"
            aria-label={t('Insérer une variable')}
          >
            {mailVariables.map(([key, label]) => (
              <Button
                type="button"
                key={key}
                variant="ghost"
                size="small"
                disabled={locked}
                onClick={() => insertVariable(key)}
                title={t('Insérer {variable}', { variable: `{${key}}` })}
              >
                {t(label)}
              </Button>
            ))}
          </div>
          <div className="mail-signature-settings">
            <label className="mail-signature-toggle" aria-label={t('Ajouter le logo de l’entreprise')}>
              <input
                type="checkbox"
                role="switch"
                aria-checked={Boolean(state.signature?.includeCompanyLogo)}
                checked={Boolean(state.signature?.includeCompanyLogo)}
                disabled={
                  locked ||
                  (!state.companyLogoDataUrl &&
                    !state.signature?.includeCompanyLogo)
                }
                onChange={(event) => {
                  setNotice('');
                  setState({
                    ...state,
                    signature: { includeCompanyLogo: event.target.checked },
                  });
                }}
              />
              <span>
                <strong>{t('Ajouter le logo de l’entreprise')}</strong>
                <small>
                  {t(
                    'Après votre message, pour les devis, factures et relances.',
                  )}
                </small>
              </span>
            </label>
            {state.signature?.includeCompanyLogo &&
              state.companyLogoDataUrl && (
                <CompanyMailSignature logo={state.companyLogoDataUrl} />
              )}
            {!state.companyLogoDataUrl && (
              <p className="mail-help">
                {state.companyLogoError
                  ? mailInterfaceMessage(state.companyLogoError)
                  : t(
                      'Ajoutez votre logo dans Paramètres → Entreprise pour l’utiliser ici.',
                    )}
              </p>
            )}
          </div>
          <div className="mail-actions">
            <Button type="submit" disabled={locked}>
              {busy ? t('Enregistrement…') : t('Enregistrer les modèles')}
            </Button>
          </div>
          <p className="mail-help">
            {t(
              'Les textes des relances se règlent dans Relances → Cycle & textes.',
            )}
          </p>
        </form>
      )}
    </section>
  );
}

export function CompanyMailSignature({ logo }: { logo: string }) {
  return (
    <figure className="mail-signature-preview">
      <figcaption>{t('Logo ajouté après votre message')}</figcaption>
      <div className="mail-signature-paper" data-document-colors>
        <img src={logo} alt={t('Logo de l’entreprise')} />
      </div>
    </figure>
  );
}
