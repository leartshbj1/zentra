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
import {documentCreationText} from './documentCreationRequest';

const transport=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({Channel:class{},invoke:transport.invoke,isTauri:()=>false}));
const scope='quick-client-durable-company',member='11111111-1111-4111-8111-111111111111',nonceA='a'.repeat(32),nonceB='b'.repeat(32);
const guardMessage='Champ invalide : Le compte connecté a changé. Rouvrez cette action avec le bon compte.';
function deferred<T=void>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>resolve=yes);return {promise,resolve};}
let root:Root|undefined,container:HTMLDivElement,workspace:Workspace,exposed:any;
let nativeNonce=nonceA,mode='',blocked=false,writeHold:ReturnType<typeof deferred>|null=null,readHold:ReturnType<typeof deferred>|null=null;
let writeEntered=false,readEntered=false,writes=0,clients:any[]=[],quotes:any[]=[],invoices:any[]=[],invoiceItems:any[]=[],projects:any[]=[],quoteItems:any[]=[],reads:any[]=[],publications:Workspace[]=[],externalRequests=0,writeAttempts:any[]=[],nativeScope=scope;
let receipts=new Map<string,any>(),probeCalls:any[]=[],probeHold:ReturnType<typeof deferred>|null=null,probeEntered=false,readOnly=false;
let beforeWrite:((args:any)=>void)|undefined;
const settings={...structuredClone(initialOnboardingSettings),organization:{...initialOnboardingSettings.organization,legalName:'Atelier témoin',contactName:'Compte témoin'}};
function rawWorkspace(){return {work_notes_scope:scope,settings:{company_name:'Atelier témoin',extra_settings_json:JSON.stringify(settings)},projects:structuredClone(projects),quotes:structuredClone(quotes),quote_items:structuredClone(quoteItems),invoices:structuredClone(invoices),invoice_items:structuredClone(invoiceItems),clients:structuredClone(clients),time_entries:[]};}
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
function Host(){const [current,setCurrent]=useState(workspace);const [nonce,setNonce]=useState<string|undefined>(nonceA);const [ro,setReadOnly]=useState(false);exposed={setNonce,setCurrent,setReadOnly};return <FormDraftIdentityProvider companyId={scope} organizationId="org-témoin" memberId={member} memberContextNonce={nonce} ready><ZentraAssistantProvider><WorkspaceApp readOnly={ro} workspace={current} setWorkspace={next=>{if(next&&typeof next!=='function'){publications.push(next);setCurrent(next);}}}/></ZentraAssistantProvider></FormDraftIdentityProvider>;}
async function restart(){await reactAct(async()=>root!.unmount());root=undefined;container.remove();blocked=false;mode='';workspace=await desktopApi.loadWorkspace();container=document.createElement('div');container.id='root';document.body.append(container);root=createRoot(container);await reactAct(async()=>root!.render(<Host/>));await settle();}

