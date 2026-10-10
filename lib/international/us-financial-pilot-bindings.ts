import { AccountPublicError } from '../account-security';
import type { FinancialAuthority } from './accounting/ledger';
import { ErpError } from './erp-contract';
import { requireUsWorkspaceAccess } from './saas-authority-d1';
import { UsAuthorityError } from './saas-authority';
import { createUsFinancialPilotHandlers, type UsFinancialPilotDependencies } from './us-financial-pilot-server';
import { createSupabaseUsFinancialPilotStore, readUsFinancialPilotScope, readUsFinancialPilotPromotionStatus } from './us-financial-pilot-store';
import { getWorkspaceCountry } from './workspace-service';

export interface UsFinancialPilotFlags {
  INTERNATIONAL_CORE_ENABLED?:string;
  INTERNATIONAL_US_ERP_ENABLED?:string;
  INTERNATIONAL_US_FINANCIAL_V5_INSTALLED?:string;
  INTERNATIONAL_US_FINANCIAL_PILOT_ENABLED?:string;
  INTERNATIONAL_US_BILLING_ENVIRONMENT?:string;
}
export function usFinancialPilotFlagConfiguration(flags:UsFinancialPilotFlags):Readonly<{installed:boolean;enabled:boolean}>{
  const core=flags.INTERNATIONAL_CORE_ENABLED==='true'&&flags.INTERNATIONAL_US_ERP_ENABLED==='true';
  const installed=flags.INTERNATIONAL_US_FINANCIAL_V5_INSTALLED==='true';
  return Object.freeze({installed,enabled:installed&&core&&flags.INTERNATIONAL_US_FINANCIAL_PILOT_ENABLED==='true'&&flags.INTERNATIONAL_US_BILLING_ENVIRONMENT==='TEST'});
}
async function flags(){try{const{env}=await import('cloudflare:workers');return usFinancialPilotFlagConfiguration(env as unknown as UsFinancialPilotFlags);}catch{return {installed:false,enabled:false};}}
export async function usFinancialPilotEnabled():Promise<boolean>{return(await flags()).enabled;}
async function client(){return(await import('../supabase-server-runtime')).supabaseServerClient();}
/** Browser identity and EFFECTIVE D1 membership/US entitlement. No CHF licence,
 * native credential, discovery list, or client-provided role is an authority. */
async function workspaceAuthority(request:Request,organizationId:string){
  if(request.headers.has('Authorization'))throw new ErpError('forbidden',403);
  const user=await(await import('../../app/zentra-auth')).getZentraUser({offerAccess:false});
  if(!user)throw new AccountPublicError('Session required',401);
  try{
    const access=await requireUsWorkspaceAccess(organizationId,user.userId);
    if(access.organizationId!==organizationId||access.userId!==user.userId)throw new ErpError('tenant_mismatch',403);
    return {mode:'browser' as const,actor:{organizationId,userId:user.userId,role:access.role,managementEntitled:true,timestamp:new Date().toISOString()}};
  }catch(error){if(error instanceof UsAuthorityError)throw new ErpError(error.status===402?'management_entitlement_required':error.status===403?'financial_permission_required':'financial_service_unavailable',error.status===422?503:error.status);throw error;}
}
async function authority(request:Request,organizationId:string){
  const admitted=await workspaceAuthority(request,organizationId);
  if(!['owner','admin','accountant'].includes(admitted.actor.role))throw new ErpError('financial_permission_required',403);
  return admitted;
}
export const usFinancialPilotDependencies:UsFinancialPilotDependencies={
  enabled:usFinancialPilotEnabled,authority,
  async configuration(actor){const value=await getWorkspaceCountry(await client(),actor);if(value.status!=='configured')throw new ErpError('financial_configuration_changed',409);return value.configuration;},
  async scope(actor,expected){return readUsFinancialPilotScope(await client(),actor,expected);},
  async store(scope,revalidate){return createSupabaseUsFinancialPilotStore(await client(),scope,revalidate);},
  async rateLimit(request,actor,operation){await(await import('../account')).enforceAccountRateLimit(request,`international-financial-pilot-${operation}`,`${actor.organizationId}:${actor.userId}`,operation==='read'?3600:120);},
  diagnostic(event){console.warn('zentra.international.financial-pilot',event);},
};
export const usFinancialPilotHandlers=createUsFinancialPilotHandlers(usFinancialPilotDependencies);

/** Explicit migration rollout marker. Leave false until the local/staging V5
 * schema is actually installed; not inferred from country or subscription.
 * Deployment must never unset this marker after a workspace is promoted;
 * pause the core/ERP/pilot flags instead, retaining promotion discovery.
 * Once installed, every promoted company selects the pilot or a closed screen.
 * Missing schema/denied grant never becomes an ERP4 fallback. */
export async function usFinancialPilotPageMode(organizationId:string,expectedUserId:string):Promise<'legacy'|'pilot'|'unavailable'>{
  const initial=await flags();if(!initial.installed)return 'legacy';
  const request=new Request('https://zentraapp.ch/private-financial-pilot-page',{headers:{'X-Zentra-Expected-User':expectedUserId}});
  try{
    // Effective workspace membership is needed for the private marker probe,
    // but member/read_only remain valid users of an unpromoted ERP4 workspace.
    const first=await workspaceAuthority(request,organizationId);
    if(first.actor.userId!==expectedUserId)return 'unavailable';
    async function fresh():Promise<FinancialAuthority>{
      const current=await workspaceAuthority(request,organizationId),currentFlags=await flags();
      if(current.actor.userId!==expectedUserId||current.actor.role!==first.actor.role||!currentFlags.installed)throw new ErpError('financial_authority_changed',403);
      if(promoted&&!currentFlags.enabled)throw new ErpError('feature_unavailable',404);
      return current.actor;
    }
    const store=await client(),promoted=await readUsFinancialPilotPromotionStatus(store,organizationId);
    let actor=await fresh();
    if(!promoted)return 'legacy';
    if(!initial.enabled||!['owner','admin','accountant'].includes(actor.role))return 'unavailable';
    const admitted=await readUsFinancialPilotScope(store,actor);
    actor=await fresh();
    await readUsFinancialPilotScope(store,actor,admitted);
    await fresh();
    return 'pilot';
  }catch(error){
    // A denied, stale, missing or unavailable private authority never becomes
    // permission to reopen a frozen ERP4 baseline.
    if(error instanceof ErpError||error instanceof AccountPublicError||error instanceof UsAuthorityError)return 'unavailable';
    throw error;
  }
}
