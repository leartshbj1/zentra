import { createErpHandlers, type ErpServerDependencies } from './runtime-server';
import { createErpSyncHandlers } from './runtime-sync-server';
import { createSupabaseErpSyncStore } from './runtime-sync-store';
import { createSupabaseErpStore } from './runtime-store';
import { getWorkspaceCountry } from './workspace-service';
import { ErpError } from './runtime';
import { validatePublicSellerSnapshot } from './invoicing';
import type { FinancialAuthority } from './accounting/ledger';
import { AccountPublicError } from '../account-security';

/** New US path, separate from CH snapshots and their revision. Both flags default to false. */
async function enabled(){
  try {const {env}=await import('cloudflare:workers');const flags=env as unknown as {INTERNATIONAL_CORE_ENABLED?:string;INTERNATIONAL_US_ERP_ENABLED?:string};return flags.INTERNATIONAL_CORE_ENABLED==='true'&&flags.INTERNATIONAL_US_ERP_ENABLED==='true';}
  catch{return false;}
}
async function authority(request:Request,organizationId:string):Promise<{mode:'browser'|'device';actor:FinancialAuthority}>{
  const {requireBrowserMembership,requireDeviceSession}=await import('../account');
  let userId:string,role:FinancialAuthority['role'],mode:'browser'|'device';
  if(request.headers.has('Authorization')){
    const session=await requireDeviceSession(request);
    if(session.organizationId!==organizationId)throw new ErpError('tenant_mismatch',403);
    userId=session.userId;role=session.role;mode='device';
  }else{
    const user=await(await import('../../app/zentra-auth')).getZentraUser();
    if(!user)throw new AccountPublicError('Session required',401);
    const membership=await requireBrowserMembership(user.userId,organizationId);
    if(membership.organizationId!==organizationId)throw new ErpError('tenant_mismatch',403);
    userId=user.userId;role=membership.role;mode='browser';
  }
  // Existing management/bundle/seat reader stays authoritative. This does not create a US price.
  const seats=await(await import('../team-seats')).teamSeats(organizationId);
  if(!seats.subscriptionActive)throw new ErpError('management_entitlement_required',402);
  return {mode,actor:{organizationId,userId,role,managementEntitled:true,timestamp:new Date().toISOString()}};
}
export const erpServerDependencies:ErpServerDependencies={
  enabled,authority,
  async configuration(actor){
    const client=(await import('../supabase-server-runtime')).supabaseServerClient();
    const state=await getWorkspaceCountry(client,actor);
    if(state.status!=='configured')throw new ErpError('country_configuration_required',409);
    return state.configuration;
  },
  async store(){return createSupabaseErpStore((await import('../supabase-server-runtime')).supabaseServerClient());},
  // A provider will be installed only with verified registrations and sandbox results.
  // Neither an owner-set status nor a country/language silently invents a tax determination.
  async taxProvider(){return null;},
  async seller(actor){
    const client=(await import('../supabase-server-runtime')).supabaseServerClient();
    const rows=await client.select<{organization_id:string;profile:Record<string,unknown>}>('zentra_company_profiles',{organization_id:`eq.${actor.organizationId}`,select:'organization_id,profile',limit:1});
    if(rows.length!==1||rows[0].organization_id!==actor.organizationId||typeof rows[0].profile?.company_name!=='string'||!rows[0].profile.company_name.trim())return null;
    const profile=rows[0].profile;
    // A live URL/device file path is never a historical logo. Add only archived, verified assets later.
    return validatePublicSellerSnapshot({organizationId:actor.organizationId,displayName:profile.company_name,...(typeof profile.email==='string'&&profile.email.trim()?{contactEmail:profile.email}:{}),...(typeof profile.phone==='string'&&profile.phone.trim()?{contactPhone:profile.phone}:{})},actor.organizationId);
  },
  async rateLimit(request,actor,operation){await(await import('../account')).enforceAccountRateLimit(request,`international-erp-${operation}`,`${actor.organizationId}:${actor.userId}`,operation==='read'?3600:600);},
  diagnostic(event){console.warn('zentra.international.erp',event);},
};
export const erpHandlers=createErpHandlers(erpServerDependencies);
export const erpSyncHandlers=createErpSyncHandlers({...erpServerDependencies,
  async syncStore(){return createSupabaseErpSyncStore((await import('../supabase-server-runtime')).supabaseServerClient());},
});
