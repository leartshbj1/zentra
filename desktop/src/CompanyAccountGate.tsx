import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Building2, LoaderCircle } from 'lucide-react';
import { desktopApi, type CloudAccountState } from './bridge';
import type { Workspace } from './types';
import { companyAccountRoleLabels, singleFlightCompanyResolver, type CompanyAccountChoice, type CompanyAccountResolution } from './companyAccount';
import { CloudAccountAccess } from './CloudAccountAccess';
import { BrandMark } from './BrandMark';
import { Button, ErrorPanel } from './ui';
import { t, useAppLanguage } from './language';
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
  useAppLanguage();
  const workspaceKey = JSON.stringify([workspace.workNotesScope ?? null, workspace.onboardingCompleted]);
  const [resolved, setResolved] = useState<{value: CompanyAccountResolution; workspaceKey: string} | null>(null);
  const resolution = resolved?.workspaceKey === workspaceKey ? resolved.value : null;
  // Subscription status does not undo admission of this exact local company.
  // A different company or local scope still needs its own fresh resolution.
  const organization = account?.status === 'connected' ? account.organizationId
    : account?.status === 'inactive' && resolution && resolution.organizationId === account.organizationId && ['ready', 'create'].includes(resolution.status)
      ? account.organizationId : undefined;
  const [failure, setFailure] = useState<{ organization: string; message: string } | null>(null);
  const error = failure && failure.organization === organization ? failure.message : '';
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const requestKey = JSON.stringify([organization, workspaceKey]);
  const current = useRef(requestKey); current.current = requestKey;
  const onWorkspaceRef = useRef(onWorkspace); onWorkspaceRef.current = onWorkspace;
  const epoch = useRef(0);
  const admitted = useRef<string | null>(null);
  async function run(choice: CompanyAccountChoice) {
    if (!organization) return;
    const attempt = ++epoch.current;
    setBusy(true); setFailure(null);
    try {
      const result = await resolve(organization, choice);
      if (attempt !== epoch.current || current.current !== requestKey) return;
      if (result.organizationId !== organization) throw new Error(t('Le compte a changé. Recommencez la connexion.'));
      let nextWorkspaceKey = workspaceKey;
      let receivedWorkspace: Workspace | undefined;
      if (result.changed) {
        const next = await desktopApi.loadWorkspace();
        if (attempt !== epoch.current || current.current !== requestKey) return;
        nextWorkspaceKey = JSON.stringify([next.workNotesScope ?? null, next.onboardingCompleted]);
        receivedWorkspace = next;
      }
      admitted.current = ['ready', 'create'].includes(result.status) ? JSON.stringify([organization, nextWorkspaceKey, createdFor, retry]) : null;
      setResolved({value: result, workspaceKey: nextWorkspaceKey});
      if (receivedWorkspace) {
        onWorkspaceRef.current(receivedWorkspace);
        window.dispatchEvent(new Event('zentra-project-documents-changed'));
      }
    } catch (reason) {
      if (attempt === epoch.current && current.current === requestKey) {
        setFailure({ organization, message: errorMessage(reason, 'Votre entreprise n’a pas pu être récupérée. Vos données sont conservées.') });
      }
    } finally { if (attempt === epoch.current) setBusy(false); }
  }
  useEffect(() => {
    // A received workspace is published by run() itself; it is already admitted.
    if (resolution && ['ready', 'create'].includes(resolution.status) && admitted.current === JSON.stringify([organization, workspaceKey, createdFor, retry])) return;
    admitted.current = null;
    setResolved(null);
    if (organization) void run(createdFor === organization ? 'publish' : 'auto');
    return () => { ++epoch.current; };
  }, [organization, workspaceKey, createdFor, retry]);
  useEffect(() => {
    if (!organization || (!error && resolution?.status !== 'waiting')) return;
    const retryConnection = () => setRetry(value => value + 1);
    window.addEventListener('online', retryConnection);
    // Another device may still be uploading the first company snapshot.
    const timer = window.setInterval(retryConnection, 15_000);
    return () => { window.removeEventListener('online', retryConnection); window.clearInterval(timer); };
  }, [organization, error, resolution?.status]);

  if (!organization || (resolution?.organizationId === organization && ['ready', 'create'].includes(resolution.status))) return <>{children}</>;
  // A decision from the previous account must never offer an action for the new one.
  const selected = resolution?.organizationId === organization ? resolution : null;
  const remote = selected?.status === 'choose_remote';
  const local = selected?.status === 'choose_local';
  const waiting = selected?.status === 'waiting';
  const opening = busy || (!selected && !error);
  const role = account?.role ? companyAccountRoleLabels[account.role] : undefined;
  return <main className="company-account-opening" aria-busy={opening}>
    <section>
      <BrandMark size={42} />
      <div className="company-account-opening__identity"><Building2 size={20} aria-hidden="true"/><div><span>{account?.organizationName}</span>{role && <small>{t(role)}</small>}</div></div>
      <h1>{t(remote ? 'Ouvrir l’espace du compte sur cet appareil ?' : local ? 'Relier cette entreprise à votre compte' : waiting ? 'Votre entreprise attend son premier envoi' : 'Ouverture de votre entreprise…')}</h1>
      {remote && <div className="company-account-choices">
        <div><span>{t('Dans votre compte')}</span><strong>{account?.organizationName}</strong><p>{t('Documents, équipe et réglages Automation de cet espace.')}</p></div>
        <div><span>{t('Sur cet appareil')}</span><strong>{workspace.settings?.organization.legalName || t('Mon entreprise')}</strong><p>{t('{quotes} devis · {invoices} factures', { quotes: workspace.quotes.length, invoices: workspace.invoices.length })}</p><small>{t('Une sauvegarde est conservée avant le changement. Les entreprises restent séparées.')}</small></div>
      </div>}
      {local && <div className="company-account-choices"><div><span>{t('Sur cet appareil')}</span><strong>{workspace.settings?.organization.legalName || t('Mon entreprise')}</strong><p>{t('{quotes} devis · {invoices} factures', { quotes: workspace.quotes.length, invoices: workspace.invoices.length })}</p></div></div>}
      {local && <p>{t('Cette entreprise sera partagée dans l’espace de votre compte. Vos collaborateurs y retrouveront les mêmes documents et montants.')}</p>}
      {waiting && <p>{t('Ouvrez Zentra sur l’appareil où vous avez créé votre entreprise et connectez le même compte. Cet écran se mettra à jour automatiquement.')}</p>}
      {error && <ErrorPanel message={error} onRetry={() => setRetry(value => value + 1)} />}
      {opening ? <p role="status"><LoaderCircle size={20} className="spin" aria-hidden="true"/>{t('Récupération sécurisée…')}</p> : <div className="company-account-opening__actions">
        {remote && <Button onClick={() => void run('open')}>{t('Ouvrir l’espace du compte')}</Button>}
        {local && <Button onClick={() => void run('publish')}>{t('Relier cette entreprise à mon compte')}</Button>}
        {waiting && <Button variant="secondary" onClick={() => setRetry(value => value + 1)}>{t('Réessayer')}</Button>}
        <CloudAccountAccess account={account} onAccountChange={onAccountChange} label={remote || local || waiting ? t('Choisir une autre entreprise') : undefined}/>
      </div>}
    </section>
  </main>;
}
