import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ERP_SCHEMA_HEADER } from './erp-schema-capability';
import { UsSupportWorkspaceError } from './us-support-workspace-contract';
import { createUsSupportTicketHandlers, type UsSupportTicketDependencies } from './us-support-ticket-server';
import { type UsSupportRoutingRequest, type UsSupportTicketMutationResult, type UsSupportTicketRequest, type UsSupportTicketStore, type UsSupportTicketsProjection } from './us-support-ticket-contract';
import { supportTicketFixture } from './us-support-ticket-test-fixture';
import { d1UsTeamStore } from './us-team-store';
import { hashUsTeamCommand, hashUsTeamToken, newUsTeamToken } from './us-team-validation';
import type { UsTeamContext, UsTeamPrivateCommand } from './us-team-contract';
import type { UsSupportTriageDecision, UsSupportTriageSource } from './us-support-triage-contract';
import { d1UsSupportTicketStore } from './us-support-ticket-d1';

type Fixture = Awaited<ReturnType<typeof supportTicketFixture>>;
const opened: Fixture[] = [];
afterEach(() => { for (const f of opened.splice(0)) { expect(f.sql.prepare('PRAGMA foreign_key_check').all()).toEqual([]); f.sql.close(); } });

async function addMember(f: Fixture, role: 'admin' | 'member' | 'accountant' | 'read_only') {
  const a = f.context().authority, userId = randomUUID(), email = userId + '@example.test';
  const owner: UsTeamContext = { schemaVersion: 1, organizationId: a.organizationId, mode: 'member', role: 'owner', user: { userId: a.userId, email: null, emailConfirmed: false },
    subscriptionId: a.subscriptionId, environment: a.environment, catalogVersion: a.catalogVersion, priceId: a.priceId, seatLimit: a.seatLimit,
    checkedAt: f.now(), validStartsAt: a.validStartsAt, validEndsAt: a.validEndsAt, credential: a.credential };
  const team = d1UsTeamStore(f.database, { now: f.now }), invitationId = randomUUID(), membershipId = randomUUID(), tokenHash = await hashUsTeamToken(newUsTeamToken());
  const invite: UsTeamPrivateCommand = { schemaVersion: 1, requestId: randomUUID(), expectedTeamRevision: await team.revision(owner), action: 'create_invitation', email, role, invitationId, tokenHash, expiresAt: f.now() + 604800 };
  await team.commit({ context: owner, command: invite, requestHash: await hashUsTeamCommand(a.organizationId, a.userId, invite) });
  const recipient: UsTeamContext = { ...owner, mode: 'recipient', role, user: { userId, email, emailConfirmed: true } };
  const accept: UsTeamPrivateCommand = { schemaVersion: 1, requestId: randomUUID(), expectedTeamRevision: await team.revision(owner), action: 'accept_invitation', invitationId, tokenHash, membershipId, firstName: 'Synthetic', lastName: role, displayName: 'Synthetic ' + role };
  await team.commit({ context: recipient, command: accept, requestHash: await hashUsTeamCommand(a.organizationId, userId, accept) });
  return { userId, membershipId, role, async revoke() {
    const command: UsTeamPrivateCommand = { schemaVersion: 1, requestId: randomUUID(), expectedTeamRevision: await team.revision(owner), action: 'revoke_member', membershipId };
    await team.commit({ context: owner, command, requestHash: await hashUsTeamCommand(a.organizationId, a.userId, command) });
  } };
}

/** Full local migration chain and both H3a/H3b D1 stores. Auth identity is
 * synthetic; no provider/network call or mailbox content is needed by H3b. */
