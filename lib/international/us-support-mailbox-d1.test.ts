import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { lifecycleFixture, lifecycleMigrationFiles } from './us-saas-test-lifecycle-test-fixture';
import { d1UsSupportWorkspaceStore } from './us-support-workspace-d1';
import { d1UsMailboxStore } from './us-support-mailbox-d1';
import { d1UsTeamStore } from './us-team-store';
import { d1UsDeviceStore } from './us-device-d1';
import { hashUsTeamCommand, hashUsTeamToken, newUsTeamToken } from './us-team-validation';
import type { UsTeamContext, UsTeamPrivateCommand } from './us-team-contract';
import type { UsSupportWorkspaceContext } from './us-support-workspace-contract';
import type { ErpSchemaVersion } from './erp-schema-capability';
import { canonicalErpJson } from './erp-contract';
import { sha256Hex } from './canonical-hash';
import { createOrResumeUsWorkspace } from './workspace-creation';
import { d1WorkspaceCreationStore } from './workspace-creation-d1';
import { prepareUsAuthorityAdmission } from './saas-authority';
import { d1UsTestPurchaseStore } from './us-saas-test-d1';
import { validateUsTestPurchase, verifiedUsTestSession, verifiedUsTestPaidProof } from './us-saas-test-contract';
import { hashUsMailboxPrivateCommand, usMailboxProjection, validateUsMailboxContext, type UsMailboxContext, type UsMailboxPrivateCommand } from './us-support-mailbox-contract';

