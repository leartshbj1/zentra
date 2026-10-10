import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { lifecycleFixture, lifecycleMigrationFiles } from './us-saas-test-lifecycle-test-fixture';
import { d1UsSupportWorkspaceStore } from './us-support-workspace-d1';
import { readUsSupportWorkspaceAuthority } from './us-support-workspace-bindings';
import { canonicalErpJson } from './erp-contract';
import { createOrResumeUsWorkspace } from './workspace-creation';
import { d1WorkspaceCreationStore } from './workspace-creation-d1';
import { prepareUsAuthorityAdmission } from './saas-authority';
import { d1UsAuthorityStore } from './saas-authority-d1';
import { d1UsTestPurchaseStore } from './us-saas-test-d1';
import { validateUsTestPurchase, verifiedUsTestSession, verifiedUsTestPaidProof } from './us-saas-test-contract';
import { d1UsDeviceStore } from './us-device-d1';
import { d1UsTeamStore } from './us-team-store';
import { hashUsTeamCommand, hashUsTeamToken, newUsTeamToken } from './us-team-validation';
import type { UsTeamPrivateCommand } from './us-team-contract';
import type { UsTeamContext } from './us-team-contract';
import type { ErpSchemaVersion } from './erp-schema-capability';
import { validateUsSupportWorkspaceContext, hashUsSupportWorkspaceRequest, type UsSupportWorkspaceContext, type UsSupportWorkspaceRequest } from './us-support-workspace-contract';

