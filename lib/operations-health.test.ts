import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({db:vi.fn(),token:'a'.repeat(64),configuration:vi.fn(),scheduler:vi.fn(),failure:vi.fn()}));
vi.mock('./runtime',()=>({database:mocks.db,runtimeValue:(key:string)=>key==='OPERATIONS_MONITOR_TOKEN'?mocks.token:'scheduler-token'}));
vi.mock('./supabase-auth-runtime',()=>({supabaseAuthConfiguration:mocks.configuration}));
vi.mock('./scheduler-health',()=>({readSchedulerHealth:mocks.scheduler,schedulerHealth:()=>({background:false,state:'unverified'})}));
vi.mock('./service-diagnostics',()=>({reportServiceFailure:mocks.failure}));
import { AUTH_PROBE_TIMEOUT_MS, OPERATIONS_CHECK_TIMEOUT_MS, OPERATIONS_DELAY_SECONDS, operationsHealth, readAuthenticationHealth, readQueueHealth, requireOperationsMonitor } from './operations-health';
import { GET } from '@/app/api/operations/health/route';
const now=1_790_000_000;
beforeEach(()=>{vi.resetAllMocks();mocks.token='a'.repeat(64);mocks.configuration.mockReturnValue({url:'https://project.supabase.co',publishableKey:'sb_publishable_fixture_only'});mocks.scheduler.mockResolvedValue({background:true,state:'current'});});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});
const request=(authorization?:string)=>new Request('https://zentraapp.ch/api/operations/health',{headers:authorization?{authorization}:{}});
const settings=()=>Response.json({external:{email:true},disable_signup:false});

