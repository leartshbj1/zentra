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

describe('actual EmployeeForm durable creation with WorkspaceApp.act and guarded bridge',()=>{
  it('captures the final DOM snapshot and stable hidden UUID before native creation, then retires only confirmed success',async()=>{
    await prepareEmployee();const id=draftValue().creationId;expect(id).toMatch(/^[a-f\d-]{36}$/i);
    await change('notes','Dernière frappe non rendue',false);
    beforeWrite=args=>{expect(draftValue().creationId).toBe(id);expect(draftValue().notes).toBe('Dernière frappe non rendue');expect(args.data.id).toBe(id);expect(args.data.notes).toBe('Dernière frappe non rendue');};
    await submit();await until(()=>document.querySelector('[role="dialog"] form')===null);expect(writes).toBe(1);expect(publications).toHaveLength(1);expect(draftKeys()).toHaveLength(0);expect(document.body.textContent).toContain('Le collaborateur a été ajouté.');expect(writeAttempts[0].expectedWorkspaceScope).toBe(scope);expect(writeAttempts[0].expectedMemberContextNonce).toBe(nonceA);expect(reads.every(read=>read.args.expectedMemberContextNonce===nonceA)).toBe(true);
  });
  it('reopens a retained creation draft with the original UUID and controlled salary, then submits that same ID',async()=>{
    await prepareEmployee();const id=draftValue().creationId;await closeEmployee();expect(draftKeys()).toHaveLength(1);await restoreEmployee();expect(draftValue().creationId).toBe(id);expect(document.querySelector<HTMLInputElement>('[name="grossSalary"]')!.value).toBe('6000');expect(document.querySelector<HTMLSelectElement>('[name="salaryMode"]')!.value).toBe('monthly');expect(writes).toBe(0);await submit();await until(()=>document.querySelector('[role="dialog"] form')===null);expect(employees[0].id).toBe(id);expect(employees[0].monthly_salary_cents).toBe(600000);
  });
  it('does not claim ID-only success after a lost ACK, changed name and salary, closure and retry',async()=>{
    mode='lost';await prepareEmployee();const id=draftValue().creationId;await submit();expect(writes).toBe(1);verifyNoRetirement();expect(document.querySelector('[data-employee-creation-recovery]')?.textContent).toContain('Vérifiez la liste');expect(buttons('Vérifier maintenant')).toHaveLength(0);await change('name','Nom modifié après réponse perdue');await change('grossSalary','7000');await closeEmployee();blocked=false;mode='';await restoreEmployee();expect(draftValue().creationId).toBe(id);await submit();verifyNoRetirement(true);expect(writes).toBe(1);expect(writeAttempts).toHaveLength(1);expect(employees[0].name).toBe('Alex Témoin');expect(employees[0].monthly_salary_cents).toBe(600000);expect(draftValue().name).toBe('Nom modifié après réponse perdue');expect(document.body.textContent).toContain('Cet élément existe déjà');
  });
  it('keeps the same UUID when an uncommitted failed creation is explicitly tried again',async()=>{
    mode='before-commit';await prepareEmployee();const id=draftValue().creationId;await submit();expect(writes).toBe(0);verifyNoRetirement(true);expect(writeAttempts).toHaveLength(1);mode='';await submit();await until(()=>document.querySelector('[role="dialog"] form')===null);expect(writes).toBe(1);expect(writeAttempts).toHaveLength(2);expect(writeAttempts.map(row=>row.data.id)).toEqual([id,id]);
  });
  it('sends at most one write for two submissions while native creation is held',async()=>{
    await prepareEmployee();const id=draftValue().creationId;writeHold=deferred();await submit();await until(()=>writeEntered);await submit();expect(writeAttempts).toHaveLength(1);expect(draftValue().creationId).toBe(id);await reactAct(async()=>writeHold!.resolve(undefined));await until(()=>document.querySelector('[role="dialog"] form')===null);expect(writes).toBe(1);expect(publications).toHaveLength(1);
  });
  it('blocks failed final local storage, retries storage only, and preserves the last DOM values and UUID',async()=>{
    await prepareEmployee();const id=draftValue().creationId;await change('notes','Saisie finale sans événement',false);const original=Storage.prototype.setItem;const failed=vi.spyOn(Storage.prototype,'setItem').mockImplementation(function(this:Storage,key,value){if(key.startsWith(FORM_DRAFT_PREFIX))throw new DOMException('Capture blocked','QuotaExceededError');original.call(this,key,value);});await submit();expect(writes).toBe(0);expect(writeAttempts).toHaveLength(0);expect(document.querySelector('[data-employee-storage-recovery]')?.textContent).toContain('sauvegarde locale');expect(draftValue().creationId).toBe(id);failed.mockRestore();await click('Réessayer la sauvegarde locale');expect(writeAttempts).toHaveLength(0);expect(draftValue().notes).toBe('Saisie finale sans événement');expect(draftValue().creationId).toBe(id);expect(document.querySelector('[data-employee-storage-recovery]')).toBeNull();await submit();await until(()=>document.querySelector('[role="dialog"] form')===null);expect(writes).toBe(1);expect(employees[0].id).toBe(id);
  });
  it('blocks a successful setItem with a failed immediate readback before every native write',async()=>{
    await prepareEmployee();const id=draftValue().creationId;const original=Storage.prototype.getItem;const failed=vi.spyOn(Storage.prototype,'getItem').mockImplementation(function(this:Storage,key){if(key.startsWith(FORM_DRAFT_PREFIX))throw new DOMException('Readback blocked','SecurityError');return original.call(this,key);});await submit();expect(writes).toBe(0);expect(writeAttempts).toHaveLength(0);expect(document.querySelector('[data-employee-storage-recovery]')).not.toBeNull();failed.mockRestore();expect(draftValue().creationId).toBe(id);await click('Réessayer la sauvegarde locale');expect(writes).toBe(0);expect(writeAttempts).toHaveLength(0);expect(document.querySelector('[data-employee-storage-recovery]')).toBeNull();
  });
  it('does not rotate an ID or close on failed discard and closes only after verified deletion',async()=>{
    await prepareEmployee();const id=draftValue().creationId;vi.spyOn(window,'confirm').mockReturnValue(true);const original=Storage.prototype.removeItem;const failed=vi.spyOn(Storage.prototype,'removeItem').mockImplementation(function(this:Storage,key){if(key.startsWith(FORM_DRAFT_PREFIX))throw new DOMException('Deletion blocked','SecurityError');original.call(this,key);});await click('Abandonner le brouillon');expect(document.querySelector('[role="dialog"] form')).not.toBeNull();expect(draftValue().creationId).toBe(id);expect(writes).toBe(0);failed.mockRestore();await click('Abandonner le brouillon');await until(()=>document.querySelector('[role="dialog"] form')===null);expect(draftKeys()).toHaveLength(0);await openEmployee();await change('name','Autre personne');await change('role','Architecte');expect(draftValue().creationId).not.toBe(id);expect(writes).toBe(0);
  });
  it('requires an explicit decision for a legacy draft without a creation ID before any write',async()=>{
    await prepareEmployee();const id=draftValue().creationId,key=draftKeys()[0];await closeEmployee();const stored=JSON.parse(localStorage.getItem(key)!);delete stored.value.creationId;localStorage.setItem(key,JSON.stringify(stored));await restoreEmployee();expect(document.querySelector('[data-employee-legacy-creation]')?.textContent).toContain('Vérifiez la liste');await submit();expect(writeAttempts).toHaveLength(0);expect(draftValue().creationId).toBeUndefined();await click('Préparer une nouvelle fiche');const next=draftValue().creationId;expect(next).toMatch(/^[a-f\d-]{36}$/i);expect(next).not.toBe(id);expect(writes).toBe(0);expect(document.querySelector('[data-employee-legacy-creation]')).toBeNull();await submit();await until(()=>document.querySelector('[role="dialog"] form')===null);expect(employees[0].id).toBe(next);
  });
  it('rejects a malformed stored creation ID without repairing it silently or sending native creation',async()=>{
    await prepareEmployee();const key=draftKeys()[0];await closeEmployee();const stored=JSON.parse(localStorage.getItem(key)!);stored.value.creationId='not-a-uuid';localStorage.setItem(key,JSON.stringify(stored));await click('Nouvelle fiche de personnel');await until(()=>document.querySelector('[role="dialog"] form')!==null);expect(document.body.textContent).toContain('brouillon');await submit();expect(writeAttempts).toHaveLength(0);expect(JSON.parse(localStorage.getItem(key)!).value.creationId).toBe('not-a-uuid');expect(document.querySelector<HTMLButtonElement>('[role="dialog"] button[type="submit"]')!.disabled).toBe(true);
  });
  it('guards the original physical workspace before held native creation and leaves a visible recovery guide',async()=>{
    await prepareEmployee();const id=draftValue().creationId;writeHold=deferred();await submit();await until(()=>writeEntered);nativeScope='other-workspace';await reactAct(async()=>writeHold!.resolve(undefined));// Frozen 11a uses the conservative creation guide; the independently reviewed physical bridge guard uses the company guide.
    await until(()=>document.querySelector('[data-employee-creation-recovery]')!==null || (document.body.textContent?.includes('Rouvrez cette action dans la bonne entreprise')??false));expect(buttons('Vérifier maintenant')).toHaveLength(0);expect(document.querySelector<HTMLButtonElement>('[role="dialog"] button[type="submit"]')!.disabled).toBe(false);expect(writes).toBe(0);verifyNoRetirement();expect(draftValue().creationId).toBe(id);expect(writeAttempts[0].expectedWorkspaceScope).toBe(scope);
  });
  it('guards the original member nonce before held creation and keeps the durable draft',async()=>{
    await prepareEmployee();const id=draftValue().creationId;writeHold=deferred();await submit();await until(()=>writeEntered);nativeNonce=nonceB;await reactAct(async()=>writeHold!.resolve(undefined));await until(()=>document.body.textContent?.includes('Ouvrez le bon compte')??false);expect(writes).toBe(0);verifyNoRetirement();expect(draftValue().creationId).toBe(id);expect(writeAttempts[0].expectedMemberContextNonce).toBe(nonceA);
  });
  it('rejects a member change after commit ACK without publishing another member workspace or retiring the draft',async()=>{
    mode='ack-member';await prepareEmployee();const id=draftValue().creationId;await submit();expect(writes).toBe(1);verifyNoRetirement();expect(draftValue().creationId).toBe(id);expect(document.body.textContent).toContain('Ouvrez le bon compte');expect(reads.every(row=>row.args.expectedMemberContextNonce===nonceA)).toBe(true);expect(buttons('Actualiser les données')).toHaveLength(0);
  });
  it('keeps existing Swiss contract validation and sends no creation with missing fixed-contract dates',async()=>{
    await openEmployee();await change('name','Contrat à corriger');await change('role','Technicien');await submit();await change('employmentRate','100');await change('salaryMode','monthly');await change('grossSalary','6000');await change('employmentContractKind','fixed');await submit();expect(document.querySelector('[data-employee-step="1"]')?.hasAttribute('hidden')).toBe(false);expect(document.querySelector('[name="employmentStart"]')?.getAttribute('aria-invalid')).toBe('true');expect(writes).toBe(0);expect(writeAttempts).toHaveLength(0);expect(draftValue().creationId).toMatch(/^[a-f\d-]{36}$/i);
  });
  it('keeps the draft open if removeItem returns but readback proves deletion did not happen',async()=>{
    await prepareEmployee();const id=draftValue().creationId;vi.spyOn(window,'confirm').mockReturnValue(true);const original=Storage.prototype.removeItem;const failed=vi.spyOn(Storage.prototype,'removeItem').mockImplementation(function(this:Storage,key){if(key.startsWith(FORM_DRAFT_PREFIX))return;original.call(this,key);});await click('Abandonner le brouillon');expect(document.querySelector('[role="dialog"] form')).not.toBeNull();expect(draftValue().creationId).toBe(id);expect(writeAttempts).toHaveLength(0);failed.mockRestore();await click('Abandonner le brouillon');await until(()=>document.querySelector('[role="dialog"] form')===null);expect(draftKeys()).toHaveLength(0);
  });
  it('preserves the existing edit path, controlled salary and original scope without inventing a creation ID',async()=>{
    const id='12345678-abcd-4abc-8def-1234567890ab';employees.push({id,name:'Personne existante',role:'Technicien',employment_rate:100,monthly_salary_cents:600000,hourly_rate_cents:0,status:'active',notes:'Note initiale',country:'CH'});const current=await desktopApi.loadWorkspace(scope,nonceA);await reactAct(async()=>exposed.setCurrent(current));await click('Équipe & salaires');const edit=document.querySelector<HTMLButtonElement>('[aria-label="Modifier Personne existante"]')!;expect(edit).not.toBeNull();await reactAct(async()=>edit.click());await change('name','Personne corrigée');await submit();await change('grossSalary','6500');await submit();expect(draftValue().creationId).toBeUndefined();await submit();await until(()=>document.querySelector('[role="dialog"] form')===null);expect(writeAttempts).toHaveLength(0);expect(writes).toBe(1);expect(employees[0].id).toBe(id);expect(employees[0].monthly_salary_cents).toBe(650000);const update=transport.invoke.mock.calls.find(([command])=>command==='update_record')![1];expect(update.expectedWorkspaceScope).toBe(scope);expect(update.expectedMemberContextNonce).toBe(nonceA);expect(update.data).not.toHaveProperty('id');expect(draftKeys()).toHaveLength(0);
  });
  it('keeps the existing annual contribution validation and points to the decision date without sending a creation',async()=>{
    await prepareEmployee();await change('smallSalaryAssessmentYear','2026');await change('smallSalarySector','ordinary');await change('smallSalaryEmployeeRequestedContributions','no');await change('smallSalaryDecisionDate','2025-01-12');await change('smallSalaryOpeningGross','0');await change('smallSalaryOpeningContributedBasis','0');await change('smallSalaryEvidenceReference','Déclaration fictive de recette');await submit();expect(writeAttempts).toHaveLength(0);expect(writes).toBe(0);expect(document.querySelector('[name="smallSalaryDecisionDate"]')?.getAttribute('aria-invalid')).toBe('true');expect(document.body.textContent).toContain('Vérifiez la date du choix de cotisation');expect(draftKeys()).toHaveLength(1);
  });
  it.each(['fr','de','it','en'] as const)('renders the real local storage guide and clears it with local capture only in %s',async language=>{
    const allowed=new Set(Object.values(languageAssets));vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{if(!allowed.has(String(input))){externalRequests++;throw Error('External request forbidden.');}return {ok:true,json:async()=>({'QA local pack':'QA local pack'})} as Response;}));await prepareEmployee();const id=draftValue().creationId;await reactAct(async()=>{await setAppLanguage(language);});const original=Storage.prototype.setItem;const failed=vi.spyOn(Storage.prototype,'setItem').mockImplementation(function(this:Storage,key,value){if(key.startsWith(FORM_DRAFT_PREFIX))throw new DOMException('Capture blocked','QuotaExceededError');original.call(this,key,value);});await submit();expect(document.querySelector('[data-employee-storage-recovery]')?.textContent).toContain(employeeCreationRecovery[language].storage);expect(writeAttempts).toHaveLength(0);failed.mockRestore();await click(draftText('Réessayer la sauvegarde locale'));expect(document.querySelector('[data-employee-storage-recovery]')).toBeNull();expect(writeAttempts).toHaveLength(0);expect(draftValue().creationId).toBe(id);
  });
  it.each(['fr','de','it','en'] as const)('renders the real explicit legacy decision in %s without automatically creating or assigning an ID',async language=>{
    const allowed=new Set(Object.values(languageAssets));vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{if(!allowed.has(String(input))){externalRequests++;throw Error('External request forbidden.');}return {ok:true,json:async()=>({'QA local pack':'QA local pack'})} as Response;}));await prepareEmployee();const key=draftKeys()[0];await closeEmployee();const stored=JSON.parse(localStorage.getItem(key)!);delete stored.value.creationId;localStorage.setItem(key,JSON.stringify(stored));await reactAct(async()=>{await setAppLanguage(language);});await restoreEmployee();expect(document.querySelector('[data-employee-legacy-creation]')?.textContent).toContain(employeeCreationRecovery[language].legacy);expect(draftValue().creationId).toBeUndefined();await submit();expect(writeAttempts).toHaveLength(0);await click(employeeCreationRecovery[language].prepare);expect(draftValue().creationId).toMatch(/^[a-f\d-]{36}$/i);expect(writeAttempts).toHaveLength(0);expect(document.querySelector('[data-employee-legacy-creation]')).toBeNull();
  });
  it.each(['fr','de','it','en'] as const)('renders actual unknown-create and manual verification instructions in %s without a language/provider/hook double',async language=>{
    const allowed=new Set(Object.values(languageAssets));vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{if(!allowed.has(String(input))){externalRequests++;throw Error('External request forbidden.');}return {ok:true,json:async()=>({'QA local pack':'QA local pack'})} as Response;}));await prepareEmployee();await reactAct(async()=>{await setAppLanguage(language);});mode='lost';await submit();const guide=document.querySelector('[data-employee-creation-recovery]')!;expect(guide.textContent).toContain(employeeCreationRecovery[language].title);expect(guide.textContent).toContain(employeeCreationRecovery[language].instruction);expect(draftKeys()).toHaveLength(1);expect(publications).toHaveLength(0);expect(buttons('Vérifier maintenant')).toHaveLength(0);expect(writes).toBe(1);
  });
  it('keeps unknown creation guidance and local recovery actions after a later storage failure without replaying the creation',async()=>{
    await prepareEmployee();mode='lost';const id=draftValue().creationId;await submit();expect(writes).toBe(1);expect(writeAttempts).toHaveLength(1);expect(document.querySelector('[data-employee-creation-recovery]')).not.toBeNull();expect(document.querySelector('[data-employee-storage-recovery]')).toBeNull();const before=localStorage.getItem(draftKeys()[0]);const original=Storage.prototype.setItem;
    const failed=vi.spyOn(Storage.prototype,'setItem').mockImplementation(function(this:Storage,key,value){if(key.startsWith(FORM_DRAFT_PREFIX))throw new DOMException('Capture blocked after unknown ACK','QuotaExceededError');original.call(this,key,value);});await change('notes','Dernière saisie après réponse perdue');
    expect(localStorage.getItem(draftKeys()[0])).toBe(before);expect(draftValue().creationId).toBe(id);expect(document.querySelector('[data-employee-creation-recovery]')).not.toBeNull();expect(document.querySelector('[data-employee-storage-recovery]')).toBeNull();expect(document.querySelector('.form-draft-notice')).not.toBeNull();expect(buttons('Réessayer la sauvegarde locale')).toHaveLength(1);expect(buttons('Abandonner le brouillon')).toHaveLength(1);expect(writes).toBe(1);expect(writeAttempts).toHaveLength(1);
    failed.mockRestore();await click('Réessayer la sauvegarde locale');expect(draftValue().creationId).toBe(id);expect(draftValue().notes).toBe('Dernière saisie après réponse perdue');expect(document.querySelector('[data-employee-creation-recovery]')?.textContent).toContain(employeeCreationRecovery.fr.instruction);expect(document.querySelector('[data-employee-storage-recovery]')).toBeNull();expect(document.querySelector('.form-draft-notice')).not.toBeNull();expect(writes).toBe(1);expect(writeAttempts).toHaveLength(1);expect(document.body.textContent).not.toContain('Le collaborateur a été ajouté.');expect(document.querySelector('[role="dialog"] form')).not.toBeNull();
  });
  it('places one local retry beside the storage explanation without a detached notice action',async()=>{
    await prepareEmployee();const id=draftValue().creationId;const original=Storage.prototype.setItem;const failed=vi.spyOn(Storage.prototype,'setItem').mockImplementation(function(this:Storage,key,value){if(key.startsWith(FORM_DRAFT_PREFIX))throw new DOMException('Capture blocked','QuotaExceededError');original.call(this,key,value);});await submit();
    const guide=document.querySelector('[data-employee-storage-recovery]')!;expect(guide).not.toBeNull();expect(guide.parentElement!.querySelector('button')?.textContent).toContain('Réessayer la sauvegarde locale');expect(buttons('Réessayer la sauvegarde locale')).toHaveLength(1);expect(document.querySelector('.form-draft-notice')).toBeNull();expect(writeAttempts).toHaveLength(0);
    failed.mockRestore();await click('Réessayer la sauvegarde locale');expect(document.querySelector('[data-employee-storage-recovery]')).toBeNull();expect(writeAttempts).toHaveLength(0);expect(draftValue().creationId).toBe(id);expect(document.querySelector('.form-draft-notice')).not.toBeNull();
  });

});

// Closed import boundary for the maintained CI test, independent of output config.
vi.hoisted(()=>{
  (globalThis as any).__employeeDurableImportRequests=0;
  Object.defineProperty(window,'matchMedia',{configurable:true,value:()=>({matches:false,addEventListener:()=>{},removeEventListener:()=>{},addListener:()=>{},removeListener:()=>{}})});
  HTMLElement.prototype.scrollIntoView=()=>{};window.scrollTo=()=>{};
  (globalThis as any).ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};
  globalThis.fetch=async()=>{(globalThis as any).__employeeDurableImportRequests++;throw Error('External fetch forbidden during maintained employee-durable test import.');};
});
