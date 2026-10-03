// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost","pretendToBeVisual":true}
/** Actual candidate WorkspaceApp/EmployeeForm/bridge/recovery/ReactDOM. Native IPC
 * is explicitly simulated, including the guard after a held local operation; no auth/network requests.
 * Unrelated preview services are stubbed; no production/network/server access. */
import {act as reactAct,useState} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {desktopApi} from './bridge';
import {WorkspaceApp} from './WorkspaceApp';
import {FormDraftIdentityProvider,draftText} from './useFormDraft';
import {ZentraAssistantProvider} from './ZentraAssistant';
import {initialOnboardingSettings} from './onboardingDraft';
import {FORM_DRAFT_PREFIX} from './formDrafts';
import type {Workspace} from './types';
import {setAppLanguage} from './language';
import {employeeCreationRecovery} from './employeeCreationDraft';
import {languageAssets} from 'virtual:zentra-language-assets';

const transport=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({Channel:class{},invoke:transport.invoke,isTauri:()=>false}));
const scope='employee-durable-company',member='11111111-1111-4111-8111-111111111111',nonceA='a'.repeat(32),nonceB='b'.repeat(32);
const guardMessage='Champ invalide : Le compte connecté a changé. Rouvrez cette action avec le bon compte.';
function deferred<T=void>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>resolve=yes);return {promise,resolve};}
let root:Root|undefined,container:HTMLDivElement,workspace:Workspace,exposed:any;
let nativeNonce=nonceA,mode='',blocked=false,writeHold:ReturnType<typeof deferred>|null=null,readHold:ReturnType<typeof deferred>|null=null;
let writeEntered=false,readEntered=false,writes=0,employees:any[]=[],reads:any[]=[],publications:Workspace[]=[],externalRequests=0,writeAttempts:any[]=[],nativeScope=scope;
let beforeWrite:((args:any)=>void)|undefined;
const settings={...structuredClone(initialOnboardingSettings),organization:{...initialOnboardingSettings.organization,legalName:'Atelier témoin',contactName:'Compte témoin'}};
function rawWorkspace(){return {work_notes_scope:scope,settings:{company_name:'Atelier témoin',extra_settings_json:JSON.stringify(settings)},clients:[],projects:[],employees:structuredClone(employees),time_entries:[]};}
function enforce(args:any){if(args?.expectedWorkspaceScope!==undefined&&args.expectedWorkspaceScope!==nativeScope)throw 'Champ invalide : L’entreprise ouverte a changé. Rouvrez cette action dans le bon espace.';if(args?.expectedMemberContextNonce!==undefined&&args.expectedMemberContextNonce!==nativeNonce)throw guardMessage;}
async function settle(){await reactAct(async()=>{for(let i=0;i<25;i++)await Promise.resolve();await new Promise<void>(resolve=>setTimeout(resolve,1));});}
async function until(check:()=>boolean){for(let i=0;i<40&&!check();i++)await settle();expect(check()).toBe(true);}
const buttons=(text:string)=>Array.from(document.querySelectorAll<HTMLButtonElement>('button')).filter(node=>node.textContent?.trim()===text);

