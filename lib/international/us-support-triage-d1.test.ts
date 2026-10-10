import { createHash,randomBytes,randomUUID } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';
import { afterEach,describe,expect,it } from 'vitest';
import { canonicalErpJson } from './erp-contract';
import { d1UsSupportTriageStore } from './us-support-triage-d1';
import { supportTriageFixture } from './us-support-triage-test-fixture';
import { US_SUPPORT_TRIAGE_MAX_SOURCES,US_SUPPORT_TRIAGE_MAX_REQUESTS,type UsSupportTriageRequest,type UsSupportTriageSource,type UsSupportTriageStore } from './us-support-triage-contract';
import type { UsMailboxContext } from './us-support-mailbox-contract';
import { d1UsTeamStore } from './us-team-store';
import { hashUsTeamCommand,hashUsTeamToken,newUsTeamToken } from './us-team-validation';
import type { UsTeamContext,UsTeamPrivateCommand } from './us-team-contract';
import { d1UsDeviceStore } from './us-device-d1';
import { createOrResumeUsWorkspace } from './workspace-creation';
import { d1WorkspaceCreationStore } from './workspace-creation-d1';
import { d1UsTestPurchaseStore } from './us-saas-test-d1';
import { prepareUsAuthorityAdmission } from './saas-authority';
import { validateUsTestPurchase,verifiedUsTestSession,verifiedUsTestPaidProof } from './us-saas-test-contract';
import { mailboxImportAuthority } from './us-support-mailbox-import-test-fixture';
import { d1UsSupportWorkspaceStore } from './us-support-workspace-d1';
import { d1UsMailboxStore } from './us-support-mailbox-d1';
import { createUsSupportTriageGrant } from './us-support-triage-policy';

