import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UsSupportMailboxContent, UsSupportMailboxPanel, usSupportMailboxCopy } from '../../components/account/us-support-mailbox-panel';
import { UsSupportWorkspaceContent } from '../../components/account/us-support-workspace-panel';
import { createBrowserUsMailboxSession } from './browser-us-support-mailbox-session';
import { hashUsMailboxRequest, type UsMailboxProjection, type UsMailboxRequest } from './us-support-mailbox-contract';
import type { UsMailboxMessages } from './us-support-mailbox-messages';

const org = '11111111-1111-4111-8111-111111111111', user = '22222222-2222-4222-8222-222222222222', requestId = '33333333-3333-4333-8333-333333333333', workspaceId = '44444444-4444-4444-8444-444444444444', connectionId = '55555555-5555-4555-8555-555555555555', secondConnection = '66666666-6666-4666-8666-666666666666';
const projection = (patch: Partial<UsMailboxProjection> = {}): UsMailboxProjection => ({ schemaVersion: 1, organizationId: org, userId: user, role: 'owner', workspaceId, revision: 0, canManage: true, connection: null, ...patch });
const connected = (patch: Partial<UsMailboxProjection> = {}) => projection({ revision: 1, connection: { id: connectionId, provider: 'infomaniak', email: 'info@example.test', verifiedAt: 1_791_600_000 }, ...patch });
const draft = { action: 'connect' as const, email: 'info@example.test', token: 'fixture-api-key-private' };
const command = (patch: Partial<UsMailboxRequest> = {}): UsMailboxRequest => ({ schemaVersion: 1, requestId, expectedRevision: 0, ...draft, ...patch });
async function result(input = command(), value = connected(), replayed = false) { return { projection: value, receipt: { schemaVersion: 1, organizationId: org, workspaceId, actorUserId: user, requestId: input.requestId, requestHash: await hashUsMailboxRequest(org, user, input), action: input.action, expectedRevision: input.expectedRevision, revision: input.expectedRevision + 1, connectionId: input.action === 'connect' ? connectionId : null, createdAt: 1_791_600_000 }, replayed }; }
const page = (patch: Partial<UsMailboxMessages> = {}): UsMailboxMessages => ({ schemaVersion: 1, organizationId: org, userId: user, role: 'owner', workspaceId, connectionId, revision: 1, offset: 0, nextOffset: 20, messages: [{ uid: '123', version: 'observed-2026-10-10', subject: '<script>private mail</script>', sender: 'Accounts <accounts@example.test>', receivedAt: 1_791_600_000, attachments: [{ id: 'attachment-1', name: 'original.pdf', sizeBytes: 4096 }] }], ...patch });
const json = (value: unknown, status = 200) => Response.json(value, { status });
function fixture(patch: Partial<Parameters<typeof createBrowserUsMailboxSession>[0]> = {}) { const fetcher = vi.fn<typeof fetch>(); return { fetcher, session: createBrowserUsMailboxSession({ organizationId: org, expectedUserId: user, role: 'owner', workspaceId, fetch: fetcher, newId: () => requestId, ...patch }) }; }
const noop = () => {};
function content(language: 'fr' | 'de' | 'it' | 'en', value: UsMailboxProjection | null, patch: Partial<Parameters<typeof UsSupportMailboxContent>[0]> = {}) {
  return renderToStaticMarkup(createElement(UsSupportMailboxContent, { language, projection: value, messages: null, email: '', token: '', review: null, busy: false, loading: false, reading: false, pending: false, terminal: false, error: '', saved: false, onEmail: noop, onToken: noop, onReview: noop, onDisconnect: noop, onBack: noop, onConfirm: noop, onRetry: noop, onRefresh: noop, onRead: noop, ...patch }));
}
afterEach(() => vi.useRealTimers());

