import type { AccountRole } from '../account-security';
import { creationUuid } from './workspace-creation';
import { UsAuthorityError } from './saas-authority';
import { d1UsAuthorityStore, parseUsSaasPolicy } from './saas-authority-d1';
import { UsDeviceError, type UsDeviceSession } from './us-device-contract';
import { requireUsDeviceSession } from './us-device-bindings';
import { d1UsTeamStore } from './us-team-store';
import { createUsTeamHandlers, type UsTeamDependencies } from './us-team-server';
import { UsTeamError, type UsTeamContext, type UsTeamInvitation, type UsTeamUser } from './us-team-contract';
import { normalizeUsTeamEmail, validateUsTeamContext } from './us-team-validation';

type Db=Pick<D1Database,'prepare'|'batch'>;
type Flags=Record<string,string|undefined>;
async function flags():Promise<Flags>{try{return(await import('cloudflare:workers')).env as unknown as Flags;}catch{return {};}}
export async function usTeamEnabled():Promise<boolean>{const f=await flags();return ['INTERNATIONAL_CORE_ENABLED','INTERNATIONAL_US_ERP_ENABLED','INTERNATIONAL_US_TEAM_ENABLED'].every(k=>f[k]==='true');}
const now=()=>Math.floor(Date.now()/1000);
async function db(){return(await import('../runtime')).database();}
async function verifiedUser():Promise<UsTeamUser>{
  const user=await(await import('../../app/zentra-auth')).getZentraUser({offerAccess:false,refreshSession:true});
  if(!user||user.provider!=='supabase')throw new UsTeamError('unauthorized',401);
  if(!user.emailConfirmed)throw new UsTeamError('email_confirmation_required',403);
  return {userId:creationUuid(user.userId),email:normalizeUsTeamEmail(user.email),emailConfirmed:true};
}
interface Source {organization_id:string;owner_user_id:string;company_name:string;subscription_id:string;environment:'TEST'|'PRODUCTION';catalog_version:string;price_id:string;seat_limit:number;starts_at:number;ends_at:number;checked_at:number}
/** Read only the retained US creation/authority, and validate its offer against
 * the private currently approved catalogue. No CH grant or financial book. */
