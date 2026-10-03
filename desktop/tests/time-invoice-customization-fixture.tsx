import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {DocumentEditor} from '/src/DocumentEditor';
import {desktopApi} from '/src/bridge';
import type {WorkspaceMutationOrigin} from '/src/workspaceMemberOrigin';
import {FormDraftIdentityProvider} from '/src/useFormDraft';
import {initialOnboardingSettings} from '/src/onboardingDraft';
import {initialDocumentFormDraft,validDocumentFormDraft} from '/src/documentFormDraft';
import {FormDraftSession,formDraftFingerprint} from '/src/formDrafts';
import {documentNumberEntry} from '/src/documentNumberEntry';
import {recentDiagnosticEvents} from '/src/diagnostics';
import {setAppLanguage,t} from '/src/language';
import '/src/styles.css';

const scenario=new URLSearchParams(location.search).get('case')||'fractional';
// 11-minute quantity is the one-ULP representation from the separate precision
// proposal: 0.18333333333333335 * 5010 rounds to its reserved 919-cent amount.
const settings=structuredClone(initialOnboardingSettings),quantity=scenario==='fractional'?61/60:scenario==='fractional11'?0.18333333333333335:1,rate=scenario==='fractional11'?5010:10001;
settings.organization.legalName='Fictive company';settings.organization.vatRegistered=false;
settings.billing.vatRatesBp=[0];settings.billing.footerTemplates=[];
const raw:any={schema_version:43,work_notes_scope:'fictive-scope-a',settings:{company_name:'Fictive company',currency:'CHF',extra_settings_json:JSON.stringify(settings)},
 clients:[{id:'client',name:'Fictive client',company:'Fictive client',created_at:'2026-09-01',updated_at:'2026-09-01'}],
 projects:[{id:'project',client_id:'client',name:'Fictive project',status:'planifie',created_at:'2026-09-01',updated_at:'2026-09-01'}],
 invoices:[{id:'invoice',number:null,title:'Fictive title',client_id:'client',project_id:'project',quote_id:null,original_invoice_id:null,type:'standard',status:'brouillon',currency:'CHF',issue_date:'2026-09-02',due_date:'2026-10-02',service_date_from:'2026-09-01',service_date_to:'2026-09-01',notes:'Fictive notes',terms:'Fictive footer',subtotal_cents:Math.round(quantity*rate),discount_cents:0,vat_cents:0,total_cents:Math.round(quantity*rate),created_at:'2026-09-01T12:00:00Z',updated_at:'2026-09-01T12:00:00Z'}],
 invoice_items:[{id:'item',invoice_id:'invoice',catalog_item_id:null,position:0,description:'Fictive time work',quantity,unit:'heure',unit_price_cents:rate,discount_bp:0,vat_bp:0,line_net_cents:Math.round(quantity*rate),line_vat_cents:0,line_total_cents:Math.round(quantity*rate),created_at:'2026-09-01T12:00:00Z',updated_at:'2026-09-01T12:00:00Z'}],
 time_billing_batches:scenario==='ordinary'?[]:[{id:'batch',request_id:'00000000-0000-4000-8000-000000000001',invoice_id:'invoice',project_id:'project',client_id:'client',vat_bp:0,created_at:'2026-09-01T12:00:00Z'}],
};
const proof:any={calls:[],writes:[],publications:[],closed:false};
Object.assign(window,{__TAURI_INTERNALS__:{invoke:async(command:string,args:any)=>{
 if(command==='append_diagnostic_events')return;
 proof.calls.push({command,args:structuredClone(args??null)});
 if(command==='get_app_state')return{onboarding_completed:true};
 if(command==='get_workspace')return structuredClone(raw);
 if(command==='update_record'){
  proof.writes.push({command,args:structuredClone(args)});
  if(args.entity!=='invoices'||args.id!=='invoice'||args.expectedWorkspaceScope!=='fictive-scope-a')throw Error('Closed fixture rejects wrong dispatch');
  Object.assign(raw.invoices[0],args.data);return structuredClone(raw.invoices[0]);
 }
 if(command==='save_document_with_items'){
  proof.writes.push({command,args:structuredClone(args)});
  if(raw.time_billing_batches.length)throw Error('Erreur base de données : time billing invoice lines are immutable');
  Object.assign(raw.invoices[0],args.input.data);return{document:structuredClone(raw.invoices[0]),items:structuredClone(raw.invoice_items)};
 }
 throw Error('Closed fixture forbids command '+command);
}}});
const workspace=await desktopApi.loadWorkspace(),item=workspace.invoices[0];
proof.calls=[];
if(scenario==='old-financial'){
 const initial=initialDocumentFormDraft('invoices',workspace.settings!,'unused',item,undefined,undefined,3);
 const session=new FormDraftSession({scope:{companyId:workspace.workNotesScope!,memberId:'local-user',type:'invoices',recordId:item.id},initial,fingerprint:formDraftFingerprint(item),validate:validDocumentFormDraft});
 session.capture({...initial,documentTitle:'Preserved personal title',documentNotes:'Preserved personal notes',footerText:'Preserved personal footer',issueDate:'2026-09-05',dueDate:'2026-11-05',lines:[{...initial.lines[0],quantity:2}]});
}
function Host(){
 const [state,setState]=useState(workspace),[closed,setClosed]=useState(false);
 const act=async(action:(origin:WorkspaceMutationOrigin)=>Promise<any>,_message:string,close=false,onError?:(reason:unknown)=>void)=>{
  try{const next=await action(Object.freeze({workspaceScope:state.workNotesScope!,memberContextNonce:'0123456789abcdef0123456789abcdef'}));proof.publications.push(next.workNotesScope);setState(next);if(close){proof.closed=true;setClosed(true);}return true;}
  catch(reason){onError?.(reason);return false;}
 };
 Object.assign(window,{__timeEditProof:{proof,state:()=>structuredClone(state),number:()=>documentNumberEntry(String(quantity),'quantity'),diagnostics:()=>recentDiagnosticEvents(),chooseLanguage:setAppLanguage,translate:t}});
 return closed?<p>CONFIRMED SAVED</p>:<DocumentEditor entity="invoices" item={item} initialStep={3} workspace={state} busy={false} readOnly={scenario==='readonly'} close={()=>{proof.closed=true;setClosed(true);}} act={act}/>;
}
createRoot(document.getElementById('root')!).render(<FormDraftIdentityProvider companyId="fictive-scope-a" memberId="local-user" memberContextNonce="0123456789abcdef0123456789abcdef" ready><Host/></FormDraftIdentityProvider>);
