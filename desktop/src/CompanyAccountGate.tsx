import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Building2, LoaderCircle } from 'lucide-react';
import { desktopApi, type CloudAccountState } from './bridge';
import type { Workspace } from './types';
import { singleFlightCompanyResolver, type CompanyAccountChoice, type CompanyAccountResolution } from './companyAccount';
import { CloudAccountAccess } from './CloudAccountAccess';
import { BrandMark } from './BrandMark';
import { Button, ErrorPanel } from './ui';
import { t } from './language';
import { errorMessage } from './utils';
import './companyAccount.css';

const resolve = singleFlightCompanyResolver((org, choice) => desktopApi.resolveConnectedCompany(org, choice));

export function CompanyAccountGate({ account, workspace, createdFor, onWorkspace, onAccountChange, children }: {
  account: CloudAccountState | null;
  workspace: Workspace;
  createdFor: string | null;
  onWorkspace: (value: Workspace) => void;
  onAccountChange: (value: CloudAccountState) => void;
  children: ReactNode;
}) {
  const organization = account?.status === 'connected' ? account.organizationId : undefined;
  const [resolution, setResolution] = useState<CompanyAccountResolution | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const current = useRef(organization); current.current = organization;
  const onWorkspaceRef = useRef(onWorkspace); onWorkspaceRef.current = onWorkspace;
  const epoch = useRef(0);
  async function run(choice: CompanyAccountChoice) {
    if (!organization) return;
    const attempt = ++epoch.current;
    setBusy(true); setError('');
    try {
      const result = await resolve(organization, choice);
      if (attempt !== epoch.current || current.current !== organization) return;
      if (result.organizationId !== organization) throw new Error(t('Le compte a changé. Recommencez la connexion.'));
      if (result.changed) {
        const next = await desktopApi.loadWorkspace();
        if (attempt !== epoch.current || current.current !== organization) return;
        onWorkspaceRef.current(next);
        window.dispatchEvent(new Event('zentra-project-documents-changed'));
      }
      setResolution(result);
    } catch (reason) {
      if (attempt === epoch.current && current.current === organization) {
        setError(errorMessage(reason, 'Votre entreprise n’a pas pu être récupérée. Vos données sont conservées.'));
      }
    } finally { if (attempt === epoch.current) setBusy(false); }
  }
  useEffect(() => {
    setResolution(null);
    if (organization) void run(createdFor === organization ? 'publish' : 'auto');
    return () => { ++epoch.current; };
  }, [organization, workspace.onboardingCompleted, createdFor, retry]);
  useEffect(() => {
    if (!organization || (!error && resolution?.status !== 'waiting')) return;
    const retryConnection = () => setRetry(value => value + 1);
    window.addEventListener('online', retryConnection);
    // Another device may still be uploading the first company snapshot.
    const timer = window.setInterval(retryConnection, 15_000);
    return () => { window.removeEventListener('online', retryConnection); window.clearInterval(timer); };
  }, [organization, error, resolution?.status]);

  if (!organization || (resolution?.organizationId === organization && ['ready', 'create'].includes(resolution.status))) return <>{children}</>;
  const remote = resolution?.status === 'choose_remote';
  const local = resolution?.status === 'choose_local';
  const waiting = resolution?.status === 'waiting';
  return <main className="company-account-opening" aria-busy={busy}>
    <section>
      <BrandMark size={42} />
      <div className="company-account-opening__identity"><Building2 size={20}/><span>{account?.organizationName}</span></div>
      <h1>{t(remote ? 'Quel espace souhaitez-vous ouvrir ?' : local ? 'Retrouvez cet espace sur tous vos appareils' : waiting ? 'Votre entreprise attend son premier envoi' : 'Ouverture de votre entreprise…')}</h1>
      {remote && <div className="company-account-choices">
        <div><span>{t('Sur cet appareil')}</span><strong>{workspace.settings?.organization.legalName || t('Mon entreprise')}</strong><p>{t('{quotes} devis · {invoices} factures', { quotes: workspace.quotes.length, invoices: workspace.invoices.length })}</p><small>{t('Une sauvegarde est conservée avant le changement.')}</small></div>
        <div><span>{t('Dans votre compte')}</span><strong>{account?.organizationName}</strong><p>{t('Documents, équipe et réglages Automation de cet espace.')}</p></div>
      </div>}
      {local && <p>{t('Retrouvez les mêmes documents et montants sur vos autres appareils.')}</p>}
      {waiting && <p>{t('Ouvrez Zentra sur l’appareil où vous avez créé votre entreprise et connectez le même compte. Cet écran se mettra à jour automatiquement.')}</p>}
      {error && <ErrorPanel message={error} onRetry={() => setRetry(value => value + 1)} />}
      {busy ? <p role="status"><LoaderCircle size={20} className="spin"/>{t('Récupération sécurisée…')}</p> : <>
        {remote && <Button onClick={() => void run('open')}>{t('Ouvrir l’espace du compte')}</Button>}
        {local && <Button onClick={() => void run('publish')}>{t('Relier cette entreprise à mon compte')}</Button>}
        {waiting && <Button variant="secondary" onClick={() => setRetry(value => value + 1)}>{t('Réessayer')}</Button>}
        <CloudAccountAccess account={account} onAccountChange={onAccountChange} label={remote || local || waiting ? t('Choisir un autre espace') : undefined}/>
      </>}
    </section>
  </main>;
}
