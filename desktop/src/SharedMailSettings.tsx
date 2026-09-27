import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, Mail } from 'lucide-react';
import { Button, ErrorPanel, Field } from './ui';
import { t } from './language';
import { errorMessage } from './utils';
import {
  outgoingMail,
  mailInterfaceMessage,
  type MailTarget,
  type SharedMailState,
} from './outgoingMail';

export type MailChannel = 'company' | 'device';

export function MailChannelChoice({
  value,
  onChange,
  disabled = false,
  compact = false,
}: {
  value: MailChannel;
  onChange: (value: MailChannel) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const group = useId();
  if (compact)
    return (
      <div className="mail-channel mail-channel--compact">
        <Field label={t('Adresse utilisée pour l’envoi')}>
          <select
            value={value}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value as MailChannel)}
          >
            <option value="company">
              {t('Pour l’entreprise')} · Infomaniak
            </option>
            <option value="device">{t('Sur cet appareil')} · SMTP</option>
          </select>
        </Field>
      </div>
    );
  return (
    <fieldset className="mail-channel" disabled={disabled}>
      <legend>{t('Adresse utilisée pour l’envoi')}</legend>
      <div className="mail-channel-options">
        {(['company', 'device'] as const).map((channel) => (
          <label key={channel} aria-label={t(channel === 'company' ? 'Pour l’entreprise' : 'Sur cet appareil')}>
            <input
              type="radio"
              name={group}
              checked={value === channel}
              onChange={() => onChange(channel)}
            />
            <span>
              <strong>
                {t(
                  channel === 'company'
                    ? 'Pour l’entreprise'
                    : 'Sur cet appareil',
                )}
              </strong>
              <small>
                {t(
                  channel === 'company'
                    ? 'Infomaniak · partagée avec l’équipe'
                    : 'SMTP · connexion locale',
                )}
              </small>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Scope-bound reads: a late response may never become another company's sender. */
export function useSharedMail(scope?: string, target?: MailTarget) {
  const [state, setState] = useState<SharedMailState | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const epoch = useRef(0);
  const entity = target?.entity,
    id = target?.id;
  const refresh = useCallback(async () => {
    if (!scope) return;
    const current = ++epoch.current;
    setLoading(true);
    setError('');
    try {
      const next = await outgoingMail.sharedState(
        scope,
        entity && id ? { entity, id } : undefined,
      );
      if (current !== epoch.current) return;
      if (next.scope !== scope)
        throw new Error('L’entreprise a changé. Rouvrez cet e-mail.');
      setState(next);
    } catch (reason) {
      if (current === epoch.current) {
        setState(null);
        setError(
          errorMessage(
            reason,
            'La messagerie partagée est indisponible. Vérifiez votre connexion puis réessayez.',
          ),
        );
      }
    } finally {
      if (current === epoch.current) setLoading(false);
    }
  }, [scope, entity, id]);
  useEffect(() => {
    const generation = epoch;
    void refresh();
    return () => {
      ++generation.current;
    };
  }, [refresh]);
  return { state: state?.scope === scope ? state : null, error, loading, refresh };
}

export function SharedMailSettings({
  scope,
  companyName,
  companyEmail,
  readOnly,
  onBusy,
}: {
  scope: string;
  companyName: string;
  companyEmail: string;
  readOnly: boolean;
  onBusy: (busy: boolean) => void;
}) {
  const shared = useSharedMail(scope);
  const [email, setEmail] = useState(companyEmail),
    [name, setName] = useState(companyName),
    [token, setToken] = useState('');
  const [editing, setEditing] = useState(false),
    [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const flight = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const connection = shared.state?.connection;
  const locked =
    busy || shared.loading || readOnly || !shared.state?.canConfigure;
  async function perform(action: () => Promise<void>) {
    if (flight.current || locked) return;
    flight.current = true;
    setBusy(true);
    onBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (reason) {
      if (mounted.current)
        setError(
          errorMessage(
            reason,
            'La messagerie partagée est indisponible. Vérifiez votre connexion puis réessayez.',
          ),
        );
    } finally {
      if (mounted.current) {
        setBusy(false);
        onBusy(false);
      }
      flight.current = false;
    }
  }
  return (
    <div className="mail-shared-settings">
      {shared.loading && !shared.state && (
        <p role="status">{t('Ouverture de la messagerie partagée…')}</p>
      )}
      {shared.error && (
        <ErrorPanel
          message={mailInterfaceMessage(shared.error)}
          onRetry={() => void shared.refresh()}
        />
      )}
      {error && <ErrorPanel message={mailInterfaceMessage(error)} />}
      {notice && (
        <p className="mail-notice" role="status">
          <Check size={17} />
          {t(notice)}
        </p>
      )}
      {shared.state?.available === false && (
        <p>
          {t(
            'Connectez votre compte dans Paramètres → Compte et choisissez l’entreprise pour partager une adresse d’envoi.',
          )}
        </p>
      )}
      {shared.state?.available && (
        <>
          <div className="mail-connection-state">
            <Mail size={20} aria-hidden="true" />
            <div>
              <strong>
                {connection?.connected
                  ? connection.fromEmail
                  : t('Une adresse pour toute l’équipe')}
              </strong>
              <span>
                {connection?.connected
                  ? connection.fromName
                  : t('Connectez Infomaniak une fois pour cette entreprise.')}
              </span>
            </div>
          </div>
          {!shared.state.canConfigure && (
            <p>{t('Un administrateur peut modifier ces réglages.')}</p>
          )}
          {connection?.connected && !editing ? (
            <>
              <p className="mail-help">
                {t(
                  'Les collaborateurs autorisés peuvent envoyer les documents depuis cette adresse sur leurs appareils.',
                )}
              </p>
              {shared.state.canConfigure && (
                <div className="mail-actions">
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={locked}
                    onClick={() => {
                      setEmail(connection.fromEmail ?? companyEmail);
                      setName(connection.fromName ?? companyName);
                      setEditing(true);
                      setConfirmDisconnect(false);
                      setNotice('');
                    }}
                  >
                    {t('Modifier la connexion')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={locked}
                    onClick={() => setConfirmDisconnect(true)}
                  >
                    {t('Déconnecter pour l’entreprise')}
                  </Button>
                </div>
              )}
              {confirmDisconnect && (
                <div className="mail-disconnect-confirm">
                  <p>
                    {t(
                      'Tous les collaborateurs perdront l’accès à cette adresse dans Zentra. Les envois déjà acceptés restent dans l’historique.',
                    )}
                  </p>
                  <div className="mail-actions">
                    <Button
                      type="button"
                      disabled={locked}
                      onClick={() =>
                        void perform(async () => {
                          await outgoingMail.disconnectShared(scope);
                          if (!mounted.current) return;
                          setConfirmDisconnect(false);
                          setToken('');
                          setNotice(
                            'Messagerie déconnectée pour l’entreprise.',
                          );
                          await shared.refresh();
                        })
                      }
                    >
                      {t('Confirmer la déconnexion')}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setConfirmDisconnect(false)}
                    >
                      {t('Annuler')}
                    </Button>
                  </div>
                </div>
              )}
            </>
          ) : (
            shared.state.canConfigure && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void perform(async () => {
                    const result = await outgoingMail.connectShared(scope, {
                      token,
                      fromEmail: email.trim(),
                      fromName: name.trim(),
                    });
                    if (!mounted.current) return;
                    setToken('');
                    if (result.scope !== scope)
                      throw new Error(
                        'L’entreprise a changé. Rouvrez cet e-mail.',
                      );
                    setEditing(false);
                    setNotice(
                      'Adresse vérifiée pour l’entreprise. Aucun e-mail de test n’a été envoyé.',
                    );
                    await shared.refresh();
                  });
                }}
              >
                <fieldset className="mail-fields" disabled={locked}>
                  <Field label={t('Adresse d’envoi')} required>
                    <input
                      type="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      autoComplete="email"
                      required
                    />
                  </Field>
                  <Field
                    label={t('Nom de l’expéditeur')}
                    required
                    hint={t('Le nom vérifié dans Infomaniak sera utilisé.')}
                  >
                    <input
                      value={name}
                      maxLength={120}
                      onChange={(event) => setName(event.target.value)}
                      autoComplete="organization"
                      required
                    />
                  </Field>
                  <Field
                    label={t('Clé API Infomaniak')}
                    required
                    hint={t(
                      'Utilisez une clé dédiée avec le droit workspace:mail. Le mot de passe de la boîte ne convient pas.',
                    )}
                  >
                    <input
                      type="password"
                      value={token}
                      maxLength={8192}
                      onChange={(event) => setToken(event.target.value)}
                      autoComplete="new-password"
                      spellCheck={false}
                      required
                    />
                  </Field>
                </fieldset>
                <p className="mail-help">
                  {t(
                    'La clé est conservée chiffrée sur le serveur Zentra. Cette connexion autorise l’envoi ; la connexion de lecture dans Support reste indépendante.',
                  )}
                </p>
                <div className="mail-actions">
                  <Button type="submit" disabled={locked}>
                    {busy
                      ? t('Vérification…')
                      : t('Connecter pour l’entreprise')}
                  </Button>
                  {connection?.connected && (
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        setEditing(false);
                        setToken('');
                        setError('');
                      }}
                    >
                      {t('Annuler')}
                    </Button>
                  )}
                </div>
              </form>
            )
          )}
        </>
      )}
    </div>
  );
}
