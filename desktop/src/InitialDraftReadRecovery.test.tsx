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
async function openSupplier(){await click('Achats & fournisseurs');await click('Ajouter le fournisseur');await until(()=>document.querySelector('[role="dialog"] [name="name"]')!==null);}
async function openTime(){await click('Temps');await click('Saisir des heures');await until(()=>document.querySelector('[role="dialog"] [name="hours"]')!==null);}
function seedValues(type:string,value:Record<string,string>){const key=ownKey(type),raw=JSON.stringify({version:1,scope:key,fingerprint:'new',savedAt:Date.now(),value});storage.rows.set(key,raw);return {key,raw,value};}
async function fillClient(dispatch=true){for(const [name,value] of Object.entries({company:'Nouveau client',street:'Autre rue',postalCode:'1202',city:'Genève',country:'CH'}))await change(name,value,dispatch);}
async function submit(){await reactAct(async()=>document.querySelector<HTMLFormElement>('[role="dialog"] form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));await settle();}
beforeEach(async()=>{
  storage=new FaultStorage();writes=0;externalRequests=0;clients=[];suppliers=[];timeEntries=[];publications=[];sessionStorage.clear();vi.stubGlobal('localStorage',storage);vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  const allowed=new Set(Object.values(languageAssets));vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{if(!allowed.has(String(input))){externalRequests++;throw Error('External request forbidden.');}return {ok:true,json:async()=>({'QA local pack':'QA local pack'})} as Response;}));
  Object.defineProperty(window,'matchMedia',{value:()=>({matches:false,addEventListener:()=>{},removeEventListener:()=>{},addListener:()=>{},removeListener:()=>{}}),configurable:true});HTMLElement.prototype.scrollIntoView=()=>{};vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});
  ipc.invoke.mockReset();ipc.invoke.mockImplementation(async(command:string,args:any)=>{
    if(args?.expectedWorkspaceScope!==undefined)expect(args.expectedWorkspaceScope).toBe(scope);if(args?.expectedMemberContextNonce!==undefined)expect(args.expectedMemberContextNonce).toBe(nonce);
    if(command==='get_app_state')return {onboarding_completed:true};if(command==='get_workspace')return rawWorkspace();
    if(command==='create_record'){expect(['clients','suppliers','time_entries']).toContain(args.entity);const rows=args.entity==='clients'?clients:args.entity==='suppliers'?suppliers:timeEntries;rows.push({...structuredClone(args.data),country:args.data.country||'CH',created_at:'2026-10-03T12:00:00Z'});writes++;return structuredClone(args.data);}
    throw Error('Command outside the closed draft fixture: '+command);
  });
  vi.spyOn(desktopApi,'getCloudBackupState').mockResolvedValue({enabled:false,connected:false,backups:[]} as never);vi.spyOn(desktopApi,'getReminderSettings').mockResolvedValue({enabled:false,senderName:'',lastScanAt:''} as never);vi.spyOn(desktopApi,'listReminderTemplates').mockResolvedValue([]);vi.spyOn(desktopApi,'listReminders').mockResolvedValue([]);vi.spyOn(desktopApi,'getSecureUpdatePolicy').mockResolvedValue({enabled:false,reason:'Closed fixture'} as never);vi.spyOn(desktopApi,'getProjectSyncStatus').mockResolvedValue({pending:0,syncing:false,connected:false,documents:[]} as never);vi.spyOn(desktopApi,'syncProjectDocuments').mockResolvedValue({pending:0,syncing:false,connected:false,documents:[]} as never);
  workspace=await desktopApi.loadWorkspace();container=document.createElement('div');container.id='root';document.body.append(container);root=createRoot(container);await reactAct(async()=>root!.render(<Host/>));await settle();
});
afterEach(async()=>{if(root)await reactAct(async()=>root!.unmount());root=undefined;container?.remove();await setAppLanguage('fr');expect(externalRequests).toBe(0);expect((globalThis as any).__initialReadImportRequests||0).toBe(0);vi.unstubAllGlobals();vi.restoreAllMocks();});
describe('real creation forms during unknown initial local reads',()=>{
  it.each(['fr','de','it','en'] as const)('offers a real immediate local reread while clean in %s',async language=>{
    const f=seed();storage.denied.add(f.key);await openClient();await reactAct(async()=>{await setAppLanguage(language);});
    expect(document.querySelector('[role="dialog"] .form-draft-notice')?.textContent).toContain(draftText('Les brouillons locaux doivent être relus'));expect(buttons(draftText('Relire les brouillons locaux'))).toHaveLength(1);expect(buttons(draftText('Abandonner le brouillon'))[0].disabled).toBe(true);
    await click(draftText('Relire les brouillons locaux'));expect(storage.rows.get(f.key)).toBe(f.raw);expect(writes).toBe(0);
    storage.denied.clear();await click(draftText('Relire les brouillons locaux'));expect(buttons(draftText('Reprendre ma saisie'))).toHaveLength(1);expect(buttons(draftText('Relire les brouillons locaux'))).toHaveLength(0);expect(storage.rows.get(f.key)).toBe(f.raw);expect(writes).toBe(0);
    await click(draftText('Reprendre ma saisie'));expect(field('company').value).toBe('Client précédent');expect(storage.rows.get(f.key)).toBe(f.raw);
    await submit();await until(()=>writes===1);expect(clients[0].id).toBe(oldId);expect(storage.rows.has(f.key)).toBe(false);expect(publications).toHaveLength(1);
  });
  it.each(['draft','marker'])('preserves the old client while repeated custom captures fail (%s)',async fault=>{
    const f=seed();storage.denied.add(fault==='draft'?f.key:f.key.replace(FORM_DRAFT_PREFIX,FORM_DRAFT_COMPLETED_PREFIX));await openClient();await fillClient();
    expect(storage.rows.get(f.key)).toBe(f.raw);expect(writes).toBe(0);expect(buttons('Enregistrer')[0].disabled).toBe(true);
    await submit();expect(document.querySelector('[data-contact-storage-recovery]')).not.toBeNull();expect(writes).toBe(0);
    storage.denied.clear();await click(draftText('Réessayer la sauvegarde locale'));expect(buttons(draftText('Reprendre ma saisie'))).toHaveLength(1);expect(writes).toBe(0);expect(storage.rows.get(f.key)).toBe(f.raw);
    await click(draftText('Reprendre ma saisie'));await submit();await until(()=>writes===1);expect(clients[0].id).toBe(oldId);
  });
  it('recovers an unknown supplier through its actual uncontrolled/controlled adapter before native creation',async()=>{
    const f=seed('supplier');storage.denied.add(f.key);await openSupplier();await change('name','Fresh supplier');await change('paymentTermsDays','60');expect(storage.rows.get(f.key)).toBe(f.raw);expect(writes).toBe(0);
    storage.denied.clear();await click(draftText('Relire les brouillons locaux'));await click(draftText('Reprendre ma saisie'));expect(field('name').value).toBe('Fournisseur précédent');expect(field('paymentTermsDays').value).toBe('30');await submit();await until(()=>writes===1);expect(suppliers[0].id).toBe(oldId);expect(suppliers[0].payment_terms_days).toBe(30);
  });
  it('keeps the fresh client UUID and last unrendered fields after a confirmed empty reread',async()=>{
    const key=ownKey();storage.denied.add(key);await openClient();await fillClient();expect(storage.rows.has(key)).toBe(false);expect(writes).toBe(0);await submit();
    storage.denied.clear();await change('company','Final field without a change event',false);await click(draftText('Réessayer la sauvegarde locale'));const captured=JSON.parse(storage.rows.get(key)!).value;expect(captured.company).toBe('Final field without a change event');expect(captured.creationId).toMatch(/^[a-f\d-]{36}$/i);
    await submit();await until(()=>writes===1);expect(clients[0].id).toBe(captured.creationId);expect(clients[0].company).toBe(captured.company);
  });
  it('does not offer a discovered ACK as a draft or replay it; only verified abandon closes creation',async()=>{
    const f=seed('client',true);storage.denied.add(f.key);await openClient();storage.denied.clear();await click(draftText('Relire les brouillons locaux'));
    expect(buttons(draftText('Reprendre ma saisie'))).toHaveLength(0);expect(buttons('Enregistrer')[0].disabled).toBe(true);await submit();expect(writes).toBe(0);expect(storage.rows.get(f.key)).toBe(f.raw);
    vi.spyOn(window,'confirm').mockReturnValue(true);storage.refuseRemove=true;await click(draftText('Abandonner le brouillon'));expect(document.querySelector('[role="dialog"] form')).not.toBeNull();expect(storage.rows.get(f.key)).toBe(f.raw);expect(writes).toBe(0);
    storage.refuseRemove=false;await click(draftText('Abandonner le brouillon'));await until(()=>document.querySelector('[role="dialog"] form')===null);expect(storage.rows.has(f.key)).toBe(false);expect(writes).toBe(0);
  });
  it.each(['draft','marker'])('preserves the controlled manual time UUID and fields across initial %s failure',async fault=>{
    const value={creationId:oldId,projectId:'project-1',employeeId:'employee-1',taskId:'',date:'2026-10-03',hours:'2',minutes:'15',breakMinutes:'0',billable:'yes',billingRate:'110.00',costRate:'45.00',status:'approved',note:'Previous controlled time entry'};
    const f=seedValues('time',value);storage.denied.add(fault==='draft'?f.key:f.key.replace(FORM_DRAFT_PREFIX,FORM_DRAFT_COMPLETED_PREFIX));await openTime();await change('hours','7');expect(storage.rows.get(f.key)).toBe(f.raw);await submit();expect(writes).toBe(0);
    storage.denied.clear();await click(draftText('Relire les brouillons locaux'));expect(buttons(draftText('Reprendre ma saisie'))).toHaveLength(1);expect(writes).toBe(0);await click(draftText('Reprendre ma saisie'));expect(field('hours').value).toBe('2');expect(field('note').value).toBe(value.note);
    await submit();await until(()=>writes===1);expect(timeEntries[0].id).toBe(oldId);expect(timeEntries[0].minutes).toBe(135);expect(storage.rows.has(f.key)).toBe(false);
  });
  it('retains the active employee draft during initial read refusal and restores controlled salary without IPC',async()=>{
    // d44 Employee creation has no durable UUID yet. This test proves the read
    // barrier/adapter only; the separate EmployeeV3 candidate owns that defect.
    const f=seedValues('employee',{name:'Collaboratrice précédente',grossSalary:'5100',salaryMode:'monthly',employmentContractKind:'indefinite',draftStep:'1',draftDeferAnnual:'false'});storage.denied.add(f.key);
    await click('Équipe & salaires');await click('Nouvelle fiche de personnel');await until(()=>document.querySelector('[role="dialog"] [name="name"]')!==null);await change('name','Nouveau nom provisoire');expect(storage.rows.get(f.key)).toBe(f.raw);expect(writes).toBe(0);
    storage.denied.clear();await click(draftText('Relire les brouillons locaux'));expect(buttons(draftText('Reprendre ma saisie'))).toHaveLength(1);await click(draftText('Reprendre ma saisie'));expect(field('name').value).toBe('Collaboratrice précédente');expect(field('grossSalary').value).toBe('5100');expect(field('salaryMode').value).toBe('monthly');expect(storage.rows.get(f.key)).toBe(f.raw);expect(writes).toBe(0);
  });
});
vi.hoisted(()=>{
  (globalThis as any).__initialReadImportRequests=0;Object.defineProperty(window,'matchMedia',{configurable:true,value:()=>({matches:false,addEventListener:()=>{},removeEventListener:()=>{},addListener:()=>{},removeListener:()=>{}})});HTMLElement.prototype.scrollIntoView=()=>{};window.scrollTo=()=>{};(globalThis as any).ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};globalThis.fetch=async()=>{(globalThis as any).__initialReadImportRequests++;throw Error('External fetch forbidden during initial-read test imports.');};
});