async function source(database:Db,organizationId:string,userId?:string){
  const row=await database.prepare(`SELECT a.organization_id,a.owner_user_id,i.company_name,a.subscription_id,a.environment,a.catalog_version,a.seat_limit,
    json_extract(a.offer_json,'$.priceId') AS price_id,json_extract(a.authority_json,'$.evidence.startsAt') AS starts_at,
    json_extract(a.authority_json,'$.evidence.endsAt') AS ends_at,unixepoch() AS checked_at
    FROM international_effective_saas_authorities a JOIN international_workspace_creation_intents i ON i.creation_id=a.creation_id AND i.organization_id=a.organization_id
    JOIN international_workspace_members owner ON owner.organization_id=a.organization_id AND owner.user_id=a.owner_user_id AND owner.role='owner' AND owner.revoked_at IS NULL
    WHERE a.organization_id=? AND a.country='US' AND a.currency='USD' AND i.state='ready' AND i.own_subscription_id=a.subscription_id AND a.revoked_at IS NULL`).bind(organizationId).first<Source>();
  if(!row)throw new UsTeamError('subscription_required',402);
  const policy=parseUsSaasPolicy(await flags(),Math.max(now(),row.checked_at));
  const access=await d1UsAuthorityStore(database).access(organizationId,userId??row.owner_user_id,policy,'gestion');
  if(access.organizationId!==organizationId||access.userId!==(userId??row.owner_user_id)||access.subscriptionId!==row.subscription_id||access.seatLimit!==row.seat_limit)throw new UsTeamError('configuration_changed',409);
  return {row,access};
}
function context(row:Source,user:UsTeamUser,mode:'member'|'recipient',role:AccountRole,credential:UsTeamContext['credential']):UsTeamContext{
  return validateUsTeamContext({schemaVersion:1,organizationId:row.organization_id,mode,role,user,subscriptionId:row.subscription_id,environment:row.environment,catalogVersion:row.catalog_version,priceId:row.price_id,seatLimit:row.seat_limit,checkedAt:Math.max(now(),row.checked_at),validStartsAt:row.starts_at,validEndsAt:row.ends_at,credential},row.organization_id,now());
}
function mapped(error:unknown):never{
  if(error instanceof UsTeamError)throw error;
  if(error instanceof UsAuthorityError||error instanceof UsDeviceError)throw new UsTeamError(error.status===401?'unauthorized':error.status===402?'subscription_required':error.status===403?'forbidden':'service_unavailable',[401,402,403].includes(error.status)?error.status:503);
  throw new UsTeamError('service_unavailable',503);
}
export const usTeamDependencies:UsTeamDependencies={
  enabled:usTeamEnabled,now,newId:()=>crypto.randomUUID(),
  async recipientUser(request){try{if(request.headers.has('Authorization'))throw new UsTeamError('unauthorized',401);return await verifiedUser();}catch(error){return mapped(error);}},
  async member(request,organizationId){let capturedUser:UsTeamUser|undefined,capturedDevice:UsDeviceSession|undefined;try{
    const organization=creationUuid(organizationId),database=await db();
    if(request.headers.has('Authorization')){
      const session=await requireUsDeviceSession(request);
      capturedDevice=session;
      if(session.organizationId!==organization)throw new UsTeamError('tenant_mismatch',403);
      const {row,access}=await source(database,organization,session.userId);
      if(access.role!==session.role||access.subscriptionId!==session.subscriptionId)throw new UsTeamError('forbidden',403);
      return context(row,{userId:session.userId,email:null,emailConfirmed:false},'member',access.role,{kind:'device',sessionId:session.sessionId,supportedSchemaVersion:session.supportedSchemaVersion});
    }
    const user=await verifiedUser();capturedUser=user;
    const {row,access}=await source(database,organization,user.userId);
    return context(row,user,'member',access.role,{kind:'browser'});
  }catch(error){
    // Before the HTTP layer receives a context, a delayed D1 failure must not
    // conceal a logout or account switch. A device never falls back to cookies.
    try {
      if(capturedUser){const fresh=await verifiedUser();if(fresh.userId!==capturedUser.userId)throw new UsTeamError('session_changed',401);}
      else if(capturedDevice){const fresh=await requireUsDeviceSession(request);if(['sessionId','organizationId','userId','role','subscriptionId','supportedSchemaVersion'].some(k=>fresh[k as keyof UsDeviceSession]!==capturedDevice![k as keyof UsDeviceSession]))throw new UsTeamError('session_changed',401);}
    }catch(delayed){if(delayed instanceof UsTeamError&&[401,402,403].includes(delayed.status)||delayed instanceof UsDeviceError&&[401,402,403].includes(delayed.status))return mapped(delayed);}
    return mapped(error);
  }},
  async recipient(request,invitation:UsTeamInvitation){try{
    if(request.headers.has('Authorization'))throw new UsTeamError('unauthorized',401);
    const user=await verifiedUser();
    // E-mail equality is established before any company information is exposed.
    if(user.email!==invitation.email)throw new UsTeamError('invitation_recipient_mismatch',403);
    if(invitation.status==='revoked'||invitation.status==='accepted'&&invitation.acceptedBy!==user.userId)throw new UsTeamError('invitation_unavailable',409);
    const {row}=await source(await db(),invitation.organizationId);
    return {context:context(row,user,'recipient',invitation.role,{kind:'browser'}),organizationName:row.company_name};
  }catch(error){return mapped(error);}},
  async store(){return d1UsTeamStore(await db());},
  async rateLimit(request,operation,key){await(await import('../account')).enforceAccountRateLimit(request,'international-us-team-'+operation,key,operation==='read'?3600:operation==='resolve'?120:60);},
  diagnostic(event){console.warn('zentra.international.us-team',event);},
};
export const usTeamHandlers=createUsTeamHandlers(usTeamDependencies);
