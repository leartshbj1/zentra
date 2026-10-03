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
  external=0;identityReads=0;rows=[];nativeNonce=nonceA;held.length=0;localStorage.clear();sessionStorage.clear();
  account={status:'connected',organizationId:organization,organizationName:'Entreprise témoin',role:'owner'};
  identity=async()=>({memberId:memberA,memberContextNonce:nonceA});firstRevalidation=deferred();held.push(firstRevalidation);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('fetch',vi.fn(async()=>{external++;throw Error('External fetch forbidden in closed App proof.');}));
  vi.spyOn(desktopApi,'getCachedCloudAccountState').mockImplementation(async()=>structuredClone(account));
  vi.spyOn(desktopApi,'getCloudAccountState').mockImplementationOnce(()=>firstRevalidation.promise).mockImplementation(async()=>structuredClone(account));
  vi.spyOn(desktopApi,'getLicenseState').mockResolvedValue(license as never);vi.spyOn(desktopApi,'refreshLicense').mockResolvedValue(license as never);
  vi.spyOn(desktopApi,'resolveConnectedCompany').mockImplementation(async org=>({status:'ready',organizationId:org,changed:false}));
  vi.spyOn(desktopApi,'getCloudTeam').mockResolvedValue({organizationId:organization,organizationName:'Entreprise témoin',role:'owner',canManage:false,profile:null,members:[],invitations:[],seats:{planName:'Recette',limit:3,used:1,reserved:0,available:2,subscriptionActive:true}} as never);
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
      if(args?.expectedMemberContextNonce!==undefined&&args.expectedMemberContextNonce!==nativeNonce)throw 'Champ invalide : Le compte connecté a changé. Rouvrez cette action avec le bon compte.';
      return command==='get_app_state'?{onboarding_completed:true}:structuredClone(raw());
    }
    if(command==='create_record'&&args.entity==='clients'){
      expect(args.expectedWorkspaceScope).toBe(scope);expect(args.expectedMemberContextNonce).toBe(nativeNonce);rows.push(structuredClone(args.data));return structuredClone(args.data);
    }
    if(command==='automation_request'&&args?.data===null)return {organizationId:organization,active:false,canManage:false,available:[],settings:{enabled:false,consent:false,mode:'shadow',flags:[],thresholds:{medium:.5,high:.95}}};
    if(command==='append_diagnostic_events')return;
    throw Error('Native command outside closed App admission fixture: '+command);
  });
});
afterEach(async()=>{if(root)await reactAct(async()=>root!.unmount());root=undefined;host?.remove();for(const pending of held)pending.resolve({memberId:memberA,memberContextNonce:nonceA,...account});await settle();await setAppLanguage('fr');expect(external).toBe(0);expect((globalThis as any).__memberOriginImportRequests).toBe(0);vi.unstubAllGlobals();vi.restoreAllMocks();});