beforeEach(async()=>{
  receipts=new Map();probeCalls=[];probeHold=null;probeEntered=false;readOnly=false;nativeScope=scope;nativeNonce=nonceA;beforeWrite=undefined;writeAttempts=[];mode='';blocked=false;writeHold=null;readHold=null;writeEntered=false;readEntered=false;writes=0;clients=[];quotes=[];quoteItems=[];invoices=[];invoiceItems=[];projects=[];reads=[];publications=[];externalRequests=0;localStorage.clear();sessionStorage.clear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('fetch',vi.fn(async()=>{externalRequests++;throw Error('External fetch is disabled in this closed fixture.');}));
  Object.defineProperty(window,'matchMedia',{value:vi.fn(()=>({matches:false,addEventListener:()=>{},removeEventListener:()=>{},addListener:()=>{},removeListener:()=>{}})),configurable:true});
  HTMLElement.prototype.scrollIntoView=()=>{};vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});
  transport.invoke.mockReset();transport.invoke.mockImplementation(async(command:string,args:any)=>{
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
      if(mode==='lost'){blocked=true;throw Error('Réponse de création perdue après commit simulé.');}
      return structuredClone(args.data);
    }
    if(command==='get_document_creation_receipt'){
      probeCalls.push(structuredClone(args));if(probeHold){probeEntered=true;await probeHold.promise;}enforce(args);
      const entry=receipts.get(args.creationRequestId),rows=args.input.entity==='quotes'?quotes:invoices,itemRows=args.input.entity==='quotes'?quoteItems:invoiceItems;
      const current=rows.find(row=>row.id===args.creationRequestId),items=itemRows.filter(row=>row[args.input.entity==='quotes'?'quote_id':'invoice_id']===args.creationRequestId);
      if(entry&&JSON.stringify(entry.input)!==JSON.stringify(args.input))throw Error('La tentative a déjà enregistré un autre contenu.');
      if(!entry&&current)throw Error('Un document existe sans reçu correspondant.');
      return {receiptVersion:1,creationRequestId:args.creationRequestId,entity:args.input.entity,status:entry?current?'confirmed':'deleted':'missing',documentId:args.creationRequestId,originalResponse:entry?.response??null,currentDocument:current??null,currentItems:current?items:[],originalMatchesCurrent:entry&&current?JSON.stringify(current)===JSON.stringify(entry.response.document)&&JSON.stringify(items)===JSON.stringify(entry.response.items):null};
    }
    if(command==='save_document_with_items'){
      enforce(args);writeAttempts.push(structuredClone(args));beforeWrite?.(args);
      if(writeHold){writeEntered=true;await writeHold.promise;}enforce(args);
      if(readOnly)throw Error('Lecture seule dans la fixture fermée.');
      if(mode==='document-before')throw Error('Écriture non confirmée avant commit simulé.');
      const old=args.creationRequestId&&receipts.get(args.creationRequestId);
      if(old){if(JSON.stringify(old.input)!==JSON.stringify(args.input))throw Error('La tentative a déjà enregistré un autre contenu.');return structuredClone(old.response);}
      writes++;
      const rows=args.input.entity==='quotes'?quotes:invoices,itemRows=args.input.entity==='quotes'?quoteItems:invoiceItems;
      const id=args.input.id||args.creationRequestId||crypto.randomUUID(),row={...structuredClone(args.input.data),id,created_at:'2026-10-03T10:00:00Z'};
      if(args.input.id){const index=rows.findIndex(row=>row.id===id);if(index<0)throw Error('Closed fixture: existing record not found');rows[index]=row;}else rows.push(row);
      const resultItems=args.input.items.map((item:any,position:number)=>({...structuredClone(item),id:item.id||crypto.randomUUID(),position,[args.input.entity==='quotes'?'quote_id':'invoice_id']:id}));itemRows.push(...resultItems);
      const response={document:row,items:resultItems,...(args.creationRequestId?{creationRequestId:args.creationRequestId}:{})};
      if(args.creationRequestId)receipts.set(args.creationRequestId,{input:structuredClone(args.input),response:structuredClone(response)});
      if(mode==='document-ack-read')blocked=true;
      if(mode==='document-lost'){blocked=true;throw Error('Réponse du document perdue après commit simulé.');}
      return response;
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
  workspace=await desktopApi.loadWorkspace();reads=[];
  container=document.createElement('div');container.id='root';document.body.append(container);root=createRoot(container);
  await reactAct(async()=>root!.render(<Host/>));await settle();
});
afterEach(async()=>{writeHold?.resolve(undefined);readHold?.resolve(undefined);probeHold?.resolve(undefined);if(root)await reactAct(async()=>root!.unmount());root=undefined;container?.remove();await setAppLanguage('fr');expect(externalRequests).toBe(0);expect((globalThis as any).__quickClientImportRequests||0).toBe(0);vi.unstubAllGlobals();vi.restoreAllMocks();});


