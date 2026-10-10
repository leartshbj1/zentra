import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createUsMailboxHandlers, type UsMailboxDependencies } from './us-support-mailbox-server';
import { hashUsMailboxPrivateCommand, UsMailboxError, type UsMailboxContext, type UsMailboxState, type UsMailboxReceipt, type UsMailboxStore } from './us-support-mailbox-contract';

function setup() {
  const org = randomUUID(), user = randomUUID(), workspaceId = randomUUID(), clock = 1791600000;
  let context: UsMailboxContext = { schemaVersion: 1, workspaceId, authority: { schemaVersion: 1, organizationId: org, userId: user, role: 'owner', ownerUserId: user, subscriptionId: 'sub_Test', environment: 'TEST', catalogVersion: 'test-v1', priceId: 'price_Test', authorityReference: 'in_Test', validStartsAt: clock - 1000, validEndsAt: clock + 1000, seatLimit: 3, checkedAt: clock, credential: { kind: 'browser' } } };
  let head: UsMailboxState = { schemaVersion: 1, organizationId: org, workspaceId, revision: 0, currentConnection: null }, gate = true;
  const receipts = new Map<string, UsMailboxReceipt>();
  const store: UsMailboxStore = {
    read: vi.fn(async () => head),
    receipt: vi.fn(async (c, id, hash) => { const found = receipts.get(c.authority.userId + id); if (found && found.requestHash !== hash) throw new UsMailboxError('mailbox_idempotency_conflict', 409); return found ?? null; }),
    commit: vi.fn(async (c, q, revalidate) => {
      await revalidate(); const hash = await hashUsMailboxPrivateCommand(org, c.authority.userId, q), found = await store.receipt(c, q.requestId, hash);
      if (found) return { state: head, receipt: found, replayed: true };
      if (head.revision !== q.expectedRevision) throw new UsMailboxError('mailbox_revision_conflict', 409);
      head = { ...head, revision: q.expectedRevision + 1, currentConnection: q.action === 'disconnect' ? null : { id: q.connectionId, revision: q.expectedRevision + 1, provider: q.provider, email: q.email, mailboxId: q.mailboxId, folderId: q.folderId, tokenSha256: q.tokenSha256, credentialsCiphertext: q.credentialsCiphertext, verifiedAt: q.verifiedAt, connectedBy: c.authority.userId } };
      const receipt: UsMailboxReceipt = { schemaVersion: 1, organizationId: org, workspaceId, actorUserId: c.authority.userId, requestId: q.requestId, requestHash: hash, action: q.action, expectedRevision: q.expectedRevision, revision: head.revision, connectionId: head.currentConnection?.id ?? null, createdAt: clock };
      receipts.set(c.authority.userId + q.requestId, receipt); return { state: head, receipt, replayed: false };
    }),
  };
  const dependencies: UsMailboxDependencies = { enabled: async () => gate, now: () => clock, member: async () => context, store: async () => store, encryptionKey: async () => btoa('x'.repeat(32)), verify: vi.fn(async () => ({ mailboxId: 'private-provider-box', folderId: 'private-provider-folder' })), messages: vi.fn(async () => ({ messages: [{ uid: '42', version: String(clock), subject: 'Invoice example', sender: 'vendor@example.test', receivedAt: clock, attachments: [{ id: 'part1', name: 'invoice.pdf', sizeBytes: 1024 }] }], nextOffset: null })), diagnostic: vi.fn() };
  const handlers = createUsMailboxHandlers(dependencies);
  const input = () => ({ schemaVersion: 1 as const, action: 'connect' as const, requestId: randomUUID(), expectedRevision: head.revision, email: 'info@example.test', token: 'fictional-test-token' });
  const request = (body?: unknown, headers: Record<string, string> = {}, suffix = '') => new Request('https://zentra.example.test/api/mailbox' + suffix, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: 'https://zentra.example.test', 'Content-Type': 'application/json', 'X-Zentra-Expected-User': context.authority.userId, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { org, user, workspaceId, clock, handlers, dependencies, store, receipts, input, request, context: () => context, actor: (next: UsMailboxContext) => { context = next; }, head: () => head, state: (next: UsMailboxState) => { head = next; }, gate: (value: boolean) => { gate = value; } };
}
describe('US mailbox HTTP with fictitious Auth/RAM store and real AES-GCM', () => {
  it('metadata read does not touch the key or provider', async () => {
    const t = setup(), key = vi.fn(t.dependencies.encryptionKey); t.dependencies.encryptionKey = key;
    const response = await t.handlers.read(t.request(), t.org); expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(await response.json()).toMatchObject({ revision: 0, canManage: true, connection: null }); expect(key).not.toHaveBeenCalled(); expect(t.dependencies.verify).not.toHaveBeenCalled(); expect(t.dependencies.messages).not.toHaveBeenCalled();
  });
  it('connect stores only ciphertext, verifies credentials and projects no private fields', async () => {
    const t = setup(), q = t.input(), response = await t.handlers.write(t.request(q), t.org), body = await response.text();
    expect(response.status).toBe(200); expect(body).not.toContain(q.token); expect(body).not.toContain('private-provider'); expect(body).not.toContain('credentialsCiphertext'); expect(body).not.toContain('tokenSha256');
    expect(t.head().currentConnection?.credentialsCiphertext).toMatch(/^v1\./); expect(JSON.stringify(t.head())).not.toContain(q.token); expect(t.dependencies.verify).toHaveBeenCalledOnce();
  });
  it('lost acknowledgement retries before provider/key access and never reconnects an old head', async () => {
    const t = setup(), q = t.input(); await t.handlers.write(t.request(q), t.org);
    const d = { schemaVersion: 1, action: 'disconnect', requestId: randomUUID(), expectedRevision: 1 };
    expect((await t.handlers.write(t.request(d), t.org)).status).toBe(200);
    t.dependencies.verify = async () => { throw Error('must not verify'); }; t.dependencies.encryptionKey = async () => { throw Error('must not read key'); };
    const response = await t.handlers.write(t.request(q), t.org); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ projection: { revision: 2, connection: null }, replayed: true, receipt: { revision: 1 } });
    expect(t.receipts.size).toBe(2);
  });
  it('same request different token conflicts without provider access', async () => {
    const t = setup(), q = t.input(); await t.handlers.write(t.request(q), t.org);
    expect((await t.handlers.write(t.request({ ...q, token: 'different' }), t.org)).status).toBe(409); expect(t.dependencies.verify).toHaveBeenCalledOnce();
  });
  it('explicit message read decrypts under the bound company and returns only metadata', async () => {
    const t = setup(); await t.handlers.write(t.request(t.input()), t.org);
    expect(t.dependencies.messages).not.toHaveBeenCalled();
    const response = await t.handlers.messages(t.request(undefined, {}, '?offset=0'), t.org); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ organizationId: t.org, userId: t.user, workspaceId: t.workspaceId, revision: 1, messages: [{ uid: '42', attachments: [{ name: 'invoice.pdf' }] }] });
    expect(t.dependencies.messages).toHaveBeenCalledOnce();
  });
  it.each(['organization','workspace','revision'] as const)('ciphertext copied to another %s cannot be decrypted', async field => {
    const t = setup(); await t.handlers.write(t.request(t.input()), t.org);
    const c = t.context(), state = t.head();
    if (field === 'workspace') { const w = randomUUID(); t.actor({ ...c, workspaceId: w }); t.state({ ...state, workspaceId: w }); }
    else if (field === 'organization') { const id = randomUUID(); t.actor({ ...c, authority: { ...c.authority, organizationId: id } }); t.state({ ...state, organizationId: id }); }
    else t.state({ ...state, revision: 2, currentConnection: { ...state.currentConnection!, revision: 2 } });
    const response = await t.handlers.messages(t.request(), t.context().authority.organizationId); expect(response.status).toBe(503); expect(t.dependencies.messages).not.toHaveBeenCalled();
  });
  it.each(['member','read_only','accountant'] as const)('%s may read sanitized connection metadata but not mail/connect/disconnect', async role => {
    const t = setup(); await t.handlers.write(t.request(t.input()), t.org); t.actor({ ...t.context(), authority: { ...t.context().authority, userId: randomUUID(), role } });
    const response = await t.handlers.read(t.request(), t.org); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ canManage: false, connection: { email: 'info@example.test' } });
    expect((await t.handlers.messages(t.request(), t.org)).status).toBe(403); expect((await t.handlers.write(t.request(t.input()), t.org)).status).toBe(403);
  });
  it.each(['gate','user','role','period','workspace'] as const)('change in %s during verification prevents commit', async kind => {
    const t = setup(); t.dependencies.verify = async () => { const c = t.context();
      if (kind === 'gate') t.gate(false);
      else if (kind === 'workspace') t.actor({ ...c, workspaceId: randomUUID() });
      else t.actor({ ...c, authority: kind === 'user' ? { ...c.authority, userId: randomUUID(), role: 'admin' } : kind === 'role' ? { ...c.authority, userId: randomUUID(), role: 'member' } : { ...c.authority, authorityReference: 'in_Renewed' } });
      return { mailboxId: 'box', folderId: 'folder' };
    };
    const response = await t.handlers.write(t.request(t.input()), t.org); expect([401,403,404,409]).toContain(response.status); expect(t.store.commit).not.toHaveBeenCalled();
  });
  it('disconnect during provider read suppresses the page', async () => {
    const t = setup(); await t.handlers.write(t.request(t.input()), t.org); t.dependencies.messages = async () => { t.state({ ...t.head(), revision: 2, currentConnection: null }); return { messages: [], nextOffset: null }; };
    const response = await t.handlers.messages(t.request(), t.org); expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: 'mailbox_revision_conflict' });
  });
  it('late revocation dominates private provider errors and diagnostics are sanitized', async () => {
    const t = setup(); t.dependencies.verify = async () => { t.dependencies.member = async () => { throw new UsMailboxError('forbidden', 403); }; throw Error('private-key-mail-body'); };
    const response = await t.handlers.write(t.request(t.input()), t.org); expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: 'forbidden' }); expect(JSON.stringify((t.dependencies.diagnostic as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('private-key');
  });
  it('cross-origin/browser-bearer/expected-user mismatches cannot verify or commit', async () => {
    const t = setup(), q = t.input();
    const invalidHeaders: Record<string, string>[] = [{ Origin: 'https://foreign.example.test' }, { Authorization: 'Bearer unexpected' }, { 'X-Zentra-Expected-User': randomUUID() }];
    for (const h of invalidHeaders) expect([401,403]).toContain((await t.handlers.write(t.request(q, h), t.org)).status);
    expect(t.dependencies.verify).not.toHaveBeenCalled(); expect(t.store.commit).not.toHaveBeenCalled();
  });
  it('device auth requires a bearer and does not use browser origin as authority', async () => {
    const t = setup(); t.actor({ ...t.context(), authority: { ...t.context().authority, credential: { kind: 'device', sessionId: 'usd_' + randomUUID(), supportedSchemaVersion: 4 } } });
    expect((await t.handlers.write(t.request(t.input()), t.org)).status).toBe(401);
    expect((await t.handlers.write(t.request(t.input(), { Authorization: 'Bearer fixture', Origin: 'https://device.example.test' }), t.org)).status).toBe(200);
  });
  it.each(['?offset=-1','?offset=1','?offset=220','?offset=0&offset=20','?other=1'])('refuses malformed pagination %s without storage or provider reads', async suffix => {
    const t = setup(); expect((await t.handlers.messages(t.request(undefined, {}, suffix), t.org)).status).toBe(422); expect(t.store.read).not.toHaveBeenCalled();
  });
  it('malformed or oversized commands and closed gate have no effects', async () => {
    const t = setup(); for (const q of [{ ...t.input(), extra: true }, { ...t.input(), token: 'x'.repeat(20_000) }]) expect((await t.handlers.write(t.request(q), t.org)).status).toBe(422);
    t.gate(false); expect((await t.handlers.write(t.request(t.input()), t.org)).status).toBe(404); expect(t.store.commit).not.toHaveBeenCalled(); expect(t.dependencies.verify).not.toHaveBeenCalled();
  });
  it('does not accept corrupt mail DTOs or extra private body content', async () => {
    const t = setup(); await t.handlers.write(t.request(t.input()), t.org);
    t.dependencies.messages = async () => ({ messages: [{ uid: '1', version: 'v', subject: 'x', sender: '', receivedAt: t.clock, attachments: [], body: 'private' }], nextOffset: null });
    expect((await t.handlers.messages(t.request(), t.org)).status).toBe(503);
  });
  it('first-invocation credential rejection precedes commit; a commit-attempt rejection stays uncertain', async () => {
    const t = setup(); t.dependencies.verify = async () => { throw new UsMailboxError('mailbox_credentials_rejected', 422); };
    expect((await t.handlers.write(t.request(t.input()), t.org)).status).toBe(422); expect(t.store.commit).not.toHaveBeenCalled();
    t.dependencies.verify = async () => ({ mailboxId: 'box', folderId: 'folder' });
    t.store.commit = async () => { throw new UsMailboxError('mailbox_credentials_rejected', 422); };
    const uncertain = await t.handlers.write(t.request(t.input()), t.org); expect(uncertain.status).toBe(503); expect(await uncertain.json()).toEqual({ error: 'service_unavailable' });
  });
});
