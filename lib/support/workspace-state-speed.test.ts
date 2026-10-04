import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

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
import { gestionLinkState } from '@/lib/supplier-inbox/service';
import { getWorkspaceState } from './service';

const owner = { userId: 'speed-owner', email: 'speed-owner@example.test', displayName: 'Synthetic owner', provider: 'supabase', emailConfirmed: true };
const other = { userId: 'foreign-owner', email: 'foreign-owner@example.test', displayName: 'Other synthetic owner', provider: 'supabase', emailConfirmed: true };
let sql: DatabaseSync;
let workspace: string;
let organization: string;
let latency: number;
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
  const execute = () => ({ success: true, meta: { changes: Number(sql.prepare(query).run(...values).changes) } });
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
type SupportView = {
  platformOwner: boolean;
  user: { email: string };
  workspace: { id: string; canManage: boolean };
  workspaces: { id: string }[];
  tickets: { id: string }[];
  connections: { id: string }[];
  counts: { total: number };
  billing: { active: boolean; plan: string; status: string; limit: number };
  gestion: { organizationId: string | null; organizationName: string | null; choices: { id: string }[] };
  automation: { active: boolean; enabled: boolean };
  productivity: unknown;
};
const request = (query = '') => new Request(`https://zentraapp.ch/api/support${query}`);

beforeEach(async () => {
  vi.resetAllMocks();
  state.user = owner;
  latency = 0;
  reads = [];
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
  latency = 100;
  vi.useFakeTimers();
  state.fetch.mockRejectedValue(new Error('No real network is allowed in this deterministic test'));
  vi.stubGlobal('fetch', state.fetch);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); sql.close(); });

describe('Support workspace read latency and access boundaries', () => {
  it('overlaps independent reads after workspace selection without changing the ordinary complete-trial state', async () => {
    const startedAt = Date.now();
    const response = await settle(getWorkspaceState(request()));
    const durationMs = Date.now() - startedAt;
    const body = await response.json() as SupportView;
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(body.platformOwner).toBe(false);
    expect(body.user.email).toBe(owner.email);
    expect(body.workspaces.map(item => item.id)).toEqual([workspace]);
    expect(body.workspace).toMatchObject({ id: workspace, canManage: true });
    expect(body.tickets.map(item => item.id)).toEqual(['own-ticket']);
    expect(body.connections.map(item => item.id)).toEqual(['own-connection']);
    expect(body.counts.total).toBe(1);
    expect(body.billing).toMatchObject({ active: true, status: 'trialing', plan: 'team', limit: 250 });
    expect(body.gestion).toMatchObject({ organizationId: organization, organizationName: 'Synthetic trial company' });
    expect(body.gestion.choices).toEqual([{ id: organization, name: 'Synthetic trial company' }]);
    expect(body.automation).toEqual({ active: true, enabled: false });
    expect(body.productivity).not.toBeNull();
    expect(state.fetch).not.toHaveBeenCalled();
    const authorized = reads.find(read => read.query.includes('WITH actor AS'))!;
    const scoped = reads.filter(read => read.query.includes('FROM support_connections WHERE workspace_id=') || read.query.includes('FROM support_tickets t WHERE workspace_id='));
    expect(scoped.length).toBe(2);
    expect(scoped.every(read => read.startedAt >= authorized.finishedAt!)).toBe(true);
    const receipt = { model: '100 ms per real SQLite SELECT, deterministic fake-clock dependency proof, not measured production latency', durationMs, readCount: reads.length, membershipReads: reads.filter(read => membershipQuery(read.query)).length, authorizedReadsFirst: true, tenantScopedTickets: true, ordinaryTrial: true, realNetworkCalls: state.fetch.mock.calls.length };
    if (process.env.ZENTRA_SPEED_PROOF_FILE) writeFileSync(process.env.ZENTRA_SPEED_PROOF_FILE, JSON.stringify(receipt, null, 2));
    // The unmodified source takes 3200ms in this same deterministic SELECT
    // model. Preserve effect/error barriers while shortening that path by at
    // least 20%; this is not a production response-time promise.
    expect(durationMs, JSON.stringify(receipt)).toBeLessThanOrEqual(3200 * 0.8);
  });

  it('reads the current membership list once when a managing workspace is linked', async () => {
    const view = await settle(gestionLinkState(workspace, owner.userId, true));
    expect(view).toMatchObject({ linked: true, organizationId: organization, organizationName: 'Synthetic trial company', role: 'owner' });
    expect(reads.filter(read => membershipQuery(read.query))).toHaveLength(1);
  });

  it('does not read private workspace data for a guessed workspace', async () => {
    await expect(settle(getWorkspaceState(request('?workspace=foreign-workspace')))).rejects.toMatchObject({ status: 404 });
    expect(reads.some(read => read.query.includes('FROM support_connections WHERE workspace_id='))).toBe(false);
    expect(reads.some(read => read.query.includes('FROM support_tickets t WHERE workspace_id='))).toBe(false);
    expect(state.fetch).not.toHaveBeenCalled();
  });

  it('does not fall back to another company when a deep link has no accessible linked workspace', async () => {
    await expect(settle(getWorkspaceState(request(`?workspace=${workspace}&organizationId=foreign-organization`)))).rejects.toMatchObject({ status: 404 });
    expect(reads.some(read => read.query.includes('FROM support_connections WHERE workspace_id='))).toBe(false);
  });

  it('rejects an absent session before any D1 read', async () => {
    state.user = null;
    await expect(settle(getWorkspaceState(request()))).rejects.toMatchObject({ status: 401 });
    expect(reads).toHaveLength(0);
  });

  it('uses a fresh user and membership on the next request with no cross-account cache', async () => {
    const first = await settle(getWorkspaceState(request()));
    expect((await first.json() as SupportView).gestion.organizationId).toBe(organization);
    state.user = other;
    const next = await settle(getWorkspaceState(request()));
    const body = await next.json() as SupportView;
    expect(body.user.email).toBe(other.email);
    expect(body.workspace.id).toBe('foreign-workspace');
    expect(body.workspaces.map(item => item.id)).toEqual(['foreign-workspace']);
    expect(body.gestion).toMatchObject({ organizationId: null, organizationName: null, choices: [] });
    expect(body.billing.active).toBe(false);
    expect(body.tickets).toEqual([]);
    expect(body.connections.map(item => item.id)).toEqual(['foreign-connection']);
    expect(state.fetch).not.toHaveBeenCalled();
  });

  it('keeps expired trial tickets, events and productivity hidden', async () => {
    const now = Math.floor(Date.now() / 1000);
    sql.prepare('UPDATE account_trials SET started_at=?,ends_at=?').run(now - 15 * 86400, now - 1);
    const response = await settle(getWorkspaceState(request()));
    const body = await response.json() as SupportView;
    expect(body.billing).toMatchObject({ active: false, status: 'trial_expired' });
    expect(body.tickets).toEqual([]);
    expect(body.counts.total).toBe(0);
    expect(body.productivity).toBeNull();
    expect(reads.some(read => read.query.includes('FROM support_followups f'))).toBe(false);
  });

  it('does not expose a focused ticket from another workspace', async () => {
    await expect(settle(getWorkspaceState(request('?ticket=foreign-ticket')))).rejects.toMatchObject({ status: 404 });
  });
});
