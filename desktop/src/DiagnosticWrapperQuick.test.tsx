import {diagnosticsApi,recentDiagnosticEvents} from './diagnostics';
// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost","pretendToBeVisual":true}
/** Actual candidate WorkspaceApp/DocumentEditor/quick-client/bridge/recovery/ReactDOM. Native IPC
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
import {languageAssets} from 'virtual:zentra-language-assets';
import {quickClientCreationRecovery} from './documentQuickClientDraft';
import {documentTotals} from './utils';

const transport=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({Channel:class{},invoke:transport.invoke,isTauri:()=>false}));
const scope='quick-client-durable-company',member='11111111-1111-4111-8111-111111111111',nonceA='a'.repeat(32),nonceB='b'.repeat(32);
const guardMessage='Champ invalide : Le compte connecté a changé. Rouvrez cette action avec le bon compte.';
function deferred<T=void>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>resolve=yes);return {promise,resolve};}
let root:Root|undefined,container:HTMLDivElement,workspace:Workspace,exposed:any;
let nativeNonce=nonceA,mode='',blocked=false,writeHold:ReturnType<typeof deferred>|null=null,readHold:ReturnType<typeof deferred>|null=null;
let writeEntered=false,readEntered=false,writes=0,clients:any[]=[],quotes:any[]=[],projects:any[]=[],quoteItems:any[]=[],reads:any[]=[],publications:Workspace[]=[],externalRequests=0,writeAttempts:any[]=[],nativeScope=scope;
let beforeWrite:((args:any)=>void)|undefined;
const settings={...structuredClone(initialOnboardingSettings),organization:{...initialOnboardingSettings.organization,legalName:'Atelier témoin',contactName:'Compte témoin'}};
function rawWorkspace(){return {work_notes_scope:scope,settings:{company_name:'Atelier témoin',extra_settings_json:JSON.stringify(settings)},projects:structuredClone(projects),quotes:structuredClone(quotes),quote_items:structuredClone(quoteItems),clients:structuredClone(clients),time_entries:[]};}
function enforce(args:any){if(args?.expectedWorkspaceScope!==undefined&&args.expectedWorkspaceScope!==nativeScope)throw 'Champ invalide : L’entreprise ouverte a changé. Rouvrez cette action dans le bon espace.';if(args?.expectedMemberContextNonce!==undefined&&args.expectedMemberContextNonce!==nativeNonce)throw guardMessage;}
async function settle(){await reactAct(async()=>{for(let i=0;i<25;i++)await Promise.resolve();await new Promise<void>(resolve=>setTimeout(resolve,1));});}
async function until(check:()=>boolean){for(let i=0;i<40&&!check();i++)await settle();expect(check()).toBe(true);}
const buttons=(text:string)=>Array.from(document.querySelectorAll<HTMLButtonElement>('button')).filter(node=>node.textContent?.trim()===text);
async function click(text:string){const button=buttons(text)[0];expect(button,document.body.textContent??'').toBeDefined();await reactAct(async()=>button.click());await settle();}
function draftKeys(){return Array.from({length:localStorage.length},(_,i)=>localStorage.key(i)!).filter(key=>key.startsWith(FORM_DRAFT_PREFIX));}
async function change(name:string,value:string,events=true){const input=document.querySelector<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>(`[role="dialog"] [name="${name}"]`)!;expect(input,name).not.toBeNull();await reactAct(async()=>{const prototype=input instanceof HTMLSelectElement?HTMLSelectElement.prototype:input instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value')!.set!.call(input,value);if(events){input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));}});await settle();}
async function openDocument(entity:'quotes'|'invoices'='quotes'){await click('Ventes');if(entity==='invoices')await click('Factures');await click(entity==='quotes'?'Nouveau devis':'Nouvelle facture');await reactAct(async()=>{await vi.dynamicImportSettled();});await until(()=>document.querySelector('[role="dialog"] [name="title"]')!==null);}
const quickNames=['contactPerson','company','email','phone','street','buildingNumber','postalCode','city','canton','country'];
async function quickChange(name:string,value:string,events=true){const section=document.querySelector('[role="dialog"] .document-inline-card')!;const input=Array.from(section.querySelectorAll<HTMLInputElement>('input'))[quickNames.indexOf(name)];expect(input,name).toBeDefined();await reactAct(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);if(events){input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));}});await settle();}
async function prepareQuick(entity:'quotes'|'invoices'='quotes'){await openDocument(entity);await change('title','Travaux témoins');await click('Nouveau contact');for(const [name,value] of Object.entries({contactPerson:'Alice Témoin',company:'Client Témoin SA',email:'alice@example.test',phone:'+41220000000',street:'Rue témoin',buildingNumber:'7',postalCode:'1201',city:'Genève',canton:'GE',country:'CH'}))await quickChange(name,value);expect(draftKeys()).toHaveLength(1);}
async function closeDocument(){const button=document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label^="Fermer «"]');expect(button).not.toBeNull();await reactAct(async()=>button!.click());await settle();}
async function restoreDocument(){await click('Nouveau devis');await until(()=>buttons(draftText('Reprendre ma saisie')).length>0);await click(draftText('Reprendre ma saisie'));}
function draftValue(){return JSON.parse(localStorage.getItem(draftKeys()[0])!).value as any;}
async function addQuick(){await click('Ajouter et sélectionner');}
function verifyRetained(){expect(draftKeys()).toHaveLength(1);expect(document.querySelector('[role="dialog"] form')).not.toBeNull();expect(document.body.textContent).not.toContain('a été ajouté et sélectionné.');}
function Host(){const [current,setCurrent]=useState(workspace);const [nonce,setNonce]=useState<string|undefined>(nonceA);exposed={setNonce,setCurrent};return <FormDraftIdentityProvider companyId={scope} organizationId="org-témoin" memberId={member} memberContextNonce={nonce} ready><ZentraAssistantProvider><WorkspaceApp workspace={current} setWorkspace={next=>{if(next&&typeof next!=='function'){publications.push(next);setCurrent(next);}}}/></ZentraAssistantProvider></FormDraftIdentityProvider>;}
async function restart(){await reactAct(async()=>root!.unmount());root=undefined;container.remove();blocked=false;mode='';workspace=await desktopApi.loadWorkspace();container=document.createElement('div');container.id='root';document.body.append(container);root=createRoot(container);await reactAct(async()=>root!.render(<Host/>));await settle();}

beforeEach(async()=>{
  nativeScope=scope;nativeNonce=nonceA;beforeWrite=undefined;writeAttempts=[];mode='';blocked=false;writeHold=null;readHold=null;writeEntered=false;readEntered=false;writes=0;clients=[];quotes=[];quoteItems=[];projects=[];reads=[];publications=[];externalRequests=0;localStorage.clear();sessionStorage.clear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('fetch',vi.fn(async()=>{externalRequests++;throw Error('External fetch is disabled in this closed fixture.');}));
  Object.defineProperty(window,'matchMedia',{value:vi.fn(()=>({matches:false,addEventListener:()=>{},removeEventListener:()=>{},addListener:()=>{},removeListener:()=>{}})),configurable:true});
  HTMLElement.prototype.scrollIntoView=()=>{};vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});
  transport.invoke.mockReset();transport.invoke.mockImplementation(async(command:string,args:any)=>{
    if(command==='clear_diagnostics')return null;
    if(command==='get_app_state'||command==='get_workspace'){
      reads.push({command,args:structuredClone(args??{}),nonce:nativeNonce});if(readHold){readEntered=true;await readHold.promise;}enforce(args);if(blocked)throw Error('Lecture locale momentanément indisponible.');
      return command==='get_app_state'?{onboarding_completed:true}:rawWorkspace();
    }
    if(command==='create_record'&&args.entity==='clients'){
      writeAttempts.push(structuredClone(args));beforeWrite?.(args);
      if(writeHold){writeEntered=true;await writeHold.promise;}enforce(args);
      if(mode==='before-commit')throw Error('Écriture locale indisponible avant commit simulé.');
      clients.push({...structuredClone(args.data),country:args.data.country||'CH',created_at:'2026-10-03T10:00:00Z'});writes++;
      if(mode==='ack-member')nativeNonce=nonceB;
      if(mode==='ack-read')blocked=true;
      if(mode==='lost'){blocked=true;throw Error('network timeout after quick commit private-fixture');}
      return structuredClone(args.data);
    }
    if(command==='update_record'&&args.entity==='clients'){enforce(args);const index=clients.findIndex(row=>row.id===args.id);expect(index).toBeGreaterThanOrEqual(0);clients[index]={...clients[index],...structuredClone(args.data)};writes++;return null;}
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
  await diagnosticsApi.clear();workspace=await desktopApi.loadWorkspace();reads=[];
  container=document.createElement('div');container.id='root';document.body.append(container);root=createRoot(container);
  await reactAct(async()=>root!.render(<Host/>));await settle();
});
afterEach(async()=>{writeHold?.resolve(undefined);readHold?.resolve(undefined);if(root)await reactAct(async()=>root!.unmount());root=undefined;container?.remove();await setAppLanguage('fr');expect(externalRequests).toBe(0);expect((globalThis as any).__quickClientImportRequests||0).toBe(0);vi.unstubAllGlobals();vi.restoreAllMocks();});

const failedCommand=(operation:string)=>recentDiagnosticEvents().filter(event=>event.operation===operation&&event.phase==='failure').at(-1)!;
describe('real quick-client diagnostic source with DocumentEditor and WorkspaceApp.act',()=>{
 it.each(['fr','de','it','en'] as const)('shows progressive source details without changing its unknown guide or document in %s',async language=>{
  const allowed=new Set(Object.values(languageAssets));vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{if(!allowed.has(String(input))){externalRequests++;throw Error('External request forbidden.');}return {ok:true,json:async()=>({'QA local pack':'QA local pack'})} as Response;}));await prepareQuick();await reactAct(async()=>{await setAppLanguage(language);});const before=draftValue();mode='lost';await addQuick();
  const failure=failedCommand('record.client.create'),guide=document.querySelector('[data-quick-client-creation-recovery]')!;expect(failure.errorCode).toBe('NETWORK');expect(guide.querySelector('code')?.textContent).toBe('ZT-'+failure.id);expect(guide.textContent).toContain(quickClientCreationRecovery[language].instruction);expect(guide.querySelector('pre')?.textContent).toBe('La création du client de ce document n’est pas confirmée.');expect(draftValue()).toEqual(before);expect(writes).toBe(1);expect(writeAttempts).toHaveLength(1);expect(publications).toHaveLength(0);expect(buttons('Vérifier maintenant')).toHaveLength(0);
  const journal=JSON.stringify(recentDiagnosticEvents());for(const value of ['Client Témoin SA','alice@example.test',before.quickClientCreationId,scope,nonceA,member,'network timeout after quick commit private-fixture'])expect(journal).not.toContain(value);
 });
 it('binds an ACK/read recovery code to the real read and retries only that read',async()=>{
  await prepareQuick();const id=draftValue().quickClientCreationId;mode='ack-read';await addQuick();await until(()=>buttons('Actualiser les données').length>0);const failure=failedCommand('get_app_state');expect(document.querySelector('.workspace-refresh-recovery code')?.textContent??Array.from(document.querySelectorAll('code')).at(-1)?.textContent).toBe('ZT-'+failure.id);expect(failedCommand('record.client.create')).toBeUndefined();expect(writes).toBe(1);expect(writeAttempts).toHaveLength(1);
  blocked=false;await click('Actualiser les données');await until(()=>draftValue().selectedClientId===id);expect(writes).toBe(1);expect(writeAttempts).toHaveLength(1);expect(publications).toHaveLength(1);expect(buttons('Actualiser les données')).toHaveLength(0);
 });
 it('keeps the original read incident distinct from a new failed read retry, and never replays the acknowledged creation',async()=>{
  await prepareQuick();const id=draftValue().quickClientCreationId;mode='ack-read';await addQuick();await until(()=>buttons('Actualiser les données').length>0);const firstCode=failedCommand('get_app_state').id;await click('Actualiser les données');const retryCode=failedCommand('get_app_state').id;expect(retryCode).not.toBe(firstCode);const codes=Array.from(document.querySelectorAll('.workspace-recovery code')).map(node=>node.textContent);expect(codes).toEqual(['ZT-'+firstCode,'ZT-'+retryCode]);expect(writes).toBe(1);expect(writeAttempts).toHaveLength(1);expect(draftValue().quickClientCreationId).toBe(id);expect(publications).toHaveLength(0);blocked=false;await click('Actualiser les données');await until(()=>draftValue().selectedClientId===id);expect(writes).toBe(1);expect(writeAttempts).toHaveLength(1);
 });
 it('keeps exact native member guard correlation through the typed terminal conversion',async()=>{
  await prepareQuick();mode='ack-member';await addQuick();const failure=failedCommand('get_app_state');expect(failure.errorCode).toBe('CONFLICT');expect(document.querySelector('.document-editor-modal code')?.textContent??Array.from(document.querySelectorAll('code')).at(-1)?.textContent).toBe('ZT-'+failure.id);expect(document.body.textContent).toContain('Ouvrez le bon compte');expect(writes).toBe(1);expect(writeAttempts).toHaveLength(1);verifyRetained();
 });
});
vi.hoisted(()=>{
  (globalThis as any).__quickClientImportRequests=0;
  Object.defineProperty(window,'matchMedia',{configurable:true,value:()=>({matches:false,addEventListener:()=>{},removeEventListener:()=>{},addListener:()=>{},removeListener:()=>{}})});
  HTMLElement.prototype.scrollIntoView=()=>{};window.scrollTo=()=>{};
  (globalThis as any).ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};
  globalThis.fetch=async()=>{(globalThis as any).__quickClientImportRequests++;throw Error('External fetch forbidden during maintained quick-client test import.');};
});
