import { ACCOUNT_ROLES } from '../account-security';
import { canonicalErpJson } from './erp-contract';
import { snapshotPrivateJson } from './private-json';
import { UsMailboxError, validateUsMailboxContext, sameUsMailboxContext, type UsMailboxContext } from './us-support-mailbox-contract';
import type { UsSupportWorkspaceContext } from './us-support-workspace-contract';

export const US_SUPPORT_WORKER_ID = 'us-support-intake-v1' as const;
export interface UsSupportWorkerCredential { readonly kind:'worker'; readonly workerId:typeof US_SUPPORT_WORKER_ID; readonly delegationId:string; readonly delegationRevision:number; readonly runId:string }
/** userId/role identify the human delegator, never an authenticated worker user. */
export interface UsSupportWorkerContext { readonly schemaVersion:1; readonly workspaceId:string; readonly authority:Omit<UsSupportWorkspaceContext,'credential'> & {readonly credential:UsSupportWorkerCredential} }
export type UsSupportExecutionContext = UsMailboxContext | UsSupportWorkerContext;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const second=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0&&v<=253_402_300_799;
const key=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(v);
const id=(v:unknown):v is string=>typeof v==='string'&&uuid.test(v);
const fail=(code='invalid_support_execution',status=503):never=>{throw new UsMailboxError(code,status);};
function exact(v:unknown,keys:readonly string[]):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))return fail();return v as Record<string,unknown>;}
export function isUsSupportWorkerContext(c:UsSupportExecutionContext):c is UsSupportWorkerContext{return c.authority.credential.kind==='worker';}
/** Structural validation only. Worker authority is resolved from current D1 rows. */
export function validateUsSupportExecutionContext(input:unknown,organizationId?:string,now?:number):UsSupportExecutionContext{
  const saved=snapshotPrivateJson(input) as UsSupportExecutionContext;
  if(saved?.authority?.credential?.kind!=='worker')return validateUsMailboxContext(saved,organizationId,now);
  const v=exact(saved,['schemaVersion','authority','workspaceId']),a=exact(v.authority,['schemaVersion','organizationId','userId','role','ownerUserId','subscriptionId','environment','catalogVersion','priceId','authorityReference','validStartsAt','validEndsAt','seatLimit','checkedAt','credential']),c=exact(a.credential,['kind','workerId','delegationId','delegationRevision','runId']);
  if(v.schemaVersion!==1||!id(v.workspaceId)||a.schemaVersion!==1||!id(a.organizationId)||organizationId!==undefined&&a.organizationId!==organizationId||!id(a.userId)||!id(a.ownerUserId)||!ACCOUNT_ROLES.includes(a.role as never)||!['owner','admin'].includes(String(a.role))||(a.userId===a.ownerUserId)!==(a.role==='owner')||!key(a.subscriptionId)||!key(a.catalogVersion)||!key(a.authorityReference)||typeof a.priceId!=='string'||!/^price_[A-Za-z0-9_]{1,120}$/.test(a.priceId)||!['TEST','PRODUCTION'].includes(String(a.environment))||!second(a.validStartsAt)||!second(a.validEndsAt)||!second(a.checkedAt)||a.validStartsAt>a.checkedAt||a.checkedAt>=a.validEndsAt||typeof a.seatLimit!=='number'||!Number.isSafeInteger(a.seatLimit)||a.seatLimit<1||a.seatLimit>1000||c.kind!=='worker'||c.workerId!==US_SUPPORT_WORKER_ID||!id(c.delegationId)||typeof c.delegationRevision!=='number'||!Number.isSafeInteger(c.delegationRevision)||c.delegationRevision<1||!id(c.runId)||now!==undefined&&(!second(now)||a.checkedAt>now||now-a.checkedAt>30||now>=a.validEndsAt))return fail();
  return saved;
}
export function sameUsSupportExecutionContext(before:UsSupportExecutionContext,after:UsSupportExecutionContext):void{
  if(!isUsSupportWorkerContext(before)&&!isUsSupportWorkerContext(after))return sameUsMailboxContext(before,after);
  if(!isUsSupportWorkerContext(before)||!isUsSupportWorkerContext(after))return fail('configuration_changed',409);
  if(canonicalErpJson({...before,authority:{...before.authority,checkedAt:0}})!==canonicalErpJson({...after,authority:{...after.authority,checkedAt:0}}))return fail('configuration_changed',409);
}
export function usSupportExecutionMailboxEncryptionContext(input:UsSupportExecutionContext,connectionId:string,revision:number):string{const c=validateUsSupportExecutionContext(input);if(!id(connectionId)||!Number.isSafeInteger(revision)||revision<1)return fail();return `us-support-mailbox:${c.authority.organizationId}:${c.workspaceId}:${connectionId}:${revision}`;}
