import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { supportWorkerFixture, supportWorkerSql } from './us-support-worker-test-fixture';
import { d1UsSupportWorkerStore } from './us-support-worker-d1';
import { createUsSupportTriageGrant } from './us-support-triage-policy';
import { d1UsSupportTriageStore } from './us-support-triage-d1';
import { d1UsSupportTicketStore } from './us-support-ticket-d1';

type Fixture = Awaited<ReturnType<typeof supportWorkerFixture>>;
type Wrapped = D1PreparedStatement & { text: string; real: D1PreparedStatement };
const opened: Fixture[] = [];
async function fixture(include = true) { const f = await supportWorkerFixture(include); opened.push(f); return f; }
afterEach(() => { for (const f of opened.splice(0)) { expect(f.sql.prepare('PRAGMA foreign_key_check').all()).toEqual([]); f.sql.close(); } });
function filtered(f: Fixture, omit: (text: string) => boolean, transform = (_text: string, args: unknown[]) => args): Pick<D1Database, 'prepare' | 'batch'> {
  return {
    prepare(text: string) {
      let real = f.database.prepare(text);
      const statement = { text, get real() { return real; }, bind(...args: unknown[]) { real = real.bind(...transform(text, args)); return statement; }, first: () => real.first(), all: () => real.all(), run: () => real.run() };
      return statement as unknown as Wrapped;
    },
    batch(statements) { return f.database.batch(statements.map(s => s as Wrapped).filter(s => !omit(s.text)).map(s => s.real)); },
  };
}
async function prepared(f: Fixture) {
  await f.enable(); const run = await f.acquire();
  await f.worker.discover(run.context, { offset: 0, nextOffset: null, references: [{ uid: '123', version: String(f.now()), receivedAt: f.now() }], issues: [] }, run.current);
  const item = (await f.worker.pending(run.context))[0];
  const q = f.request({ requestId: item.requestId, uid: item.uid, expectedMessageVersion: item.version! });
  await f.worker.prepare(run.context, { discoveryId: item.id, request: q }, run.current);
  return { ...run, q, item, source: f.source({ uid: q.uid, messageVersion: q.expectedMessageVersion, receivedAt: f.now() }) };
}
const count = (f: Fixture, table: string) => Number(f.sql.prepare('SELECT count(*) AS n FROM international_us_support_worker_' + table).get()!.n);
/** Replace only pilot-history count subqueries, retaining the production limits
 * and every authority/JSON/FK guard. This avoids creating 20,000 fake pages. */
function capacityCounts(f: Fixture) {
  const forced: Partial<Record<'delegations' | 'runs' | 'pages' | 'issues', number>> = {};
  f.sql.function('h4_capacity_count', (table, organizationId) => forced[String(table) as keyof typeof forced] ?? Number(f.sql.prepare('SELECT count(*) AS n FROM international_us_support_worker_' + String(table) + ' WHERE organization_id=?').get(organizationId)!.n));
  for (const row of f.sql.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'international_us_support_worker_%'").all()) {
    const original = String(row.sql), patched = original.replace(/\(SELECT count\(\*\) FROM international_us_support_worker_(delegations|runs|pages|issues) WHERE organization_id=NEW.organization_id\)/g, "h4_capacity_count('$1',NEW.organization_id)");
    if (patched !== original) f.sql.exec('DROP TRIGGER ' + String(row.name) + ';' + patched);
  }
  return forced;
}
function insertDeferral(f: Fixture, c: Awaited<ReturnType<Fixture['acquire']>>['context'], discoveryId: string, code = 'provider_unavailable') {
  return f.sql.prepare('INSERT INTO international_us_support_worker_deferrals(run_id,organization_id,workspace_id,discovery_id,code,context_json,created_at)VALUES(?,?,?,?,?,?,?)').run(c.authority.credential.runId, c.authority.organizationId, c.workspaceId, discoveryId, code, JSON.stringify(c), c.authority.checkedAt);
}

