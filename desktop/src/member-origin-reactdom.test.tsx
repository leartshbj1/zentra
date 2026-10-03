// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost","pretendToBeVisual":true}
/** Actual candidate WorkspaceApp/ContactForm/bridge/recovery/ReactDOM. Native IPC
 * is explicitly simulated, including the guard after a held local operation.
 * Unrelated preview services are stubbed; no production/network/server access. */
import {act as reactAct,useState} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {desktopApi} from './bridge';
import {WorkspaceApp} from './WorkspaceApp';
import {FormDraftIdentityProvider} from './useFormDraft';
import {ZentraAssistantProvider} from './ZentraAssistant';
import {initialOnboardingSettings} from './onboardingDraft';
import {FORM_DRAFT_PREFIX} from './formDrafts';
import type {Workspace} from './types';
import {ErrorGuidance} from './ErrorGuidance';
import {WorkspaceMemberOriginChangedError} from './workspaceMemberOrigin';
import {setAppLanguage} from './language';
import {languageAssets} from 'virtual:zentra-language-assets';

const transport=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({Channel:class{},invoke:transport.invoke,isTauri:()=>false}));
const scope='member-origin-company',member='11111111-1111-4111-8111-111111111111',nonceA='a'.repeat(32),nonceB='b'.repeat(32),nonceC='c'.repeat(32);
const guardMessage='Champ invalide : Le compte connecté a changé. Rouvrez cette action avec le bon compte.';
function deferred<T=void>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>resolve=yes);return {promise,resolve};}
let root:Root|undefined,container:HTMLDivElement,workspace:Workspace,exposed:any;
let nativeScope=scope,nativeNonce=nonceA,mode='',blocked=false,writeHold:ReturnType<typeof deferred>|null=null,readHold:ReturnType<typeof deferred>|null=null;
let writeEntered=false,readEntered=false,writes=0,clients:any[]=[],reads:any[]=[],publications:Workspace[]=[],externalRequests=0;
const settings={...structuredClone(initialOnboardingSettings),organization:{...initialOnboardingSettings.organization,legalName:'Atelier témoin',contactName:'Compte témoin'}};
function rawWorkspace(){return {work_notes_scope:nativeScope,settings:{company_name:'Atelier témoin',extra_settings_json:JSON.stringify(settings)},clients:structuredClone(clients),projects:[],employees:[],time_entries:[]};}
function enforce(args:any){if(args?.expectedWorkspaceScope!==undefined&&args.expectedWorkspaceScope!==nativeScope)throw Error('Champ invalide : L’entreprise ouverte a changé. Rouvrez cette action dans le bon espace.');if(args?.expectedMemberContextNonce!==undefined&&args.expectedMemberContextNonce!==nativeNonce)throw guardMessage;}
async function settle(){await reactAct(async()=>{for(let i=0;i<25;i++)await Promise.resolve();await new Promise<void>(resolve=>setTimeout(resolve,1));});}
async function until(check:()=>boolean){for(let i=0;i<40&&!check();i++)await settle();expect(check()).toBe(true);}
const buttons=(text:string)=>Array.from(document.querySelectorAll<HTMLButtonElement>('button')).filter(node=>node.textContent?.trim()===text);
async function click(text:string){const button=buttons(text)[0];expect(button,document.body.textContent??'').toBeDefined();await reactAct(async()=>button.click());await settle();}
function draftKeys(){return Array.from({length:localStorage.length},(_,i)=>localStorage.key(i)!).filter(key=>key.startsWith(FORM_DRAFT_PREFIX));}
async function fill(){const values={company:'Client de recette',contactPerson:'Personne témoin',street:'Rue de recette',postalCode:'1000',city:'Lausanne',country:'CH'};for(const [name,value]of Object.entries(values)){const input=document.querySelector<HTMLInputElement|HTMLSelectElement>(`[role="dialog"] [name="${name}"]`)!;expect(input).not.toBeNull();await reactAct(async()=>{const prototype=input instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));});}await settle();expect(draftKeys().length).toBe(1);}
async function openClient(){await click('Clients');await click('Nouveau client');await until(()=>document.querySelector('[role="dialog"] [name="company"]')!==null);await fill();}
async function openEdit(){await click('Clients');const button=document.querySelector<HTMLButtonElement>('[aria-label="Modifier Client existant"]');expect(button).not.toBeNull();await reactAct(async()=>button!.click());await until(()=>document.querySelector('[role="dialog"] [name="company"]')!==null);await fill();}
function draftValue(){return JSON.parse(localStorage.getItem(draftKeys()[0])!).value as Record<string,string>;}
async function submit(){const form=document.querySelector<HTMLFormElement>('[role="dialog"] form')!;await reactAct(async()=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));await settle();}
function verifyNoRetirement(){expect(draftKeys()).toHaveLength(1);expect(publications).toHaveLength(0);expect(document.body.textContent).not.toContain('Le client a été ajouté.');expect(document.querySelector('[role="dialog"] form')).not.toBeNull();}