describe('US Support H2a honest mailbox interface', () => {
  for (const language of ['fr', 'de', 'it', 'en'] as const) {
    it(`renders explicit ${language} connection choices and password input without legacy links`, () => {
      const html = content(language, projection()), c = usSupportMailboxCopy[language];
      for (const key of ['title', 'limitation', 'email', 'token', 'tokenHelp', 'review'] as const) expect(html).toContain(c[key]);
      expect(html).toContain('type="password"'); expect(html).toContain('autoComplete="new-password"'); expect(html).toContain('type="email"'); expect(html).not.toContain('<a '); expect(html).not.toContain('JEV'); expect(html).not.toContain('/support/espace');
    });
    it(`keeps the key out of the ${language} confirmation and exposes explicit back/confirm`, () => {
      const html = content(language, projection(), { token: draft.token, review: { draft, expectedRevision: 0 } }), c = usSupportMailboxCopy[language];
      expect(html).toContain(c.connectTitle); expect(html).toContain(c.connectHelp); expect(html).toContain(c.confirmConnect); expect(html).toContain(c.back); expect(html).toContain(draft.email); expect(html).not.toContain(draft.token); expect(html).not.toContain('<form');
    });
    it(`renders ${language} manual metadata-only messages without HTML, IDs or import controls`, () => {
      const html = content(language, connected(), { messages: page() }), c = usSupportMailboxCopy[language];
      expect(html).toContain(c.manual); expect(html).toContain(c.attachments); expect(html).toContain('original.pdf'); expect(html).toContain(c.next); expect(html).toContain('&lt;script&gt;private mail&lt;/script&gt;'); expect(html).not.toContain('<script>'); expect(html).not.toContain('attachment-1'); expect(html).not.toContain(connectionId); expect(html).not.toContain('<a ');
    });
  }
  for (const role of ['accountant', 'member', 'read_only'] as const) it(`shows ${role} metadata without management, key or mail controls`, () => {
    const html = content('en', connected({ role, canManage: false })); expect(html).toContain(draft.email); expect(html).toContain(usSupportMailboxCopy.en.member); expect(html).not.toContain('<form'); expect(html).not.toContain('type="password"'); expect(html).not.toContain(usSupportMailboxCopy.en.read);
  });
  it('confirms disconnection inline and never includes a key', () => {
    const html = content('en', connected(), { review: { draft: { action: 'disconnect' }, expectedRevision: 1 } }); expect(html).toContain(usSupportMailboxCopy.en.disconnectHelp); expect(html).toContain(usSupportMailboxCopy.en.confirmDisconnect); expect(html).not.toContain('<form'); expect(html).not.toContain(draft.token);
  });
  it('keeps retry enabled with a pending operation and hides every new mutation', () => {
    const html = content('en', connected(), { pending: true, token: draft.token }); expect(html).toContain(usSupportMailboxCopy.en.pending); expect(html).toMatch(/<button type="button" class="account-button">Retry the same request<\/button>/); expect(html).not.toContain('<form'); expect(html).not.toContain(draft.token); expect(html).toMatch(/<button type="button" class="account-button secondary" disabled="">Read messages<\/button>/);
  });
  it('explains a rejected credential in an accessible error and unlocks correction', () => {
    const html = content('en', projection(), { error: 'mailbox_credentials_rejected' }); expect(html).toContain(usSupportMailboxCopy.en.rejected); expect(html).toContain('role="alert"'); expect(html).toContain('aria-invalid="true"'); expect(html).toContain('<form');
  });
  it('starts scoped panels without private connection data in SSR', () => {
    const html = renderToStaticMarkup(createElement(UsSupportMailboxPanel, { organizationId: org, expectedUserId: user, role: 'owner', workspaceId, language: 'en' })); expect(html).not.toContain(draft.email); expect(html).not.toContain(draft.token); expect(html).not.toContain('<form');
  });
  it('retains H1 registry-only copy by default and changes it only with prepared H2 admission', () => {
    const props = { language: 'en' as const, projection: { schemaVersion: 1 as const, organizationId: org, userId: user, role: 'owner' as const, canCreate: false, stage: 'registry_only' as const, mailboxAvailable: false as const, classificationAvailable: false as const, workspace: { schemaVersion: 1 as const, organizationId: org, workspaceId, ownerUserId: user, connectedBy: user, name: 'Support', revision: 1 as const, createdAt: 1_791_600_000 } }, name: '', busy: false, loading: false, pending: false, terminal: false, error: '', saved: false, onName: noop, onSubmit: noop, onRetry: noop, onRefresh: noop };
    expect(renderToStaticMarkup(createElement(UsSupportWorkspaceContent, props))).toContain('Mailbox connection, mail reception and sorting are not available');
    expect(renderToStaticMarkup(createElement(UsSupportWorkspaceContent, { ...props, mailboxEnabled: true }))).toContain('The mailbox is read only at your request');
  });
  it('polls metadata alone and multiplexes nested invalidation without overwriting the parent', () => {
    const child = readFileSync(new URL('../../components/account/us-support-mailbox-panel.tsx', import.meta.url), 'utf8'), parent = readFileSync(new URL('../../components/account/us-support-workspace-panel.tsx', import.meta.url), 'utf8');
    expect(child).toContain("import './us-erp-workbench.css'"); expect(child).toContain('intervalMs: 30_000'); expect(child).toContain('tick: () => load(true)'); expect(child).not.toContain('localStorage'); expect(child).not.toContain('sessionStorage');
    expect(parent).toContain('mailboxEnabled = false'); expect(parent).toContain('mailboxInvalidation.current?.()'); expect(parent).toContain('registerInvalidation={registerMailboxInvalidation}'); expect(parent).not.toContain('registerInvalidation={registerInvalidation}');
  });
});

