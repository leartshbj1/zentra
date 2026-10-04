// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost","pretendToBeVisual":true}
/** Actual App, company gate, account panel, identity provider and WorkspaceApp.
 * Account/backend data and native IPC are closed explicit fakes. No hook,
 * identity provider, admission effect, or account-change callback is replaced. */
import {act as reactAct} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {setAppLanguage} from './language';
import {languageAssets} from 'virtual:zentra-language-assets';
vi.setConfig({testTimeout:15000});
import {App} from './App';
import {desktopApi,type CloudAccountState} from './bridge';
import {initialOnboardingSettings} from './onboardingDraft';
import {FORM_DRAFT_PREFIX} from './formDrafts';
import {recentDiagnosticEvents} from './diagnostics';
import {ZentraAssistantProvider} from './ZentraAssistant';

const transport=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({Channel:class{},invoke:transport.invoke,isTauri:()=>false}));
const scope='app-admission-company',organization='app-admission-org';
const memberA='11111111-1111-4111-8111-111111111111',memberB='22222222-2222-4222-8222-222222222222';
const nonceA='a'.repeat(32),nonceB='b'.repeat(32);
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>resolve=yes);return {promise,resolve};}
const held:{resolve:(value:any)=>void}[]=[];
let root:Root|undefined,host:HTMLDivElement,external=0,identityReads=0,nativeNonce=nonceA;
let account:CloudAccountState,rows:any[],identity:()=>Promise<{memberId?:string;memberContextNonce?:string}>;
let writes=0,writeAttempts:any[]=[],readArgs:any[]=[],writeHold:ReturnType<typeof deferred<void>>|null=null,writeEntered=false;
let firstRevalidation:ReturnType<typeof deferred<CloudAccountState>>;
const settings={...structuredClone(initialOnboardingSettings),business:{nogaSection:'M',nogaDivision:'68',activityDescription:'Services de recette',nogaDetailedCode:''},organization:{...initialOnboardingSettings.organization,legalName:'Entreprise témoin',contactName:'Compte témoin'}};
const raw=()=>({work_notes_scope:scope,settings:{company_name:'Entreprise témoin',extra_settings_json:JSON.stringify(settings),noga_section:'M',noga_division:'68',activity_description:'Services de recette'},clients:rows,projects:[],employees:[],time_entries:[]});
const license={enforcementConfigured:true,status:'valid',readOnly:false,canRefresh:false,accessRole:'owner',installationId:'synthetic-app-only',reason:''};
async function settle(){await reactAct(async()=>{for(let i=0;i<25;i++)await Promise.resolve();await new Promise<void>(yes=>setTimeout(yes,5));});}
async function until(check:()=>boolean){const deadline=performance.now()+8000;while(!check()&&performance.now()<deadline)await settle();expect(check(),document.body.textContent??'').toBe(true);}
const button=(text:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(row=>row.textContent?.trim()===text);
async function click(text:string){const target=button(text);expect(target,document.body.textContent??'').toBeDefined();await reactAct(async()=>target!.click());await settle();}
const draftKeys=()=>Object.keys(localStorage).filter(key=>key.startsWith(FORM_DRAFT_PREFIX));
const draftOwner=()=>JSON.parse(decodeURIComponent(draftKeys()[0].slice(FORM_DRAFT_PREFIX.length))).slice(0,3);
async function openClient(){await click('Clients');await click('Nouveau client');await until(()=>document.querySelector('[role="dialog"] [name="company"]')!==null);
  for(const [name,value] of Object.entries({company:'App témoin',contactPerson:'Personne témoin',street:'Rue témoin',postalCode:'1000',city:'Lausanne',country:'CH'})){
    const input=document.querySelector<HTMLInputElement|HTMLSelectElement>(`[role="dialog"] [name="${name}"]`)!;
    await reactAct(async()=>{const prototype=input instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));});
  }await settle();expect(draftKeys()).toHaveLength(1);
}
async function submit(){const form=document.querySelector<HTMLFormElement>('[role="dialog"] form')!;await reactAct(async()=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));await settle();}
async function mount(){host=document.createElement('div');host.id='root';document.body.append(host);root=createRoot(host);await reactAct(async()=>root!.render(<ZentraAssistantProvider><App/></ZentraAssistantProvider>));await settle();}