beforeEach(async()=>{
  nativeScope=scope;nativeNonce=nonceA;mode='';blocked=false;writeHold=null;readHold=null;writeEntered=false;readEntered=false;writes=0;clients=[{id:'existing-client',name:'Client existant',company:'Client existant',contact_person:'Personne témoin',address_line1:'Rue de recette',postal_code:'1000',city:'Lausanne',country:'CH',notes:''}];reads=[];publications=[];externalRequests=0;localStorage.clear();sessionStorage.clear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('fetch',vi.fn(async()=>{externalRequests++;throw Error('External fetch is disabled in this closed fixture.');}));
  Object.defineProperty(window,'matchMedia',{value:vi.fn(()=>({matches:false,addEventListener:()=>{},removeEventListener:()=>{},addListener:()=>{},removeListener:()=>{}})),configurable:true});
  HTMLElement.prototype.scrollIntoView=()=>{};vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});
  transport.invoke.mockReset();transport.invoke.mockImplementation(async(command:string,args:any)=>{
    if(command==='get_app_state'||command==='get_workspace'){
      reads.push({command,args:structuredClone(args??{}),nonce:nativeNonce});if(readHold){readEntered=true;await readHold.promise;}enforce(args);if(blocked)throw Error('Lecture locale momentanément indisponible.');
      return command==='get_app_state'?{onboarding_completed:true}:rawWorkspace();
    }
    if(command==='create_record'&&args.entity==='clients'){
      if(writeHold){writeEntered=true;await writeHold.promise;}enforce(args);clients.push({...structuredClone(args.data),created_at:'2026-10-03T10:00:00Z'});writes++;
      if(mode==='ack-member')nativeNonce=nonceB;
      if(mode==='ack-workspace')nativeScope='other-physical-workspace';
      if(mode==='lost'){blocked=true;throw Error('Réponse de création perdue après commit simulé.');}
      return structuredClone(args.data);
    }
    if(command==='update_record'&&args.entity==='clients'){enforce(args);const index=clients.findIndex(row=>row.id===args.id);expect(index).toBeGreaterThanOrEqual(0);clients[index]={...clients[index],...structuredClone(args.data)};writes++;if(mode==='edit-unreadable')blocked=true;return null;}
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
  function Host(){const [current,setCurrent]=useState(workspace);const [nonce,setNonce]=useState<string|undefined>(nonceA);exposed={setNonce};return <FormDraftIdentityProvider companyId={scope} organizationId="org-témoin" memberId={member} memberContextNonce={nonce} ready><ZentraAssistantProvider><WorkspaceApp workspace={current} setWorkspace={next=>{if(next&&typeof next!=='function'){publications.push(next);setCurrent(next);}}}/></ZentraAssistantProvider></FormDraftIdentityProvider>;}
  await reactAct(async()=>root!.render(<Host/>));await settle();
});
afterEach(async()=>{writeHold?.resolve(undefined);readHold?.resolve(undefined);if(root)await reactAct(async()=>root!.unmount());root=undefined;container?.remove();await setAppLanguage('fr');expect(externalRequests).toBe(0);expect((globalThis as any).__memberOriginImportRequests).toBe(0);vi.unstubAllGlobals();vi.restoreAllMocks();});

