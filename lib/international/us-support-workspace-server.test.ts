import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createUsSupportWorkspaceHandlers, type UsSupportWorkspaceDependencies } from './us-support-workspace-server';
import { UsSupportWorkspaceError, hashUsSupportWorkspaceRequest, type UsSupportWorkspace, type UsSupportWorkspaceContext, type UsSupportWorkspaceProjection, type UsSupportWorkspaceResult, type UsSupportWorkspaceStore } from './us-support-workspace-contract';

function setup() {
  const org = randomUUID(), user = randomUUID(), now = 1791600000;
  let context: UsSupportWorkspaceContext = { schemaVersion: 1, organizationId: org, userId: user, ownerUserId: user, role: 'owner', subscriptionId: 'sub_TEST', environment: 'TEST', catalogVersion: 'test-v1', priceId: 'price_Test', authorityReference: 'in_Test', validStartsAt: now - 100, validEndsAt: now + 1000, seatLimit: 3, checkedAt: now, credential: { kind: 'browser' } };
  let workspace: UsSupportWorkspace | null = null, enabled = true;
  const receipts = new Map<string, { hash: string; value: UsSupportWorkspaceResult }>();
  const store: {
    read: (...args: Parameters<UsSupportWorkspaceStore['read']>) => ReturnType<UsSupportWorkspaceStore['read']>;
    create: (...args: Parameters<UsSupportWorkspaceStore['create']>) => ReturnType<UsSupportWorkspaceStore['create']>;
  } = {
    read: vi.fn(async () => workspace),
    create: vi.fn(async (actor, request, revalidate) => {
      await revalidate();
      const key = actor.organizationId + ':' + actor.userId + ':' + request.requestId, hash = await hashUsSupportWorkspaceRequest(actor.organizationId, actor.userId, request), prior = receipts.get(key);
      if (prior) { if (prior.hash !== hash) throw new UsSupportWorkspaceError('support_idempotency_conflict', 409); return { ...prior.value, replayed: true }; }
      if (workspace && workspace.name !== request.name) throw new UsSupportWorkspaceError('support_workspace_conflict', 409);
      workspace ??= { schemaVersion: 1, organizationId: actor.organizationId, workspaceId: randomUUID(), ownerUserId: actor.ownerUserId, connectedBy: actor.userId, name: request.name, revision: 1, createdAt: now };
      const value = { workspace, receipt: { schemaVersion: 1 as const, organizationId: org, requestId: request.requestId, workspaceId: workspace.workspaceId, actorUserId: actor.userId, createdAt: now }, replayed: false };
      receipts.set(key, { hash, value }); return value;
    }),
  };
  const dependencies: UsSupportWorkspaceDependencies = { enabled: async () => enabled, now: () => now, member: async () => context, store: async () => store, diagnostic: vi.fn() };
  const handlers = createUsSupportWorkspaceHandlers(dependencies);
  const input = () => ({ schemaVersion: 1, requestId: randomUUID(), name: 'Example Support' });
  const request = (body?: unknown, headers: Record<string, string> = {}) => new Request('https://zentra.example.test/api/support-workspace', { method: body === undefined ? 'GET' : 'POST', headers: { Origin: 'https://zentra.example.test', 'Content-Type': 'application/json', 'X-Zentra-Expected-User': context.userId, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { org, user, now, store, receipts, dependencies, handlers, input, request, context: () => context, actor: (v: UsSupportWorkspaceContext) => { context = v; }, enabled: (v: boolean) => { enabled = v; } };
}
describe('US Support registry HTTP, explicitly fictitious Auth and RAM storage', () => {
  it('reads private honest readiness without giving a mailbox or quota', async () => {
    const t = setup(), r = await t.handlers.read(t.request(), t.org);
    expect(r.status).toBe(200); expect(r.headers.get('Cache-Control')).toContain('no-store'); expect(r.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(await r.json()).toEqual({ schemaVersion: 1, organizationId: t.org, userId: t.user, role: 'owner', canCreate: true, stage: 'registry_only', mailboxAvailable: false, classificationAvailable: false, workspace: null });
  });
  it('creates and recovers the same receipt after a lost HTTP acknowledgement', async () => {
    const t = setup(), q = t.input();
    const first = await t.handlers.create(t.request(q), t.org), one = await first.json() as { projection: UsSupportWorkspaceProjection; receipt: unknown; replayed: boolean };
    expect(first.status).toBe(200); expect(one.projection.canCreate).toBe(false); expect(one.projection.workspace?.name).toBe(q.name);
    const second = await t.handlers.create(t.request(q), t.org), two = await second.json();
    expect(two).toEqual({ ...one, replayed: true }); expect(t.receipts.size).toBe(1);
  });
  it('same request with changed material is a conflict and never renames', async () => {
    const t = setup(), q = t.input(); await t.handlers.create(t.request(q), t.org);
    expect((await t.handlers.create(t.request({ ...q, name: 'Other space' }), t.org)).status).toBe(409); expect(t.receipts.size).toBe(1);
  });
  it.each(['accountant','member','read_only'] as const)('%s can read admitted Support metadata but cannot create', async role => {
    const t = setup(); t.actor({ ...t.context(), userId: randomUUID(), role });
    const read = await t.handlers.read(t.request(), t.org); expect(read.status).toBe(200); expect(await read.json()).toMatchObject({ role, canCreate: false });
    expect((await t.handlers.create(t.request(t.input()), t.org)).status).toBe(403); expect(t.store.create).not.toHaveBeenCalled();
  });
  it('current admin can prepare under the real owner', async () => {
    const t = setup(), admin = randomUUID(); t.actor({ ...t.context(), userId: admin, role: 'admin' });
    const r = await t.handlers.create(t.request(t.input()), t.org); expect(r.status).toBe(200); expect(await r.json()).toMatchObject({ projection: { workspace: { ownerUserId: t.user, connectedBy: admin } } });
  });
  it.each([401,402,403] as const)('fresh admission denial %s reads no registry', async status => {
    const t = setup(); t.dependencies.member = async () => { throw new UsSupportWorkspaceError(status === 401 ? 'unauthorized' : status === 402 ? 'subscription_required' : 'forbidden', status); };
    expect((await t.handlers.read(t.request(), t.org)).status).toBe(status); expect(t.store.read).not.toHaveBeenCalled();
  });
  it('a closed gate calls no Auth or persistence', async () => {
    const t = setup(); t.enabled(false); const member = vi.fn(t.dependencies.member.bind(t.dependencies)); t.dependencies.member = member;
    expect((await t.handlers.create(t.request(t.input()), t.org)).status).toBe(404); expect(member).not.toHaveBeenCalled(); expect(t.store.create).not.toHaveBeenCalled();
  });
  it('gate closure after a registry read suppresses its response', async () => {
    const t = setup(); t.store.read = async () => { t.enabled(false); return null; };
    const r = await t.handlers.read(t.request(), t.org); expect(r.status).toBe(404); expect(await r.json()).toEqual({ error: 'feature_unavailable' });
  });
  it('cross-origin browser mutation cannot reach the store', async () => {
    const t = setup(); expect((await t.handlers.create(t.request(t.input(), { Origin: 'https://other.example.test' }), t.org)).status).toBe(403); expect(t.store.create).not.toHaveBeenCalled();
  });
  it('verified device credential has no browser-cookie fallback', async () => {
    const t = setup(); t.actor({ ...t.context(), credential: { kind: 'device', sessionId: 'usd_' + randomUUID(), supportedSchemaVersion: 4 } });
    expect((await t.handlers.create(t.request(t.input()), t.org)).status).toBe(401);
    expect((await t.handlers.create(t.request(t.input(), { Authorization: 'Bearer fixture-only', Origin: 'https://other.example.test' }), t.org)).status).toBe(200);
  });
  it('unexpected browser bearer cannot reuse a cookie context', async () => {
    const t = setup(); expect((await t.handlers.read(t.request(undefined, { Authorization: 'Bearer foreign' }), t.org)).status).toBe(401);
  });
  it('expected user mismatch is not another account’s metadata', async () => {
    const t = setup(); expect((await t.handlers.read(t.request(undefined, { 'X-Zentra-Expected-User': randomUUID() }), t.org)).status).toBe(401); expect(t.store.read).not.toHaveBeenCalled();
  });
  it.each(['user','role','period','credential'] as const)('suppresses private data after %s changes during read', async what => {
    const t = setup(); t.store.read = async () => {
      const c = t.context(); t.actor(what === 'user' ? { ...c, userId: randomUUID(), role: 'admin' } : what === 'role' ? { ...c, userId: randomUUID(), role: 'read_only' } : what === 'period' ? { ...c, authorityReference: 'in_Renewed', validEndsAt: c.validEndsAt + 100 } : { ...c, credential: { kind: 'device', sessionId: 'usd_' + randomUUID(), supportedSchemaVersion: 4 } }); return null;
    };
    const r = await t.handlers.read(t.request(), t.org); expect([401,403,409]).toContain(r.status); expect(await r.json()).not.toHaveProperty('workspace');
  });
  it('delayed store failure cannot hide membership revocation', async () => {
    const t = setup(); t.store.read = async () => { t.dependencies.member = async () => { throw new UsSupportWorkspaceError('forbidden', 403); }; throw Error('private database detail'); };
    const r = await t.handlers.read(t.request(), t.org); expect(r.status).toBe(403); expect(await r.json()).toEqual({ error: 'forbidden' });
    expect(JSON.stringify((t.dependencies.diagnostic as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('private database detail');
  });
  it.each(['workspace','request','actor','name'] as const)('rejects corrupted mutation result %s', async what => {
    const t = setup(), real = t.store.create.bind(t.store); t.store.create = async (...args) => {
      const r = await real(...args); return what === 'workspace' ? { ...r, workspace: { ...r.workspace, organizationId: randomUUID() } } : what === 'request' ? { ...r, receipt: { ...r.receipt, requestId: randomUUID() } } : what === 'actor' ? { ...r, receipt: { ...r.receipt, actorUserId: randomUUID() } } : { ...r, workspace: { ...r.workspace, name: 'Wrong response' } };
    };
    const r = await t.handlers.create(t.request(t.input()), t.org); expect(r.status).toBe(503); expect(await r.json()).toEqual({ error: 'invalid_support_record' });
  });
  it.each([{ extra: true }, { name: 'x' }, { name: 'Bad\u202ename' }, { schemaVersion: 2 }])('rejects malformed command without effects %j', async patch => {
    const t = setup(); expect((await t.handlers.create(t.request({ ...t.input(), ...patch }), t.org)).status).toBe(422); expect(t.store.create).not.toHaveBeenCalled();
  });
  it('does not reveal unexpected exceptions or allow unsafe diagnostics to break the response', async () => {
    const t = setup(); t.store.read = async () => { throw Error('secret provider password'); }; t.dependencies.diagnostic = () => { throw Error('logger broken'); };
    const r = await t.handlers.read(t.request(), t.org); expect(r.status).toBe(503); expect(await r.json()).toEqual({ error: 'service_unavailable' });
  });
  it('rejects oversized request and query/method misuse', async () => {
    const t = setup(); expect((await t.handlers.create(t.request({ ...t.input(), name: 'x'.repeat(5000) }), t.org)).status).toBe(422);
    expect((await t.handlers.read(new Request('https://zentra.example.test/api/support-workspace?organizationId=other'), t.org)).status).toBe(422);
    expect((await t.handlers.read(t.request(t.input()), t.org)).status).toBe(422); expect((await t.handlers.read(t.request(), 'invalid')).status).toBe(422);
  });
});