beforeEach(()=>{
  writes=0;writeAttempts=[];readArgs=[];writeHold=null;writeEntered=false;external=0;identityReads=0;rows=[];nativeNonce=nonceA;held.length=0;localStorage.clear();sessionStorage.clear();
  account={status:'connected',organizationId:organization,organizationName:'Entreprise témoin',role:'owner'};
  identity=async()=>({memberId:memberA,memberContextNonce:nonceA});firstRevalidation=deferred();held.push(firstRevalidation);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('fetch',vi.fn(async()=>{external++;throw Error('External fetch forbidden in closed App proof.');}));
  vi.spyOn(desktopApi,'getCachedCloudAccountState').mockImplementation(async()=>structuredClone(account));
  vi.spyOn(desktopApi,'getCloudAccountState').mockImplementationOnce(()=>firstRevalidation.promise).mockImplementation(async()=>structuredClone(account));
  vi.spyOn(desktopApi,'getLicenseState').mockResolvedValue(license as never);vi.spyOn(desktopApi,'refreshLicense').mockResolvedValue(license as never);
  vi.spyOn(desktopApi,'resolveConnectedCompany').mockImplementation(async org=>({status:'ready',organizationId:org,changed:false}));
  vi.spyOn(desktopApi,'getCloudTeam').mockResolvedValue({organizationId:organization,organizationName:'Entreprise témoin',role:'owner',canManage:false,profile:null,members:[],invitations:[],seats:{planName:'Recette',limit:3,used:1,reserved:0,available:2,subscriptionActive:true}} as never);
  vi.spyOn(desktopApi,'getNogaCatalog').mockResolvedValue({version:'2025',source:'',sections:[{code:'M',label:'Recette',divisions:[{code:'68',label:'Recette'}]}]} as never);
  vi.spyOn(desktopApi,'getCompanySyncState').mockResolvedValue({enabled:false,connected:false} as never);
  vi.spyOn(desktopApi,'getCloudBackupState').mockResolvedValue({enabled:false,connected:false,backups:[]} as never);
  vi.spyOn(desktopApi,'getReminderSettings').mockResolvedValue({enabled:false,senderName:'',lastScanAt:''} as never);
  vi.spyOn(desktopApi,'listReminderTemplates').mockResolvedValue([]);vi.spyOn(desktopApi,'listReminders').mockResolvedValue([]);
  vi.spyOn(desktopApi,'getSecureUpdatePolicy').mockResolvedValue({enabled:false,reason:'Recette locale'} as never);
  vi.spyOn(desktopApi,'getProjectSyncStatus').mockResolvedValue({pending:0,syncing:false,connected:false,documents:[]} as never);
  vi.spyOn(desktopApi,'syncProjectDocuments').mockResolvedValue({pending:0,syncing:false,connected:false,documents:[]} as never);
  transport.invoke.mockReset();transport.invoke.mockImplementation(async(command:string,args:any)=>{
    if(command==='get_form_draft_identity'){identityReads++;return identity();}
    if(command==='get_app_state'||command==='get_workspace'){
      readArgs.push({command,args:structuredClone(args??{})});
      if(args?.expectedMemberContextNonce!==undefined&&args.expectedMemberContextNonce!==nativeNonce)throw 'Champ invalide : Le compte connecté a changé. Rouvrez cette action avec le bon compte.';
      return command==='get_app_state'?{onboarding_completed:true,activity_profile_required:true}:structuredClone(raw());
    }
    if(command==='update_settings'){writeAttempts.push(structuredClone(args));if(writeHold){writeEntered=true;await writeHold.promise;}if(args.expectedMemberContextNonce!==undefined&&args.expectedMemberContextNonce!==nativeNonce)throw 'Champ invalide : Le compte connecté a changé. Rouvrez cette action avec le bon compte.';writes++;return structuredClone(args.data);}
    if(command==='create_record'&&args.entity==='clients'){
      expect(args.expectedWorkspaceScope).toBe(scope);expect(args.expectedMemberContextNonce).toBe(nativeNonce);rows.push(structuredClone(args.data));return structuredClone(args.data);
    }
    if(command==='automation_request'&&args?.data===null)return {organizationId:organization,active:false,canManage:false,available:[],settings:{enabled:false,consent:false,mode:'shadow',flags:[],thresholds:{medium:.5,high:.95}}};
    if(command==='append_diagnostic_events')return;
    throw Error('Native command outside closed App admission fixture: '+command);
  });
});
afterEach(async()=>{writeHold?.resolve(undefined);if(root)await reactAct(async()=>root!.unmount());root=undefined;host?.remove();for(const pending of held)pending.resolve({memberId:memberA,memberContextNonce:nonceA,...account});await settle();await setAppLanguage('fr');expect(external).toBe(0);expect((globalThis as any).__memberOriginImportRequests).toBe(0);vi.unstubAllGlobals();vi.restoreAllMocks();});


