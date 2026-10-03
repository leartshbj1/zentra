import {diagnosticsApi,recentDiagnosticEvents} from './diagnostics';
// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost","pretendToBeVisual":true}
/** Actual candidate WorkspaceApp/DocumentEditor/footer templates/bridge/recovery/ReactDOM. Native IPC
 * is explicitly simulated, including the guard after a held local operation; no auth/network requests.
 * Unrelated preview services are stubbed; no production/network/server access. */
import {act as reactAct,useState} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {desktopApi} from './bridge';
import {WorkspaceApp} from './WorkspaceApp';
import {FormDraftIdentityProvider} from './useFormDraft';
import {ZentraAssistantProvider} from './ZentraAssistant';
import {initialOnboardingSettings} from './onboardingDraft';
import type {Workspace} from './types';
import {setAppLanguage} from './language';

const transport=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({Channel:class{},invoke:transport.invoke,isTauri:()=>false}));
const scope='quick-client-durable-company',member='11111111-1111-4111-8111-111111111111',nonceA='a'.repeat(32),nonceB='b'.repeat(32);
const guardMessage='Champ invalide : Le compte connecté a changé. Rouvrez cette action avec le bon compte.';
function deferred<T=void>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>resolve=yes);return {promise,resolve};}
let root:Root|undefined,container:HTMLDivElement,workspace:Workspace,exposed:any;
let nativeNonce=nonceA,mode='',blocked=false,writeHold:ReturnType<typeof deferred>|null=null,readHold:ReturnType<typeof deferred>|null=null;
let writeEntered=false,readEntered=false,writes=0,clients:any[]=[],quotes:any[]=[],projects:any[]=[],quoteItems:any[]=[],reads:any[]=[],publications:Workspace[]=[],externalRequests=0,writeAttempts:any[]=[],nativeScope=scope;
let beforeWrite:((args:any)=>void)|undefined;
const baseSettings={...structuredClone(initialOnboardingSettings),organization:{...initialOnboardingSettings.organization,legalName:'Atelier témoin',contactName:'Compte témoin'}};
let settings=structuredClone(baseSettings);
const clientId='22222222-2222-4222-8222-222222222222';
function rawWorkspace(){return {work_notes_scope:scope,settings:{company_name:'Atelier témoin',extra_settings_json:JSON.stringify(settings)},projects:structuredClone(projects),quotes:structuredClone(quotes),quote_items:structuredClone(quoteItems),clients:structuredClone(clients),time_entries:[]};}
function enforce(args:any){if(args?.expectedWorkspaceScope!==undefined&&args.expectedWorkspaceScope!==nativeScope)throw 'Champ invalide : L’entreprise ouverte a changé. Rouvrez cette action dans le bon espace.';if(args?.expectedMemberContextNonce!==undefined&&args.expectedMemberContextNonce!==nativeNonce)throw guardMessage;}
async function settle(){await reactAct(async()=>{for(let i=0;i<25;i++)await Promise.resolve();await new Promise<void>(resolve=>setTimeout(resolve,1));});}
async function until(check:()=>boolean){for(let i=0;i<40&&!check();i++)await settle();expect(check()).toBe(true);}
const buttons=(text:string)=>Array.from(document.querySelectorAll<HTMLButtonElement>('button')).filter(node=>node.textContent?.trim()===text);
async function click(text:string){const button=buttons(text)[0];expect(button,document.body.textContent??'').toBeDefined();await reactAct(async()=>button.click());await settle();}
async function change(name:string,value:string,events=true){const input=document.querySelector<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>(`[role="dialog"] [name="${name}"]`)!;expect(input,name).not.toBeNull();await reactAct(async()=>{const prototype=input instanceof HTMLSelectElement?HTMLSelectElement.prototype:input instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value')!.set!.call(input,value);if(events){input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));}});await settle();}
async function openDocument(entity:'quotes'|'invoices'='quotes'){await click('Ventes');if(entity==='invoices')await click('Factures');await click(entity==='quotes'?'Nouveau devis':'Nouvelle facture');await reactAct(async()=>{await vi.dynamicImportSettled();});await until(()=>document.querySelector('[role="dialog"] [name="title"]')!==null);}
function Host(){const [current,setCurrent]=useState(workspace);const [nonce,setNonce]=useState<string|undefined>(nonceA);exposed={setNonce,setCurrent};return <FormDraftIdentityProvider companyId={scope} organizationId="org-témoin" memberId={member} memberContextNonce={nonce} ready><ZentraAssistantProvider><WorkspaceApp workspace={current} setWorkspace={next=>{if(next&&typeof next!=='function'){publications.push(next);setCurrent(next);}}}/></ZentraAssistantProvider></FormDraftIdentityProvider>;}
beforeEach(async()=>{
  nativeScope=scope;nativeNonce=nonceA;settings=structuredClone(baseSettings);settings.billing.footerTemplates=[{id:'33333333-3333-4333-8333-333333333333',name:'Modèle témoin',text:'Texte original témoin'}];beforeWrite=undefined;writeAttempts=[];mode='';blocked=false;writeHold=null;readHold=null;writeEntered=false;readEntered=false;writes=0;clients=[{id:clientId,name:'Client témoin',company:'Client témoin SA',country:'CH'}];quotes=[];quoteItems=[];projects=[];reads=[];publications=[];externalRequests=0;localStorage.clear();sessionStorage.clear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('fetch',vi.fn(async()=>{externalRequests++;throw Error('External fetch is disabled in this closed fixture.');}));
  Object.defineProperty(window,'matchMedia',{value:vi.fn(()=>({matches:false,addEventListener:()=>{},removeEventListener:()=>{},addListener:()=>{},removeListener:()=>{}})),configurable:true});
  HTMLElement.prototype.scrollIntoView=()=>{};vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});
  transport.invoke.mockReset();transport.invoke.mockImplementation(async(command:string,args:any)=>{
    if(command==='clear_diagnostics')return null;
    if(command==='get_app_state'||command==='get_workspace'){
      reads.push({command,args:structuredClone(args??{}),nonce:nativeNonce});if(readHold){readEntered=true;await readHold.promise;}enforce(args);if(blocked)throw Error('Lecture locale momentanément indisponible.');
      return command==='get_app_state'?{onboarding_completed:true}:rawWorkspace();
    }
    if(command==='update_settings'){
      writeAttempts.push(structuredClone(args));beforeWrite?.(args);
      if(writeHold){writeEntered=true;await writeHold.promise;}enforce(args);
      if(mode==='before-commit')throw Error('Synthetic settings refusal before commit.');
      settings={...settings,billing:{...settings.billing,...JSON.parse(args.data.extra_settings_json).billing}};writes++;
      if(mode==='ack-member')nativeNonce=nonceB;
      if(mode==='ack-read')blocked=true;
      return structuredClone(args.data);
    }
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
afterEach(async()=>{writeHold?.resolve(undefined);readHold?.resolve(undefined);if(root)await reactAct(async()=>root!.unmount());root=undefined;container?.remove();await setAppLanguage('fr');expect(externalRequests).toBe(0);expect((globalThis as any).__footerTemplateImportRequests||0).toBe(0);vi.unstubAllGlobals();vi.restoreAllMocks();});

vi.hoisted(()=>{
  (globalThis as any).__footerTemplateImportRequests=0;
  Object.defineProperty(window,'matchMedia',{configurable:true,value:()=>({matches:false,addEventListener:()=>{},removeEventListener:()=>{},addListener:()=>{},removeListener:()=>{}})});
  HTMLElement.prototype.scrollIntoView=()=>{};window.scrollTo=()=>{};
  (globalThis as any).ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};
  globalThis.fetch=async()=>{(globalThis as any).__footerTemplateImportRequests++;throw Error('External fetch forbidden during footer template test import.');};
});

async function changeElement(input:HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement,value:string){
  expect(input).not.toBeNull();await reactAct(async()=>{const prototype=input instanceof HTMLSelectElement?HTMLSelectElement.prototype:input instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));});await settle();
}
async function prepareFooter(action:'save'|'delete'){
  await openDocument();await change('title','Document témoin');await change('clientId',clientId);
  const description=document.querySelector<HTMLInputElement>('[role="dialog"] input[aria-label="Description"]')!;await changeElement(description,'Prestation témoin');
  await changeElement(document.querySelector<HTMLInputElement>('[role="dialog"] input[aria-label="Quantité"]')!,'1');await changeElement(document.querySelector<HTMLInputElement>('[role="dialog"] input[aria-label="Prix unitaire"]')!,'100');
  const step=document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="3. Conditions"]')!;expect(step).not.toBeNull();await reactAct(async()=>step.click());await settle();
  const details=document.querySelector<HTMLDetailsElement>('.document-templates-details')!;await reactAct(async()=>{details.open=true;details.dispatchEvent(new Event('toggle',{bubbles:true}));});await settle();
  if(action==='save'){await change('terms','Texte ajouté par le compte A');await changeElement(document.querySelector<HTMLInputElement>('.document-footer-templates input')!,'Nouveau modèle A');}
  else await changeElement(document.querySelector<HTMLSelectElement>('.document-footer-templates select')!,'33333333-3333-4333-8333-333333333333');
}

describe('actual DocumentEditor footer template origin held mutation',()=>{
 it.each(['save','delete'] as const)('refuses old account A %s after same-workspace transition to B',async action=>{
  await prepareFooter(action);const before=structuredClone(settings.billing.footerTemplates);writeHold=deferred();
  await click(action==='save'?'Enregistrer le modèle':'Supprimer le modèle');await until(()=>writeEntered);
  await reactAct(async()=>{nativeNonce=nonceB;exposed.setNonce(nonceB);});await settle();writeHold.resolve(undefined);await settle();
  expect(writeAttempts).toHaveLength(1);expect(writeAttempts[0].expectedWorkspaceScope).toBe(scope);expect.soft(writeAttempts[0].expectedMemberContextNonce).toBe(nonceA);
  expect.soft(writes).toBe(0);expect.soft(settings.billing.footerTemplates).toEqual(before);expect.soft(publications).toHaveLength(0);
 });
});


describe('actual footer settings guarded ACK and read-only recovery',()=>{
 it.each(['save','delete'] as const)('saves current member %s with unchanged footer payload and both bound reads',async action=>{
  await prepareFooter(action);reads=[];await click(action==='save'?'Enregistrer le modèle':'Supprimer le modèle');
  expect(writes).toBe(1);expect(writeAttempts).toHaveLength(1);expect(writeAttempts[0].expectedWorkspaceScope).toBe(scope);expect(writeAttempts[0].expectedMemberContextNonce).toBe(nonceA);
  const templates=JSON.parse(writeAttempts[0].data.extra_settings_json).billing.footerTemplates;
  expect(templates).toEqual(settings.billing.footerTemplates);expect(templates).toHaveLength(action==='save'?2:0);expect(publications).toHaveLength(1);
  expect(reads.map(row=>row.command)).toEqual(['get_app_state','get_workspace']);for(const read of reads)expect(read.args).toEqual({expectedWorkspaceScope:scope,expectedMemberContextNonce:nonceA});
 });
 it.each(['save','delete'] as const)('refuses %s after A to B to A with a fresh nonce',async action=>{
  await prepareFooter(action);const before=structuredClone(settings.billing.footerTemplates);writeHold=deferred();await click(action==='save'?'Enregistrer le modèle':'Supprimer le modèle');await until(()=>writeEntered);
  await reactAct(async()=>{nativeNonce=nonceB;exposed.setNonce(nonceB);});await settle();const nonceA2='c'.repeat(32);await reactAct(async()=>{nativeNonce=nonceA2;exposed.setNonce(nonceA2);});await settle();writeHold.resolve(undefined);await settle();
  expect(writeAttempts).toHaveLength(1);expect(writeAttempts[0].expectedMemberContextNonce).toBe(nonceA);expect(writes).toBe(0);expect(settings.billing.footerTemplates).toEqual(before);expect(publications).toHaveLength(0);
 });
 it.each(['save','delete'] as const)('does not publish %s or keep a refresh loop after canonical member refusal following ACK',async action=>{
  await prepareFooter(action);reads=[];mode='ack-member';await click(action==='save'?'Enregistrer le modèle':'Supprimer le modèle');await settle();
  expect(writes).toBe(1);expect(writeAttempts).toHaveLength(1);expect(publications).toHaveLength(0);expect(reads).toHaveLength(1);expect(reads[0].args).toEqual({expectedWorkspaceScope:scope,expectedMemberContextNonce:nonceA});
  expect(buttons('Actualiser les données')).toHaveLength(0);const count=transport.invoke.mock.calls.length;await settle();expect(transport.invoke.mock.calls.length).toBe(count);
 });
 it.each(['save','delete'] as const)('only rereads after acknowledged %s and an ordinary read failure',async action=>{
  await prepareFooter(action);reads=[];mode='ack-read';await click(action==='save'?'Enregistrer le modèle':'Supprimer le modèle');await until(()=>buttons('Actualiser les données').length>0);
  expect(writes).toBe(1);expect(writeAttempts).toHaveLength(1);expect(publications).toHaveLength(0);await click('Actualiser les données');expect(writes).toBe(1);expect(writeAttempts).toHaveLength(1);expect(publications).toHaveLength(0);
  blocked=false;await click('Actualiser les données');await until(()=>publications.length===1);expect(writes).toBe(1);expect(writeAttempts).toHaveLength(1);expect(buttons('Actualiser les données')).toHaveLength(0);for(const read of reads)expect(read.args).toEqual({expectedWorkspaceScope:scope,expectedMemberContextNonce:nonceA});
 });
 it('keeps the omitted-nonce legacy shape and sends exactly the same settings payload',async()=>{
  const proposed={...settings,billing:{...settings.billing,footerTemplates:[{id:'33333333-3333-4333-8333-333333333333',name:'Payload témoin',text:'Texte témoin'}]}};reads=[];
  await desktopApi.saveSettings(proposed,scope);const legacy=structuredClone(writeAttempts[0]);expect(legacy.expectedMemberContextNonce).toBeUndefined();expect(reads.map(row=>row.args)).toEqual([{},{}]);
  reads=[];await desktopApi.saveSettings(proposed,scope,nonceA);expect(writeAttempts).toHaveLength(2);expect(writeAttempts[1].data).toEqual(legacy.data);expect(reads.map(row=>row.args)).toEqual([{expectedWorkspaceScope:scope,expectedMemberContextNonce:nonceA},{expectedWorkspaceScope:scope,expectedMemberContextNonce:nonceA}]);
 });
 it('preserves ordinary native refusal with its existing bounded read and no write replay',async()=>{
  await prepareFooter('save');reads=[];mode='before-commit';await click('Enregistrer le modèle');expect(writeAttempts).toHaveLength(1);expect(writes).toBe(0);expect(reads.map(row=>row.command)).toEqual(['get_app_state','get_workspace']);for(const read of reads)expect(read.args).toEqual({expectedWorkspaceScope:scope,expectedMemberContextNonce:nonceA});expect(publications).toHaveLength(1);expect(document.body.textContent).toContain('Synthetic settings refusal before commit.');expect(buttons('Actualiser les données')).toHaveLength(0);
 });
});
