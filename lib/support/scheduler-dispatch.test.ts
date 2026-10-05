import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
const mocks=vi.hoisted(()=>({db:null as unknown}));
vi.mock('@/lib/runtime',()=>({database:()=>mocks.db}));
vi.mock('./mail-sync',()=>({requireMailScheduler:vi.fn(),runMailSync:vi.fn()}));
vi.mock('@/lib/service-diagnostics',()=>({reportServiceFailure:vi.fn()}));
import {readSchedulerDemand,readWorkflowBacklog,schedulerWorkerDemand} from './scheduler-dispatch';
let sql: DatabaseSync;
const time=1_800_000_000;
beforeEach(()=>{
  vi.spyOn(Date,'now').mockReturnValue(time*1000);
  sql=new DatabaseSync(':memory:');
  sql.exec(`CREATE TABLE support_workspaces(id TEXT PRIMARY KEY,mode TEXT);
    CREATE TABLE support_connections(id TEXT PRIMARY KEY,workspace_id TEXT,active INTEGER,provider TEXT,created_at INTEGER);
    CREATE TABLE support_mailboxes(connection_id TEXT PRIMARY KEY,workspace_id TEXT,next_sync_at INTEGER,lease_until INTEGER);
    CREATE TABLE automation_workflow_runs(id TEXT PRIMARY KEY,state TEXT,due_at INTEGER,lease_until INTEGER);
    CREATE INDEX workflow_due ON automation_workflow_runs(state,due_at);
    INSERT INTO support_workspaces VALUES('eligible-private-id','review'),('paused-private-id','paused');`);
  mocks.db={prepare:(query:string)=>({bind:(...values:unknown[])=>({first:async()=>sql.prepare(query).get(...values as never[])??null})})};
});
afterEach(()=>{sql.close();vi.restoreAllMocks();});
function mailbox(id:string,{workspace='eligible-private-id',due=time,lease=0,active=1,provider='infomaniak'}={}){
  sql.prepare('INSERT INTO support_connections VALUES(?,?,?,?,?)').run(id,workspace,active,provider,time-2000);
  sql.prepare('INSERT INTO support_mailboxes VALUES(?,?,?,?)').run(id,workspace,due,lease);
}
function workflow(id:string,state:string,due=time,lease=0){sql.prepare('INSERT INTO automation_workflow_runs VALUES(?,?,?,?)').run(id,state,due,lease);}
it('returns zero business workers and a closed content-free plan for an empty queue',async()=>{
  const {plan}=await readSchedulerDemand();
  expect(plan).toEqual({protocol:'zentra-scheduler-demand',version:1,observedAt:time,desiredWorkers:0,
    mailboxesDue:0,workflowsDue:0,expiredWorkflows:0,activeMailboxes:0,activeWorkflows:0});
});
it('requests one worker for one eligible due mailbox and preserves paused/future/active exclusions',async()=>{
  mailbox('real-due');mailbox('paused',{workspace:'paused-private-id'});mailbox('future',{due:time+1});
  mailbox('held',{lease:time+60});mailbox('inactive',{active:0});mailbox('different-provider',{provider:'zendesk'});
  const {plan}=await readSchedulerDemand();
  expect(plan).toMatchObject({desiredWorkers:1,mailboxesDue:1,activeMailboxes:1});
  for(const privateValue of ['eligible-private-id','paused-private-id','real-due','infomaniak','zendesk'])expect(JSON.stringify(plan)).not.toContain(privateValue);
});
it('keeps eight workers available for 150 companies instead of reducing the capacity ceiling',async()=>{
  for(let i=0;i<150;i++){
    const workspace='company-'+i;
    sql.prepare('INSERT INTO support_workspaces VALUES(?,?)').run(workspace,'review');
    mailbox('mailbox-'+i,{workspace});
  }
  expect((await readSchedulerDemand()).plan).toMatchObject({mailboxesDue:150,desiredWorkers:8});
});
it('admits workflows without mail and maintenance of interrupted runs, never future/review/completed jobs',async()=>{
  workflow('due','queued');workflow('waiting','waiting');workflow('future','queued',time+1);
  workflow('leased','waiting',time,time+1);workflow('interrupted','running',0,time);
  workflow('active','running',0,time+60);workflow('review','review');workflow('completed','completed');
  expect(await readWorkflowBacklog()).toEqual({due:2,expired:1,active:1});
  expect((await readSchedulerDemand()).plan).toMatchObject({desiredWorkers:1,mailboxesDue:0,workflowsDue:2,expiredWorkflows:1});
});
it('reobserves new arrivals and lease races rather than treating a previous count as a reservation',async()=>{
  expect((await readSchedulerDemand()).plan.desiredWorkers).toBe(0);
  mailbox('new-arrival');expect((await readSchedulerDemand()).plan.desiredWorkers).toBe(1);
  sql.prepare('UPDATE support_mailboxes SET lease_until=?').run(time+600);
  expect((await readSchedulerDemand()).plan).toMatchObject({desiredWorkers:0,activeMailboxes:1});
});
it.each([[0,0,0,0],[1,0,0,1],[3,0,0,2],[150,0,0,8],[0,1,0,1],[0,21,0,2],[0,150,0,8],[0,0,1,1]])
  ('calculates the bounded demand (%i,%i,%i) -> %i',(mail,workflows,expired,expected)=>expect(schedulerWorkerDemand(mail,workflows,expired)).toBe(expected));
it.each([-1,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1])('fails closed for invalid counters %s',invalid=>{
  expect(()=>schedulerWorkerDemand(invalid,0,0)).toThrow('Scheduler demand unavailable');
});