const migration = readFileSync(new URL('../../drizzle/0093_international_us_support_workspaces.sql', import.meta.url), 'utf8');
type Fixture = Awaited<ReturnType<typeof lifecycleFixture>>;
const opened: Fixture[] = [];
afterEach(() => { for (const f of opened.splice(0)) { expect(f.sql.prepare('PRAGMA foreign_key_check').all()).toEqual([]); f.sql.close(); } });
async function fixture(includeRegistry = true) {
  const f = await lifecycleFixture(); opened.push(f);
  f.sql.prepare("INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at)VALUES('legacy-support',?,'Existing CH Support',?,?)").run(f.actor, f.now(), f.now());
  const before = f.sql.prepare('SELECT * FROM support_workspaces').all();
  if (includeRegistry) f.sql.exec(migration);
  return { ...f, beforeSupport: before, support: d1UsSupportWorkspaceStore(f.database, { now: f.now }) };
}
function context(f: Fixture, userId = f.actor, credential: UsSupportWorkspaceContext['credential'] = { kind: 'browser' }): UsSupportWorkspaceContext {
  const a = f.sql.prepare('SELECT * FROM international_effective_saas_authorities WHERE organization_id=?').get(f.intent.organizationId)!;
  const authority = JSON.parse(a.authority_json as string) as Fixture['authority'];
  const m = f.sql.prepare('SELECT role FROM international_workspace_members WHERE organization_id=? AND user_id=?').get(f.intent.organizationId, userId);
  return validateUsSupportWorkspaceContext({ schemaVersion: 1, organizationId: f.intent.organizationId, userId, role: m?.role ?? 'member', ownerUserId: f.actor,
    subscriptionId: authority.subscriptionId, environment: authority.offer.environment, catalogVersion: authority.offer.catalogVersion, priceId: authority.offer.priceId,
    authorityReference: authority.evidence!.referenceId, validStartsAt: authority.evidence!.startsAt, validEndsAt: authority.evidence!.endsAt,
    seatLimit: a.seat_limit, checkedAt: f.now(), credential }, f.intent.organizationId, f.now());
}
function request(name = 'US Support TEST', requestId = randomUUID()): UsSupportWorkspaceRequest { return { schemaVersion: 1, requestId, name }; }
const count = (f: Fixture, table = 'international_us_support_workspaces') => Number(f.sql.prepare('SELECT count(*) AS n FROM ' + table).get()!.n);
async function member(f: Fixture, role: Exclude<UsSupportWorkspaceContext['role'], 'owner'>) {
  const userId = randomUUID(), email = userId + '@example.test', store = d1UsTeamStore(f.database, { now: f.now });
  const owner = team(context(f)), token = newUsTeamToken(), invitationId = randomUUID(), tokenHash = await hashUsTeamToken(token);
  const invitation: UsTeamPrivateCommand = { schemaVersion: 1, requestId: randomUUID(), expectedTeamRevision: await store.revision(owner), action: 'create_invitation', email, role, invitationId, tokenHash, expiresAt: f.now() + 604800 };
  await store.commit({ context: owner, command: invitation, requestHash: await hashUsTeamCommand(owner.organizationId, owner.user.userId, invitation) });
  const recipient: UsTeamContext = { ...owner, mode: 'recipient', role, user: { userId, email, emailConfirmed: true } };
  const acceptance: UsTeamPrivateCommand = { schemaVersion: 1, requestId: randomUUID(), expectedTeamRevision: await store.revision(owner), action: 'accept_invitation', invitationId, tokenHash, membershipId: randomUUID(), firstName: 'US', lastName: 'TEST', displayName: 'US TEST' };
  await store.commit({ context: recipient, command: acceptance, requestHash: await hashUsTeamCommand(owner.organizationId, userId, acceptance) });
  return userId;
}
function intercepted(f: Fixture, batch: (statements: D1PreparedStatement[]) => Promise<D1Result[]>) { return { prepare: f.database.prepare.bind(f.database), batch } as Pick<D1Database, 'prepare' | 'batch'>; }
function serialized(f: Fixture) {
  let queue = Promise.resolve();
  return intercepted(f, statements => { const result = queue.then(() => f.database.batch(statements)); queue = result.then(() => undefined, () => undefined); return result; });
}
function rawWrite(f: Fixture, table: string, values: Record<string, SQLInputValue>, replace = false) {
  const names = Object.keys(values); return f.sql.prepare(`INSERT ${replace ? 'OR REPLACE ' : ''}INTO ${table}(${names.join(',')})VALUES(${names.map(() => '?').join(',')})`).run(...Object.values(values));
}
async function create(f: Awaited<ReturnType<typeof fixture>>, q = request(), userId = f.actor) { return f.support.create(context(f, userId), q, async () => context(f, userId)); }
function renewal(f: Fixture) {
  const invoiceId = 'in_SupportRenewal';
  return f.paid({ invoiceId, sourceId: invoiceId, authority: { ...f.authority, evidence: { ...f.authority.evidence!, referenceId: invoiceId, startsAt: f.now(), endsAt: f.authority.evidence!.endsAt + 3600 } } });
}
function team(c: UsSupportWorkspaceContext): UsTeamContext { return { schemaVersion: 1, organizationId: c.organizationId, mode: 'member', role: c.role, user: { userId: c.userId, email: null, emailConfirmed: false }, subscriptionId: c.subscriptionId, environment: c.environment, catalogVersion: c.catalogVersion, priceId: c.priceId, seatLimit: c.seatLimit, checkedAt: c.checkedAt, validStartsAt: c.validStartsAt, validEndsAt: c.validEndsAt, credential: c.credential }; }
async function native(f: Fixture, schema: ErpSchemaVersion) {
  const store = d1UsDeviceStore(f.database), sessionId = 'usd_' + randomUUID(), codeHash = randomBytes(32).toString('base64url'), tokenHash = randomBytes(32).toString('base64url');
  await store.start({ codeHash, tokenHash, installationId: randomUUID(), userCode: 'ABCD-EFGH', schema, now: f.now() });
  await store.approve('ABCD-EFGH', { organizationId: f.intent.organizationId, organizationName: 'US TEST', userId: f.actor, role: 'owner', subscriptionId: f.authority.subscriptionId, entitlementValidUntil: f.authority.evidence!.endsAt, configurationStamp: 'fictitious TEST' }, f.now());
  await store.consume((await store.challenge('code', codeHash))!, sessionId, f.now());
  return { store, tokenHash, credential: { kind: 'device' as const, sessionId, supportedSchemaVersion: schema } };
}
async function cloneReceipt(f: Fixture) {
  const row = { ...f.sql.prepare('SELECT * FROM international_us_support_workspace_receipts LIMIT 1').get()! } as Record<string, SQLInputValue>;
  const q = request(row.name as string); row.command_id = randomUUID(); row.request_id = q.requestId; row.command_json = canonicalErpJson(q);
  row.request_hash = await hashUsSupportWorkspaceRequest(row.organization_id as string, row.actor_user_id as string, q);
  row.receipt_json = canonicalErpJson({ ...JSON.parse(row.receipt_json as string), requestId: q.requestId }); return row;
}
/** A second real0091 admission, with fictitious TEST gateway attestations. */
async function company(f: Fixture, module: 'gestion' | 'complet' = 'complet') {
  const stamp = new Date(f.now() * 1000).toISOString();
  const { organizationId: _organizationId, ...configuration } = f.intent.configuration;
  const initial = await createOrResumeUsWorkspace(f.actor, { requestId: randomUUID(), confirmationVersion: 1, companyName: 'Second US TEST', configuration }, { store: d1WorkspaceCreationStore(f.database), allocateId: () => randomUUID(), now: () => stamp, fingerprint: async value => createHash('sha256').update(value).digest('hex'), admit: async i => ({ creationId: i.creationId, organizationId: i.organizationId, actorUserId: f.actor, requestId: i.requestId, configurationFingerprint: i.fingerprint, configuration: i.configuration, revision: 1, updatedBy: f.actor, updatedAt: stamp, replayed: false }), revalidate: async () => {} });
  const offer = { ...f.authority.offer, module }, subscriptionId = 'sub_' + initial.organizationId.replaceAll('-', ''), invoiceId = 'in_' + initial.organizationId.replaceAll('-', '');
  const authority = { ...f.authority, organizationId: initial.organizationId, subscriptionId, offer, evidence: { ...f.authority.evidence!, organizationId: initial.organizationId, subscriptionId, referenceId: invoiceId } };
  const policy = { ...f.policy, catalog: [{ offer, seatLimit: 8 }], now: f.now() }, store = d1UsTestPurchaseStore(f.database);
  const purchase = await store.reserve(initial, validateUsTestPurchase({ ...f.purchase, purchaseId: randomUUID(), creationId: initial.creationId, organizationId: initial.organizationId, requestId: initial.requestId, configurationFingerprint: initial.fingerprint, receipt: initial.receipt!, offer, createdAt: f.now(), expiresAt: f.now() + 3600 }, initial), async () => {});
  const session = await store.bind(purchase, verifiedUsTestSession(purchase, { purchaseId: purchase.purchaseId, sessionId: 'cs_test_' + purchase.purchaseId.replaceAll('-', ''), customerId: null, subscriptionId: null, createdAt: f.now(), expiresAt: purchase.expiresAt }), async () => {});
  const proof = verifiedUsTestPaidProof(purchase, { purchaseId: purchase.purchaseId, sessionId: session.sessionId, customerId: 'cus_SecondSupport', subscriptionId, invoiceId, eventId: 'evt_SecondSupport', providerAccountId: purchase.providerAccountId, authority, serverPrice: f.price, verifiedAt: f.now() });
  await store.admit(initial, purchase, session, proof, prepareUsAuthorityAdmission(initial, { authority, seatLimit: 8 }, policy, f.price), async () => {});
  return { context: { ...context(f), organizationId: initial.organizationId, subscriptionId, authorityReference: invoiceId }, policy };
}

