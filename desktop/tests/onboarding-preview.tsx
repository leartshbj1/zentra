// Development-only synthetic fixture: no remote calls, native storage or customer data.
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC } from '@tauri-apps/api/mocks';
import { Onboarding } from '../src/Onboarding';
import { ZentraAssistantProvider } from '../src/ZentraAssistant';
import { desktopApi, type CloudAccountState } from '../src/bridge';
import { validateOnboarding } from '../src/onboardingValidation';
import { installAssistantFixture } from './assistant-fixture';
import { initialOnboardingSettings } from '../src/onboardingDraft';
import { CompanyAccountGate } from '../src/CompanyAccountGate';
import type { AppSettings, NogaCatalog, Workspace } from '../src/types';
import { setAppLanguage } from '../src/language';
import { setAppearance } from '../src/appearance';
import '../src/styles.css';
import '../src/workspace-design.css';
import '../src/mobile.css';
import '../src/experience.css';
import '../src/workspace-shell.css';
import '../src/guided-tour.css';
import '../src/clarity.css';
import '../src/refined.css';
import '../src/assistant.css';
import '../src/dark.generated.css';
import '../src/dark.css';
import '../src/mobile-air.css';
import '../src/automation-design.css';
import '../src/workspace-atelier.css';
import '../src/onboarding-journey.css';

const query = new URLSearchParams(location.search);
if (query.has('language')) setAppLanguage(query.get('language') as 'fr'|'de'|'it'|'en');
if (query.has('theme')) setAppearance(query.get('theme') as 'light'|'dark');
const catalog: NogaCatalog = {version:'2025',source:'https://www.kubb-tool.bfs.admin.ch/fr/noga/2025',sections:[{code:'M',label:'Activités immobilières',divisions:[{code:'68',label:'Activités immobilières'}]},{code:'F',label:'Construction',divisions:[{code:'43',label:'Travaux de construction spécialisés'}]}]};
const empty = {onboardingCompleted:false,settings:null,quotes:[],invoices:[]} as unknown as Workspace;
const fixture = {calls:[] as string[],completed:[] as AppSettings[],preflightFailure:false,createFailure:false,catalogFailure:false,restoreCancelled:false,account:{status:'disconnected'} as CloudAccountState};
Object.assign(window,{onboardingFixture:fixture});
installAssistantFixture();
mockIPC(command => {
  if (command==='automation_request') return {organizationId:'fixture-company',active:false,canManage:true,available:[],settings:{enabled:false,consent:false,mode:'suggest',flags:[],thresholds:{medium:.7,high:.9}}};
  if (command==='company_logo_preview') return '/src/assets/zentra-wordmark.png';
  if (command==='set_app_appearance') return null;
  throw new Error(`Unsupported test command ${command}`);
});
desktopApi.getNogaCatalog=async()=>{if(fixture.catalogFailure)throw new Error('Catalogue de test indisponible.');return catalog;};
desktopApi.getCachedCloudAccountState=desktopApi.getCloudAccountState=async()=>fixture.account;
desktopApi.startCloudAccountLink=async()=>{fixture.calls.push('start-link');return fixture.account={status:'pending',userCode:'TEST-1234',intervalSeconds:3,authorizationExpiresAt:new Date(Date.now()+600000).toISOString()};};
desktopApi.openCloudAccountLink=async()=>{fixture.calls.push('open-link');};
desktopApi.pollCloudAccountLink=async()=>fixture.account;
desktopApi.disconnectCloudAccount=async()=>{fixture.account={status:'disconnected'};};
desktopApi.getResetRecovery=async()=>({available:false}) as never;
desktopApi.chooseBackupFolder=async()=>{fixture.calls.push('backup-folder');return 'C:\\Zentra-test\\Sauvegardes';};
desktopApi.chooseRestoreFile=async()=>{fixture.calls.push('choose-restore');return fixture.restoreCancelled?null:'C:\\Zentra-test\\demo.zentra';};
desktopApi.chooseLogo=async()=>'/synthetic/logo.png';
desktopApi.stageCompanyLogo=async()=>`C:\\Zentra-test\\attachments\\branding\\logo-${'a'.repeat(64)}.png`;
desktopApi.validateOnboarding=async(settings,scope)=>{
  fixture.calls.push(`validate-${scope}`);
  if(fixture.preflightFailure){fixture.preflightFailure=false;return {valid:false,issues:[{step:2,field:'billing.iban',label:'L’IBAN',message:'Vérifiez le compte bancaire choisi.'}]};}
  const issues=validateOnboarding(settings,catalog,true,scope);
  return {valid:!issues.length,issues};
};
desktopApi.resolveConnectedCompany=async organizationId=>({organizationId,changed:query.has('remote'),status:query.has('remote')?'ready':'create'}) as never;
desktopApi.loadWorkspace=async()=>({...empty,onboardingCompleted:true,settings:{...initialOnboardingSettings,organization:{...initialOnboardingSettings.organization,legalName:'Entreprise déjà partagée'}}});

function Preview() {
  const [account,setAccount]=useState<CloudAccountState>(fixture.account);
  const [workspace,setWorkspace]=useState<Workspace>(empty);
  if(workspace.onboardingCompleted) return <main className="splash-screen"><h1>{workspace.settings?.organization.legalName}</h1><p>Parcours de test terminé. Aucune donnée réelle enregistrée.</p></main>;
  return <CompanyAccountGate account={account} workspace={workspace} createdFor={null} onAccountChange={setAccount} onWorkspace={setWorkspace}>
    <Onboarding cloudAccount={account} onCloudAccountChange={setAccount} onJoined={setWorkspace} onComplete={async(settings,scope)=>{
      fixture.calls.push(`create-${scope}`);if(fixture.createFailure)throw new Error('Enregistrement de test interrompu. Réessayez.');
      fixture.completed.push(settings);setWorkspace({...empty,onboardingCompleted:true,settings});
    }} onRestore={async()=>{fixture.calls.push('restore');setWorkspace({...empty,onboardingCompleted:true,settings:{...initialOnboardingSettings,organization:{...initialOnboardingSettings.organization,legalName:'Entreprise restaurée'}}});}}/>
  </CompanyAccountGate>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><ZentraAssistantProvider><Preview/></ZentraAssistantProvider></StrictMode>);