vi.hoisted(()=>{
  (globalThis as any).__quickClientImportRequests=0;
  Object.defineProperty(window,'matchMedia',{configurable:true,value:()=>({matches:false,addEventListener:()=>{},removeEventListener:()=>{},addListener:()=>{},removeListener:()=>{}})});
  HTMLElement.prototype.scrollIntoView=()=>{};window.scrollTo=()=>{};
  (globalThis as any).ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};
  globalThis.fetch=async()=>{(globalThis as any).__quickClientImportRequests++;throw Error('External fetch forbidden during maintained quick-client test import.');};
});

async function readyDocument(entity:'quotes'|'invoices'='quotes'){
 if(buttons('Découvrir plus tard').length)await click('Découvrir plus tard');await prepareQuick(entity);await addQuick();await closeDocument();
 const key=draftKeys()[0],raw=JSON.parse(localStorage.getItem(key)!);
 raw.value.lines=[{id:'held-line',catalogItemId:null,description:'Prestation de recette',quantity:1,unit:'forfait',unitPriceCents:10000,discountBp:0,vatRateBp:0}];
 raw.value.numberInputs={'held-line-quantity':'1','held-line-price':'100','held-line-discount':'0'};raw.value.step=3;raw.value.issueDate='2026-10-03';raw.value.dueDate='2026-11-02';
 if(entity==='invoices'){raw.value.invoiceType='standard';raw.value.serviceDateFrom='2026-10-01';raw.value.serviceDateTo='2026-10-03';}
 localStorage.setItem(key,JSON.stringify(raw));await click(entity==='quotes'?'Nouveau devis':'Nouvelle facture');await until(()=>buttons(draftText('Reprendre ma saisie')).length>0);await click(draftText('Reprendre ma saisie'));
 writes=0;writeAttempts=[];reads=[];publications=[];
 return key;
}
async function loseAcknowledgement(entity:'quotes'|'invoices'='quotes'){await readyDocument(entity);mode='document-lost';await click('Enregistrer le brouillon');await until(()=>writes===1);mode='';blocked=false;probeCalls=[];return draftValue().documentCreationRequest;}
describe('durable document creation, actual WorkspaceApp/DocumentEditor/provider/bridge',()=>{
 it.each(['quotes','invoices'] as const)('lost %s ACK locks edits and repeat submit; pure explicit probe keeps one row',async(entity)=>{
   const request=await loseAcknowledgement(entity),first=(entity==='quotes'?quotes:invoices)[0].id;
   expect(request.creationRequestId).toBe(first);expect(request.input.id).toBeNull();expect(JSON.stringify(request)).not.toContain(nonceA);expect(request.companyId).toBe(scope);expect(request.memberId).toBe(member);
   expect(document.querySelector<HTMLInputElement>('[name="title"]')!.matches(':disabled')).toBe(true);await click('Enregistrer le brouillon');expect(writeAttempts).toHaveLength(1);
   reads=[];publications=[];await click(documentCreationText.fr.probe);
   expect(probeCalls).toHaveLength(1);expect(reads).toHaveLength(0);expect(publications).toHaveLength(0);expect((entity==='quotes'?quotes:invoices).map(row=>row.id)).toEqual([first]);
   expect(probeCalls[0].input).toEqual(request.input);expect(probeCalls[0].expectedMemberContextNonce).toBe(nonceA);expect(document.body.textContent).toContain(documentCreationText.fr.confirmed);
   await click(documentCreationText.fr.finish);expect(draftKeys()).toHaveLength(0);expect(writeAttempts).toHaveLength(1);
 });
 it.each(['quotes','invoices'] as const)('restart/restoration keeps the exact %s input and UUID without replay; fresh nonce probe',async(entity)=>{
   const request=await loseAcknowledgement(entity);await restart();nativeNonce=nonceB;await reactAct(async()=>exposed.setNonce(nonceB));await settle();
   await click('Ventes');if(entity==='invoices')await click('Factures');await click(entity==='quotes'?'Nouveau devis':'Nouvelle facture');await click(draftText('Reprendre ma saisie'));
   expect(writeAttempts).toHaveLength(1);expect(probeCalls).toHaveLength(0);expect(draftValue().documentCreationRequest).toEqual(request);
   reads=[];await click(documentCreationText.fr.probe);expect(probeCalls[0].input).toEqual(request.input);expect(probeCalls[0].creationRequestId).toBe(request.creationRequestId);expect(probeCalls[0].expectedMemberContextNonce).toBe(nonceB);expect(reads).toHaveLength(0);expect(writes).toBe(1);
 });
 it('a missing local receipt permits only an explicit exact-input retry, never ID-as-update',async()=>{
   await readyDocument();mode='document-before';await click('Enregistrer le brouillon');const request=draftValue().documentCreationRequest;expect(writes).toBe(0);mode='';reads=[];
   await click(documentCreationText.fr.probe);expect(writes).toBe(0);expect(reads).toHaveLength(0);expect(document.body.textContent).toContain(documentCreationText.fr.missing);
   await click(documentCreationText.fr.retry);expect(writes).toBe(1);expect(writeAttempts).toHaveLength(2);expect(writeAttempts[0].input).toEqual(writeAttempts[1].input);expect(writeAttempts.every(args=>args.input.id===null&&args.creationRequestId===request.creationRequestId)).toBe(true);expect(draftKeys()).toHaveLength(0);
 });
 it('deleted receipt never exposes resend and never recreates the document',async()=>{
   await loseAcknowledgement();quotes=[];await click(documentCreationText.fr.probe);expect(document.body.textContent).toContain(documentCreationText.fr.deleted);expect(buttons(documentCreationText.fr.retry)).toHaveLength(0);expect(writeAttempts).toHaveLength(1);
   await click(documentCreationText.fr.finish);expect(draftKeys()).toHaveLength(0);expect(quotes).toHaveLength(0);
 });
 it('confirmation keeps the immutable initial response distinct from later current content',async()=>{
   await loseAcknowledgement();quotes[0].title='Titre modifié ensuite';await click(documentCreationText.fr.probe);
   expect(document.body.textContent).toContain(documentCreationText.fr.changed);const panel=document.querySelector('[data-document-creation-receipt]')!;expect(panel.textContent).toContain('Travaux témoins');expect(panel.textContent).toContain('Titre modifié ensuite');expect(writes).toBe(1);
 });
 it('probe works while writes are read-only and makes no app-state/workspace read',async()=>{
   await loseAcknowledgement();readOnly=true;await reactAct(async()=>exposed.setReadOnly(true));await settle();reads=[];publications=[];
   await click(documentCreationText.fr.probe);expect(probeCalls).toHaveLength(1);expect(reads).toHaveLength(0);expect(publications).toHaveLength(0);expect(document.body.textContent).toContain(documentCreationText.fr.confirmed);expect(writes).toBe(1);
 });
 it('provider A→B→A while pure probe is held rejects the old response, even with the same physical space',async()=>{
   await loseAcknowledgement();probeHold=deferred();await click(documentCreationText.fr.probe);await until(()=>probeEntered);
   await reactAct(async()=>exposed.setNonce(nonceB));await settle();await reactAct(async()=>exposed.setNonce(nonceA));await settle();probeHold.resolve(undefined);await settle();
   expect(document.body.textContent).not.toContain(documentCreationText.fr.confirmed);expect(document.body.textContent).toContain('compte');expect(draftKeys()).toHaveLength(1);expect(writes).toBe(1);
 });
 it.each(['physical','member'] as const)('native %s probe guard is terminal, with draft intact and no replay',async(kind)=>{
   await loseAcknowledgement();if(kind==='physical')nativeScope='other-company';else nativeNonce=nonceB;reads=[];
   await click(documentCreationText.fr.probe);expect(document.body.textContent).not.toContain(documentCreationText.fr.confirmed);expect(draftKeys()).toHaveLength(1);expect(reads).toHaveLength(0);expect(writes).toBe(1);
 });
 it('local final-capture failure sends no document, and local retry sends no IPC',async()=>{
   await readyDocument();const key=draftKeys()[0],before=localStorage.getItem(key);const real=Storage.prototype.setItem;
   const failure=vi.spyOn(Storage.prototype,'setItem').mockImplementation(function(this:Storage,k:string,v:string){if(k===key)throw Error('Synthetic local quota');return real.call(this,k,v);});
   await click('Enregistrer le brouillon');expect(writeAttempts).toHaveLength(0);expect(localStorage.getItem(key)).toBe(before);expect(document.body.textContent).toContain(documentCreationText.fr.storage);
   reads=[];probeCalls=[];failure.mockRestore();await click(documentCreationText.fr.localRetry);expect(writeAttempts).toHaveLength(0);expect(reads).toHaveLength(0);expect(probeCalls).toHaveLength(0);
 });
 it('last DOM title and notes are captured before write even before React onChange',async()=>{
   await readyDocument();await change('title','Dernier titre sans event',false);await change('notes','Dernières notes sans event',false);mode='document-lost';
   await click('Enregistrer le brouillon');expect(writeAttempts).toHaveLength(1);expect(writeAttempts[0].input.data.title).toBe('Dernier titre sans event');expect(writeAttempts[0].input.data.notes).toBe('Dernières notes sans event');expect(draftValue().documentCreationRequest.input).toEqual(writeAttempts[0].input);
 });
 it('legacy document without durable ID requires explicit preparation and sends nothing on restore',async()=>{
   await readyDocument();await closeDocument();const key=draftKeys()[0],raw=JSON.parse(localStorage.getItem(key)!);delete raw.value.documentCreationId;localStorage.setItem(key,JSON.stringify(raw));await click('Nouveau devis');await click(draftText('Reprendre ma saisie'));
   expect(document.body.textContent).toContain(documentCreationText.fr.legacy);expect(writeAttempts).toHaveLength(0);await click('Enregistrer le brouillon');expect(writeAttempts).toHaveLength(0);await click(documentCreationText.fr.prepare);expect(draftValue().documentCreationId).toMatch(/^[a-f0-9-]{36}$/);expect(writeAttempts).toHaveLength(0);
 });
 it('the exact UUID/input are durably read back before the first native creation',async()=>{
   const key=await readyDocument();beforeWrite=args=>{const current=JSON.parse(localStorage.getItem(key)!).value;expect(current.documentCreationId).toBe(args.creationRequestId);expect(current.documentCreationRequest.input).toEqual(args.input);expect(current.documentCreationRequest).not.toHaveProperty('memberContextNonce');};
   await click('Enregistrer le brouillon');expect(writeAttempts).toHaveLength(1);expect(draftKeys()).toHaveLength(0);
 });
 it('a latest unrendered numeric price is captured and totals are recomputed with the existing engine',async()=>{
   await readyDocument();const price=document.querySelector<HTMLInputElement>('[data-document-number-id="held-line-price"]')!;await reactAct(async()=>Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(price,'160'));mode='document-lost';
   await click('Enregistrer le brouillon');expect(writeAttempts[0].input.items[0].unit_price_cents).toBe(16000);expect(writeAttempts[0].input.data.total_cents).toBe(16000);expect(draftValue().numberInputs['held-line-price']).toBe('160');
 });
 it('preflight missing handler blocks an older save handler that would ignore the request ID',async()=>{
   await readyDocument();const implementation=transport.invoke.getMockImplementation()!;transport.invoke.mockImplementation(async(command:string,args:any)=>{if(command==='get_document_creation_receipt')throw 'Command get_document_creation_receipt not found';return implementation(command,args);});
   await click('Enregistrer le brouillon');expect(writes).toBe(0);expect(writeAttempts).toHaveLength(0);expect(draftValue().documentCreationRequest).toBeDefined();
 });
 it('a changed provider after held preflight rejects before native write, including A→B→A',async()=>{
   await readyDocument();probeHold=deferred();await click('Enregistrer le brouillon');await until(()=>probeEntered);await reactAct(async()=>exposed.setNonce(nonceB));await settle();await reactAct(async()=>exposed.setNonce(nonceA));await settle();probeHold.resolve(undefined);await settle();
   expect(writes).toBe(0);expect(writeAttempts).toHaveLength(0);expect(draftKeys()).toHaveLength(1);expect(document.querySelector('[role="dialog"] form')).not.toBeNull();
 });
 it('ACK followed by unavailable workspace read recovers by reads without resending',async()=>{
   await readyDocument();mode='document-ack-read';await click('Enregistrer le brouillon');await until(()=>buttons('Actualiser les données').length>0);expect(writes).toBe(1);expect(writeAttempts).toHaveLength(1);blocked=false;mode='';await click('Actualiser les données');await settle();
   expect(writeAttempts).toHaveLength(1);expect(draftKeys()).toHaveLength(0);expect(document.querySelector('[data-document-creation-receipt]')).toBeNull();
 });
 it('explicit refresh after confirmation is separate, guarded, and does not resend creation',async()=>{
   await loseAcknowledgement();await click(documentCreationText.fr.probe);reads=[];publications=[];await click(documentCreationText.fr.refresh);
   expect(reads.map(read=>read.command)).toEqual(['get_app_state','get_workspace']);expect(reads.every(read=>read.args.expectedWorkspaceScope===scope&&read.args.expectedMemberContextNonce===nonceA)).toBe(true);expect(publications).toHaveLength(1);expect(writeAttempts).toHaveLength(1);expect(draftKeys()).toHaveLength(1);
 });
 it('failed explicit refresh preserves the proof and draft without reporting a new creation',async()=>{
   await loseAcknowledgement();await click(documentCreationText.fr.probe);blocked=true;publications=[];await click(documentCreationText.fr.refresh);
   expect(publications).toHaveLength(0);expect(draftKeys()).toHaveLength(1);expect(writeAttempts).toHaveLength(1);expect(document.body.textContent).toContain(documentCreationText.fr.confirmed);
 });
 it.each(['fr','de','it','en'] as const)('real receipt guide remains available in %s with local language assets only',async(language)=>{
   await loseAcknowledgement();const allowed=new Set(Object.values(languageAssets));vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{if(!allowed.has(String(input))){externalRequests++;throw Error('External request forbidden.');}return {ok:true,json:async()=>({'QA local pack':'QA local pack'})} as Response;}));
   await reactAct(async()=>{expect(await setAppLanguage(language)).toBe(true);});await settle();expect(document.body.textContent).toContain(documentCreationText[language].instruction);await click(documentCreationText[language].probe);expect(document.body.textContent).toContain(documentCreationText[language].confirmed);expect(writes).toBe(1);
 });
 it.each(['physical','member'] as const)('held first %s native creation guard rejects before commit and releases the form',async(kind)=>{
   await readyDocument();writeHold=deferred();await click('Enregistrer le brouillon');await until(()=>writeEntered);if(kind==='physical')nativeScope='other-company';else nativeNonce=nonceB;writeHold.resolve(undefined);await settle();
   expect(writes).toBe(0);expect(publications).toHaveLength(0);expect(draftKeys()).toHaveLength(1);expect(buttons(documentCreationText.fr.probe)[0].disabled).toBe(false);expect(buttons('Actualiser les données')).toHaveLength(0);
 });
 it('member changes after ACK during refresh keep the request and never publish another member data',async()=>{
   await readyDocument();beforeWrite=()=>{readHold=deferred();};await click('Enregistrer le brouillon');await until(()=>readEntered);nativeNonce=nonceB;await reactAct(async()=>exposed.setNonce(nonceB));await settle();readHold!.resolve(undefined);await settle();
   expect(writes).toBe(1);expect(publications).toHaveLength(0);expect(draftKeys()).toHaveLength(1);expect(buttons('Actualiser les données')).toHaveLength(0);expect(buttons(documentCreationText.fr.probe)[0].disabled).toBe(false);
 });
 it('request storage readback mismatch prevents the write; retry remains local',async()=>{
   const key=await readyDocument(),before=localStorage.getItem(key),realGet=Storage.prototype.getItem;let requestStored=false;
   const set=Storage.prototype.setItem;const write=vi.spyOn(Storage.prototype,'setItem').mockImplementation(function(this:Storage,k:string,v:string){set.call(this,k,v);if(k===key&&JSON.parse(v).value?.documentCreationRequest)requestStored=true;});
   const read=vi.spyOn(Storage.prototype,'getItem').mockImplementation(function(this:Storage,k:string){return k===key&&requestStored?before:realGet.call(this,k);});
   await click('Enregistrer le brouillon');expect(requestStored).toBe(true);expect(writeAttempts).toHaveLength(0);expect(probeCalls).toHaveLength(0);read.mockRestore();write.mockRestore();reads=[];await click(documentCreationText.fr.localRetry);expect(writeAttempts).toHaveLength(0);expect(reads).toHaveLength(0);expect(probeCalls).toHaveLength(0);
 });
 it('failed abandonment retains the UUID and dialog; verified abandonment closes before fresh identity',async()=>{
   const request=await loseAcknowledgement();vi.spyOn(window,'confirm').mockReturnValue(true);const remove=Storage.prototype.removeItem;
   const failure=vi.spyOn(Storage.prototype,'removeItem').mockImplementation(function(this:Storage,k:string){if(k.startsWith(FORM_DRAFT_PREFIX))throw Error('Synthetic removal denied');remove.call(this,k);});
   await click(draftText('Abandonner le brouillon'));expect(document.querySelector('[role="dialog"] form')).not.toBeNull();expect(draftValue().documentCreationId).toBe(request.creationRequestId);failure.mockRestore();await click(draftText('Abandonner le brouillon'));expect(document.querySelector('[role="dialog"] form')).toBeNull();await click('Nouveau devis');await change('title','Nouvelle saisie');expect(draftValue().documentCreationId).not.toBe(request.creationRequestId);expect(writes).toBe(1);
 });
});

