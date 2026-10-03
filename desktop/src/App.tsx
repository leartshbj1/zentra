import { t } from './language';
import { useAppLanguage } from './language';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  lazy,
  Suspense,
  type FormEvent,
  type ReactNode,
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
  cloudAccountChangeNeedsLicenseRefresh,
  createSingleFlightCloudAccessRevalidator,
  readLocalCloudAccess,
  readCloudAccessForAccount,
} from './cloudAccessRevalidation';
// Returning companies never need the complete first-run wizard on the opening path.
const Onboarding = lazy(() => import('./Onboarding').then(module => ({ default: module.Onboarding })));
const loadWorkspaceModule = () => import('./WorkspaceApp').then((module) => ({ default: module.WorkspaceApp }));
const WorkspaceApp = lazy(loadWorkspaceModule);
import type { AppSettings, LicenseState, Workspace } from './types';
import { Button, Modal } from './ui';
import { errorMessage, normalizeLicenseToken } from './utils';
import { useMobileLayout } from './useMobileLayout';
import { CloudAccountAccess } from './CloudAccountAccess';
import { CompanyAccountGate } from './CompanyAccountGate';
import { FormDraftIdentityProvider } from './useFormDraft';
import { recordDiagnostic, classifyDiagnosticError } from './diagnostics';
import { ErrorGuidance } from './ErrorGuidance';

const FORM_DRAFT_IDENTITY_TIMEOUT_MS = 15_000;
const draftIdentityMessages = {
  fr: { loading: 'Vérification de votre compte sur cet appareil…', failure: 'Votre compte ne peut pas être vérifié sur cet appareil. Vos données sont conservées.', timeout: 'Cette vérification prend trop de temps. Vos données sont conservées.', scope: 'Votre espace local n’a pas pu être identifié. Vos données sont conservées.', retry: 'Réessayer la vérification' },
  de: { loading: 'Ihr Konto wird auf diesem Gerät geprüft…', failure: 'Ihr Konto kann auf diesem Gerät nicht geprüft werden. Ihre Daten bleiben erhalten.', timeout: 'Diese Prüfung dauert zu lange. Ihre Daten bleiben erhalten.', scope: 'Ihr lokaler Arbeitsbereich konnte nicht identifiziert werden. Ihre Daten bleiben erhalten.', retry: 'Prüfung erneut versuchen' },
  it: { loading: 'Verifica del tuo account su questo dispositivo…', failure: 'Non è possibile verificare il tuo account su questo dispositivo. I tuoi dati sono conservati.', timeout: 'Questa verifica richiede troppo tempo. I tuoi dati sono conservati.', scope: 'Non è stato possibile identificare il tuo spazio locale. I tuoi dati sono conservati.', retry: 'Riprova la verifica' },
  en: { loading: 'Checking your account on this device…', failure: 'Your account cannot be verified on this device. Your data is preserved.', timeout: 'This check is taking too long. Your data is preserved.', scope: 'Your local workspace could not be identified. Your data is preserved.', retry: 'Retry account check' },
};

type DraftCompanyAdmission = {key:string;epoch:number};
function DraftCompanyAdmissionMarker({identityKey,epoch,onAdmission,children}:{identityKey:string;epoch:number;onAdmission:(value:DraftCompanyAdmission)=>void;children:ReactNode}) {
  // This child mounts only after the company gate has finished binding or
  // receiving its workspace. Do not start a local identity deadline before it.
  useLayoutEffect(() => { onAdmission({key:identityKey,epoch}); }, [identityKey,epoch,onAdmission]);
  return <>{children}</>;
}

