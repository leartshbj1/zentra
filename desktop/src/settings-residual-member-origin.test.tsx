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
import {FinanceOverview} from './FinanceOverview';
import {FormDraftIdentityProvider} from './useFormDraft';
import {ZentraAssistantProvider} from './ZentraAssistant';
import {initialOnboardingSettings} from './onboardingDraft';
import type {Workspace} from './types';
import {setAppLanguage} from './language';
import {isMobileRuntime} from './mobileRuntime';

const transport=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({Channel:class{},invoke:transport.invoke,isTauri:()=>false}));
const scope='quick-client-durable-company',member='11111111-1111-4111-8111-111111111111',nonceA='a'.repeat(32),nonceB='b'.repeat(32);
const guardMessage='Champ invalide : Le compte connecté a changé. Rouvrez cette action avec le bon compte.';
function deferred<T=void>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>resolve=yes);return {promise,resolve};}
let root:Root|undefined,container:HTMLDivElement,workspace:Workspace,exposed:any;
let renderFinance=false;
let nativeNonce=nonceA,mode='',blocked=false,writeHold:ReturnType<typeof deferred>|null=null,readHold:ReturnType<typeof deferred>|null=null;
let writeEntered=false,readEntered=false,writes=0,clients:any[]=[],quotes:any[]=[],projects:any[]=[],quoteItems:any[]=[],reads:any[]=[],publications:Workspace[]=[],externalRequests=0,writeAttempts:any[]=[],nativeScope=scope;
let beforeWrite:((args:any)=>void)|undefined;
const baseSettings={...structuredClone(initialOnboardingSettings),organization:{...initialOnboardingSettings.organization,legalName:'Atelier témoin',contactName:'Compte témoin'}};
baseSettings.payroll={...baseSettings.payroll,enabled:true,payrollCanton:'VD',accidentInsurer:'Assureur original',fiduciaryValidated:true};
let settings=structuredClone(baseSettings);
const clientId='22222222-2222-4222-8222-222222222222';
function rawWorkspace(){return {work_notes_scope:scope,settings:{company_name:'Atelier témoin',extra_settings_json:JSON.stringify(settings)},projects:structuredClone(projects),quotes:structuredClone(quotes),quote_items:structuredClone(quoteItems),clients:structuredClone(clients),employees:[{id:'44444444-4444-4444-8444-444444444444',name:'Personne témoin',birth_date:'1990-01-01',employment_start_date:'2026-01-01',employment_contract_kind:'indefinite',contractual_weekly_minutes:2400,active:1}],time_entries:[]};}
function enforce(args:any){if(args?.expectedWorkspaceScope!==undefined&&args.expectedWorkspaceScope!==nativeScope)throw 'Champ invalide : L’entreprise ouverte a changé. Rouvrez cette action dans le bon espace.';if(args?.expectedMemberContextNonce!==undefined&&args.expectedMemberContextNonce!==nativeNonce)throw guardMessage;}
async function settle(){await reactAct(async()=>{for(let i=0;i<25;i++)await Promise.resolve();await new Promise<void>(resolve=>setTimeout(resolve,1));});}
async function until(check:()=>boolean){for(let i=0;i<40&&!check();i++)await settle();expect(check(),document.body.textContent??'').toBe(true);}
const buttons=(text:string)=>Array.from(document.querySelectorAll<HTMLButtonElement>('button')).filter(node=>node.textContent?.trim()===text);
async function click(text:string){const button=buttons(text)[0];expect(button,document.body.textContent??'').toBeDefined();expect(button.disabled,text).toBe(false);await reactAct(async()=>button.click());await settle();}
async function change(name:string,value:string,events=true){const input=document.querySelector<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>(`[role="dialog"] [name="${name}"]`)!;expect(input,name).not.toBeNull();await reactAct(async()=>{const prototype=input instanceof HTMLSelectElement?HTMLSelectElement.prototype:input instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value')!.set!.call(input,value);if(events){input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));}});await settle();}
async function openDocument(entity:'quotes'|'invoices'='quotes'){await click('Ventes');if(entity==='invoices')await click('Factures');await click(entity==='quotes'?'Nouveau devis':'Nouvelle facture');await reactAct(async()=>{await vi.dynamicImportSettled();});await until(()=>document.querySelector('[role="dialog"] [name="title"]')!==null);}
function Host(){const [current,setCurrent]=useState(workspace);const [nonce,setNonce]=useState<string|undefined>(nonceA);const [finance,setFinance]=useState(false);exposed={setNonce,setCurrent,setFinance};const publish=(next:Workspace)=>{publications.push(next);setCurrent(next);};return <FormDraftIdentityProvider companyId={scope} organizationId="org-témoin" memberId={member} memberContextNonce={nonce} ready><ZentraAssistantProvider>{finance?<FinanceOverview workspace={current} income={null} continuity={{enabled:false,mappingReady:false,journalEntryCount:0} as never} busy={false} periodLabel="2026" readOnly={false} onSection={()=>{}} onWorkspaceChange={publish} onInstallStarter={async()=>{}}/>:<WorkspaceApp workspace={current} setWorkspace={next=>{if(next&&typeof next!=='function'){publications.push(next);setCurrent(next);}}}/>}</ZentraAssistantProvider></FormDraftIdentityProvider>;}
beforeEach(async()=>{
  nativeScope=scope;nativeNonce=nonceA;settings=structuredClone(baseSettings);settings.billing.footerTemplates=[{id:'33333333-3333-4333-8333-333333333333',name:'Modèle témoin',text:'Texte original témoin'}];beforeWrite=undefined;writeAttempts=[];mode='';blocked=false;writeHold=null;readHold=null;writeEntered=false;readEntered=false;writes=0;clients=[{id:clientId,name:'Client témoin',company:'Client témoin SA',country:'CH'}];quotes=[];quoteItems=[];projects=[];reads=[];publications=[];externalRequests=0;localStorage.clear();sessionStorage.clear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('fetch',vi.fn(async()=>{externalRequests++;throw Error('External fetch is disabled in this closed fixture.');}));
  Object.defineProperty(window,'matchMedia',{value:vi.fn(()=>({matches:false,addEventListener:()=>{},removeEventListener:()=>{},addListener:()=>{},removeListener:()=>{}})),configurable:true});
  HTMLCanvasElement.prototype.getContext=(()=>({measureText:(value:string)=>({width:value.length*8})})) as never;HTMLElement.prototype.scrollTo=()=>{};HTMLElement.prototype.scrollIntoView=()=>{};vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});
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
      settings=JSON.parse(args.data.extra_settings_json);writes++;
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
  vi.spyOn(desktopApi,'listPayrollContributionDefinitions').mockResolvedValue([]);
  vi.spyOn(desktopApi,'getAccountingSettings').mockResolvedValue({enabled:false} as never);
  vi.spyOn(desktopApi,'listAccounts').mockResolvedValue([]);
  vi.spyOn(desktopApi,'getNogaCatalog').mockResolvedValue({version:'2025',source:'',sections:[]} as never);
  await diagnosticsApi.clear();workspace=await desktopApi.loadWorkspace();reads=[];
  container=document.createElement('div');container.id='root';document.body.append(container);root=createRoot(container);
  await reactAct(async()=>root!.render(<Host/>));await settle();
});
afterEach(async()=>{writeHold?.resolve(undefined);readHold?.resolve(undefined);if(root)await reactAct(async()=>root!.unmount());root=undefined;container?.remove();await setAppLanguage('fr');expect(externalRequests).toBe(0);expect((globalThis as any).__footerTemplateImportRequests||0).toBe(0);vi.unstubAllGlobals();vi.restoreAllMocks();});

vi.hoisted(()=>{
  (globalThis as any).__footerTemplateImportRequests=0;
  Object.defineProperty(window,'matchMedia',{configurable:true,value:()=>({matches:false,addEventListener:()=>{},removeEventListener:()=>{},addListener:()=>{},removeListener:()=>{}})});
  HTMLElement.prototype.scrollTo=()=>{};HTMLElement.prototype.scrollIntoView=()=>{};window.scrollTo=()=>{};
  (globalThis as any).ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};
  globalThis.fetch=async()=>{(globalThis as any).__footerTemplateImportRequests++;throw Error('External fetch forbidden during footer template test import.');};
});