async function gateSubmit(){const form=document.querySelector<HTMLFormElement>('.business-profile-gate form')!;expect(form).not.toBeNull();await reactAct(async()=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));await settle();}
describe('actual App activity-profile member admission before every settings write',()=>{
 it('opens an already-created local offline company gate only after local member nonce admission',async()=>{
  account={status:'disconnected'};identity=async()=>({memberContextNonce:nonceA});await mount();await until(()=>document.querySelector('.business-profile-gate')!==null);expect(identityReads).toBe(1);readArgs=[];await gateSubmit();expect(writes).toBe(1);expect(writeAttempts).toHaveLength(1);expect(writeAttempts[0].expectedWorkspaceScope).toBe(scope);expect(writeAttempts[0].expectedMemberContextNonce).toBe(nonceA);for(const read of readArgs)expect(read.args).toEqual({expectedWorkspaceScope:scope,expectedMemberContextNonce:nonceA});
 });
 it('does not expose profile save while first identity is still unknown and does not obtain a second origin at submit',async()=>{
  const pending=deferred<{memberId?:string;memberContextNonce?:string}>();held.push(pending);identity=()=>pending.promise;await mount();await until(()=>identityReads===1);expect(document.querySelector('.business-profile-gate')).toBeNull();expect(writeAttempts).toHaveLength(0);await reactAct(async()=>pending.resolve({memberId:memberA,memberContextNonce:nonceA}));await until(()=>document.querySelector('.business-profile-gate')!==null);const count=identityReads;await gateSubmit();expect(writes).toBe(1);expect(identityReads).toBe(count);
 });
 it.each(['absent','malformed','rejected'] as const)('does not expose activity-profile write with %s initial identity',async kind=>{
  identity=kind==='rejected'?async()=>{throw Error('Closed local identity failure');}:async()=>({memberId:memberA,...(kind==='malformed'?{memberContextNonce:'invalid'}:{})});await mount();await until(()=>document.querySelector('[data-draft-identity-failure]')!==null);expect(document.querySelector('.business-profile-gate')).toBeNull();expect(writes).toBe(0);expect(writeAttempts).toHaveLength(0);expect(identityReads).toBe(1);
 });
 it.each([false,true])('refuses activity-profile A save after same-workspace member transition ABA=%s',async aba=>{
  await mount();await until(()=>document.querySelector('.business-profile-gate')!==null);readArgs=[];writeHold=deferred();held.push(writeHold);await gateSubmit();await until(()=>writeEntered);nativeNonce=nonceB;if(aba)nativeNonce='c'.repeat(32);await reactAct(async()=>writeHold!.resolve(undefined));await settle();expect.soft(writes).toBe(0);expect(writeAttempts).toHaveLength(1);expect.soft(writeAttempts[0].expectedMemberContextNonce).toBe(nonceA);expect.soft(readArgs).toHaveLength(0);expect(document.querySelector('.business-profile-gate')).not.toBeNull();
 });
});
describe('actual profile gate uses the existing four-language identity failure gate',()=>{
 it.each((['fr','de','it','en'] as const).flatMap(language=>(['absent','malformed'] as const).map(kind=>({language,kind}))))('keeps $language profile action unavailable with $kind member nonce',async({language,kind})=>{
  const allowed=new Set(Object.values(languageAssets));vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{if(!allowed.has(String(input))){external++;throw Error('External language request forbidden.');}return {ok:true,json:async()=>({'QA local pack':'QA local pack'})} as Response;}));await setAppLanguage(language);
  identity=async()=>({memberId:memberA,...(kind==='malformed'?{memberContextNonce:'invalid'}:{})});await mount();await until(()=>document.querySelector('[data-draft-identity-failure]')!==null);expect(document.querySelector('[data-draft-identity-failure]')?.getAttribute('data-draft-identity-failure')).toBe(kind==='absent'?'compatibility':'context');expect(document.querySelector('.business-profile-gate')).toBeNull();expect(document.querySelector('[role="alert"]')).not.toBeNull();expect(writeAttempts).toHaveLength(0);expect(writes).toBe(0);
 });
});

// Closed import boundary for the maintained CI test, independent of output config.
vi.hoisted(()=>{
  (globalThis as any).__memberOriginImportRequests=0;
  Object.defineProperty(window,'matchMedia',{configurable:true,value:()=>({matches:false,addEventListener:()=>{},removeEventListener:()=>{},addListener:()=>{},removeListener:()=>{}})});
  HTMLElement.prototype.scrollIntoView=()=>{};window.scrollTo=()=>{};
  (globalThis as any).ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};
  globalThis.fetch=async()=>{(globalThis as any).__memberOriginImportRequests++;throw Error('External fetch forbidden during maintained member-origin test import.');};
});
