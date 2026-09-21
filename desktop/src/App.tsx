import { t } from './language';
import { useAppLanguage } from './language';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  lazy,
  Suspense,
  type FormEvent,
} from 'react';
import {
  Copy,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { AppUpdater } from './AppUpdater';
import { waitForNativeStartup, withinAppOpeningDeadline } from './appOpening';
import { BrandMark } from './BrandMark';
import { desktopApi, type CloudAccountState } from './bridge';
import { BusinessProfileGate } from './BusinessProfileEditor';
import { DevelopmentNotice } from './DevelopmentNotice';
import {
  CLOUD_ACCESS_REVALIDATION_INTERVAL_MS,
  cloudAccountChangeNeedsFullRevalidation,
  createSingleFlightCloudAccessRevalidator,
} from './cloudAccessRevalidation';
import { Onboarding } from './Onboarding';
const WorkspaceApp = lazy(() => import('./WorkspaceApp').then((module) => ({ default: module.WorkspaceApp })));
import type { AppSettings, LicenseState, Workspace } from './types';
import { Button, ErrorPanel, Modal } from './ui';
import { errorMessage, normalizeLicenseToken } from './utils';
import { useMobileLayout } from './useMobileLayout';
import { CloudAccountAccess } from './CloudAccountAccess';
import { CompanyAccountGate } from './CompanyAccountGate';

export function App() {
  useAppLanguage();
  useMobileLayout();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [license, setLicense] = useState<LicenseState | null>(null);
  const [cloudAccount, setCloudAccount] = useState<CloudAccountState | null>(
    null,
  );
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [createdFor, setCreatedFor] = useState<string | null>(null);
  const openingAttempt = useRef(0);
  const automaticRefreshStarted = useRef(false);
  const cloudAccessRevalidator = useRef<
    ReturnType<typeof createSingleFlightCloudAccessRevalidator> | undefined
  >(undefined);
  if (!cloudAccessRevalidator.current) {
    cloudAccessRevalidator.current =
      createSingleFlightCloudAccessRevalidator(desktopApi);
  }

  const revalidateCloudAccess = useCallback(async () => {
    try {
      const next = await cloudAccessRevalidator.current!();
      setCloudAccount(next.account);
      setLicense(next.license);
    } catch {
      // Le backend renvoie le compte mis en cache lors d'une panne réseau. Si
      // une autre erreur survient, ne jamais écraser le bail déjà affiché.
    }
  }, []);

  const load = useCallback(async () => {
    const attempt = ++openingAttempt.current;
    setLoading(true);
    setError('');
    try {
      await waitForNativeStartup();
      if (attempt !== openingAttempt.current) return;
      const [nextWorkspace, nextAccess] = await Promise.all([
        withinAppOpeningDeadline(desktopApi.loadWorkspace()),
        cloudAccessRevalidator.current!(),
      ]);
      if (attempt !== openingAttempt.current) return;
      setWorkspace(nextWorkspace);
      setLicense(nextAccess.license);
      setCloudAccount(nextAccess.account);
    } catch (reason) {
      if (attempt !== openingAttempt.current) return;
      setError(errorMessage(reason, 'L’espace local n’a pas pu être ouvert.'));
    } finally {
      if (attempt === openingAttempt.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => { openingAttempt.current += 1; };
  }, [load]);

  useEffect(() => {
    if (
      !license?.enforcementConfigured ||
      !license.canRefresh ||
      automaticRefreshStarted.current
    )
      return;
    automaticRefreshStarted.current = true;
    void desktopApi
      .refreshLicense(true)
      .then(setLicense)
      .catch(() => {
        // Un échec réseau ne remplace jamais le bail local déjà validé. Le
        // renouvellement manuel affichera, lui, une erreur explicite.
      });
  }, [license]);

  useEffect(() => {
    if (
      cloudAccount?.status !== 'connected' &&
      cloudAccount?.status !== 'inactive'
    )
      return;

    const interval = window.setInterval(() => {
      void revalidateCloudAccess();
    }, CLOUD_ACCESS_REVALIDATION_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [cloudAccount?.status, revalidateCloudAccess]);

  const handleCloudAccountChange = useCallback(
    (next: CloudAccountState) => {
      setCloudAccount(next);
      if (cloudAccountChangeNeedsFullRevalidation(next)) {
        void revalidateCloudAccess();
      }
    },
    [revalidateCloudAccess],
  );

  if (loading) {
    return (
      <main className="splash-screen" aria-busy="true">
        <div className="splash-logo">
          <BrandMark size={58} />
        </div>
        <h1>Zentra</h1>
        <p role="status">{t("Ouverture de votre espace local sécurisé…")}</p>
        <LoaderCircle className="spin" size={22} aria-hidden="true" />
      </main>
    );
  }

  if (error || !workspace) {
    return (
      <main className="fatal-screen">
        <div className="splash-logo">
          <BrandMark size={58} />
        </div>
        <ErrorPanel
          title={t("Espace indisponible")}
          message={error || 'Aucune donnée locale n’a été retournée.'}
        />
        <Button autoFocus onClick={() => void load()}>{t("Réessayer")}</Button>
        <StandaloneUpdaterAccess />
      </main>
    );
  }

  const activityProfileMissing = Boolean(
    workspace.settings &&
    (!workspace.settings.business.nogaSection ||
      !workspace.settings.business.nogaDivision ||
      !workspace.settings.business.activityDescription.trim()),
  );
  const cloudRoleReadOnly =
    license?.accessRole === 'read_only' || cloudAccount?.role === 'read_only';
  const workspaceReady = Boolean(
    workspace.onboardingCompleted &&
      workspace.settings &&
      !workspace.activityProfileRequired &&
      !activityProfileMissing,
  );
  const content =
    !workspace.onboardingCompleted || !workspace.settings ? (
      <Onboarding
        onJoined={next=>{setWorkspace(next);void revalidateCloudAccess();}}
        cloudAccount={cloudAccount}
        onCloudAccountChange={handleCloudAccountChange}
        onComplete={async (settings: AppSettings, scope) => {
          const organization = cloudAccount?.status === 'connected' ? cloudAccount.organizationId ?? null : null;
          const next = await desktopApi.completeOnboarding(settings, scope);
          setCreatedFor(organization);
          setWorkspace(next);
        }}
        onRestore={async (path: string) =>
          setWorkspace(await desktopApi.restoreBackup(path))
        }
        onCloudRestore={async (id: string) => setWorkspace(await desktopApi.restoreCloudBackup(id))}
      />
    ) : workspace.activityProfileRequired || activityProfileMissing ? (
      <BusinessProfileGate workspace={workspace} onSaved={setWorkspace} />
    ) : (
      <Suspense fallback={<main className="splash-screen"><LoaderCircle className="spin" size={24} /><p>{t("Ouverture de votre espace…")}</p></main>}><WorkspaceApp
        workspace={workspace}
        setWorkspace={setWorkspace}
        readOnly={Boolean(license?.readOnly || cloudRoleReadOnly)}
        readOnlySource={cloudRoleReadOnly ? 'cloud' : 'license'}
        cloudAccount={cloudAccount}
        onCloudAccountChange={handleCloudAccountChange}
      /></Suspense>
    );

  const licenseNeedsAttention = Boolean(license && license.status !== 'valid');

  return (
    <>
      <CompanyAccountGate account={cloudAccount} workspace={workspace} createdFor={createdFor} onWorkspace={setWorkspace} onAccountChange={handleCloudAccountChange}>{content}</CompanyAccountGate>
      {!workspaceReady ? <StandaloneUpdaterAccess /> : null}
      {license && licenseNeedsAttention ? (
        <LicenseActivation
          license={license}
          account={cloudAccount}
          onAccountChange={handleCloudAccountChange}
          hasNavigation={workspaceReady}
          onInstall={async (token) => {
            const next = await desktopApi.installLicenseToken(token);
            setLicense(next);
            setWorkspace(await desktopApi.loadWorkspace());
          }}
          onRefresh={async () =>
            setLicense(await desktopApi.refreshLicense(false))
          }
        />
      ) : null}
    </>
  );
}

export function StandaloneUpdaterAccess() {
  const [open, setOpen] = useState(false);
  const [installing, setInstalling] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        className="standalone-updater__launcher"
        onClick={() => setOpen(true)}
      >
        <RefreshCw size={16} />{t(" Mise à jour")}</Button>
      {open ? (
        <Modal
          title={t("Mise à jour de Zentra")}
          wide
          dismissible={!installing}
          onClose={() => { if (!installing) setOpen(false); }}
        >
          <div className="standalone-updater-content">
            <AppUpdater onInstallingChange={setInstalling} />
          </div>
        </Modal>
      ) : null}
    </>
  );
}

const licenseLabels: Record<LicenseState['status'], string> = {
  not_configured: 'Contrôle de licence non configuré',
  missing: 'Activation requise',
  invalid: 'Licence invalide',
  clock_error: 'Horloge de l’ordinateur à contrôler',
  not_yet_valid: 'Licence pas encore valide',
  inactive: 'Abonnement inactif',
  expired: 'Licence expirée',
  valid: 'Licence active',
};

function LicenseActivation({
  license,
  account,
  onAccountChange,
  hasNavigation,
  onInstall,
  onRefresh,
}: {
  account?: import('./bridge').CloudAccountState | null;
  onAccountChange?: (account: import('./bridge').CloudAccountState) => void;
  hasNavigation: boolean;
  license: LicenseState;
  onInstall: (token: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onInstall(normalizeLicenseToken(token));
      setToken('');
    } catch (reason) {
      setError(
        errorMessage(
          reason,
          'Le jeton de licence n’a pas pu être vérifié en ligne. Vérifiez la connexion Internet puis réessayez.',
        ),
      );
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    setRefreshing(true);
    setError('');
    try {
      await onRefresh();
    } catch (reason) {
      setError(
        errorMessage(
          reason,
          'La licence n’a pas pu être renouvelée en ligne. Le bail local reste inchangé.',
        ),
      );
    } finally {
      setRefreshing(false);
    }
  }
  const identity = (
    <div className="license-banner__identity">
      <span>{t("Installation")}</span>
      <code>{license.installationId || 'indisponible'}</code>
      {license.installationId ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title={t("Copier l’identifiant")}
          onClick={() =>
            void navigator.clipboard.writeText(license.installationId)
          }
        >
          <Copy size={14} />
        </Button>
      ) : null}
    </div>
  );
  if (!license.enforcementConfigured) {
    return (
      <DevelopmentNotice identity={identity} hasNavigation={hasNavigation} />
    );
  }
  const form = (
    <form onSubmit={submit}>
      {identity}
      {license.canRefresh ? (
        <Button
          type="button"
          size="small"
          onClick={() => void refresh()}
          disabled={busy || refreshing}
        >
          {refreshing ? (
            <LoaderCircle className="spin" size={15} />
          ) : (
            <RefreshCw size={15} />
          )}
          {refreshing ? t("Renouvellement…") : t("Renouveler en ligne")}
        </Button>
      ) : null}
      <label>
        <span>{t("Ou installer un nouveau jeton signé")}</span>
        <textarea
          value={token}
          onChange={(event) => setToken(event.target.value)}
          rows={2}
          required
        />
      </label>
      {error ? <small className="license-banner__error">{error}</small> : null}
      <Button
        type="submit"
        size="small"
        disabled={busy || refreshing || !normalizeLicenseToken(token)}
      >
        {busy ? (
          <LoaderCircle className="spin" size={15} />
        ) : (
          <KeyRound size={15} />
        )}
        {busy ? t("Vérification en ligne…") : t("Installer le jeton")}
      </Button>
    </form>
  );
  return (
    <aside
      className={`license-banner ${license.readOnly ? 'license-banner--warning' : ''}`}
      role="status"
    >
      <div className="license-banner__summary">
        <span>
          {license.readOnly ? (
            <KeyRound size={18} />
          ) : (
            <ShieldCheck size={18} />
          )}
        </span>
        <div>
          <strong>{licenseLabels[license.status]}</strong>
          <small>
            {license.readOnly
              ? t("Application en lecture seule; sauvegarde et export restent disponibles.")
              : t("{v0} · valable jusqu’au {v1}", { v0: license.customerName || 'Licence vérifiée', v1: license.validUntil })}
          </small>
        </div>
      </div>
      {license.readOnly && <div className="license-account-activation">
        <p>{t('Connectez-vous au compte utilisé pour votre abonnement. Votre licence s’active automatiquement.')}</p>
        <CloudAccountAccess account={account} onAccountChange={onAccountChange}/>
      </div>}
      <details>
        <summary>{t("Licence et identifiant d’installation")}</summary>
        {form}
      </details>
      <p>
        {license.reason ||
          `Solo 49 CHF · Start 59 CHF · Pro 89 CHF par mois · toutes les fonctions actuelles et futures incluses`}
      </p>
    </aside>
  );
}
