import { UsDeviceError, validateUsDeviceAdmission, type UsDeviceAdmission } from './us-device-contract';
import { createUsDeviceHandlers } from './us-device-server';
import { d1UsDeviceStore } from './us-device-d1';
import { requireUsWorkspaceAccess } from './saas-authority-d1';
import { getWorkspaceCountry } from './workspace-service';
import { canonicalCreationJson } from './workspace-creation';
import type { AccountRole } from '../account-security';
import type { ErpSchemaVersion } from './erp-schema-capability';

/** Only new pairing can capture4, after every independent server gate is on.
 * Previously captured credentials are never silently promoted or rewritten. */
export async function usNativeMaximumSchemaVersion():Promise<ErpSchemaVersion>{
  try{const {env}=await import('cloudflare:workers');const flags=env as unknown as Record<string,string|undefined>;return ['INTERNATIONAL_CORE_ENABLED','INTERNATIONAL_US_ERP_ENABLED','INTERNATIONAL_US_NATIVE_ADMISSION_ENABLED','INTERNATIONAL_US_PURCHASING_V2_ENABLED','INTERNATIONAL_US_PROJECTS_V3_ENABLED','INTERNATIONAL_US_ACCOUNTING_V4_ENABLED'].every(name=>flags[name]==='true')?4:3;}catch{return 3;}
}

/** Fresh and default closed; no data query or implicit CH entitlement. */
export async function usNativeAdmissionEnabled():Promise<boolean>{
  try{const {env}=await import('cloudflare:workers');const flags=env as unknown as {INTERNATIONAL_CORE_ENABLED?:string;INTERNATIONAL_US_ERP_ENABLED?:string;INTERNATIONAL_US_NATIVE_ADMISSION_ENABLED?:string};return flags.INTERNATIONAL_CORE_ENABLED==='true'&&flags.INTERNATIONAL_US_ERP_ENABLED==='true'&&flags.INTERNATIONAL_US_NATIVE_ADMISSION_ENABLED==='true';}catch{return false;}
}
async function access(organizationId:string,userId:string):Promise<UsDeviceAdmission>{
  const rights=await requireUsWorkspaceAccess(organizationId,userId);
  if(rights.organizationId!==organizationId||rights.userId!==userId)throw new UsDeviceError('forbidden',403);
  const db=(await import('../runtime')).database();
  const row=await db.prepare(`SELECT i.company_name,a.subscription_id,json_extract(a.authority_json,'$.evidence.endsAt') AS ends_at,
    m.role,a.seat_limit,(SELECT count(*) FROM international_workspace_members seats WHERE seats.organization_id=a.organization_id AND seats.revoked_at IS NULL) AS active_seats
    FROM international_workspace_creation_intents i JOIN international_effective_saas_authorities a ON a.creation_id=i.creation_id AND a.organization_id=i.organization_id AND a.subscription_id=i.own_subscription_id
    JOIN international_workspace_members m ON m.organization_id=a.organization_id AND m.user_id=? AND m.revoked_at IS NULL
    JOIN international_workspace_members owner ON owner.organization_id=a.organization_id AND owner.user_id=a.owner_user_id AND owner.role='owner' AND owner.revoked_at IS NULL
    WHERE i.organization_id=? AND i.state='ready' AND a.revoked_at IS NULL AND a.country='US' AND a.currency='USD'`).bind(userId,organizationId).first<{company_name:string;subscription_id:string;ends_at:number;role:AccountRole;seat_limit:number;active_seats:number}>();
  if(!row||row.role!==rights.role||row.subscription_id!==rights.subscriptionId)throw new UsDeviceError('forbidden',403);
  if(!Number.isSafeInteger(row.active_seats)||row.active_seats<1||!Number.isSafeInteger(row.seat_limit)||row.seat_limit!==rights.seatLimit)throw new UsDeviceError('service_unavailable',503);
  if(row.active_seats>row.seat_limit)throw new UsDeviceError('seat_limit_reached',403);
  const state=await getWorkspaceCountry((await import('../supabase-server-runtime')).supabaseServerClient(),{organizationId,userId,role:rights.role});
  if(state.status!=='configured'||state.configuration.organizationId!==organizationId||state.configuration.country!=='US'||state.configuration.currency!=='USD')throw new UsDeviceError('forbidden',403);
  return validateUsDeviceAdmission({organizationId,organizationName:row.company_name,userId,role:rights.role,subscriptionId:rights.subscriptionId,entitlementValidUntil:row.ends_at,configurationStamp:canonicalCreationJson({revision:state.revision,configuration:state.configuration})});
}
export const usDeviceHandlers=createUsDeviceHandlers({
  enabled:usNativeAdmissionEnabled,
  maxSchemaVersion:usNativeMaximumSchemaVersion,
  async user(){return(await import('../../app/zentra-auth')).getZentraUser({offerAccess:false,refreshSession:true});},
  access,
  async store(){return d1UsDeviceStore((await import('../runtime')).database());},
  async rateLimit(request,operation,key){await(await import('../account')).enforceAccountRateLimit(request,'international-us-device-'+operation,key,operation==='exchange'?240:operation==='start'?12:operation==='me'?3600:60);},
});
/** US bearer only. Does not invoke a cookie, CHF licence or CH session reader. */
export async function requireUsDeviceSession(request:Request,allowedRoles?:readonly AccountRole[]){return usDeviceHandlers.requireSession(request,allowedRoles);}