describe('H1 Support US on the actual0000..0093 SQLite chain; synthetic trusted Auth/payment only', () => {
  it('preserves populated CH/core Support and all prior US data without backfill', async () => {
    const f = await fixture(); expect(lifecycleMigrationFiles).toHaveLength(93); expect(count(f)).toBe(0); expect(f.snapshot()).toEqual(f.before);
    expect(f.sql.prepare('SELECT * FROM support_workspaces').all()).toEqual(f.beforeSupport); expect(await f.support.read(context(f))).toBeNull();
    await create(f); expect(f.snapshot()).toEqual(f.before); expect(f.sql.prepare('SELECT * FROM support_workspaces').all()).toEqual(f.beforeSupport);
    for (const table of ['support_gestion_links', 'support_members', 'support_connections', 'support_mailboxes', 'support_tickets']) expect(count(f, table)).toBe(0);
  });
  it('creates one immutable workspace/receipt with real owner, connecting actor and computed material hash', async () => {
    const f = await fixture(), q = request('  E\u0301quipe US  '), result = await create(f, q);
    expect(result).toMatchObject({ replayed: false, workspace: { organizationId: f.intent.organizationId, ownerUserId: f.actor, connectedBy: f.actor, name: 'Équipe US', revision: 1, createdAt: f.now() }, receipt: { actorUserId: f.actor, requestId: q.requestId } });
    const stored = f.sql.prepare('SELECT * FROM international_us_support_workspace_receipts').get()!;
    expect(stored.request_hash).toBe(await hashUsSupportWorkspaceRequest(f.intent.organizationId, f.actor, q)); expect(await f.support.read(context(f))).toEqual(result.workspace);
  });
  it('keeps original ID/date/actor on exact retry with a fresh clock and after a paid renewal', async () => {
    const f = await fixture(), q = request(), first = await create(f, q); f.setNow(f.now() + 1); expect(await create(f, q)).toEqual({ ...first, replayed: true });
    await f.store.apply(f.binding, renewal(f), async () => {}); expect(await create(f, q)).toEqual({ ...first, replayed: true }); expect(count(f, 'international_us_support_workspace_receipts')).toBe(1);
  });
  it('refuses changed same-request material and a new request attempting an implicit rename', async () => {
    const f = await fixture(), q = request(); await create(f, q);
    await expect(create(f, { ...q, name: 'Changed' })).rejects.toMatchObject({ status: 409, code: 'support_idempotency_conflict' });
    await expect(create(f, request('Changed'))).rejects.toMatchObject({ status: 409, code: 'support_workspace_conflict' }); expect(count(f, 'international_us_support_workspace_receipts')).toBe(1);
  });
  it('scopes request receipts to actor while preserving the first owner/connection/date', async () => {
    const f = await fixture(), q = request(), first = await create(f, q), admin = await member(f, 'admin'); f.setNow(f.now() + 1);
    const second = await create(f, q, admin); expect(second.workspace).toEqual(first.workspace); expect(second.receipt.actorUserId).toBe(admin); expect(second.replayed).toBe(false);
    expect(count(f)).toBe(1); expect(count(f, 'international_us_support_workspace_receipts')).toBe(2);
  });
  it('allows a current admin to create without replacing the real US owner', async () => {
    const f = await fixture(), admin = await member(f, 'admin'), result = await create(f, request(), admin);
    expect(result.workspace).toMatchObject({ ownerUserId: f.actor, connectedBy: admin });
  });
  it.each(['accountant', 'member', 'read_only'] as const)('allows %s registry reading but refuses creation', async role => {
    const f = await fixture(), userId = await member(f, role); expect(await f.support.read(context(f, userId))).toBeNull();
    await expect(create(f, request(), userId)).rejects.toMatchObject({ status: 403 }); const first = await create(f); expect(await f.support.read(context(f, userId))).toEqual(first.workspace);
  });
  it('converges concurrent exact requests on one workspace and one first receipt', async () => {
    const f = await fixture(), store = d1UsSupportWorkspaceStore(serialized(f), { now: f.now }), q = request();
    const results = await Promise.all([store.create(context(f), q, async () => context(f)), store.create(context(f), q, async () => context(f))]);
    expect(results[0].workspace).toEqual(results[1].workspace); expect(results.map(r => r.replayed).sort((a, b) => Number(a) - Number(b))).toEqual([false, true]); expect(count(f)).toBe(1); expect(count(f, 'international_us_support_workspace_receipts')).toBe(1);
  });
  it('converges two concurrent actors/requests on the SQL-selected canonical workspace', async () => {
    const f = await fixture(), admin = await member(f, 'admin'), store = d1UsSupportWorkspaceStore(serialized(f), { now: f.now });
    const results = await Promise.all([store.create(context(f), request(), async () => context(f)), store.create(context(f, admin), request(), async () => context(f, admin))]);
    expect(results[0].workspace).toEqual(results[1].workspace); expect(results.map(r => r.receipt.actorUserId).sort()).toEqual([f.actor, admin].sort()); expect(count(f)).toBe(1); expect(count(f, 'international_us_support_workspace_receipts')).toBe(2);
  });
  it('recovers an acknowledgement lost after atomic commit with its original durable receipt', async () => {
    const f = await fixture(), store = d1UsSupportWorkspaceStore(intercepted(f, async statements => { await f.database.batch(statements); throw Error('synthetic response loss'); }), { now: f.now });
    expect(await store.create(context(f), request(), async () => context(f))).toMatchObject({ replayed: true }); expect(count(f)).toBe(1); expect(count(f, 'international_us_support_workspace_receipts')).toBe(1);
  });
  it('rolls receipt and registry back together when an unrelated last statement fails', async () => {
    const f = await fixture(), store = d1UsSupportWorkspaceStore(intercepted(f, statements => f.database.batch([...statements, f.database.prepare('INSERT INTO missing_support_test_table(value)VALUES(1)')])), { now: f.now });
    await expect(store.create(context(f), request(), async () => context(f))).rejects.toMatchObject({ status: 503 }); expect(count(f)).toBe(0); expect(count(f, 'international_us_support_workspace_receipts')).toBe(0);
  });
  it('fails closed when0093 is absent, without selecting any legacy owner workspace', async () => {
    const f = await fixture(false); await expect(f.support.read(context(f))).rejects.toMatchObject({ status: 503 }); await expect(create(f)).rejects.toMatchObject({ status: 503 }); expect(f.sql.prepare('SELECT * FROM support_workspaces').all()).toEqual(f.beforeSupport);
  });
  it.each(['subscriptionId', 'ownerUserId', 'environment', 'catalogVersion', 'priceId', 'authorityReference', 'validStartsAt', 'validEndsAt', 'seatLimit'] as const)('refuses stale/forged %s provenance', async field => {
    const f = await fixture(), admin = await member(f, 'admin'), c = context(f, admin); const value = field === 'ownerUserId' ? randomUUID() : field === 'environment' ? 'PRODUCTION' : typeof c[field] === 'number' ? Number(c[field]) + 1 : 'price_wrong';
    await expect(f.support.read({ ...c, [field]: value })).rejects.toMatchObject({ status: 409 });
  });
  it('does not disclose a registry to a nonmember, CH organization or foreign US scope', async () => {
    const f = await fixture(); await create(f); await expect(f.support.read(context(f, randomUUID()))).rejects.toMatchObject({ status: 403 });
    await expect(f.support.read({ ...context(f), organizationId: randomUUID() })).rejects.toMatchObject({ status: 403 });
    await expect(f.support.read({ ...context(f), organizationId: 'lifecycle-CH' })).rejects.toMatchObject({ status: 503 });
  });
  it('fails closed after member or authority revocation even on exact stored replay', async () => {
    const f = await fixture(), admin = await member(f, 'admin'), q = request(); await create(f, q, admin);
    const owner = team(context(f)), teamStore = d1UsTeamStore(f.database, { now: f.now }), revoke: UsTeamPrivateCommand = { schemaVersion: 1, requestId: randomUUID(), expectedTeamRevision: await teamStore.revision(owner), action: 'revoke_member', membershipId: f.sql.prepare('SELECT membership_id FROM international_workspace_members WHERE organization_id=? AND user_id=?').get(f.intent.organizationId, admin)!.membership_id as string };
    await teamStore.commit({ context: owner, command: revoke, requestHash: await hashUsTeamCommand(owner.organizationId, owner.user.userId, revoke) }); await expect(create(f, q, admin)).rejects.toMatchObject({ status: 403 });
    f.sql.prepare('UPDATE international_saas_authorities SET revoked_at=? WHERE organization_id=?').run(f.now(), f.intent.organizationId); await expect(create(f, q)).rejects.toMatchObject({ status: 402 }); expect(count(f)).toBe(1);
  });
  it('does not output a successful committed result after identity loss, while retaining immutable data', async () => {
    const f = await fixture(); let committed = false; const store = d1UsSupportWorkspaceStore(intercepted(f, async statements => { const results = await f.database.batch(statements); committed = true; return results; }), { now: f.now });
    await expect(store.create(context(f), request(), async () => committed ? { ...context(f), userId: randomUUID(), role: 'admin' } : context(f))).rejects.toMatchObject({ status: 401 }); expect(count(f)).toBe(1);
  });
  it('fences a renewal arriving after JS validation but before SQL insert, then accepts a fresh retry', async () => {
    const f = await fixture(), q = request(); let changed = false; const store = d1UsSupportWorkspaceStore(intercepted(f, async statements => { if (!changed) { changed = true; await f.store.apply(f.binding, renewal(f), async () => {}); } return f.database.batch(statements); }), { now: f.now });
    await expect(store.create(context(f), q, async () => context(f))).rejects.toMatchObject({ status: 409 }); expect(count(f)).toBe(0); expect(count(f, 'international_us_support_workspace_receipts')).toBe(0); expect(await create(f, q)).toMatchObject({ replayed: false });
  });
  it('SQL refuses a31s stale initial write while an old committed exact retry remains available with fresh context', async () => {
    const f = await fixture(), store = d1UsSupportWorkspaceStore(intercepted(f, async statements => { f.setNow(f.now() + 31); return f.database.batch(statements); }), { now: f.now });
    await expect(store.create(context(f), request(), async () => context(f))).rejects.toMatchObject({ status: 402 }); expect(count(f)).toBe(0);
    const q = request(), first = await create(f, q); f.setNow(f.now() + 31); expect(await create(f, q)).toEqual({ ...first, replayed: true });
  });
  it.each([1, 2, 3, 4] as const)('requires the exact current native family/capability%d and retains its own expiry across renewal', async schema => {
    const f = await fixture(), n = await native(f, schema), c = () => context(f, f.actor, n.credential), q = request();
    await f.support.create(c(), q, async () => c()); await f.store.apply(f.binding, renewal(f), async () => {}); expect(await f.support.read(c())).not.toBeNull();
    f.setNow(f.authority.evidence!.endsAt); await expect(f.support.read(c())).rejects.toMatchObject({ status: 401 }); expect(count(f)).toBe(1);
  });
  it('requires fresh native revocation and refuses a captured capability upgrade', async () => {
    const f = await fixture(), n = await native(f, 3), c = context(f, f.actor, n.credential);
    await expect(f.support.read({ ...c, credential: { ...n.credential, supportedSchemaVersion: 4 } })).rejects.toMatchObject({ status: 401 });
    await n.store.revoke(n.tokenHash, f.now()); await expect(f.support.read(c)).rejects.toMatchObject({ status: 401 });
  });
});

