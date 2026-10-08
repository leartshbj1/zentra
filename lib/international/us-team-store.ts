import { canonicalErpJson } from './erp-contract';
import { snapshotPrivateJson } from './private-json';
import { UsTeamError, type UsTeamCommit, type UsTeamCommitResult, type UsTeamContext, type UsTeamInvitation, type UsTeamReceipt, type UsTeamStoredReceipt, type UsTeamStore } from './us-team-contract';
import { hashUsTeamCommand, validateUsTeamCommit, validateUsTeamContext, validateUsTeamInvitation, validateUsTeamProjection, validateUsTeamReceipt, validateUsTeamStoredReceipt } from './us-team-validation';

type TeamDatabase = Pick<D1Database, 'prepare' | 'batch'>;
type Row = Record<string, unknown>;
const bad = (): never => { throw new UsTeamError('invalid_team_record', 503); };
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const digest = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
function row(input: unknown): Row { const v = snapshotPrivateJson(input); if (!v || typeof v !== 'object' || Array.isArray(v)) return bad(); return v as Row; }
function json(value: unknown): unknown { if (typeof value !== 'string' || new TextEncoder().encode(value).length > 262_144) return bad(); const v: unknown = JSON.parse(value); if (canonicalErpJson(v) !== value) return bad(); return v; }
function invitation(input: unknown): UsTeamInvitation {
  const v = row(input);
  return validateUsTeamInvitation({schemaVersion:1,organizationId:v.organization_id,invitationId:v.invitation_id,email:v.email,role:v.role,tokenHash:v.token_hash,
    createdBy:v.created_by,createdAt:v.created_at,expiresAt:v.expires_at,status:v.status,revokedAt:v.revoked_at,acceptedBy:v.accepted_by,acceptedAt:v.accepted_at,membershipId:v.membership_id});
}
function dbError(error: unknown): UsTeamError {
  if (error instanceof UsTeamError) return error;
  const text = error instanceof Error ? error.message : '';
  const errors: [string, string, number][] = [
    ['us_team_revision_conflict','team_revision_conflict',409], ['us_team_idempotency_conflict','team_idempotency_conflict',409],
    ['us_team_seat_limit_reached','team_seat_limit_reached',409], ['international_us_seat_limit','team_seat_limit_reached',409],
    ['us_team_subscription_required','subscription_required',402], ['us_team_management_required','team_management_required',403],
    ['us_team_owner_protected','team_owner_protected',409], ['us_team_member_protected','team_member_protected',409],
    ['us_team_invitation_unavailable','team_invitation_unavailable',409],
  ];
  const match=errors.find(([marker])=>text.includes(marker));
  return match ? new UsTeamError(match[1],match[2]) : new UsTeamError('service_unavailable',503);
}

/** Private server port. Context is authenticated/catalogue-verified upstream;
 * every operation also corroborates retained US facts and current membership.
 * No raw invitation token, URL, email transport or ERP write reaches this sink. */