import {userErrorCopy} from './userErrors';
describe('actual lost-confirmation document guidance',()=>{
 it.each(['fr','de','it','en'] as const)('renders uncertainty rather than field validation in %s without replay',async(language)=>{
   const request=await loseAcknowledgement(),stored=localStorage.getItem(draftKeys()[0]);
   const allowed=new Set(Object.values(languageAssets));vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{if(!allowed.has(String(input))){externalRequests++;throw Error('External request forbidden.');}return {ok:true,json:async()=>({'QA local pack':'QA local pack'})} as Response;}));
   await reactAct(async()=>{expect(await setAppLanguage(language)).toBe(true);});await settle();
   const guide=document.querySelector('[role="dialog"] .error-guidance')!;
   expect(guide).not.toBeNull();expect(guide.textContent).toContain(userErrorCopy(language).documentCreationUnknown.title);expect(guide.textContent).toContain(userErrorCopy(language).documentCreationUnknown.message);expect(guide.textContent).toContain(userErrorCopy(language).documentCreationUnknown.action);
   expect(guide.textContent).not.toContain(userErrorCopy(language).validation.title);expect(guide.textContent).not.toContain(userErrorCopy(language).validation.action);
   expect(guide.querySelector('.error-guidance__actions')).toBeNull();
   expect(document.querySelector('[data-document-creation-receipt]')!.textContent).toContain(documentCreationText[language].instruction);
   await settle();expect(writeAttempts).toHaveLength(1);expect(writes).toBe(1);expect(probeCalls).toHaveLength(0);expect(draftValue().documentCreationRequest).toEqual(request);expect(localStorage.getItem(draftKeys()[0])).toBe(stored);
   expect(guide.querySelector('.error-guidance__incident code')!.textContent).toMatch(/^ZT-/);
 });
});
