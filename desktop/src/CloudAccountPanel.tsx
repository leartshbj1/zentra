import { t, useAppLanguage } from './language';
import { CloudTeamPanel } from './CloudTeamPanel';
import { NativeSubscription } from './NativeSubscription';
import type { AppSettings } from './types';
import { useEffect, useRef, useState } from 'react';
import {
  Check,
  Cloud,
  Copy,
  ExternalLink,
  LoaderCircle,
  LockKeyhole,
  Users,
  UserRound, ShieldCheck, CreditCard, Link2, Database, ChevronRight,
} from 'lucide-react';
import { desktopApi, type CloudAccountState } from './bridge';
import { loadCloudAccountPanel } from './cloudAccountOpening';
import { errorMessage } from './utils';
import { Button, SectionHeading } from './ui';
import './workflow-clarity.css';

const ROLE_LABEL: Record<NonNullable<CloudAccountState['role']>, string> = {
  owner: 'Propriétaire',
  admin: 'Administrateur',
  accountant: 'Comptable / fiduciaire',
  member: 'Collaborateur',
  read_only: 'Lecture seule',
};

export function CloudAccountPanel({
  onAccountChange,
  settings,
  joining = false,
  setup = false,
}: {
  onAccountChange?: (account: CloudAccountState) => void;
  settings?: AppSettings | null;
  joining?: boolean;
  setup?: boolean;
}) {
  useAppLanguage();
  const [account, setAccount] = useState<CloudAccountState | null>(null);
  const [busy, setBusy] = useState(false);
  const [subscriptionOpen,setSubscriptionOpen]=useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const pollInFlight = useRef(false);
  const operation = useRef(0);
  const starting = useRef(false);
  const previousAccount = useRef<CloudAccountState | null>(null);
  const changeCallback = useRef(onAccountChange); changeCallback.current = onAccountChange;

  useEffect(() => {
    let active = true;
    const revision = operation.current;
    void loadCloudAccountPanel(desktopApi, {
      local: value => {
        if (active && revision === operation.current) setAccount(value);
      },
      verified: value => {
        if (active && revision === operation.current) {
          setAccount(value);
          changeCallback.current?.(value);
        }
      },
      failed: (_reason, hasLocal) => {
        if (active && revision === operation.current) {
          if (!hasLocal) {
            setAccount({ status: 'disconnected' });
            setError('La connexion enregistrée n’a pas pu être lue. Vous pouvez vous reconnecter.');
          }
        }
      },
    });
    return () => {
      active = false;
      ++operation.current;
    };
  }, []);

  useEffect(() => {
    if (account?.status !== 'pending') return;
    const interval = window.setInterval(
      () => { setNow(Date.now()); if (!account.authorizationExpiresAt || Date.parse(account.authorizationExpiresAt)>Date.now()) void poll(false); },
      Math.max(3, account.intervalSeconds ?? 3) * 1_000,
    );
    return () => window.clearInterval(interval);
  }, [account?.status, account?.intervalSeconds, account?.authorizationExpiresAt]);

  async function begin() {
    if (starting.current) return;
    starting.current = true;
    if (account?.status === 'connected') previousAccount.current = account;
    const revision = ++operation.current;
    setBusy(true);
    setError('');
    try {
      const pending = await desktopApi.startCloudAccountLink();
      if (revision !== operation.current) return;
      setAccount(pending);
      setCopied(false);
      // Keep the current space active until the other one is approved.
      if (!previousAccount.current) changeCallback.current?.(pending);
      await openPage();
    } catch (reason) {
      if (revision !== operation.current) return;
      setError(
        errorMessage(reason, 'La connexion au compte n’a pas pu démarrer.'),
      );
    } finally {
      if (revision === operation.current) setBusy(false);
      starting.current = false;
    }
  }

  async function poll(showError = true) {
    if (pollInFlight.current || starting.current) return;
    const revision = operation.current;
    pollInFlight.current = true;
    if (showError) setBusy(true);
    try {
      const next = await desktopApi.pollCloudAccountLink();
      if (revision !== operation.current) return;
      setAccount(next);
      if (!previousAccount.current || next.status === 'connected') changeCallback.current?.(next);
      if (next.status === 'connected') previousAccount.current = null;
      if (showError || next.status === 'connected') setError('');
    } catch (reason) {
      if (showError && revision === operation.current) {
        setError(
          errorMessage(reason, 'L’autorisation n’a pas pu être vérifiée.'),
        );
      }
    } finally {
      pollInFlight.current = false;
      if (showError && revision === operation.current) setBusy(false);
    }
  }

  async function openPage() {
    try { await desktopApi.openCloudAccountLink(); }
    catch (reason) { setError(errorMessage(reason, 'La page sécurisée ne s’est pas ouverte. Réessayez avec le bouton ci-dessous ; votre code reste valable.')); }
  }

  async function disconnect() {
    if (
      !window.confirm(
        t('Déconnecter ce poste du compte Zentra ? Les données locales ne seront pas supprimées.'),
      )
    )
      return;
    setBusy(true);
    ++operation.current;
    setError('');
    try {
      await desktopApi.disconnectCloudAccount();
      const disconnected: CloudAccountState = { status: 'disconnected' };
      setAccount(disconnected);
      onAccountChange?.(disconnected);
    } catch (reason) {
      setError(errorMessage(reason, 'Ce poste n’a pas pu être déconnecté.'));
    } finally {
      setBusy(false);
    }
  }

  async function copyCode() {
    if (!account?.userCode) return;
    try {
      await navigator.clipboard.writeText(account.userCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setError(
        'Le code n’a pas pu être copié. Vous pouvez le saisir manuellement.',
      );
    }
  }

  async function cancelSwitch() {
    ++operation.current;
    setBusy(true); setError('');
    try {
      // The native account lock waits for a poll already in progress. Never
      // pretend the old session is still active if approval just completed.
      const current = await desktopApi.getCloudAccountState();
      setAccount(current); changeCallback.current?.(current);
      previousAccount.current = null;
    } catch (reason) { setError(errorMessage(reason, 'Le compte n’a pas pu être vérifié. Réessayez.')); }
    finally { setBusy(false); }
  }

  const connected = account?.status === 'connected';
  const expired = account?.status === 'expired';
  const inactive = account?.status === 'inactive';
  const pending = account?.status === 'pending';
  const codeExpired = pending && !!account.authorizationExpiresAt && Date.parse(account.authorizationExpiresAt) <= now;

  if(subscriptionOpen&&connected&&account.organizationId)return <section className="cloud-account-panel"><Button variant="ghost" onClick={()=>setSubscriptionOpen(false)}>{t('Retour au compte')}</Button><NativeSubscription key={account.organizationId} organizationId={account.organizationId}/></section>;

  return (
    <section className="panel settings-card settings-card--wide cloud-account-panel">
      {!setup && <SectionHeading
        title={t(connected ? "Votre espace" : "Connecter votre entreprise")}
        description={connected ? undefined : t("Utilisez votre compte personnel ou l’adresse e-mail de votre invitation.")}
      />}

      {!account ? (
        <div className="settings-cloud-status">
          <LoaderCircle className="spin" size={20} />
          <span>{t("Lecture du compte protégé…")}</span>
        </div>
      ) : connected ? (
        <div className="settings-cloud-account is-connected">
          <span className="settings-cloud-account__icon">
            <Check size={22} />
          </span>
          <div>
            <strong>{account.organizationName}</strong>
            <p>
              {account.role ? t(ROLE_LABEL[account.role]) : t("Membre")}
            </p>
          </div>
          <Button variant="secondary" disabled={busy} onClick={() => void begin()}>{t('Changer d’espace')}</Button>
        </div>
      ) : pending ? (
        <div className="settings-cloud-link">
          {codeExpired && <p role="status">{t('Ce code a expiré. Demandez un nouveau code, puis confirmez uniquement celui affiché ici.')}</p>}
          <div className="settings-cloud-link__code">
            <span>{t("Code à vérifier")}</span>
            <strong>{account.userCode}</strong>
          </div>
          <p>{t('Choisissez votre espace dans le navigateur et confirmez ce code. La connexion se termine automatiquement.')}</p>
          <div className="settings-actions">
            <Button
              disabled={busy}
              onClick={() => void openPage()}
            >
              <ExternalLink size={16} />{t(" Ouvrir la page sécurisée")}</Button>
            <Button variant="secondary" onClick={() => void copyCode()}>
              {copied ? <Check size={16} /> : <Copy size={16} />}
              {copied ? t("Code copié") : t("Copier le code")}
            </Button>
          </div>
          <details className="workflow-options"><summary>{t('La connexion ne se termine pas ?')}</summary><div className="settings-actions">
            <Button variant="secondary" disabled={busy || codeExpired} onClick={() => void poll(true)}>{t('Vérifier maintenant')}</Button>
            <Button variant="ghost" disabled={busy} onClick={() => void begin()}>{t('Demander un nouveau code')}</Button>
          </div></details>
          {previousAccount.current && <Button variant="ghost" disabled={busy} onClick={() => void cancelSwitch()}>{t('Rester dans mon espace actuel')}</Button>}
        </div>
      ) : (
        <div className="settings-cloud-intro">
          {(!setup || expired || inactive) && <div>
            {expired || inactive ? (
              <LockKeyhole size={24} />
            ) : (
              <Cloud size={24} />
            )}
            <strong>
              {inactive
                ? t("Abonnement à réactiver")
                : expired
                  ? t("Session du poste expirée")
                  : t("Aucun compte relié")}
            </strong>
            <p>
              {inactive
                ? t("Les données locales restent lisibles. Réactivez l’abonnement puis reliez de nouveau ce poste pour modifier et archiver.")
                : expired
                  ? t("Reconnectez ce poste pour reprendre les fonctions d’équipe et l’archivage.")
                  : t("Reliez ce poste à l’entreprise pour utiliser les accès partagés et l’archive distante.")}
            </p>
          </div>}
          <Button className={setup ? "first-run-connect" : undefined} disabled={busy} onClick={() => void begin()}>
            {busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              setup ? <UserRound size={19} /> : <Users size={16} />
            )}
            {busy ? t("Préparation…") : t(setup ? "Se connecter" : "Se connecter dans le navigateur")}
            {setup && !busy && <ChevronRight size={19}/>}
          </Button>
          {setup && <p className="first-run-connect-note">{t("Une page sécurisée s’ouvre dans votre navigateur.")}</p>}
        </div>
      )}

      {connected && !joining ? <CloudTeamPanel key={account.organizationId} settings={settings}/> : null}
      {connected && !setup && <nav className="cloud-account-shortcuts" aria-label={t('Paramètres du compte')}>
        {([
          ['profil','Profil',UserRound],['securite','Sécurité',ShieldCheck],
          ['abonnement','Abonnement',CreditCard],['connexions','Appareils connectés',Link2],
          ['donnees','Données et confidentialité',Database],
        ] as const).map(([section,label,Icon])=><button key={section} type="button" disabled={busy} onClick={()=>section==='abonnement'?setSubscriptionOpen(true):void desktopApi.openCloudAccountPortal(section).catch(reason=>setError(errorMessage(reason,'La page du compte ne s’est pas ouverte. Réessayez.')))}><Icon size={19}/><span>{t(label)}</span><ChevronRight size={17}/></button>)}
      </nav>}
      {connected ? (
        <div className="settings-actions cloud-account-panel__actions">
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => void disconnect()}
          >{t("Déconnecter ce poste")}</Button>
        </div>
      ) : null}
      <div className="settings-cloud-privacy"><LockKeyhole size={15}/><p>{t("Connexion protégée sur cet appareil.")}</p></div>
      {error ? (
        <p className="form-error" role="alert">
          {t(error)}
        </p>
      ) : null}
    </section>
  );
}
