import { canonicalErpJson } from './erp-contract';
import { sha256Hex } from './canonical-hash';
import { parseUsSubscriptionAuthority, usWorkspaceAccess, type UsAuthorityRecord, type UsMembership, type UsSaasPolicy } from './saas-authority';
import { workspaceCreationIntentFromRow, type WorkspaceCreationRow } from './workspace-creation-d1';
import { snapshotPrivateJson } from './private-json';
import { d1UsMailboxStore } from './us-support-mailbox-d1';
import { validateUsMailboxConnection, validateUsMailboxState, UsMailboxError, type UsMailboxState } from './us-support-mailbox-contract';
import { validateUsSupportExecutionContext, isUsSupportWorkerContext, US_SUPPORT_WORKER_ID, type UsSupportExecutionContext, type UsSupportWorkerContext } from './us-support-execution-contract';
import { parseUsSupportTriagePolicy, type UsSupportTriagePolicy } from './us-support-triage-policy';
import type { UsSupportWorkerLease, UsSupportWorkerDelegation } from './us-support-worker-contract';

type Database=Pick<D1Database,'prepare'|'batch'>;
const fail=(code='worker_authority_unavailable',status=409):never=>{throw new UsMailboxError(code,status);};
function currentWorkerRow(c:UsSupportWorkerContext,r:Record<string,unknown>|null){
  if(!r)return fail('worker_revoked',409);if(typeof r.checked_at!=='number'||!Number.isSafeInteger(r.checked_at)||c.authority.checkedAt>r.checked_at||r.checked_at-c.authority.checkedAt>30)return fail('configuration_changed',409);
  const keys=['role','ownerUserId','subscriptionId','environment','catalogVersion','priceId','authorityReference','validStartsAt','validEndsAt','seatLimit'] as const;
  const columns=['role','owner_user_id','subscription_id','environment','catalog_version','price_id','authority_reference','valid_starts_at','valid_ends_at','seat_limit'];
  if(keys.some((key,i)=>c.authority[key]!==r[columns[i]]))return fail('configuration_changed',409);
  return c;
}
/** SQL verifies a live delegation generation and run, not a user credential. */
export async function assertUsSupportWorkerExecution(database:Database,input:UsSupportWorkerContext,now?:number):Promise<UsSupportWorkerContext>{
  const c=validateUsSupportExecutionContext(input,undefined,now);if(!isUsSupportWorkerContext(c))return fail();const k=c.authority.credential;
  const r=await database.prepare(`SELECT *,unixepoch() AS checked_at FROM international_us_support_worker_admissible WHERE organization_id=? AND workspace_id=? AND run_id=? AND worker_id=? AND delegation_id=? AND delegation_revision=? AND user_id=?`).bind(c.authority.organizationId,c.workspaceId,k.runId,k.workerId,k.delegationId,k.delegationRevision,c.authority.userId).first<Record<string,unknown>>();
  return currentWorkerRow(c,r);
}
export async function readUsSupportWorkerAuthority(database:Database,lease:UsSupportWorkerLease|UsSupportWorkerContext,options:{now?:()=>number;policy:()=>Promise<UsSaasPolicy>;triagePolicy:()=>Promise<UsSupportTriagePolicy>}):Promise<UsSupportWorkerContext>{
  lease=snapshotPrivateJson(lease) as typeof lease;
  if('authority' in lease){const captured=validateUsSupportExecutionContext(lease);if(!isUsSupportWorkerContext(captured))return fail();}
  const runId='authority' in lease?lease.authority.credential.runId:lease.runId;
  const policy=await options.policy(),triage=parseUsSupportTriagePolicy(await options.triagePolicy()),policySha256=await sha256Hex(canonicalErpJson(triage));
  const row=await database.prepare(`SELECT i.*,w.*,d.snapshot_json,a.authority_json,a.offer_json,a.updated_at AS authority_updated_at,a.revoked_at AS authority_revoked_at,a.revision AS authority_revision,m.membership_id,m.joined_at,m.revoked_at AS member_revoked_at,unixepoch() AS checked_at FROM international_us_support_worker_admissible w JOIN international_us_support_worker_delegations d ON d.organization_id=w.organization_id AND d.workspace_id=w.workspace_id AND d.revision=w.delegation_revision JOIN international_effective_saas_authorities a ON a.organization_id=w.organization_id JOIN international_workspace_creation_intents i ON i.creation_id=a.creation_id AND i.organization_id=a.organization_id JOIN international_workspace_members m ON m.organization_id=w.organization_id AND m.user_id=w.user_id AND m.membership_id=json_extract(d.snapshot_json,'$.grantedMembershipId') WHERE w.run_id=?`).bind(runId).first<Record<string,unknown>>();
  if(!row)return fail('worker_revoked',409);
  const captured='authority' in lease?{organizationId:lease.authority.organizationId,workspaceId:lease.workspaceId,delegationId:lease.authority.credential.delegationId,delegationRevision:lease.authority.credential.delegationRevision,workerId:lease.authority.credential.workerId,userId:lease.authority.userId}:{...lease,userId:row.user_id};
  if(captured.organizationId!==row.organization_id||captured.workspaceId!==row.workspace_id||captured.delegationId!==row.delegation_id||captured.delegationRevision!==row.delegation_revision||captured.workerId!==row.worker_id||captured.userId!==row.user_id)return fail('worker_authority_changed',409);
  const at=(options.now??(()=>Math.floor(Date.now()/1000)))(),delegation=JSON.parse(String(row.snapshot_json)) as UsSupportWorkerDelegation,authority=parseUsSubscriptionAuthority(JSON.parse(String(row.authority_json)));
  if(delegation.triagePolicySha256!==policySha256)return fail('worker_policy_changed',409);
  if(canonicalErpJson(authority.offer)!==row.offer_json)return fail('invalid_worker_record',503);
  const intent=workspaceCreationIntentFromRow(row as unknown as WorkspaceCreationRow),record:UsAuthorityRecord={organizationId:String(row.organization_id),creationId:String(row.creation_id),ownerUserId:String(row.owner_user_id),authority,seatLimit:Number(row.seat_limit),revision:row.authority_revision as 1,updatedAt:Number(row.authority_updated_at),revokedAt:row.authority_revoked_at as number|null},member:UsMembership={membershipId:String(row.membership_id),organizationId:String(row.organization_id),userId:String(row.user_id),role:row.role as UsMembership['role'],joinedAt:Number(row.joined_at),revokedAt:row.member_revoked_at as number|null};
  const gestion=usWorkspaceAccess(intent,record,member,{...policy,now:at},'gestion'),support=usWorkspaceAccess(intent,record,member,{...policy,now:at},'support');
  if(canonicalErpJson(gestion)!==canonicalErpJson(support)||!['owner','admin'].includes(gestion.role)||authority.evidence?.kind!=='verified_payment')return fail('subscription_required',402);
  const context=validateUsSupportExecutionContext({schemaVersion:1,workspaceId:row.workspace_id,authority:{schemaVersion:1,organizationId:row.organization_id,userId:row.user_id,role:row.role,ownerUserId:row.owner_user_id,subscriptionId:row.subscription_id,environment:row.environment,catalogVersion:row.catalog_version,priceId:row.price_id,authorityReference:row.authority_reference,validStartsAt:row.valid_starts_at,validEndsAt:row.valid_ends_at,seatLimit:row.seat_limit,checkedAt:row.checked_at,credential:{kind:'worker',workerId:US_SUPPORT_WORKER_ID,delegationId:row.delegation_id,delegationRevision:row.delegation_revision,runId}}},String(row.organization_id),at);
  if(!isUsSupportWorkerContext(context))return fail();return currentWorkerRow(context,row);
}
/** Existing H2 ciphertext and exact AES AAD; no synthetic human context. */
export async function readUsSupportExecutionMailbox(database:Database,input:UsSupportExecutionContext):Promise<UsMailboxState>{
  const c=validateUsSupportExecutionContext(input);if(!isUsSupportWorkerContext(c))return d1UsMailboxStore(database).read(c);const k=c.authority.credential;
  const r=await database.prepare(`SELECT w.*,h.revision,c.connection_id,c.provider,c.email,c.mailbox_id,c.folder_id,c.token_sha256,c.verified_at,c.connected_by,s.credentials_ciphertext,unixepoch() AS checked_at FROM international_us_support_worker_admissible w JOIN international_us_support_mailbox_heads h ON h.organization_id=w.organization_id AND h.workspace_id=w.workspace_id JOIN international_us_support_mailbox_connections c ON c.organization_id=h.organization_id AND c.workspace_id=h.workspace_id AND c.connection_id=h.current_connection_id AND c.revision=h.revision JOIN international_us_support_mailbox_secrets s ON s.connection_id=c.connection_id JOIN international_us_support_mailbox_receipts r ON r.command_id=h.last_command_id AND r.connection_id=c.connection_id JOIN international_us_support_mailbox_commits x ON x.command_id=r.command_id WHERE w.organization_id=? AND w.workspace_id=? AND w.run_id=? AND w.worker_id=? AND w.delegation_id=? AND w.delegation_revision=? AND w.user_id=? AND s.credentials_ciphertext IS NOT NULL AND s.cleared_by_command_id IS NULL`).bind(c.authority.organizationId,c.workspaceId,k.runId,k.workerId,k.delegationId,k.delegationRevision,c.authority.userId).first<Record<string,unknown>>();
  if(!r)return fail('worker_connection_changed',409);currentWorkerRow(c,r);const connection=validateUsMailboxConnection({id:r.connection_id,provider:r.provider,email:r.email,mailboxId:r.mailbox_id,folderId:r.folder_id,tokenSha256:r.token_sha256,credentialsCiphertext:r.credentials_ciphertext,verifiedAt:r.verified_at,connectedBy:r.connected_by,revision:r.revision});
  return validateUsMailboxState({schemaVersion:1,organizationId:c.authority.organizationId,workspaceId:c.workspaceId,revision:r.revision,currentConnection:connection},c.authority.organizationId);
}