async function changeElement(input:HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement,value:string){
  expect(input).not.toBeNull();await reactAct(async()=>{const prototype=input instanceof HTMLSelectElement?HTMLSelectElement.prototype:input instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));});await settle();
}

type Route='vat'|'payroll'|'finance';
async function prepare(route:Route){
 if(route==='vat'){await click('Paramètres');await reactAct(async()=>{await vi.dynamicImportSettled();});await until(()=>buttons('Enregistrer les taux').length>0);}
 if(route==='payroll'){
  await click('Équipe & salaires');await click('Bulletins0');await click('Nouvelle fiche');await reactAct(async()=>{await vi.dynamicImportSettled();});await until(()=>document.querySelector('[role="dialog"]')!==null);
  await click('Continuer');const details=document.querySelector<HTMLDetailsElement>('[data-payroll-selection]')!;expect(details).not.toBeNull();await reactAct(async()=>{details.open=true;});await click('Mes caisses et assurances');await until(()=>document.querySelector('.payroll-setup')!==null);
  await changeElement(document.querySelector<HTMLInputElement>('.payroll-setup [name="accidentInsurer"]')!,'Assureur proposé A');
 }
 if(route==='finance'){await reactAct(async()=>exposed.setFinance(true));await settle();await click('Choisir mes délais');const radio=document.querySelector<HTMLInputElement>('[name="billing-preset"][value="short"]')!;expect(radio).not.toBeNull();await reactAct(async()=>radio.click());await settle();await click('Vérifier mes choix');}
}
async function save(route:Route){
 if(route==='vat')await click('Enregistrer les taux');
 if(route==='finance')await click('Appliquer ces réglages');
 if(route==='payroll'){const form=document.querySelector<HTMLFormElement>('.payroll-setup form')!;expect(form).not.toBeNull();await reactAct(async()=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));await settle();await reactAct(async()=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));await settle();}
}
async function transition(aba:boolean){await reactAct(async()=>{nativeNonce=nonceB;exposed.setNonce(nonceB);});await settle();if(aba){await reactAct(async()=>{nativeNonce='c'.repeat(32);exposed.setNonce(nativeNonce);});await settle();}}
const assertBoundReads=()=>{for(const read of reads)expect(read.args).toEqual({expectedWorkspaceScope:scope,expectedMemberContextNonce:nonceA});};
describe('actual residual settings caller account origins',()=>{
 it.each(['vat','payroll','finance'] as const)('saves %s with exact captured origin and only bound reads',async route=>{
  await prepare(route);reads=[];await save(route);await until(()=>writes===1);expect(writeAttempts).toHaveLength(1);expect(writeAttempts[0].expectedWorkspaceScope).toBe(scope);expect(writeAttempts[0].expectedMemberContextNonce).toBe(nonceA);expect(publications).toHaveLength(1);assertBoundReads();
 });
 it.each((['vat','payroll','finance'] as const).flatMap(route=>[false,true].map(aba=>({route,aba}))))('refuses held $route write after actor transition ABA=$aba',async({route,aba})=>{
  await prepare(route);reads=[];const before=structuredClone(settings);writeHold=deferred();await save(route);await until(()=>writeEntered);await transition(aba);writeHold.resolve(undefined);await settle();expect(writeAttempts).toHaveLength(1);expect.soft(writeAttempts[0].expectedMemberContextNonce).toBe(nonceA);expect.soft(writes).toBe(0);expect.soft(settings).toEqual(before);expect.soft(publications).toHaveLength(0);assertBoundReads();
 });
 it.each(['vat','payroll','finance'] as const)('keeps %s ACK recovery bound and terminal after member refusal',async route=>{
  await prepare(route);reads=[];mode='ack-member';await save(route);await until(()=>writes===1);await settle();expect(writeAttempts).toHaveLength(1);expect(publications).toHaveLength(0);assertBoundReads();expect(buttons('Actualiser les données')).toHaveLength(0);const count=transport.invoke.mock.calls.length;await settle();expect(transport.invoke.mock.calls.length).toBe(count);
 });
});