describe('actual candidate WorkspaceApp.act, guarded bridge and ReactDOM recovery',()=>{
  it.each([
    ['fr','Compte ouvert à vérifier','Ouvrez le bon compte'],
    ['de','Geöffnetes Konto prüfen','Öffnen Sie das richtige Konto'],
    ['it','Verifica il conto aperto','Apri il conto corretto'],
    ['en','Check the open account','Open the correct account'],
  ] as const)('renders the real terminal member guide in %s without a language hook double',async(language,title,action)=>{
    const allowed=new Set(Object.values(languageAssets));
    vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{if(!allowed.has(String(input))){externalRequests++;throw Error('External language request forbidden.');}return {ok:true,json:async()=>({'QA local pack':'QA local pack'})} as Response;}));
    await reactAct(async()=>{await setAppLanguage(language);root!.render(<ErrorGuidance error={new WorkspaceMemberOriginChangedError()} operation="read" onReload={()=>{throw Error('Terminal member error must not expose reload');}}/>);});
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(title);expect(document.querySelector('[role="alert"]')?.textContent).toContain(action);expect(document.querySelector('.error-guidance__actions')).toBeNull();expect(writes).toBe(0);
  });

  it('ends a canonical native physical-space refusal after ACK and retains the original draft',async()=>{
    mode='ack-workspace';await openClient();const saved=draftValue();await submit();expect(writes).toBe(1);verifyNoRetirement();expect(draftValue()).toEqual(saved);
    expect(document.body.textContent).toContain('Entreprise ouverte à vérifier');expect(buttons('Actualiser les données')).toHaveLength(0);expect(document.querySelector<HTMLInputElement>('[role="dialog"] [name="company"]')!.disabled).toBe(false);
  });
  it('ends a read-only recovery when the physical-space guard rejects the original read',async()=>{
    mode='edit-unreadable';await openEdit();const saved=draftValue();await submit();await until(()=>buttons('Actualiser les données').length>0);
    nativeScope='other-physical-workspace';blocked=false;await click('Actualiser les données');await until(()=>document.body.textContent?.includes('Entreprise ouverte à vérifier')??false);
    verifyNoRetirement();expect(draftValue()).toEqual(saved);expect(writes).toBe(1);expect(buttons('Actualiser les données')).toHaveLength(0);expect(reads.every(read=>read.args.expectedWorkspaceScope===scope)).toBe(true);
  });
  it('refuses a queued creation for a different physical space before its synthetic commit',async()=>{
    await openClient();const saved=draftValue();writeHold=deferred();await submit();await until(()=>writeEntered);nativeScope='other-physical-workspace';await reactAct(async()=>writeHold!.resolve(undefined));
    await until(()=>document.body.textContent?.includes('Entreprise ouverte à vérifier')??false);expect(writes).toBe(0);verifyNoRetirement();expect(draftValue()).toEqual(saved);expect(buttons('Actualiser les données')).toHaveLength(0);
  });
  it('rejects member B after ACK without publishing success or retiring the original draft',async()=>{mode='ack-member';await openClient();await submit();expect(writes).toBe(1);verifyNoRetirement();expect(document.body.textContent).toContain('Compte ouvert à vérifier');expect(document.querySelector<HTMLInputElement>('[role="dialog"] [name="company"]')!.disabled).toBe(false);});
  it('ends unavailable post-update read recovery when B becomes current and keeps the original nonce in retry reads',async()=>{mode='edit-unreadable';await openEdit();await submit();await until(()=>buttons('Actualiser les données').length>0);nativeNonce=nonceB;blocked=false;await click('Actualiser les données');await until(()=>document.body.textContent?.includes('Compte ouvert à vérifier')??false);verifyNoRetirement();expect(writes).toBe(1);expect(reads.every(read=>read.args.expectedMemberContextNonce===nonceA)).toBe(true);expect(buttons('Actualiser les données')).toHaveLength(0);});
  it('rejects B during a held post-update recovery read without an infinite recovery modal',async()=>{mode='edit-unreadable';await openEdit();await submit();await until(()=>buttons('Actualiser les données').length>0);blocked=false;readHold=deferred();await click('Actualiser les données');await until(()=>readEntered);nativeNonce=nonceB;await reactAct(async()=>readHold!.resolve(undefined));await until(()=>document.body.textContent?.includes('Compte ouvert à vérifier')??false);verifyNoRetirement();expect(buttons('Actualiser les données')).toHaveLength(0);expect(document.querySelector<HTMLInputElement>('[role="dialog"] [name="company"]')!.disabled).toBe(false);});
  it('keeps old A pending after A -> B -> A with a fresh nonce instead of accepting the same member ID',async()=>{mode='edit-unreadable';await openEdit();await submit();await until(()=>buttons('Actualiser les données').length>0);nativeNonce=nonceB;nativeNonce=nonceC;blocked=false;await click('Actualiser les données');await until(()=>document.body.textContent?.includes('Compte ouvert à vérifier')??false);verifyNoRetirement();expect(writes).toBe(1);expect(reads.every(read=>read.args.expectedMemberContextNonce===nonceA)).toBe(true);});
  it('rejects a queued creation when the native member changes before the simulated local guard',async()=>{await openClient();writeHold=deferred();await submit();await until(()=>writeEntered);nativeNonce=nonceB;await reactAct(async()=>writeHold!.resolve(undefined));await until(()=>document.body.textContent?.includes('Compte ouvert à vérifier')??false);expect(writes).toBe(0);verifyNoRetirement();});
  it('allows the unchanged admitted context to finish once and retire its draft',async()=>{await openClient();await reactAct(async()=>exposed.setNonce(nonceA));await submit();await until(()=>document.querySelector('[role="dialog"] form')===null);expect(writes).toBe(1);expect(publications).toHaveLength(1);expect(draftKeys()).toHaveLength(0);expect(document.body.textContent).toContain('Le client a été ajouté.');expect(reads.every(read=>read.args.expectedMemberContextNonce===nonceA)).toBe(true);});
  it('fails closed for the named legacy backend without nonce, sending no creation',async()=>{await openClient();await reactAct(async()=>exposed.setNonce(undefined));await submit();expect(writes).toBe(0);verifyNoRetirement();expect(document.body.textContent).toContain('Compte ouvert à vérifier');expect(transport.invoke.mock.calls.filter(([command])=>command==='create_record')).toHaveLength(0);});

  it('preserves the durable new-contact unknown-outcome wrapper instead of claiming ID-only success',async()=>{
    mode='lost';await openClient();const id=draftValue().creationId;expect(id).toMatch(/^[a-f\d-]{36}$/i);await submit();
    expect(writes).toBe(1);verifyNoRetirement();expect(draftValue().creationId).toBe(id);expect(buttons('Vérifier maintenant')).toHaveLength(0);
    expect(document.querySelector('[data-contact-creation-recovery]')?.textContent).toContain('Vérifiez la liste');
    expect(document.querySelector<HTMLInputElement>('[role="dialog"] [name="company"]')!.disabled).toBe(false);
  });
  it('blocks the last synchronous contact capture on local failure and retries storage without native creation',async()=>{
    await openClient();const id=draftValue().creationId;const input=document.querySelector<HTMLInputElement>('[role="dialog"] [name="company"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'Dernière frappe non rendue');
    const original=Storage.prototype.setItem;const failed=vi.spyOn(Storage.prototype,'setItem').mockImplementation(function(this:Storage,key,value){if(key.startsWith(FORM_DRAFT_PREFIX))throw new DOMException('Capture blocked','QuotaExceededError');original.call(this,key,value);});
    await submit();expect(writes).toBe(0);expect(transport.invoke.mock.calls.some(([command])=>command==='create_record')).toBe(false);
    expect(document.querySelector('[data-contact-storage-recovery]')?.textContent).toContain('sauvegarde locale');expect(draftValue().creationId).toBe(id);
    failed.mockRestore();const retry=document.querySelector<HTMLButtonElement>('.contact-form-failure .error-guidance__actions button')!;await reactAct(async()=>retry.click());await settle();
    expect(writes).toBe(0);expect(document.querySelector('[data-contact-storage-recovery]')).toBeNull();expect(draftValue().creationId).toBe(id);expect(draftValue().company).toBe('Dernière frappe non rendue');
    await submit();await until(()=>document.querySelector('[role="dialog"] form')===null);expect(writes).toBe(1);expect(clients.at(-1).id).toBe(id);
  });
  it('keeps new contact open after failed durable discard and closes only after verified deletion',async()=>{
    await openClient();const id=draftValue().creationId;vi.spyOn(window,'confirm').mockReturnValue(true);const original=Storage.prototype.removeItem;
    const failed=vi.spyOn(Storage.prototype,'removeItem').mockImplementation(function(this:Storage,key){if(key.startsWith(FORM_DRAFT_PREFIX))throw new DOMException('Deletion blocked','SecurityError');original.call(this,key);});
    await click('Abandonner le brouillon');expect(document.querySelector('[role="dialog"] form')).not.toBeNull();expect(draftValue().creationId).toBe(id);expect(writes).toBe(0);
    failed.mockRestore();await click('Abandonner le brouillon');await until(()=>document.querySelector('[role="dialog"] form')===null);expect(draftKeys()).toHaveLength(0);
    await click('Nouveau client');await until(()=>document.querySelector('[role="dialog"] [name="company"]')!==null);await fill();expect(draftValue().creationId).not.toBe(id);expect(writes).toBe(0);
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