describe('US mailbox browser transport', () => {
  it('makes no automatic request and uses private same-origin reads before explicit changes', async () => {
    const { session, fetcher } = fixture(); expect(fetcher).not.toHaveBeenCalled(); fetcher.mockResolvedValueOnce(json(projection())).mockResolvedValueOnce(json(await result()));
    await session.load(); expect(fetcher.mock.calls[0][0]).toBe(`/api/international/workspaces/${org}/support-mailbox`); expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'X-Zentra-Expected-User': user } });
    await session.change({ ...draft, email: ' Info@Example.Test ', token: ` Bearer ${draft.token} ` }, 0); const body = fetcher.mock.calls[1][1]?.body; if (typeof body !== 'string') throw Error('Expected JSON command'); expect(JSON.parse(body)).toEqual(command()); expect(session.hasPending()).toBe(false); session.dispose();
  });
  it('retains exact ID, key, address and revision after lost ACK even when metadata finds our committed connection', async () => {
    const { session, fetcher } = fixture(); fetcher.mockResolvedValueOnce(json(projection())).mockRejectedValueOnce(Error('private-provider-detail')).mockResolvedValueOnce(json(connected())).mockResolvedValueOnce(json(await result(command(), connected(), true)));
    await session.load(); await expect(session.change(draft, 0)).rejects.toMatchObject({ code: 'service_unavailable' }); expect(session.hasPending()).toBe(true); await session.load(); expect(session.hasPending()).toBe(true);
    await expect(session.change({ action: 'disconnect' }, 1)).rejects.toMatchObject({ code: 'pending_operation' }); await session.retry(); expect(fetcher.mock.calls[3][1]?.body).toBe(fetcher.mock.calls[1][1]?.body); expect(session.hasPending()).toBe(false); session.dispose();
  });
  it('historical replay adopts a newer disconnected head without resurrecting the old mailbox', async () => {
    const { session, fetcher } = fixture(), newer = projection({ revision: 2 }); fetcher.mockResolvedValueOnce(json(projection())).mockRejectedValueOnce(Error('lost')).mockResolvedValueOnce(json(newer)).mockResolvedValueOnce(json(await result(command(), newer, true)));
    await session.load(); await expect(session.change(draft, 0)).rejects.toMatchObject({ code: 'service_unavailable' }); await session.load(); expect(await session.retry()).toEqual(newer); expect(session.hasPending()).toBe(false); await expect(session.messages()).rejects.toMatchObject({ code: 'read_required' }); expect(fetcher).toHaveBeenCalledTimes(4); session.dispose();
  });
  it('correlates disconnect receipts without expecting an obsolete connection ID', async () => {
    const { session, fetcher } = fixture(), input: UsMailboxRequest = { schemaVersion: 1, requestId, expectedRevision: 1, action: 'disconnect' }, value = projection({ revision: 2 }); fetcher.mockResolvedValueOnce(json(connected())).mockResolvedValueOnce(json(await result(input, value)));
    await session.load(); expect(await session.change({ action: 'disconnect' }, 1)).toEqual(value); expect(session.hasPending()).toBe(false); session.dispose();
  });
  for (const code of ['invalid_mailbox_request', 'mailbox_credentials_rejected']) it(`releases only authoritative ${code}422 so the key can be corrected`, async () => {
    const { session, fetcher } = fixture(); fetcher.mockResolvedValueOnce(json(projection())).mockResolvedValueOnce(json({ error: code }, 422)).mockResolvedValueOnce(json(await result())); await session.load(); await expect(session.change(draft, 0)).rejects.toMatchObject({ code }); expect(session.hasPending()).toBe(false); await session.change(draft, 0); expect(session.hasPending()).toBe(false); session.dispose();
  });
  for (const code of ['invalid_mailbox_request', 'mailbox_credentials_rejected']) it(`retains the command when retry ${code}422 cannot rule out a delayed first commit`, async () => {
    const { session, fetcher } = fixture({ timeoutMs: 10 }); let finish!: (response: Response) => void;
    const committed = await result(); fetcher.mockResolvedValueOnce(json(projection())).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(json({ error: code }, 422)).mockResolvedValueOnce(json(await result(command(), connected(), true)));
    await session.load(); await expect(session.change(draft, 0)).rejects.toMatchObject({ code: 'service_unavailable' });
    await expect(session.retry()).rejects.toMatchObject({ code }); expect(session.hasPending()).toBe(true);
    finish(json(committed)); expect(await session.retry()).toEqual(connected()); expect(session.hasPending()).toBe(false);
    expect(fetcher.mock.calls.slice(1).every(call => call[1]?.body === fetcher.mock.calls[1][1]?.body)).toBe(true); session.dispose();
  });
  for (const [code, status] of [['configuration_changed', 409], ['mailbox_verification_expired', 409], ['mailbox_revision_conflict', 409], ['mailbox_provider_unavailable', 503], ['mailbox_credentials_rejected', 503]] as const) it(`preserves the exact envelope after ${code}${status}`, async () => {
    const { session, fetcher } = fixture(); fetcher.mockResolvedValueOnce(json(projection())).mockResolvedValueOnce(json({ error: code }, status)).mockResolvedValueOnce(json(await result())); await session.load(); await expect(session.change(draft, 0)).rejects.toMatchObject({ code }); expect(session.hasPending()).toBe(true); await session.retry(); expect(fetcher.mock.calls[2][1]?.body).toBe(fetcher.mock.calls[1][1]?.body); session.dispose();
  });
  for (const status of [401, 402, 403]) it(`purges pending on ${status} before reading an untrusted body`, async () => {
    const { session, fetcher } = fixture(), cancel = vi.fn(); fetcher.mockResolvedValueOnce(json(projection())).mockRejectedValueOnce(Error('lost')).mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status }));
    await session.load(); await expect(session.change(draft, 0)).rejects.toMatchObject({ code: 'service_unavailable' }); await expect(session.load()).rejects.toMatchObject({ denied: true, status }); expect(cancel).toHaveBeenCalledOnce(); expect(session.hasPending()).toBe(false); await expect(session.retry()).rejects.toMatchObject({ code: 'session_changed' }); expect(fetcher).toHaveBeenCalledTimes(3);
  });
  for (const patch of [{ organizationId: connectionId }, { userId: connectionId }, { role: 'admin' as const }, { workspaceId: connectionId }]) it(`disposes on a fresh identity/workspace mismatch ${JSON.stringify(patch)}`, async () => {
    const { session, fetcher } = fixture(); fetcher.mockResolvedValueOnce(json(projection())).mockRejectedValueOnce(Error('lost')).mockResolvedValueOnce(json(projection(patch))); await session.load(); await expect(session.change(draft, 0)).rejects.toMatchObject({ code: 'service_unavailable' }); await expect(session.load()).rejects.toMatchObject({ code: 'session_changed', denied: true }); expect(session.hasPending()).toBe(false);
  });
  it('requires actual read readiness and the captured revision before writing', async () => {
    const { session, fetcher } = fixture(); await expect(session.change(draft, 0)).rejects.toMatchObject({ code: 'read_required' }); fetcher.mockResolvedValueOnce(json(connected())); await session.load(); await expect(session.change(draft, 0)).rejects.toMatchObject({ code: 'read_required' }); expect(fetcher).toHaveBeenCalledOnce(); session.dispose();
  });
  it('prevents members from managing or reading messages locally', async () => {
    const { session, fetcher } = fixture({ role: 'member' }); fetcher.mockResolvedValueOnce(json(connected({ role: 'member', canManage: false }))); await session.load(); await expect(session.change(draft, 1)).rejects.toMatchObject({ code: 'read_required' }); await expect(session.messages()).rejects.toMatchObject({ code: 'read_required' }); expect(fetcher).toHaveBeenCalledOnce(); session.dispose();
  });
  it('does not let a delayed metadata read replace a committed mutation', async () => {
    const { session, fetcher } = fixture(); let finish!: (value: Response) => void; fetcher.mockResolvedValueOnce(json(projection())).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(json(await result())); await session.load(); const old = session.load(); await session.change(draft, 0); finish(json(projection())); await expect(old).rejects.toMatchObject({ code: 'stale_read' }); await expect(session.change(draft, 0)).rejects.toMatchObject({ code: 'read_required' }); session.dispose();
  });
  it('reads only an explicitly requested bounded page and preserves provider offsets', async () => {
    const { session, fetcher } = fixture(); fetcher.mockResolvedValueOnce(json(connected())).mockResolvedValueOnce(json(page({ offset: 20, nextOffset: 40, messages: [] }))); await session.load(); expect(fetcher).toHaveBeenCalledOnce(); expect(await session.messages(20)).toMatchObject({ offset: 20, nextOffset: 40, messages: [] }); expect(fetcher.mock.calls[1][0]).toBe(`/api/international/workspaces/${org}/support-mailbox/messages?offset=20`); expect(fetcher.mock.calls.every(call => call[1]?.method === 'GET')).toBe(true); session.dispose();
  });
  for (const offset of [-20, 1, 201, 220, 1.5, NaN]) it(`rejects unsupported page offset ${offset} before fetching`, async () => {
    const { session, fetcher } = fixture(); fetcher.mockResolvedValueOnce(json(connected())); await session.load(); await expect(session.messages(offset)).rejects.toMatchObject({ code: 'invalid_mailbox_request' }); expect(fetcher).toHaveBeenCalledOnce(); session.dispose();
  });
  it('refuses messages delayed across a metadata connection replacement', async () => {
    const { session, fetcher } = fixture(); let finish!: (value: Response) => void; fetcher.mockResolvedValueOnce(json(connected())).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(json(connected({ revision: 2, connection: { ...connected().connection!, id: secondConnection } }))); await session.load(); const reading = session.messages(); await session.load(); finish(json(page())); await expect(reading).rejects.toMatchObject({ code: 'stale_messages' }); session.dispose();
  });
  for (const patch of [{ connectionId: secondConnection }, { revision: 2 }, { offset: 20, nextOffset: 40 }]) it(`rejects stale public message scope ${JSON.stringify(patch)}`, async () => {
    const { session, fetcher } = fixture(); fetcher.mockResolvedValueOnce(json(connected())).mockResolvedValueOnce(json(page(patch))); await session.load(); await expect(session.messages()).rejects.toMatchObject({ code: 'stale_messages' }); session.dispose();
  });
  for (const patch of [{ organizationId: secondConnection }, { userId: secondConnection }, { workspaceId: secondConnection }, { role: 'admin' as const }]) it(`purges mismatched message identity ${JSON.stringify(patch)}`, async () => {
    const { session, fetcher } = fixture(); fetcher.mockResolvedValueOnce(json(connected())).mockResolvedValueOnce(json(page(patch))); await session.load(); await expect(session.messages()).rejects.toMatchObject({ code: 'session_changed', denied: true }); await expect(session.load()).rejects.toMatchObject({ code: 'session_changed' });
  });
  it('retains pending on mismatched success receipt and permits only exact retry', async () => {
    const { session, fetcher } = fixture(), valid = await result(); fetcher.mockResolvedValueOnce(json(projection())).mockResolvedValueOnce(json({ ...valid, receipt: { ...valid.receipt, requestHash: '0'.repeat(64) } })).mockResolvedValueOnce(json(valid)); await session.load(); await expect(session.change(draft, 0)).rejects.toMatchObject({ code: 'invalid_response' }); expect(session.hasPending()).toBe(true); await session.retry(); expect(fetcher.mock.calls[2][1]?.body).toBe(fetcher.mock.calls[1][1]?.body); session.dispose();
  });
  it('bounds metadata, error and message bodies and cancels oversized streams', async () => {
    const { session, fetcher } = fixture(), cancel = vi.fn(); fetcher.mockResolvedValueOnce(new Response(' '.repeat(16_385), { headers: { 'Content-Type': 'application/json' } })).mockResolvedValueOnce(json({ error: 'private-token-should-not-leak' }, 503)).mockResolvedValueOnce(json(connected())).mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); }, cancel }), { headers: { 'Content-Type': 'application/json' } }));
    await expect(session.load()).rejects.toMatchObject({ code: 'invalid_response' }); await expect(session.load()).rejects.toMatchObject({ code: 'service_unavailable' }); await session.load(); await expect(session.messages()).rejects.toMatchObject({ code: 'invalid_response' }); expect(cancel).toHaveBeenCalledOnce(); session.dispose();
  });
  it('accepts legitimate metadata-heavy message pages above512KiB without silently dropping entries', async () => {
    const { session, fetcher } = fixture(), heavy = page({ messages: Array.from({ length: 100 }, (_, index) => ({ ...page().messages[0], uid: String(index), attachments: Array.from({ length: 20 }, (_, a) => ({ id: `id${a}${'x'.repeat(180)}`, name: `${'文'.repeat(170)}.pdf`, sizeBytes: 6 * 1024 * 1024 })) })) }); expect(new TextEncoder().encode(JSON.stringify(heavy)).length).toBeGreaterThan(512 * 1024); fetcher.mockResolvedValueOnce(json(connected())).mockResolvedValueOnce(json(heavy)); await session.load(); expect((await session.messages()).messages).toHaveLength(100); session.dispose();
  });
  it('times out a lost POST, keeps its command, and never retries automatically', async () => {
    const { session, fetcher } = fixture({ timeoutMs: 10 }); fetcher.mockResolvedValueOnce(json(projection())).mockImplementationOnce(() => new Promise(() => {})); await session.load(); await expect(session.change(draft, 0)).rejects.toMatchObject({ code: 'service_unavailable' }); expect(session.hasPending()).toBe(true); expect(fetcher).toHaveBeenCalledTimes(2); session.dispose(); expect(session.hasPending()).toBe(false);
  });
  it('cancels a delayed message body on disposal and never returns late mail', async () => {
    const { session, fetcher } = fixture(), cancel = vi.fn(); fetcher.mockResolvedValueOnce(json(connected())).mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { headers: { 'Content-Type': 'application/json' } })); await session.load(); const rejected = expect(session.messages()).rejects.toMatchObject({ code: 'session_changed', denied: true }); await Promise.resolve(); await Promise.resolve(); session.dispose(); await rejected; expect(cancel).toHaveBeenCalledOnce(); expect(session.hasPending()).toBe(false);
  });
});
