import { AccountPublicError, requireAccountSameOrigin } from '../account-security';
import { readJsonObjectWithinLimit, RequestBodyError } from '../request-body';
import { LedgerError } from './accounting/ledger';
import { canonicalErpJson, ErpError } from './erp-contract';
import { snapshotPrivateJson } from './private-json';
import { confirmErpExpectedUser, confirmErpReadAdmission, type ErpReadAdmission } from './read-admission';
import type { CompanyConfiguration } from './types';
import { executeUsFinancialKernelV5, validateUsFinancialRequestV5, type UsFinancialKernelStoreV5 } from './us-financial-kernel-runtime';
import { UsFinancialPilotError, validateUsFinancialPilotHead, type UsFinancialPilotHead } from './us-financial-pilot-contract';
import { projectUsFinancialPilotOverview, projectUsFinancialPilotInvoices, projectUsFinancialPilotInvoice, projectUsFinancialPilotList } from './us-financial-pilot-projection';
import { projectUsFinancialPilotReports } from './us-financial-pilot-reports';
import { validateUsFinancialPilotPaymentRequest, validateUsFinancialPilotPaymentReceipt, usFinancialPilotPaymentEntityId } from './us-financial-pilot-payment';
import type { UsFinancialPilotScope } from './us-financial-pilot-store';
import { creationUuid } from './workspace-creation';

export type UsFinancialPilotStore=UsFinancialKernelStoreV5 & {head(this:void):Promise<UsFinancialPilotHead>};
export interface UsFinancialPilotDependencies {
  enabled(this:void):Promise<boolean>|boolean;
  authority(this:void,request:Request,organizationId:string):Promise<ErpReadAdmission>;
  configuration(this:void,actor:ErpReadAdmission['actor']):Promise<CompanyConfiguration>;
  scope(this:void,actor:ErpReadAdmission['actor'],expected?:UsFinancialPilotScope):Promise<UsFinancialPilotScope>;
  store(this:void,scope:UsFinancialPilotScope,revalidate:()=>Promise<UsFinancialPilotScope>):Promise<UsFinancialPilotStore>|UsFinancialPilotStore;
  rateLimit(this:void,request:Request,actor:ErpReadAdmission['actor'],operation:'read'|'write'):Promise<void>;
  diagnostic(this:void,event:Readonly<{operation:'read'|'write';code:string;status:number}>):void;
}
const headers={'Cache-Control':'no-store, max-age=0','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Vary':'Cookie, X-Zentra-Expected-User, X-Zentra-Financial-Pilot'};
const json=(data:unknown,status=200)=>Response.json(data,{status,headers});
const allowedCodes=new Set(['unauthorized','session_changed','forbidden','tenant_mismatch','management_entitlement_required','financial_permission_required','feature_unavailable','financial_pilot_unavailable','financial_pilot_opt_in_required','financial_pilot_opt_in_changed','financial_test_grant_required','financial_test_grant_changed','financial_authority_changed','financial_configuration_changed','financial_policy_unavailable','financial_upgrade_required','financial_capability_unavailable','financial_book_too_large','financial_snapshot_changed','financial_book_required','financial_source_changed','financial_clock_reversed','financial_immutable','financial_append_unavailable','financial_tax_plan_required','invalid_financial_pilot_request','invalid_financial_pilot_cursor','invalid_financial_request','invalid_financial_date','revision_conflict','idempotency_conflict','settlement_amount_conflict','payment_exceeds_balance','accounting_period_not_open','invoice_not_found','account_not_found','cash_flow_classification_required','rate_limited','invalid_request','edition_unavailable','configuration_changed']);
function failure(value:unknown,operation:'read'|'write',deps:UsFinancialPilotDependencies):Response{
  let status=503,code='financial_service_unavailable';
  if(value instanceof UsFinancialPilotError){status=value.status;code=value.code;}
  else if(value instanceof ErpError&&allowedCodes.has(value.code)){status=value.status;code=value.code;}
  else if(value instanceof AccountPublicError){status=value.status;code=status===401?'unauthorized':status===402?'management_entitlement_required':status===429?'rate_limited':'forbidden';}
  else if(value instanceof RequestBodyError){status=value.status;code='invalid_request';}
  else if(value instanceof LedgerError){const mapped:Record<string,readonly[string,number]>={PAYMENT_EXCEEDS_BALANCE:['payment_exceeds_balance',422],PERIOD_CLOSED:['accounting_period_not_open',409],ACCOUNTING_PERIOD_CLOSED:['accounting_period_not_open',409],FINANCIAL_PERMISSION_REQUIRED:['financial_permission_required',403]};const known=mapped[value.message];if(known){[code,status]=known;}}
  try{deps.diagnostic({operation,code,status});}catch{/* telemetry never changes financial outcome */}
  return json({error:code},status);
}
function query(request:Request,allowed:readonly string[]):URLSearchParams{
  const params=new URL(request.url).searchParams;
  for(const key of params.keys())if(!allowed.includes(key)||params.getAll(key).length!==1)throw new ErpError('invalid_financial_pilot_request',422);
  return params;
}
function revision(params:URLSearchParams,required=true):number|undefined{
  const raw=params.get('revision');if(raw===null&&!required)return undefined;
  if(raw===null||!/^[1-9][0-9]{0,15}$/.test(raw)||!Number.isSafeInteger(Number(raw))||Number(raw)>=Number.MAX_SAFE_INTEGER)throw new ErpError('invalid_financial_pilot_request',422);
  return Number(raw);
}
type ReadKind='head'|'snapshot'|'invoices'|'invoice'|'reports'|'list';
/** Separate browser TEST protocol. It never negotiates public ERP5, provisions
 * grants or tax facts, falls back to a frozen baseline, or routes native auth. */