async function fixture() {
  const f = await supportTicketFixture(); opened.push(f);
  const org = f.intent.organizationId; let actor: string = f.actor; let gate = true, serial = 123;
  let store: UsSupportTicketStore = f.tickets;
  const d: UsSupportTicketDependencies = { enabled: async () => gate, now: f.now,
    member: vi.fn(async (_request, organizationId) => {
      if (organizationId !== org || !f.sql.prepare('SELECT role FROM international_workspace_members WHERE organization_id=? AND user_id=? AND revoked_at IS NULL').get(org, actor)) throw new UsSupportWorkspaceError('forbidden', 403);
      return f.context(actor);
    }), store: async () => store, diagnostic: vi.fn() };
  const handlers = createUsSupportTicketHandlers(d);
  const request = (body?: unknown, suffix = '', headers: Record<string, string> = {}) => new Request(`https://zentra.test/api/international/workspaces/${org}/support-tickets${suffix}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { Origin: 'https://zentra.test', 'Content-Type': 'application/json', [ERP_SCHEMA_HEADER]: '4', 'X-Zentra-Expected-User': actor, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const write = (q: UsSupportTicketRequest | Record<string, unknown>) => handlers.write(request(q), org);
  const read = async () => { const response = await handlers.read(request(), org); expect(response.status).toBe(200); return await response.json() as UsSupportTicketsProjection; };
  const create = (jobId: string): UsSupportTicketRequest => ({ schemaVersion: 1, requestId: randomUUID(), action: 'create', jobId });
  const routing = async (routes: UsSupportRoutingRequest['routes'], patch: Partial<UsSupportRoutingRequest> = {}) => {
    const current = await read(), q: UsSupportRoutingRequest = { schemaVersion: 1, requestId: randomUUID(), expectedRevision: current.routing.revision, enabled: true, threshold: 0.9, routes, ...patch };
    return handlers.routing(request(q), org);
  };
  const complete = async (sourcePatch: Partial<UsSupportTriageSource> = {}, decisionPatch: Partial<UsSupportTriageDecision> = {}, state: 'reserved' | 'uncertain' | 'completed' = 'completed') => {
    const uid = String(serial++), source = f.source({ uid, ...sourcePatch }), q = f.request({ uid: source.uid, expectedMessageVersion: source.messageVersion }), grant = f.grant();
    const reserved = await f.triage.claim(f.context(), { request: q, source, grant }, async () => f.context());
    if (state === 'reserved') return reserved;
    const dispatchId = randomUUID(); await f.triage.dispatch(f.context(), { requestId: reserved.requestId, requestHash: reserved.requestHash, dispatchId }, async () => f.context());
    if (state === 'uncertain') return f.triage.uncertain(f.context(), { requestId: reserved.requestId, requestHash: reserved.requestHash, dispatchId }, async () => f.context());
    const decision = f.decision(decisionPatch);
    return f.triage.complete(f.context(), { requestId: reserved.requestId, requestHash: reserved.requestHash, dispatchId, decision }, async () => f.context());
  };
  return { f, org, d, handlers, request, write, read, create, routing, complete, actor: (userId: string) => { actor = userId; }, setStore: (value: UsSupportTicketStore) => { store = value; }, gate: (value: boolean) => { gate = value; } };
}
async function confirmed(response: Response): Promise<UsSupportTicketMutationResult> { expect(response.status, await response.clone().text()).toBe(200); return await response.json() as UsSupportTicketMutationResult; }

describe('US Support tickets HTTP + real SQLite H3a/H3b composition', () => {
  it('creates once from durable provenance, automatically assigns a current rule and replays after mailbox disconnect', async () => {
    const t = await fixture(), member = await addMember(t.f, 'member'), beforeTicketWork = t.f.snapshot();
    expect((await t.routing([{ category: 'billing', membershipId: member.membershipId }])).status).toBe(200);
    const job = await t.complete(), q = t.create(job.job.id), first = await confirmed(await t.write(q));
    expect(first).toMatchObject({ replayed: false, ticket: { originJobId: job.job.id, revision: 1, category: 'billing', assigneeMembershipId: member.membershipId, assigneeActive: true, humanCorrection: false, status: 'open', audit: { total: 1 } } });
    expect(first.ticket.originalDecision).toEqual(job.job.result);
    await t.f.mailbox.commit(t.f.context(), { schemaVersion: 1, requestId: randomUUID(), action: 'disconnect', expectedRevision: 1 }, async () => t.f.context());
    const replay = await confirmed(await t.write(q)); expect(replay.receipt).toEqual(first.receipt); expect(replay.replayed).toBe(true);
    const projection = await t.read(); expect(projection.tickets).toHaveLength(1); expect(projection.tickets[0].audit.total).toBe(1);
    const text = JSON.stringify(projection); for (const privateValue of ['mailbox-test', 'inbox-test', 'messageSha256', 'sourceHash', 'credentialsCiphertext', 'context_json', 'grant_json']) expect(text).not.toContain(privateValue);
    expect(t.f.snapshot()).toEqual(beforeTicketWork); expect(t.f.sql.prepare('SELECT * FROM support_workspaces').all()).toEqual(t.f.legacyBefore);
  });
  it('concurrent new commands for the same completed source return one ticket and one creation audit', async () => {
    const t = await fixture(), job = await t.complete();
    const responses = await Promise.all([t.write(t.create(job.job.id)), t.write(t.create(job.job.id))]);
    const results = await Promise.all(responses.map(confirmed)); expect(results[0].ticket.id).toBe(results[1].ticket.id);
    const p = await t.read(); expect(p.tickets).toHaveLength(1); expect(p.tickets[0].audit.total).toBe(1);
  });
  it.each(['reserved', 'uncertain'] as const)('refuses an actually %s H3a job without creating a ticket', async state => {
    const t = await fixture(), job = await t.complete({}, {}, state), response = await t.write(t.create(job.job.id));
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: 'ticket_source_not_completed' }); expect((await t.read()).tickets).toEqual([]);
  });
  it('refuses absent and foreign-company jobs without importing their decision', async () => {
    const a = await fixture(), b = await fixture(), foreign = await b.complete();
    for (const id of [randomUUID(), foreign.job.id]) { const response = await a.write(a.create(id)); expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: 'ticket_source_not_completed' }); }
    expect((await a.read()).tickets).toEqual([]);
  });
  it.each([
    { source: { attachmentCount: 1 }, decision: { reviewReasons: ['unread_attachments'], needsReview: true } },
    { source: { bodyComplete: false }, decision: { reviewReasons: ['incomplete_body'], needsReview: true } },
    { source: {}, decision: { languageConfidence: 0.5, reviewReasons: ['low_confidence'], needsReview: true } },
    { source: {}, decision: { humanRequested: 0.2, reviewReasons: ['human_requested'], needsReview: true } },
    { source: {}, decision: { category: 'other', reviewReasons: ['other_category'], needsReview: true } },
  ] as const)('preserves mandatory review and never automatically assigns %j', async item => {
    const t = await fixture(), member = await addMember(t.f, 'member'); expect((await t.routing([{ category: 'billing', membershipId: member.membershipId }, { category: 'other', membershipId: member.membershipId }])).status).toBe(200);
    const job = await t.complete(item.source, item.decision), result = await confirmed(await t.write(t.create(job.job.id)));
    expect(result.ticket).toMatchObject({ assigneeMembershipId: null, needsReview: true, reviewReasons: item.decision.reviewReasons }); expect(result.ticket.originalDecision).toEqual(job.job.result);
  });
  it('requires the current routing threshold in addition to a clean historic H3a decision', async () => {
    const t = await fixture(), member = await addMember(t.f, 'member'); expect((await t.routing([{ category: 'billing', membershipId: member.membershipId }], { threshold: 0.99 })).status).toBe(200);
    const result = await confirmed(await t.write(t.create((await t.complete()).job.id))); expect(result.ticket.assigneeMembershipId).toBeNull();
  });
  it('a revoked saved rule target is never assigned and its prior assignment becomes visibly inactive', async () => {
    const t = await fixture(), member = await addMember(t.f, 'member'); expect((await t.routing([{ category: 'billing', membershipId: member.membershipId }])).status).toBe(200);
    const prior = await confirmed(await t.write(t.create((await t.complete()).job.id))); await member.revoke();
    const next = await confirmed(await t.write(t.create((await t.complete()).job.id))); expect(next.ticket.assigneeMembershipId).toBeNull();
    expect((await t.read()).tickets.find(ticket => ticket.id === prior.ticket.id)).toMatchObject({ assigneeMembershipId: member.membershipId, assigneeActive: false });
  });
  it('corrects and reassigns with immutable classifier provenance and an append-only audit', async () => {
    const t = await fixture(), member = await addMember(t.f, 'member'), admin = await addMember(t.f, 'admin'), job = await t.complete();
    const first = await confirmed(await t.write(t.create(job.job.id))); t.actor(admin.userId);
    const corrected = await confirmed(await t.write({ schemaVersion: 1, requestId: randomUUID(), action: 'correct', ticketId: first.ticket.id, expectedRevision: 1, category: 'bug', priority: 'urgent', language: 'fr' }));
    expect(corrected.ticket).toMatchObject({ revision: 2, category: 'bug', priority: 'urgent', language: 'fr', humanCorrection: true, correctedBy: admin.userId }); expect(corrected.ticket.originalDecision).toEqual(job.job.result);
    const assigned = await confirmed(await t.write({ schemaVersion: 1, requestId: randomUUID(), action: 'assign', ticketId: first.ticket.id, expectedRevision: 2, assigneeMembershipId: member.membershipId }));
    expect(assigned.ticket.audit.events.map(event => event.action)).toEqual(['assign', 'correct', 'create']); expect(assigned.ticket.audit.total).toBe(3);
    t.actor(t.f.actor); const duplicate = await confirmed(await t.write(t.create(job.job.id))); expect(duplicate.ticket).toMatchObject({ revision: 3, category: 'bug', assigneeMembershipId: member.membershipId }); expect(duplicate.ticket.originalDecision).toEqual(job.job.result);
  });
  it('members transition only their own currently assigned ticket and cannot correct, assign, create or edit rules', async () => {
    const t = await fixture(), own = await addMember(t.f, 'member'), other = await addMember(t.f, 'member');
    expect((await t.routing([{ category: 'billing', membershipId: own.membershipId }])).status).toBe(200);
    const first = await confirmed(await t.write(t.create((await t.complete()).job.id))), id = first.ticket.id; t.actor(other.userId);
    expect((await t.write({ schemaVersion: 1, requestId: randomUUID(), action: 'set_status', ticketId: id, expectedRevision: 1, status: 'in_progress' })).status).toBe(403);
    t.actor(own.userId); const moved = await confirmed(await t.write({ schemaVersion: 1, requestId: randomUUID(), action: 'set_status', ticketId: id, expectedRevision: 1, status: 'in_progress' })); expect(moved.ticket.status).toBe('in_progress');
    for (const q of [t.create(randomUUID()), { schemaVersion: 1, requestId: randomUUID(), action: 'correct', ticketId: id, expectedRevision: 2, category: 'bug', priority: 'high', language: 'en' }, { schemaVersion: 1, requestId: randomUUID(), action: 'assign', ticketId: id, expectedRevision: 2, assigneeMembershipId: own.membershipId }]) expect((await t.write(q)).status).toBe(403);
    expect((await t.routing([])).status).toBe(403); expect((await t.read()).tickets[0].revision).toBe(2);
  });
  it.each(['accountant', 'read_only'] as const)('%s can read shared tickets and head, but cannot mutate or become a target', async role => {
    const t = await fixture(), member = await addMember(t.f, role), first = await confirmed(await t.write(t.create((await t.complete()).job.id)));
    expect((await t.routing([{ category: 'billing', membershipId: member.membershipId }])).status).toBe(409);
    t.actor(member.userId); expect((await t.read()).tickets).toHaveLength(1); expect((await t.handlers.head(t.request(), t.org)).status).toBe(200);
    expect((await t.write({ schemaVersion: 1, requestId: randomUUID(), action: 'set_status', ticketId: first.ticket.id, expectedRevision: 1, status: 'resolved' })).status).toBe(403); expect((await t.routing([])).status).toBe(403);
  });
  it('rejects a stale human edit rather than overwriting a newer assignment', async () => {
    const t = await fixture(), member = await addMember(t.f, 'member'), first = await confirmed(await t.write(t.create((await t.complete()).job.id)));
    await confirmed(await t.write({ schemaVersion: 1, requestId: randomUUID(), action: 'assign', ticketId: first.ticket.id, expectedRevision: 1, assigneeMembershipId: member.membershipId }));
    const stale = await t.write({ schemaVersion: 1, requestId: randomUUID(), action: 'correct', ticketId: first.ticket.id, expectedRevision: 1, category: 'bug', priority: 'urgent', language: 'en' });
    expect(stale.status).toBe(409); expect(await stale.json()).toEqual({ error: 'ticket_revision_conflict' }); expect((await t.read()).tickets[0]).toMatchObject({ revision: 2, category: 'billing', assigneeMembershipId: member.membershipId });
  });
  it('a completed historical recipe cannot create a second ticket or replace a human correction', async () => {
    const t = await fixture(), firstJob = await t.complete(), first = await confirmed(await t.write(t.create(firstJob.job.id)));
    const corrected = await confirmed(await t.write({ schemaVersion: 1, requestId: randomUUID(), action: 'correct', ticketId: first.ticket.id, expectedRevision: 1, category: 'bug', priority: 'urgent', language: 'fr' }));
    const source = firstJob.job.source, q = t.f.request({ uid: source.uid, expectedMessageVersion: source.messageVersion }), grant = { ...t.f.grant(), recipeVersion: 'us-support-text:historical-recipe-v0' };
    const claimed = await t.f.triage.claim(t.f.context(), { request: q, source, grant }, async () => t.f.context()), dispatchId = randomUUID();
    const reference = { requestId: claimed.requestId, requestHash: claimed.requestHash, dispatchId }; await t.f.triage.dispatch(t.f.context(), reference, async () => t.f.context());
    const other = await t.f.triage.complete(t.f.context(), { ...reference, decision: t.f.decision({ recipeVersion: grant.recipeVersion }) }, async () => t.f.context());
    const duplicate = await confirmed(await t.write(t.create(other.job.id))); expect(duplicate.ticket.id).toBe(first.ticket.id);
    expect(duplicate.ticket).toMatchObject({ revision: 2, originJobId: firstJob.job.id, category: 'bug', priority: 'urgent', language: 'fr', correctedBy: t.f.actor });
    expect(duplicate.ticket.originalDecision).toEqual(corrected.ticket.originalDecision); expect((await t.read()).tickets).toHaveLength(1);
  });
  it('fresh actor revocation after SQL read suppresses the complete shared projection', async () => {
    const t = await fixture(), admin = await addMember(t.f, 'admin'); await confirmed(await t.write(t.create((await t.complete()).job.id))); t.actor(admin.userId);
    t.setStore({ ...t.f.tickets, async read(...args) { const result = await t.f.tickets.read(...args); await admin.revoke(); return result; } });
    const response = await t.handlers.read(t.request(), t.org); expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: 'forbidden' });
  });
  it('rechecks an explicit target revoked after HTTP admission and before the real commit', async () => {
    const t = await fixture(), member = await addMember(t.f, 'member'), first = await confirmed(await t.write(t.create((await t.complete()).job.id)));
    t.setStore({ ...t.f.tickets, async commit(...args) { await member.revoke(); return t.f.tickets.commit(...args); } });
    const response = await t.write({ schemaVersion: 1, requestId: randomUUID(), action: 'assign', ticketId: first.ticket.id, expectedRevision: 1, assigneeMembershipId: member.membershipId });
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: 'ticket_assignee_unavailable' });
    expect((await t.read()).tickets[0]).toMatchObject({ revision: 1, assigneeMembershipId: null });
  });
  it.each(['source_hash', 'result_sha256'] as const)('rejects compromised private H3a %s returned by storage', async field => {
    const t = await fixture(), job = await t.complete();
    const database: Pick<D1Database, 'prepare' | 'batch'> = { batch: t.f.database.batch.bind(t.f.database), prepare(query) {
      const original = t.f.database.prepare(query); if (!query.includes('SELECT j.*,d.dispatch_id')) return original;
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement => ({
        bind: (...values: unknown[]) => wrap(statement.bind(...values)),
        first: async (column?: string) => { const value = column === undefined ? await statement.first() : await statement.first(column); return value && typeof value === 'object' ? { ...value, [field]: '0'.repeat(64) } : value; },
        all: statement.all.bind(statement), run: statement.run.bind(statement),
      }) as D1PreparedStatement;
      return wrap(original);
    } };
    t.setStore(d1UsSupportTicketStore(database, { now: t.f.now }));
    const response = await t.write(t.create(job.job.id)); expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'invalid_ticket_record' });
    expect((await t.read()).tickets).toEqual([]);
  });
  it('rejects a foreign-company route target and stale routing edits without changing saved rules', async () => {
    const a = await fixture(), b = await fixture(), foreign = await addMember(b.f, 'member');
    expect((await a.routing([{ category: 'billing', membershipId: foreign.membershipId }])).status).toBe(409);
    expect((await a.routing([])).status).toBe(200);
    const stale = await a.routing([], { expectedRevision: 0 }); expect(stale.status).toBe(409); expect((await a.read()).routing.revision).toBe(1);
  });
  it('rejects browser-supplied source/decision/assignment material on a create command', async () => {
    const t = await fixture(), q = t.create((await t.complete()).job.id);
    for (const patch of [{ source: t.f.source() }, { decision: t.f.decision() }, { assigneeMembershipId: randomUUID() }, { body: 'Injected mail body' }, { jobId: '../../private' }]) expect((await t.write({ ...q, ...patch })).status).toBe(422);
    expect((await t.read()).tickets).toEqual([]);
  });
});
