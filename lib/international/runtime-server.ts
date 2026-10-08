import { AccountPublicError, requireAccountSameOrigin, sha256Hex } from '../account-security';
import { readJsonObjectWithinLimit, RequestBodyError } from '../request-body';
import { LedgerError, type FinancialAuthority } from './accounting/ledger';
import { ErpError, executeErp, canonicalErpJson } from './runtime';
import type { ErpExecutionDependencies } from './runtime';
import { validateErpRequest } from './erp-request';
import { validateErpReceipt } from './runtime-store';
import { snapshotPrivateJson } from './private-json';
import type { ErpRequest, ErpStore } from './runtime-types';
import type { CompanyConfiguration } from './types';
import type { TaxCalculationProvider,PublicSellerSnapshot } from './invoicing';
import { publicCompanyConfiguration, publicErpState } from './public-projection';
import { confirmErpReadAdmission, confirmErpExpectedUser } from './read-admission';
import { erpClientSchemaVersion, requireErpClientSchema } from './erp-schema-capability';

export interface ErpServerDependencies {
  enabled:()=>Promise<boolean> | boolean;
  /** Exact workspace membership/seat/session and product access, not body claims. */
  authority:(request:Request,organizationId:string)=>Promise<{mode:'browser'|'device';actor:FinancialAuthority}>;
  configuration:(actor:FinancialAuthority)=>Promise<CompanyConfiguration>;
  /** Must cap the returned port to BOTH the client request and trusted server
   * configuration. A request header cannot enable a server feature. */
  store:(clientSchemaVersion?:1|2)=>Promise<ErpStore> | ErpStore;
  taxProvider:(config:CompanyConfiguration)=>Promise<TaxCalculationProvider|null>;
  projectExists?:(actor:FinancialAuthority,projectId:string)=>Promise<boolean>;
  seller?:(actor:FinancialAuthority)=>Promise<PublicSellerSnapshot|null>;
  /** Optional private TEST issuer, supplied only by trusted server wiring.
   * No runtime binding installs it by default. Only issue_invoice dispatches
   * here; other ERP commands retain the existing engine and its atomic store. */
  issueInvoiceTest?:(execution:Pick<ErpExecutionDependencies,'store'|'configuration'|'actor'|'revalidate'>,input:ErpRequest)=>Promise<Readonly<{receipt:unknown;replayed:boolean}>>;
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
    confirmErpExpectedUser(request,result);
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
        const clientSchemaVersion=erpClientSchemaVersion(request);
        const state=await(await dependencies.store(clientSchemaVersion)).read(organizationId);
        confirmErpReadAdmission(trusted,await dependencies.authority(request,organizationId));
        if(!await dependencies.enabled())throw new ErpError('feature_unavailable',404);
        if(state)requireErpClientSchema(state.schemaVersion,clientSchemaVersion);
        return json(state?{status:'ready',state:publicErpState(state)}:{status:'uninitialized',configuration:publicCompanyConfiguration(trusted.config)});
      }catch(error){return failure(error,'read',dependencies);}
    },
    async POST(request:Request,organizationId:string){
      try{
        if(!await dependencies.enabled())return json({error:'feature_unavailable'},404);
        const trusted=await context(request,organizationId,'write');
        const clientSchemaVersion=erpClientSchemaVersion(request);
        const input=await readJsonObjectWithinLimit(request,262144);
        async function revalidate(){
          // Configuration stays private and scoped to the initial admission. Read
          // authority last so changes during this await cannot authorize a commit.
          const config=await dependencies.configuration(trusted.actor);
          if(canonicalErpJson(config)!==canonicalErpJson(trusted.config))throw new ErpError('configuration_changed',409);
          const fresh=await dependencies.authority(request,organizationId);
          confirmErpReadAdmission(trusted,fresh);
          if(!await dependencies.enabled())throw new ErpError('feature_unavailable',404);
          return fresh.actor;
        }
        const requestInput=validateErpRequest(input,organizationId);
        if(['save_vendor','record_vendor_bill','record_vendor_payment'].includes(requestInput.command.type))requireErpClientSchema(2,clientSchemaVersion);
        if(requestInput.command.type==='issue_invoice'&&!['owner','admin','accountant'].includes(trusted.actor.role))throw new ErpError('financial_permission_required',403);
        const store=await dependencies.store(clientSchemaVersion);
        // Enforce the trusted factory contract even for an incorrectly wired
        // injected port. Legacy receipt lookup must use the guarded legacy RPC.
        requireErpClientSchema(store.supportedSchemaVersion??1,clientSchemaVersion);
        const execution={store,configuration:trusted.config,actor:trusted.actor,revalidate};
        const result=requestInput.command.type==='issue_invoice'&&dependencies.issueInvoiceTest
          ?await dependencies.issueInvoiceTest(execution,requestInput)
          :await executeErp({...execution,taxProvider:config=>dependencies.taxProvider(config),...(dependencies.seller?{seller:()=>dependencies.seller!(trusted.actor)}:{}),...(dependencies.projectExists?{projectExists:(_organizationId:string,projectId:string)=>dependencies.projectExists!(trusted.actor,projectId)}:{})},requestInput);
        // An injected private issuer must not project its proof or SDK metadata.
        // A receipt remains the exact public five-field ERP contract.
        async function publicResult(){
          const detached=snapshotPrivateJson(result) as typeof result;
          if(!detached||typeof detached!=='object'||Array.isArray(detached)||Reflect.ownKeys(detached).length!==2||!Object.hasOwn(detached,'receipt')||!Object.hasOwn(detached,'replayed'))throw new ErpError('invalid_receipt',503);
          const receipt=validateErpReceipt(detached.receipt,organizationId);
          const commandHash=await sha256Hex(canonicalErpJson([organizationId,trusted.actor.userId,requestInput]));
          if(typeof detached.replayed!=='boolean'||receipt.idempotencyKey!==requestInput.idempotencyKey||receipt.commandHash!==commandHash||receipt.action!==requestInput.command.type||receipt.revision!==requestInput.expectedRevision+1)throw new ErpError('invalid_receipt',503);
          if(requestInput.command.type==='issue_invoice'&&receipt.entityId!==requestInput.command.id)throw new ErpError('invalid_receipt',503);
          return {receipt,replayed:detached.replayed};
        }
        let projected;
        try{projected=await publicResult();}catch(error){await revalidate();throw error;}
        // A completed transaction remains committed if admission changes while
        // storage is pending. Withhold its receipt; an exact retry can recover it.
        await revalidate();
        return json(projected);
      }catch(error){return failure(error,'write',dependencies);}
    },
  };
}
