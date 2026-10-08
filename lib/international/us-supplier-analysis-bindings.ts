import { erpServerDependencies, usPurchasingSchemaVersion } from './runtime-bindings';
import { UsAuthorityError } from './saas-authority';
import { requireUsWorkspaceAccess, requireUsWorkspaceAutomationAuthority } from './saas-authority-d1';
import { createUsAutomationGrant, parseUsAutomationBudgetPolicy, type UsAutomationBudgetPolicy } from './us-automation-policy';
import { createSupabaseUsAutomationStore } from './us-automation-store';
import { createSupabaseUsSupplierStore } from './us-supplier-store';
import { createUsAnalysisSettingsHandlers } from './us-supplier-analysis-server';
import { createUsSupplierAnalysis } from './us-supplier-analysis';
import { ErpError } from './erp-contract';
import type { FinancialAuthority } from './accounting/ledger';
import type { UsSupplierServerDependencies } from './us-supplier-server';
import type { UsAutomationGrant } from './us-automation-contract';

async function flags(){try{const {env}=await import('cloudflare:workers');return env as unknown as {INTERNATIONAL_US_SUPPLIER_MAIL_ENABLED?:string;INTERNATIONAL_US_SUPPLIER_ANALYSIS_ENABLED?:string;INTERNATIONAL_US_AUTOMATION_BUDGET_POLICY_JSON?:string};}catch{return {};}}
export async function usSupplierModuleEnabled(){return await erpServerDependencies.enabled() && (await flags()).INTERNATIONAL_US_SUPPLIER_MAIL_ENABLED==='true';}
async function policy():Promise<UsAutomationBudgetPolicy|null>{const raw=(await flags()).INTERNATIONAL_US_AUTOMATION_BUDGET_POLICY_JSON;return raw ? parseUsAutomationBudgetPolicy(raw):null;}
export async function usSupplierAutomationAccess(actor:FinancialAuthority){
  try{const access=await requireUsWorkspaceAccess(actor.organizationId,actor.userId,'automation');if(access.role!==actor.role)throw new ErpError('automation_permission_required',403);}
  catch(error){if(error instanceof UsAuthorityError)throw new ErpError(error.code==='subscription_required'?'automation_entitlement_required':error.status===403?'automation_permission_required':'service_unavailable',error.status===422?503:error.status);throw error;}
}
async function grant(actor:FinancialAuthority,p:UsAutomationBudgetPolicy):Promise<UsAutomationGrant>{
  try {const authority=await requireUsWorkspaceAutomationAuthority(actor.organizationId,actor.userId);if(authority.role!==actor.role)throw new ErpError('automation_permission_required',403);return createUsAutomationGrant(authority,p);}
  catch(error){if(error instanceof UsAuthorityError)throw new ErpError(error.code==='subscription_required'?'automation_entitlement_required':error.status===403?'automation_permission_required':'service_unavailable',error.status===422?503:error.status);throw error;}
}
async function providerEnabled(){return await usSupplierModuleEnabled() && (await flags()).INTERNATIONAL_US_SUPPLIER_ANALYSIS_ENABLED==='true';}
async function providerKey(){if(!await providerEnabled())return null;return (await import('../automation/config')).decisionApiKey();}
async function analysisStore(capability:1|2|3|4){return createSupabaseUsAutomationStore((await import('../supabase-server-runtime')).supabaseServerClient(),{supportedSchemaVersion:await usPurchasingSchemaVersion(capability)});}
export const usAnalysisSettingsHandlers=createUsAnalysisSettingsHandlers({
  ...erpServerDependencies,enabled:usSupplierModuleEnabled,automationAccess:usSupplierAutomationAccess,analysisStore,policy,grant,
  async providerReady(){return !!await providerKey() && await providerEnabled();},now:()=>Math.floor(Date.now()/1000),
});
export const prepareUsSupplierAnalysis:NonNullable<UsSupplierServerDependencies['prepareAnalysis']>=async input=>{
  const supportedSchemaVersion=await usPurchasingSchemaVersion(4);
  if(supportedSchemaVersion!==4)throw new ErpError('automation_upgrade_required',409);
  return createUsSupplierAnalysis({
    store:await analysisStore(4),suppliers:createSupabaseUsSupplierStore((await import('../supabase-server-runtime')).supabaseServerClient(),{supportedSchemaVersion}),
    async grant(actor){const p=await policy();if(!p)throw new ErpError('supplier_analysis_unavailable',503);return grant(actor,p);},
    providerKey,providerEnabled,newId:()=>crypto.randomUUID(),
  })(input);
};
