import { desktopApi } from '/src/bridge';
import { companyReceiveAllowed } from '/src/companySync';
const actualRestore=desktopApi.restoreBackup;
const actualCreate=desktopApi.createInvoiceFromTimeEntries;
const actualLoad=desktopApi.loadWorkspace;
export function installTimeBillingScopeAudit(workspace,installIdentity){
 workspace.settings.organization.legalName='UI COMPANY A';
 const project=workspace.projects[0];project.clientId=workspace.clients[0].id;
 workspace.employees=[{id:'synthetic-employee',name:'Collaborateur fictif',active:true}];
 workspace.timeEntries=[{id:'same-synthetic-time',projectId:project.id,employeeId:'synthetic-employee',date:'2026-09-01',minutes:60,billable:true,billingRateCents:6000,hourlyCostCents:3000,status:'approved',billingStatus:'unbilled',note:'Prestation synthétique',createdAt:'2026-09-01T08:00:00Z'}];
 installIdentity(workspace);
 desktopApi.restoreBackup=actualRestore;desktopApi.createInvoiceFromTimeEntries=actualCreate;
 desktopApi.chooseRestoreFile=async()=>'/synthetic/same-uuid-backup.zentra';
 const native=window.__TAURI_INTERNALS__,prior=native.invoke;
 let releaseRestore,releasePicker,heldRead;
 let mode='ordinary',failReads=0,holdRead=false;
 const proof={restores:0,reads:0,pickerPending:false,readPending:false,timeCommands:[],unexpected:[],choices:[]};
 const resolveCompany=desktopApi.resolveConnectedCompany;
 desktopApi.resolveConnectedCompany=async (organizationId,choice)=>{
  proof.choices.push({organizationId,choice:choice||'auto'});
  if(organizationId==='synthetic-organization-c'&&(!choice||choice==='auto'))return {status:'choose_remote',organizationId,changed:false};
  if(organizationId==='automation-qa'&&proof.restores&&workspace.workNotesScope==='synthetic-restored-scope-b')return {status:'ready',organizationId,changed:false};
  return resolveCompany(organizationId,choice);
 };
 let releaseBilling;let billingRaw={};
 const raw=()=>({...(billingRaw.scope===workspace.workNotesScope?billingRaw:{}),schema_version:workspace.schemaVersion,work_notes_scope:workspace.workNotesScope,settings:{company_name:workspace.settings.organization.legalName,noga_section:workspace.settings.business.nogaSection,noga_division:workspace.settings.business.nogaDivision,activity_description:workspace.settings.business.activityDescription,vat_registered:workspace.settings.organization.vatRegistered,default_vat_bp:workspace.settings.billing.vatRatesBp[0]||0},clients:workspace.clients.map(c=>({id:c.id,name:c.name,company:c.company})),projects:workspace.projects.map(p=>({id:p.id,name:p.name,client_id:p.clientId,status:p.status})),time_entries:workspace.timeEntries.map(t=>({id:t.id,project_id:t.projectId,employee_id:t.employeeId,date:t.date,minutes:t.minutes,billable:t.billable,billing_rate_cents:t.billingRateCents,cost_rate_cents:t.hourlyCostCents,status:'approuve',billing_status:t.billingStatus||'unbilled',note:t.note})),employees:workspace.employees.map(e=>({id:e.id,name:e.name,status:'actif'}))});
 native.invoke=async(command,args,options)=>{
  if(command==='restore_backup'){proof.restores++;return new Promise(resolve=>{releaseRestore=()=>{if(mode!=='same-scope')workspace.workNotesScope='synthetic-restored-scope-b';workspace.settings.organization.legalName='RESTORED COMPANY B';resolve({});};});}
  if(command==='get_app_state')return {onboarding_completed:true,activity_profile_required:false,data_dir:'',app_version:'synthetic'};
  if(command==='get_workspace'){
   proof.reads++;
   if(failReads>0){failReads--;throw Error('Synthetic restore read unavailable');}
   if(holdRead){holdRead=false;proof.readPending=true;const snapshot=structuredClone(raw());return new Promise(resolve=>{heldRead=()=>{proof.readPending=false;resolve(snapshot);};});}
   return raw();
  }
  if(command==='create_invoice_from_time_entries'){proof.timeCommands.push({databaseScope:workspace.workNotesScope,expectedScopePresent:Object.hasOwn(args,'expectedWorkspaceScope'),expectedScope:args.expectedWorkspaceScope,input:structuredClone(args.input)});const input=args.input, invoiceId='synthetic-created-invoice', batchId='synthetic-created-batch', lineId='synthetic-created-line';
    const selected=workspace.timeEntries.find(entry=>entry.id===input.time_entry_ids[0]);
    selected.billingStatus='reserved';
    billingRaw={scope:workspace.workNotesScope,invoices:[{id:invoiceId,project_id:input.project_id,client_id:workspace.projects.find(project=>project.id===input.project_id).clientId,type:'standard',status:'brouillon',number:null,title:'Synthetic created draft',currency:'CHF',issue_date:'2026-10-03',due_date:'2026-11-03',subtotal_cents:6000,vat_cents:486,total_cents:6486}],invoice_items:[{id:lineId,invoice_id:invoiceId,position:0,description:'Synthetic time',quantity:1,unit:'heure',unit_price_cents:6000,discount_bp:0,vat_bp:810,line_net_cents:6000,line_vat_cents:486,line_total_cents:6486}],time_billing_batches:[{id:batchId,request_id:input.request_id,invoice_id:invoiceId,project_id:input.project_id,vat_bp:810}],time_billing_entries:[{id:'synthetic-created-entry',batch_id:batchId,time_entry_id:selected.id,invoice_item_id:lineId,minutes_snapshot:60,billing_rate_cents_snapshot:6000,amount_cents_snapshot:6000}]};
    const receipt={invoice:billingRaw.invoices[0],idempotent:false};if(mode==='late-success')return new Promise(resolve=>{releaseBilling=()=>resolve(receipt);});return receipt;}
  return prior(command,args,options);
 };
 window.__qaTimeBillingScope={proof,releaseBilling(){if(!releaseBilling)throw Error('No held synthetic billing receipt');releaseBilling();},
  begin(nextMode){mode=nextMode;if(mode==='recovery')failReads=2;if(mode==='late-account')holdRead=true;if(mode!=='picker')desktopApi.loadWorkspace=actualLoad;if(mode==='picker')desktopApi.chooseRestoreFile=()=>{proof.pickerPending=true;return new Promise(resolve=>{releasePicker=()=>{proof.pickerPending=false;resolve('/synthetic/old-picker.zentra');};});};},
  releasePicker(){if(!releasePicker)throw Error('No held synthetic picker');releasePicker();},
  releaseRead(){if(!heldRead)throw Error('No held synthetic restore read');heldRead();},
  switchVerifiedAccount(){
   const qa=window.__qaAppDraftIdentity;
   const next={status:'connected',organizationId:'synthetic-organization-c',organizationName:'CURRENT COMPANY C',role:'owner'};
   qa.link(next,'synthetic-member-c','synthetic-company-c');qa.setAccount(next,'synthetic-member-c');qa.identityMode('ready');qa.releaseAccount(1);
  },
  releaseRestore:()=>{if(!releaseRestore)throw Error('No held synthetic restore');releaseRestore();},database:()=>({scope:workspace.workNotesScope,company:workspace.settings.organization.legalName,timeIds:workspace.timeEntries.map(t=>t.id),projectIds:workspace.projects.map(p=>p.id)}),receiveAllowed:companyReceiveAllowed};
}
