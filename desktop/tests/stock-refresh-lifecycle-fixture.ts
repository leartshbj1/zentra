// Test-only SDK reads; never execute a stock mutation, native DB or network request.
import { desktopApi, type CloudAccountState } from '../src/bridge';
import type { Workspace } from '../src/types';
import {recentDiagnosticEvents,resolveErrorIncident} from '../src/diagnostics';
const productionRead=desktopApi.loadWorkspace;
type Held={resolve:(value:unknown)=>void;reject:(reason:unknown)=>void;raw:unknown};
export function installStockRefreshFixture(workspace:Workspace,installIdentity:(workspace:Workspace)=>void){
 workspace.settings!.organization.legalName='SYNTHETIC COMPANY A';
 installIdentity(workspace);
 const identity=(window as any).__qaAppDraftIdentity;
 const native=(window as any).__TAURI_INTERNALS__;
 const previousInvoke=native.invoke;
 const originalResolver=desktopApi.resolveConnectedCompany;
 const proof={reads:[] as any[],resolutions:[] as any[],native:[] as string[],blockedNative:[] as string[],writes:[] as string[]};
 const held=new Map<number,Held>();let serial=0,nextHeld=false;
  const refusal=new Error('Fichier local indisponible : refus synthétique de la lecture de stock.');
 const settings=workspace.settings!;
 const rawSettings={
  company_name:settings.organization.legalName,legal_form:settings.organization.legalForm,
  owner_name:settings.organization.contactName,email:settings.organization.email,phone:settings.organization.phone,
  address_line1:settings.organization.address.street,address_line2:'',postal_code:settings.organization.address.postalCode,
  city:settings.organization.address.city,canton:settings.organization.address.canton,country:settings.organization.address.country,
  uid_number:settings.organization.uidNumber,vat_number:settings.organization.vatNumber,vat_registered:settings.organization.vatRegistered,
  default_vat_bp:settings.billing.vatRatesBp[0]||0,iban:settings.billing.iban,bank_name:settings.billing.accountHolder,currency:'CHF',
  quote_prefix:settings.billing.quotePrefix,invoice_prefix:settings.billing.invoicePrefix,credit_note_prefix:settings.billing.creditNotePrefix,
  quote_start_number:settings.billing.nextQuoteNumber,invoice_start_number:settings.billing.nextInvoiceNumber,
  credit_note_start_number:settings.billing.nextCreditNoteNumber,payment_terms_days:settings.billing.paymentTermsDays,
  quote_validity_days:settings.billing.quoteValidityDays,logo_path:'',noga_section:settings.business.nogaSection,
  noga_division:settings.business.nogaDivision,activity_description:settings.business.activityDescription,noga_detailed_code:settings.business.nogaDetailedCode,
  extra_settings_json:JSON.stringify({...settings,organization:{website:settings.organization.website,address:{buildingNumber:settings.organization.address.buildingNumber}}}),
 };
 const raw=()=>({
  schema_version:43,work_notes_scope:workspace.workNotesScope,
  settings:{...structuredClone(rawSettings),company_name:workspace.settings!.organization.legalName},
  clients:workspace.clients.map(client=>({id:client.id,company:client.company,name:client.name,contact_person:client.contactPerson,email:client.email,phone:client.phone,address_line1:'Rue fictive',postal_code:'1000',city:'Lausanne',archived_at:null})),
  catalog_items:workspace.catalogItems.map(item=>({id:item.id,kind:item.kind,name:item.name,sku:item.sku,unit:item.unit,description:item.description,sales_price_cents:item.salesPriceCents,purchase_cost_cents:item.purchaseCostCents,vat_bp:item.vatBp,track_stock:item.trackStock,stock_quantity_milli:item.stockQuantityMilli,reorder_level_milli:item.reorderLevelMilli,archived_at:item.archivedAt})),
  stock_movements:[],stock_reservation_events:[],stock_availability:workspace.stockAvailability.map(row=>({catalog_item_id:row.catalogItemId,on_hand_milli:row.onHandMilli,reserved_milli:row.reservedMilli,available_milli:row.availableMilli})),
 });
 desktopApi.loadWorkspace=productionRead;
 desktopApi.resolveConnectedCompany=async(org,choice)=>{
  proof.resolutions.push({org,choice:choice||'auto',scope:workspace.workNotesScope});
  if(org==='synthetic-organization-b'&&workspace.workNotesScope==='synthetic-company-a'&&(!choice||choice==='auto'))return{status:'choose_remote',organizationId:org,changed:false};
  return originalResolver(org,choice);
 };
 native.invoke=async(command:string,args:any,options:unknown)=>{
  proof.native.push(command);
  if(command==='get_app_state')return{onboarding_completed:true,activity_profile_required:false,data_dir:'',app_version:'synthetic'};
  if(command==='get_workspace'){
   const stack=new Error('Synthetic stock refresh lineage').stack||'';
   const pending=nextHeld&&stack.includes('/src/WorkspaceApp.tsx');
   const captured=raw();const read={id:++serial,scope:workspace.workNotesScope,pending,stockRefresh:stack.includes('/src/WorkspaceApp.tsx'),stack};proof.reads.push(read);
   if(pending){nextHeld=false;return new Promise((resolve,reject)=>held.set(read.id,{resolve,reject,raw:captured}));}
   return captured;
  }
  if(command.startsWith('record_stock_')){proof.writes.push(command);throw Error('Read-only stock fixture forbids mutations');}
  try{return await previousInvoke(command,args,options);}catch(error){proof.blockedNative.push(command);throw error;}
 };
 Object.assign(window,{__qaStockRefreshRead:{
  proof,holdNext(){nextHeld=true;},
  settle(readId:number){const row=held.get(readId);if(!row)throw Error('No held stock refresh');held.delete(readId);proof.reads.find(read=>read.id===readId)!.pending=false;row.resolve(row.raw);},
  settleWrongWorkspace(readId:number){
     const row=held.get(readId);if(!row)throw Error('No held stock refresh');
     held.delete(readId);proof.reads.find(read=>read.id===readId)!.pending=false;
     const response:any=structuredClone(row.raw);response.work_notes_scope='synthetic-company-b';
     response.settings.company_name='SYNTHETIC COMPANY B';
     response.clients=response.clients.map((client:any)=>({...client,id:'synthetic-client-b',name:'Client fictif B',company:'Client fictif B'}));
     row.resolve(response);
   },
   refuse(readId:number){const row=held.get(readId);if(!row)throw Error('No held stock refresh');held.delete(readId);proof.reads.find(read=>read.id===readId)!.pending=false;row.reject(refusal);},
   diagnostics(){return recentDiagnosticEvents().filter(event=>event.operation==='workspace.stock_refresh'||event.operation==='get_workspace');},
   refusalIncident(){return resolveErrorIncident(refusal);},
   switchAccount(){const account:CloudAccountState={status:'connected',organizationId:'synthetic-organization-b',organizationName:'SYNTHETIC COMPANY B',role:'owner'};identity.link(account,'synthetic-member-b','synthetic-company-b');identity.setAccount(account,'synthetic-member-b');identity.releaseAccount(1);},
  snapshot(){return{scope:workspace.workNotesScope,company:workspace.settings!.organization.legalName};},
 }});
}
