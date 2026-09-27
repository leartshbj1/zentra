import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Download,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  RotateCw,
  Server,
  ShieldCheck,
} from 'lucide-react';
import {
  activeUpdaterStep,
  formatUpdateBytes,
  formatUpdateDate,
  initialUpdaterProgress,
  reduceUpdaterProgress,
  updaterSteps,
  updaterFailureExplanation,
} from './appUpdaterLogic';
import { desktopApi } from './bridge';
import {
  checkUpdateAvailability,
  clearAvailableUpdate,
  getAvailableUpdate,
  pauseBackgroundUpdateChecks,
} from './updateAvailability';
import type {
  SecureUpdateEvent,
  SecureUpdateMetadata,
  SecureUpdaterPolicy,
} from './types';
import { Button, SectionHeading } from './ui';
import { errorMessage } from './utils';
import { ReleaseHistory } from './ReleaseHistory';
import { t, getAppLocale, useAppLanguage, type InterfaceMessage } from './language';
import './app-updater-readability.css';

type CheckOutcome = 'idle' | 'available' | 'current' | 'installed';

export const APP_UPDATER_TARGET_ID = 'app-updater';

export function AppUpdater({
  onInstallingChange,
}: { onInstallingChange?: (installing: boolean) => void } = {}) {
  useAppLanguage();
  const sectionRef = useRef<HTMLElement>(null);
  const [policy, setPolicy] = useState<SecureUpdaterPolicy | null>(null);
  const [policyLoading, setPolicyLoading] = useState(true);
  const [available, setAvailable] = useState<SecureUpdateMetadata | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [progress, setProgress] = useState(initialUpdaterProgress);
  const [outcome, setOutcome] = useState<CheckOutcome>('idle');
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [message, setMessage] = useState<string | InterfaceMessage>(
    'Lecture de la politique de mise à jour…',
  );
  const [error, setError] = useState('');
  const [installationDetail, setInstallationDetail] = useState('');

  useEffect(() => {
    const resume = pauseBackgroundUpdateChecks();
    let active = true;
    void desktopApi
      .getSecureUpdatePolicy()
      .then(async (value) => {
        if (!active) return;
        setPolicy(value);
        if (value.enabled && getAvailableUpdate()) {
          setChecking(true);
          try {
            const update = await checkUpdateAvailability(true);
            if (!active) return;
            setAvailable(update);
            setOutcome(update ? 'available' : 'current');
            setCheckedAt(new Date().toISOString());
            setMessage(
              update
                ? { source: 'Zentra {version} est prête à télécharger.', values: { version: update.version } }
                : { source: 'Zentra {version} est déjà à jour.', values: { version: value.currentVersion } },
            );
          } finally {
            if (active) setChecking(false);
          }
          return;
        }
        setMessage(
          value.enabled
            ? 'Le canal stable est prêt. Lancez une recherche quand vous le souhaitez.'
            : value.reason,
        );
      })
      .catch((reason) => {
        if (!active) return;
        setError(
          errorMessage(
            reason,
            'La politique de mise à jour locale n’a pas pu être lue. Vous pouvez réessayer.',
          ),
        );
      })
      .finally(() => {
        if (active) setPolicyLoading(false);
      });
    return () => {
      active = false;
      resume();
    };
  }, []);

  async function checkNow() {
    setInstallationDetail('');
    setChecking(true);
    setConfirming(false);
    setError('');
    setAvailable(null);
    setOutcome('idle');
    setProgress(initialUpdaterProgress);
    setMessage('Lecture du canal stable…');
    try {
      const currentPolicy = await desktopApi.getSecureUpdatePolicy();
      setPolicy(currentPolicy);
      if (!currentPolicy.enabled) {
        setMessage(currentPolicy.reason);
        return;
      }
      setMessage('Connexion HTTPS au canal stable…');
      const update = await checkUpdateAvailability(true);
      setAvailable(update);
      setOutcome(update ? 'available' : 'current');
      setCheckedAt(new Date().toISOString());
      setMessage(
        update
          ? { source: 'Zentra {version} est disponible. Sa signature sera contrôlée avant l’installation.', values: { version: update.version } }
          : { source: 'Zentra {version} est déjà à jour.', values: { version: currentPolicy.currentVersion } },
      );
    } catch (reason) {
      setError(
        errorMessage(
          reason,
          'La recherche sécurisée n’a pas abouti. Vérifiez la connexion, puis réessayez.',
        ),
      );
    } finally {
      setChecking(false);
    }
  }

  function receiveEvent(event: SecureUpdateEvent) {
    setProgress((current) => reduceUpdaterProgress(current, event));
    if (event.event === 'preparing') {
      setMessage('Préparation du téléchargement signé…');
      return;
    }
    if (event.event === 'started') {
      setMessage('Téléchargement HTTPS en cours…');
      return;
    }
    if (event.event === 'progress') return;
    if (event.event === 'verifying') {
      setMessage(
        'Téléchargement terminé. Zentra vérifie la signature, puis remet l’installation au système. L’application va se fermer et redémarrer automatiquement.',
      );
      return;
    }
    setAvailable(null);
    setOutcome('installed');
    clearAvailableUpdate();
    setMessage(
      'La mise à jour a été remise au système. Zentra redémarre automatiquement avec la nouvelle version.',
    );
  }

  async function install() {
    if (!available) return;
    setConfirming(false);
    setInstalling(true);
    onInstallingChange?.(true);
    // The confirmation button disappears during installation. Keep keyboard
    // focus on the persistent panel so the surrounding dialog retains it.
    sectionRef.current?.focus({ preventScroll: true });
    setError('');
    setInstallationDetail('');
    setMessage('Préparation de la mise à jour…');
    try {
      await desktopApi.installSecureUpdate(receiveEvent);
    } catch (reason) {
      setProgress(initialUpdaterProgress);
      setOutcome('available');
      const detail = errorMessage(reason, 'L’installation n’a pas abouti. La mise à jour reste disponible : réessayez après vérification.');
      const explanation = updaterFailureExplanation(detail);
      setError(explanation || detail);
      setInstallationDetail(explanation ? detail : '');
    } finally {
      setInstalling(false);
      onInstallingChange?.(false);
    }
  }

  const messageText = typeof message === 'string' ? t(message) : t(message.source, message.values);
  const progressLabel =
    progress.phase === 'downloading'
      ? progress.contentLength
        ? t('{downloaded} sur {total}', { downloaded: formatUpdateBytes(progress.downloadedBytes), total: formatUpdateBytes(progress.contentLength) })
        : t('{downloaded} téléchargés', { downloaded: formatUpdateBytes(progress.downloadedBytes) })
      : messageText;
  const activeStep = activeUpdaterStep({
    checking,
    phase: progress.phase,
    updateAvailable: Boolean(available),
  });
  const statusTone = error
    ? 'is-error'
    : outcome === 'installed' || outcome === 'current'
      ? 'is-success'
      : outcome === 'available'
        ? 'is-update'
        : policy?.enabled
          ? 'is-ready'
          : 'is-disabled';
  const statusTitle = error
    ? 'Une action est nécessaire'
    : installing
      ? 'Mise à jour en cours'
      : outcome === 'installed'
        ? 'Installation lancée'
        : outcome === 'current'
          ? 'Zentra est à jour'
          : outcome === 'available'
            ? 'Mise à jour prête à télécharger'
            : policyLoading
              ? 'Vérification du canal…'
              : policy?.enabled
                ? 'Canal stable protégé'
                : 'Canal inactif dans cette édition';
  const statusIcon = error ? (
    <AlertTriangle size={22} />
  ) : policyLoading || checking || installing ? (
    <LoaderCircle className="spin" size={22} />
  ) : outcome === 'current' || outcome === 'installed' ? (
    <CheckCircle2 size={22} />
  ) : policy?.enabled ? (
    <ShieldCheck size={22} />
  ) : (
    <LockKeyhole size={22} />
  );
  const formattedDate = available ? formatUpdateDate(available.date) : null;
  const showProgress = installing || progress.phase !== 'idle';

  if (policy?.channel === 'store')
    return (
      <section
        id={APP_UPDATER_TARGET_ID}
        className="panel settings-card settings-card--wide app-updater"
        tabIndex={-1}
      >
        <SectionHeading
          title={t('Mises à jour mobiles')}
          description={t('Version installée : {version}', { version: policy.currentVersion })}
        />
        <p>{t(policy.reason)}</p>
        <ReleaseHistory version={policy.currentVersion} />
      </section>
    );

  return (
    <section
      ref={sectionRef}
      id={APP_UPDATER_TARGET_ID}
      className="panel settings-card settings-card--wide app-updater settings-scroll-target"
      tabIndex={-1}
    >
      <SectionHeading
        title={t('Mettre Zentra à jour sans le réinstaller')}
        description={t('Version installée : {version}. Retrouvez les dernières améliorations en conservant vos données. Le fichier est vérifié avant l’installation.', { version: policy?.currentVersion || '…' })}
      />

      <div
        className={`app-updater__status ${statusTone}`}
        role={error ? 'alert' : 'status'}
        aria-live={error ? 'assertive' : 'polite'}
      >
        <span>{statusIcon}</span>
        <div>
          <strong>{t(statusTitle)}</strong>
          <p>{error ? t(error) : messageText}</p>
          {checkedAt && !checking ? (
            <small>
              <Clock3 size={13} /> {t('Dernière recherche réussie à {time}', { time: new Date(checkedAt).toLocaleTimeString(getAppLocale(), {
                hour: '2-digit',
                minute: '2-digit',
              }) })}
            </small>
          ) : null}
        </div>
      </div>

      <ol className="app-updater__steps" aria-label={t('Étapes de la mise à jour')}>
        {updaterSteps.map((label, stepIndex) => {
          const done =
            outcome === 'installed' ||
            stepIndex < activeStep ||
            (outcome === 'current' && stepIndex === 0) ||
            (outcome === 'available' && stepIndex === 0);
          const active = !done && stepIndex === activeStep;
          return (
            <li
              key={label}
              className={done ? 'is-done' : active ? 'is-active' : ''}
              aria-current={active ? 'step' : undefined}
            >
              <span>{done ? <CheckCircle2 size={15} /> : stepIndex + 1}</span>
              <strong>{t(label)}</strong>
            </li>
          );
        })}
      </ol>

      {available ? (
        <article className="app-updater__release">
          <div>
            <span>{t('Nouvelle version')}</span>
            <strong>Zentra {available.version}</strong>
            <small>
              {formattedDate
                ? t('Publiée le {date}', { date: formattedDate })
                : t('Depuis Zentra {version}', { version: available.currentVersion })}
            </small>
          </div>
          {available.notes ? (
            <p>{available.notes}</p>
          ) : (
            <p>{t('Le manifeste ne contient pas de notes de version.')}</p>
          )}
        </article>
      ) : null}

      {confirming && available ? (
        <fieldset
          className="app-updater__confirmation"
          aria-labelledby="app-updater-confirm-title"
        >
          <ShieldCheck size={24} />
          <div>
            <strong id="app-updater-confirm-title">
              {t('Prêt à installer Zentra {version}', { version: available.version })}
            </strong>
            <p>
              {t('Enregistrez les saisies ouvertes. La signature sera contrôlée avant que le système ferme Zentra, installe la version puis relance l’application. Aucune désinstallation manuelle n’est nécessaire.')}
            </p>
            <div className="app-updater__confirmation-actions">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setConfirming(false)}
              >
                {t('Annuler')}
              </Button>
              <Button type="button" onClick={() => void install()}>
                <Download size={16} /> {t('Installer et redémarrer')}
              </Button>
            </div>
          </div>
        </fieldset>
      ) : null}

      {showProgress ? (
        <section className="app-updater__progress" aria-label={t('État du téléchargement')} aria-live="polite">
          <div>
            <span>{progressLabel}</span>
            <strong>
              {progress.percent === null
                ? '…'
                : `${Math.round(progress.percent)} %`}
            </strong>
          </div>
          <progress
            max={100}
            value={progress.percent ?? undefined}
            aria-label={t('Progression de la mise à jour')}
          />
          <small>
            {progress.phase === 'verifying'
              ? t('Ne fermez pas Zentra : la signature et l’installateur sont en cours de contrôle.')
              : t('N’éteignez pas l’ordinateur pendant l’installation. Les données locales de votre entreprise restent sur cet appareil.')}
          </small>
        </section>
      ) : null}

      <div className="app-updater__actions">
        <Button
          type="button"
          variant="secondary"
          disabled={
            policyLoading || policy?.enabled === false || checking || installing
          }
          onClick={() => void checkNow()}
        >
          {checking ? (
            <LoaderCircle className="spin" size={16} />
          ) : (
            <RefreshCw size={16} />
          )}
          {checking
            ? t('Recherche…')
            : error
              ? t('Réessayer la recherche')
              : t('Rechercher une mise à jour')}
        </Button>
        {available && !confirming && !installing ? (
          <Button
            type="button"
            disabled={checking || installing}
            onClick={() => setConfirming(true)}
          >
            <Download size={16} /> {t('Préparer l’installation {version}', { version: available.version })}
          </Button>
        ) : null}
      </div>
      <details className="app-updater__technical">
        <summary>{t('Informations techniques et confidentialité')}</summary>
        {installationDetail ? <p>{installationDetail}</p> : null}
        <div className="app-updater__facts">
          <div>
            <Server size={16} />
            <span>{t('Version installée')}</span>
            <strong>{policy?.currentVersion || '—'}</strong>
          </div>
          <div>
            <LockKeyhole size={16} />
            <span>{t('Transport')}</span>
            <strong>{policy?.transport || 'HTTPS'}</strong>
          </div>
          <div>
            <ShieldCheck size={16} />
            <span>{t('Signature')}</span>
            <strong>{t('Ed25519 obligatoire')}</strong>
          </div>
          <div>
            <RotateCw size={16} />
            <span>{t('Installation sécurisée')}</span>
            <strong>{t('Fermeture et redémarrage')}</strong>
          </div>
          {policy?.endpointHost ? (
            <div>
              <Server size={16} />
              <span>{t('Serveur')}</span>
              <strong>{policy.endpointHost}</strong>
            </div>
          ) : null}
        </div>
        <p className="app-updater__notice">
          {t('Aucune mise à jour ne s’installe seule. La requête indique la version, le système et l’architecture ; comme toute connexion HTTPS, le serveur voit aussi l’adresse IP et les métadonnées techniques. Aucune donnée métier n’est envoyée par ce contrôle.')}
        </p>
      </details>
      <ReleaseHistory version={policy?.currentVersion} />
    </section>
  );
}