export function App() {
  const language = useAppLanguage();
  useMobileLayout();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [license, setLicense] = useState<LicenseState | null>(null);
  const [cloudAccount, setCloudAccount] = useState<CloudAccountState | null>(
    null,
  );
  const [error, setError] = useState('');
  const [openingErrorIncident, setOpeningErrorIncident] = useState<{attempt:number;code:string} | null>(null);
  const [loading, setLoading] = useState(true);
  const [createdFor, setCreatedFor] = useState<string | null>(null);
  const [draftIdentity, setDraftIdentity] = useState<{key:string; memberId?:string}>({key:''});
  const [draftIdentityRevision, setDraftIdentityRevision] = useState(0);
  const [companyAdmission, setCompanyAdmission] = useState<DraftCompanyAdmission | null>(null);
  const [draftIdentityFailure, setDraftIdentityFailure] = useState<{key:string; reason:'failure'|'timeout'|'scope'; incidentCode:string} | null>(null);
  const cloudDraftIdentity = cloudAccount?.status === 'connected' || cloudAccount?.status === 'inactive';
  const draftOrganizationId = cloudDraftIdentity ? cloudAccount?.organizationId || '' : '';
  // Access status can change without changing the owner of the local drafts.
  const draftIdentityKey = JSON.stringify([workspace?.workNotesScope || '', draftOrganizationId, cloudDraftIdentity ? 'cloud' : 'local']);
  const draftIdentityReady = Boolean(workspace?.workNotesScope) && draftIdentity.key === draftIdentityKey && Boolean(draftIdentity.memberId);
  const openingAttempt = useRef(0);
  const automaticRefreshStarted = useRef(false);
  const accountEpoch = useRef(0);
  const cloudAccessRevalidator = useRef<
    ReturnType<typeof createSingleFlightCloudAccessRevalidator> | undefined
  >(undefined);
  if (!cloudAccessRevalidator.current) {
    cloudAccessRevalidator.current =
      createSingleFlightCloudAccessRevalidator(desktopApi);
  }

  const revalidateCloudAccess = useCallback(async () => {
    const epoch = accountEpoch.current;
    try {
      const next = await cloudAccessRevalidator.current!();
      if (epoch !== accountEpoch.current) return;
      setCloudAccount(next.account);
      setLicense(next.license);
      setDraftIdentityRevision(value=>value+1);
    } catch {
      // Le backend renvoie le compte mis en cache lors d'une panne réseau. Si
      // une autre erreur survient, ne jamais écraser le bail déjà affiché.
    }
  }, []);

  const load = useCallback(async () => {
    const attempt = ++openingAttempt.current;
    const started = performance.now();
    const incident = recordDiagnostic({area:'app',operation:'workspace.open',phase:'start'});
    setLoading(true);
    setError('');
    setOpeningErrorIncident(null);
    try {
      await waitForNativeStartup();
      if (attempt !== openingAttempt.current) return;
      // Load the work window while local data is read, instead of afterwards.
      void loadWorkspaceModule().catch(() => {});
      const [nextWorkspace, nextAccess] = await Promise.all([
        withinAppOpeningDeadline(desktopApi.loadWorkspace()),
        withinAppOpeningDeadline(readLocalCloudAccess(desktopApi)),
      ]);
      if (attempt !== openingAttempt.current) return;
      setWorkspace(nextWorkspace);
      setLicense(nextAccess.license);
      setCloudAccount(nextAccess.account);
      recordDiagnostic({id:incident,area:'app',operation:'workspace.open',phase:'success',durationMs:performance.now()-started});
      // Recheck revocation, role and subscription immediately, off the opening path.
      void revalidateCloudAccess();
    } catch (reason) {
      if (attempt !== openingAttempt.current) return;
      setError(errorMessage(reason, 'L’espace local n’a pas pu être ouvert.'));
      setOpeningErrorIncident({attempt,code:`ZT-${incident}`});
      recordDiagnostic({id:incident,area:'app',operation:'workspace.open',phase:'failure',durationMs:performance.now()-started,errorCode:classifyDiagnosticError(reason)});
    } finally {
      if (attempt === openingAttempt.current) setLoading(false);
    }
  }, [revalidateCloudAccess]);

  useEffect(() => {
    let active = true;
    if (!workspace || companyAdmission?.key !== draftIdentityKey || companyAdmission.epoch !== accountEpoch.current) return;
    setDraftIdentityFailure(null);
    if (!workspace.workNotesScope) {
      setDraftIdentity({key:draftIdentityKey});
      const incident = recordDiagnostic({area:'draft',operation:'identity.scope',phase:'failure',errorCode:'STORAGE'});
      setDraftIdentityFailure({key:draftIdentityKey,reason:'scope',incidentCode:`ZT-${incident}`});
      return;
    }
    if (!cloudDraftIdentity) {
      setDraftIdentity({key:draftIdentityKey,memberId:'local-user'});
      return;
    }
    const epoch = accountEpoch.current;
    const started = performance.now();
    const incident = recordDiagnostic({area:'draft',operation:'identity.read',phase:'start'});
    const failed = (reason: 'failure'|'timeout') => {
      if (!active || epoch !== accountEpoch.current) return;
      active = false;
      clearTimeout(timer);
      // A transient local read error for the same account must not close a form.
      // Explicit account changes synchronously invalidate the previous identity.
      setDraftIdentity(previous=>previous.key===draftIdentityKey?previous:{key:draftIdentityKey});
      setDraftIdentityFailure({key:draftIdentityKey,reason,incidentCode:`ZT-${incident}`});
      recordDiagnostic({id:incident,area:'draft',operation:'identity.read',phase:'failure',durationMs:performance.now()-started,errorCode:'STORAGE'});
    };
    const timer = window.setTimeout(() => failed('timeout'), FORM_DRAFT_IDENTITY_TIMEOUT_MS);
    // This trusted member id comes from protected local storage, never a server
    // request or editable account metadata. Only the initial admission waits.
    void Promise.resolve().then(() => desktopApi.getFormDraftIdentity()).then(identity => {
      if (!active || epoch !== accountEpoch.current) return;
      if (!identity.memberId?.trim()) { failed('failure'); return; }
      active = false;
      clearTimeout(timer);
      setDraftIdentity({key:draftIdentityKey,memberId:identity.memberId});
      recordDiagnostic({id:incident,area:'draft',operation:'identity.read',phase:'success',durationMs:performance.now()-started});
    }, () => failed('failure'));
    return () => { if (active) recordDiagnostic({id:incident,area:'draft',operation:'identity.read',phase:'info',durationMs:performance.now()-started}); active = false; clearTimeout(timer); };
  }, [Boolean(workspace), draftIdentityKey, draftIdentityRevision, companyAdmission?.key, companyAdmission?.epoch]);

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
    const epoch = accountEpoch.current;
    void desktopApi
      .refreshLicense(true)
      .then(next => { if (epoch === accountEpoch.current) setLicense(next); })
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
    (next: CloudAccountState, reason?: 'verified' | 'linked' | 'disconnected') => {
      const epoch = ++accountEpoch.current;
      cloudAccessRevalidator.current!.invalidate();
      if (reason !== 'verified') { setDraftIdentity({key:''}); setDraftIdentityFailure(null); }
      setDraftIdentityRevision(value=>value+1);
      setCloudAccount(next);
      if (cloudAccountChangeNeedsLicenseRefresh(next)) {
        // Native approval/account reads already checked the session. Repeating
        // /me here delays the new licence and competes with Automation startup.
        void readCloudAccessForAccount(desktopApi, next)
          .then(access => { if (epoch === accountEpoch.current) setLicense(access.license); })
          .catch(() => {});
      }
    },
    [],
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
        <ErrorGuidance
          title={t("Espace indisponible")}
          error={error || 'Aucune donnée locale n’a été retournée.'}
          operation="read"
          incidentCode={openingErrorIncident?.attempt === openingAttempt.current ? openingErrorIncident.code : undefined}
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
      <Suspense fallback={<main className="splash-screen" aria-busy="true"><LoaderCircle className="spin" size={24} aria-hidden="true" /><p role="status">{t("Ouverture de votre espace…")}</p></main>}><Onboarding
        accountNotice={license && license.status !== 'valid' ? <LicenseActivation
          license={license} account={cloudAccount} onAccountChange={handleCloudAccountChange} hasNavigation={false}
          onInstall={async token => { setLicense(await desktopApi.installLicenseToken(token)); setWorkspace(await desktopApi.loadWorkspace()); }}
          onRefresh={async () => setLicense(await desktopApi.refreshLicense(false))}
        /> : null}
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
      /></Suspense>
    ) : workspace.activityProfileRequired || activityProfileMissing ? (
      <BusinessProfileGate key={workspace.workNotesScope} workspace={workspace} readOnly={Boolean(license?.readOnly || cloudRoleReadOnly)} onSaved={setWorkspace} />
    ) : !draftIdentityReady ? (
      <main className="splash-screen draft-identity-splash" aria-busy={draftIdentityFailure?.key !== draftIdentityKey}>
        <BrandMark size={58} />
        <h1>Zentra</h1>
        {draftIdentityFailure?.key === draftIdentityKey ? <>
          <ErrorGuidance title={t('Espace indisponible')} error={draftIdentityMessages[language][draftIdentityFailure.reason]} fallback={draftIdentityMessages[language][draftIdentityFailure.reason]} operation="read" incidentCode={draftIdentityFailure.incidentCode} />
          <Button autoFocus onClick={() => { if (!workspace.workNotesScope) { void load(); return; } setDraftIdentityFailure(null); setDraftIdentityRevision(value=>value+1); }}>{draftIdentityMessages[language].retry}</Button>
        </> : <><p role="status">{draftIdentityMessages[language].loading}</p><LoaderCircle className="spin" size={22} aria-hidden="true" /></>}
      </main>
    ) : (
      <Suspense fallback={<main className="splash-screen"><LoaderCircle className="spin" size={24} /><p>{t("Ouverture de votre espace…")}</p></main>}><FormDraftIdentityProvider key={`${draftIdentityKey}:${draftIdentity.memberId}`} companyId={workspace.workNotesScope} organizationId={draftOrganizationId || undefined} memberId={draftIdentity.memberId} ready><WorkspaceApp
        workspace={workspace}
        setWorkspace={setWorkspace}
        readOnly={Boolean(license?.readOnly || cloudRoleReadOnly)}
        readOnlySource={cloudRoleReadOnly ? 'cloud' : 'license'}
        cloudAccount={cloudAccount}
        onCloudAccountChange={handleCloudAccountChange}
      /></FormDraftIdentityProvider></Suspense>
    );

  const licenseNeedsAttention = Boolean(license && license.status !== 'valid');

  return (
    <>
      <CompanyAccountGate account={cloudAccount} workspace={workspace} createdFor={createdFor} onWorkspace={setWorkspace} onAccountChange={handleCloudAccountChange}>
        <DraftCompanyAdmissionMarker identityKey={draftIdentityKey} epoch={accountEpoch.current} onAdmission={setCompanyAdmission}>{content}</DraftCompanyAdmissionMarker>
      </CompanyAccountGate>
      {!workspaceReady ? <StandaloneUpdaterAccess /> : null}
      {license && licenseNeedsAttention && workspace.onboardingCompleted && workspace.settings ? (
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
          className="app-updater-modal"
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
      {error ? <ErrorGuidance error={error} compact /> : null}
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