describe('private read-only health access',()=>{
  it.each([undefined,'Basic '+ 'a'.repeat(64),'Bearer scheduler-token','Bearer '+ 'b'.repeat(64),'Bearer '+ 'a'.repeat(129)])('refuses before querying or contacting upstream: %s',async value=>{
    const response=await GET(request(value));expect(response.status).toBe(401);expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.db).not.toHaveBeenCalled();expect(mocks.configuration).not.toHaveBeenCalled();expect(mocks.scheduler).not.toHaveBeenCalled();
  });
  it('accepts only the separate credential in its header, never URL or cookie',async()=>{
    await expect(requireOperationsMonitor(request('Bearer '+mocks.token))).resolves.toBeUndefined();
    await expect(requireOperationsMonitor(new Request(`https://zentraapp.ch/api/operations/health?token=${mocks.token}`,{headers:{cookie:`token=${mocks.token}`}}))).rejects.toMatchObject({status:401});
    mocks.token='';await expect(requireOperationsMonitor(request('Bearer '+'a'.repeat(64)))).rejects.toMatchObject({status:401});
  });
});
describe('authentication dependency probe',()=>{
  it('reads settings once with only the public key and no redirects, no-store or login mutation',async()=>{
    const fetcher=vi.fn().mockResolvedValue(settings());expect(await readAuthenticationHealth(fetcher)).toMatchObject({state:'available',upstreamStatus:200});
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://project.supabase.co/auth/v1/settings',expect.objectContaining({method:'GET',redirect:'manual',cache:'no-store',headers:{apikey:'sb_publishable_fixture_only',Accept:'application/json'},signal:expect.any(AbortSignal)}));
  });
  it.each([[402,'restricted'],[401,'misconfigured'],[403,'misconfigured'],[429,'unavailable'],[500,'unavailable'],[302,'unavailable']])('exposes status %s without the response body',async(status,state)=>{
    const result=await readAuthenticationHealth(vi.fn().mockResolvedValue(new Response('secret-email@example.invalid',{status:Number(status)})));
    expect(result).toMatchObject({state,upstreamStatus:status});expect(JSON.stringify(result)).not.toContain('secret-email');
  });
  it.each([Response.json({}),Response.json({external:[],disable_signup:false}),new Response('<html>Login</html>'),Response.json({external:{email:true},disable_signup:false,padding:'x'.repeat(17_000)}),new Response('{}',{headers:{'content-type':'application/json','content-length':'20000'}})])('does not treat malformed or oversized HTTP 200 as healthy',async response=>{
    expect(await readAuthenticationHealth(vi.fn().mockResolvedValue(response))).toMatchObject({state:'invalid_response'});
  });
  it('bounds network time and handles missing configuration without disclosure',async()=>{
    vi.useFakeTimers();
    const fetcher=vi.fn((_url:unknown,init?:RequestInit)=>new Promise<Response>((_,reject)=>init?.signal?.addEventListener('abort',()=>reject(new Error('private network detail')))));
    const promise=readAuthenticationHealth(fetcher);await vi.advanceTimersByTimeAsync(AUTH_PROBE_TIMEOUT_MS);
    expect(await promise).toMatchObject({state:'timeout',durationMs:AUTH_PROBE_TIMEOUT_MS});
    mocks.configuration.mockImplementation(()=>{throw new Error('private config')});
    expect(await readAuthenticationHealth(fetcher)).toMatchObject({state:'misconfigured'});expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe('queues against actual SQLite schemas',()=>{
  let db:DatabaseSync;
  beforeEach(()=>{
    vi.spyOn(Date,'now').mockReturnValue(now*1000);
    db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=OFF');
    for(const file of ['0041_mysterious_brother_voodoo','0052_support_mailboxes','0059_careless_proteus','0066_operations_queue_index','0069_supplier_capture_analysis'])db.exec(readFileSync(new URL(`../drizzle/${file}.sql`,import.meta.url),'utf8'));
    mocks.db.mockReturnValue({prepare:(sql:string)=>({bind:(...args:(string|number)[])=>({first:async()=>db.prepare(sql).get(...args)})})});
    db.prepare('INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run('ws','owner','PRIVATE COMPANY',now-100,now);
    db.prepare('INSERT INTO support_connections(id,workspace_id,provider,label,domain,login,secret,hook_hash,directory_json,routes_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('conn','ws','infomaniak','private@company.invalid','host','login','secret','hash','{}','{}',now-100);
    db.prepare('INSERT INTO support_mailboxes(connection_id,workspace_id,email,mailbox_id,folder_id,since_at,next_sync_at) VALUES(?,?,?,?,?,?,?)').run('conn','ws','private@company.invalid','mail','folder',now,now+300);
    db.prepare('INSERT INTO automation_workflows(id,organization_id,name,definition,enabled,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('rule','org','PRIVATE RULE','{}',1,'owner',now,now);
  });
  afterEach(()=>db.close());
  const ticket=(id:string,state:string,created=now-2000,lease:number|null=null)=>db.prepare('INSERT INTO support_tickets(id,workspace_id,connection_id,external_id,subject,body,source_json,fingerprint,state,created_at,updated_at,lease_until) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,'ws','conn',id,'PRIVATE SUBJECT','PRIVATE BODY','{}','hash',state,created,created,lease);
  const workflow=(id:string,state:string,due=now-2000,lease=0)=>db.prepare('INSERT INTO automation_workflow_runs(id,organization_id,workflow_id,workflow_revision,source_id,source_version,title,definition,state,due_at,created_at,updated_at,lease_until) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,'org','rule',1,id,'1','PRIVATE TITLE','{}',state,due,now-3000,now,lease);
  it('returns counts and dates without contents, identifiers or writes',async()=>{
    ticket('pending','pending');workflow('scheduled','waiting',now+3600);
    const changes=db.prepare('SELECT total_changes() AS n').get();const result=await readQueueHealth(now);
    expect(result).toMatchObject({state:'current',tickets:{due:1,overdue:0,stalled:0},workflows:{due:0,overdue:0}});
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|private@|secret|conn|"org"/);
  });
  it('does not treat a newly connected mailbox as overdue since epoch',async()=>{
    db.exec('UPDATE support_mailboxes SET next_sync_at=0');expect(await readQueueHealth(now)).toMatchObject({state:'current',mailboxes:{due:1,overdue:0,oldestDueAt:new Date((now-100)*1000).toISOString()}});
  });
  it('keeps mailbox failure observable after a healthy scheduler cycle and hides its error content',async()=>{
    db.prepare('UPDATE support_mailboxes SET last_error=?').run('PRIVATE PASSWORD');
    expect(await readQueueHealth(now)).toMatchObject({state:'attention',mailboxes:{errors:1}});
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(settings()));expect((await operationsHealth()).state).toBe('degraded');
    db.exec('UPDATE support_mailboxes SET last_error=NULL');expect(await readQueueHealth(now)).toMatchObject({state:'current'});
  });
  it('distinguishes future waits, active leases, expired leases and overdue ready work',async()=>{
    ticket('leased','processing',now-2000,now+60);workflow('future','waiting',now+10);workflow('leased','running',0,now+60);
    expect(await readQueueHealth(now)).toMatchObject({state:'current'});
    ticket('stalled','processing',now-2000,now);workflow('expired','running',0,now);
    workflow('late','waiting',now-OPERATIONS_DELAY_SECONDS-1);
    db.prepare('UPDATE support_mailboxes SET next_sync_at=?').run(now-OPERATIONS_DELAY_SECONDS-1);
    expect(await readQueueHealth(now)).toMatchObject({state:'delayed',mailboxes:{overdue:1},tickets:{stalled:1},workflows:{stalled:1,overdue:1}});
  });
  it('excludes paused workspaces, disconnected mailboxes, manual review and disabled rules',async()=>{
    ticket('review','review');workflow('review','review');expect(await readQueueHealth(now)).toMatchObject({state:'current'});
    ticket('error','error');workflow('failed','failed');db.prepare('UPDATE support_mailboxes SET last_error=?').run('problem');
    db.exec("UPDATE support_workspaces SET mode='paused'; UPDATE automation_workflows SET enabled=0");
    expect(await readQueueHealth(now)).toMatchObject({state:'current',tickets:{errors:0},mailboxes:{errors:0},workflows:{errors:0}});
    db.exec("UPDATE support_workspaces SET mode='review'; UPDATE support_connections SET active=0");
    expect(await readQueueHealth(now)).toMatchObject({state:'current',tickets:{errors:0},mailboxes:{errors:0}});
  });
  it('returns unavailable rather than empty queues when the database fails',async()=>{
    mocks.db.mockImplementation(()=>{throw new Error('PRIVATE DATABASE')});expect(await readQueueHealth(now)).toEqual({state:'unavailable'});
    expect(mocks.failure).toHaveBeenCalledWith(expect.any(Error),{operation:'operations.queues.read'});
  });
  it('uses the queue-state index rather than scanning archived ticket bodies',()=>{
    const plan=db.prepare("EXPLAIN QUERY PLAN SELECT created_at FROM support_tickets WHERE state IN ('pending','processing','error')").all();
    expect(JSON.stringify(plan)).toContain('support_ticket_operations');
  });
  it('returns 503 for an unavailable dependency even when the public site is reachable',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('PRIVATE DETAILS',{status:402})));
    const response=await GET(request('Bearer '+mocks.token));expect(response.status).toBe(503);expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({state:'degraded',authentication:{state:'restricted',upstreamStatus:402}});
  });
  it('returns healthy only when all dependency checks pass',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockImplementation(async()=>settings()));
    const response=await GET(request('Bearer '+mocks.token));expect(response.status).toBe(200);expect(await response.json()).toMatchObject({state:'healthy'});
    mocks.scheduler.mockResolvedValue({state:'inactive',background:false});expect((await GET(request('Bearer '+mocks.token))).status).toBe(503);
  });
  it('bounds a nonresponding database check instead of leaving the monitor hanging',async()=>{
    vi.useFakeTimers();vi.stubGlobal('fetch',vi.fn().mockImplementation(async()=>settings()));
    mocks.db.mockReturnValue({prepare:()=>({bind:()=>({first:()=>new Promise(()=>{})})})});
    const pending=operationsHealth();await vi.advanceTimersByTimeAsync(OPERATIONS_CHECK_TIMEOUT_MS);
    expect(await pending).toMatchObject({state:'degraded',queues:{state:'unavailable'}});
  });
  const capture=(id:string,state:string,lease=now-1)=>db.prepare('INSERT INTO supplier_capture_analyses(workspace_id,source_sha256,organization_id,inbox_id,owner_token,owner_until,state,reservation,extraction,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('ws',id,'PRIVATE ORGANIZATION','PRIVATE INBOX','PRIVATE TOKEN',lease,state,'PRIVATE RESERVATION','PRIVATE EXTRACTION',now-2000,now-1000);
  it.each(['analyzing','uncertain'])('reports an expired %s capture as reconciliation, even in a paused workspace',async state=>{
    capture('PRIVATE SOURCE SHA',state);db.exec("UPDATE support_workspaces SET mode='paused'");
    vi.stubGlobal('fetch',vi.fn().mockImplementation(async()=>settings()));
    const response=await GET(request('Bearer '+mocks.token));expect(response.status).toBe(503);
    const result=await response.json();expect(result).toMatchObject({state:'degraded',captures:{state:'attention',reconciliationRequired:1,awaitingResume:0,awaitingAdmission:0}});
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|private@|SOURCE SHA|RESERVATION|EXTRACTION/);
  });
  it('counts resumable and retryable work without claiming it is a failure or eligible for processing',async()=>{
    capture('preparing','preparing');capture('analyzed','analyzed');capture('retryable','retryable');
    capture('active-analysis','analyzing',now+60);capture('active-uncertainty','uncertain',now+60);
    capture('imported','completed');capture('ignored-non-invoice','completed');
    vi.stubGlobal('fetch',vi.fn().mockImplementation(async()=>settings()));
    const response=await GET(request('Bearer '+mocks.token));expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({captures:{state:'current',reconciliationRequired:0,awaitingResume:2,awaitingAdmission:1}});
  });
  it('does not silently report zero when the capture migration is absent',async()=>{
    db.exec('DROP TABLE supplier_capture_analyses');vi.stubGlobal('fetch',vi.fn().mockImplementation(async()=>settings()));
    const response=await GET(request('Bearer '+mocks.token));expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({captures:{state:'unavailable'}});
  });
  it('does not report healthy when an unknown capture state was persisted',async()=>{
    capture('unexpected','unrecognized-state');vi.stubGlobal('fetch',vi.fn().mockImplementation(async()=>settings()));
    const response=await GET(request('Bearer '+mocks.token));expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({captures:{state:'unavailable'}});
  });
});
