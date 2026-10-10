import { canonicalErpJson } from './erp-contract';
import { snapshotPrivateJson } from './private-json';
import { sha256Hex } from './canonical-hash';
import { d1UsSupportWorkspaceStore } from './us-support-workspace-d1';
import { UsSupportWorkspaceError } from './us-support-workspace-contract';
import { UsMailboxError } from './us-support-mailbox-contract';
import { sameUsSupportExecutionContext, validateUsSupportExecutionContext, isUsSupportWorkerContext } from './us-support-execution-contract';
import { assertUsSupportWorkerExecution } from './us-support-execution-d1';
import { hashUsSupportTriageSource, validateUsSupportTriageSource, validateUsSupportTriageGrant, validateUsSupportTriageDecision, US_SUPPORT_TRIAGE_MODEL, US_SUPPORT_TRIAGE_RECIPE_VERSION } from './us-support-triage-contract';
import { UsSupportTicketError, US_SUPPORT_TICKETS_PAGE_SIZE, validateUsSupportTicketRequest, validateUsSupportRoutingRequest, validateUsSupportTicket,
  validateUsSupportRouting, validateUsSupportTicketsHead, validateUsSupportTicketsProjection, validateUsSupportTicketReceipt,
  validateUsSupportTicketMutationResult, validateUsSupportRoutingMutationResult, hashUsSupportTicketExecutionRequest, hashUsSupportRoutingRequest,
  type UsSupportTicketStore, type UsSupportTicketContext, type UsSupportTicket, type UsSupportRouting, type UsSupportTicketRequest,
  type UsSupportTicketStoredResult } from './us-support-ticket-contract';

type Database=Pick<D1Database,'prepare'|'batch'>;
type Row=Record<string,unknown>;
type Snapshot=Omit<UsSupportTicket,'assigneeActive'|'audit'>;
const fail=(code='invalid_ticket_record',status=503):never=>{throw new UsSupportTicketError(code,status);};
function row(input:unknown):Row{const v=snapshotPrivateJson(input);if(!v||typeof v!=='object'||Array.isArray(v))return fail();return v as Row;}
function json(input:unknown):unknown{if(typeof input!=='string'||new TextEncoder().encode(input).length>32_768)return fail();const v:unknown=JSON.parse(input);if(canonicalErpJson(v)!==input)return fail();return v;}
function mapped(error:unknown):UsSupportTicketError{
  if(error instanceof UsSupportTicketError)return error;
  if(error instanceof UsSupportWorkspaceError||error instanceof UsMailboxError)return new UsSupportTicketError(error.code,error.status);
  const message=error instanceof Error?error.message:'';
  const markers:readonly[string,number][]=[['idempotency_conflict',409],['revision_conflict',409],['source_conflict',409],['source_not_completed',409],['assignee_unavailable',409],['capacity_exceeded',409],['audit_capacity_exceeded',409],['command_capacity_exceeded',409],['subscription_required',402],['forbidden',403],['unauthorized',401],['invalid_record',503],['immutable',503]];
  const match=markers.find(([code])=>message.includes('us_ticket_'+code));
  return match?new UsSupportTicketError(['subscription_required','forbidden','unauthorized'].includes(match[0])?match[0]:['invalid_record','immutable'].includes(match[0])?'invalid_ticket_record':'ticket_'+match[0],match[1]):new UsSupportTicketError('service_unavailable',503);
}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const initialRouting=():UsSupportRouting=>({schemaVersion:1,revision:0,enabled:false,threshold:1,routes:[]});
function snapshot(ticket:UsSupportTicket):Snapshot{const {assigneeActive:_active,audit:_audit,...value}=ticket;return value;}
/** Local workflow only. Source proof is read from actual immutable H3a rows;
 * no mailbox/provider port or outbound action is available here. */
