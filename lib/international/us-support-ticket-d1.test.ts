import { randomBytes,randomUUID } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { supportTicketFixture } from './us-support-ticket-test-fixture';
import { d1UsSupportTicketStore } from './us-support-ticket-d1';
import { canonicalErpJson } from './erp-contract';
import { hashUsSupportTicketRequest,hashUsSupportRoutingRequest,US_SUPPORT_TICKET_COMMAND_LIMIT,type UsSupportTicketRequest } from './us-support-ticket-contract';
import { d1UsTeamStore } from './us-team-store';
import { hashUsTeamCommand,hashUsTeamToken,newUsTeamToken } from './us-team-validation';
import type { UsTeamContext,UsTeamPrivateCommand } from './us-team-contract';
import type { UsMailboxContext } from './us-support-mailbox-contract';
import { d1UsDeviceStore } from './us-device-d1';

type Fixture=Awaited<ReturnType<typeof supportTicketFixture>>;
const opened:Fixture[]=[];
async function fixture(include=true){const f=await supportTicketFixture(include);opened.push(f);return f;}
afterEach(()=>{for(const f of opened.splice(0)){expect(f.sql.prepare('PRAGMA foreign_key_check').all()).toEqual([]);f.sql.close();}});
function team(c:UsMailboxContext):UsTeamContext{const a=c.authority;return {schemaVersion:1,organizationId:a.organizationId,mode:'member',role:a.role,user:{userId:a.userId,email:null,emailConfirmed:false},subscriptionId:a.subscriptionId,environment:a.environment,catalogVersion:a.catalogVersion,priceId:a.priceId,seatLimit:a.seatLimit,checkedAt:a.checkedAt,validStartsAt:a.validStartsAt,validEndsAt:a.validEndsAt,credential:a.credential};}
async function member(f:Fixture,role:'admin'|'member'|'accountant'|'read_only'){
  const userId=randomUUID(),store=d1UsTeamStore(f.database,{now:f.now}),owner=team(f.context()),invitationId=randomUUID(),email=userId+'@example.test',tokenHash=await hashUsTeamToken(newUsTeamToken());
  const invite:UsTeamPrivateCommand={schemaVersion:1,requestId:randomUUID(),expectedTeamRevision:await store.revision(owner),action:'create_invitation',email,role,invitationId,tokenHash,expiresAt:f.now()+604800};await store.commit({context:owner,command:invite,requestHash:await hashUsTeamCommand(owner.organizationId,f.actor,invite)});
  const membershipId=randomUUID(),accept:UsTeamPrivateCommand={schemaVersion:1,requestId:randomUUID(),expectedTeamRevision:await store.revision(owner),action:'accept_invitation',invitationId,tokenHash,membershipId,firstName:'Support',lastName:'TEST',displayName:'Support TEST'};await store.commit({context:{...owner,mode:'recipient',role,user:{userId,email,emailConfirmed:true}},command:accept,requestHash:await hashUsTeamCommand(owner.organizationId,userId,accept)});return {userId,membershipId};
}
const commit=(f:Fixture,q:UsSupportTicketRequest,user=f.actor)=>f.tickets.commit(f.context(user),q,async()=>f.context(user));
async function create(f:Fixture,uid='123'){const job=await f.completeJob({request:{uid}}),q=f.ticketRequest(job.job.id);return {job,q,...await commit(f,q)};}
const change=(f:Fixture,id:string,revision:number,patch:Record<string,unknown>):UsSupportTicketRequest=>({schemaVersion:1,requestId:randomUUID(),ticketId:id,expectedRevision:revision,...patch}) as UsSupportTicketRequest;
const count=(f:Fixture,name:string)=>Number(f.sql.prepare('SELECT count(*)AS n FROM '+name).get()!.n);
const intercept=(f:Fixture,batch:(statements:D1PreparedStatement[])=>Promise<D1Result[]>)=>({prepare:f.database.prepare.bind(f.database),batch}) as Pick<D1Database,'prepare'|'batch'>;
function rawInsert(f:Fixture,table:string,values:Record<string,SQLInputValue>,replace=false){const keys=Object.keys(values);return f.sql.prepare(`INSERT ${replace?'OR REPLACE ':''}INTO ${table}(${keys.join(',')})VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(values));}
async function revoke(f:Fixture,membershipId:string){const store=d1UsTeamStore(f.database,{now:f.now}),c=team(f.context()),q:UsTeamPrivateCommand={schemaVersion:1,requestId:randomUUID(),expectedTeamRevision:await store.revision(c),action:'revoke_member',membershipId};await store.commit({context:c,command:q,requestHash:await hashUsTeamCommand(c.organizationId,f.actor,q)});}
async function native(f:Fixture,schema:3|4){const store=d1UsDeviceStore(f.database),sessionId='usd_'+randomUUID(),codeHash=randomBytes(32).toString('base64url'),tokenHash=randomBytes(32).toString('base64url'),userCode='ABCD-EFG'+schema;await store.start({codeHash,tokenHash,installationId:randomUUID(),userCode,schema,now:f.now()});await store.approve(userCode,{organizationId:f.intent.organizationId,organizationName:'US TEST',userId:f.actor,role:'owner',subscriptionId:f.authority.subscriptionId,entitlementValidUntil:f.authority.evidence!.endsAt,configurationStamp:'synthetic TEST'},f.now());await store.consume((await store.challenge('code',codeHash))!,sessionId,f.now());return {kind:'device' as const,sessionId,supportedSchemaVersion:schema};}

describe('US Support tickets actual SQLite0000..0097; synthetic Auth/provider',()=>{
  it('creates a body-free ticket from durable completed triage and reads a coherent head',async()=>{
    const f=await fixture(),r=await create(f);expect(r.ticket).toMatchObject({revision:1,status:'open',humanCorrection:false,assigneeMembershipId:null,audit:{total:1}});
    const p=await f.tickets.read(f.context());expect(p.tickets).toEqual([r.ticket]);expect(p.head).toEqual({revision:1,teamRevision:0});expect((await f.tickets.head(f.context())).revision).toBe(1);
    expect(f.snapshot()).toEqual(f.before);for(const key of ['subject','body','mailboxId','folderId','messageSha256','context_json'])expect(JSON.stringify(p)).not.toContain('"'+key+'"');
  });
  it('replays exact requests and deduplicates new aliases without repeating ticket audit',async()=>{
    const f=await fixture(),r=await create(f);expect((await commit(f,r.q)).replayed).toBe(true);const alias=await commit(f,f.ticketRequest(r.job.job.id));expect(alias.ticket).toEqual(r.ticket);expect(alias.replayed).toBe(true);
    expect(count(f,'international_us_support_tickets')).toBe(1);expect(count(f,'international_us_support_ticket_audit')).toBe(2);expect((await f.tickets.head(f.context())).revision).toBe(2);
    await expect(commit(f,{schemaVersion:1,requestId:r.q.requestId,action:'create',jobId:randomUUID()})).rejects.toMatchObject({code:'ticket_idempotency_conflict',status:409});
  });
  it('preserves original decision and review reasons through a human correction',async()=>{
    const f=await fixture(),r=await create(f),q=change(f,r.ticket.id,1,{action:'correct',category:'other',priority:'urgent',language:'fr'}),next=await commit(f,q);
    expect(next.ticket).toMatchObject({revision:2,category:'other',priority:'urgent',language:'fr',humanCorrection:true,correctedBy:f.actor});expect(next.ticket.originalDecision).toEqual(r.ticket.originalDecision);expect(next.ticket.reviewReasons).toEqual(r.ticket.reviewReasons);
    expect((await commit(f,r.q)).ticket).toEqual(next.ticket);expect(next.ticket.audit.events.map(e=>e.action)).toEqual(['correct','create']);
  });
  it('enforces ticket CAS and independent routing CAS',async()=>{
    const f=await fixture(),r=await create(f);await commit(f,change(f,r.ticket.id,1,{action:'set_status',status:'resolved'}));await expect(commit(f,change(f,r.ticket.id,1,{action:'set_status',status:'open'}))).rejects.toMatchObject({code:'ticket_revision_conflict',status:409});
    const q=f.routingRequest(),saved=await f.tickets.saveRouting(f.context(),q,async()=>f.context());expect(saved.routing.revision).toBe(1);await expect(f.tickets.saveRouting(f.context(),f.routingRequest(),async()=>f.context())).rejects.toMatchObject({code:'ticket_revision_conflict'});expect((await f.tickets.saveRouting(f.context(),q,async()=>f.context())).replayed).toBe(true);
  });
  it('assigns on explicit creation only when current routing and every confidence permit',async()=>{
    const f=await fixture(),target=await member(f,'member'),q=f.routingRequest({enabled:true,threshold:0.9,routes:[{category:'billing',membershipId:target.membershipId}]});await f.tickets.saveRouting(f.context(),q,async()=>f.context());
    const r=await create(f);expect(r.ticket).toMatchObject({assigneeMembershipId:target.membershipId,assigneeActive:true});
    const next=await commit(f,change(f,r.ticket.id,1,{action:'assign',assigneeMembershipId:null}));expect(next.ticket.assigneeMembershipId).toBeNull();expect((await commit(f,f.ticketRequest(r.job.job.id))).ticket.assigneeMembershipId).toBeNull();
    const job=await f.completeJob({request:{uid:'124'},source:{attachmentCount:1},decision:{reviewReasons:['unread_attachments'],needsReview:true}});expect((await commit(f,f.ticketRequest(job.job.id))).ticket.assigneeMembershipId).toBeNull();
  });
  it('lets only the assigned member change status while other roles read only',async()=>{
    const f=await fixture(),assigned=await member(f,'member'),other=await member(f,'member'),accountant=await member(f,'accountant'),readonly=await member(f,'read_only'),r=await create(f);
    const assignedTicket=await commit(f,change(f,r.ticket.id,1,{action:'assign',assigneeMembershipId:assigned.membershipId}));
    const result=await commit(f,change(f,r.ticket.id,2,{action:'set_status',status:'in_progress'}),assigned.userId);expect(result.ticket.revision).toBe(3);
    for(const u of [other,accountant,readonly]){expect((await f.tickets.read(f.context(u.userId))).tickets[0].id).toBe(r.ticket.id);await expect(commit(f,change(f,r.ticket.id,3,{action:'set_status',status:'resolved'}),u.userId)).rejects.toMatchObject({status:403});}
    await expect(commit(f,change(f,r.ticket.id,3,{action:'correct',category:'bug',priority:'normal',language:'en'}),assigned.userId)).rejects.toMatchObject({status:403});
    expect(assignedTicket.ticket.assigneeActive).toBe(true);
  });
  it('refuses incomplete jobs and unavailable target roles',async()=>{
    const f=await fixture();await expect(commit(f,f.ticketRequest(randomUUID()))).rejects.toMatchObject({code:'ticket_source_not_completed',status:409});const r=await create(f),readonly=await member(f,'read_only');
    await expect(commit(f,change(f,r.ticket.id,1,{action:'assign',assigneeMembershipId:readonly.membershipId}))).rejects.toMatchObject({code:'ticket_assignee_unavailable'});
  });
  it('keeps receipts readable after mailbox disconnect and closes without0097',async()=>{
    const f=await fixture(),r=await create(f);await f.mailbox.commit(f.context(),{schemaVersion:1,requestId:randomUUID(),expectedRevision:1,action:'disconnect'},async()=>f.context());expect((await commit(f,r.q)).ticket.id).toBe(r.ticket.id);expect((await f.tickets.read(f.context())).tickets).toHaveLength(1);
    const missing=await fixture(false);await expect(missing.tickets.head(missing.context())).rejects.toMatchObject({code:'service_unavailable',status:503});
  });
  it('shares actor idempotency namespace across ticket and routing requests',async()=>{
    const f=await fixture(),r=await create(f),q=f.routingRequest({requestId:r.q.requestId});await expect(f.tickets.saveRouting(f.context(),q,async()=>f.context())).rejects.toMatchObject({code:'ticket_idempotency_conflict'});
    const hash=await hashUsSupportTicketRequest(f.intent.organizationId,f.context().workspaceId,f.actor,r.q),saved=await f.tickets.find(f.context(),r.q.requestId,hash);expect(saved!.kind).toBe('ticket');expect(await hashUsSupportRoutingRequest(f.intent.organizationId,f.context().workspaceId,f.actor,q)).not.toBe(hash);
  });
  it('has only actual SQL migration segments',async()=>{const f=await fixture();expect(f.sql.prepare("SELECT count(*)AS n FROM sqlite_master WHERE name LIKE 'international_us_support_ticket_%'").get()!.n).toBeGreaterThan(10);});
  it('retains historical revoked assignment and observes the real team revision',async()=>{
    const f=await fixture(),target=await member(f,'member');await f.tickets.saveRouting(f.context(),f.routingRequest({enabled:true,routes:[{category:'billing',membershipId:target.membershipId}]}),async()=>f.context());const r=await create(f),before=await f.tickets.head(f.context());await revoke(f,target.membershipId);
    const p=await f.tickets.read(f.context());expect(p.tickets[0]).toMatchObject({assigneeMembershipId:target.membershipId,assigneeActive:false});expect(p.tickets[0].audit).toEqual(r.ticket.audit);expect(p.assignees.some(a=>a.membershipId===target.membershipId)).toBe(false);expect(p.head.teamRevision).toBe(before.teamRevision+1);expect(p.head.revision).toBe(before.revision);
    const later=await create(f,'124');expect(later.ticket.assigneeMembershipId).toBeNull();await expect(commit(f,change(f,r.ticket.id,1,{action:'set_status',status:'resolved'}),target.userId)).rejects.toMatchObject({status:403});
  });
  it('keeps request receipts actor-scoped for a real invited administrator',async()=>{
    const f=await fixture(),admin=await member(f,'admin'),r=await create(f),hash=await hashUsSupportTicketRequest(f.intent.organizationId,f.context().workspaceId,f.actor,r.q);expect(await f.tickets.find(f.context(admin.userId),r.q.requestId,hash)).toBeNull();
    const alias=await commit(f,r.q,admin.userId);expect(alias.ticket).toEqual(r.ticket);expect(alias.receipt.actorUserId).toBe(admin.userId);
  });
  it('serializes concurrent exact creation and competing CAS status writes',async()=>{
    const f=await fixture(),job=await f.completeJob(),q=f.ticketRequest(job.job.id),results=await Promise.all(Array.from({length:6},()=>commit(f,q)));expect(new Set(results.map(r=>r.ticket.id)).size).toBe(1);expect(count(f,'international_us_support_ticket_commands')).toBe(1);
    const id=results[0].ticket.id,changed=await Promise.allSettled(['resolved','in_progress'].map(status=>commit(f,change(f,id,1,{action:'set_status',status}))));expect(changed.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(changed.find(r=>r.status==='rejected')).toMatchObject({reason:{code:'ticket_revision_conflict',status:409}});expect((await f.tickets.read(f.context())).tickets[0].audit.total).toBe(2);
  });
  it.each(['create','correct','save_routing'] as const)('recovers committed %s with a lost acknowledgement',async phase=>{
    const f=await fixture();let lost=true;const store=d1UsSupportTicketStore(intercept(f,async statements=>{const r=await f.database.batch(statements);if(lost){lost=false;throw Error('lost acknowledgement');}return r;}),{now:f.now});
    if(phase==='save_routing'){const q=f.routingRequest();expect((await store.saveRouting(f.context(),q,async()=>f.context())).replayed).toBe(true);expect(count(f,'international_us_support_ticket_routing')).toBe(1);}
    else{const job=await f.completeJob(),q=f.ticketRequest(job.job.id),r=await(phase==='create'?store:f.tickets).commit(f.context(),q,async()=>f.context());if(phase==='correct')await store.commit(f.context(),change(f,r.ticket.id,1,{action:'correct',category:'bug',priority:'normal',language:'fr'}),async()=>f.context());expect(count(f,'international_us_support_tickets')).toBe(1);expect((await f.tickets.read(f.context())).tickets[0].revision).toBe(phase==='correct'?2:1);}
  });
  it('rolls back effects when the correlated audit is omitted from a partial batch',async()=>{
    const f=await fixture(),job=await f.completeJob(),store=d1UsSupportTicketStore(intercept(f,statements=>f.database.batch(statements.slice(0,-1))),{now:f.now});await expect(store.commit(f.context(),f.ticketRequest(job.job.id),async()=>f.context())).rejects.toMatchObject({status:503});expect(count(f,'international_us_support_tickets')).toBe(0);expect(count(f,'international_us_support_ticket_commands')).toBe(0);expect((await f.tickets.head(f.context())).revision).toBe(0);
  });
  it('corroborates current H1 inside SQL when authority is revoked after preflight',async()=>{
    const f=await fixture(),job=await f.completeJob(),store=d1UsSupportTicketStore(intercept(f,statements=>{f.sql.prepare('UPDATE international_saas_authorities SET revoked_at=? WHERE organization_id=?').run(f.now(),f.intent.organizationId);return f.database.batch(statements);}),{now:f.now});await expect(store.commit(f.context(),f.ticketRequest(job.job.id),async()=>f.context())).rejects.toMatchObject({status:402});expect(count(f,'international_us_support_tickets')).toBe(0);
  });
  it('requires real native4 sessions and rejects current native revocation',async()=>{
    const f=await fixture(),old=await native(f,3);await expect(f.tickets.head(f.context(f.actor,old))).rejects.toMatchObject({code:'client_upgrade_required',status:409});const credential=await native(f,4),c=()=>f.context(f.actor,credential);expect((await f.tickets.head(c())).revision).toBe(0);
    const job=await f.completeJob(),store=d1UsSupportTicketStore(intercept(f,statements=>{f.sql.prepare('UPDATE international_us_device_v4_sessions SET revoked_at=? WHERE session_id=?').run(f.now(),credential.sessionId);return f.database.batch(statements);}),{now:f.now});await expect(store.commit(c(),f.ticketRequest(job.job.id),async()=>c())).rejects.toMatchObject({status:401});expect(count(f,'international_us_support_tickets')).toBe(0);
  });
  it('bounds visible audit to20, refuses the101st mutation, and still replays aliases',async()=>{
    const f=await fixture(),r=await create(f);for(let revision=1;revision<100;revision++)await commit(f,change(f,r.ticket.id,revision,{action:'set_status',status:revision%2?'resolved':'open'}));const current=(await f.tickets.read(f.context())).tickets[0];expect(current.audit.total).toBe(100);expect(current.audit.events).toHaveLength(20);expect(current.audit.events.map(e=>e.ticketRevision)).toEqual(Array.from({length:20},(_,i)=>100-i));
    await expect(commit(f,change(f,r.ticket.id,100,{action:'set_status',status:'in_progress'}))).rejects.toMatchObject({code:'ticket_audit_capacity_exceeded',status:409});expect((await commit(f,f.ticketRequest(r.job.job.id))).ticket).toEqual(current);expect(count(f,'international_us_support_ticket_revisions')).toBe(100);
  });
  it('enforces the global command pilot cap using an explicit count shim',async()=>{
    const f=await fixture(),r=await create(f),trigger=f.sql.prepare("SELECT sql FROM sqlite_master WHERE name='international_us_support_ticket_command_insert'").get()!.sql as string,needle='(SELECT count(*)FROM international_us_support_ticket_commands WHERE organization_id=NEW.organization_id)';expect(trigger).toContain(needle+'>='+US_SUPPORT_TICKET_COMMAND_LIMIT);f.sql.exec('CREATE TABLE test_ticket_command_count(n INTEGER NOT NULL)');f.sql.prepare('INSERT INTO test_ticket_command_count VALUES(?)').run(US_SUPPORT_TICKET_COMMAND_LIMIT);f.sql.exec('DROP TRIGGER international_us_support_ticket_command_insert');f.sql.exec(trigger.replace(needle,'(SELECT n FROM test_ticket_command_count)'));
    await expect(commit(f,f.ticketRequest(r.job.job.id))).rejects.toMatchObject({code:'ticket_command_capacity_exceeded',status:409});expect(count(f,'international_us_support_ticket_commands')).toBe(1);expect((await commit(f,r.q)).ticket).toEqual(r.ticket);
  });
  it('reads deterministic25-item pages with newly created tickets first',async()=>{
    const f=await fixture(),ids:string[]=[];for(let i=0;i<26;i++){f.setNow(f.now()+1);const job=await f.completeJob({request:{uid:String(1000+i)},grant:{...f.grant(),limit:100}});ids.push((await commit(f,f.ticketRequest(job.job.id))).ticket.id);}const first=await f.tickets.read(f.context()),last=await f.tickets.read(f.context(),25);expect(first.tickets.map(t=>t.id)).toEqual(ids.slice(1).reverse());expect(first.nextOffset).toBe(25);expect(last.tickets.map(t=>t.id)).toEqual([ids[0]]);expect(last.nextOffset).toBeNull();
    await expect(f.tickets.read(f.context(),-1)).rejects.toMatchObject({status:422});
  });
  it('rejects SQL rewrites and REPLACE on every immutable identity including the head',async()=>{
    const f=await fixture();await create(f);await f.tickets.saveRouting(f.context(),f.routingRequest(),async()=>f.context());
    for(const table of ['international_us_support_tickets',...['commands','revisions','routing','audit'].map(n=>'international_us_support_ticket_'+n)]){expect(()=>f.sql.exec('DELETE FROM '+table)).toThrow(/us_ticket_immutable/);const saved=f.sql.prepare('SELECT * FROM '+table).get()! as Record<string,SQLInputValue>;expect(()=>f.sql.exec('UPDATE '+table+' SET organization_id=organization_id')).toThrow(/us_ticket_immutable/);expect(()=>rawInsert(f,table,saved,true)).toThrow();}
    const head=f.sql.prepare('SELECT * FROM international_us_support_ticket_heads').get()! as Record<string,SQLInputValue>;expect(()=>rawInsert(f,'international_us_support_ticket_heads',head,true)).toThrow();expect(()=>f.sql.exec('DELETE FROM international_us_support_ticket_heads')).toThrow();expect(()=>f.sql.exec('UPDATE international_us_support_ticket_heads SET revision=revision+1')).toThrow();
  });
  it('SQL rejects unknown action fields, NULL routing version and stale authority facts',async()=>{
    const f=await fixture(),r=await create(f),job=await f.completeJob({request:{uid:'124'}}),saved=f.sql.prepare('SELECT * FROM international_us_support_ticket_commands').get()! as Record<string,SQLInputValue>;
    const pending=()=>{const q=f.ticketRequest(job.job.id);return {...saved,command_id:randomUUID(),request_id:q.requestId,revision:2,entity_id:randomUUID(),job_id:job.job.id,source_hash:job.job.sourceHash,request_json:canonicalErpJson(q)};};
    const check=(values:Record<string,SQLInputValue>,pattern:RegExp)=>{f.sql.exec('BEGIN');try{expect(()=>rawInsert(f,'international_us_support_ticket_commands',values)).toThrow(pattern);}finally{f.sql.exec('ROLLBACK');}};
    check({...pending(),routing_revision:null},/us_ticket_invalid_record/);const wrong=pending(),q=JSON.parse(wrong.request_json as string);check({...wrong,request_json:canonicalErpJson({schemaVersion:1,requestId:q.requestId,action:'create',ticketId:job.job.id})},/us_ticket_invalid_record/);
    const c=f.context();check({...pending(),context_json:canonicalErpJson({...c,authority:{...c.authority,seatLimit:99}})},/us_ticket_subscription_required/);check({...pending(),created_at:f.now()+1,context_json:canonicalErpJson({...c,authority:{...c.authority,checkedAt:f.now()+1}})},/us_ticket_subscription_required/);expect(count(f,'international_us_support_tickets')).toBe(1);expect(r.ticket.revision).toBe(1);
  });
});
