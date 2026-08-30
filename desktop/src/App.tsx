import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Copy, HardHat, KeyRound, LoaderCircle, ShieldCheck } from 'lucide-react';
import { desktopApi } from './bridge';
import { BusinessProfileGate } from './BusinessProfileEditor';
import { Onboarding } from './Onboarding';
import { WorkspaceApp } from './WorkspaceApp';
import type { AppSettings, LicenseState, Workspace } from './types';
import { Button, ErrorPanel } from './ui';

export function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [license, setLicense] = useState<LicenseState | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [nextWorkspace, nextLicense] = await Promise.all([desktopApi.loadWorkspace(), desktopApi.getLicenseState()]);
      setWorkspace(nextWorkspace);
      setLicense(nextLicense);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'L’espace local n’a pas pu être ouvert.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <main className="splash-screen">
        <div className="splash-logo"><HardHat size={28} /></div>
        <h1>HelviChantier</h1>
        <p>Ouverture de votre espace local sécurisé…</p>
        <LoaderCircle className="spin" size={22} />
      </main>
    );
  }

  if (error || !workspace) {
    return (
      <main className="fatal-screen">
        <div className="splash-logo"><HardHat size={28} /></div>
        <ErrorPanel message={error || 'Aucune donnée locale n’a été retournée.'} />
        <Button onClick={() => void load()}>Réessayer</Button>
      </main>
    );
  }

  const activityProfileMissing = Boolean(workspace.settings && (!workspace.settings.business.nogaSection || !workspace.settings.business.nogaDivision || !workspace.settings.business.activityDescription.trim()));
  const content = !workspace.onboardingCompleted || !workspace.settings ? (
      <Onboarding
        onComplete={async (settings: AppSettings) => setWorkspace(await desktopApi.completeOnboarding(settings))}
        onRestore={async (path: string) => setWorkspace(await desktopApi.restoreBackup(path))}
      />
    ) : workspace.activityProfileRequired || activityProfileMissing ? <BusinessProfileGate workspace={workspace} onSaved={setWorkspace} /> : <WorkspaceApp workspace={workspace} setWorkspace={setWorkspace} readOnly={license?.readOnly ?? false} />;

  return <>{content}{license ? <LicenseActivation license={license} onInstall={async (token) => { const next = await desktopApi.installLicenseToken(token); setLicense(next); setWorkspace(await desktopApi.loadWorkspace()); }} /> : null}</>;
}

const licenseLabels: Record<LicenseState['status'], string> = {
  not_configured: 'Contrôle de licence non configuré',
  missing: 'Activation requise',
  invalid: 'Licence invalide',
  clock_error: 'Horloge Windows à contrôler',
  not_yet_valid: 'Licence pas encore valide',
  expired: 'Licence expirée',
  valid: 'Licence active',
};

function LicenseActivation({ license, onInstall }: { license: LicenseState; onInstall: (token: string) => Promise<void> }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError('');
    try { await onInstall(token.trim()); setToken(''); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Le jeton de licence n’a pas pu être vérifié localement.'); }
    finally { setBusy(false); }
  }
  const identity = <div className="license-banner__identity"><span>Installation</span><code>{license.installationId || 'indisponible'}</code>{license.installationId ? <Button type="button" variant="ghost" size="icon" title="Copier l’identifiant" onClick={() => void navigator.clipboard.writeText(license.installationId)}><Copy size={14} /></Button> : null}</div>;
  if (!license.enforcementConfigured) {
    return <aside className="license-banner" role="status"><div className="license-banner__summary"><span><ShieldCheck size={18} /></span><div><strong>{licenseLabels.not_configured}</strong><small>Cette indication doit uniquement apparaître pendant le développement.</small></div></div>{identity}<p>{license.reason}</p></aside>;
  }
  const form = <form onSubmit={submit}>{identity}<label><span>Jeton signé obtenu après le paiement Stripe</span><textarea value={token} onChange={(event) => setToken(event.target.value)} rows={2} required /></label>{error ? <small className="license-banner__error">{error}</small> : null}<Button type="submit" size="small" disabled={busy || !token.trim()}>{busy ? <LoaderCircle className="spin" size={15} /> : <KeyRound size={15} />}{busy ? 'Vérification…' : 'Installer le jeton'}</Button></form>;
  return <aside className={`license-banner ${license.readOnly ? 'license-banner--warning' : ''}`} role="status"><div className="license-banner__summary"><span>{license.readOnly ? <KeyRound size={18} /> : <ShieldCheck size={18} />}</span><div><strong>{licenseLabels[license.status]}</strong><small>{license.readOnly ? 'Application en lecture seule; sauvegarde et export restent disponibles.' : `${license.customerName || 'Licence vérifiée'} · valable jusqu’au ${license.validUntil}`}</small></div></div>{license.readOnly ? form : <details><summary>Licence et identifiant d’installation</summary>{form}</details>}<p>{license.reason || `Plan 50 CHF / mois · jeton signé et lié à ce PC`}</p></aside>;
}