describe('actual App root member-context admission',()=>{
  it('admits a valid local native nonce while durable drafts retain local-user as owner',async()=>{
    account={status:'disconnected'};identity=async()=>({memberContextNonce:nonceA});await mount();await until(()=>document.querySelector('.desktop-app')!==null);
    expect(identityReads).toBe(1);await openClient();expect(draftOwner()).toEqual([scope,'','local-user']);await submit();await until(()=>document.querySelector('[role="dialog"] form')===null);
    const writes=transport.invoke.mock.calls.filter(([command])=>command==='create_record');expect(writes).toHaveLength(1);expect(writes[0][1].expectedMemberContextNonce).toBe(nonceA);
  });
  it('admits the verified cloud member only after the real company gate has resolved',async()=>{
    const company=deferred<any>();held.push(company);vi.mocked(desktopApi.resolveConnectedCompany).mockImplementation(()=>company.promise);await mount();await until(()=>vi.mocked(desktopApi.resolveConnectedCompany).mock.calls.length===1);
    expect(identityReads).toBe(0);expect(document.querySelector('.desktop-app')).toBeNull();await reactAct(async()=>company.resolve({status:'ready',organizationId:organization,changed:false}));
    await until(()=>document.querySelector('.desktop-app')!==null);await openClient();expect(draftOwner()).toEqual([scope,organization,memberA]);await submit();await until(()=>document.querySelector('[role="dialog"] form')===null);expect(rows).toHaveLength(1);
  });
  it('ignores a stale awaited identity after a real verified account callback changes the epoch',async()=>{
    await mount();await until(()=>document.querySelector('.desktop-app')!==null);const old=deferred<{memberId?:string;memberContextNonce?:string}>();held.push(old);
    identity=()=>old.promise;await reactAct(async()=>firstRevalidation.resolve(structuredClone(account)));await until(()=>identityReads>=2);
    identity=async()=>({memberId:memberB,memberContextNonce:nonceB});nativeNonce=nonceB;await click('Mon compte');await until(()=>identityReads>=3);await until(()=>document.querySelector('.desktop-app')!==null&&document.querySelector('.cloud-account-panel')===null);
    await openClient();expect(draftOwner()).toEqual([scope,organization,memberB]);const savedDraft=localStorage.getItem(draftKeys()[0]);await reactAct(async()=>old.resolve({memberId:memberA,memberContextNonce:nonceA}));await settle();
    expect(draftOwner()).toEqual([scope,organization,memberB]);expect(localStorage.getItem(draftKeys()[0])).toBe(savedDraft);await submit();await until(()=>document.querySelector('[role="dialog"] form')===null);
    const writes=transport.invoke.mock.calls.filter(([command])=>command==='create_record');expect(writes).toHaveLength(1);expect(writes[0][1].expectedMemberContextNonce).toBe(nonceB);
  });
  it.each([
    ['fr','Mettre Zentra à jour','Installez la dernière mise à jour'],
    ['de','Zentra aktualisieren','Installieren Sie das neueste Update'],
    ['it','Aggiorna Zentra','Installa l’ultimo aggiornamento'],
    ['en','Update Zentra','Install the latest update'],
  ] as const)('names missing native nonce as a version/update failure in %s and leaves writes closed',async(language,title,action)=>{
    const allowed=new Set(Object.values(languageAssets));vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{if(!allowed.has(String(input))){external++;throw Error('External language request forbidden.');}return {ok:true,json:async()=>({'QA local pack':'QA local pack'})} as Response;}));await setAppLanguage(language);
    identity=async()=>({memberId:memberA});await mount();await until(()=>document.querySelector('[data-draft-identity-failure="compatibility"]')!==null);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(title);expect(document.querySelector('[role="alert"]')?.textContent).toContain(action);expect(document.querySelector('.standalone-updater__launcher')).not.toBeNull();expect(button('Réessayer la vérification')).toBeUndefined();expect(document.querySelector('.desktop-app')).toBeNull();expect(button('Nouveau client')).toBeUndefined();
    expect(transport.invoke.mock.calls.some(([command])=>command==='create_record'||command==='update_record')).toBe(false);expect(draftKeys()).toHaveLength(0);
    expect(recentDiagnosticEvents().some(event=>event.operation==='identity.read'&&event.phase==='failure'&&event.errorCode==='CONFLICT')).toBe(true);
  });
  it.each([
    ['fr','Le compte utilisé pour cette action n’est plus disponible'],
    ['de','Das Konto dieser Aktion ist auf diesem Gerät nicht mehr verfügbar'],
    ['it','Il conto usato per questa azione non è più disponibile'],
    ['en','The account used for this action is no longer available'],
  ] as const)('keeps a malformed native context terminal and renders its canonical error in %s',async(language,message)=>{
    const allowed=new Set(Object.values(languageAssets));vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{if(!allowed.has(String(input))){external++;throw Error('External language request forbidden.');}return {ok:true,json:async()=>({'QA local pack':'QA local pack'})} as Response;}));await setAppLanguage(language);identity=async()=>({memberId:memberA,memberContextNonce:'invalid'});await mount();await until(()=>document.querySelector('[data-draft-identity-failure="context"]')!==null);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(message);expect(document.querySelector('.desktop-app')).toBeNull();expect(rows).toHaveLength(0);expect(transport.invoke.mock.calls.some(([command])=>command==='create_record'||command==='update_record')).toBe(false);
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
