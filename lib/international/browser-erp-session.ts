import { validateErpRequest } from './erp-request';
import { validateCompanyConfiguration } from './country-config';
import { validateStoredErp } from './runtime-validation';
import type { CompanyConfiguration } from './types';
import type { ErpCommand, ErpReceipt, ErpRequest, ErpState } from './runtime-types';

export type BrowserErpRead=Readonly<{status:'ready';state:ErpState}|{status:'uninitialized';configuration:CompanyConfiguration}>;
export type BrowserErpResult=Readonly<{receipt:ErpReceipt;replayed:boolean}>;
export type BrowserErpOutcome='rejected'|'uncertain'|'unauthorized';
export class BrowserErpError extends Error {
  constructor(readonly code:string,readonly status:number,readonly outcome:BrowserErpOutcome){super(code);this.name='BrowserErpError';}
}
export interface BrowserErpSessionOptions {
  organizationId:string;
  /** Non-secret stale-account fence. The server must compare it to its own Auth actor. */
  expectedUserId?:string;
  fetch?:typeof globalThis.fetch;
  newId?:()=>string;
}
export interface BrowserErpSession {
  load():Promise<BrowserErpRead>;
  submit(command:ErpCommand,expectedRevision:number):Promise<BrowserErpResult>;
  retry():Promise<BrowserErpResult>;
  hasPending():boolean;
  dispose():void;
}
const rejectedConflicts=new Set(['revision_conflict','estimate_revision_conflict','idempotency_conflict']);
const responseTimeoutMs=30000;
// Never turn arbitrary server/debug text into an error shown to a browser user.
const publicErrors=new Set(['unauthorized','session_changed','forbidden','management_entitlement_required','financial_permission_required','owner_required','tenant_mismatch','feature_unavailable','edition_unavailable','country_configuration_required','configuration_changed','service_unavailable','invalid_request','invalid_date','invalid_customer','invalid_email','invalid_estimate','invalid_period','invalid_payment_terms','invalid_amount','revision_conflict','estimate_revision_conflict','idempotency_conflict','already_initialized','workspace_not_initialized','workspace_unavailable','immutable_record','invalid_state','invalid_stored_state','project_not_found','customer_required','estimate_not_found','issued_estimate_locked','invoice_already_issued','invoice_not_found','number_sequence_exhausted','accounting_period_not_open','tax_configuration_required','seller_configuration_required','tax_assessment_expired','stale_tax_assessment','payment_exceeds_balance','period_closed','event_too_large']);
const exactObject=(value:unknown,keys:readonly string[]):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))&&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
function frozen<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))frozen(child);Object.freeze(value);}return value;}
function readProjection(value:unknown,organizationId:string):BrowserErpRead {
  if(exactObject(value,['status','configuration'])&&value.status==='uninitialized'){
    const configuration=validateCompanyConfiguration(value.configuration);
    if(configuration.organizationId!==organizationId||configuration.country!=='US'||configuration.currency!=='USD'||Object.hasOwn(configuration,'ein'))throw new Error('Invalid public configuration');
    return frozen(structuredClone({status:'uninitialized' as const,configuration}));
  }
  if(exactObject(value,['status','state'])&&value.status==='ready'){
    const state=validateStoredErp(value.state,organizationId);
    if(state.configuration.country!=='US'||state.configuration.currency!=='USD'||Object.hasOwn(state.configuration,'ein')||state.invoices.some(invoice=>Object.hasOwn(invoice.companyConfiguration,'ein')))throw new Error('Invalid public state');
    return frozen(structuredClone({status:'ready' as const,state}));
  }
  throw new Error('Invalid public projection');
}
function entityId(request:ErpRequest,organizationId:string):string {
  switch(request.command.type){
    case 'initialize':case 'refresh_configuration':return organizationId;
    case 'save_customer':return request.command.customer.id;
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
  if(typeof organizationId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(organizationId)||expectedUserId!==undefined&&(typeof expectedUserId!=='string'||!expectedUserId.trim()||expectedUserId!==expectedUserId.trim()||expectedUserId.length>256||Array.from(expectedUserId).some(char=>char.charCodeAt(0)<32||char.charCodeAt(0)===127)))throw new BrowserErpError('invalid_request',422,'rejected');
  const fetcher=options.fetch??globalThis.fetch.bind(globalThis),newId=options.newId??(()=>globalThis.crypto.randomUUID());
  const url=`/api/international/workspaces/${encodeURIComponent(organizationId)}/erp`;
  const controllers=new Set<AbortController>();
  let disposed=false,writing=false,readRequired=false,mutationEpoch=0,latestRead=0,pending:Readonly<{body:string;request:ErpRequest}>|null=null;
  function alive(){if(disposed)throw new BrowserErpError('session_disposed',0,'unauthorized');}
  const headers=()=>({Accept:'application/json',...(expectedUserId===undefined?{}:{'X-Zentra-Expected-User':expectedUserId})});
  async function response(request:RequestInit,write:boolean):Promise<{body:unknown;status:number}> {
    alive();const controller=new AbortController();controllers.add(controller);
    let timedOut=false,timer:ReturnType<typeof setTimeout>|undefined;
    const deadline=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{timedOut=true;reject(new BrowserErpError('response_timeout',0,write?'uncertain':'rejected'));controller.abort();},responseTimeoutMs);});
    try {
      const result=await Promise.race([fetcher(url,{...request,credentials:'same-origin',mode:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal}),deadline]);alive();
      const unauthorizedCode=result.status===401?'unauthorized':result.status===402?'management_entitlement_required':result.status===403?'forbidden':null;
      let body:unknown;try{body=await Promise.race([result.json(),deadline]);}catch{if(unauthorizedCode){mutationEpoch++;throw new BrowserErpError(unauthorizedCode,result.status,'unauthorized');}if(timedOut)throw new BrowserErpError('response_timeout',0,write?'uncertain':'rejected');throw new BrowserErpError('invalid_response',result.status,write?'uncertain':'rejected');}alive();
      if(!result.ok){
        const code=exactObject(body,['error'])&&typeof body.error==='string'&&publicErrors.has(body.error)?body.error:'service_unavailable';
        const unauthorized=[401,402,403].includes(result.status);
        if(unauthorized)mutationEpoch++;
        if(write&&result.status===409&&rejectedConflicts.has(code)){pending=null;readRequired=true;throw new BrowserErpError(code,result.status,'rejected');}
        throw new BrowserErpError(code,result.status,unauthorized?'unauthorized':write?'uncertain':'rejected');
      }
      return {body,status:result.status};
    } catch(error){alive();if(error instanceof BrowserErpError&&error.outcome==='unauthorized')throw error;if(timedOut)throw new BrowserErpError('response_timeout',0,write?'uncertain':'rejected');if(error instanceof BrowserErpError)throw error;throw new BrowserErpError('response_unavailable',0,write?'uncertain':'rejected');}
    finally{if(timer!==undefined)clearTimeout(timer);controllers.delete(controller);}
  }
  async function send():Promise<BrowserErpResult> {
    alive();if(writing)throw new BrowserErpError('pending_operation',409,'rejected');
    if(!pending)throw new BrowserErpError('no_pending_operation',409,'rejected');
    const original=pending;writing=true;
    try {
      const result=await response({method:'POST',headers:{...headers(),'Content-Type':'application/json'},body:original.body},true);alive();
      let value:BrowserErpResult;try{value=resultProjection(result.body,original.request,organizationId);}catch{throw new BrowserErpError('invalid_response',result.status,'uncertain');}
      pending=null;readRequired=true;return value;
    }finally{mutationEpoch++;writing=false;}
  }
  return {
    async load(){
      const epoch=mutationEpoch,read=++latestRead;
      const result=await response({method:'GET',headers:headers()},false);alive();
      if(epoch!==mutationEpoch||read!==latestRead)throw new BrowserErpError('stale_read',0,'rejected');
      let value:BrowserErpRead;try{value=readProjection(result.body,organizationId);}catch{throw new BrowserErpError('invalid_response',result.status,'rejected');}
      readRequired=false;return value;
    },
    async submit(command,expectedRevision){
      alive();if(pending||writing)throw new BrowserErpError('pending_operation',409,'rejected');
      if(readRequired)throw new BrowserErpError('read_required',409,'rejected');
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
