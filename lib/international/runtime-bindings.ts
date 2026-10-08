import { createErpHandlers, type ErpServerDependencies } from './runtime-server';
import { createErpSyncHandlers } from './runtime-sync-server';
import { createSupabaseErpSyncStore } from './runtime-sync-store';
import { createSupabaseErpStore } from './runtime-store';
import { getWorkspaceCountry } from './workspace-service';
import { ErpError } from './runtime';
import { validatePublicSellerSnapshot } from './invoicing';
import type { FinancialAuthority } from './accounting/ledger';
import { AccountPublicError } from '../account-security';
import { requireUsWorkspaceAccess } from './saas-authority-d1';
import { UsAuthorityError } from './saas-authority';
import { getUsSellerProfile } from './seller-profile';
import { createUsSellerProfileHandlers } from './seller-profile-server';
import { createUsTaxProfileHandlers } from './us-tax-profile-server';
import type { ErpSchemaVersion } from './erp-schema-capability';
import { requireUsDeviceSession } from './us-device-bindings';
import { UsDeviceError } from './us-device-contract';
import { erpClientSchemaVersion } from './erp-schema-capability';
import { createUsTaxReadinessHandlers } from './us-tax-readiness-server';

/** New US path, separate from CH snapshots and their revision. Both flags default to false. */
async function enabled(){
  try {const {env}=await import('cloudflare:workers');const flags=env as unknown as {INTERNATIONAL_CORE_ENABLED?:string;INTERNATIONAL_US_ERP_ENABLED?:string};return flags.INTERNATIONAL_CORE_ENABLED==='true'&&flags.INTERNATIONAL_US_ERP_ENABLED==='true';}
  catch{return false;}
}
/** Additive purchasing schema is staged separately. Never inferred from a
 * client's header, country, language, subscription or existing CHF licence. */
export async function usPurchasingSchemaVersion(clientSchemaVersion:ErpSchemaVersion=1):Promise<ErpSchemaVersion>{
  if(clientSchemaVersion===1)return 1;
  try {const {env}=await import('cloudflare:workers');const flags=env as unknown as {INTERNATIONAL_US_PURCHASING_V2_ENABLED?:string;INTERNATIONAL_US_PROJECTS_V3_ENABLED?:string;INTERNATIONAL_US_ACCOUNTING_V4_ENABLED?:string};if(flags.INTERNATIONAL_US_PURCHASING_V2_ENABLED!=='true')return 1;if(clientSchemaVersion<3||flags.INTERNATIONAL_US_PROJECTS_V3_ENABLED!=='true')return 2;return clientSchemaVersion===4&&flags.INTERNATIONAL_US_ACCOUNTING_V4_ENABLED==='true'?4:3;}
  catch{return 1;}
}
async function authority(request:Request,organizationId:string):Promise<{mode:'browser'|'device';actor:FinancialAuthority}>{
  let userId:string,deviceRole:FinancialAuthority['role']|undefined,mode:'browser'|'device';
  if(request.headers.has('Authorization')){
    let session;
    try { session=await requireUsDeviceSession(request); }
    catch(error){if(error instanceof UsDeviceError)throw new ErpError(error.code,error.status);throw error;}
    if(session.organizationId!==organizationId)throw new ErpError('tenant_mismatch',403);
    if(![1,2,3,4].includes(session.supportedSchemaVersion))throw new ErpError('service_unavailable',503);
    // Captured credential support is immutable. A newer header alone cannot
    // upgrade an older installation's financial protocol or reveal a v4 book.
    if(erpClientSchemaVersion(request)>session.supportedSchemaVersion)throw new ErpError('client_upgrade_required',409);
    userId=session.userId;deviceRole=session.role;mode='device';
  }else{
    const user=await(await import('../../app/zentra-auth')).getZentraUser({offerAccess:false});
    if(!user)throw new AccountPublicError('Session required',401);
    userId=user.userId;mode='browser';
  }
  // The US ERP cannot inherit a CHF licence, seat reader or account-wide trial.
  // Native Authorization admits only the separate US credential family.
  try {
    const access=await requireUsWorkspaceAccess(organizationId,userId);
    if(access.organizationId!==organizationId||access.userId!==userId)throw new ErpError('tenant_mismatch',403);
    if(deviceRole!==undefined&&deviceRole!==access.role)throw new ErpError('financial_permission_required',403);
    return {mode,actor:{organizationId,userId,role:access.role,managementEntitled:true,timestamp:new Date().toISOString()}};
  } catch(error) {
    if(error instanceof UsAuthorityError)throw new ErpError(error.code==='subscription_required'?'management_entitlement_required':error.status===403?'financial_permission_required':'service_unavailable',error.status===422?503:error.status);
    throw error;
  }
}
export const erpServerDependencies:ErpServerDependencies={
  enabled,authority,
  freshSupportedSchemaVersion:usPurchasingSchemaVersion,
  async configuration(actor){
    const client=(await import('../supabase-server-runtime')).supabaseServerClient();
    const state=await getWorkspaceCountry(client,actor);
    if(state.status!=='configured')throw new ErpError('country_configuration_required',409);
    return state.configuration;
  },
  async store(clientSchemaVersion){return createSupabaseErpStore((await import('../supabase-server-runtime')).supabaseServerClient(),{supportedSchemaVersion:await usPurchasingSchemaVersion(clientSchemaVersion)});},
  // A provider will be installed only with verified registrations and sandbox results.
  // Neither an owner-set status nor a country/language silently invents a tax determination.
  async taxProvider(){return null;},
  async seller(actor){
    const client=(await import('../supabase-server-runtime')).supabaseServerClient();
    const state=await getUsSellerProfile(client,actor);
    if(state.status!=='configured')return null;
    // Dedicated US public identity; neither a Swiss profile nor a mutable logo URL.
    return validatePublicSellerSnapshot({organizationId:actor.organizationId,...state.profile},actor.organizationId);
  },
  async rateLimit(request,actor,operation){await(await import('../account')).enforceAccountRateLimit(request,`international-erp-${operation}`,`${actor.organizationId}:${actor.userId}`,operation==='read'?3600:600);},
  diagnostic(event){console.warn('zentra.international.erp',event);},
};
export const erpHandlers=createErpHandlers(erpServerDependencies);
// Informative projection only. No gateway/evaluator is installed until an
// independently observed TEST merchant binding has been validated. Default
// refusal preserves CH and cannot upgrade a credential or authorize issuance.
export const usTaxReadinessHandlers=createUsTaxReadinessHandlers({
  ...erpServerDependencies, now:()=>Math.floor(Date.now()/1000),
});
export const usSellerProfileHandlers=createUsSellerProfileHandlers({...erpServerDependencies,
  async store(){return (await import('../supabase-server-runtime')).supabaseServerClient();},
});
export const usTaxProfileHandlers=createUsTaxProfileHandlers({...erpServerDependencies,
  async store(){return (await import('../supabase-server-runtime')).supabaseServerClient();},
  async rateLimit(request,actor,operation){await(await import('../account')).enforceAccountRateLimit(request,`international-us-tax-profile-${operation}`,`${actor.organizationId}:${actor.userId}`,operation==='read'?600:120);},
  diagnostic(event){console.warn('zentra.international.us-tax-profile',event);},
});
export const erpSyncHandlers=createErpSyncHandlers({...erpServerDependencies,
  async syncStore(clientSchemaVersion){return createSupabaseErpSyncStore((await import('../supabase-server-runtime')).supabaseServerClient(),{supportedSchemaVersion:await usPurchasingSchemaVersion(clientSchemaVersion)});},
});