const folder = new URL('../../drizzle/', import.meta.url);
const h1Sql = readFileSync(new URL('0093_international_us_support_workspaces.sql', folder), 'utf8');
const mailboxSql = readFileSync(new URL('0094_international_us_support_mailbox.sql', folder), 'utf8');
type Base = Awaited<ReturnType<typeof lifecycleFixture>>;
const opened: Base[] = [];
afterEach(() => { for (const f of opened.splice(0)) { expect(f.sql.prepare('PRAGMA foreign_key_check').all()).toEqual([]); f.sql.close(); } });
function authority(f: Base, organizationId = f.intent.organizationId, userId = f.actor, credential: UsSupportWorkspaceContext['credential'] = { kind: 'browser' }): UsSupportWorkspaceContext {
  const row = f.sql.prepare('SELECT * FROM international_effective_saas_authorities WHERE organization_id=?').get(organizationId)!;
  const current = JSON.parse(row.authority_json as string) as Base['authority'];
  const member = f.sql.prepare('SELECT role FROM international_workspace_members WHERE organization_id=? AND user_id=?').get(organizationId, userId);
  return { schemaVersion: 1, organizationId, userId, role: (member?.role ?? 'member') as UsSupportWorkspaceContext['role'], ownerUserId: f.actor,
    subscriptionId: current.subscriptionId, environment: current.offer.environment, catalogVersion: current.offer.catalogVersion, priceId: current.offer.priceId,
    authorityReference: current.evidence!.referenceId, validStartsAt: current.evidence!.startsAt, validEndsAt: current.evidence!.endsAt, seatLimit: row.seat_limit as number, checkedAt: f.now(), credential };
}
async function fixture(includeMailbox = true) {
  const f = await lifecycleFixture(); opened.push(f);
  f.sql.prepare("INSERT INTO support_workspaces(id,owner_id,name,created_at,updated_at)VALUES('legacy-mailbox-support',?,'Existing CH Support',?,?)").run(f.actor, f.now(), f.now());
  const legacyBefore = f.sql.prepare('SELECT * FROM support_workspaces').all(); f.sql.exec(h1Sql);
  const registry = await d1UsSupportWorkspaceStore(f.database, { now: f.now }).create(authority(f), { schemaVersion: 1, requestId: randomUUID(), name: 'US mailbox TEST' }, async () => authority(f));
  if (includeMailbox) f.sql.exec(mailboxSql);
  const context = (userId = f.actor, credential: UsSupportWorkspaceContext['credential'] = { kind: 'browser' }) => validateUsMailboxContext({ schemaVersion: 1, authority: authority(f, f.intent.organizationId, userId, credential), workspaceId: registry.workspace.workspaceId }, f.intent.organizationId, f.now());
  return { ...f, registry, legacyBefore, context, mailbox: d1UsMailboxStore(f.database, { now: f.now }) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function connect(f: Fixture, patch: Partial<Extract<UsMailboxPrivateCommand, { action: 'connect' }>> = {}): Promise<Extract<UsMailboxPrivateCommand, { action: 'connect' }>> {
  return { schemaVersion: 1, requestId: randomUUID(), expectedRevision: 0, action: 'connect', email: 'mailbox@example.test', tokenSha256: await sha256Hex('fake_fixture_token'),
    connectionId: randomUUID(), provider: 'infomaniak', mailboxId: 'fixture-mailbox', folderId: 'fixture-inbox', credentialsCiphertext: 'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA==', verifiedAt: f.now(), ...patch };
}
function disconnect(expectedRevision: number): UsMailboxPrivateCommand { return { schemaVersion: 1, requestId: randomUUID(), expectedRevision, action: 'disconnect' }; }
async function commit(f: Fixture, q: UsMailboxPrivateCommand, userId = f.actor) { return f.mailbox.commit(f.context(userId), q, async () => f.context(userId)); }
function count(f: Base, table = 'international_us_support_mailbox_receipts'): number { return Number(f.sql.prepare('SELECT count(*) AS n FROM ' + table).get()!.n); }
function intercepted(f: Base, batch: (statements: D1PreparedStatement[]) => Promise<D1Result[]>) { return { prepare: f.database.prepare.bind(f.database), batch } as Pick<D1Database, 'prepare' | 'batch'>; }
function team(c: UsSupportWorkspaceContext): UsTeamContext { return { schemaVersion: 1, organizationId: c.organizationId, mode: 'member', role: c.role,
  user: { userId: c.userId, email: null, emailConfirmed: false }, subscriptionId: c.subscriptionId, environment: c.environment, catalogVersion: c.catalogVersion, priceId: c.priceId,
  seatLimit: c.seatLimit, checkedAt: c.checkedAt, validStartsAt: c.validStartsAt, validEndsAt: c.validEndsAt, credential: c.credential }; }
async function member(f: Fixture, role: Exclude<UsSupportWorkspaceContext['role'], 'owner'>) {
  const userId = randomUUID(), email = userId + '@example.test', store = d1UsTeamStore(f.database, { now: f.now }), owner = team(authority(f));
  const invitationId = randomUUID(), tokenHash = await hashUsTeamToken(newUsTeamToken());
  const q: UsTeamPrivateCommand = { schemaVersion: 1, requestId: randomUUID(), expectedTeamRevision: await store.revision(owner), action: 'create_invitation', email, role, invitationId, tokenHash, expiresAt: f.now() + 604800 };
  await store.commit({ context: owner, command: q, requestHash: await hashUsTeamCommand(owner.organizationId, owner.user.userId, q) });
  const recipient: UsTeamContext = { ...owner, mode: 'recipient', role, user: { userId, email, emailConfirmed: true } };
  const accept: UsTeamPrivateCommand = { schemaVersion: 1, requestId: randomUUID(), expectedTeamRevision: await store.revision(owner), action: 'accept_invitation', invitationId, tokenHash, membershipId: randomUUID(), firstName: 'US', lastName: 'TEST', displayName: 'US TEST' };
  await store.commit({ context: recipient, command: accept, requestHash: await hashUsTeamCommand(owner.organizationId, userId, accept) }); return userId;
}
async function revokeMember(f: Fixture, userId: string) {
  const store = d1UsTeamStore(f.database, { now: f.now }), owner = team(authority(f));
  const q: UsTeamPrivateCommand = { schemaVersion: 1, requestId: randomUUID(), expectedTeamRevision: await store.revision(owner), action: 'revoke_member', membershipId: f.sql.prepare('SELECT membership_id FROM international_workspace_members WHERE organization_id=? AND user_id=?').get(owner.organizationId, userId)!.membership_id as string };
  await store.commit({ context: owner, command: q, requestHash: await hashUsTeamCommand(owner.organizationId, owner.user.userId, q) });
}
function renewal(f: Fixture) { const invoiceId = 'in_MailboxRenewal'; return f.paid({ invoiceId, sourceId: invoiceId, authority: { ...f.authority, evidence: { ...f.authority.evidence!, referenceId: invoiceId, startsAt: f.now(), endsAt: f.authority.evidence!.endsAt + 3600 } } }); }
async function native(f: Fixture, schema: ErpSchemaVersion) {
  const store = d1UsDeviceStore(f.database), sessionId = 'usd_' + randomUUID(), codeHash = randomBytes(32).toString('base64url'), tokenHash = randomBytes(32).toString('base64url');
  await store.start({ codeHash, tokenHash, installationId: randomUUID(), userCode: 'ABCD-EFGH', schema, now: f.now() });
  await store.approve('ABCD-EFGH', { organizationId: f.intent.organizationId, organizationName: 'US TEST', userId: f.actor, role: 'owner', subscriptionId: f.authority.subscriptionId,
    entitlementValidUntil: f.authority.evidence!.endsAt, configurationStamp: 'fictitious TEST' }, f.now());
  await store.consume((await store.challenge('code', codeHash))!, sessionId, f.now()); return { store, tokenHash, credential: { kind: 'device' as const, sessionId, supportedSchemaVersion: schema } };
}
async function company(f: Fixture) {
  const stamp = new Date(f.now() * 1000).toISOString(), { organizationId: _organizationId, ...configuration } = f.intent.configuration;
  const initial = await createOrResumeUsWorkspace(f.actor, { requestId: randomUUID(), confirmationVersion: 1, companyName: 'Second US mailbox TEST', configuration }, {
    store: d1WorkspaceCreationStore(f.database), allocateId: () => randomUUID(), now: () => stamp, fingerprint: async text => createHash('sha256').update(text).digest('hex'),
    admit: async i => ({ creationId: i.creationId, organizationId: i.organizationId, actorUserId: f.actor, requestId: i.requestId, configurationFingerprint: i.fingerprint, configuration: i.configuration, revision: 1, updatedBy: f.actor, updatedAt: stamp, replayed: false }), revalidate: async () => {} });
  const subscriptionId = 'sub_' + initial.organizationId.replaceAll('-', ''), invoiceId = 'in_' + initial.organizationId.replaceAll('-', '');
  const current = { ...f.authority, organizationId: initial.organizationId, subscriptionId, evidence: { ...f.authority.evidence!, organizationId: initial.organizationId, subscriptionId, referenceId: invoiceId } };
  const purchaseStore = d1UsTestPurchaseStore(f.database);
  const purchase = await purchaseStore.reserve(initial, validateUsTestPurchase({ ...f.purchase, purchaseId: randomUUID(), creationId: initial.creationId, organizationId: initial.organizationId,
    requestId: initial.requestId, configurationFingerprint: initial.fingerprint, receipt: initial.receipt!, createdAt: f.now(), expiresAt: f.now() + 3600 }, initial), async () => {});
  const session = await purchaseStore.bind(purchase, verifiedUsTestSession(purchase, { purchaseId: purchase.purchaseId, sessionId: 'cs_test_' + purchase.purchaseId.replaceAll('-', ''), customerId: null, subscriptionId: null, createdAt: f.now(), expiresAt: purchase.expiresAt }), async () => {});
  const proof = verifiedUsTestPaidProof(purchase, { purchaseId: purchase.purchaseId, sessionId: session.sessionId, customerId: 'cus_SecondMailbox', subscriptionId, invoiceId, eventId: 'evt_SecondMailbox', providerAccountId: purchase.providerAccountId, authority: current, serverPrice: f.price, verifiedAt: f.now() });
  await purchaseStore.admit(initial, purchase, session, proof, prepareUsAuthorityAdmission(initial, { authority: current, seatLimit: 8 }, { ...f.policy, now: f.now() }, f.price), async () => {});
  const a = authority(f, initial.organizationId), registry = await d1UsSupportWorkspaceStore(f.database, { now: f.now }).create(a, { schemaVersion: 1, requestId: randomUUID(), name: 'Second US Support' }, async () => authority(f, initial.organizationId));
  return () => validateUsMailboxContext({ schemaVersion: 1, authority: authority(f, initial.organizationId), workspaceId: registry.workspace.workspaceId }, initial.organizationId, f.now());
}

describe('H2a mailbox on the real0000..0094 SQLite chain; trusted fictitious provider only', () => {
  it('adds empty US storage without CH/legacy or prior US mutations and reads revision zero', async () => {
    const f = await fixture(); expect(lifecycleMigrationFiles).toHaveLength(93); expect(f.snapshot()).toEqual(f.before);
    expect(f.sql.prepare('SELECT * FROM support_workspaces').all()).toEqual(f.legacyBefore);
    expect(await f.mailbox.read(f.context())).toMatchObject({ revision: 0, currentConnection: null });
    await commit(f, await connect(f)); expect(f.snapshot()).toEqual(f.before); expect(f.sql.prepare('SELECT * FROM support_workspaces').all()).toEqual(f.legacyBefore);
    for (const table of ['support_connections','support_mailboxes','support_members','support_tickets']) expect(count(f, table)).toBe(0);
  });
  it('commits one scoped head, immutable descriptor, sanitized receipt and encrypted credential', async () => {
    const f = await fixture(), q = await connect(f), result = await commit(f, q);
    expect(result).toMatchObject({ replayed: false, state: { revision: 1, currentConnection: { id: q.connectionId, connectedBy: f.actor, credentialsCiphertext: q.credentialsCiphertext } }, receipt: { expectedRevision: 0, revision: 1, connectionId: q.connectionId } });
    const saved = f.sql.prepare('SELECT * FROM international_us_support_mailbox_receipts').get()!;
    expect(saved.request_hash).toBe(await hashUsMailboxPrivateCommand(f.intent.organizationId, f.actor, q));
    expect(JSON.stringify(saved)).not.toContain(q.credentialsCiphertext); expect(JSON.stringify(saved)).not.toContain('fake_fixture_token'); expect(JSON.stringify(saved.receipt_json)).not.toContain(q.tokenSha256);
    expect(count(f, 'international_us_support_mailbox_commits')).toBe(1); expect(await f.mailbox.read(f.context())).toEqual(result.state);
  });
  it('preserves first connection/IV/time on exact generated-field retry, even after verification expires', async () => {
    const f = await fixture(), q = await connect(f), first = await commit(f, q); f.setNow(f.now() + 31);
    const again = await commit(f, { ...q, connectionId: randomUUID(), credentialsCiphertext: 'v1.BBBBBBBBBBBBBBBB.BBBBBBBBBBBBBBBBBBBBBB==', verifiedAt: f.now() });
    expect(again).toEqual({ ...first, replayed: true }); expect(count(f)).toBe(1);
    expect(await f.mailbox.receipt(f.context(), q.requestId, first.receipt.requestHash)).toEqual(first.receipt);
  });
  it('purges old ciphertext when replacing, retaining only immutable descriptor/receipt history', async () => {
    const f = await fixture(), old = await connect(f); await commit(f, old);
    const q = await connect(f, { expectedRevision: 1, email: 'second@example.test' }); await commit(f, q);
    expect(f.sql.prepare('SELECT credentials_ciphertext,cleared_by_command_id FROM international_us_support_mailbox_secrets WHERE connection_id=?').get(old.connectionId)).toMatchObject({ credentials_ciphertext: null, cleared_by_command_id: expect.any(String) });
    expect(count(f, 'international_us_support_mailbox_connections')).toBe(2); expect((await f.mailbox.read(f.context())).currentConnection!.id).toBe(q.connectionId);
    const oldReplay = await commit(f, old); expect(oldReplay.state.currentConnection!.id).toBe(q.connectionId); expect(oldReplay.receipt.connectionId).toBe(old.connectionId); expect(oldReplay.replayed).toBe(true);
  });
  it('disconnects and purges, exact old connect replay never resurrects the secret', async () => {
    const f = await fixture(), q = await connect(f); await commit(f, q); const disconnected = await commit(f, disconnect(1));
    expect(disconnected.state).toMatchObject({ revision: 2, currentConnection: null }); expect(disconnected.receipt.connectionId).toBeNull();
    expect(f.sql.prepare('SELECT credentials_ciphertext FROM international_us_support_mailbox_secrets').get()!.credentials_ciphertext).toBeNull();
    expect((await commit(f, q)).state).toEqual(disconnected.state); expect(count(f)).toBe(2);
    expect(() => f.sql.prepare('UPDATE international_us_support_mailbox_secrets SET credentials_ciphertext=?,cleared_by_command_id=NULL').run(q.credentialsCiphertext)).toThrow(/us_mailbox_immutable/);
  });
  it('allows an explicit empty disconnect with a real receipt/CAS', async () => { const f = await fixture(), result = await commit(f, disconnect(0)); expect(result.state).toMatchObject({ revision: 1, currentConnection: null }); expect(count(f)).toBe(1); });
  it.each(['email','tokenSha256','expectedRevision','action'] as const)('rejects changed request material %s instead of adopting it', async field => {
    const f = await fixture(), q = await connect(f); await commit(f, q);
    const changed: UsMailboxPrivateCommand = field === 'action' ? { schemaVersion: 1, requestId: q.requestId, action: 'disconnect', expectedRevision: 0 }
      : { ...q, [field]: field === 'email' ? 'other@example.test' : field === 'tokenSha256' ? 'b'.repeat(64) : 1 };
    await expect(commit(f, changed)).rejects.toMatchObject({ status: 409, code: 'mailbox_idempotency_conflict' }); expect(count(f)).toBe(1);
  });
  it('rejects stale/new expected revision and duplicate connection identity without purging anything', async () => {
    const f = await fixture(), first = await connect(f); await commit(f, first);
    await expect(commit(f, await connect(f))).rejects.toMatchObject({ status: 409 });
    await expect(commit(f, await connect(f, { expectedRevision: 2 }))).rejects.toMatchObject({ status: 409 });
    await expect(commit(f, await connect(f, { expectedRevision: 1, connectionId: first.connectionId }))).rejects.toMatchObject({ status: 503 });
    expect((await f.mailbox.read(f.context())).currentConnection!.credentialsCiphertext).toBe(first.credentialsCiphertext); expect(count(f)).toBe(1);
  });
  it('converges exact concurrent retries with different generated IDs and IVs to one original', async () => {
    const f = await fixture(), q = await connect(f); let queue = Promise.resolve();
    const store = d1UsMailboxStore(intercepted(f, statements => { const result = queue.then(() => f.database.batch(statements)); queue = result.then(() => undefined, () => undefined); return result; }), { now: f.now });
    const results = await Promise.all([store.commit(f.context(), q, async () => f.context()), store.commit(f.context(), { ...q, connectionId: randomUUID() }, async () => f.context())]);
    expect(results[0].receipt).toEqual(results[1].receipt); expect(results.map(r => r.replayed).sort((a, b) => Number(a) - Number(b))).toEqual([false,true]); expect(count(f)).toBe(1);
  });
  it('recovers loss of acknowledgement only from the complete durable atomic receipt', async () => {
    const f = await fixture(), q = await connect(f), store = d1UsMailboxStore(intercepted(f, async statements => { await f.database.batch(statements); throw Error('synthetic lost acknowledgement'); }), { now: f.now });
    expect(await store.commit(f.context(), q, async () => f.context())).toMatchObject({ replayed: true, state: { revision: 1 } }); expect(count(f)).toBe(1);
  });
  it('rolls back receipt, new secret and old-secret purge if any batch effect fails', async () => {
    const f = await fixture(), first = await connect(f); await commit(f, first);
    const store = d1UsMailboxStore(intercepted(f, statements => f.database.batch([...statements, f.database.prepare('INSERT INTO missing_mailbox_test_table(value)VALUES(1)')])), { now: f.now });
    await expect(store.commit(f.context(), await connect(f, { expectedRevision: 1 }), async () => f.context())).rejects.toMatchObject({ status: 503 });
    expect(count(f)).toBe(1); expect((await f.mailbox.read(f.context())).currentConnection!.id).toBe(first.connectionId); expect(count(f, 'international_us_support_mailbox_secrets')).toBe(1);
  });
  it.each(['admin','accountant','member','read_only'] as const)('uses real Team membership and redacts or admits role %s', async role => {
    const f = await fixture(), q = await connect(f); await commit(f, q); const userId = await member(f, role), state = await f.mailbox.read(f.context(userId));
    expect(state.currentConnection!.credentialsCiphertext).toBe(role === 'admin' ? q.credentialsCiphertext : null);
    expect(usMailboxProjection(f.context(userId), state).canManage).toBe(role === 'admin');
    if (role === 'admin') expect((await commit(f, disconnect(1), userId)).receipt.actorUserId).toBe(userId);
    else { await expect(commit(f, disconnect(1), userId)).rejects.toMatchObject({ status: 403 }); await expect(f.mailbox.receipt(f.context(userId), q.requestId, 'a'.repeat(64))).rejects.toMatchObject({ status: 403 }); }
  });
  it('scopes request receipts by actor and denies unknown membership or registry substitution', async () => {
    const f = await fixture(), q = await connect(f), first = await commit(f, q), admin = await member(f, 'admin');
    expect(await f.mailbox.receipt(f.context(admin), q.requestId, first.receipt.requestHash)).toBeNull();
    await expect(f.mailbox.read(f.context(randomUUID()))).rejects.toMatchObject({ status: 403 });
    await expect(f.mailbox.read({ ...f.context(), workspaceId: randomUUID() })).rejects.toMatchObject({ status: 403 });
  });
  it('isolates two real paid US companies of one owner, same request IDs and independent revisions', async () => {
    const f = await fixture(), second = await company(f), q = await connect(f); await commit(f, q);
    const two = await f.mailbox.commit(second(), { ...q, connectionId: randomUUID() }, async () => second());
    expect(two.state.organizationId).not.toBe(f.intent.organizationId); expect(two.state.revision).toBe(1); expect(count(f)).toBe(2);
    await expect(f.mailbox.read({ ...f.context(), workspaceId: second().workspaceId })).rejects.toMatchObject({ status: 403 });
  });
  it('replays under a fresh paid renewal but fences a renewal between JS and the atomic SQL sink', async () => {
    const f = await fixture(), q = await connect(f), first = await commit(f, q); await f.store.apply(f.binding, renewal(f), async () => {});
    expect(await commit(f, q)).toEqual({ ...first, replayed: true });
    const newInvoice = 'in_MailboxSecondRenewal', observation = f.paid({ eventId: 'evt_MailboxSecondRenewal', sourceId: newInvoice, invoiceId: newInvoice,
      authority: { ...f.authority, evidence: { ...f.authority.evidence!, referenceId: newInvoice, startsAt: f.now(), endsAt: f.authority.evidence!.endsAt + 7200 } } });
    const store = d1UsMailboxStore(intercepted(f, async statements => { await f.store.apply(f.binding, observation, async () => {}); return f.database.batch(statements); }), { now: f.now });
    await expect(store.commit(f.context(), disconnect(1), async () => f.context())).rejects.toMatchObject({ status: 409 }); expect(count(f)).toBe(1);
  });
  it('fails closed on revocation even for an exact receipt replay', async () => {
    const f = await fixture(), admin = await member(f, 'admin'), q = await connect(f); await commit(f, q, admin); await revokeMember(f, admin);
    await expect(commit(f, q, admin)).rejects.toMatchObject({ status: 403 });
    f.sql.prepare('UPDATE international_saas_authorities SET revoked_at=? WHERE organization_id=?').run(f.now(), f.intent.organizationId);
    await expect(f.mailbox.read(f.context())).rejects.toMatchObject({ status: 402 }); expect(count(f)).toBe(1);
  });
  it('retains committed history but returns no success after fresh identity loss', async () => {
    const f = await fixture(), q = await connect(f); let committed = false;
    const store = d1UsMailboxStore(intercepted(f, async statements => { const results = await f.database.batch(statements); committed = true; return results; }), { now: f.now });
    await expect(store.commit(f.context(), q, async () => { if (committed) throw Object.assign(Error('unauthorized'), { code: 'unauthorized', status: 401 }); return f.context(); })).rejects.toMatchObject({ status: 503 });
    expect(count(f)).toBe(1); expect((await commit(f, q)).replayed).toBe(true);
  });
  it('returns the original typed fresh-Auth failure instead of a success after the commit', async () => {
    const f = await fixture(), q = await connect(f); let committed = false;
    const store = d1UsMailboxStore(intercepted(f, async statements => { const results = await f.database.batch(statements); committed = true; return results; }), { now: f.now });
    const { UsMailboxError } = await import('./us-support-mailbox-contract');
    await expect(store.commit(f.context(), q, async () => { if (committed) throw new UsMailboxError('unauthorized', 401); return f.context(); })).rejects.toMatchObject({ status: 401 }); expect(count(f)).toBe(1);
  });
  it.each([1,2,3,4] as const)('corroborates actual native session v%s and refuses its revocation', async schema => {
    const f = await fixture(), n = await native(f, schema), c = () => f.context(f.actor, n.credential), q = await connect(f);
    await f.mailbox.commit(c(), q, async () => c()); await n.store.revoke(n.tokenHash, f.now());
    await expect(f.mailbox.read(c())).rejects.toMatchObject({ status: 401 }); await expect(f.mailbox.commit(c(), q, async () => c())).rejects.toMatchObject({ status: 401 });
  });
  it('rejects first stale/future provider verification and expired contexts without persisting anything', async () => {
    const f = await fixture();
    for (const verifiedAt of [f.now() - 31, f.now() + 1]) await expect(commit(f, await connect(f, { verifiedAt }))).rejects.toMatchObject({ status: 409 });
    const old = f.context(); f.setNow(f.now() + 31); await expect(f.mailbox.read(old)).rejects.toMatchObject({ status: 503 }); expect(count(f)).toBe(0);
  });
  it('fails explicitly when0094 is absent without any legacy fallback', async () => { const f = await fixture(false); await expect(f.mailbox.read(f.context())).rejects.toMatchObject({ status: 503 }); await expect(commit(f, await connect(f))).rejects.toMatchObject({ status: 503 }); expect(count(f, 'support_connections')).toBe(0); });
});

describe('0094 direct SQL integrity independent of JS validation', () => {
  async function pending(f: Fixture) {
    if (count(f) === 0) await commit(f, await connect(f));
    const saved = { ...f.sql.prepare('SELECT * FROM international_us_support_mailbox_receipts').get()! } as Record<string, SQLInputValue>;
    const material = { schemaVersion: 1, requestId: randomUUID(), expectedRevision: 1, action: 'disconnect' }, receipt = JSON.parse(saved.receipt_json as string) as Record<string, unknown>;
    const commandId = randomUUID(); Object.assign(saved, { command_id: commandId, request_id: material.requestId, action: 'disconnect', expected_revision: 1, revision: 2, connection_id: null,
      material_json: canonicalErpJson(material), receipt_json: canonicalErpJson({ ...receipt, requestId: material.requestId, action: 'disconnect', expectedRevision: 1, revision: 2, connectionId: null }) });
    return saved;
  }
  function insert(f: Fixture, values: Record<string, SQLInputValue>, replace = false) { const keys = Object.keys(values); f.sql.prepare(`INSERT ${replace ? 'OR REPLACE ' : ''}INTO international_us_support_mailbox_receipts(${keys.join(',')})VALUES(${keys.map(() => '?').join(',')})`).run(...Object.values(values)); }
  it('rejects an otherwise scoped receipt without a matching atomic final effect', async () => {
    const f = await fixture(), saved = await pending(f); f.sql.exec('BEGIN'); insert(f, saved);
    expect(() => f.sql.exec('COMMIT')).toThrow(/FOREIGN KEY/); f.sql.exec('ROLLBACK'); expect(count(f)).toBe(1);
  });
  it.each(['authorityReference','validStartsAt','validEndsAt','seatLimit','ownerUserId','subscriptionId','priceId','environment','catalogVersion'] as const)('rejects direct %s context drift at the sink', async field => {
    const f = await fixture(), saved = await pending(f), captured = JSON.parse(saved.context_json as string) as UsMailboxContext;
    const before = captured.authority[field]; saved.context_json = canonicalErpJson({ ...captured, authority: { ...captured.authority, [field]: typeof before === 'number' ? before + 1 : before + '_different' } });
    expect(() => insert(f, saved)).toThrow(/us_mailbox_subscription_required/); expect(count(f)).toBe(1);
  });
  it('rejects metadata-only member writes and stale SQL timestamps', async () => {
    const f = await fixture(), saved = await pending(f), captured = JSON.parse(saved.context_json as string) as UsMailboxContext;
    const userId = await member(f, 'member'); saved.actor_user_id = userId;
    saved.context_json = canonicalErpJson({ ...captured, authority: { ...captured.authority, userId, role: 'member' } });
    saved.receipt_json = canonicalErpJson({ ...JSON.parse(saved.receipt_json as string), actorUserId: userId }); expect(() => insert(f, saved)).toThrow(/us_mailbox_forbidden/);
    const other = await pending(f); f.setNow(f.now() + 31); expect(() => insert(f, other)).toThrow(/us_mailbox_subscription_required/); expect(count(f)).toBe(1);
  });
  it('rejects mutable/replaced/deleted history and direct secret purge with no current command', async () => {
    const f = await fixture(), q = await connect(f); await commit(f, q);
    for (const table of ['international_us_support_mailbox_receipts','international_us_support_mailbox_connections','international_us_support_mailbox_commits']) {
      const key = table.endsWith('connections') ? 'connection_id' : 'command_id'; expect(() => f.sql.exec(`UPDATE ${table} SET ${key}=${key}`)).toThrow(/us_mailbox_immutable/);
      expect(() => f.sql.exec(`DELETE FROM ${table}`)).toThrow(/us_mailbox_immutable/);
    }
    expect(() => f.sql.exec('DELETE FROM international_us_support_mailbox_heads')).toThrow(/us_mailbox_immutable/);
    expect(() => f.sql.exec('DELETE FROM international_us_support_mailbox_secrets')).toThrow(/us_mailbox_immutable/);
    expect(() => f.sql.prepare('UPDATE international_us_support_mailbox_secrets SET credentials_ciphertext=NULL,cleared_by_command_id=?').run(randomUUID())).toThrow(/us_mailbox_immutable/);
    const saved = { ...f.sql.prepare('SELECT * FROM international_us_support_mailbox_receipts').get()! } as Record<string, SQLInputValue>; expect(() => insert(f, saved, true)).toThrow(/us_mailbox_idempotency_conflict/);
  });
  it('rolls back an in-batch expiry at the final marker as well as at initial receipt', async () => {
    const f = await fixture(), q = await connect(f); let tick = false;
    const store = d1UsMailboxStore(intercepted(f, async statements => {
      const last = statements.at(-1)!; const wrapped = statements.slice(0, -1);
      wrapped.push({ run: async () => { if (!tick) { tick = true; f.setNow(f.now() + 31); } return last.run(); } } as D1PreparedStatement);
      return f.database.batch(wrapped);
    }), { now: f.now });
    await expect(store.commit(f.context(), q, async () => f.context())).rejects.toMatchObject({ status: 503 }); expect(count(f)).toBe(0);
  });
});
