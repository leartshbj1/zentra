import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createUsMailboxProvider } from './us-support-mailbox-provider';
import { UsMailboxError, type UsMailboxConnection, type UsMailboxContext } from './us-support-mailbox-contract';
import { validateUsMailboxMessages, validateUsMailboxOffset } from './us-support-mailbox-messages';

function setup() {
  const now = 1791600000, org = randomUUID(), user = randomUUID();
  const context: UsMailboxContext = { schemaVersion: 1, workspaceId: randomUUID(), authority: { schemaVersion: 1, organizationId: org, userId: user, ownerUserId: user, role: 'owner', subscriptionId: 'sub_Test', environment: 'TEST', catalogVersion: 'test', priceId: 'price_Test', authorityReference: 'in_Test', validStartsAt: now - 100, validEndsAt: now + 1000, seatLimit: 3, checkedAt: now, credential: { kind: 'browser' } } };
  const connection: UsMailboxConnection = { id: randomUUID(), provider: 'infomaniak', email: 'info@example.test', mailboxId: 'box-private', folderId: 'inbox-private', tokenSha256: 'a'.repeat(64), credentialsCiphertext: null, verifiedAt: now, connectedBy: user, revision: 1 };
  const calls: { url: URL; init?: RequestInit }[] = [];
  let threads: unknown[] = [{ messages: [{ uid: '42@server', folder_id: 'inbox-private', date: now + 0.25 }] }], body: Record<string, unknown> = { date: now, subject: 'Invoice', from: [{ email: 'vendor@example.test' }], body: '<script>bad()</script><p>Private mail text</p>', attachments: [{ part_id: 'part-1', name: 'invoice.pdf', size: 123 }, { part_id: 'part-2', name: 'meeting.ics', size: 50 }] };
  const fetcher: typeof fetch = vi.fn(async (input, init) => { const url = new URL(String(input)); calls.push({ url, init });
    const data = url.pathname.endsWith('/mailbox') ? [{ uuid: 'box-private', email: 'info@example.test' }] : url.pathname.endsWith('/folder') ? [{ id: 'inbox-private', role: 'inbox' }] : url.pathname.endsWith('/message') ? { threads } : body;
    return Response.json({ result: 'success', data });
  });
  return { now, context, connection, calls, fetcher, provider: createUsMailboxProvider(fetcher), threads: (value: unknown[]) => { threads = value; }, body: (value: Record<string, unknown>) => { body = value; } };
}
describe('US Infomaniak adapter, fake fixed-origin provider', () => {
  it('verifies existing mailbox and inbox with the shared connector', async () => {
    const t = setup(), check = vi.fn(async () => {});
    expect(await t.provider.verify('info@example.test', 'fixture-key', check)).toEqual({ mailboxId: 'box-private', folderId: 'inbox-private' });
    expect(t.calls).toHaveLength(2); expect(t.calls.every(c => c.url.origin === 'https://mail.infomaniak.com' && c.init?.redirect === 'manual')).toBe(true); expect(check.mock.calls.length).toBeGreaterThanOrEqual(5);
  });
  it('returns detached metadata, no mail text/HTML/URLs/keys, with finite thread pagination', async () => {
    const t = setup(), result = await t.provider.messages(t.context, t.connection, 'fixture-key', 0, async () => {});
    expect(result).toEqual({ messages: [{ uid: '42', version: String(t.now), subject: 'Invoice', sender: 'vendor@example.test', receivedAt: t.now, attachments: [{ id: 'part-1', name: 'invoice.pdf', sizeBytes: 123 }, { id: 'part-2', name: 'meeting.ics', sizeBytes: 50 }] }], nextOffset: null });
    expect(JSON.stringify(result)).not.toMatch(/Private mail|fixture-key|<script>|https:/); expect(t.calls[0].url.searchParams.get('limit')).toBe('20'); expect(t.calls.every(c => !c.init?.method || c.init.method === 'GET')).toBe(true);
  });
  it('checks revocation before the next request after a provider body has been read', async () => {
    const t = setup(); let checks = 0;
    await expect(t.provider.messages(t.context, t.connection, 'fixture', 0, async () => { if (++checks >= 3) throw new UsMailboxError('forbidden', 403); })).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    expect(t.calls).toHaveLength(1);
  });
  it.each(['duplicate','tooManyThreads','tooManyMessages','missingDate'] as const)('refuses %s without reading message bodies', async kind => {
    const t = setup(), message = { uid: '42', date: t.now };
    t.threads(kind === 'duplicate' ? [{ messages: [message, message] }] : kind === 'tooManyThreads' ? Array.from({ length: 21 }, (_, i) => ({ messages: [{ ...message, uid: String(i) }] })) : kind === 'tooManyMessages' ? [{ messages: Array.from({ length: 101 }, (_, i) => ({ ...message, uid: String(i) })) }] : [{ messages: [{ uid: '42' }] }]);
    await expect(t.provider.messages(t.context, t.connection, 'fixture', 0, async () => {})).rejects.toMatchObject({ status: 503 }); expect(t.calls).toHaveLength(1);
  });
  it('uses thread count for next page and stops at the explicit maximum', async () => {
    const t = setup(); t.threads(Array.from({ length: 20 }, (_, i) => ({ messages: [{ uid: String(i + 1), date: t.now }] })));
    expect((await t.provider.messages(t.context, t.connection, 'fixture', 180, async () => {})).nextOffset).toBe(200);
    expect((await t.provider.messages(t.context, t.connection, 'fixture', 200, async () => {})).nextOffset).toBeNull();
  });
  it.each([{ date: '', subject: 'x' }, { date: 1, subject: 'bad\u202e' }, { date: 1, attachments: [{ part_id: '1', name: 'invoice.pdf', size: 7 * 1024 * 1024 }] }])('fails closed on unusable version or unsafe metadata %j', async body => {
    const t = setup(); t.body(body); await expect(t.provider.messages(t.context, t.connection, 'fixture', 0, async () => {})).rejects.toMatchObject({ status: 503 });
  });
  it('provider errors never expose diagnostics, mail or credential values', async () => {
    const provider = createUsMailboxProvider(async () => new Response('private-provider-token-and-mail', { status: 401 }));
    await expect(provider.verify('info@example.test', 'fixture', async () => {})).rejects.toMatchObject({ code: 'mailbox_credentials_rejected', message: 'mailbox_credentials_rejected' });
  });
});
describe('US mailbox public message contract', () => {
  it.each([null,'0','20','200'])('accepts bounded offset %s', value => expect(validateUsMailboxOffset(value)).toBe(Number(value)));
  it.each(['01','-1','1','220','2e1',' 20','20.0'])('rejects malformed offset %s', value => expect(() => validateUsMailboxOffset(value)).toThrow());
  it('refuses cross-company, member, private fields, duplicate source and arbitrary next pages', () => {
    const t = setup(), base = { schemaVersion: 1, organizationId: t.context.authority.organizationId, userId: t.context.authority.userId, role: 'owner', workspaceId: t.context.workspaceId, connectionId: t.connection.id, revision: 1, offset: 0, nextOffset: null, messages: [{ uid: '1', version: 'date', subject: '', sender: '', receivedAt: t.now, attachments: [] }] };
    expect(validateUsMailboxMessages(base)).toEqual(base);
    for (const value of [{ ...base, role: 'member' }, { ...base, token: 'secret' }, { ...base, nextOffset: 200 }, { ...base, messages: [base.messages[0],base.messages[0]] }]) expect(() => validateUsMailboxMessages(value)).toThrow();
    expect(() => validateUsMailboxMessages(base, randomUUID())).toThrow();
  });
});
