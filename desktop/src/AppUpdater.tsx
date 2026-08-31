import { useEffect, useState } from 'react';
import { Download, LoaderCircle, LockKeyhole, RefreshCw, Server, ShieldCheck } from 'lucide-react';
import { desktopApi } from './bridge';
import type { SecureUpdateEvent, SecureUpdateMetadata, SecureUpdaterPolicy } from './types';
import { Button, SectionHeading } from './ui';
import { errorMessage } from './utils';

type ProgressState = {
  phase: 'idle' | 'preparing' | 'downloading' | 'verifying' | 'installed';
  downloadedBytes: number;
  contentLength: number | null;
  percent: number | null;
};

const initialProgress: ProgressState = {
  phase: 'idle',
  downloadedBytes: 0,
  contentLength: null,
  percent: null,
};

export function AppUpdater() {
  const [policy, setPolicy] = useState<SecureUpdaterPolicy | null>(null);
  const [available, setAvailable] = useState<SecureUpdateMetadata | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<ProgressState>(initialProgress);
  const [message, setMessage] = useState('Lecture de la politique de mise à jour…');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void desktopApi.getSecureUpdatePolicy()
      .then((value) => {
        if (!active) return;
        setPolicy(value);
        setMessage(value.enabled ? 'Le canal stable est prêt. Lancez une recherche quand vous le souhaitez.' : value.reason);
      })
      .catch((reason) => {
        if (active) setError(errorMessage(reason, 'La politique de mise à jour locale n’a pas pu être lue.'));
      });
    return () => { active = false; };
  }, []);

  async function checkNow() {
    setChecking(true);
    setError('');
    setAvailable(null);
    setProgress(initialProgress);
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
      setMessage(update
        ? `Elyko ${update.version} est disponible. La signature sera contrôlée avant toute installation.`
        : `Elyko ${currentPolicy.currentVersion} est déjà à jour.`);
    } catch (reason) {
      setError(errorMessage(reason, 'La recherche sécurisée n’a pas abouti.'));
    } finally {
      setChecking(false);
    }
  }

  function receiveEvent(event: SecureUpdateEvent) {
    if (event.event === 'preparing') {
      setProgress({ ...initialProgress, phase: 'preparing' });
      setMessage('Préparation du téléchargement signé…');
      return;
    }
    if (event.event === 'started') {
      setProgress({ phase: 'downloading', downloadedBytes: 0, contentLength: event.data.contentLength, percent: 0 });
      setMessage('Téléchargement HTTPS en cours…');
      return;
    }
    if (event.event === 'progress') {
      setProgress({ phase: 'downloading', ...event.data });
      return;
    }
    if (event.event === 'verifying') {
      setProgress((current) => ({ ...current, phase: 'verifying', percent: 100 }));
      setMessage('Téléchargement terminé. Vérification de la signature et préparation de l’installation…');
      return;
    }
    setProgress((current) => ({ ...current, phase: 'installed', percent: 100 }));
    setMessage('Installation lancée. Elyko va se fermer puis redémarrer avec la nouvelle version.');
  }

  async function install() {
    if (!available) return;
    const confirmed = window.confirm(
      `Installer Elyko ${available.version} maintenant ?\n\nEnregistrez vos saisies ouvertes. Windows fermera Elyko pendant la mise à jour puis l’application pourra être relancée normalement.`,
    );
    if (!confirmed) return;
    setInstalling(true);
    setError('');
    try {
      await desktopApi.installSecureUpdate(receiveEvent);
      receiveEvent({ event: 'installed' });
    } catch (reason) {
      setProgress(initialProgress);
      setError(errorMessage(reason, 'La mise à jour a été refusée ou n’a pas pu être installée.'));
    } finally {
      setInstalling(false);
    }
  }

  const progressLabel = progress.phase === 'downloading'
    ? progress.contentLength
      ? `${formatBytes(progress.downloadedBytes)} sur ${formatBytes(progress.contentLength)}`
      : `${formatBytes(progress.downloadedBytes)} téléchargés`
    : message;

  return <section className="panel settings-card settings-card--wide app-updater">
    <SectionHeading
      eyebrow="Maintenance sécurisée"
      title="Mettre Elyko à jour sans le réinstaller"
      description="Le canal est figé dans l’application. Tauri exige une archive signée et refuse toute source non HTTPS."
    />
    <div className={`app-updater__status ${policy?.enabled ? 'is-ready' : 'is-disabled'}`}>
      <span>{policy?.enabled ? <ShieldCheck size={22} /> : <LockKeyhole size={22} />}</span>
      <div>
        <strong>{policy?.enabled ? 'Canal stable protégé' : 'Canal inactif dans cette édition'}</strong>
        <p>{error || message}</p>
      </div>
    </div>
    <div className="app-updater__facts">
      <div><Server size={16} /><span>Version installée</span><strong>{policy?.currentVersion || '—'}</strong></div>
      <div><LockKeyhole size={16} /><span>Transport</span><strong>{policy?.transport || 'HTTPS'}</strong></div>
      <div><ShieldCheck size={16} /><span>Signature</span><strong>Tauri / Ed25519 obligatoire</strong></div>
      {policy?.endpointHost ? <div><Server size={16} /><span>Serveur</span><strong>{policy.endpointHost}</strong></div> : null}
    </div>
    {available ? <article className="app-updater__release">
      <div><span>Nouvelle version</span><strong>Elyko {available.version}</strong><small>{available.date ? `Publiée le ${new Date(available.date).toLocaleDateString('fr-CH')}` : `Depuis Elyko ${available.currentVersion}`}</small></div>
      {available.notes ? <p>{available.notes}</p> : <p>Notes de version non fournies par le manifeste.</p>}
    </article> : null}
    {installing ? <div className="app-updater__progress" role="status" aria-live="polite">
      <div><span>{progressLabel}</span><strong>{progress.percent === null ? '…' : `${progress.percent} %`}</strong></div>
      <progress max={100} value={progress.percent ?? undefined} />
      <small>N’éteignez pas le PC pendant l’installation. Vos données locales ne sont pas envoyées au serveur.</small>
    </div> : null}
    <div className="app-updater__actions">
      <Button type="button" variant="secondary" disabled={!policy?.enabled || checking || installing} onClick={() => void checkNow()}>
        {checking ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
        {checking ? 'Recherche…' : 'Rechercher une mise à jour'}
      </Button>
      {available ? <Button type="button" disabled={checking || installing} onClick={() => void install()}>
        {installing ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}
        {installing ? 'Installation…' : `Télécharger et installer ${available.version}`}
      </Button> : null}
    </div>
    <p className="app-updater__notice">Aucune mise à jour ne s’installe seule. La requête indique la version, Windows et l’architecture; comme toute connexion HTTPS, le serveur voit aussi l’adresse IP et les métadonnées techniques. Aucune donnée de l’entreprise n’est envoyée.</p>
  </section>;
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 octet';
  const units = ['octets', 'Ko', 'Mo', 'Go'];
  const rank = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** rank;
  return `${value.toLocaleString('fr-CH', { maximumFractionDigits: rank ? 1 : 0 })} ${units[rank]}`;
}
