import { validateErpRequest } from './erp-request';
import { validateCompanyConfiguration } from './country-config';
import { validateStoredErp } from './runtime-validation';
import type { CompanyConfiguration } from './types';
import type { ErpCommand, ErpReceipt, ErpRequest, ErpState } from './runtime-types';
import { ERP_SCHEMA_HEADER, type ErpSchemaVersion } from './erp-schema-capability';
import { applyErpDelta, validateErpDelta, validateErpRevision, type ErpRevision } from './runtime-sync';
import { ErpError } from './erp-contract';

export type BrowserErpRead=Readonly<{status:'ready';state:ErpState}|{status:'uninitialized';configuration:CompanyConfiguration}>;
export type BrowserErpResult=Readonly<{receipt:ErpReceipt;replayed:boolean}>;
export type BrowserErpSyncResult=Readonly<{status:'unchanged'|'changed'|'deferred';read:BrowserErpRead}>;
export type BrowserErpOutcome='rejected'|'uncertain'|'unauthorized';
export class BrowserErpError extends Error {
  constructor(readonly code:string,readonly status:number,readonly outcome:BrowserErpOutcome){super(code);this.name='BrowserErpError';}
}
export interface BrowserErpSessionOptions {
  organizationId:string;
  /** Non-secret stale-account fence. The server must compare it to its own Auth actor. */
  expectedUserId?:string;
  /** Client protocol support; never an entitlement or permission. Default1. */
  supportedSchemaVersion?:ErpSchemaVersion;
  fetch?:typeof globalThis.fetch;
  newId?:()=>string;
}
export interface BrowserErpSession {
  load():Promise<BrowserErpRead>;
  synchronize(current:BrowserErpRead):Promise<BrowserErpSyncResult>;
  submit(command:ErpCommand,expectedRevision:number):Promise<BrowserErpResult>;
  retry():Promise<BrowserErpResult>;
  hasPending():boolean;
  dispose():void;
}
const rejectedConflicts=new Set(['sales_order_source_locked','sales_order_invoice_blocked','revision_conflict','estimate_revision_conflict','project_revision_conflict','idempotency_conflict']);
const responseTimeoutMs=30000;
const syncPageLimit=10,syncPageRounds=8,syncPageBytes=4*1024*1024,syncSnapshotBytes=32*1024*1024;
// Never turn arbitrary server/debug text into an error shown to a browser user.
const publicErrors=new Set(['sales_order_source_locked','sales_order_invoice_blocked','unauthorized','session_changed','forbidden','management_entitlement_required','financial_permission_required','owner_required','tenant_mismatch','feature_unavailable','edition_unavailable','country_configuration_required','configuration_changed','service_unavailable','invalid_request','invalid_date','invalid_customer','invalid_email','invalid_estimate','invalid_period','invalid_payment_terms','invalid_amount','revision_conflict','estimate_revision_conflict','idempotency_conflict','already_initialized','workspace_not_initialized','workspace_unavailable','immutable_record','invalid_state','invalid_stored_state','project_not_found','customer_required','estimate_not_found','issued_estimate_locked','invoice_already_issued','invoice_not_found','number_sequence_exhausted','accounting_period_not_open','tax_configuration_required','seller_configuration_required','tax_assessment_expired','stale_tax_assessment','payment_exceeds_balance','period_closed','event_too_large','client_upgrade_required','purchasing_unavailable','vendor_required','vendor_bill_not_found','vendor_bill_already_recorded','vendor_payment_already_recorded','purchase_account_required','overpayment']);
publicErrors.add('rate_limited');
for (const code of ['invalid_cursor','invalid_sync_state','sync_reset_required']) publicErrors.add(code);
for (const code of ['projects_unavailable','legacy_project_review_required','project_customer_locked','project_revision_conflict','vendor_bill_project_conflict','project_archived','project_customer_mismatch']) publicErrors.add(code);
for (const code of ['accounting_unavailable','accounting_upgrade_required','accounting_already_upgraded','period_limit_reached','period_already_exists','accounting_period_order_conflict','manual_account_forbidden','manual_journal_required','entry_not_found','invalid_reversal','accounting_period_closed','unbalanced_entry','account_not_found','invalid_entry','cash_flow_category_required']) publicErrors.add(code);
for (const code of ['unbalanced_journal','unknown_account','invalid_journal_line','cash_flow_classification_required']) publicErrors.add(code);
const exactObject=(value:unknown,keys:readonly string[]):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
function frozen<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))frozen(child);Object.freeze(value);}return value;}
function readProjection(value:unknown,organizationId:string,supportedSchemaVersion:ErpSchemaVersion):BrowserErpRead {
  if(exactObject(value,['status','configuration'])&&value.status==='uninitialized'){
    const configuration=validateCompanyConfiguration(value.configuration);
    if(configuration.organizationId!==organizationId||configuration.country!=='US'||configuration.currency!=='USD'||Object.hasOwn(configuration,'ein'))throw new Error('Invalid public configuration');
    return frozen(structuredClone({status:'uninitialized' as const,configuration}));
  }
  if(exactObject(value,['status','state'])&&value.status==='ready'){
    const state=validateStoredErp(value.state,organizationId);
    if(state.schemaVersion>supportedSchemaVersion)throw new BrowserErpError('client_upgrade_required',409,'rejected');
    if(state.configuration.country!=='US'||state.configuration.currency!=='USD'||Object.hasOwn(state.configuration,'ein')||state.invoices.some(invoice=>Object.hasOwn(invoice.companyConfiguration,'ein')))throw new Error('Invalid public state');
    return frozen(structuredClone({status:'ready' as const,state}));
  }
  throw new Error('Invalid public projection');
}
function entityId(request:ErpRequest,organizationId:string):string {
  switch(request.command.type){
    case 'initialize':case 'refresh_configuration':case 'upgrade_accounting':return organizationId;
    case 'save_customer':return request.command.customer.id;
    case 'save_vendor':return request.command.vendor.id;
    case 'save_projects':return request.command.projects[0].id;
    case 'accept_estimate':return request.command.estimateId;
    case 'close_period':return request.command.periodId;
    default:return request.command.id;
  }
}
function resultProjection(value:unknown,request:ErpRequest,organizationId:string):BrowserErpResult {
  if(!exactObject(value,['receipt','replayed'])||typeof value.replayed!=='boolean'||!exactObject(value.receipt,['idempotencyKey','commandHash','revision','entityId','action']))throw new Error('Invalid receipt');
  const receipt=value.receipt;
  if(receipt.idempotencyKey!==request.idempotencyKey||receipt.action!==request.command.type||receipt.entityId!==entityId(request,organizationId)||receipt.revision!==request.expectedRevision+1||!Number.isSafeInteger(receipt.revision)||typeof receipt.commandHash!=='string'||!/^[a-f0-9]{64}$/.test(receipt.commandHash))throw new Error('Invalid receipt');
  return frozen(structuredClone({receipt:receipt as unknown as ErpReceipt,replayed:value.replayed}));
}
/** Cookie-only browser transport. It never supplies a SaaS grant or financial authority.
 * Pending operations live only in this instance's RAM: disposal/reload loses their
 * exact retry envelope. A new page must reread persisted state; it cannot infer that
 * an interrupted write failed or silently create a replacement operation.
 */
