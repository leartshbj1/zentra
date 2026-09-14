import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ResetAppPanel } from '../src/ResetAppPanel';
import { ResetRecovery } from '../src/ResetRecovery';
import { JoinCompany } from '../src/JoinCompany';
import { CloudTeamPanel } from '../src/CloudTeamPanel';
import { desktopApi } from '../src/bridge';
import { initialOnboardingSettings } from '../src/onboardingDraft';
import { ZentraAssistantProvider } from '../src/ZentraAssistant';
import { useMobileLayout } from '../src/useMobileLayout';
import { setAppearance } from '../src/appearance';
import type { Workspace } from '../src/types';
import '../src/styles.css';
import '../src/workspace-design.css';
import '../src/mobile.css';
import '../src/dark.generated.css';
import '../src/dark.css';
const query = new URLSearchParams(location.search);
setAppearance(query.get('theme')==='dark'?'dark':'light');
const company = {organizationId:'org_fixture',organizationName:'Entreprise de démonstration',role:'member',canManage:true,profile:{company_name:'Entreprise de démonstration'},companyCopy:query.has('missing')?null:{backupId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',publishedAt:'2026-09-14T12:00:00Z',sizeBytes:100},seats:{planName:'Start',limit:3,used:1,reserved:0,available:2,subscriptionActive:true},members:[],invitations:[]};
let joined=0, resets=0;
if(query.has('cacheFailure')) {
  let failures=0;
  const proto=Object.getPrototypeOf(caches) as CacheStorage;
  const keys=proto.keys;
  proto.keys=async function(){if(failures++===0)throw new Error('Le cache est occupé. Réessayez.');return keys.call(this);};
}
desktopApi.getCloudAccountState=async()=>({status:'connected',organizationId:'org_fixture',role:'member',organizationName:company.organizationName});
desktopApi.getCloudTeam=async()=>company;
desktopApi.joinCloudCompany=async()=>{
  joined++;
  await new Promise(resolve=>setTimeout(resolve,150));
  if(query.has('failure')&&joined===1)throw new Error('Connexion interrompue. Réessayez pour récupérer l’entreprise.');
  return {projects:[{id:'p'}],clients:[{id:'c'}],invoices:[{id:'i'}]} as Workspace;
};
desktopApi.resetLocalApp=async confirmation=>{
  resets++;
  if(confirmation!=='REINITIALISER')throw new Error('Confirmation absente');
  if(query.has('failure'))throw new Error('Un transfert est encore en cours. Réessayez dans un instant.');
  history.replaceState(null,'',`?resetDone=1&resetCalls=${resets}`);
  return {reset:true};
};
desktopApi.publishCloudCompany=async()=>({});
desktopApi.getResetRecovery=async()=>({available:true,createdAt:'2026-09-14'});
desktopApi.restoreResetRecovery=async()=>({projects:[{id:'p'}],clients:[{id:'c'}],invoices:[{id:'i'}]} as Workspace);
desktopApi.publishCompanyCopy=async()=>{company.companyCopy={backupId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',publishedAt:new Date().toISOString(),sizeBytes:100};return {};};
desktopApi.inviteCloudMember=async()=>({invitation:{url:'https://zentra.example/invitation?token=example'}});
Object.assign(window,{companyFixture:{get joined(){return joined},get resets(){return resets}}});
function Harness(){
  useMobileLayout();
  const [result,setResult]=useState<Workspace|null>(null),[closed,setClosed]=useState(false);
  if(query.has('resetDone'))return <main><h1>Créer, importer ou rejoindre une entreprise</h1></main>;
  if(query.has('recovery'))return result?<h1>Entreprise récupérée</h1>:<ResetRecovery onRestored={setResult}/>;
  if(query.has('join'))return result?<main><h1>Entreprise ouverte</h1><p>1 client · 1 facture · 1 projet</p></main>:closed?<p>Fermé</p>:<JoinCompany onClose={()=>setClosed(true)} onJoined={setResult}/>;
  return <main style={{maxWidth:850,margin:'auto',padding:16}}><h1>Compte et appareil</h1><ResetAppPanel/>{query.has('team')&&<CloudTeamPanel settings={initialOnboardingSettings}/>}</main>;
}
createRoot(document.getElementById('root')!).render(<ZentraAssistantProvider><Harness/></ZentraAssistantProvider>);
