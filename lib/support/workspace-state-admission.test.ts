// Independent admission witnesses. SQL, billing, roles and grants are real;
// only the already-verified Auth boundary and external transports are isolated.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

const state = vi.hoisted(() => ({
  db: null as unknown,
  user: null as unknown,
  fetch: vi.fn(),
}));
vi.mock('@/lib/runtime', () => ({
  database: () => state.db,
  runtimeValue: (name: string) => name === 'STRIPE_SECRET_KEY' ? 'sk_live_synthetic_not_a_real_key' : name === 'PUBLIC_SITE_URL' ? 'https://zentraapp.ch' : '',
}));
vi.mock('@/app/zentra-auth', () => ({ getZentraUser: async () => state.user }));
import { startAccountTrial } from '@/lib/account-trial';
import { getWorkspaceState } from '@/lib/support/service';

const owner = { userId: 'speed-owner', email: 'speed-owner@example.test', displayName: 'Synthetic owner', provider: 'supabase', emailConfirmed: true };
const other = { userId: 'foreign-owner', email: 'foreign-owner@example.test', displayName: 'Other synthetic owner', provider: 'supabase', emailConfirmed: true };
let sql: DatabaseSync;
let workspace: string;
let organization: string;
let latency: number;
let writes: string[];
let reads: { query: string; startedAt: number; finishedAt?: number }[];
const membershipQuery = (query: string) => query.includes('FROM organization_members member');
function prepare(query: string) {
  let values: SQLInputValue[] = [];
  async function read(all: boolean) {
    const operation = { query, startedAt: Date.now(), finishedAt: undefined as number | undefined };
    reads.push(operation);
    if (latency) await new Promise(resolve => setTimeout(resolve, latency));
    operation.finishedAt = Date.now();
    return all ? { results: sql.prepare(query).all(...values) } : sql.prepare(query).get(...values) ?? null;
  }
  const execute = () => { writes.push(query); return { success: true, meta: { changes: Number(sql.prepare(query).run(...values).changes) } }; };
  return {
    bind(...args: SQLInputValue[]) { values = args; return this; },
    first: async () => read(false),
    all: async () => read(true),
    run: async () => execute(),
    execute,
  };
}
async function settle<T>(pending: Promise<T>) {
  // Attach the rejection handler immediately so a deliberately denied read is
  // never reported as an unhandled rejection while fake timers are drained.
  const result = pending.then(value => ({ value }), error => ({ error }));
  await vi.runAllTimersAsync();
  const outcome = await result;
  if ('error' in outcome) throw outcome.error;
  return outcome.value;
}
const request = (query = '') => new Request(`https://zentraapp.ch/api/support${query}`);