describe('settings read-only recovery and awaited pickers keep original admission',()=>{
 it.each(['payroll','finance'] as const)('refuses %s before writing when A read resumes under actor B',async route=>{
  await prepare(route);reads=[];readHold=deferred();await save(route);await until(()=>readEntered);await transition(true);readHold.resolve(undefined);await settle();expect(writeAttempts).toHaveLength(0);expect(writes).toBe(0);expect(publications).toHaveLength(0);assertBoundReads();
 });
 it.each(['folder','logo'] as const)('does not recapture %s actor after the native picker await',async kind=>{
  await prepare('vat');const picked=deferred<string>();const chooser=kind==='folder'?'chooseBackupFolder':'chooseLogo';vi.spyOn(desktopApi,chooser).mockImplementation(()=>picked.promise);if(kind==='logo')vi.spyOn(desktopApi,'stageCompanyLogo').mockResolvedValue('staged-logo.png');
  // The mobile backup flow shares a local archive; it deliberately exposes no desktop folder picker.
  if(kind==='folder'&&isMobileRuntime()){
   const before=structuredClone(settings.backup),invokeCount=transport.invoke.mock.calls.length;reads=[];await settle();expect(buttons('Choisir le dossier')).toHaveLength(0);expect(buttons('Enregistrer les options')).toHaveLength(1);expect(document.body.textContent).toContain('Choisissez ensuite où la conserver dans la fenêtre de partage.');expect(desktopApi.chooseBackupFolder).not.toHaveBeenCalled();expect(writeAttempts).toHaveLength(0);expect(writes).toBe(0);expect(settings.backup).toEqual(before);expect(publications).toHaveLength(0);expect(reads).toEqual([]);expect(transport.invoke.mock.calls).toHaveLength(invokeCount);return;
  }
  reads=[];await click(kind==='folder'?'Choisir le dossier':'Choisir le logo');await transition(true);await reactAct(async()=>picked.resolve(kind==='folder'?'D:/local-demo-backup':'source-logo.png'));await settle();expect(writeAttempts).toHaveLength(1);expect(writeAttempts[0].expectedMemberContextNonce).toBe(nonceA);expect(writes).toBe(0);expect(publications).toHaveLength(0);assertBoundReads();
 });
 it('keeps every settings recovery read on A after ACK loss then terminates under B without another write',async()=>{
  await prepare('vat');reads=[];mode='ack-read';await save('vat');await until(()=>buttons('Actualiser les données').length>0);expect(writes).toBe(1);expect(writeAttempts).toHaveLength(1);await transition(true);blocked=false;await click('Actualiser les données');await settle();expect(publications).toHaveLength(0);expect(writeAttempts).toHaveLength(1);expect(writes).toBe(1);expect(buttons('Actualiser les données')).toHaveLength(0);assertBoundReads();
 });
});
