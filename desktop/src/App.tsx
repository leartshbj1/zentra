import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import {
  Copy,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { BrandMark } from './BrandMark';
import { desktopApi, type CloudAccountState } from './bridge';
import { BusinessProfileGate } from './BusinessProfileEditor';
import {
  CLOUD_ACCESS_REVALIDATION_INTERVAL_MS,
  createSingleFlightCloudAccessRevalidator,
} from './cloudAccessRevalidation';
import { Onboarding } from './Onboarding';
import { WorkspaceApp } from './WorkspaceApp';
import type { AppSettings, LicenseState, Workspace } from './types';
import { Button, ErrorPanel } from './ui';
import { errorMessage, normalizeLicenseToken } from './utils';

export function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [license, setLicense] = useState<LicenseState | null>(null);
  const [cloudAccount, setCloudAccount] = useState<CloudAccountState | null>(
    null,
  );
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
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
    setLoading(true);
    setError('');
    try {
      const [nextWorkspace, nextAccess] = await Promise.all([
        desktopApi.loadWorkspace(),
        cloudAccessRevalidator.current!(),
      ]);
      setWorkspace(nextWorkspace);
      setLicense(nextAccess.license);
      setCloudAccount(nextAccess.account);
    } catch (reason) {
      setError(errorMessage(reason, 'L’espace local n’a pas pu être ouvert.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
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
      void revalidateCloudAccess();
    },
    [revalidateCloudAccess],
  );

  if (loading) {
    return (
      <main className="splash-screen">
        <div className="splash-logo">
          <BrandMark size={58} />
        </div>
        <h1>Zentra</h1>
        <p>Ouverture de votre espace local sécurisé…</p>
        <LoaderCircle className="spin" size={22} />
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
          message={error || 'Aucune donnée locale n’a été retournée.'}
        />
        <Button onClick={() => void load()}>Réessayer</Button>
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
  const content =
    !workspace.onboardingCompleted || !workspace.settings ? (
      <Onboarding
        onComplete={async (settings: AppSettings, scope) =>
          setWorkspace(await desktopApi.completeOnboarding(settings, scope))
        }
        onRestore={async (path: string) =>
          setWorkspace(await desktopApi.restoreBackup(path))
        }
      />
    ) : workspace.activityProfileRequired || activityProfileMissing ? (
      <BusinessProfileGate workspace={workspace} onSaved={setWorkspace} />
    ) : (
      <WorkspaceApp
        workspace={workspace}
        setWorkspace={setWorkspace}
        readOnly={Boolean(license?.readOnly || cloudRoleReadOnly)}
        readOnlySource={cloudRoleReadOnly ? 'cloud' : 'license'}
        cloudAccount={cloudAccount}
        onCloudAccountChange={handleCloudAccountChange}
      />
    );

  const licenseNeedsAttention = Boolean(license && license.status !== 'valid');

  return (
    <>
      {content}
      {license && licenseNeedsAttention ? (
        <LicenseActivation
          license={license}
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
  onInstall,
  onRefresh,
}: {
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
      <span>Installation</span>
      <code>{license.installationId || 'indisponible'}</code>
      {license.installationId ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title="Copier l’identifiant"
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
      <aside className="license-banner" role="status">
        <div className="license-banner__summary">
          <span>
            <ShieldCheck size={18} />
          </span>
          <div>
            <strong>{licenseLabels.not_configured}</strong>
            <small>
              Cette indication doit uniquement apparaître pendant le
              développement.
            </small>
          </div>
        </div>
        {identity}
        <p>{license.reason}</p>
      </aside>
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
          {refreshing ? 'Renouvellement…' : 'Renouveler en ligne'}
        </Button>
      ) : null}
      <label>
        <span>Ou installer un nouveau jeton signé</span>
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
        {busy ? 'Vérification en ligne…' : 'Installer le jeton'}
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
              ? 'Application en lecture seule; sauvegarde et export restent disponibles.'
              : `${license.customerName || 'Licence vérifiée'} · valable jusqu’au ${license.validUntil}`}
          </small>
        </div>
      </div>
      {license.readOnly ? (
        form
      ) : (
        <details>
          <summary>Licence et identifiant d’installation</summary>
          {form}
        </details>
      )}
      <p>
        {license.reason ||
          `Plan fixe 50 CHF / mois · fonctions et collaborateurs inclus · jeton lié à cet appareil`}
      </p>
    </aside>
  );
}