function expectSingleReadGuide() {
  expect(document.querySelector('[data-employee-storage-recovery]')).toBeNull();
  expect(buttons(draftText('Réessayer la sauvegarde locale'))).toHaveLength(0);
  const abandon=buttons(draftText('Abandonner le brouillon'));
  expect(abandon).toHaveLength(1);expect(abandon[0].disabled).toBe(true);
}
async function click(text:string){const button=buttons(text)[0];expect(button,document.body.textContent??'').toBeDefined();await reactAct(async()=>button.click());await settle();}
function draftKeys(){return Array.from({length:localStorage.length},(_,i)=>localStorage.key(i)!).filter(key=>key.startsWith(FORM_DRAFT_PREFIX));}
async function change(name:string,value:string,events=true){const input=document.querySelector<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>(`[role="dialog"] [name="${name}"]`)!;expect(input,name).not.toBeNull();await reactAct(async()=>{const prototype=input instanceof HTMLSelectElement?HTMLSelectElement.prototype:input instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value')!.set!.call(input,value);if(events){input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));}});await settle();}
async function openEmployee(){await click('Équipe & salaires');await click('Nouvelle fiche de personnel');await until(()=>document.querySelector('[role="dialog"] [name="name"]')!==null);}
async function prepareEmployee(){await openEmployee();await change('name','Alex Témoin');await change('role','Responsable de projet');await submit();await change('employmentRate','100');await change('salaryMode','monthly');await change('grossSalary','6000');await change('employmentContractKind','indefinite');await submit();expect(document.querySelector('[data-employee-step="2"]')?.hasAttribute('hidden')).toBe(false);expect(draftKeys()).toHaveLength(1);}
async function closeEmployee(){const button=document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label^="Fermer «"]');expect(button).not.toBeNull();await reactAct(async()=>button!.click());await settle();}
async function restoreEmployee(){await click('Nouvelle fiche de personnel');await until(()=>buttons(draftText('Reprendre ma saisie')).length>0);await click(draftText('Reprendre ma saisie'));}
function draftValue(){return JSON.parse(localStorage.getItem(draftKeys()[0])!).value as Record<string,string>;}
async function submit(){const form=document.querySelector<HTMLFormElement>('[role="dialog"] form')!;await reactAct(async()=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));await settle();}
function verifyNoRetirement(allowOriginalReadPublication=false){expect(draftKeys()).toHaveLength(1);if(!allowOriginalReadPublication)expect(publications).toHaveLength(0);else expect(publications.every(value=>value.workNotesScope===scope)).toBe(true);expect(document.body.textContent).not.toContain('Le collaborateur a été ajouté.');expect(document.querySelector('[role="dialog"] form')).not.toBeNull();}

beforeEach(async()=>{
  nativeScope=scope;nativeNonce=nonceA;beforeWrite=undefined;writeAttempts=[];mode='';blocked=false;writeHold=null;readHold=null;writeEntered=false;readEntered=false;writes=0;employees=[];reads=[];publications=[];externalRequests=0;localStorage.clear();sessionStorage.clear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('fetch',vi.fn(async()=>{externalRequests++;throw Error('External fetch is disabled in this closed fixture.');}));
  Object.defineProperty(window,'matchMedia',{value:vi.fn(()=>({matches:false,addEventListener:()=>{},removeEventListener:()=>{},addListener:()=>{},removeListener:()=>{}})),configurable:true});
  HTMLElement.prototype.scrollIntoView=()=>{};vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});
  transport.invoke.mockReset();transport.invoke.mockImplementation(async(command:string,args:any)=>{
    if(command==='get_app_state'||command==='get_workspace'){
      reads.push({command,args:structuredClone(args??{}),nonce:nativeNonce});if(readHold){readEntered=true;await readHold.promise;}enforce(args);if(blocked)throw Error('Lecture locale momentanément indisponible.');
      return command==='get_app_state'?{onboarding_completed:true}:rawWorkspace();
    }
    if(command==='create_record'&&args.entity==='employees'){
      writeAttempts.push(structuredClone(args));beforeWrite?.(args);
      if(writeHold){writeEntered=true;await writeHold.promise;}enforce(args);
      if(mode==='before-commit')throw Error('Écriture locale indisponible avant commit simulé.');
      employees.push({...structuredClone(args.data),country:args.data.country||'CH',created_at:'2026-10-03T10:00:00Z'});writes++;
      if(mode==='ack-member')nativeNonce=nonceB;
      if(mode==='lost'){blocked=true;throw Error('Réponse de création perdue après commit simulé.');}
      return structuredClone(args.data);
    }
    if(command==='update_record'&&args.entity==='employees'){enforce(args);const index=employees.findIndex(row=>row.id===args.id);expect(index).toBeGreaterThanOrEqual(0);employees[index]={...employees[index],...structuredClone(args.data)};writes++;return null;}
    throw Error('Native command outside this closed fixture: '+command);
  });
  // Read/write methods under test remain actual. Only unrelated background
  // preview services are stubbed, as in maintained mobile-harness defaults.
  vi.spyOn(desktopApi,'getCloudBackupState').mockResolvedValue({enabled:false,connected:false,backups:[]} as never);
  vi.spyOn(desktopApi,'getReminderSettings').mockResolvedValue({enabled:false,senderName:'',lastScanAt:''} as never);
  vi.spyOn(desktopApi,'listReminderTemplates').mockResolvedValue([]);vi.spyOn(desktopApi,'listReminders').mockResolvedValue([]);
  vi.spyOn(desktopApi,'getSecureUpdatePolicy').mockResolvedValue({enabled:false,reason:'Recette locale'} as never);
  vi.spyOn(desktopApi,'getProjectSyncStatus').mockResolvedValue({pending:0,syncing:false,connected:false,documents:[]} as never);
  vi.spyOn(desktopApi,'syncProjectDocuments').mockResolvedValue({pending:0,syncing:false,connected:false,documents:[]} as never);
  workspace=await desktopApi.loadWorkspace();reads=[];
  container=document.createElement('div');container.id='root';document.body.append(container);root=createRoot(container);
  function Host(){const [current,setCurrent]=useState(workspace);const [nonce,setNonce]=useState<string|undefined>(nonceA);exposed={setNonce,setCurrent};return <FormDraftIdentityProvider companyId={scope} organizationId="org-témoin" memberId={member} memberContextNonce={nonce} ready><ZentraAssistantProvider><WorkspaceApp workspace={current} setWorkspace={next=>{if(next&&typeof next!=='function'){publications.push(next);setCurrent(next);}}}/></ZentraAssistantProvider></FormDraftIdentityProvider>;}
  await reactAct(async()=>root!.render(<Host/>));await settle();
});
afterEach(async()=>{writeHold?.resolve(undefined);readHold?.resolve(undefined);if(root)await reactAct(async()=>root!.unmount());root=undefined;container?.remove();await setAppLanguage('fr');expect(externalRequests).toBe(0);expect((globalThis as any).__employeeDurableImportRequests).toBe(0);vi.unstubAllGlobals();vi.restoreAllMocks();});