export function d1UsTeamStore(database: TeamDatabase, options: {now?:()=>number} = {}): UsTeamStore {
  const now = options.now ?? (()=>Math.floor(Date.now()/1000));
  async function context(input: unknown): Promise<UsTeamContext> {
    const c=validateUsTeamContext(input,undefined,now());
    const saved=await database.prepare(`SELECT a.subscription_id,a.environment,a.catalog_version,a.seat_limit,json_extract(a.offer_json,'$.priceId') AS price_id,
      json_extract(a.authority_json,'$.evidence.startsAt') AS starts_at,json_extract(a.authority_json,'$.evidence.endsAt') AS ends_at
      FROM international_saas_authorities a JOIN international_workspace_creation_intents i ON i.creation_id=a.creation_id AND i.organization_id=a.organization_id
      JOIN international_workspace_members owner ON owner.organization_id=a.organization_id AND owner.user_id=a.owner_user_id AND owner.role='owner' AND owner.revoked_at IS NULL
      WHERE a.organization_id=? AND i.state='ready' AND i.own_subscription_id=a.subscription_id AND a.country='US' AND a.currency='USD' AND a.revoked_at IS NULL
      AND json_extract(a.authority_json,'$.status')='active' AND json_extract(a.authority_json,'$.evidence.revoked')=0
      AND json_extract(a.authority_json,'$.evidence.startsAt')<=unixepoch() AND json_extract(a.authority_json,'$.evidence.endsAt')>unixepoch()`)
      .bind(c.organizationId).first();
    if(!saved)throw new UsTeamError('subscription_required',402);
    const v=row(saved);
    if(v.subscription_id!==c.subscriptionId||v.environment!==c.environment||v.catalog_version!==c.catalogVersion||v.seat_limit!==c.seatLimit||v.price_id!==c.priceId||v.starts_at!==c.validStartsAt||v.ends_at!==c.validEndsAt)throw new UsTeamError('configuration_changed',409);
    if(c.mode==='member') {
      const member=await database.prepare('SELECT role,revoked_at FROM international_workspace_members WHERE organization_id=? AND user_id=?').bind(c.organizationId,c.user.userId).first();
      if(!member||row(member).role!==c.role||row(member).revoked_at!==null)throw new UsTeamError('forbidden',403);
    }
    if(c.credential?.kind==='device') {
      const source=c.credential.supportedSchemaVersion===4?'international_us_device_v4_sessions':'international_us_device_sessions';
      const session=await database.prepare(`SELECT session_id FROM ${source} WHERE session_id=? AND organization_id=? AND user_id=? AND role=? AND subscription_id=? AND supported_schema_version=? AND revoked_at IS NULL AND expires_at>unixepoch() AND entitlement_valid_until>unixepoch()`)
        .bind(c.credential.sessionId,c.organizationId,c.user.userId,c.role,c.subscriptionId,c.credential.supportedSchemaVersion).first();
      if(!session)throw new UsTeamError('unauthorized',401);
    }
    return c;
  }
  async function savedReceipt(c:UsTeamContext,id:string):Promise<UsTeamStoredReceipt|null> {
    if(!uuid(id))return bad();
    const saved=await database.prepare('SELECT * FROM international_us_team_commands WHERE organization_id=? AND actor_user_id=? AND request_id=?').bind(c.organizationId,c.user.userId,id).first();
    if(!saved)return null;
    const v=row(saved),command=validateUsTeamCommit({context:json(v.context_json),command:json(v.command_json),requestHash:v.request_hash});
    const receipt=validateUsTeamReceipt(json(v.receipt_json),c.organizationId);
    const entity=command.command.action==='regenerate_invitation'?command.command.newInvitationId:command.command.action==='accept_invitation'||command.command.action==='revoke_member'?command.command.membershipId:command.command.invitationId;
    if(command.context.organizationId!==c.organizationId||command.context.user.userId!==c.user.userId||command.command.requestId!==id||command.requestHash!==await hashUsTeamCommand(c.organizationId,c.user.userId,command.command)
      ||v.organization_id!==c.organizationId||v.actor_user_id!==c.user.userId||v.request_id!==id||v.action!==command.command.action||v.entity_id!==entity||v.created_at!==command.context.checkedAt
      ||v.expected_revision!==command.command.expectedTeamRevision||v.revision!==command.command.expectedTeamRevision+1||receipt.entityId!==entity||receipt.action!==v.action||receipt.requestId!==id||receipt.revision!==v.revision)return bad();
    const audit=await database.prepare('SELECT * FROM international_us_team_audit WHERE organization_id=? AND command_id=?').bind(c.organizationId,v.command_id).first();
    if(!audit)return bad();
    const a=row(audit);for(const key of ['organization_id','command_id','revision','actor_user_id','action','entity_id','request_hash','created_at'])if(a[key]!==v[key])return bad();
    return validateUsTeamStoredReceipt({receipt,requestHash:v.request_hash,actorUserId:v.actor_user_id,createdAt:v.created_at},c.organizationId);
  }
  async function find(hash:string):Promise<UsTeamInvitation|null> {
    if(!digest(hash))return bad();
    const saved=await database.prepare('SELECT * FROM international_us_team_invitations WHERE token_hash=?').bind(hash).first();
    return saved?invitation(saved):null;
  }
  return {
    async revision(input){try{const c=await context(input);const saved=await database.prepare('SELECT revision FROM international_us_team_heads WHERE organization_id=?').bind(c.organizationId).first();const v=saved?row(saved).revision:0;if(typeof v!=='number'||!Number.isSafeInteger(v)||v<0)return bad();await context(c);return v;}catch(error){throw dbError(error);}},
    async find(hash){try{return await find(hash);}catch(error){throw dbError(error);}},
    async invitation(input,id){try{const c=await context(input);if(!uuid(id)||c.mode!=='member'||!['owner','admin'].includes(c.role))throw new UsTeamError('forbidden',403);
      const saved=await database.prepare('SELECT * FROM international_us_team_invitations WHERE organization_id=? AND invitation_id=?').bind(c.organizationId,id).first();await context(c);return saved?invitation(saved):null;
    }catch(error){throw dbError(error);}},
    async receipt(input,id){try{const c=await context(input),saved=await savedReceipt(c,id);await context(c);return saved;}catch(error){throw dbError(error);}},
    async read(input){try {
      const c=await context(input);if(c.mode!=='member')throw new UsTeamError('forbidden',403);
      // One SQL snapshot keeps counts, head and arrays coherent during joins.
      const saved=await database.prepare(`SELECT COALESCE((SELECT revision FROM international_us_team_heads WHERE organization_id=?),0) AS revision,
        (SELECT json_group_array(json_object('membershipId',membership_id,'userId',user_id,'role',role,'displayName',display_name,'joinedAt',joined_at)) FROM
          (SELECT * FROM international_workspace_members WHERE organization_id=? AND revoked_at IS NULL ORDER BY joined_at,membership_id LIMIT 1001)) AS members,
        (SELECT json_group_array(json_object('invitationId',invitation_id,'email',email,'role',role,'createdAt',created_at,'expiresAt',expires_at)) FROM
          (SELECT * FROM international_us_team_invitations WHERE organization_id=? AND status='pending' AND expires_at>? ORDER BY created_at,invitation_id LIMIT 1001)) AS invitations`)
        .bind(c.organizationId,c.organizationId,c.organizationId,c.checkedAt).first();
      if(!saved)return bad();const v=row(saved);
      if(typeof v.members!=='string'||typeof v.invitations!=='string'||v.members.length+v.invitations.length>1_048_576)return bad();
      const members:unknown=JSON.parse(v.members),invitations:unknown=JSON.parse(v.invitations);if(!Array.isArray(members)||!Array.isArray(invitations))return bad();
      const result=validateUsTeamProjection({schemaVersion:1,organizationId:c.organizationId,revision:v.revision,role:c.role,seatLimit:c.seatLimit,activeMembers:members.length,
        reservedInvitations:invitations.length,remainingSeats:c.seatLimit-members.length-invitations.length,checkedAt:c.checkedAt,members,invitations:['owner','admin'].includes(c.role)?invitations:[]},c.organizationId);
      await context(c);return result;
    }catch(error){throw dbError(error);}},
    async commit(input){
      let captured:UsTeamCommit;
      try{captured=validateUsTeamCommit(input,now());}catch{return bad();}
      const {context:c,command:q,requestHash}=captured;
      try {
        await context(c);
        if(requestHash!==await hashUsTeamCommand(c.organizationId,c.user.userId,q))return bad();
        const replay=await savedReceipt(c,q.requestId);
        if(replay){if(replay.requestHash!==requestHash)throw new UsTeamError('team_idempotency_conflict',409);await context(c);return {receipt:replay.receipt,replayed:true,firstApplied:false};}
        const entity=q.action==='regenerate_invitation'?q.newInvitationId:q.action==='accept_invitation'||q.action==='revoke_member'?q.membershipId:q.invitationId;
        const receipt:UsTeamReceipt={schemaVersion:1,organizationId:c.organizationId,requestId:q.requestId,action:q.action,entityId:entity,revision:q.expectedTeamRevision+1};
        const commandId=crypto.randomUUID(), stamp=c.checkedAt,org=c.organizationId;
        const statements:D1PreparedStatement[]=[
          database.prepare('INSERT INTO international_us_team_heads(organization_id,revision,last_command_id) SELECT ?,0,NULL WHERE NOT EXISTS(SELECT 1 FROM international_us_team_heads WHERE organization_id=?)').bind(org,org),
          database.prepare(`INSERT INTO international_us_team_commands(command_id,organization_id,actor_user_id,request_id,expected_revision,revision,action,entity_id,request_hash,command_json,context_json,receipt_json,created_at)VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .bind(commandId,org,c.user.userId,q.requestId,q.expectedTeamRevision,receipt.revision,q.action,entity,requestHash,canonicalErpJson(q),canonicalErpJson(c),canonicalErpJson(receipt),stamp),
        ];
        if(q.action==='regenerate_invitation'||q.action==='revoke_invitation')statements.push(database.prepare("UPDATE international_us_team_invitations SET status='revoked',revoked_at=?,changed_command_id=? WHERE organization_id=? AND invitation_id=? AND status='pending'").bind(stamp,commandId,org,q.invitationId));
        if(q.action==='create_invitation')statements.push(database.prepare(`INSERT INTO international_us_team_invitations(invitation_id,organization_id,email,role,token_hash,created_by,created_at,expires_at,status,created_command_id)VALUES(?,?,?,?,?,?,?,?,'pending',?)`).bind(q.invitationId,org,q.email,q.role,q.tokenHash,c.user.userId,stamp,q.expiresAt,commandId));
        if(q.action==='regenerate_invitation')statements.push(database.prepare(`INSERT INTO international_us_team_invitations(invitation_id,organization_id,email,role,token_hash,created_by,created_at,expires_at,status,created_command_id)SELECT ?,organization_id,email,role,?,?,?,?,'pending',? FROM international_us_team_invitations WHERE organization_id=? AND invitation_id=? AND status='revoked' AND changed_command_id=?`).bind(q.newInvitationId,q.tokenHash,c.user.userId,stamp,q.expiresAt,commandId,org,q.invitationId,commandId));
        if(q.action==='accept_invitation')statements.push(
          database.prepare("UPDATE international_us_team_invitations SET status='accepted',accepted_by=?,accepted_at=?,membership_id=?,changed_command_id=? WHERE organization_id=? AND invitation_id=? AND status='pending' AND token_hash=? AND email=? AND expires_at>?").bind(c.user.userId,stamp,q.membershipId,commandId,org,q.invitationId,q.tokenHash,c.user.email,stamp),
          database.prepare(`INSERT INTO international_workspace_members(membership_id,organization_id,user_id,role,display_name,joined_at)VALUES(?,?,?,?,?,?)`).bind(q.membershipId,org,c.user.userId,c.role,q.displayName,stamp),
          database.prepare(`INSERT INTO international_us_team_profiles(organization_id,membership_id,user_id,email,first_name,last_name,display_name,accepted_command_id,created_at)VALUES(?,?,?,?,?,?,?,?,?)`).bind(org,q.membershipId,c.user.userId,c.user.email,q.firstName,q.lastName,q.displayName,commandId,stamp));
        if(q.action==='revoke_member')statements.push(
          database.prepare('UPDATE international_workspace_members SET revoked_at=? WHERE organization_id=? AND membership_id=? AND revoked_at IS NULL').bind(stamp,org,q.membershipId),
          database.prepare('UPDATE international_us_device_sessions SET revoked_at=? WHERE organization_id=? AND user_id=(SELECT user_id FROM international_workspace_members WHERE organization_id=? AND membership_id=?) AND revoked_at IS NULL').bind(stamp,org,org,q.membershipId),
          database.prepare('UPDATE international_us_device_v4_sessions SET revoked_at=? WHERE organization_id=? AND user_id=(SELECT user_id FROM international_workspace_members WHERE organization_id=? AND membership_id=?) AND revoked_at IS NULL').bind(stamp,org,org,q.membershipId));
        statements.push(database.prepare('INSERT INTO international_us_team_audit(organization_id,command_id,revision,actor_user_id,action,entity_id,request_hash,created_at)VALUES(?,?,?,?,?,?,?,?)').bind(org,commandId,receipt.revision,c.user.userId,q.action,entity,requestHash,stamp));
        await context(c);
        let firstApplied=false;
        try {const results=await database.batch(statements);if(!results.every(result=>result.success)||results[1]?.meta.changes!==1)throw new UsTeamError('service_unavailable',503);firstApplied=true;}
        catch(error){await context(c);const saved=await savedReceipt(c,q.requestId);if(!saved)throw dbError(error);if(saved.requestHash!==requestHash)throw new UsTeamError('team_idempotency_conflict',409);return {receipt:saved.receipt,replayed:true,firstApplied:false};}
        await context(c);const saved=await savedReceipt(c,q.requestId);if(!saved||saved.requestHash!==requestHash)return bad();
        const result:UsTeamCommitResult={receipt:saved.receipt,replayed:!firstApplied,firstApplied};return result;
      }catch(error){throw dbError(error);}
    },
  };
}
