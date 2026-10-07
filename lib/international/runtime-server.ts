import { AccountPublicError, requireAccountSameOrigin } from '../account-security';
import { readJsonObjectWithinLimit, RequestBodyError } from '../request-body';
import { LedgerError, type FinancialAuthority } from './accounting/ledger';
import { ErpError, executeErp, canonicalErpJson } from './runtime';
import type { ErpStore } from './runtime-types';
import type { CompanyConfiguration } from './types';
import type { TaxCalculationProvider,PublicSellerSnapshot } from './invoicing';

export interface ErpServerDependencies {
  enabled:()=>Promise<boolean> | boolean;
  /** Exact workspace membership/seat/session and product access, not body claims. */
  authority:(request:Request,organizationId:string)=>Promise<{mode:'browser'|'device';actor:FinancialAuthority}>;
  configuration:(actor:FinancialAuthority)=>Promise<CompanyConfiguration>;
  store:()=>Promise<ErpStore> | ErpStore;
  taxProvider:(config:CompanyConfiguration)=>Promise<TaxCalculationProvider|null>;
  projectExists?:(actor:FinancialAuthority,projectId:string)=>Promise<boolean>;
  seller?:(actor:FinancialAuthority)=>Promise<PublicSellerSnapshot|null>;
  rateLimit:(request:Request,actor:FinancialAuthority,operation:'read'|'write')=>Promise<void>;
  /** No document text, addresses, secrets, token, tax raw response or payment details. */
  diagnostic:(event:{operation:'read'|'write';code:string;status:number})=>void;
}
const headers={'Cache-Control':'no-store, max-age=0','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
function json(value:unknown,status=200){return Response.json(value,{status,headers});}
const financialCodes:Record<string,number>={TENANT_MISMATCH:403,MANAGEMENT_ENTITLEMENT_REQUIRED:402,FINANCIAL_PERMISSION_REQUIRED:403,INVOICE_PERMISSION_REQUIRED:403,REVISION_CONFLICT:409,IDEMPOTENCY_CONFLICT:409,PAYMENT_EXCEEDS_BALANCE:422,TAX_CONFIGURATION_REQUIRED:409,TAX_ASSESSMENT_EXPIRED:409,STALE_TAX_ASSESSMENT:409,PERIOD_CLOSED:409};
function failure(error:unknown,operation:'read'|'write',dependencies:ErpServerDependencies):Response{
  let code='service_unavailable',status=503;
  if(error instanceof ErpError){code=error.code;status=error.status;}
  else if(error instanceof AccountPublicError){status=error.status;code=status===401?'unauthorized':status===402?'management_entitlement_required':'forbidden';}
  else if(error instanceof RequestBodyError){status=error.status;code='invalid_request';}
  else if(error instanceof LedgerError){code=error.message.toLowerCase();status=financialCodes[error.message]??422;}
  else if(error instanceof TypeError||error instanceof RangeError){status=422;code='invalid_request';}
  // Diagnostic sink cannot make an already rejected financial operation successful.
  try{dependencies.diagnostic({operation,code,status});}catch{/* optional telemetry unavailable */}
  return json({error:code},status);
}
function path(organizationId:string){if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(organizationId))throw new ErpError('invalid_request');}
export function createErpHandlers(dependencies:ErpServerDependencies){
  async function context(request:Request,organizationId:string,operation:'read'|'write'){
    path(organizationId);
    const result=await dependencies.authority(request,organizationId);
    if(result.actor.organizationId!==organizationId)throw new ErpError('tenant_mismatch',403);
    if(!result.actor.managementEntitled)throw new ErpError('management_entitlement_required',402);
    if(operation==='write'&&result.mode==='browser')requireAccountSameOrigin(request);
    await dependencies.rateLimit(request,result.actor,operation);
    const config=await dependencies.configuration(result.actor);
    if(config.organizationId!==organizationId)throw new ErpError('tenant_mismatch',403);
    if(config.country!=='US')throw new ErpError('edition_unavailable',409);
    return {...result,config};
  }
  return {
    async GET(request:Request,organizationId:string){
      try{
        if(!await dependencies.enabled())return json({error:'feature_unavailable'},404);
        const trusted=await context(request,organizationId,'read');
        const state=await(await dependencies.store()).read(organizationId);
        return json(state?{status:'ready',state}:{status:'uninitialized',configuration:trusted.config});
      }catch(error){return failure(error,'read',dependencies);}
    },
    async POST(request:Request,organizationId:string){
      try{
        if(!await dependencies.enabled())return json({error:'feature_unavailable'},404);
        const trusted=await context(request,organizationId,'write');
        const input=await readJsonObjectWithinLimit(request,262144);
        const result=await executeErp({store:await dependencies.store(),configuration:trusted.config,actor:trusted.actor,taxProvider:config=>dependencies.taxProvider(config),...(dependencies.seller?{seller:()=>dependencies.seller!(trusted.actor)}:{}),...(dependencies.projectExists?{projectExists:(_organizationId:string,projectId:string)=>dependencies.projectExists!(trusted.actor,projectId)}:{}),async revalidate(){
          const fresh=await dependencies.authority(request,organizationId);
          if(fresh.mode!==trusted.mode||fresh.actor.organizationId!==trusted.actor.organizationId||fresh.actor.userId!==trusted.actor.userId)throw new ErpError('session_changed',401);
          const config=await dependencies.configuration(fresh.actor);
          if(canonicalErpJson(config)!==canonicalErpJson(trusted.config))throw new ErpError('configuration_changed',409);
          return fresh.actor;
        }},input);
        return json(result);
      }catch(error){return failure(error,'write',dependencies);}
    },
  };
}
