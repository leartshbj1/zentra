import { useEffect, useState } from 'react';
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
} from './appUpdaterLogic';
import { desktopApi } from './bridge';
import type {
  SecureUpdateEvent,
  SecureUpdateMetadata,
  SecureUpdaterPolicy,
} from './types';
import { Button, SectionHeading } from './ui';
import { errorMessage } from './utils';

type CheckOutcome = 'idle' | 'available' | 'current' | 'installed';

export const APP_UPDATER_TARGET_ID = 'app-updater';

export function AppUpdater() {
  const [policy, setPolicy] = useState<SecureUpdaterPolicy | null>(null);
  const [policyLoading, setPolicyLoading] = useState(true);
  const [available, setAvailable] = useState<SecureUpdateMetadata | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [progress, setProgress] = useState(initialUpdaterProgress);
  const [outcome, setOutcome] = useState<CheckOutcome>('idle');
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [message, setMessage] = useState('Lecture de la politique de mise à jour…');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void desktopApi.getSecureUpdatePolicy()
      .then((value) => {
        if (!active) return;
        setPolicy(value);
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
    };
  }, []);

  async function checkNow() {
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
      const update = await desktopApi.checkSecureUpdate();
      setAvailable(update);
      setOutcome(update ? 'available' : 'current');
      setCheckedAt(new Date().toISOString());
      setMessage(
        update
          ? `Zentra ${update.version} est disponible. Sa signature sera contrôlée avant l’installation.`
          : `Zentra ${currentPolicy.currentVersion} est déjà à jour.`,
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
    setMessage(
      'La mise à jour a été remise au système. Zentra redémarre automatiquement avec la nouvelle version.',
    );
  }

  async function install() {
    if (!available) return;
    setConfirming(false);
    setInstalling(true);
    setError('');
    setMessage('Préparation de la mise à jour…');
    try {
      await desktopApi.installSecureUpdate(receiveEvent);
    } catch (reason) {
      setProgress(initialUpdaterProgress);
      setOutcome('available');
      setError(
        errorMessage(
          reason,
          'L’installation n’a pas abouti. La mise à jour reste disponible : fermez les fenêtres qui la bloquent, puis réessayez.',
        ),
      );
    } finally {
      setInstalling(false);
    }
  }

  const progressLabel = progress.phase === 'downloading'
    ? progress.contentLength
      ? `${formatUpdateBytes(progress.downloadedBytes)} sur ${formatUpdateBytes(progress.contentLength)}`
      : `${formatUpdateBytes(progress.downloadedBytes)} téléchargés`
    : message;
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
  const statusIcon = error
    ? <AlertTriangle size={22} />
    : policyLoading || checking
      ? <LoaderCircle className="spin" size={22} />
      : outcome === 'current' || outcome === 'installed'
        ? <CheckCircle2 size={22} />
        : policy?.enabled
          ? <ShieldCheck size={22} />
          : <LockKeyhole size={22} />;
  const formattedDate = available ? formatUpdateDate(available.date) : null;
  const showProgress = installing || progress.phase !== 'idle';

  if (policy?.channel === 'store') return <section id={APP_UPDATER_TARGET_ID} className="panel settings-card settings-card--wide app-updater" tabIndex={-1}>
    <SectionHeading title="Mises à jour mobiles" description={`Version installée : ${policy.currentVersion}`} />
    <p>{policy.reason}</p>
  </section>;

  return <section
    id={APP_UPDATER_TARGET_ID}
    className="panel settings-card settings-card--wide app-updater settings-scroll-target"
    tabIndex={-1}
  >
    <SectionHeading
      eyebrow="Maintenance sécurisée"
      title="Mettre Zentra à jour sans le réinstaller"
      description="Le canal est figé dans l’application. Zentra exige un téléchargement HTTPS et une signature valide avant de confier l’installation à Windows ou macOS."
    />

    <div
      className={`app-updater__status ${statusTone}`}
      role={error ? 'alert' : 'status'}
      aria-live={error ? 'assertive' : 'polite'}
    >
      <span>{statusIcon}</span>
      <div>
        <strong>{statusTitle}</strong>
        <p>{error || message}</p>
        {checkedAt && !checking ? <small>
          <Clock3 size={13} /> Dernière recherche réussie à {new Date(checkedAt).toLocaleTimeString('fr-CH', { hour: '2-digit', minute: '2-digit' })}
        </small> : null}
      </div>
    </div>

    <div className="app-updater__facts">
      <div><Server size={16} /><span>Version installée</span><strong>{policy?.currentVersion || '—'}</strong></div>
      <div><LockKeyhole size={16} /><span>Transport</span><strong>{policy?.transport || 'HTTPS'}</strong></div>
      <div><ShieldCheck size={16} /><span>Signature</span><strong>Ed25519 obligatoire</strong></div>
      <div><RotateCw size={16} /><span>Installation sécurisée</span><strong>Fermeture et redémarrage</strong></div>
      {policy?.endpointHost ? <div><Server size={16} /><span>Serveur</span><strong>{policy.endpointHost}</strong></div> : null}
    </div>

    <ol className="app-updater__steps" aria-label="Étapes de la mise à jour">
      {updaterSteps.map((label, stepIndex) => {
        const done = outcome === 'installed'
          || stepIndex < activeStep
          || (outcome === 'current' && stepIndex === 0)
          || (outcome === 'available' && stepIndex === 0);
        const active = !done && stepIndex === activeStep;
        return <li
          key={label}
          className={done ? 'is-done' : active ? 'is-active' : ''}
          aria-current={active ? 'step' : undefined}
        >
          <span>{done ? <CheckCircle2 size={15} /> : stepIndex + 1}</span>
          <strong>{label}</strong>
        </li>;
      })}
    </ol>

    {available ? <article className="app-updater__release">
      <div>
        <span>Nouvelle version</span>
        <strong>Zentra {available.version}</strong>
        <small>{formattedDate ? `Publiée le ${formattedDate}` : `Depuis Zentra ${available.currentVersion}`}</small>
      </div>
      {available.notes
        ? <p>{available.notes}</p>
        : <p>Le manifeste ne contient pas de notes de version.</p>}
    </article> : null}

    {confirming && available ? <div className="app-updater__confirmation" role="group" aria-labelledby="app-updater-confirm-title">
      <ShieldCheck size={24} />
      <div>
        <strong id="app-updater-confirm-title">Prêt à installer Zentra {available.version}</strong>
        <p>Enregistrez les saisies ouvertes. La signature sera contrôlée avant que le système ferme Zentra, installe la version puis relance l’application. Aucune désinstallation manuelle n’est nécessaire.</p>
        <div className="app-updater__confirmation-actions">
          <Button type="button" variant="secondary" onClick={() => setConfirming(false)}>Annuler</Button>
          <Button type="button" onClick={() => void install()}><Download size={16} /> Installer et redémarrer</Button>
        </div>
      </div>
    </div> : null}

    {showProgress ? <div className="app-updater__progress" role="status" aria-live="polite">
      <div><span>{progressLabel}</span><strong>{progress.percent === null ? '…' : `${Math.round(progress.percent)} %`}</strong></div>
      <progress max={100} value={progress.percent ?? undefined} aria-label="Progression de la mise à jour" />
      <small>{progress.phase === 'verifying'
        ? 'Ne fermez pas Zentra : la signature et l’installateur sont en cours de contrôle.'
        : 'N’éteignez pas l’ordinateur pendant l’installation. Les données locales de votre entreprise restent sur cet appareil.'}</small>
    </div> : null}

    <div className="app-updater__actions">
      <Button
        type="button"
        variant="secondary"
        disabled={policyLoading || policy?.enabled === false || checking || installing}
        onClick={() => void checkNow()}
      >
        {checking ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
        {checking ? 'Recherche…' : error ? 'Réessayer la recherche' : 'Rechercher une mise à jour'}
      </Button>
      {available && !confirming ? <Button
        type="button"
        disabled={checking || installing}
        onClick={() => setConfirming(true)}
      >
        <Download size={16} /> Préparer l’installation {available.version}
      </Button> : null}
    </div>
    <p className="app-updater__notice">Aucune mise à jour ne s’installe seule. La requête indique la version, le système et l’architecture ; comme toute connexion HTTPS, le serveur voit aussi l’adresse IP et les métadonnées techniques. Aucune donnée métier n’est envoyée par ce contrôle.</p>
  </section>;
}
