import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
const mocks=vi.hoisted(()=>({authorize:vi.fn(),single:vi.fn(),db:vi.fn(),report:vi.fn()}));
vi.mock('@/lib/runtime',()=>({database:mocks.db}));
vi.mock('@/lib/service-diagnostics',()=>({reportServiceFailure:mocks.report}));
vi.mock('./mail-sync',()=>({requireMailScheduler:mocks.authorize,runMailSync:mocks.single}));
import {MAIL_BATCH_ADMISSION_MS,MAIL_BATCH_LIMIT,readMailBacklog,runMailSyncBatch} from './mail-sync-batch';
let sql:DatabaseSync;
const request=()=>new Request('https://zentraapp.ch/api/support/mail-sync',{method:'POST'});
beforeEach(()=>{
  vi.resetAllMocks();
  sql=new DatabaseSync(':memory:');
  sql.exec(`CREATE TABLE support_workspaces(id TEXT PRIMARY KEY,mode TEXT);
    CREATE TABLE support_connections(id TEXT PRIMARY KEY,workspace_id TEXT,active INTEGER,provider TEXT,created_at INTEGER);
    CREATE TABLE support_mailboxes(connection_id TEXT PRIMARY KEY,workspace_id TEXT,next_sync_at INTEGER,lease_until INTEGER);`);
  mocks.db.mockImplementation(()=>({prepare:(query:string)=>({bind:(...values:unknown[])=>({first:async()=>sql.prepare(query).get(...values as never[])??null})})}));
  mocks.authorize.mockResolvedValue(undefined);
  mocks.single.mockResolvedValue({idle:true});
});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();sql.close();});
it('authenticates before a claim or even a backlog read',async()=>{
  mocks.authorize.mockRejectedValue(new Error('refused'));
  await expect(runMailSyncBatch(request())).rejects.toThrow('refused');
  expect(mocks.single).not.toHaveBeenCalled();expect(mocks.db).not.toHaveBeenCalled();
});
it('caps two active lanes and four total attempts, then waits for every lane',async()=>{
  const release:Array<()=>void>=[];let active=0,peak=0,done=false;
  mocks.single.mockImplementation(async()=>{active++;peak=Math.max(peak,active);await new Promise<void>(r=>release.push(r));active--;return {idle:false,imported:1,processed:2};});
  const run=runMailSyncBatch(request()).then(value=>{done=true;return value;});
  await vi.waitFor(()=>expect(release).toHaveLength(2));
  expect(done).toBe(false);release[0]();release[1]();
  await vi.waitFor(()=>expect(release).toHaveLength(4));
  expect(active).toBe(2);expect(done).toBe(false);release[2]();release[3]();
  expect(await run).toMatchObject({imported:4,processed:8,mailboxes:{checked:4,failed:0}});
  expect(peak).toBe(2);expect(active).toBe(0);expect(mocks.single).toHaveBeenCalledTimes(MAIL_BATCH_LIMIT);
});
it('stops admissions at the deadline without returning before in-flight work settles',async()=>{
  let time=1_800_000_000_000;vi.spyOn(Date,'now').mockImplementation(()=>time);
  const release:Array<()=>void>=[];let done=false;
  mocks.single.mockImplementation(async()=>{await new Promise<void>(r=>release.push(r));return {idle:false,imported:1};});
  const run=runMailSyncBatch(request()).then(value=>{done=true;return value;});
  await vi.waitFor(()=>expect(release).toHaveLength(2));
  time+=MAIL_BATCH_ADMISSION_MS;release[0]();
  await Promise.resolve();await Promise.resolve();expect(done).toBe(false);
  release[1]();
  expect(await run).toMatchObject({incomplete:true,mailboxes:{checked:2,budgetExhausted:true}});
  expect(mocks.single).toHaveBeenCalledTimes(2);
  expect(mocks.single.mock.calls[0][1]).toEqual({deadline:1_800_000_000_000+MAIL_BATCH_ADMISSION_MS});
});
it('preserves successful peers and continues after one mailbox or claim failure',async()=>{
  mocks.single.mockRejectedValueOnce(new Error('private detail')).mockResolvedValue({idle:false,imported:2});
  const result=await runMailSyncBatch(request());
  expect(result).toMatchObject({failed:true,imported:6,mailboxes:{checked:4,failed:1}});
  expect(JSON.stringify(result)).not.toContain('private detail');
});
it('drains a pending lane before reporting a failed backlog read',async()=>{
  let release!:()=>void,finished=false;
  mocks.single.mockImplementationOnce(async()=>({idle:true})).mockImplementationOnce(async()=>{await new Promise<void>(r=>{release=r;});finished=true;return {idle:false};});
  mocks.db.mockImplementation(()=>{expect(finished).toBe(true);throw new Error('backlog unavailable');});
  const run=runMailSyncBatch(request());
  const rejection=expect(run).rejects.toThrow('backlog unavailable');
  await vi.waitFor(()=>expect(mocks.single).toHaveBeenCalledTimes(2));release();await rejection;
});
it('reports only eligible mailbox counts, age and active leases on real SQLite',async()=>{
  const now=1_800_000_000;vi.spyOn(Date,'now').mockReturnValue(now*1000);
  sql.exec(`INSERT INTO support_workspaces VALUES('on','review'),('off','paused');`);
  const add=(id:string,workspace:string,due:number,lease:number,active=1,provider='infomaniak')=>{
    sql.prepare('INSERT INTO support_connections VALUES(?,?,?,?,?)').run(id,workspace,active,provider,now-2000);
    sql.prepare('INSERT INTO support_mailboxes VALUES(?,?,?,?)').run(id,workspace,due,lease);
  };
  add('old','on',0,0);add('fresh','on',now,0);add('held','on',now-2000,now+60);
  add('future','on',now+60,0);add('paused','off',0,0);add('inactive','on',0,0,0);add('other-provider','on',0,0,1,'zendesk');
  expect(await readMailBacklog()).toEqual({due:2,overdue:1,active:1,oldestDueAt:new Date((now-2000)*1000).toISOString()});
  const result=await runMailSyncBatch(request());
  expect(result).toMatchObject({idle:false,more:true,syncing:true,mailboxes:{due:2,overdue:1,active:1}});
  for (const value of ['old','fresh','on','paused','infomaniak']) expect(JSON.stringify(result)).not.toContain(':'+JSON.stringify(value));
});