describe('EmployeeV3 integration with the actual initial-read barrier',()=>{
  it.each(['draft','marker'])('finds the retained UUID after initial %s failure without overwriting or native write',async fault=>{
    await prepareEmployee();const key=draftKeys()[0],raw=localStorage.getItem(key)!,id=draftValue().creationId;await closeEmployee();
    const original=Storage.prototype.getItem;const failed=vi.spyOn(Storage.prototype,'getItem').mockImplementation(function(this:Storage,readKey){if(readKey===(fault==='draft'?key:key.replace('.drafts.','.completed.')))throw Error('Initial read denied');return original.call(this,readKey);});
    await click('Nouvelle fiche de personnel');await until(()=>document.querySelector('[role="dialog"] [name="name"]')!==null);
    expect(buttons(draftText('Relire les brouillons locaux'))).toHaveLength(1);expectSingleReadGuide();expect(document.querySelector('[role="dialog"] .form-draft-notice')).not.toBeNull();await change('name','Fresh name during refused read');await click(draftText('Relire les brouillons locaux'));expect(original.call(localStorage,key)).toBe(raw);expect(writeAttempts).toHaveLength(0);
    failed.mockRestore();await click(draftText('Relire les brouillons locaux'));expect(buttons(draftText('Reprendre ma saisie'))).toHaveLength(1);expect(writeAttempts).toHaveLength(0);expect(draftValue().creationId).toBe(id);await click(draftText('Reprendre ma saisie'));expect(document.querySelector<HTMLInputElement>('[name="grossSalary"]')!.value).toBe('6000');expect(draftValue().creationId).toBe(id);await submit();await until(()=>writes===1);expect(employees[0].id).toBe(id);expect(draftKeys()).toHaveLength(0);
  });
  it.each(['fr','de','it','en'] as const)('keeps immediate clean reread visible in %s despite the custom employee storage guide',async language=>{
    const allowed=new Set(Object.values(languageAssets));vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{if(!allowed.has(String(input))){externalRequests++;throw Error('External request forbidden.');}return {ok:true,json:async()=>({'QA local pack':'QA local pack'})} as Response;}));
    const original=Storage.prototype.getItem;const failed=vi.spyOn(Storage.prototype,'getItem').mockImplementation(function(this:Storage,key){if(key.startsWith(FORM_DRAFT_PREFIX)||key.startsWith('zentra.forms.completed.v1.'))throw Error('Initial read denied');return original.call(this,key);});await openEmployee();await reactAct(async()=>{await setAppLanguage(language);});
    expect(buttons(draftText('Relire les brouillons locaux'))).toHaveLength(1);expectSingleReadGuide();expect(document.querySelector('[role="dialog"] .form-draft-notice')?.textContent).toContain(draftText('Les brouillons locaux doivent être relus'));expect(writeAttempts).toHaveLength(0);await click(draftText('Relire les brouillons locaux'));expect(writeAttempts).toHaveLength(0);failed.mockRestore();await click(draftText('Relire les brouillons locaux'));expect(buttons(draftText('Relire les brouillons locaux'))).toHaveLength(0);expect(draftKeys()).toHaveLength(0);await change('name','Explicit edit after pure reread');expect(draftValue().creationId).toMatch(/^[a-f\d-]{36}$/i);expect(writeAttempts).toHaveLength(0);
  });

  it.each(['draft','marker'])('clears a refused-save storage sentinel after explicit restore following %s refusal',async fault=>{
    await prepareEmployee();const key=draftKeys()[0],raw=localStorage.getItem(key)!,id=draftValue().creationId;await closeEmployee();
    const original=Storage.prototype.getItem;const failed=vi.spyOn(Storage.prototype,'getItem').mockImplementation(function(this:Storage,readKey){if(readKey===(fault==='draft'?key:key.replace('.drafts.','.completed.')))throw Error('Initial read denied');return original.call(this,readKey);});
    await openEmployee();await change('name','Fresh name during refused read');await change('role','Responsible');await submit();
    await change('employmentRate','100');await change('salaryMode','monthly');await change('grossSalary','6000');await change('employmentContractKind','indefinite');await submit();await submit();
    expect(original.call(localStorage,key)).toBe(raw);expect(writeAttempts).toHaveLength(0);
    failed.mockRestore();await click(draftText('Relire les brouillons locaux'));expect(buttons(draftText('Reprendre ma saisie'))).toHaveLength(1);await click(draftText('Reprendre ma saisie'));
    expect(draftValue().creationId).toBe(id);expect(document.querySelector<HTMLInputElement>('[name="grossSalary"]')!.value).toBe('6000');
    expect(document.querySelector('[data-employee-storage-recovery]')).toBeNull();expect(buttons(draftText('Réessayer la sauvegarde locale'))).toHaveLength(0);expect(writeAttempts).toHaveLength(0);
    await submit();await until(()=>writes===1);expect(employees[0].id).toBe(id);expect(draftKeys()).toHaveLength(0);
  });
});
vi.hoisted(()=>{
  (globalThis as any).__employeeDurableImportRequests=0;
  Object.defineProperty(window,'matchMedia',{configurable:true,value:()=>({matches:false,addEventListener:()=>{},removeEventListener:()=>{},addListener:()=>{},removeListener:()=>{}})});
  HTMLElement.prototype.scrollIntoView=()=>{};window.scrollTo=()=>{};
  (globalThis as any).ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};
  globalThis.fetch=async()=>{(globalThis as any).__employeeDurableImportRequests++;throw Error('External fetch forbidden during maintained employee-durable test import.');};
});