export function d1UsSupportTicketStore(database:Database,options:{now?:()=>number}={}):UsSupportTicketStore{
  const now=options.now??(()=>Math.floor(Date.now()/1000)),registry=d1UsSupportWorkspaceStore(database,{now});
  async function context(input:unknown){const c=validateUsSupportExecutionContext(input,undefined,now());if(isUsSupportWorkerContext(c))return assertUsSupportWorkerExecution(database,c,now());const workspace=await registry.read(c.authority);if(!workspace||workspace.workspaceId!==c.workspaceId)return fail('forbidden',403);if(c.authority.credential.kind==='device'&&c.authority.credential.supportedSchemaVersion!==4)return fail('client_upgrade_required',409);return c;}
  async function admitted(input:UsSupportTicketContext,revalidate:()=>Promise<UsSupportTicketContext>){const first=await context(input);return async()=>{const next=validateUsSupportExecutionContext(await revalidate(),first.authority.organizationId,now());sameUsSupportExecutionContext(first,next);return context(next);};}
  function manage(c:UsSupportTicketContext){if(!['owner','admin'].includes(c.authority.role))return fail('support_management_required',403);}
  async function heads(c:UsSupportTicketContext){const saved=await database.prepare(`SELECT COALESCE((SELECT revision FROM international_us_support_ticket_heads WHERE organization_id=? AND workspace_id=?),0) AS revision,COALESCE((SELECT revision FROM international_us_team_heads WHERE organization_id=?),0) AS teamRevision`).bind(c.authority.organizationId,c.workspaceId,c.authority.organizationId).first();const h=row(saved);return validateUsSupportTicketsHead({schemaVersion:1,organizationId:c.authority.organizationId,userId:c.authority.userId,role:c.authority.role,workspaceId:c.workspaceId,revision:h.revision,teamRevision:h.teamRevision});}
  async function routing(c:UsSupportTicketContext){const saved=await database.prepare('SELECT snapshot_json FROM international_us_support_ticket_routing WHERE organization_id=? AND workspace_id=? ORDER BY revision DESC LIMIT 1').bind(c.authority.organizationId,c.workspaceId).first();return saved?validateUsSupportRouting(json(row(saved).snapshot_json)):initialRouting();}
  async function active(c:UsSupportTicketContext,membershipId:string|null){if(membershipId===null)return false;const saved=await database.prepare("SELECT membership_id FROM international_workspace_members WHERE organization_id=? AND membership_id=? AND revoked_at IS NULL AND role IN('owner','admin','member')").bind(c.authority.organizationId,membershipId).first();return saved!==null;}
  async function ticket(c:UsSupportTicketContext,ticketId:string):Promise<UsSupportTicket|null>{
    if(!uuid(ticketId))return fail('invalid_ticket_request',422);
    const saved=await database.prepare(`SELECT r.snapshot_json,t.origin_job_id,t.source_hash,t.created_at,t.id,
      (SELECT count(*) FROM international_us_support_ticket_audit a JOIN international_us_support_ticket_commands ac ON ac.command_id=a.command_id AND ac.applied=1 WHERE a.organization_id=t.organization_id AND a.workspace_id=t.workspace_id AND a.entity_id=t.id AND a.action<>'save_routing') AS total,
      (SELECT json_group_array(json(a.event_json)) FROM (SELECT a.event_json FROM international_us_support_ticket_audit a JOIN international_us_support_ticket_commands ac ON ac.command_id=a.command_id AND ac.applied=1 WHERE a.organization_id=t.organization_id AND a.workspace_id=t.workspace_id AND a.entity_id=t.id AND a.action<>'save_routing' ORDER BY a.revision DESC LIMIT 20) a) AS events
      FROM international_us_support_tickets t JOIN international_us_support_ticket_revisions r ON r.organization_id=t.organization_id AND r.workspace_id=t.workspace_id AND r.ticket_id=t.id
      WHERE t.organization_id=? AND t.workspace_id=? AND t.id=? ORDER BY r.revision DESC LIMIT 1`).bind(c.authority.organizationId,c.workspaceId,ticketId).first();
    if(!saved)return null;const r=row(saved),s=row(json(r.snapshot_json));
    if(s.id!==r.id||s.originJobId!==r.origin_job_id||s.createdAt!==r.created_at||typeof r.events!=='string')return fail();
    return validateUsSupportTicket({...s,assigneeActive:await active(c,s.assigneeMembershipId as string|null),audit:{total:r.total,events:JSON.parse(r.events)}},c.authority.organizationId,c.workspaceId);
  }
  async function completedJob(c:UsSupportTicketContext,jobId:string){
    const saved=await database.prepare(`SELECT j.*,d.dispatch_id,x.decision_json,x.result_sha256,x.created_at AS completed_at FROM international_us_support_triage_jobs j
      JOIN international_us_support_triage_dispatches d ON d.organization_id=j.organization_id AND d.workspace_id=j.workspace_id AND d.job_id=j.id
      JOIN international_us_support_triage_completions x ON x.organization_id=j.organization_id AND x.workspace_id=j.workspace_id AND x.job_id=j.id AND x.dispatch_id=d.dispatch_id
      WHERE j.organization_id=? AND j.workspace_id=? AND j.id=?`).bind(c.authority.organizationId,c.workspaceId,jobId).first();
    if(!saved)return fail('ticket_source_not_completed',409);const r=row(saved),source=validateUsSupportTriageSource(json(r.source_json)),grant=validateUsSupportTriageGrant(json(r.grant_json),c.authority.organizationId,c.workspaceId,r.created_at as number),decision=validateUsSupportTriageDecision(json(r.decision_json),{source,grant});
    if(await hashUsSupportTriageSource(c.authority.organizationId,c.workspaceId,source)!==r.source_hash||await sha256Hex(r.decision_json as string)!==r.result_sha256||!uuid(r.dispatch_id)||typeof r.completed_at!=='number'||r.completed_at<(r.created_at as number))return fail();
    return {id:jobId,source,grant,decision,sourceHash:r.source_hash as string};
  }
  async function receipt(c:UsSupportTicketContext,requestId:string,requestHash:string):Promise<UsSupportTicketStoredResult|null>{
    if(!uuid(requestId)||!digest(requestHash))return fail('invalid_ticket_request',422);
    const saved=await database.prepare('SELECT c.*,a.command_id AS audited FROM international_us_support_ticket_commands c JOIN international_us_support_ticket_audit a ON a.organization_id=c.organization_id AND a.workspace_id=c.workspace_id AND a.command_id=c.command_id WHERE c.organization_id=? AND c.workspace_id=? AND c.actor_user_id=? AND c.request_id=?').bind(c.authority.organizationId,c.workspaceId,c.authority.userId,requestId).first();
    if(!saved)return null;const r=row(saved);if(r.request_hash!==requestHash)return fail('ticket_idempotency_conflict',409);
    const q=r.action==='save_routing'?validateUsSupportRoutingRequest(json(r.request_json)):validateUsSupportTicketRequest(json(r.request_json));
    const captured=validateUsSupportExecutionContext(json(r.context_json),c.authority.organizationId);
    const expectedHash=r.action==='save_routing'?await hashUsSupportRoutingRequest(c.authority.organizationId,c.workspaceId,c.authority.userId,q as never):await hashUsSupportTicketExecutionRequest(captured,q as UsSupportTicketRequest);
    if(expectedHash!==requestHash||q.requestId!==requestId||captured.authority.userId!==c.authority.userId||captured.workspaceId!==c.workspaceId||captured.authority.checkedAt!==r.created_at)return fail();
    const received=validateUsSupportTicketReceipt({schemaVersion:1,organizationId:c.authority.organizationId,workspaceId:c.workspaceId,requestId,actorUserId:c.authority.userId,action:r.action,entityId:r.entity_id,revision:r.entity_revision,headRevision:r.revision,createdAt:r.created_at});
    if(r.action==='save_routing')return {kind:'routing',...validateUsSupportRoutingMutationResult({routing:await routing(c),receipt:received,replayed:true},c.authority.organizationId,c.workspaceId)};
    const retained=await ticket(c,r.entity_id as string);if(!retained)return fail();return {kind:'ticket',...validateUsSupportTicketMutationResult({ticket:retained,receipt:received,replayed:true},c.authority.organizationId,c.workspaceId)};
  }
  function commandStatement(c:UsSupportTicketContext,q:unknown,hash:string,values:{commandId:string;action:string;entityId:string;expectedRevision:number;entityRevision:number;applied:boolean;jobId?:string;sourceHash?:string;routingRevision?:number}){
    return database.prepare(`INSERT INTO international_us_support_ticket_commands(command_id,organization_id,workspace_id,actor_user_id,request_id,request_hash,action,entity_id,expected_revision,entity_revision,revision,applied,job_id,source_hash,routing_revision,request_json,context_json,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,revision+1,?,?,?,?,?,?,? FROM international_us_support_ticket_heads WHERE organization_id=? AND workspace_id=?`).bind(values.commandId,c.authority.organizationId,c.workspaceId,c.authority.userId,(q as {requestId:string}).requestId,hash,values.action,values.entityId,values.expectedRevision,values.entityRevision,Number(values.applied),values.jobId??null,values.sourceHash??null,values.routingRevision??null,canonicalErpJson(q),canonicalErpJson(c),c.authority.checkedAt,c.authority.organizationId,c.workspaceId);
  }
  function ensureHead(c:UsSupportTicketContext){return database.prepare('INSERT INTO international_us_support_ticket_heads(organization_id,workspace_id,revision,last_command_id) SELECT ?,?,0,NULL WHERE NOT EXISTS(SELECT 1 FROM international_us_support_ticket_heads WHERE organization_id=? AND workspace_id=?)').bind(c.authority.organizationId,c.workspaceId,c.authority.organizationId,c.workspaceId);}
  function auditStatement(c:UsSupportTicketContext,commandId:string,event:unknown){return database.prepare(`INSERT INTO international_us_support_ticket_audit(organization_id,workspace_id,command_id,revision,actor_user_id,action,entity_id,entity_revision,request_hash,event_json,context_json,created_at)
    SELECT organization_id,workspace_id,command_id,revision,actor_user_id,action,entity_id,entity_revision,request_hash,CASE WHEN action='save_routing' THEN ? ELSE json_set(?,'$.revision',revision) END,context_json,created_at FROM international_us_support_ticket_commands WHERE command_id=?`).bind(canonicalErpJson(event),canonicalErpJson(event),commandId);}
  async function runBatch(statements:D1PreparedStatement[]){const results=await database.batch(statements);if(!results.every(r=>r.success))return fail();}
  return {
    async head(input){try{const c=await context(input),h=await heads(c);await context(c);return h;}catch(error){throw mapped(error);}},
    async read(input,offset=0){try{
      if(!Number.isSafeInteger(offset)||offset<0||offset>500)return fail('invalid_ticket_request',422);const c=await context(input);
      for(let attempt=0;attempt<3;attempt++){
        const before=await heads(c),rows=await database.prepare('SELECT id FROM international_us_support_tickets WHERE organization_id=? AND workspace_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?').bind(c.authority.organizationId,c.workspaceId,US_SUPPORT_TICKETS_PAGE_SIZE+1,offset).all();if(!rows.success)return fail();
        const tickets:UsSupportTicket[]=[];for(const raw of rows.results.slice(0,US_SUPPORT_TICKETS_PAGE_SIZE)){const t=await ticket(c,row(raw).id as string);if(!t)return fail();tickets.push(t);}
        const settings=await routing(c),members=await database.prepare("SELECT membership_id AS membershipId,user_id AS userId,role,display_name AS displayName FROM international_workspace_members WHERE organization_id=? AND revoked_at IS NULL AND role IN('owner','admin','member') ORDER BY joined_at,membership_id LIMIT 1001").bind(c.authority.organizationId).all();if(!members.success)return fail();
        const after=await heads(c);await context(c);if(before.revision!==after.revision||before.teamRevision!==after.teamRevision)continue;
        return validateUsSupportTicketsProjection({schemaVersion:1,organizationId:c.authority.organizationId,userId:c.authority.userId,role:c.authority.role,workspaceId:c.workspaceId,offset,nextOffset:rows.results.length>US_SUPPORT_TICKETS_PAGE_SIZE?offset+US_SUPPORT_TICKETS_PAGE_SIZE:null,tickets,routing:settings,assignees:members.results,head:{revision:after.revision,teamRevision:after.teamRevision}},c.authority.organizationId,c.workspaceId);
      }
      return fail('ticket_revision_conflict',409);
    }catch(error){throw mapped(error);}},
    async find(input,requestId,requestHash){try{const c=await context(input),saved=await receipt(c,requestId,requestHash);await context(c);return saved;}catch(error){throw mapped(error);}},
    async commit(input,requestInput,revalidate){try{
      const q=validateUsSupportTicketRequest(requestInput),fresh=await admitted(input,revalidate);let c=await fresh();if(isUsSupportWorkerContext(c)&&q.action!=='create')return fail('forbidden',403);const hash=await hashUsSupportTicketExecutionRequest(c,q);
      for(let attempt=0;attempt<3;attempt++){
        const existing=await receipt(c,q.requestId,hash);if(existing){await fresh();if(existing.kind!=='ticket')return fail('ticket_idempotency_conflict',409);const {kind:_kind,...r}=existing;return r;}
        if(q.action!=='set_status')manage(c);
        let next:Snapshot,applied=true,sourceHash:string|null=null,originJobId:string|null=null,routingRevision:number|null=null;
        if(q.action==='create'){
          const job=await completedJob(c,q.jobId);sourceHash=job.sourceHash;originJobId=job.id;
          const found=await database.prepare('SELECT id FROM international_us_support_tickets WHERE organization_id=? AND workspace_id=? AND source_hash=?').bind(c.authority.organizationId,c.workspaceId,sourceHash).first();
          if(found){const retained=await ticket(c,row(found).id as string);if(!retained)return fail();next=snapshot(retained);applied=false;}
          else{
            const settings=await routing(c);routingRevision=settings.revision;const target=settings.routes.find(r=>r.category===job.decision.category)?.membershipId??null;
            const safe=settings.enabled&&!job.decision.needsReview&&job.decision.reviewReasons.length===0&&job.decision.model===US_SUPPORT_TRIAGE_MODEL&&job.decision.recipeVersion===US_SUPPORT_TRIAGE_RECIPE_VERSION&&Math.min(job.decision.categoryConfidence,job.decision.priorityConfidence,job.decision.languageConfidence)>=Math.max(settings.threshold,job.grant.threshold)&&await active(c,target);
            next={schemaVersion:1,id:crypto.randomUUID(),organizationId:c.authority.organizationId,workspaceId:c.workspaceId,originJobId:job.id,uid:job.source.uid,createdAt:c.authority.checkedAt,revision:1,category:job.decision.category,priority:job.decision.priority,language:job.decision.language,originalDecision:job.decision,reviewReasons:job.decision.reviewReasons,needsReview:job.decision.needsReview,humanCorrection:false,correctedBy:null,assigneeMembershipId:safe?target:null,status:'open',updatedAt:c.authority.checkedAt};
          }
        }else{
          const prior=await ticket(c,q.ticketId);if(!prior)return fail('ticket_not_found',404);if(prior.revision!==q.expectedRevision)return fail('ticket_revision_conflict',409);
          if(q.action==='set_status'&&!['owner','admin'].includes(c.authority.role)){
            const member=await database.prepare("SELECT user_id FROM international_workspace_members WHERE organization_id=? AND membership_id=? AND user_id=? AND role='member' AND revoked_at IS NULL").bind(c.authority.organizationId,prior.assigneeMembershipId,c.authority.userId).first();if(c.authority.role!=='member'||!member||!prior.assigneeActive)return fail('forbidden',403);
          }
          next={...snapshot(prior),revision:prior.revision+1,updatedAt:c.authority.checkedAt};
          if(q.action==='correct')next={...next,category:q.category,priority:q.priority,language:q.language,humanCorrection:true,correctedBy:c.authority.userId};
          if(q.action==='assign'){if(q.assigneeMembershipId!==null&&!await active(c,q.assigneeMembershipId))return fail('ticket_assignee_unavailable',409);next={...next,assigneeMembershipId:q.assigneeMembershipId};}
          if(q.action==='set_status')next={...next,status:q.status};
        }
        c=await fresh();const commandId=crypto.randomUUID(),statements=[ensureHead(c),commandStatement(c,q,hash,{commandId,action:q.action,entityId:next.id,expectedRevision:q.action==='create'?0:q.expectedRevision,entityRevision:next.revision,applied,jobId:originJobId??undefined,sourceHash:sourceHash??undefined,routingRevision:routingRevision??undefined})];
        if(q.action==='create'&&applied)statements.push(database.prepare('INSERT INTO international_us_support_tickets(id,organization_id,workspace_id,source_hash,origin_job_id,created_command_id,created_at) VALUES(?,?,?,?,?,?,?)').bind(next.id,c.authority.organizationId,c.workspaceId,sourceHash,originJobId,commandId,next.createdAt));
        if(applied)statements.push(database.prepare('INSERT INTO international_us_support_ticket_revisions(organization_id,workspace_id,ticket_id,revision,command_id,snapshot_json)VALUES(?,?,?,?,?,?)').bind(c.authority.organizationId,c.workspaceId,next.id,next.revision,commandId,canonicalErpJson(next)));
        const event={ticketRevision:next.revision,action:q.action,actorUserId:c.authority.userId,createdAt:c.authority.checkedAt,category:next.category,priority:next.priority,language:next.language,assigneeMembershipId:next.assigneeMembershipId,status:next.status,humanCorrection:next.humanCorrection,...(isUsSupportWorkerContext(c)?{actorKind:'worker',delegationId:c.authority.credential.delegationId,delegationRevision:c.authority.credential.delegationRevision,runId:c.authority.credential.runId}:{})};
        statements.push(auditStatement(c,commandId,event));
        try{await runBatch(statements);}catch(error){c=await fresh();const saved=await receipt(c,q.requestId,hash);if(saved?.kind==='ticket'){const {kind:_kind,...r}=saved;await fresh();return r;}if(q.action==='create'&&attempt<2&&(error instanceof Error)&&(/UNIQUE|us_ticket_revision_conflict|us_ticket_source_conflict/.test(error.message)))continue;throw error;}
        const saved=await receipt(await fresh(),q.requestId,hash);await fresh();if(saved?.kind!=='ticket')return fail();const {kind:_kind,...r}=saved;return {...r,replayed:!applied};
      }
      return fail('ticket_revision_conflict',409);
    }catch(error){throw mapped(error);}},
    async saveRouting(input,requestInput,revalidate){try{
      const q=validateUsSupportRoutingRequest(requestInput),fresh=await admitted(input,revalidate);let c=await fresh();if(isUsSupportWorkerContext(c))return fail('forbidden',403);const hash=await hashUsSupportRoutingRequest(c.authority.organizationId,c.workspaceId,c.authority.userId,q),existing=await receipt(c,q.requestId,hash);
      if(existing){await fresh();if(existing.kind!=='routing')return fail('ticket_idempotency_conflict',409);const {kind:_kind,...r}=existing;return r;}manage(c);
      const previous=await routing(c);if(previous.revision!==q.expectedRevision)return fail('ticket_revision_conflict',409);for(const route of q.routes)if(!await active(c,route.membershipId))return fail('ticket_assignee_unavailable',409);
      const next=validateUsSupportRouting({schemaVersion:1,revision:q.expectedRevision+1,enabled:q.enabled,threshold:q.threshold,routes:q.routes}),commandId=crypto.randomUUID();c=await fresh();
      const statements=[ensureHead(c),commandStatement(c,q,hash,{commandId,action:'save_routing',entityId:c.workspaceId,expectedRevision:q.expectedRevision,entityRevision:next.revision,applied:true}),database.prepare('INSERT INTO international_us_support_ticket_routing(organization_id,workspace_id,revision,command_id,snapshot_json)VALUES(?,?,?,?,?)').bind(c.authority.organizationId,c.workspaceId,next.revision,commandId,canonicalErpJson(next)),auditStatement(c,commandId,next)];
      try{await runBatch(statements);}catch(error){const saved=await receipt(await fresh(),q.requestId,hash);if(saved?.kind!=='routing')throw error;const {kind:_kind,...r}=saved;await fresh();return r;}
      const saved=await receipt(await fresh(),q.requestId,hash);await fresh();if(saved?.kind!=='routing')return fail();const {kind:_kind,...r}=saved;return {...r,replayed:false};
    }catch(error){throw mapped(error);}},
  };
}
