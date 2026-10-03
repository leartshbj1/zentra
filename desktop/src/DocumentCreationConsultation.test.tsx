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
import {documentConsultationText} from './documentCreationConsultation';
import {formDraftKey,FORM_DRAFT_COMPLETED_PREFIX,formDraftFingerprint} from './formDrafts';

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
function Host(){const [current,setCurrent]=useState(workspace);const [nonce,setNonce]=useState<string|undefined>(nonceA);const [ro,setReadOnly]=useState(readOnly);const [who,setMember]=useState(member),[company,setCompany]=useState(scope);exposed={setNonce,setCurrent,setReadOnly,setMember,setCompany};return <FormDraftIdentityProvider companyId={company} organizationId="org-témoin" memberId={who} memberContextNonce={nonce} ready><ZentraAssistantProvider><WorkspaceApp readOnly={ro} workspace={current} setWorkspace={next=>{if(next&&typeof next!=='function'){publications.push(next);setCurrent(next);}}}/></ZentraAssistantProvider></FormDraftIdentityProvider>;}
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

async function prepareConsultation(entity:'quotes'|'invoices'='quotes'){
 const request=await loseAcknowledgement(entity);readOnly=true;await restart();nativeNonce=nonceB;await reactAct(async()=>exposed.setNonce(nonceB));await settle();await click('Ventes');if(entity==='invoices')await click('Factures');
 reads=[];publications=[];probeCalls=[];transport.invoke.mockClear();return request;
}
function trackStorage(){const set=vi.spyOn(Storage.prototype,'setItem'),remove=vi.spyOn(Storage.prototype,'removeItem');return {set,remove,verify:()=>{expect(set).not.toHaveBeenCalled();expect(remove).not.toHaveBeenCalled();}};}
async function openConsultation(){await click(documentConsultationText.fr.open);await until(()=>document.querySelector('[data-document-creation-consultation]')!==null);}
describe('read-only retained document consultation, actual ReactDOM WorkspaceApp and bridge',()=>{
 it.each(['quotes','invoices'] as const)('restart read-only %s entry permits only explicit pure restoration/probe/close, zero local writes',async(entity)=>{
  const request=await prepareConsultation(entity),key=draftKeys()[0],before=localStorage.getItem(key),storage=trackStorage();
  expect(buttons(entity==='quotes'?'Nouveau devis':'Nouvelle facture')[0].disabled).toBe(true);await openConsultation();
  expect(probeCalls).toHaveLength(0);expect(reads).toHaveLength(0);expect(document.querySelector('[name="title"]')!.matches(':disabled')).toBe(true);expect(buttons(draftText('Abandonner le brouillon'))).toHaveLength(0);
  await click(draftText('Reprendre ma saisie'));expect(probeCalls).toHaveLength(0);expect(reads).toHaveLength(0);expect(localStorage.getItem(key)).toBe(before);expect(draftValue().documentCreationRequest).toEqual(request);
  expect(buttons('Enregistrer le brouillon')).toHaveLength(0);expect(buttons(documentCreationText.fr.finish)).toHaveLength(0);expect(buttons(documentCreationText.fr.refresh)).toHaveLength(0);
  await change('title','Tentative de modification');expect(localStorage.getItem(key)).toBe(before);
  await click(documentCreationText.fr.probe);expect(probeCalls).toHaveLength(1);expect(probeCalls[0].input).toEqual(request.input);expect(probeCalls[0].expectedMemberContextNonce).toBe(nonceB);expect(reads).toHaveLength(0);expect(publications).toHaveLength(0);expect(writeAttempts).toHaveLength(1);
  expect(buttons(documentCreationText.fr.finish)).toHaveLength(0);expect(buttons(documentCreationText.fr.refresh)).toHaveLength(0);await click(documentConsultationText.fr.close);expect(document.querySelector('[data-document-creation-consultation]')).toBeNull();expect(localStorage.getItem(key)).toBe(before);storage.verify();
  expect(transport.invoke.mock.calls.map(call=>call[0])).toEqual(['get_document_creation_receipt']);
 });
 it.each(['missing','deleted'] as const)('read-only %s proof never permits write, completion, marker or refresh',async(status)=>{
  const request=await prepareConsultation();if(status==='missing'){receipts.clear();quotes=[];}else quotes=[];
  const before=localStorage.getItem(draftKeys()[0]),storage=trackStorage();await openConsultation();await click(draftText('Reprendre ma saisie'));await click(documentCreationText.fr.probe);
  expect(document.body.textContent).toContain(status==='missing'?documentConsultationText.fr.missing:documentCreationText.fr.deleted);expect(buttons(documentCreationText.fr.retry)).toHaveLength(0);expect(buttons(documentCreationText.fr.finish)).toHaveLength(0);expect(buttons(documentCreationText.fr.refresh)).toHaveLength(0);expect(writeAttempts).toHaveLength(1);expect(reads).toHaveLength(0);expect(draftValue().documentCreationId).toBe(request.creationRequestId);await closeDocument();expect(localStorage.getItem(draftKeys()[0])).toBe(before);storage.verify();
 });
 it.each(['draft','marker'] as const)('initial %s read failure in retained consultation can be purely reread then explicitly restored',async(kind)=>{
  await prepareConsultation();const key=draftKeys()[0],marker=key.replace(FORM_DRAFT_PREFIX,FORM_DRAFT_COMPLETED_PREFIX),before=localStorage.getItem(key),get=Storage.prototype.getItem;
  let refuse=true,opened=false;const storage=trackStorage();const failure=vi.spyOn(Storage.prototype,'getItem').mockImplementation(function(this:Storage,k:string){if(opened&&refuse&&k===(kind==='draft'?key:marker))throw Error('Synthetic read denied');return get.call(this,k);});
  opened=true;await openConsultation();expect(buttons(draftText('Relire les brouillons locaux'))[0].disabled).toBe(false);expect(buttons(draftText('Abandonner le brouillon'))).toHaveLength(0);expect(probeCalls).toHaveLength(0);
  refuse=false;await click(draftText('Relire les brouillons locaux'));expect(buttons(draftText('Reprendre ma saisie'))[0].disabled).toBe(false);expect(probeCalls).toHaveLength(0);await click(draftText('Reprendre ma saisie'));await click(documentCreationText.fr.probe);expect(probeCalls).toHaveLength(1);expect(reads).toHaveLength(0);expect(localStorage.getItem(key)).toBe(before);failure.mockRestore();storage.verify();
 });
 it('retired marker after inventory refuses restoration and never erases the retained bytes',async()=>{
  await prepareConsultation();const key=draftKeys()[0],raw=localStorage.getItem(key)!;localStorage.setItem(key.replace(FORM_DRAFT_PREFIX,FORM_DRAFT_COMPLETED_PREFIX),JSON.stringify({version:1,recordFingerprint:formDraftFingerprint(raw)}));const storage=trackStorage();await openConsultation();expect(document.body.textContent).toContain(documentConsultationText.fr.empty);expect(buttons(draftText('Reprendre ma saisie'))).toHaveLength(0);expect(buttons(documentCreationText.fr.probe)).toHaveLength(0);expect(probeCalls).toHaveLength(0);expect(reads).toHaveLength(0);expect(localStorage.getItem(key)).toBe(raw);await closeDocument();storage.verify();
 });
 it('several retained drafts require explicit choice and probe only the selected exact input',async()=>{
  await loseAcknowledgement();const key=draftKeys()[0],raw=JSON.parse(localStorage.getItem(key)!),second=structuredClone(raw),id='22222222-2222-4222-8222-222222222222';
  const scope2={companyId:scope,organizationId:'org-témoin',memberId:member,type:'quotes',context:'quote:;project:second-context'};second.scope=formDraftKey(scope2);second.value.documentCreationId=id;second.value.documentCreationRequest.creationRequestId=id;second.value.documentTitle='Seconde saisie témoin';second.value.documentCreationRequest.input.data.title='Seconde saisie témoin';localStorage.setItem(second.scope,JSON.stringify(second));
  readOnly=true;await restart();await click('Ventes');reads=[];probeCalls=[];publications=[];const storage=trackStorage();await click(documentConsultationText.fr.open);
  expect(document.body.textContent).toContain(documentConsultationText.fr.choose);expect(document.querySelectorAll('[data-document-creation-choice]')).toHaveLength(2);expect(document.querySelector('[data-document-creation-consultation]')).toBeNull();expect(probeCalls).toHaveLength(0);
  await click('Seconde saisie témoin');await click(draftText('Reprendre ma saisie'));await click(documentCreationText.fr.probe);expect(probeCalls[0].creationRequestId).toBe(id);expect(probeCalls[0].input).toEqual(second.value.documentCreationRequest.input);expect(reads).toHaveLength(0);expect(writeAttempts).toHaveLength(1);expect(localStorage.getItem(key)).toBe(JSON.stringify(raw));storage.verify();
 });
 it('provider A→B→A while consultation probe is held rejects old reply, zero local writes',async()=>{
  await prepareConsultation();const before=localStorage.getItem(draftKeys()[0]),storage=trackStorage();await openConsultation();await click(draftText('Reprendre ma saisie'));probeHold=deferred();await click(documentCreationText.fr.probe);await until(()=>probeEntered);
  await reactAct(async()=>exposed.setNonce(nonceA));await settle();await reactAct(async()=>exposed.setNonce(nonceB));await settle();probeHold.resolve(undefined);await settle();expect(document.body.textContent).not.toContain(documentCreationText.fr.confirmed);expect(reads).toHaveLength(0);expect(publications).toHaveLength(0);expect(localStorage.getItem(draftKeys()[0])).toBe(before);storage.verify();
 });
 it.each(['physical','member'] as const)('native %s guard on consultation probe preserves retained entry and releases controls',async(kind)=>{
  await prepareConsultation();const before=localStorage.getItem(draftKeys()[0]),storage=trackStorage();await openConsultation();await click(draftText('Reprendre ma saisie'));if(kind==='physical')nativeScope='other-company';else nativeNonce=nonceA;
  await click(documentCreationText.fr.probe);expect(document.body.textContent).not.toContain(documentCreationText.fr.confirmed);expect(buttons(documentCreationText.fr.probe)[0].disabled).toBe(false);expect(reads).toHaveLength(0);expect(localStorage.getItem(draftKeys()[0])).toBe(before);storage.verify();
 });
 it.each(['fr','de','it','en'] as const)('real read-only consultation guide and probe in %s do not mutate local storage',async(language)=>{
  await prepareConsultation();const allowed=new Set(Object.values(languageAssets));vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{if(!allowed.has(String(input))){externalRequests++;throw Error('External request forbidden.');}return {ok:true,json:async()=>({'QA local pack':'QA local pack'})} as Response;}));
  await reactAct(async()=>{expect(await setAppLanguage(language)).toBe(true);});await settle();const before=localStorage.getItem(draftKeys()[0]),storage=trackStorage();await click(documentConsultationText[language].open);expect(document.body.textContent).toContain(documentConsultationText[language].intro);await click(draftText('Reprendre ma saisie'));await click(documentCreationText[language].probe);expect(document.body.textContent).toContain(documentCreationText[language].confirmed);await click(documentConsultationText[language].close);expect(localStorage.getItem(draftKeys()[0])).toBe(before);expect(reads).toHaveLength(0);storage.verify();
 });
 it('ACK and read confirmed with failed completion storage remains truthful, retains request and never replays',async()=>{
  await readyDocument();beforeWrite=()=>{const set=Storage.prototype.setItem,remove=Storage.prototype.removeItem;vi.spyOn(Storage.prototype,'setItem').mockImplementation(function(this:Storage,key:string,value:string){if(key.startsWith(FORM_DRAFT_PREFIX)||key.startsWith(FORM_DRAFT_COMPLETED_PREFIX))throw Error('Completion storage denied');return set.call(this,key,value);});vi.spyOn(Storage.prototype,'removeItem').mockImplementation(function(this:Storage,key:string){if(key.startsWith(FORM_DRAFT_PREFIX)||key.startsWith(FORM_DRAFT_COMPLETED_PREFIX))throw Error('Completion remove denied');return remove.call(this,key);});};
  await click('Enregistrer le brouillon');expect(writes).toBe(1);expect(writeAttempts).toHaveLength(1);expect(draftKeys()).toHaveLength(1);expect(draftValue().documentCreationRequest).toBeDefined();expect(document.body.textContent).toContain(documentCreationText.fr.confirmed);expect(document.body.textContent).not.toContain('Aucun document n’a été envoyé');expect(document.body.textContent).toContain(documentCreationText.fr.storage);await click('Enregistrer le brouillon');expect(writeAttempts).toHaveLength(1);
 });

 it('consultation stays read-only when the parent later restores write access',async()=>{
  await prepareConsultation();const before=localStorage.getItem(draftKeys()[0]),storage=trackStorage();await openConsultation();await click(draftText('Reprendre ma saisie'));await reactAct(async()=>exposed.setReadOnly(false));await settle();expect(document.querySelector('[name="title"]')!.matches(':disabled')).toBe(true);expect(buttons('Enregistrer le brouillon')).toHaveLength(0);expect(buttons(documentCreationText.fr.finish)).toHaveLength(0);expect(buttons(draftText('Abandonner le brouillon'))).toHaveLength(0);await change('notes','Tentative readonly');await click(documentCreationText.fr.probe);expect(reads).toHaveLength(0);expect(localStorage.getItem(draftKeys()[0])).toBe(before);storage.verify();
 });
 it.each(['company','member'] as const)('different %s provider hides the old consultation and cannot probe its request',async(kind)=>{
  await prepareConsultation();const before=localStorage.getItem(draftKeys()[0]),storage=trackStorage();await openConsultation();await click(draftText('Reprendre ma saisie'));await reactAct(async()=>kind==='company'?exposed.setCompany('other-company'):exposed.setMember('other-member'));await settle();expect(document.querySelector('[name="title"]')).toBeNull();expect(document.body.textContent).toContain(documentConsultationText.fr.empty);expect(buttons(documentCreationText.fr.probe)).toHaveLength(0);expect(probeCalls).toHaveLength(0);expect(reads).toHaveLength(0);expect(localStorage.getItem(draftKeys()[0])).toBe(before);storage.verify();
 });

});
