import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { desktopApi, type CloudAccountState } from '../src/bridge';
import { CompanyAccountGate } from '../src/CompanyAccountGate';
import { initialOnboardingSettings } from '../src/onboardingDraft';
import { setAppearance } from '../src/appearance';
import { setAppLanguage } from '../src/language';
import type { Workspace } from '../src/types';
import '../src/styles.css';
import '../src/dark.css';
const query = new URLSearchParams(location.search);
setAppearance(query.get('theme') === 'dark' ? 'dark' : 'light');
if (query.get('language') === 'de') setAppLanguage('de');
const scenario = query.get('scenario') || 'empty';
const account: CloudAccountState = { status: 'connected', organizationId: 'windows', organizationName: 'Atelier Windows', role: 'owner' };
const received = { onboardingCompleted: true, settings: initialOnboardingSettings, quotes: [], clients: [{ id: 'client-windows', name: 'Client Windows' }], invoices: [{ id: 'invoice-windows', number: 'F-2026-0012' }] } as unknown as Workspace;
let calls = 0, loaded = false;
desktopApi.getCloudAccountState = async () => account;
desktopApi.resolveConnectedCompany = async (org, choice) => {
  calls++;
  await new Promise(resolve => setTimeout(resolve, 150));
  if (scenario === 'failure' && calls === 1) throw new Error('Connexion interrompue. Réessayez.');
  if (scenario === 'old' && choice !== 'open' && !loaded) return {status:'choose_remote',organizationId:org,changed:false};
  if (scenario === 'local' && choice !== 'publish') return {status:'choose_local',organizationId:org,changed:false};
  if (scenario === 'waiting') return {status:'waiting',organizationId:org,changed:false};
  if (scenario === 'create') return {status:'create',organizationId:org,changed:false};
  const changed = !loaded; loaded = true;
  return {status:'ready',organizationId:org,changed};
};
desktopApi.loadWorkspace = async () => received;
function Harness() {
  const [workspace, setWorkspace] = useState<Workspace>({ ...received, onboardingCompleted: ['old','local'].includes(scenario), clients: [], invoices: [] });
  return <CompanyAccountGate account={account} workspace={workspace} createdFor={scenario==='created'?'windows':null} onWorkspace={setWorkspace} onAccountChange={()=>{}}>
    <main><h1>{workspace.clients.length?'Atelier Windows retrouvé':'Créer votre entreprise'}</h1><p>{workspace.clients[0]?.name}</p><p>{workspace.invoices[0]?.number}</p></main>
  </CompanyAccountGate>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><Harness/></StrictMode>);