describe('0093 direct SQL guards and the actual fresh authority reader', () => {
  it('cannot commit a receipt alone or a registry without its first receipt', async () => {
    const f = await fixture(); await create(f); const r = await cloneReceipt(f); r.workspace_id = randomUUID(); r.receipt_json = canonicalErpJson({ ...JSON.parse(r.receipt_json as string), workspaceId: r.workspace_id });
    expect(() => rawWrite(f, 'international_us_support_workspace_receipts', r)).toThrow(/support_workspace_conflict/);
    const w = { ...f.sql.prepare('SELECT * FROM international_us_support_workspaces').get()! } as Record<string, SQLInputValue>; w.workspace_id = randomUUID(); w.organization_id = randomUUID(); w.created_command_id = randomUUID(); expect(() => rawWrite(f, 'international_us_support_workspaces', w)).toThrow();
    const second = await company(f), orphan = await cloneReceipt(f); orphan.organization_id = second.context.organizationId; orphan.workspace_id = randomUUID(); orphan.context_json = canonicalErpJson(second.context);
    orphan.request_hash = await hashUsSupportWorkspaceRequest(second.context.organizationId, f.actor, JSON.parse(orphan.command_json as string));
    orphan.receipt_json = canonicalErpJson({ ...JSON.parse(orphan.receipt_json as string), organizationId: orphan.organization_id, workspaceId: orphan.workspace_id });
    expect(() => rawWrite(f, 'international_us_support_workspace_receipts', orphan)).toThrow(/FOREIGN KEY/); expect(count(f)).toBe(1); expect(count(f, 'international_us_support_workspace_receipts')).toBe(1);
  });
  it.each(['organizationId', 'userId', 'ownerUserId', 'subscriptionId', 'environment', 'catalogVersion', 'priceId', 'authorityReference', 'validStartsAt', 'validEndsAt', 'seatLimit'] as const)('SQL rejects direct receipt %s context drift independently of JS validation', async field => {
    const f = await fixture(); await create(f); const r = await cloneReceipt(f), c = JSON.parse(r.context_json as string) as Record<string, unknown>;
    c[field] = typeof c[field] === 'number' ? Number(c[field]) + 1 : randomUUID(); r.context_json = canonicalErpJson(c); expect(() => rawWrite(f, 'international_us_support_workspace_receipts', r)).toThrow(); expect(count(f, 'international_us_support_workspace_receipts')).toBe(1);
  });
  it('SQL independently rejects low roles, unknown JSON keys and an invented native session', async () => {
    const f = await fixture(); await create(f); for (const patch of [{ role: 'member' }, { privateToken: 'must-not-persist' }, { credential: { kind: 'device', sessionId: randomUUID(), supportedSchemaVersion: 4 } }]) {
      const r = await cloneReceipt(f); r.context_json = canonicalErpJson({ ...JSON.parse(r.context_json as string), ...patch }); expect(() => rawWrite(f, 'international_us_support_workspace_receipts', r)).toThrow();
    } expect(count(f, 'international_us_support_workspace_receipts')).toBe(1);
  });
  it.each(['international_us_support_workspaces', 'international_us_support_workspace_receipts'])('forbids UPDATE/DELETE/REPLACE of immutable%s', async table => {
    const f = await fixture(); await create(f); const r = f.sql.prepare('SELECT * FROM ' + table).get() as Record<string, SQLInputValue>;
    expect(() => f.sql.exec('UPDATE ' + table + ' SET created_at=created_at+1')).toThrow('us_support_immutable'); expect(() => f.sql.exec('DELETE FROM ' + table)).toThrow('us_support_immutable'); expect(() => rawWrite(f, table, r, true)).toThrow(); expect(count(f, table)).toBe(1);
  });
  it('rejects hostile getters before reads and unknown command fields before writes', async () => {
    const f = await fixture(); let reads = 0; const c = { ...context(f), get seatLimit() { reads++; return 8; } };
    await expect(f.support.read(c)).rejects.toMatchObject({ status: 503 }); expect(reads).toBe(0); await expect(create(f, { ...request(), token: 'unexpected' } as UsSupportWorkspaceRequest)).rejects.toMatchObject({ status: 422 }); expect(count(f)).toBe(0);
  });
  it('actual reader returns current Complet rights for every role, but no CH membership adoption', async () => {
    const f = await fixture(); for (const role of ['owner', 'admin', 'accountant', 'member', 'read_only'] as const) { const user = role === 'owner' ? f.actor : await member(f, role), c = context(f, user); expect(await readUsSupportWorkspaceAuthority(f.database, team(c), f.policy)).toEqual(c); }
    await expect(readUsSupportWorkspaceAuthority(f.database, { ...team(context(f)), organizationId: 'lifecycle-CH' }, f.policy)).rejects.toMatchObject({ status: 403 });
    await expect(readUsSupportWorkspaceAuthority(f.database, team(context(f, randomUUID())), f.policy)).rejects.toMatchObject({ status: 403 });
  });
  it('actual reader returns the same effective paid renewal invoice/period and fences a change between module checks', async () => {
    const f = await fixture(), captured = context(f); await f.store.apply(f.binding, renewal(f), async () => {});
    const latest = await readUsSupportWorkspaceAuthority(f.database, team(context(f)), { ...f.policy, now: f.now() }); expect(latest.authorityReference).toBe('in_SupportRenewal'); expect(latest.validEndsAt).toBeGreaterThan(captured.validEndsAt);
    let reads = 0; const database = { batch: f.database.batch.bind(f.database), prepare(sql: string) { const statement = f.database.prepare(sql), first = statement.first.bind(statement); statement.first = async (...args: Parameters<typeof first>) => { const result = await first(...args); if (sql.includes('a.authority_json') && ++reads === 2) await f.store.apply(f.binding, f.paid({ invoiceId: 'in_DuringRead', sourceId: 'in_DuringRead', authority: { ...f.authority, evidence: { ...f.authority.evidence!, referenceId: 'in_DuringRead', startsAt: f.now(), endsAt: latest.validEndsAt + 1 } } }), async () => {}); return result; }; return statement; } } as D1Database;
    await expect(readUsSupportWorkspaceAuthority(database, team(context(f)), { ...f.policy, now: f.now() })).rejects.toMatchObject({ status: 503 });
  });
  it('allows multiple US companies of the same true owner while the existing legacy owner workspace remains unchanged', async () => {
    const f = await fixture(), first = await create(f), c = await company(f);
    const second = await f.support.create(c.context, request(), async () => c.context); expect(second.workspace.workspaceId).not.toBe(first.workspace.workspaceId); expect(second.workspace.ownerUserId).toBe(first.workspace.ownerUserId); expect(count(f)).toBe(2); expect(f.sql.prepare('SELECT * FROM support_workspaces').all()).toEqual(f.beforeSupport);
  });
  it('Gestion-only paid US admission remains valid for Gestion but does not grant Support via reader, store or SQL', async () => {
    const f = await fixture(), c = await company(f, 'gestion');
    expect(await d1UsAuthorityStore(f.database).access(c.context.organizationId, f.actor, c.policy)).toMatchObject({ role: 'owner' });
    await expect(readUsSupportWorkspaceAuthority(f.database, team(c.context), c.policy)).rejects.toMatchObject({ status: 402 });
    await expect(f.support.read(c.context)).rejects.toMatchObject({ status: 402 }); await expect(f.support.create(c.context, request(), async () => c.context)).rejects.toMatchObject({ status: 402 });
    await create(f); const r = await cloneReceipt(f); r.organization_id = c.context.organizationId; r.workspace_id = randomUUID(); r.context_json = canonicalErpJson(c.context); r.receipt_json = canonicalErpJson({ ...JSON.parse(r.receipt_json as string), organizationId: r.organization_id, workspaceId: r.workspace_id });
    expect(() => rawWrite(f, 'international_us_support_workspace_receipts', r)).toThrow('us_support_subscription_required'); expect(count(f)).toBe(1);
  });
});