type Fixture=Awaited<ReturnType<typeof supportTriageFixture>>;
const opened:Fixture[]=[];
async function fixture(includeTriage=true){const f=await supportTriageFixture(includeTriage);opened.push(f);return f;}
afterEach(()=>{for(const f of opened.splice(0)){expect(f.sql.prepare('PRAGMA foreign_key_check').all()).toEqual([]);f.sql.close();}});
const count=(f:Fixture,suffix='jobs')=>Number(f.sql.prepare('SELECT count(*) AS n FROM international_us_support_triage_'+suffix).get()!.n);
const claim=async(f:Fixture,q:UsSupportTriageRequest=f.request(),source:UsSupportTriageSource=f.source({uid:q.uid,messageVersion:q.expectedMessageVersion}),userId=f.actor,store:UsSupportTriageStore=f.triage)=>store.claim(f.context(userId),{request:q,source,grant:f.grant(userId)},async()=>f.context(userId));
const reference=(r:Awaited<ReturnType<typeof claim>>,dispatchId=randomUUID())=>({requestId:r.requestId,requestHash:r.requestHash,dispatchId});
const intercept=(f:Fixture,batch:(statements:D1PreparedStatement[])=>Promise<D1Result[]>)=>({prepare:f.database.prepare.bind(f.database),batch}) as Pick<D1Database,'prepare'|'batch'>;
function team(c:UsMailboxContext):UsTeamContext{const a=c.authority;return {schemaVersion:1,organizationId:a.organizationId,mode:'member',role:a.role,user:{userId:a.userId,email:null,emailConfirmed:false},subscriptionId:a.subscriptionId,environment:a.environment,catalogVersion:a.catalogVersion,priceId:a.priceId,seatLimit:a.seatLimit,checkedAt:a.checkedAt,validStartsAt:a.validStartsAt,validEndsAt:a.validEndsAt,credential:a.credential};}
async function member(f:Fixture,role:'admin'|'member'|'read_only'){
  const userId=randomUUID(),email=userId+'@example.test',store=d1UsTeamStore(f.database,{now:f.now}),owner=team(f.context()),invitationId=randomUUID(),tokenHash=await hashUsTeamToken(newUsTeamToken());
  const invitation:UsTeamPrivateCommand={schemaVersion:1,requestId:randomUUID(),expectedTeamRevision:await store.revision(owner),action:'create_invitation',email,role,invitationId,tokenHash,expiresAt:f.now()+604800};
  await store.commit({context:owner,command:invitation,requestHash:await hashUsTeamCommand(owner.organizationId,f.actor,invitation)});
  const accept:UsTeamPrivateCommand={schemaVersion:1,requestId:randomUUID(),expectedTeamRevision:await store.revision(owner),action:'accept_invitation',invitationId,tokenHash,membershipId:randomUUID(),firstName:'Support',lastName:'TEST',displayName:'Support TEST'};
  await store.commit({context:{...owner,mode:'recipient',role,user:{userId,email,emailConfirmed:true}},command:accept,requestHash:await hashUsTeamCommand(owner.organizationId,userId,accept)});return userId;
}
async function native(f:Fixture,schema:1|2|3|4){
  const store=d1UsDeviceStore(f.database),sessionId='usd_'+randomUUID(),codeHash=randomBytes(32).toString('base64url'),tokenHash=randomBytes(32).toString('base64url'),userCode='ABCD-EFG'+schema;
  await store.start({codeHash,tokenHash,installationId:randomUUID(),userCode,schema,now:f.now()});
  await store.approve(userCode,{organizationId:f.intent.organizationId,organizationName:'US TEST',userId:f.actor,role:'owner',subscriptionId:f.authority.subscriptionId,entitlementValidUntil:f.authority.evidence!.endsAt,configurationStamp:'synthetic TEST'},f.now());
  await store.consume((await store.challenge('code',codeHash))!,sessionId,f.now());return {store,credential:{kind:'device' as const,sessionId,supportedSchemaVersion:schema}};
}
function rawInsert(f:Fixture,table:string,values:Record<string,SQLInputValue>,replace=false){const keys=Object.keys(values);return f.sql.prepare(`INSERT ${replace?'OR REPLACE ':''}INTO international_us_support_triage_${table}(${keys.join(',')})VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(values));}
async function secondCompany(f:Fixture){
  const stamp=new Date(f.now()*1000).toISOString(),{organizationId:_org,...configuration}=f.intent.configuration;
  const initial=await createOrResumeUsWorkspace(f.actor,{requestId:randomUUID(),confirmationVersion:1,companyName:'Second triage TEST',configuration},{store:d1WorkspaceCreationStore(f.database),allocateId:()=>randomUUID(),now:()=>stamp,fingerprint:async text=>createHash('sha256').update(text).digest('hex'),admit:async i=>({creationId:i.creationId,organizationId:i.organizationId,actorUserId:f.actor,requestId:i.requestId,configurationFingerprint:i.fingerprint,configuration:i.configuration,revision:1,updatedBy:f.actor,updatedAt:stamp,replayed:false}),revalidate:async()=>{}});
  const subscriptionId='sub_'+initial.organizationId.replaceAll('-',''),invoiceId='in_'+initial.organizationId.replaceAll('-','');
  const authority={...f.authority,organizationId:initial.organizationId,subscriptionId,evidence:{...f.authority.evidence!,organizationId:initial.organizationId,subscriptionId,referenceId:invoiceId}};
  const purchases=d1UsTestPurchaseStore(f.database),purchase=await purchases.reserve(initial,validateUsTestPurchase({...f.purchase,purchaseId:randomUUID(),creationId:initial.creationId,organizationId:initial.organizationId,requestId:initial.requestId,configurationFingerprint:initial.fingerprint,receipt:initial.receipt!,createdAt:f.now(),expiresAt:f.now()+3600},initial),async()=>{});
  const session=await purchases.bind(purchase,verifiedUsTestSession(purchase,{purchaseId:purchase.purchaseId,sessionId:'cs_test_'+purchase.purchaseId.replaceAll('-',''),customerId:null,subscriptionId:null,createdAt:f.now(),expiresAt:purchase.expiresAt}),async()=>{});
  const proof=verifiedUsTestPaidProof(purchase,{purchaseId:purchase.purchaseId,sessionId:session.sessionId,customerId:'cus_SecondTriage',subscriptionId,invoiceId,eventId:'evt_SecondTriage',providerAccountId:purchase.providerAccountId,authority,serverPrice:f.price,verifiedAt:f.now()});
  await purchases.admit(initial,purchase,session,proof,prepareUsAuthorityAdmission(initial,{authority,seatLimit:8},{...f.saasPolicy,now:f.now()},f.price),async()=>{});
  const a=()=>mailboxImportAuthority({...f,policy:f.saasPolicy},initial.organizationId),registry=await d1UsSupportWorkspaceStore(f.database,{now:f.now}).create(a(),{schemaVersion:1,requestId:randomUUID(),name:'Second Support'},async()=>a());
  const context=():UsMailboxContext=>({schemaVersion:1,authority:a(),workspaceId:registry.workspace.workspaceId}),connection={...f.connection,connectionId:randomUUID(),requestId:randomUUID(),expectedRevision:0,verifiedAt:f.now()};
  await d1UsMailboxStore(f.database,{now:f.now}).commit(context(),connection,async()=>context());return {context,connection};
}
describe('US Support triage on real0000..0096 SQLite; synthetic Auth/provider boundary',()=>{
  it('reserves one immutable source and preserves CH and existing SaaS data',async()=>{
    const f=await fixture(),r=await claim(f);expect(r).toMatchObject({replayed:false,job:{state:'reserved',actorUserId:f.actor,dispatchId:null,result:null}});
    expect(await f.triage.usage(f.context(),f.grant())).toEqual({limit:10,used:1,remaining:9});expect(f.snapshot()).toEqual(f.before);expect(f.sql.prepare('SELECT * FROM support_workspaces').all()).toEqual(f.legacyBefore);
    for(const table of ['support_connections','support_mailboxes','support_members','support_tickets'])expect(f.sql.prepare('SELECT count(*) AS n FROM '+table).get()!.n).toBe(0);
    const retained=JSON.stringify(f.sql.prepare('SELECT * FROM international_us_support_triage_jobs').get());for(const secret of ['mailbox@example.test',f.connection.credentialsCiphertext,f.connection.tokenSha256])expect(retained).not.toContain(secret);
  });
  it('replays exact reservation and completion under the first job identity',async()=>{
    const f=await fixture(),q=f.request(),r=await claim(f,q);f.setNow(f.now()+31);expect(await claim(f,q)).toEqual({...r,replayed:true});
    const ref=reference(r),d=await f.triage.dispatch(f.context(),ref,async()=>f.context());expect(d.mayDispatch).toBe(true);expect(d.result.job.state).toBe('dispatched');
    const done=await f.triage.complete(f.context(),{...ref,decision:f.decision()},async()=>f.context());expect(done.job).toMatchObject({state:'completed',dispatchId:ref.dispatchId,result:f.decision()});
    expect(await f.triage.complete(f.context(),{...ref,decision:f.decision()},async()=>f.context())).toEqual({...done,replayed:true});expect(count(f)).toBe(1);expect(count(f,'dispatches')).toBe(1);expect(count(f,'completions')).toBe(1);
  });
  it.each(['expectedMessageVersion','expectedMailboxRevision','connectionId','processingPolicyVersion'] as const)('rejects changed exact request field %s',async key=>{
    const f=await fixture(),q=f.request(),r=await claim(f,q),changed={...q,[key]:key==='expectedMailboxRevision'?2:key==='connectionId'?randomUUID():'different'};
    await expect(claim(f,changed)).rejects.toMatchObject({code:'triage_idempotency_conflict',status:409});expect((await f.triage.find(f.context(),q.requestId,r.requestHash))!.job.id).toBe(r.job.id);
  });
  it.each(['messageVersion','messageSha256','receivedAt','attachmentCount','bodyComplete'] as const)('rejects changed immutable observed source fact %s',async key=>{
    const f=await fixture();await claim(f);const source=f.source({[key]:key==='receivedAt'?f.now()-99:key==='attachmentCount'?1:key==='bodyComplete'?false:key==='messageSha256'?'d'.repeat(64):'changed'});
    await expect(claim(f,f.request({expectedMessageVersion:source.messageVersion}),source)).rejects.toMatchObject({code:'triage_source_conflict',status:409});expect(count(f)).toBe(1);expect(count(f,'requests')).toBe(1);
  });
  it('deduplicates across real owner/admin actors but keeps exact actor receipts',async()=>{
    const f=await fixture(),admin=await member(f,'admin'),q=f.request(),one=await claim(f,q);expect(await f.triage.find(f.context(admin),q.requestId,one.requestHash)).toBeNull();
    const two=await claim(f,q,undefined,admin);expect(two.job).toEqual(one.job);expect(two.requestHash).not.toBe(one.requestHash);expect(count(f)).toBe(1);expect(count(f,'requests')).toBe(2);
    await expect(f.triage.find(f.context(admin),q.requestId,one.requestHash)).rejects.toMatchObject({code:'triage_idempotency_conflict'});
  });
  it('deduplicates reconnects and uses no new quota for a completed source',async()=>{
    const f=await fixture(),one=await claim(f),ref=reference(one);await f.triage.dispatch(f.context(),ref,async()=>f.context());await f.triage.complete(f.context(),{...ref,decision:f.decision()},async()=>f.context());
    const connectionId=randomUUID();await f.mailbox.commit(f.context(),{...f.connection,requestId:randomUUID(),expectedRevision:1,connectionId,verifiedAt:f.now()},async()=>f.context());
    const next=await claim(f,f.request({connectionId,expectedMailboxRevision:2}));expect(next.job.id).toBe(one.job.id);expect(next.job.state).toBe('completed');expect(next.replayed).toBe(true);expect((await f.triage.usage(f.context(),f.grant())).used).toBe(1);
  });
  it('reserves at most current quota across concurrent distinct sources and persists losers nowhere',async()=>{
    const f=await fixture(),grant={...f.grant(),limit:2},results=await Promise.allSettled(Array.from({length:8},(_,i)=>{const q=f.request({uid:String(100+i)});return f.triage.claim(f.context(),{request:q,source:f.source({uid:q.uid}),grant},async()=>f.context());}));
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(2);for(const r of results)if(r.status==='rejected')expect(r.reason).toMatchObject({code:'triage_quota_exceeded',status:409});expect(count(f)).toBe(2);expect(count(f,'requests')).toBe(2);
  });
  it('concurrent exact retry reserves once and emits one unique dispatch permission',async()=>{
    const f=await fixture(),q=f.request(),results=await Promise.all(Array.from({length:8},()=>claim(f,q)));expect(new Set(results.map(r=>r.job.id)).size).toBe(1);expect(count(f)).toBe(1);expect(count(f,'requests')).toBe(1);
    const dispatched=await Promise.all(results.map(r=>f.triage.dispatch(f.context(),reference(r),async()=>f.context())));expect(dispatched.filter(r=>r.mayDispatch)).toHaveLength(1);expect(count(f,'dispatches')).toBe(1);
    const saved=await f.triage.find(f.context(),q.requestId,results[0].requestHash);expect(saved!.job.state).toBe('uncertain');expect(count(f,'uncertain')).toBe(0);
  });
  it('never redispatches uncertain work and does not refund reserved or uncertain units',async()=>{
    const f=await fixture(),r=await claim(f),ref=reference(r);await f.triage.dispatch(f.context(),ref,async()=>f.context());await f.triage.uncertain(f.context(),ref,async()=>f.context());
    expect((await f.triage.dispatch(f.context(),reference(r),async()=>f.context())).mayDispatch).toBe(false);expect(count(f,'dispatches')).toBe(1);expect(count(f,'uncertain')).toBe(1);
    const usage=await f.triage.usage(f.context(),{...f.grant(),limit:1});expect(usage).toEqual({limit:1,used:1,remaining:0});
  });
  it.each(['claim','dispatch','complete'] as const)('recovers committed %s with lost acknowledgement without permission to emit twice',async phase=>{
    const f=await fixture(),q=f.request();let first=true;const store=d1UsSupportTriageStore(intercept(f,async statements=>{const r=await f.database.batch(statements);if(first){first=false;throw Error('lost acknowledgement');}return r;}),{now:f.now});
    const r=await claim(f,q,undefined,f.actor,phase==='claim'?store:f.triage),ref=reference(r);
    const dispatch=await (phase==='dispatch'?store:f.triage).dispatch(f.context(),ref,async()=>f.context());expect(dispatch.mayDispatch).toBe(phase!=='dispatch');
    const done=await (phase==='complete'?store:f.triage).complete(f.context(),{...ref,decision:f.decision()},async()=>f.context());expect(done.job.state).toBe('completed');expect(count(f)).toBe(1);expect(count(f,'dispatches')).toBe(1);expect(count(f,'completions')).toBe(1);
  });
  it('replays and completes historical dispatch after disconnect while new claims close',async()=>{
    const f=await fixture(),q=f.request(),r=await claim(f,q),ref=reference(r);await f.triage.dispatch(f.context(),ref,async()=>f.context());
    await f.mailbox.commit(f.context(),{schemaVersion:1,requestId:randomUUID(),expectedRevision:1,action:'disconnect'},async()=>f.context());
    const done=await f.triage.complete(f.context(),{...ref,decision:f.decision()},async()=>f.context());expect((await f.triage.find(f.context(),q.requestId,r.requestHash))!.job).toEqual(done.job);expect((await claim(f,q)).replayed).toBe(true);
    await expect(claim(f,f.request({uid:'124'}))).rejects.toMatchObject({code:'triage_connection_changed',status:409});
  });
  it('rejects altered completion and wrong original dispatch',async()=>{
    const f=await fixture(),r=await claim(f),ref=reference(r);await f.triage.dispatch(f.context(),ref,async()=>f.context());await f.triage.complete(f.context(),{...ref,decision:f.decision()},async()=>f.context());
    await expect(f.triage.complete(f.context(),{...ref,decision:f.decision({priority:'high'})},async()=>f.context())).rejects.toMatchObject({code:'triage_idempotency_conflict'});
    await expect(f.triage.complete(f.context(),{...ref,dispatchId:randomUUID(),decision:f.decision()},async()=>f.context())).rejects.toMatchObject({code:'triage_idempotency_conflict'});
  });
  it('revocation during atomic claim rolls back SQL despite preflight admission',async()=>{
    const f=await fixture(),store=d1UsSupportTriageStore(intercept(f,async statements=>{f.sql.prepare('UPDATE international_saas_authorities SET revoked_at=? WHERE organization_id=?').run(f.now(),f.intent.organizationId);return f.database.batch(statements);}),{now:f.now});
    await expect(claim(f,undefined,undefined,f.actor,store)).rejects.toMatchObject({status:402});expect(count(f)).toBe(0);expect(count(f,'requests')).toBe(0);
  });
  it('fresh rights remain mandatory for historical reads and results',async()=>{
    const f=await fixture(),r=await claim(f);f.sql.prepare('UPDATE international_saas_authorities SET revoked_at=? WHERE organization_id=?').run(f.now(),f.intent.organizationId);
    await expect(f.triage.find(f.context(),r.requestId,r.requestHash)).rejects.toMatchObject({status:402});
  });
  it('denies member/read-only roles before source data and enforces native schema4 sessions',async()=>{
    const f=await fixture(),ordinary=await member(f,'member');await expect(claim(f,undefined,undefined,ordinary)).rejects.toMatchObject({status:403});
    const old=await native(f,3);await expect(f.triage.usage(f.context(f.actor,old.credential),f.grant())).rejects.toMatchObject({code:'client_upgrade_required',status:409});
    const n=await native(f,4),c=()=>f.context(f.actor,n.credential),q=f.request(),r=await f.triage.claim(c(),{request:q,source:f.source(),grant:f.grant()},async()=>c());
    expect(r.job.state).toBe('reserved');f.sql.prepare('UPDATE international_us_device_v4_sessions SET revoked_at=? WHERE session_id=?').run(f.now(),n.credential.sessionId);
    await expect(f.triage.find(c(),r.requestId,r.requestHash)).rejects.toMatchObject({status:401});
  });
  it('keeps sources/quota/results isolated for two US companies of one owner',async()=>{
    const f=await fixture(),one=await claim(f),other=await secondCompany(f),q={...f.request(),connectionId:other.connection.connectionId},grant=createUsSupportTriageGrant(other.context(),f.policy);
    const two=await f.triage.claim(other.context(),{request:q,source:f.source(),grant},async()=>other.context());expect(two.job.id).not.toBe(one.job.id);expect(two.job.sourceHash).not.toBe(one.job.sourceHash);
    expect(await f.triage.find(other.context(),one.requestId,one.requestHash)).toBeNull();expect((await f.triage.usage(other.context(),grant)).used).toBe(1);expect((await f.triage.usage(f.context(),f.grant())).used).toBe(1);
  });
  it('SQL rejects forged result flags and append-only rewrites including REPLACE',async()=>{
    const f=await fixture(),r=await claim(f),ref=reference(r);await f.triage.dispatch(f.context(),ref,async()=>f.context());const dispatch=f.sql.prepare('SELECT * FROM international_us_support_triage_dispatches').get()!;
    const forged={...f.decision(),reviewReasons:['unread_attachments'],needsReview:true};
    expect(()=>rawInsert(f,'completions',{...dispatch,decision_json:canonicalErpJson(forged),result_sha256:'a'.repeat(64)} as Record<string,SQLInputValue>)).toThrow(/us_triage_invalid_record/);
    await f.triage.complete(f.context(),{...ref,decision:f.decision()},async()=>f.context());
    for(const table of ['jobs','requests','dispatches','completions']){
      expect(()=>f.sql.exec('UPDATE international_us_support_triage_'+table+' SET created_at=created_at')).toThrow(/us_triage_immutable/);
      expect(()=>f.sql.exec('DELETE FROM international_us_support_triage_'+table)).toThrow(/us_triage_immutable/);
      const saved=f.sql.prepare('SELECT * FROM international_us_support_triage_'+table).get()!;expect(()=>rawInsert(f,table,saved as Record<string,SQLInputValue>,true)).toThrow();
    }
  });
  it('fresh native revocation during dispatch is corroborated inside SQL',async()=>{
    const f=await fixture(),n=await native(f,4),c=()=>f.context(f.actor,n.credential),q=f.request(),r=await f.triage.claim(c(),{request:q,source:f.source(),grant:f.grant()},async()=>c());
    const store=d1UsSupportTriageStore(intercept(f,async statements=>{f.sql.prepare('UPDATE international_us_device_v4_sessions SET revoked_at=? WHERE session_id=?').run(f.now(),n.credential.sessionId);return f.database.batch(statements);}),{now:f.now});
    await expect(store.dispatch(c(),reference(r),async()=>c())).rejects.toMatchObject({status:401});expect(count(f,'dispatches')).toBe(0);
  });
  it('closes when the additive triage migration is missing',async()=>{
    const f=await fixture(false);await expect(claim(f)).rejects.toMatchObject({code:'service_unavailable',status:503});
  });
  it('SQL rejects forged aliases, source hashes and first-command adoption',async()=>{
    const f=await fixture();await claim(f);
    const saved=f.sql.prepare('SELECT * FROM international_us_support_triage_requests').get()! as Record<string,SQLInputValue>;
    const alias=()=>{const requestId=randomUUID();return {...saved,command_id:randomUUID(),request_id:requestId,request_json:canonicalErpJson({...JSON.parse(saved.request_json as string),requestId})};};
    for(const offset of [-31,1]){
      const created_at=f.now()+offset,context=f.context();
      expect(()=>rawInsert(f,'requests',{...alias(),created_at,context_json:canonicalErpJson({...context,authority:{...context.authority,checkedAt:created_at}})})).toThrow(/us_triage_subscription_required/);
    }
    for(const patch of [{subscriptionId:'sub_Forged'},{authorityReference:'forged'},{seatLimit:99},{validEndsAt:f.now()+100}]){
      const context=f.context();expect(()=>rawInsert(f,'requests',{...alias(),context_json:canonicalErpJson({...context,authority:{...context.authority,...patch}})})).toThrow(/us_triage_subscription_required/);
    }
    const other=alias(),q=JSON.parse(other.request_json as string);
    expect(()=>rawInsert(f,'requests',{...other,request_json:canonicalErpJson({...q,consent:false})})).toThrow(/us_triage_invalid_record/);
    expect(()=>rawInsert(f,'requests',{...alias(),source_json:canonicalErpJson(f.source({messageSha256:'c'.repeat(64)}))})).toThrow(/us_triage_source_conflict/);
    expect(()=>rawInsert(f,'requests',{...other,mailbox_revision:2,request_json:canonicalErpJson({...q,expectedMailboxRevision:2})})).toThrow(/us_triage_connection_changed/);
    const job=f.sql.prepare('SELECT * FROM international_us_support_triage_jobs').get()! as Record<string,SQLInputValue>;
    const requestId=randomUUID(),clone={...job,id:randomUUID(),request_id:requestId,first_command_id:randomUUID(),source_hash:'c'.repeat(64),request_json:canonicalErpJson({...JSON.parse(job.request_json as string),requestId})};
    expect(()=>rawInsert(f,'jobs',clone)).toThrow(/UNIQUE/);
    expect(()=>rawInsert(f,'jobs',{...clone,first_command_id:saved.command_id})).toThrow(/us_triage_invalid_record/);
    expect(count(f)).toBe(1);expect(count(f,'requests')).toBe(1);
  });
  it('enforces explicit pilot source and request capacity without deleting audit history',async()=>{
    const f=await fixture(),first=await claim(f),job=f.sql.prepare('SELECT * FROM international_us_support_triage_jobs').get()! as Record<string,SQLInputValue>,saved=f.sql.prepare('SELECT * FROM international_us_support_triage_requests').get()! as Record<string,SQLInputValue>;
    const grant={...f.grant(),limit:1_000_000},grant_json=canonicalErpJson(grant),digest=(value:unknown)=>createHash('sha256').update(canonicalErpJson(value)).digest('hex');
    const alias=(q:UsSupportTriageRequest,source:UsSupportTriageSource,jobId:string,commandId:string)=>({...saved,command_id:commandId,request_id:q.requestId,request_json:canonicalErpJson(q),request_hash:digest({domain:'zentra:us-support-triage:request:v1',organizationId:f.intent.organizationId,workspaceId:f.context().workspaceId,actorUserId:f.actor,request:q}),source_json:canonicalErpJson(source),grant_json,job_id:jobId});
    f.sql.exec('BEGIN');
    try {
      for(let i=1;i<US_SUPPORT_TRIAGE_MAX_SOURCES;i++){
        const q=f.request({uid:String(10_000+i)}),source=f.source({uid:q.uid}),commandId=randomUUID(),id=randomUUID();
        rawInsert(f,'jobs',{...job,id,first_command_id:commandId,request_id:q.requestId,request_json:canonicalErpJson(q),source_json:canonicalErpJson(source),grant_json,source_hash:digest({domain:'zentra:us-support-triage:source:v1',organizationId:f.intent.organizationId,workspaceId:f.context().workspaceId,provider:source.provider,mailboxId:source.mailboxId,folderId:source.folderId,uid:source.uid})});
        rawInsert(f,'requests',alias(q,source,id,commandId));
      }
      f.sql.exec('COMMIT');
    } catch(error){f.sql.exec('ROLLBACK');throw error;}
    expect(count(f)).toBe(US_SUPPORT_TRIAGE_MAX_SOURCES);
    await expect(f.triage.claim(f.context(),{request:f.request({uid:'999999'}),source:f.source({uid:'999999'}),grant},async()=>f.context())).rejects.toMatchObject({code:'triage_capacity_exceeded',status:409});
    f.sql.exec('BEGIN');
    try {
      for(let i=US_SUPPORT_TRIAGE_MAX_SOURCES;i<US_SUPPORT_TRIAGE_MAX_REQUESTS;i++)rawInsert(f,'requests',alias(f.request(),f.source(),first.job.id,randomUUID()));
      f.sql.exec('COMMIT');
    } catch(error){f.sql.exec('ROLLBACK');throw error;}
    await expect(claim(f)).rejects.toMatchObject({code:'triage_capacity_exceeded',status:409});
    expect(count(f)).toBe(US_SUPPORT_TRIAGE_MAX_SOURCES);expect(count(f,'requests')).toBe(US_SUPPORT_TRIAGE_MAX_REQUESTS);
    expect((await f.triage.find(f.context(),first.requestId,first.requestHash))!.job.id).toBe(first.job.id);
  });
});