beforeEach(async () => {
  vi.resetAllMocks();
  state.user = owner;
  latency = 0;
  reads = [];
  writes = [];
  sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  for (const file of readdirSync(new URL('../../drizzle/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) {
    sql.exec(readFileSync(new URL('../../drizzle/' + file, import.meta.url), 'utf8'));
  }
  state.db = {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      sql.exec('BEGIN');
      try { const result = statements.map(statement => statement.execute()); sql.exec('COMMIT'); return result; }
      catch (error) { sql.exec('ROLLBACK'); throw error; }
    },
  };
  const trial = await startAccountTrial(owner, 'Synthetic trial company', true);
  organization = trial.organization_id;
  workspace = (sql.prepare('SELECT id FROM support_workspaces WHERE owner_id=?').get(owner.userId) as { id: string }).id;
  sql.prepare('INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run('foreign-workspace', other.userId, 'Foreign synthetic company', 1, 1);
  const insertConnection = sql.prepare("INSERT INTO support_connections(id,workspace_id,provider,label,domain,login,secret,hook_hash,directory_json,routes_json,created_at) VALUES(?,?,'api','Synthetic connection','','','','','{\"teams\":[],\"agents\":[]}','{}',1)");
  insertConnection.run('own-connection', workspace);
  insertConnection.run('foreign-connection', 'foreign-workspace');
  const insertTicket = sql.prepare("INSERT INTO support_tickets(id,workspace_id,connection_id,external_id,subject,body,source_json,fingerprint,state,created_at,updated_at) VALUES(?,?,?,?,?,'Synthetic body','{}','synthetic-fingerprint','review',?,?)");
  const now = Math.floor(Date.now() / 1000);
  insertTicket.run('own-ticket', workspace, 'own-connection', 'OWN-1', 'Owned synthetic request', now, now);
  insertTicket.run('foreign-ticket', 'foreign-workspace', 'foreign-connection', 'FOREIGN-1', 'Foreign synthetic request', now, now);
  reads = [];
  writes = [];
  latency = 100;
  vi.useFakeTimers();
  state.fetch.mockRejectedValue(new Error('No real network is allowed in this deterministic test'));
  vi.stubGlobal('fetch', state.fetch);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); sql.close(); });



type AdmissionView = {
 workspace: {id:string;role:string;canManage:boolean};
 user: {email:string};
 members: unknown[];
 tickets: {id:string}[];
 connections: {id:string}[];
 events: {id:string}[];
 solicitationFeed: {id:string}[];
 focusedTicket: unknown | null;
 counts: Record<string,number>;
 billing: {active:boolean;offeredAccess?:boolean};
 gestion: {organizationId:string|null;organizationName:string|null;role:string|null;choices:{id:string}[]};
 automation: {active:boolean;enabled:boolean};
 productivity: {policies:unknown[];daily:{gestion:unknown|null};canCreateGestion:boolean}|null;
};
// A selected-workspace response is asserted field-by-field below. Account-empty
// responses are compared whole without assuming this selected-space shape.
async function selectedView(response:Response):Promise<AdmissionView>{
 return await response.json() as AdmissionView;
}

function addSupportMember(role='read_only') {
  sql.prepare('INSERT INTO support_members(id,workspace_id,email,role,created_at) VALUES(?,?,?,?,1)').run('direct-reader',workspace,other.email,role);
  state.user=other;
}
function privateSupplementalRead(query: string) {
  return query.includes('FROM support_platform_secrets') || query.includes('FROM support_mailboxes WHERE')
    || query.includes('FROM service_scheduler_health') || query.includes('FROM support_followups f');
}
function populateHiddenContent() {
  sql.prepare("INSERT INTO support_events(id,workspace_id,ticket_id,kind,detail,actor,created_at) VALUES('visible-event',?,?,'routed','Synthetic detail','Zentra Support',?)").run(workspace,'own-ticket',Math.floor(Date.now()/1000));
  sql.prepare("UPDATE support_workspaces SET solicitation_notifications=1 WHERE id=?").run(workspace);
  sql.prepare("UPDATE support_tickets SET state='quiet',decision_json=? WHERE id='own-ticket'").run(JSON.stringify({category:'solicitation',priority:'low',confidence:.99}));
}
describe('Independent admission witnesses for parallel Support reads',()=>{
  it('keeps Support reader and unrelated Gestion access separate with no administration data',async()=>{
    addSupportMember();
    const response=await settle(getWorkspaceState(request('?workspace='+workspace)));
    const body=await selectedView(response);
    expect(body.workspace.role).toBe('read_only');
    expect(body.workspace.canManage).toBe(false);
    expect(body.members).toEqual([]);
    expect(body.productivity!.policies).toEqual([]);
    expect(body.gestion).toMatchObject({organizationId:null,organizationName:null,role:null,choices:[]});
    expect(body.productivity!.daily.gestion).toBeNull();
    expect(body.productivity!.canCreateGestion).toBe(false);
    expect(body.tickets.map((x)=>x.id)).toEqual(['own-ticket']);
    expect(reads.some(r=>r.query.includes('SELECT id,email,role FROM support_members'))).toBe(false);
    expect(state.fetch).not.toHaveBeenCalled();
  });
  it('observes Gestion revocation on the very next request without exposing the previous company',async()=>{
    const before=await settle(getWorkspaceState(request()));
    expect((await selectedView(before)).gestion.organizationId).toBe(organization);
    sql.prepare('UPDATE organization_members SET revoked_at=? WHERE organization_id=? AND user_id=?').run(Math.floor(Date.now()/1000),organization,owner.userId);
    const after=await settle(getWorkspaceState(request()));
    const body=await selectedView(after);
    expect(body.workspace.id).toBe(workspace);
    expect(body.gestion).toMatchObject({organizationId:null,organizationName:null,role:null,choices:[]});
    expect(body.automation).toEqual({active:false,enabled:false});
    expect(body.productivity!.daily.gestion).toBeNull();
    expect(body.productivity!.canCreateGestion).toBe(false);
  });
  it('hides paid tickets, counts, events and solicitation feed when actual data exists after trial expiry',async()=>{
    populateHiddenContent();
    const visible=await settle(getWorkspaceState(request()));
    const first=await selectedView(visible);
    expect(first.events.map((x)=>x.id)).toContain('visible-event');
    expect(first.solicitationFeed.map((x)=>x.id)).toEqual(['own-ticket']);
    // SQLite unixepoch uses the real clock; expiration must precede it, even after fake timers advanced.
    const time=Math.floor(vi.getRealSystemTime()/1000);
    sql.prepare('UPDATE account_trials SET started_at=?,ends_at=?').run(time-15*86400,time-1);
    reads=[];
    const hidden=await settle(getWorkspaceState(request()));
    const body=await selectedView(hidden);
    expect(body.billing.active).toBe(false);
    expect(body.tickets).toEqual([]);
    expect(body.focusedTicket).toBeNull();
    expect(body.counts).toEqual({total:0,review:0,errors:0,ready:0,routed:0,automatic:0,corrections:0});
    expect(body.events).toEqual([]);
    expect(body.solicitationFeed).toEqual([]);
    expect(body.productivity).toBeNull();
    expect(reads.some(r=>r.query.includes('FROM support_followups f'))).toBe(false);
    expect(reads.some(r=>r.query.includes("SELECT id FROM support_tickets WHERE workspace_id=? AND state='quiet'"))).toBe(false);
  });
  it('rejects a foreign focused ticket before platform, mailbox and productivity supplemental reads',async()=>{
    await expect(settle(getWorkspaceState(request('?ticket=foreign-ticket')))).rejects.toMatchObject({status:404});
    expect(reads.some(r=>privateSupplementalRead(r.query))).toBe(false);
    expect(writes).toEqual([]);
    expect(state.fetch).not.toHaveBeenCalled();
  });
  it('rejects malformed pagination before starting the private parallel group',async()=>{
    await expect(settle(getWorkspaceState(request('?before=NaN')))).rejects.toMatchObject({status:400});
    expect(reads.some(r=>r.query.includes('FROM support_connections WHERE workspace_id='))).toBe(false);
    expect(reads.some(r=>r.query.includes('FROM support_tickets t WHERE workspace_id='))).toBe(false);
  });
  it('rejects the nonexistent category before starting private parallel reads',async()=>{
    await expect(settle(getWorkspaceState(request('?category=not-a-real-category')))).rejects.toMatchObject({status:400});
    expect(reads.some(r=>r.query.includes('FROM support_connections WHERE workspace_id='))).toBe(false);
    expect(reads.some(r=>privateSupplementalRead(r.query))).toBe(false);
  });
  it('returns an empty account without reading another company when no workspace is authorized',async()=>{
    state.user={...other,userId:'empty-account',email:'empty@example.test'};
    const response=await settle(getWorkspaceState(request()));
    expect(await selectedView(response)).toEqual({user:{name:other.displayName,email:'empty@example.test'},platformOwner:false,workspaces:[],workspace:null});
    expect(reads.some(r=>r.query.includes('FROM support_connections WHERE workspace_id='))).toBe(false);
    expect(reads.some(r=>privateSupplementalRead(r.query))).toBe(false);
    expect(writes).toEqual([]);
  });
  it('makes no database mutation or supplier call in the ordinary post-selection state path',async()=>{
    const response=await settle(getWorkspaceState(request()));
    expect(response.status).toBe(200);
    expect(writes).toEqual([]);
    expect(state.fetch).not.toHaveBeenCalled();
  });
  it('keeps two overlapping requests bound to each initially verified user',async()=>{
    const first=getWorkspaceState(request());
    state.user=other;
    const second=getWorkspaceState(request());
    const [a,b]=await settle(Promise.all([first,second]));
    const va=await selectedView(a),vb=await selectedView(b);
    expect(va.user.email).toBe(owner.email);
    expect(va.workspace.id).toBe(workspace);
    expect(va.tickets.map((x)=>x.id)).toEqual(['own-ticket']);
    expect(va.gestion.organizationId).toBe(organization);
    expect(vb.user.email).toBe(other.email);
    expect(vb.workspace.id).toBe('foreign-workspace');
    expect(vb.connections.map((x)=>x.id)).toEqual(['foreign-connection']);
    expect(vb.tickets).toEqual([]);
    expect(vb.gestion.organizationId).toBeNull();
    expect(state.fetch).not.toHaveBeenCalled();
  });
});


function prepareUnboundAutomationOffer(ambiguous=false) {
 const time=Math.floor(vi.getRealSystemTime()/1000);
 sql.prepare('DELETE FROM complete_trials WHERE organization_id=?').run(organization);
 // Trial subscriptions deliberately use livemode0. This case instead models a paid live Gestion base.
 sql.prepare('UPDATE subscriptions SET livemode=1,entitlement_valid_until=? WHERE subscription_id=(SELECT subscription_id FROM organizations WHERE organization_id=?)').run(time+30*86400,organization);
 sql.prepare('INSERT INTO founder_account_identities(user_id,email,display_name,provider,last_seen_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO NOTHING').run(owner.userId,owner.email,owner.displayName,'supabase',time);
 sql.prepare("INSERT INTO founder_support_grants(email,grant_id,user_id,workspace_id,plan_id,valid_from,valid_until,revision,created_at,updated_at,last_operation_id) VALUES(?,?,?,?,'team',?,?,1,?,?,'synthetic-support-grant')").run(owner.email,'support-grant',owner.userId,workspace,time-86400,time+30*86400,time,time);
 sql.prepare("INSERT INTO founder_automation_grants(email,grant_id,valid_from,valid_until,revision,created_at,updated_at,last_operation_id) VALUES(?,'synthetic-automation-grant',?,?,1,?,?,'synthetic-automation-operation')").run(owner.email,time-86400,time+30*86400,time,time);
 if(ambiguous){
  const subscription=sql.prepare('SELECT subscription_id FROM organizations WHERE organization_id=?').get(organization)!.subscription_id;
  sql.prepare('INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,entitlement_valid_until,livemode,updated_at) SELECT ?,customer_id,price_id,status,current_period_end,entitlement_valid_until,livemode,updated_at FROM subscriptions WHERE subscription_id=?').run('synthetic-second-subscription',subscription);
  sql.prepare('INSERT INTO organizations(organization_id,name,subscription_id,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,1,1)').run('synthetic-second-company','Second synthetic company','synthetic-second-subscription',owner.userId);
  sql.prepare('INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES(?,?,?,?,?,1)').run('synthetic-second-membership','synthetic-second-company',owner.userId,owner.email,'owner');
 }
 writes=[];reads=[];
}
describe('Effectful offered Automation fallback discovered by independent source review',()=>{
 it('keeps one offered grant tied to the same company without duplicate deferred binding',async()=>{
  prepareUnboundAutomationOffer();
  const response=await settle(getWorkspaceState(request()));
  const body=await selectedView(response);
  expect(body.billing.active).toBe(true);
  expect(body.billing.offeredAccess).toBe(true);
  expect(body.automation).toEqual({active:true,enabled:false});
  expect(body.productivity!.daily.gestion).toEqual({invoices:0,appointments:0,pending:0});
  expect(body.productivity!.canCreateGestion).toBe(true);
  const grant=sql.prepare('SELECT * FROM founder_automation_grants WHERE email=?').get(owner.email);
  expect(grant).toMatchObject({organization_id:organization,user_id:owner.userId,revision:1,last_operation_id:'synthetic-automation-operation',revoked_at:null});
  expect(sql.prepare('SELECT COUNT(*) AS n FROM founder_automation_grants').get()!.n).toBe(1);
  expect(sql.prepare('SELECT COUNT(*) AS n FROM founder_automation_events').get()!.n).toBe(0);
  expect(writes).toHaveLength(2);
  expect(writes.every(q=>q.startsWith('UPDATE founder_automation_grants SET user_id=')||q.includes('UPDATE founder_automation_grants SET organization_id='))).toBe(true);
  expect(state.fetch).not.toHaveBeenCalled();
 });
 it('does not choose one of two companies while two offered-entitlement readers encounter an unbound grant',async()=>{
  prepareUnboundAutomationOffer(true);
  const response=await settle(getWorkspaceState(request()));
  const body=await selectedView(response);
  expect(body.automation).toEqual({active:false,enabled:false});
  expect(body.productivity!.daily.gestion).toBeNull();
  expect(body.productivity!.canCreateGestion).toBe(false);
  expect(sql.prepare('SELECT organization_id FROM founder_automation_grants WHERE email=?').get(owner.email)!.organization_id).toBeNull();
  expect(writes.some(q=>q.includes('UPDATE founder_automation_grants SET organization_id='))).toBe(false);
  expect(state.fetch).not.toHaveBeenCalled();
 });
 it('does not activate an offered grant revoked between discovery and the first conditional update',async()=>{
  prepareUnboundAutomationOffer();
  const db=state.db as {prepare:typeof prepare};
  let revoked=false;
  db.prepare=(query:string)=>{
   const statement=prepare(query);
   const execute=statement.run;
   statement.run=async()=>{
    if(!revoked&&query.startsWith('UPDATE founder_automation_grants SET user_id=')){
     revoked=true;
     sql.prepare('UPDATE founder_automation_grants SET revoked_at=? WHERE email=?').run(Math.floor(vi.getRealSystemTime()/1000),owner.email);
    }
    return execute();
   };
   return statement;
  };
  const response=await settle(getWorkspaceState(request()));
  const body=await selectedView(response);
  expect(revoked).toBe(true);
  expect(body.automation).toEqual({active:false,enabled:false});
  expect(body.productivity!.daily.gestion).toBeNull();
  expect(body.productivity!.canCreateGestion).toBe(false);
  expect(sql.prepare('SELECT organization_id FROM founder_automation_grants WHERE email=?').get(owner.email)!.organization_id).toBeNull();
  expect(state.fetch).not.toHaveBeenCalled();
 });
});


describe('Error barriers around effectful entitlement resolution',()=>{
 it('does not bind an unbound offer after a platform secret decryption has already failed',async()=>{
  prepareUnboundAutomationOffer();
  sql.prepare("INSERT INTO support_platform_secrets(id,secret,updated_by,updated_at) VALUES('typesafe','invalid-synthetic-ciphertext','synthetic-owner',1)").run();
  await expect(settle(getWorkspaceState(request()))).rejects.toMatchObject({status:503});
  const grant=sql.prepare('SELECT organization_id,user_id FROM founder_automation_grants WHERE email=?').get(owner.email);
  expect(grant!.organization_id).toBeNull();
  expect(writes).toEqual([]);
  expect(state.fetch).not.toHaveBeenCalled();
 });
});

describe('Late pure-error barrier before productivity entitlement fallback',()=>{
 it('does not bind through productivity after Zendesk availability fails and Support delegation is unavailable',async()=>{
  prepareUnboundAutomationOffer();
  sql.prepare('UPDATE support_gestion_links SET connected_by=? WHERE workspace_id=?').run('unavailable-synthetic-connector',workspace);
  sql.prepare("INSERT INTO support_platform_secrets(id,secret,updated_by,updated_at) VALUES('zendesk-oauth','invalid-synthetic-ciphertext','synthetic-owner',1)").run();
  await expect(settle(getWorkspaceState(request()))).rejects.toMatchObject({status:503});
  const grant=sql.prepare('SELECT organization_id,user_id FROM founder_automation_grants WHERE email=?').get(owner.email);
  expect(grant!.organization_id).toBeNull();
  expect(writes).toEqual([]);
  expect(state.fetch).not.toHaveBeenCalled();
 });
});