export function createUsFinancialPilotHandlers(bindings:UsFinancialPilotDependencies){
  const deps:UsFinancialPilotDependencies=Object.freeze({enabled:bindings.enabled.bind(undefined),authority:bindings.authority.bind(undefined),configuration:bindings.configuration.bind(undefined),scope:bindings.scope.bind(undefined),store:bindings.store.bind(undefined),rateLimit:bindings.rateLimit.bind(undefined),diagnostic:bindings.diagnostic.bind(undefined)});
  async function run(request:Request,organizationId:string,kind:ReadKind|'payment',detail?:string):Promise<Response>{
    const operation=kind==='payment'?'write':'read';
    let trusted:ErpReadAdmission|undefined,scope:UsFinancialPilotScope|undefined,configuration:CompanyConfiguration|undefined,authorityAttempted=false;
    async function freshAuthority():Promise<ErpReadAdmission>{
      const fresh=snapshotPrivateJson(await deps.authority(request,organizationId)) as ErpReadAdmission;
      confirmErpExpectedUser(request,fresh);
      if(fresh.mode!=='browser')throw new ErpError('forbidden',403);
      if(fresh.actor.organizationId!==organizationId)throw new ErpError('tenant_mismatch',403);
      if(!fresh.actor.managementEntitled)throw new ErpError('management_entitlement_required',402);
      if(!['owner','admin','accountant'].includes(fresh.actor.role))throw new ErpError('financial_permission_required',403);
      if(trusted)confirmErpReadAdmission(trusted,fresh);
      return fresh;
    }
    async function revalidate():Promise<UsFinancialPilotScope>{
      const fresh=await freshAuthority();
      if(!await deps.enabled())throw new ErpError('feature_unavailable',404);
      const current=await deps.scope(fresh.actor,scope);
      if(configuration&&canonicalErpJson(await deps.configuration(fresh.actor))!==canonicalErpJson(configuration)){
        await freshAuthority();throw new ErpError('financial_configuration_changed',409);
      }
      // Auth/D1 and the feature switch can change while PG/configuration is
      // awaited. Recheck after that final private wait, without claiming a
      // distributed Auth/D1/PG transaction or replacing PG's locked grant.
      await freshAuthority();
      if(!await deps.enabled())throw new ErpError('feature_unavailable',404);
      return current;
    }
    try{
      // A device credential must never enter the old browser/device dispatcher.
      if(request.headers.has('Authorization'))throw new ErpError('forbidden',403);
      if(request.headers.get('X-Zentra-Financial-Pilot')!=='1'||!request.headers.get('X-Zentra-Expected-User'))throw new ErpError('invalid_financial_pilot_request',422);
      try{creationUuid(organizationId);}catch{throw new ErpError('invalid_financial_pilot_request',422);}
      if(request.method!==(operation==='write'?'POST':'GET'))throw new ErpError('invalid_financial_pilot_request',422);
      if(!await deps.enabled())throw new ErpError('feature_unavailable',404);
      const params=query(request,kind==='head'||kind==='payment'?[]:kind==='snapshot'?['revision']:kind==='reports'?['revision','from','to','asOf','accountId','cursor']:kind==='invoice'?['revision','paymentCursor','creditCursor']:['revision','cursor']);
      const expected=kind==='head'||kind==='payment'?undefined:revision(params,kind!=='snapshot');
      if(operation==='write')requireAccountSameOrigin(request);
      authorityAttempted=true;trusted=await freshAuthority();
      await deps.rateLimit(request,trusted.actor,operation);
      scope=await deps.scope(trusted.actor);
      if(scope.scope.organizationId!==organizationId||scope.scope.actor.userId!==trusted.actor.userId||scope.scope.actor.role!==trusted.actor.role)throw new ErpError('financial_authority_changed',403);
      const store=await deps.store(scope,revalidate);
      let result:unknown;
      if(kind==='head')result=validateUsFinancialPilotHead(await store.head(),organizationId);
      else if(kind==='payment'){
        const input=validateUsFinancialPilotPaymentRequest(await readJsonObjectWithinLimit(request,16_384));
        configuration=snapshotPrivateJson(await deps.configuration(trusted.actor)) as CompanyConfiguration;
        if(configuration.organizationId!==organizationId||configuration.country!=='US'||configuration.currency!=='USD'||configuration.accountingBasis!=='accrual')throw new ErpError('edition_unavailable',409);
        const privateRequest=validateUsFinancialRequestV5({idempotencyKey:`pilot:${input.requestId}`,expectedRevision:input.expectedRevision,command:{...input.command,id:usFinancialPilotPaymentEntityId(input.requestId)}},organizationId);
        const receipt=await executeUsFinancialKernelV5({configuration,actor:scope.scope.actor,policy:scope.scope.policy,store,revalidate:async()=>{const fresh=await revalidate();return{configuration:configuration!,actor:fresh.scope.actor,policy:fresh.scope.policy};},resolveTax:async()=>{throw new ErpError('financial_tax_plan_required',409);}},privateRequest);
        result=validateUsFinancialPilotPaymentReceipt({consumer:'financial-pilot',schemaVersion:1,organizationId,revision:receipt.revision,entityId:receipt.entityId,action:receipt.action},organizationId,input);
      }else{
        const book=await store.read(organizationId);if(!book)throw new ErpError('financial_book_required',409);
        if(kind==='snapshot')result=await projectUsFinancialPilotOverview(book,expected);
        else if(kind==='invoices')result=await projectUsFinancialPilotInvoices(book,{revision:expected!,cursor:params.get('cursor')});
        else if(kind==='invoice'){
          if(!detail)throw new ErpError('invalid_financial_pilot_request',422);
          result=await projectUsFinancialPilotInvoice(book,{revision:expected!,invoiceId:detail,...(params.has('paymentCursor')?{paymentCursor:params.get('paymentCursor')!}:{}),...(params.has('creditCursor')?{creditCursor:params.get('creditCursor')!}:{})});
        }else if(kind==='list'){
          if(!['customers','vendors','estimates','journals','periods'].includes(detail??''))throw new ErpError('invalid_financial_pilot_request',422);
          result=await projectUsFinancialPilotList(book,{revision:expected!,kind:detail as 'customers'|'vendors'|'estimates'|'journals'|'periods',cursor:params.get('cursor')});
        }else result=await projectUsFinancialPilotReports(book,{revision:expected!,from:params.get('from')??'',to:params.get('to')??'',asOf:params.get('asOf')??'',...(params.has('accountId')?{accountId:params.get('accountId')!}:{}),...(params.has('cursor')?{cursor:params.get('cursor')!}:{})});
      }
      await revalidate();
      return json(result);
    }catch(error){
      let latest=error;
      if(authorityAttempted)try{await freshAuthority();}catch(fresh){if((fresh instanceof ErpError||fresh instanceof AccountPublicError)&&[401,402,403].includes(fresh.status))latest=fresh;}
      return failure(latest,operation,deps);
    }
  }
  return Object.freeze({HEAD:(request:Request,organizationId:string)=>run(request,organizationId,'head'),SNAPSHOT:(request:Request,organizationId:string)=>run(request,organizationId,'snapshot'),INVOICES:(request:Request,organizationId:string)=>run(request,organizationId,'invoices'),INVOICE:(request:Request,organizationId:string,id:string)=>run(request,organizationId,'invoice',id),LIST:(request:Request,organizationId:string,kind:string)=>run(request,organizationId,'list',kind),REPORTS:(request:Request,organizationId:string)=>run(request,organizationId,'reports'),POST:(request:Request,organizationId:string)=>run(request,organizationId,'payment')});
}
