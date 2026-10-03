/** Non-shipping closed dependency fixture for real App/Gate, restores and time billing.
 * All records/ACKs are synthetic. No native binary, LocalStore, API, email or user data.
 * Capture bridge methods before the existing mobile harness assigns its defaults.
 */
import { desktopApi, type CloudAccountState } from '../src/bridge';
import type { Workspace } from '../src/types';
import { companyReceiveAllowed } from '../src/companySync';
const actualRestore=desktopApi.restoreBackup;
const actualCreate=desktopApi.createInvoiceFromTimeEntries;
const actualLoad=desktopApi.loadWorkspace;
export function installTimeBillingRestoreLifecycleFixture(workspace: Workspace, installIdentity: (workspace: Workspace) => void) {
 workspace.settings!.organization.legalName='UI COMPANY A';
 const project=workspace.projects[0];project.clientId=workspace.clients[0].id;
 workspace.employees=[{id:'synthetic-employee',name:'Collaborateur fictif',active:true}] as unknown as Workspace['employees'];
 workspace.timeEntries=[{id:'same-synthetic-time',projectId:project.id,employeeId:'synthetic-employee',date:'2026-09-01',minutes:60,billable:true,billingRateCents:6000,hourlyCostCents:3000,status:'approved',billingStatus:'unbilled',note:'Prestation synthétique',createdAt:'2026-09-01T08:00:00Z'}] as unknown as Workspace['timeEntries'];
 installIdentity(workspace);
 desktopApi.restoreBackup=actualRestore;desktopApi.createInvoiceFromTimeEntries=actualCreate;
 desktopApi.chooseRestoreFile=async()=>'/synthetic/same-uuid-backup.zentra';
 const native=(window as any).__TAURI_INTERNALS__,prior=native.invoke;
 let releaseRestore: (() => void) | undefined, releasePicker: (() => void) | undefined, heldRead: (() => void) | undefined;
 let mode='ordinary',failReads=0,holdRead=false;
 const proof={restores:0,reads:0,pickerPending:false,readPending:false,timeCommands:[] as {databaseScope?: string;expectedScopePresent:boolean;input:unknown}[],unexpected:[] as string[],choices:[] as {organizationId:string;choice:string}[]};
 const resolveCompany=desktopApi.resolveConnectedCompany;
 desktopApi.resolveConnectedCompany=async (organizationId,choice)=>{
  proof.choices.push({organizationId,choice:choice||'auto'});
  if(organizationId==='synthetic-organization-c'&&(!choice||choice==='auto'))return {status:'choose_remote' as const,organizationId,changed:false};
  if(organizationId==='automation-qa'&&proof.restores&&workspace.workNotesScope==='synthetic-restored-scope-b')return {status:'ready' as const,organizationId,changed:false};
  return resolveCompany(organizationId,choice);
 };
 const raw=()=>({schema_version:workspace.schemaVersion,work_notes_scope:workspace.workNotesScope,settings:{company_name:workspace.settings!.organization.legalName,noga_section:workspace.settings!.business.nogaSection,noga_division:workspace.settings!.business.nogaDivision,activity_description:workspace.settings!.business.activityDescription,vat_registered:workspace.settings!.organization.vatRegistered,default_vat_bp:workspace.settings!.billing.vatRatesBp[0]||0},clients:workspace.clients.map(c=>({id:c.id,name:c.name,company:c.company})),projects:workspace.projects.map(p=>({id:p.id,name:p.name,client_id:p.clientId,status:p.status})),time_entries:workspace.timeEntries.map(t=>({id:t.id,project_id:t.projectId,employee_id:t.employeeId,date:t.date,minutes:t.minutes,billable:t.billable,billing_rate_cents:t.billingRateCents,cost_rate_cents:t.hourlyCostCents,status:'approuve',billing_status:'unbilled',note:t.note})),employees:workspace.employees.map(e=>({id:e.id,name:e.name,status:'actif'}))});
 native.invoke=async(command: string,args?: any,options?: unknown)=>{
  if(command==='restore_backup'){proof.restores++;return new Promise(resolve=>{releaseRestore=()=>{if(mode!=='same-scope')workspace.workNotesScope='synthetic-restored-scope-b';workspace.settings!.organization.legalName='RESTORED COMPANY B';resolve({});};});}
  if(command==='get_app_state')return {onboarding_completed:true,activity_profile_required:false,data_dir:'',app_version:'synthetic'};
  if(command==='get_workspace'){
   proof.reads++;
   if(failReads>0){failReads--;throw Error('Synthetic restore read unavailable');}
   if(holdRead){holdRead=false;proof.readPending=true;const snapshot=structuredClone(raw());return new Promise(resolve=>{heldRead=()=>{proof.readPending=false;resolve(snapshot);};});}
   return raw();
  }
  if(command==='create_invoice_from_time_entries'){proof.timeCommands.push({databaseScope:workspace.workNotesScope,expectedScopePresent:Object.hasOwn(args,'expectedWorkspaceScope'),input:structuredClone(args.input)});return new Promise(()=>{});}
  return prior(command,args,options);
 };
 (window as any).__qaTimeBillingScope={proof,
  begin(nextMode: string){mode=nextMode;if(mode==='recovery')failReads=2;if(mode==='late-account')holdRead=true;if(mode!=='picker')desktopApi.loadWorkspace=actualLoad;if(mode==='picker')desktopApi.chooseRestoreFile=()=>{proof.pickerPending=true;return new Promise(resolve=>{releasePicker=()=>{proof.pickerPending=false;resolve('/synthetic/old-picker.zentra');};});};},
  releasePicker(){if(!releasePicker)throw Error('No held synthetic picker');releasePicker();},
  releaseRead(){if(!heldRead)throw Error('No held synthetic restore read');heldRead();},
  switchVerifiedAccount(){
   const qa=(window as any).__qaAppDraftIdentity;
   const next: CloudAccountState={status:'connected',organizationId:'synthetic-organization-c',organizationName:'CURRENT COMPANY C',role:'owner'};
   qa.link(next,'synthetic-member-c','synthetic-company-c');qa.setAccount(next,'synthetic-member-c');qa.identityMode('ready');qa.releaseAccount(1);
  },
  releaseRestore:()=>{if(!releaseRestore)throw Error('No held synthetic restore');releaseRestore();},database:()=>({scope:workspace.workNotesScope,company:workspace.settings!.organization.legalName,timeIds:workspace.timeEntries.map(t=>t.id),projectIds:workspace.projects.map(p=>p.id)}),receiveAllowed:companyReceiveAllowed};
}
