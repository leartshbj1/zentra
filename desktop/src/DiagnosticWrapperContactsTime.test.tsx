import {diagnosticsApi,recentDiagnosticEvents} from './diagnostics';
// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost","pretendToBeVisual":true}
/** Real WorkspaceApp.act, ContactForms/WorkTimeForms, identity provider, draft
 * hook/core, bridge and recovery. Only closed IPC, Storage and unrelated
 * background services are fixtures. No action, hook, bridge or provider doubles.
 * This does not certify native persistence or multi-device delivery. */
import {act as reactAct,useState} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {desktopApi} from './bridge';
import {WorkspaceApp} from './WorkspaceApp';
import {FormDraftIdentityProvider,draftText} from './useFormDraft';
import {ZentraAssistantProvider} from './ZentraAssistant';
import {initialOnboardingSettings} from './onboardingDraft';
import {FORM_DRAFT_PREFIX,FORM_DRAFT_COMPLETED_PREFIX,formDraftKey,formDraftFingerprint} from './formDrafts';
import type {Workspace} from './types';
import {setAppLanguage} from './language';
import {languageAssets} from 'virtual:zentra-language-assets';

const ipc=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({Channel:class{},invoke:ipc.invoke,isTauri:()=>false}));
const scope='initial-read-synthetic-company',member='11111111-1111-4111-8111-111111111111',nonce='a'.repeat(32),oldId='22222222-2222-4222-8222-222222222222';
class FaultStorage implements Storage {
  rows=new Map<string,string>();denied=new Set<string>();writes:string[]=[];removes:string[]=[];refuseRemove=false;
  get length(){return this.rows.size;}key(index:number){return [...this.rows.keys()][index]??null;}
  clear(){this.rows.clear();}getItem(key:string){if(this.denied.has(key))throw Error('Initial draft read denied');return this.rows.get(key)??null;}
  setItem(key:string,value:string){this.writes.push(key);this.rows.set(key,value);}removeItem(key:string){this.removes.push(key);if(this.refuseRemove&&key.startsWith(FORM_DRAFT_PREFIX))throw Error('Draft removal denied');this.rows.delete(key);}
}
let lostReply=false,blockedRead=false;
let storage:FaultStorage,root:Root|undefined,container:HTMLElement,workspace:Workspace,writes:number,externalRequests:number,clients:any[],suppliers:any[],timeEntries:any[],publications:Workspace[];
const settings={...structuredClone(initialOnboardingSettings),organization:{...initialOnboardingSettings.organization,legalName:'Entreprise témoin',contactName:'Compte témoin'}};
function rawWorkspace(){return {work_notes_scope:scope,settings:{company_name:'Entreprise témoin',extra_settings_json:JSON.stringify(settings)},clients:structuredClone(clients),suppliers:structuredClone(suppliers),employees:[{id:'employee-1',name:'Alice Témoin',active:1,hourly_cost_cents:4500}],projects:[{id:'project-1',name:'Projet témoin',status:'active'}],time_entries:structuredClone(timeEntries)};}
function Host(){const [current,setCurrent]=useState(workspace);return <FormDraftIdentityProvider companyId={scope} organizationId="org-synthetic" memberId={member} memberContextNonce={nonce} ready><ZentraAssistantProvider><WorkspaceApp workspace={current} setWorkspace={next=>{if(next&&typeof next!=='function'){publications.push(next);setCurrent(next);}}}/></ZentraAssistantProvider></FormDraftIdentityProvider>;}
async function settle(){await reactAct(async()=>{for(let i=0;i<20;i++)await Promise.resolve();await new Promise<void>(done=>setTimeout(done,1));});}
const buttons=(text:string)=>Array.from(document.querySelectorAll<HTMLButtonElement>('button')).filter(button=>button.textContent?.trim()===text);
async function click(text:string){const button=buttons(text)[0];expect(button,document.body.textContent??'').toBeDefined();expect(button.disabled).toBe(false);await reactAct(async()=>button.click());await settle();}
async function until(check:()=>boolean){for(let i=0;i<45&&!check();i++)await settle();expect(check(),document.body.textContent??'').toBe(true);}
function field(name:string){const node=document.querySelector<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>(`[role="dialog"] [name="${name}"]`);expect(node,name).not.toBeNull();return node!;}
async function change(name:string,value:string,dispatch=true){const node=field(name);await reactAct(async()=>{const prototype=node instanceof HTMLSelectElement?HTMLSelectElement.prototype:node instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value')!.set!.call(node,value);if(dispatch){node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));}});await settle();}
function ownKey(type='client'){return formDraftKey({companyId:scope,organizationId:'org-synthetic',memberId:member,type});}
function seed(type='client',ack=false){const key=ownKey(type);const value=type==='supplier'?{creationId:oldId,name:'Fournisseur précédent',contactName:'',email:'supplier@example.test',phone:'',address:'Rue témoin 7',uidNumber:'',iban:'',paymentTermsDays:'30',notes:'Notes conservées'}:{creationId:oldId,contactPerson:'Alice Précédente',company:'Client précédent',email:'alice@example.test',phone:'',street:'Rue témoin',buildingNumber:'7',postalCode:'1201',city:'Genève',canton:'GE',country:'CH',notes:'Notes conservées'};const raw=JSON.stringify({version:1,scope:key,fingerprint:'new',savedAt:Date.now(),value});storage.rows.set(key,raw);if(ack)storage.rows.set(key.replace(FORM_DRAFT_PREFIX,FORM_DRAFT_COMPLETED_PREFIX),JSON.stringify({version:1,savedAt:Date.now(),recordFingerprint:formDraftFingerprint(raw)}));return {key,raw,value};}
async function openClient(){await click('Clients');await click('Nouveau client');await until(()=>document.querySelector('[role="dialog"] [name="contactPerson"]')!==null);}
async function openSupplier(){await click('Achats & fournisseurs');await click('Ajouter le fournisseur');await reactAct(async()=>{await vi.dynamicImportSettled();});await until(()=>document.querySelector('[role="dialog"] [name="name"]')!==null);}
async function openTime(){await click('Temps');await click('Saisir des heures');await until(()=>document.querySelector('[role="dialog"] [name="hours"]')!==null);}
function seedValues(type:string,value:Record<string,string>){const key=ownKey(type),raw=JSON.stringify({version:1,scope:key,fingerprint:'new',savedAt:Date.now(),value});storage.rows.set(key,raw);return {key,raw,value};}
async function fillClient(dispatch=true){for(const [name,value] of Object.entries({company:'Nouveau client',street:'Autre rue',postalCode:'1202',city:'Genève',country:'CH'}))await change(name,value,dispatch);}
async function submit(){await reactAct(async()=>document.querySelector<HTMLFormElement>('[role="dialog"] form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));await settle();}
beforeEach(async()=>{
  lostReply=false;blockedRead=false;storage=new FaultStorage();writes=0;externalRequests=0;clients=[];suppliers=[];timeEntries=[];publications=[];sessionStorage.clear();vi.stubGlobal('localStorage',storage);vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  const allowed=new Set(Object.values(languageAssets));vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{if(!allowed.has(String(input))){externalRequests++;throw Error('External request forbidden.');}return {ok:true,json:async()=>({'QA local pack':'QA local pack'})} as Response;}));
  Object.defineProperty(window,'matchMedia',{value:()=>({matches:false,addEventListener:()=>{},removeEventListener:()=>{},addListener:()=>{},removeListener:()=>{}}),configurable:true});HTMLElement.prototype.scrollIntoView=()=>{};vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});
  ipc.invoke.mockReset();ipc.invoke.mockImplementation(async(command:string,args:any)=>{
    if(args?.expectedWorkspaceScope!==undefined)expect(args.expectedWorkspaceScope).toBe(scope);if(args?.expectedMemberContextNonce!==undefined)expect(args.expectedMemberContextNonce).toBe(nonce);
    if(command==='clear_diagnostics')return null;
    if(blockedRead&&(command==='get_app_state'||command==='get_workspace'))throw Error('network timeout subsequent read private-fixture');
    if(command==='get_app_state')return {onboarding_completed:true};if(command==='get_workspace')return rawWorkspace();
    if(command==='create_record'){expect(['clients','suppliers','time_entries']).toContain(args.entity);const rows=args.entity==='clients'?clients:args.entity==='suppliers'?suppliers:timeEntries;rows.push({...structuredClone(args.data),country:args.data.country||'CH',created_at:'2026-10-03T12:00:00Z'});writes++;if(lostReply){blockedRead=true;throw Error('network timeout after contact-time commit private-fixture');}return structuredClone(args.data);}
    throw Error('Command outside the closed draft fixture: '+command);
  });
  vi.spyOn(desktopApi,'getCloudBackupState').mockResolvedValue({enabled:false,connected:false,backups:[]} as never);vi.spyOn(desktopApi,'getReminderSettings').mockResolvedValue({enabled:false,senderName:'',lastScanAt:''} as never);vi.spyOn(desktopApi,'listReminderTemplates').mockResolvedValue([]);vi.spyOn(desktopApi,'listReminders').mockResolvedValue([]);vi.spyOn(desktopApi,'getSecureUpdatePolicy').mockResolvedValue({enabled:false,reason:'Closed fixture'} as never);vi.spyOn(desktopApi,'getProjectSyncStatus').mockResolvedValue({pending:0,syncing:false,connected:false,documents:[]} as never);vi.spyOn(desktopApi,'syncProjectDocuments').mockResolvedValue({pending:0,syncing:false,connected:false,documents:[]} as never);
  await diagnosticsApi.clear();workspace=await desktopApi.loadWorkspace();container=document.createElement('div');container.id='root';document.body.append(container);root=createRoot(container);await reactAct(async()=>root!.render(<Host/>));await settle();
});
afterEach(async()=>{if(root)await reactAct(async()=>root!.unmount());root=undefined;container?.remove();await setAppLanguage('fr');expect(externalRequests).toBe(0);expect((globalThis as any).__initialReadImportRequests||0).toBe(0);vi.unstubAllGlobals();vi.restoreAllMocks();});
const failedCommand=(operation:string)=>recentDiagnosticEvents().filter(event=>event.operation===operation&&event.phase==='failure').at(-1)!;
const operationByKind={client:'record.client.create',supplier:'record.supplier.create',time:'record.time_entry.create'} as const;
describe('real contact and time source guides with WorkspaceApp.act and closed IPC',()=>{
 it.each((['client','supplier','time'] as const).flatMap(kind=>(['fr','de','it','en'] as const).map(language=>[kind,language] as const)))('retains the source code, durable fields and no-replay behavior for %s in %s',async(kind,language)=>{
  if(kind==='client'){await openClient();await fillClient();}else if(kind==='supplier'){await openSupplier();await change('name','Fournisseur privé témoin');}else{await openTime();await change('projectId','project-1');await change('employeeId','employee-1');await change('hours','2');await change('billable','yes');await change('billingRate','110');await change('costRate','45');}
  await reactAct(async()=>{await setAppLanguage(language);});const key=ownKey(kind),before=JSON.parse(storage.getItem(key)!).value;lostReply=true;await submit();const failure=failedCommand(operationByKind[kind]);expect(failure).toBeDefined();expect(failure.errorCode).toBe('NETWORK');const selector=kind==='time'?'[data-time-creation-recovery]':'[data-contact-creation-recovery]',guide=document.querySelector(selector)!;expect(guide).not.toBeNull();expect(guide.parentElement?.querySelector('code')?.textContent).toBe('ZT-'+failure.id);expect(writes).toBe(1);expect(publications).toHaveLength(0);expect(JSON.parse(storage.getItem(key)!).value).toEqual(before);expect(buttons('Vérifier maintenant')).toHaveLength(0);expect(ipc.invoke.mock.calls.filter(([cmd])=>cmd==='create_record')).toHaveLength(1);
  const journal=JSON.stringify(recentDiagnosticEvents());for(const value of [scope,member,nonce,'Fournisseur privé témoin','network timeout after contact-time commit private-fixture'])expect(journal).not.toContain(value);
 });
});
vi.hoisted(()=>{
  (globalThis as any).__initialReadImportRequests=0;Object.defineProperty(window,'matchMedia',{configurable:true,value:()=>({matches:false,addEventListener:()=>{},removeEventListener:()=>{},addListener:()=>{},removeListener:()=>{}})});HTMLElement.prototype.scrollIntoView=()=>{};window.scrollTo=()=>{};(globalThis as any).ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};globalThis.fetch=async()=>{(globalThis as any).__initialReadImportRequests++;throw Error('External fetch forbidden during initial-read test imports.');};
});
