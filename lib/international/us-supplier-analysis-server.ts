import { AccountPublicError, requireAccountSameOrigin } from '../account-security';
import { readJsonObjectWithinLimit, RequestBodyError } from '../request-body';
import type { FinancialAuthority } from './accounting/ledger';
import { canonicalErpJson, ErpError } from './erp-contract';
import { erpClientSchemaVersion, type ErpSchemaVersion } from './erp-schema-capability';
import { snapshotPrivateJson } from './private-json';
import { confirmErpExpectedUser, confirmErpReadAdmission, type ErpReadAdmission } from './read-admission';
import type { ErpServerDependencies } from './runtime-server';
import type { CompanyConfiguration } from './types';
import { creationUuid } from './workspace-creation';
import type { UsAutomationGrant, UsAutomationStore } from './us-automation-contract';
import { automationExact, validateUsAutomationSettings, validateUsAutomationSettingsRequest, validateUsAutomationGrant, validateUsAutomationUsage } from './us-automation-validation';
import { UsAutomationPolicyError, type UsAutomationBudgetPolicy } from './us-automation-policy';
import { readBrowserUsAnalysisReadiness, type BrowserUsAnalysisReadiness, type UsAnalysisReason } from './browser-us-analysis-session';

export type UsAnalysisSettingsDependencies = Pick<ErpServerDependencies, 'enabled' | 'authority' | 'configuration' | 'store' | 'freshSupportedSchemaVersion' | 'rateLimit' | 'diagnostic'> & {
  automationAccess(actor: FinancialAuthority): Promise<void>;
  analysisStore(capability: ErpSchemaVersion): Promise<UsAutomationStore> | UsAutomationStore;
  policy(): Promise<UsAutomationBudgetPolicy | null>;
  grant(actor: FinancialAuthority, policy: UsAutomationBudgetPolicy): Promise<UsAutomationGrant>;
  providerReady(): Promise<boolean>;
  now(): number;
};
const headers = { 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const codes: Readonly<Record<string, number>> = {
  invalid_request:422, invalid_automation_request:422, invalid_automation_record:503,
  unauthorized:401, session_changed:401, forbidden:403, tenant_mismatch:403,
  financial_permission_required:403, financial_authority_changed:403, management_entitlement_required:402, automation_entitlement_required:402,
  feature_unavailable:404, edition_unavailable:409, configuration_changed:409, client_upgrade_required:409,
  automation_upgrade_required:409, automation_permission_required:403, automation_consent_required:409,
  automation_revision_conflict:409, automation_idempotency_conflict:409,
  rate_limited:429, service_unavailable:503,
};
const json = (body:unknown,status=200) => Response.json(body,{status,headers});
function financial(actor:FinancialAuthority) {
  if (!actor.managementEntitled) throw new ErpError('management_entitlement_required',402);
  if (!['owner','admin','accountant'].includes(actor.role)) throw new ErpError('financial_permission_required',403);
}
function cap(value:unknown) { if(value!==4)throw new ErpError('automation_upgrade_required',409); }
function privateSettings(input:unknown,org:string){try{return validateUsAutomationSettings(input,org);}catch{throw new ErpError('invalid_automation_record',503);}}
function errorCode(error:unknown) {
  if(error instanceof ErpError && Object.hasOwn(codes,error.code) && codes[error.code]===error.status)return {error:error.code,status:error.status};
  if(error instanceof RequestBodyError)return {error:'invalid_automation_request',status:error.status};
  if(error instanceof AccountPublicError && [401,402,403,429].includes(error.status))return {error: error.status===401?'unauthorized':error.status===402?'automation_entitlement_required':error.status===429?'rate_limited':'forbidden',status:error.status};
  return {error:'service_unavailable',status:503};
}
/** Public settings contains no provider secret, job lease, source or payment
 * evidence. GET never reserves, dispatches or commits financial operations. */
export function createUsAnalysisSettingsHandlers(dependencies:UsAnalysisSettingsDependencies) {
  async function handle(request:Request, organizationId:string, operation:'read'|'write') {
    let trusted:ErpReadAdmission|undefined, configuration:CompanyConfiguration|undefined;
    const clock=()=>{const n=dependencies.now();if(!Number.isSafeInteger(n)||n<=0)throw new ErpError('service_unavailable',503);return n;};
    async function revalidate() {
      if(!trusted)throw new ErpError('unauthorized',401);
      let delayed:unknown;
      try {
        if(configuration && canonicalErpJson(await dependencies.configuration(trusted.actor))!==canonicalErpJson(configuration))throw new ErpError('configuration_changed',409);
        cap(dependencies.freshSupportedSchemaVersion ? await dependencies.freshSupportedSchemaVersion(4) : (await dependencies.store(4)).supportedSchemaVersion);
      } catch(error) {delayed=error;}
      const fresh=await dependencies.authority(request,organizationId);
      confirmErpExpectedUser(request,fresh);confirmErpReadAdmission(trusted,fresh);financial(fresh.actor);
      await dependencies.automationAccess(fresh.actor);
      if(!await dependencies.enabled())throw new ErpError('feature_unavailable',404);
      if(delayed)throw delayed;
      return fresh.actor;
    }
    try {
      try{creationUuid(organizationId);}catch{throw new ErpError('invalid_request');}
      if(new URL(request.url).search || !['GET','POST'].includes(request.method))throw new ErpError('invalid_request');
      if(!await dependencies.enabled())throw new ErpError('feature_unavailable',404);
      trusted=snapshotPrivateJson(await dependencies.authority(request,organizationId)) as ErpReadAdmission;
      if(!['browser','device'].includes(trusted.mode))throw new ErpError('unauthorized',401);
      confirmErpExpectedUser(request,trusted);financial(trusted.actor);
      if(trusted.actor.organizationId!==organizationId)throw new ErpError('tenant_mismatch',403);
      if(operation==='write' && trusted.mode==='browser')requireAccountSameOrigin(request);
      await dependencies.automationAccess(trusted.actor);
      await dependencies.rateLimit?.(request,trusted.actor,operation);
      cap(erpClientSchemaVersion(request));
      const store=await dependencies.store(4), analysis=await dependencies.analysisStore(4);cap(store.supportedSchemaVersion);cap(analysis.supportedSchemaVersion);
      configuration=snapshotPrivateJson(await dependencies.configuration(trusted.actor)) as CompanyConfiguration;
      if(configuration.organizationId!==organizationId)throw new ErpError('tenant_mismatch',403);
      if(configuration.country!=='US'||configuration.currency!=='USD')throw new ErpError('edition_unavailable',409);
      const book=await store.read(organizationId);
      if(!book || book.schemaVersion!==4 || book.ledger.organizationId!==organizationId || book.ledger.currency!=='USD' || canonicalErpJson(book.configuration)!==canonicalErpJson(configuration))throw new ErpError('configuration_changed',409);
      const initialActor=await revalidate();
      let receipt:undefined|Readonly<{requestId:string;revision:number;mode:'active'|'paused';policyVersion:string|null;consent:boolean}>, replayed=false;
      if(operation==='write') {
        const v=automationExact(await readJsonObjectWithinLimit(request,4096),['schemaVersion','requestId','expectedRevision','mode','policyVersion','consent']);
        if(v.schemaVersion!==1 || !['active','paused'].includes(String(v.mode)))throw new ErpError('invalid_automation_request');
        if(v.mode==='active' ? initialActor.role!=='owner' : !['owner','admin'].includes(initialActor.role))throw new ErpError('automation_permission_required',403);
        const policy=await dependencies.policy();
        if(v.mode==='active' && (!policy || v.policyVersion!==policy.processingPolicyVersion))throw new ErpError('automation_consent_required',409);
        const change=validateUsAutomationSettingsRequest({schemaVersion:v.schemaVersion,requestId:v.requestId,expectedRevision:v.expectedRevision,action:v.mode==='active'?'activate':'pause',processingPolicyVersion:v.policyVersion,consent:v.consent});
        // An activation may preserve consent while no quota/provider is ready.
        // It cannot invoke an analysis until all independent gates pass.
        const before=await revalidate();
        if(v.mode==='active' && (await dependencies.policy())?.processingPolicyVersion!==v.policyVersion)throw new ErpError('automation_consent_required',409);
        const result=await analysis.saveSettings(before,change);
        const historical=privateSettings(result.settings,organizationId);
        if(typeof result.replayed!=='boolean' || historical.revision!==change.expectedRevision+1 || historical.enabled!==(v.mode==='active'))throw new ErpError('invalid_automation_record',503);
        if(change.action==='activate' && (historical.consent?.processingPolicyVersion!==change.processingPolicyVersion || historical.consent.acceptedBy!==before.userId))throw new ErpError('invalid_automation_record',503);
        receipt={requestId:change.requestId,revision:historical.revision,mode:v.mode as 'active'|'paused',policyVersion:v.policyVersion as string|null,consent:v.consent as boolean};replayed=result.replayed;
      }
      const actor=await revalidate();
      const settings=privateSettings(await analysis.readSettings(actor),organizationId);
      if(receipt && settings.revision<receipt.revision)throw new ErpError('invalid_automation_record',503);
      const policy=await dependencies.policy();
      let grant:UsAutomationGrant|null=null;
      if(policy) {
        try {grant=validateUsAutomationGrant(await dependencies.grant(await revalidate(),policy),organizationId);}
        catch(error) {if(!(error instanceof UsAutomationPolicyError)||error.code!=='automation_budget_unavailable')throw error;}
      }
      const providerReady=await dependencies.providerReady();
      let quota:BrowserUsAnalysisReadiness['quota']=null;
      if(grant) {
        const usage=validateUsAutomationUsage(await analysis.usage(await revalidate(),grant),grant);
        quota={limit:usage.limit,used:usage.consumed,reserved:usage.held,remaining:usage.remaining,periodStart:grant.periodStart,periodEnd:grant.periodEnd};
      }
      await revalidate();
      // Settings/policy revocation after asynchronous quota/provider reads
      // cannot be exposed as a fresh ready projection.
      const finalSettings=privateSettings(await analysis.readSettings(await revalidate()),organizationId);
      const finalPolicy=await dependencies.policy();
      if(canonicalErpJson(finalSettings)!==canonicalErpJson(settings)||canonicalErpJson(finalPolicy)!==canonicalErpJson(policy))throw new ErpError('configuration_changed',409);
      const checkedAt=clock();
      let reason:UsAnalysisReason|null=!policy?'policy_unconfigured':!settings.enabled?'paused':settings.consent?.processingPolicyVersion!==policy.processingPolicyVersion?'consent_required':!grant?'quota_unconfigured':!providerReady?'provider_unconfigured':!quota || quota.remaining===0?'quota_exhausted':null;
      if(grant && (checkedAt<grant.periodStart || checkedAt>=grant.periodEnd))reason='configuration_required';
      const expiresAt=reason===null && grant ? Math.min(checkedAt+120,grant.periodEnd):checkedAt+120;
      const projection=readBrowserUsAnalysisReadiness({schemaVersion:1,organizationId,revision:settings.revision,mode:settings.enabled?'active':'paused',availability:reason===null?'ready':'blocked',reason,mayConfigure:actor.role==='owner'||actor.role==='admin',policyVersion:policy?.processingPolicyVersion??null,acceptedPolicyVersion:settings.consent?.processingPolicyVersion??null,quota,checkedAt,expiresAt},organizationId,checkedAt);
      await revalidate();
      return json(receipt ? {settings:projection,receipt,replayed} : projection);
    }catch(error){
      let latest=error;
      if(trusted)try{await revalidate();}catch(freshError){latest=freshError;}
      const failure=errorCode(latest);
      try{dependencies.diagnostic?.({operation,code:failure.error,status:failure.status});}catch{/* bounded codes only */}
      return json({error:failure.error},failure.status);
    }
  }
  return {GET:(request:Request,org:string)=>handle(request,org,'read'),POST:(request:Request,org:string)=>handle(request,org,'write')};
}