describe('H4 additive migration and SQL race fences on actual SQLite', () => {
  it('preserves populated human authority, source, dispatch, completion and ticket evidence', async () => {
    const f = await fixture(false), job = await f.completeJob();
    await f.tickets.commit(f.context(), f.ticketRequest(job.job.id), async () => f.context());
    const tables = ['international_saas_authorities', 'international_workspace_members', 'international_us_device_sessions', 'international_us_device_v4_sessions', 'international_us_support_workspaces', 'international_us_support_mailbox_receipts', 'international_us_support_mailbox_connections', 'international_us_support_mailbox_secrets', 'international_us_support_triage_jobs', 'international_us_support_triage_requests', 'international_us_support_triage_dispatches', 'international_us_support_triage_completions', 'international_us_support_tickets', 'international_us_support_ticket_commands', 'international_us_support_ticket_revisions', 'international_us_support_ticket_audit'];
    const snapshot = () => tables.map(name => ({ name, rows: f.sql.prepare('SELECT * FROM ' + name).all(), columns: f.sql.prepare('PRAGMA table_info(' + name + ')').all(), foreignKeys: f.sql.prepare('PRAGMA foreign_key_list(' + name + ')').all() }));
    const before = snapshot(); f.sql.exec(supportWorkerSql); expect(snapshot()).toEqual(before);
    expect((await f.tickets.read(f.context())).tickets).toHaveLength(1);
  });

  it.each(['pages', 'discovered'])('rolls back discovery, page proof and cursor if the %s effect is omitted', async table => {
    const f = await fixture(); await f.enable(); const run = await f.acquire();
    const store = d1UsSupportWorkerStore(filtered(f, text => text.startsWith('INSERT INTO international_us_support_worker_' + table + '(')), f.workerOptions);
    await expect(store.discover(run.context, { offset: 0, nextOffset: 20, references: [{ uid: '123', version: null, receivedAt: null }], issues: [] }, run.current)).rejects.toMatchObject({ status: 503 });
    for (const suffix of ['discovered', 'pages', 'reference_proofs']) expect(count(f, suffix)).toBe(0);
    expect((await f.worker.read(f.context())).scanOffset).toBe(0);
    await f.worker.discover(run.context, { offset: 0, nextOffset: 20, references: [{ uid: '123', version: null, receivedAt: null }], issues: [] }, run.current);
    expect(count(f, 'reference_proofs')).toBe(1);
  });

  it('allows an inert historical finish after revoke without releasing the replacement run', async () => {
    const f = await fixture(); await f.enable(); const old = await f.acquire();
    await f.worker.manage(f.context(), { schemaVersion: 1, requestId: randomUUID(), expectedRevision: 1, action: 'revoke' }, async () => f.context());
    await f.worker.manage(f.context(), f.manageRequest({ expectedRevision: 2 }), async () => f.context());
    const next = await f.acquire();
    await f.worker.finish(old.context, { outcome: 'revoked', nextDueAt: f.now() + 60 });
    expect(f.sql.prepare('SELECT lease_run_id FROM international_us_support_worker_heads').get()!.lease_run_id).toBe(next.lease.runId);
    expect((await next.current()).authority.credential.runId).toBe(next.lease.runId);
  });

  it('refuses a second autonomous reservation for a physical UID under a different recipe', async () => {
    const f = await fixture(), r = await prepared(f);
    await f.triage.claim(f.context(), { request: f.request({ uid: r.q.uid, expectedMessageVersion: r.q.expectedMessageVersion }), source: r.source, grant: { ...f.grant(), recipeVersion: 'historical-recipe' } }, async () => f.context());
    await expect(f.triage.claim(r.context, { request: r.q, source: r.source, grant: createUsSupportTriageGrant(r.context, f.policy) }, r.current)).rejects.toMatchObject({ code: 'triage_source_conflict', status: 409 });
    expect(f.sql.prepare('SELECT count(*) AS n FROM international_us_support_triage_jobs').get()!.n).toBe(1);
    expect((await f.triage.usage(f.context(), f.grant())).used).toBe(1);
  });

  it('requires the dispatch run for worker completion even after a fresh lease is acquired', async () => {
    const f = await fixture(), r = await prepared(f);
    const claimed = await f.triage.claim(r.context, { request: r.q, source: r.source, grant: createUsSupportTriageGrant(r.context, f.policy) }, r.current);
    const reference = { requestId: r.q.requestId, requestHash: claimed.requestHash, dispatchId: randomUUID() };
    await f.triage.dispatch(r.context, reference, r.current);
    await f.worker.finish(r.context, { outcome: 'uncertain', nextDueAt: f.now() });
    const next = await f.acquire();
    await expect(f.triage.complete(next.context, { ...reference, decision: f.decision() }, next.current)).rejects.toMatchObject({ status: 503 });
    expect(f.sql.prepare('SELECT count(*) AS n FROM international_us_support_triage_completions').get()!.n).toBe(0);
    expect(f.sql.prepare('SELECT count(*) AS n FROM international_us_support_triage_dispatches').get()!.n).toBe(1);
  });

  it('does not let a human request alias complete an execution dispatched by a worker', async () => {
    const f = await fixture(), r = await prepared(f);
    const claimed = await f.triage.claim(r.context, { request: r.q, source: r.source, grant: createUsSupportTriageGrant(r.context, f.policy) }, r.current);
    const reference = { requestId: r.q.requestId, requestHash: claimed.requestHash, dispatchId: randomUUID() };
    await f.triage.dispatch(r.context, reference, r.current);
    const humanRequest = f.request({ uid: r.q.uid, expectedMessageVersion: r.q.expectedMessageVersion });
    const human = await f.triage.claim(f.context(), { request: humanRequest, source: r.source, grant: f.grant() }, async () => f.context());
    await expect(f.triage.complete(f.context(), { requestId: humanRequest.requestId, requestHash: human.requestHash, dispatchId: reference.dispatchId, decision: f.decision() }, async () => f.context())).rejects.toMatchObject({ status: 503 });
    expect(f.sql.prepare('SELECT count(*) AS n FROM international_us_support_triage_completions').get()!.n).toBe(0);
  });

  it('caps new delegation versions while preserving revoke, read and receipt replay', async () => {
    const f = await fixture(), counts = capacityCounts(f), q = f.manageRequest(); counts.delegations = 999;
    await f.worker.manage(f.context(), q, async () => f.context()); counts.delegations = 1000;
    await expect(f.worker.manage(f.context(), f.manageRequest({ expectedRevision: 1 }), async () => f.context())).rejects.toMatchObject({ code: 'worker_capacity_exceeded' });
    const revoke = { schemaVersion: 1 as const, requestId: randomUUID(), expectedRevision: 1, action: 'revoke' as const };
    await f.worker.manage(f.context(), revoke, async () => f.context());
    expect((await f.worker.read(f.context())).status).toBe('revoked');
    expect((await f.worker.manage(f.context(), q, async () => f.context())).replayed).toBe(true);
    expect((await f.worker.manage(f.context(), revoke, async () => f.context())).replayed).toBe(true);
    expect(count(f, 'delegations')).toBe(2);
  });

  it('rejects a delegation with a missing action rather than accepting SQL null as consent', async () => {
    const f = await fixture();
    const store = d1UsSupportWorkerStore(filtered(f, () => false, (text, args) => {
      if (text.startsWith('INSERT INTO international_us_support_worker_delegations(')) {
        const q = JSON.parse(String(args[7])); delete q.action; args[7] = JSON.stringify(q);
      }
      return args;
    }), f.workerOptions);
    await expect(store.manage(f.context(), f.manageRequest(), async () => f.context())).rejects.toMatchObject({ code: 'invalid_worker_record', status: 503 });
    expect(count(f, 'delegations')).toBe(0); expect(count(f, 'heads')).toBe(0);
  });

  it('rejects worker attribution keys substituted for a nullable field in a human audit', async () => {
    const f = await fixture(), job = await f.completeJob();
    const tickets = d1UsSupportTicketStore(filtered(f, () => false, (text, args) => {
      if (text.startsWith('INSERT INTO international_us_support_ticket_audit(')) {
        const event = JSON.parse(String(args[1])); expect(event.assigneeMembershipId).toBeNull();
        delete event.assigneeMembershipId; event.actorKind = 'worker'; args[1] = JSON.stringify(event);
      }
      return args;
    }), { now: f.now });
    await expect(tickets.commit(f.context(), f.ticketRequest(job.job.id), async () => f.context())).rejects.toMatchObject({ code: 'invalid_ticket_record', status: 503 });
    for (const suffix of ['commands', 'audit', 'revisions']) expect(f.sql.prepare('SELECT count(*) AS n FROM international_us_support_ticket_' + suffix).get()!.n).toBe(0);
    expect(f.sql.prepare('SELECT count(*) AS n FROM international_us_support_tickets').get()!.n).toBe(0);
    expect((await f.tickets.commit(f.context(), f.ticketRequest(job.job.id), async () => f.context())).ticket.audit.events[0].actorKind).toBeUndefined();
  });

  it('caps run insertion at 10000 without closing historical finish or management reads', async () => {
    const f = await fixture(), counts = capacityCounts(f); await f.enable(); counts.runs = 9999;
    const r = await f.acquire(); counts.runs = 10000;
    await f.worker.finish(r.context, { outcome: 'capacity_blocked', nextDueAt: f.now() });
    await expect(f.worker.acquire({ runId: randomUUID() })).rejects.toMatchObject({ code: 'worker_capacity_exceeded' });
    expect((await f.worker.read(f.context())).revision).toBe(1);
    expect(count(f, 'runs')).toBe(1); expect(count(f, 'finishes')).toBe(1);
  });

  it('caps page insertion at 20000 atomically and still permits a run to drain pending', async () => {
    const f = await fixture(), counts = capacityCounts(f); await f.enable(); counts.pages = 19999;
    const r = await f.acquire(); await f.worker.discover(r.context, { offset: 0, nextOffset: 20, references: [], issues: [] }, r.current);
    counts.pages = 20000;
    await expect(f.worker.discover(r.context, { offset: 20, nextOffset: 40, references: [{ uid: '124', version: null, receivedAt: null }], issues: [] }, r.current)).rejects.toMatchObject({ code: 'worker_capacity_exceeded' });
    expect(count(f, 'discovered')).toBe(0); expect(count(f, 'pages')).toBe(1);
    expect((await f.worker.read(f.context())).scanOffset).toBe(20);
    await f.worker.finish(r.context, { outcome: 'partial', nextDueAt: f.now() });
    expect((await f.acquire()).context.authority.credential.kind).toBe('worker');
  });

  it('caps new issue observations at 2000 while allowing an already recorded issue', async () => {
    const f = await fixture(), counts = capacityCounts(f); await f.enable(); const r = await f.acquire(); counts.issues = 1999;
    const issue = { code: 'invalid_date', uid: null, fingerprint: 'a'.repeat(64) };
    await f.worker.discover(r.context, { offset: 0, nextOffset: 20, references: [], issues: [issue] }, r.current);
    counts.issues = 2000;
    await expect(f.worker.discover(r.context, { offset: 20, nextOffset: 40, references: [], issues: [{ ...issue, fingerprint: 'b'.repeat(64) }] }, r.current)).rejects.toMatchObject({ code: 'worker_capacity_exceeded' });
    expect(count(f, 'pages')).toBe(1); expect(count(f, 'issues')).toBe(1);
    await f.worker.discover(r.context, { offset: 20, nextOffset: 40, references: [], issues: [issue] }, r.current);
    expect(count(f, 'pages')).toBe(2); expect(count(f, 'issues')).toBe(1);
    await f.worker.finish(r.context, { outcome: 'partial', nextDueAt: f.now() });
    expect((await f.acquire()).context.authority.credential.kind).toBe('worker');
  });

  it('allows an immutable retry observation in a later live run for the original physical discovery', async () => {
    const f = await fixture(), r = await prepared(f);
    await f.worker.defer(r.context, { discoveryId: r.item.id, code: 'provider_unavailable' }, r.current);
    await f.worker.defer(r.context, { discoveryId: r.item.id, code: 'provider_unavailable' }, r.current);
    expect(count(f, 'deferrals')).toBe(1);
    expect(() => insertDeferral(f, r.context, r.item.id)).toThrow('us_worker_immutable');
    expect(() => f.sql.prepare('UPDATE international_us_support_worker_deferrals SET code=?').run('changed')).toThrow('us_worker_immutable');
    expect(() => f.sql.exec('DELETE FROM international_us_support_worker_deferrals')).toThrow('us_worker_immutable');
    await f.worker.finish(r.context, { outcome: 'partial', nextDueAt: f.now() });
    const next = await f.acquire(); await f.worker.defer(next.context, { discoveryId: r.item.id, code: 'provider_unavailable' }, next.current);
    expect(count(f, 'deferrals')).toBe(2); expect((await f.worker.pending(next.context))[0].request).toEqual(r.q);
  });

  it.each(['uncertain', 'rejected'] as const)('refuses retry observations for a discovery marked %s', async stage => {
    const f = await fixture(), r = await prepared(f);
    await f.worker.stage(r.context, { discoveryId: r.item.id, stage, jobId: null, code: 'provider_unavailable' }, r.current);
    expect(() => insertDeferral(f, r.context, r.item.id)).toThrow('us_worker_invalid_record'); expect(count(f, 'deferrals')).toBe(0);
  });

  it('refuses retry observations once the completed analysis has a recorded ticket', async () => {
    const f = await fixture(), r = await prepared(f);
    const claimed = await f.triage.claim(r.context, { request: r.q, source: r.source, grant: createUsSupportTriageGrant(r.context, f.policy) }, r.current);
    const reference = { requestId: r.q.requestId, requestHash: claimed.requestHash, dispatchId: randomUUID() };
    await f.triage.dispatch(r.context, reference, r.current);
    await f.triage.complete(r.context, { ...reference, decision: f.decision() }, r.current);
    await f.tickets.commit(r.context, f.ticketRequest(claimed.job.id), r.current);
    await f.worker.stage(r.context, { discoveryId: r.item.id, stage: 'ticketed', jobId: claimed.job.id, code: null }, r.current);
    expect(() => insertDeferral(f, r.context, r.item.id)).toThrow('us_worker_invalid_record'); expect(count(f, 'deferrals')).toBe(0);
  });

  it('refuses retry observations for absent references and revoked runs at the SQL boundary', async () => {
    const f = await fixture(), r = await prepared(f);
    expect(() => insertDeferral(f, r.context, randomUUID())).toThrow('us_worker_invalid_record');
    await f.worker.manage(f.context(), { schemaVersion: 1, requestId: randomUUID(), expectedRevision: 1, action: 'revoke' }, async () => f.context());
    expect(() => insertDeferral(f, r.context, r.item.id)).toThrow('us_worker_revoked'); expect(count(f, 'deferrals')).toBe(0);
  });

  it('rejects a source predating consent in SQL even if a caller bypasses the service preflight', async () => {
    const f = await fixture(), r = await prepared(f);
    const db = filtered(f, () => false, (text, args) => {
      if (text.startsWith('INSERT INTO international_us_support_triage_jobs(')) args[12] = JSON.stringify({ ...r.source, receivedAt: f.now() - 1 });
      return args;
    });
    const triage = d1UsSupportTriageStore(db, { now: f.now });
    await expect(triage.claim(r.context, { request: r.q, source: r.source, grant: createUsSupportTriageGrant(r.context, f.policy) }, r.current)).rejects.toMatchObject({ code: 'triage_source_conflict', status: 409 });
    expect((await f.triage.usage(f.context(), f.grant())).used).toBe(0);
  });

  it('refuses the first classifier dispatch for an old reservation after a later consent starts', async () => {
    const f = await fixture(), r = await prepared(f);
    const claimed = await f.triage.claim(r.context, { request: r.q, source: r.source, grant: createUsSupportTriageGrant(r.context, f.policy) }, r.current);
    const original = f.sql.prepare('SELECT command_id,actor_user_id FROM international_us_support_triage_requests WHERE job_id=?').get(claimed.job.id)!;
    await f.worker.manage(f.context(), { schemaVersion: 1, requestId: randomUUID(), expectedRevision: 1, action: 'revoke' }, async () => f.context());
    f.setNow(f.now() + 1); await f.worker.manage(f.context(), f.manageRequest({ expectedRevision: 2 }), async () => f.context());
    const next = await f.acquire(), c = next.context;
    expect(() => f.sql.prepare('INSERT INTO international_us_support_triage_dispatches(organization_id,workspace_id,job_id,dispatch_id,command_id,actor_user_id,context_json,created_at)VALUES(?,?,?,?,?,?,?,?)').run(c.authority.organizationId, c.workspaceId, claimed.job.id, randomUUID(), original.command_id, original.actor_user_id, JSON.stringify(c), c.authority.checkedAt)).toThrow('us_triage_connection_changed');
    expect(f.sql.prepare('SELECT count(*) AS n FROM international_us_support_triage_dispatches').get()!.n).toBe(0);
    expect((await f.triage.usage(f.context(), f.grant())).used).toBe(1);
  });
});
