import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { desktopApi, type CloudAccountState } from '../src/bridge';
import { CompanyAccountGate } from '../src/CompanyAccountGate';
import { initialOnboardingSettings } from '../src/onboardingDraft';
import { setAppearance } from '../src/appearance';
import { parseLanguage, setAppLanguage } from '../src/language';
import type { Workspace } from '../src/types';
import '../src/styles.css';
import '../src/dark.css';
import '../src/workspace-atelier.css';
import '../src/text-size.css';
const query = new URLSearchParams(location.search);
setAppearance(query.get('theme') === 'dark' ? 'dark' : 'light');
await setAppLanguage(parseLanguage(query.get('language')) || 'fr');
const scenario = query.get('scenario') || 'empty';
let currentAccount: CloudAccountState = { status: 'connected', organizationId: 'windows', organizationName: query.has('long') ? 'Atelier Windows — Société de rénovation et de conseil pour les entreprises du Léman' : 'Atelier Windows', role: query.get('role') === 'read_only' ? 'read_only' : 'owner' };
const received = { onboardingCompleted: true, settings: initialOnboardingSettings, quotes: [], clients: [{ id: 'client-windows', name: 'Client Windows' }], invoices: [{ id: 'invoice-windows', number: 'F-2026-0012' }] } as unknown as Workspace;
let calls = 0, loaded = false;
const held = new Map<string, (fail?: boolean) => void>();
const qa = {calls: [] as {org:string;choice:string}[], loads:0, failNextOpen:false, pending:()=>[...held.keys()], switchAccount: (_org:string)=>{}, release:(key:string,fail=false)=>held.get(key)?.(fail)};
(window as unknown as {__companyGateQa:typeof qa}).__companyGateQa=qa;
desktopApi.getCloudAccountState = async () => currentAccount;
desktopApi.getCachedCloudAccountState = async () => currentAccount;
desktopApi.resolveConnectedCompany = async (org, choice) => {
  calls++;
  qa.calls.push({org,choice});
  await new Promise(resolve => setTimeout(resolve, 150));
  if(scenario==='race'&&org==='mac'&&loaded)return {status:'ready',organizationId:org,changed:false};
  if (scenario==='race' && ((org==='windows'&&choice==='open') || (org==='mac'&&choice==='auto'))) await new Promise<void>((resolve,reject)=>held.set(`${org}:${choice}`,fail=>{held.delete(`${org}:${choice}`);if(fail)reject(new Error('Ancienne erreur'));else resolve();}));
  if (choice==='open' && qa.failNextOpen) {qa.failNextOpen=false;throw new Error('La connexion a été interrompue. Vos données sont conservées.');}
  if (scenario === 'failure' && calls === 1) throw new Error('Connexion interrompue. Réessayez.');
  if ((scenario === 'old' || scenario === 'race'&&org==='windows') && choice !== 'open' && !loaded) return {status:'choose_remote',organizationId:org,changed:false};
  if (scenario==='race'&&org==='mac'&&choice!=='publish') return {status:'choose_local',organizationId:org,changed:false};
  if (scenario === 'local' && choice !== 'publish') return {status:'choose_local',organizationId:org,changed:false};
  if (scenario === 'waiting') return {status:'waiting',organizationId:org,changed:false};
  if (scenario === 'create') return {status:'create',organizationId:org,changed:false};
  if (scenario==='race'&&org==='windows'&&choice==='open') return {status:'ready',organizationId:org,changed:true};
  const changed = !loaded; loaded = true;
  return {status:'ready',organizationId:org,changed};
};
desktopApi.loadWorkspace = async () => {qa.loads++;return received;};
function Harness() {
  const [account,setAccount]=useState(currentAccount);
  qa.switchAccount=org=>{currentAccount={...currentAccount,organizationId:org,organizationName:'Atelier Mac'};setAccount(currentAccount);};
  const [workspace, setWorkspace] = useState<Workspace>({ ...received, onboardingCompleted: ['old','local','race'].includes(scenario), clients: [], invoices: [] });
  return <CompanyAccountGate account={account} workspace={workspace} createdFor={scenario==='created'?'windows':null} onWorkspace={setWorkspace} onAccountChange={value=>{currentAccount=value;setAccount(value);}}>
    <main><h1>{workspace.clients.length?'Atelier Windows retrouvé':'Créer votre entreprise'}</h1><p>{workspace.clients[0]?.name}</p><p>{workspace.invoices[0]?.number}</p></main>
  </CompanyAccountGate>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><Harness/></StrictMode>);