export function createBrowserErpSession(options:BrowserErpSessionOptions):BrowserErpSession {
  const {organizationId,expectedUserId}=options;
  const supportedSchemaVersion=options.supportedSchemaVersion??1;
  if(![1,2,3,4].includes(supportedSchemaVersion))throw new BrowserErpError('invalid_request',422,'rejected');
  if(typeof organizationId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(organizationId)||expectedUserId!==undefined&&(typeof expectedUserId!=='string'||!expectedUserId.trim()||expectedUserId!==expectedUserId.trim()||expectedUserId.length>256||Array.from(expectedUserId).some(char=>char.charCodeAt(0)<32||char.charCodeAt(0)===127)))throw new BrowserErpError('invalid_request',422,'rejected');
  const fetcher=options.fetch??globalThis.fetch.bind(globalThis),newId=options.newId??(()=>globalThis.crypto.randomUUID());
  const url=`/api/international/workspaces/${encodeURIComponent(organizationId)}/erp`;
  const controllers=new Set<AbortController>();
  let disposed=false,writing=false,loading=0,readRequired=false,mutationEpoch=0,accessEpoch=0,latestRead=0,latestSync=0,pending:Readonly<{body:string;request:ErpRequest}>|null=null;
  function alive(){if(disposed)throw new BrowserErpError('session_disposed',0,'unauthorized');}
  const headers=()=>({Accept:'application/json',...(supportedSchemaVersion>1?{[ERP_SCHEMA_HEADER]:String(supportedSchemaVersion)}:{}),...(expectedUserId===undefined?{}:{'X-Zentra-Expected-User':expectedUserId})});
  async function response(request:RequestInit,write:boolean,path='',maximumBytes?:number,timeoutMs=responseTimeoutMs):Promise<{body:unknown;status:number}> {
    alive();const controller=new AbortController();controllers.add(controller);
    let timedOut=false,timer:ReturnType<typeof setTimeout>|undefined;
    const deadline=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{timedOut=true;reject(new BrowserErpError('response_timeout',0,write?'uncertain':'rejected'));controller.abort();},timeoutMs);});
    try {
      const result=await Promise.race([fetcher(url+path,{...request,credentials:'same-origin',mode:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal}),deadline]);alive();
      const unauthorizedCode=result.status===401?'unauthorized':result.status===402?'management_entitlement_required':result.status===403?'forbidden':null;
      // Deny at headers, without waiting on a potentially stalled/private body.
      if(unauthorizedCode){mutationEpoch++;accessEpoch++;readRequired=true;controller.abort();throw new BrowserErpError(unauthorizedCode,result.status,'unauthorized');}
      let body:unknown;try{
        if(maximumBytes===undefined)body=await Promise.race([result.json(),deadline]);
        else {
          const maximum=result.ok?maximumBytes:4096,length=result.headers.get('Content-Length');
          if(result.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()!=='application/json'||length!==null&&(!/^\d+$/.test(length)||Number(length)>maximum))throw new Error('Invalid body');
          const reader=result.body?.getReader(),parts:Uint8Array[]=[];let size=0;
          if(reader){try{for(;;){const part=await Promise.race([reader.read(),deadline]);alive();if(part.done)break;size+=part.value.byteLength;if(size>maximum){void reader.cancel();throw new Error('Oversized body');}parts.push(part.value);}}finally{reader.releaseLock();}}
          else{const bytes=new Uint8Array(await Promise.race([result.arrayBuffer(),deadline]));size=bytes.byteLength;if(size>maximum)throw new Error('Oversized body');parts.push(bytes);}
          const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}
          body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
        }
      }catch{if(timedOut)throw new BrowserErpError('response_timeout',0,write?'uncertain':'rejected');throw new BrowserErpError('invalid_response',result.status,write?'uncertain':'rejected');}alive();
      if(!result.ok){
        const code=exactObject(body,['error'])&&typeof body.error==='string'&&publicErrors.has(body.error)?body.error:'service_unavailable';
        if(write&&result.status===409&&rejectedConflicts.has(code)){pending=null;readRequired=true;throw new BrowserErpError(code,result.status,'rejected');}
        throw new BrowserErpError(code,result.status,write?'uncertain':'rejected');
      }
      return {body,status:result.status};
    } catch(error){alive();if(error instanceof BrowserErpError&&error.outcome==='unauthorized')throw error;if(timedOut)throw new BrowserErpError('response_timeout',0,write?'uncertain':'rejected');if(error instanceof BrowserErpError)throw error;throw new BrowserErpError('response_unavailable',0,write?'uncertain':'rejected');}
    finally{if(timer!==undefined)clearTimeout(timer);controllers.delete(controller);}
  }
  function syncError(error:unknown,status=200):never {
    if(error instanceof BrowserErpError)throw error;
    if(error instanceof ErpError&&error.code==='client_upgrade_required')throw new BrowserErpError(error.code,409,'rejected');
    throw new BrowserErpError('invalid_sync_state',status,'rejected');
  }
  async function synchronize(current:BrowserErpRead):Promise<BrowserErpSyncResult> {
    alive();
    const epoch=mutationEpoch,access=accessEpoch,read=latestRead,sync=++latestSync,blocked=writing||pending!==null||loading>0,expires=Date.now()+responseTimeoutMs;
    const deferred=():BrowserErpSyncResult=>({status:'deferred',read:current});
    const intact=()=>{
      alive();if(access!==accessEpoch)throw new BrowserErpError('session_changed',0,'unauthorized');
      return !blocked&&epoch===mutationEpoch&&read===latestRead&&sync===latestSync&&!writing&&pending===null&&loading===0;
    };
    const remaining=()=>{const value=expires-Date.now();if(value<=0)throw new BrowserErpError('response_timeout',0,'rejected');return value;};
    // Even an unresolved write must keep probing current admission. A wakeup or
    // local pending envelope never supplies permission to display another book.
    const result=await response({method:'GET',headers:headers()},false,'/revision',4096,remaining());
    alive();if(access!==accessEpoch)throw new BrowserErpError('session_changed',0,'unauthorized');
    let initial:BrowserErpRead,head:ErpRevision|null;
    try {
      initial=readProjection(current,organizationId,supportedSchemaVersion);
      if(result.body!==null&&!exactObject(result.body,['schemaVersion','organizationId','revision']))throw new Error('Invalid head');
      head=result.body===null?null:validateErpRevision(result.body,organizationId,supportedSchemaVersion);
    }catch(error){return syncError(error,result.status);}
    const from=initial.status==='ready'?initial.state.revision:0;
    if(head===null&&from>0||head!==null&&(head.revision<from||initial.status==='ready'&&(head.schemaVersion<initial.state.schemaVersion||head.revision===from&&head.schemaVersion!==initial.state.schemaVersion)))return syncError(null);
    if(!intact())return deferred();
    if(head===null||head.revision===from){readRequired=false;return {status:'unchanged',read:current};}
    let candidate=initial.status==='ready'?initial.state:null,observedHead=head.revision,observedSchema=head.schemaVersion;
    for(let page=0;page<syncPageRounds;page++){
      if(!intact())return deferred();
      const after=candidate?.revision??0;
      const next=await response({method:'GET',headers:headers()},false,`/changes?after=${after}&limit=${syncPageLimit}`,syncPageBytes,remaining());
      if(!intact())return deferred();
      let delta:ReturnType<typeof validateErpDelta>;
      try {
        delta=validateErpDelta(next.body,organizationId,after,syncPageLimit,supportedSchemaVersion);
        if(delta.headRevision<observedHead||delta.schemaVersion<observedSchema)throw new Error('Regressed head');
        observedHead=delta.headRevision;observedSchema=delta.schemaVersion;
      }catch(error){return syncError(error,next.status);}
      if(delta.resetRequired){
        // Only the durable reset marker permits a full snapshot recovery.
        const fresh=await response({method:'GET',headers:headers()},false,'',syncSnapshotBytes,remaining());
        if(!intact())return deferred();
        let value:BrowserErpRead;try{value=readProjection(fresh.body,organizationId,supportedSchemaVersion);if(value.status!=='ready'||value.state.revision<observedHead||value.state.schemaVersion<observedSchema)throw new Error('Regressed snapshot');}catch(error){return syncError(error,fresh.status);}
        if(!intact())return deferred();
        readRequired=false;return {status:'changed',read:value};
      }
      try{candidate=applyErpDelta(candidate,delta,organizationId,supportedSchemaVersion);if(!candidate||candidate.revision<=after)throw new Error('No progress');}catch(error){return syncError(error,next.status);}
      if(!delta.hasMore)break;
    }
    if(!intact())return deferred();
    let value:BrowserErpRead;try{value=readProjection({status:'ready',state:candidate},organizationId,supportedSchemaVersion);}catch(error){return syncError(error);}
    if(!intact())return deferred();
    readRequired=false;return {status:'changed',read:value};
  }
  async function send():Promise<BrowserErpResult> {
    alive();if(writing)throw new BrowserErpError('pending_operation',409,'rejected');
    if(!pending)throw new BrowserErpError('no_pending_operation',409,'rejected');
    const original=pending,startedAccess=accessEpoch;writing=true;
    try {
      const result=await response({method:'POST',headers:{...headers(),'Content-Type':'application/json'},body:original.body},true);alive();
      // Preserve exact recovery if a parallel read already observed revocation.
      if(accessEpoch!==startedAccess)throw new BrowserErpError('session_changed',0,'unauthorized');
      let value:BrowserErpResult;try{value=resultProjection(result.body,original.request,organizationId);}catch{throw new BrowserErpError('invalid_response',result.status,'uncertain');}
      pending=null;readRequired=true;return value;
    }finally{mutationEpoch++;writing=false;}
  }
  return {
    async load(){
      const epoch=mutationEpoch,read=++latestRead;loading++;
      try{
        const result=await response({method:'GET',headers:headers()},false);alive();
        if(epoch!==mutationEpoch||read!==latestRead)throw new BrowserErpError('stale_read',0,'rejected');
        let value:BrowserErpRead;try{value=readProjection(result.body,organizationId,supportedSchemaVersion);}catch(error){if(error instanceof BrowserErpError)throw error;throw new BrowserErpError('invalid_response',result.status,'rejected');}
        readRequired=false;return value;
      }finally{loading--;}
    },
    synchronize,
    async submit(command,expectedRevision){
      alive();if(pending||writing)throw new BrowserErpError('pending_operation',409,'rejected');
      if(readRequired)throw new BrowserErpError('read_required',409,'rejected');
      if(supportedSchemaVersion===1&&['save_vendor','record_vendor_bill','record_vendor_payment'].includes(command.type))throw new BrowserErpError('client_upgrade_required',409,'rejected');
      if(supportedSchemaVersion<3&&command.type==='save_projects')throw new BrowserErpError('client_upgrade_required',409,'rejected');
      if(supportedSchemaVersion<4&&['upgrade_accounting','open_period','post_manual_journal','reverse_manual_journal'].includes(command.type))throw new BrowserErpError('client_upgrade_required',409,'rejected');
      let request:ErpRequest,body:string;
      try {
        validateErpRequest({idempotencyKey:'input-validation',expectedRevision,command},organizationId);
        request=validateErpRequest({idempotencyKey:newId(),expectedRevision,command},organizationId);body=JSON.stringify(request);
        // Own the complete immutable envelope, rather than retaining form references.
        request=frozen(validateErpRequest(JSON.parse(body),organizationId));
      }catch{throw new BrowserErpError('invalid_request',422,'rejected');}
      if(new TextEncoder().encode(body).byteLength>262144)throw new BrowserErpError('request_too_large',413,'rejected');
      pending=Object.freeze({request,body});return send();
    },
    retry:send,
    hasPending:()=>!disposed&&pending!==null,
    dispose(){disposed=true;pending=null;for(const controller of controllers)controller.abort();controllers.clear();},
  };
}
