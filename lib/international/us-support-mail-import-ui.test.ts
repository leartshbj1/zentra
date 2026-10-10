import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createBrowserUsMailImportSession, type BrowserUsMailImportDraft } from './browser-us-support-mail-import-session';
import { hashUsMailboxImportRequest, type UsMailboxImportRequest } from './us-support-mailbox-import-contract';
import type { UsSupplierDocument } from './us-supplier-document-contract';
import { UsSupportMailImportContent, canImportUsMailAttachment, usSupportMailImportCopy, type UsSupportMailImportChoice } from '../../components/account/us-support-mail-import';
import { UsSupportMailboxContent } from '../../components/account/us-support-mailbox-panel';

const org = '11111111-1111-4111-8111-111111111111', user = '22222222-2222-4222-8222-222222222222', requestId = '33333333-3333-4333-8333-333333333333', workspaceId = '44444444-4444-4444-8444-444444444444', connectionId = '55555555-5555-4555-8555-555555555555', documentId = '66666666-6666-4666-8666-666666666666';
const draft: BrowserUsMailImportDraft = { connectionId, expectedMailboxRevision: 1, uid: '123', attachmentId: 'part-1', expectedMessageVersion: 'observed-2026-10-10' };
const input: UsMailboxImportRequest = { ...draft, schemaVersion: 1, requestId };
const original = (patch: Partial<UsSupplierDocument> = {}): UsSupplierDocument => ({ schemaVersion: 1, organizationId: org, id: documentId, contentSha256: 'a'.repeat(64), sizeBytes: 4096, mediaType: 'application/pdf', fileName: 'canonical invoice.pdf', createdBy: user, createdAt: '2026-10-10T12:00:00.000Z', stored: true, readable: true, proposalId: null, ...patch });
const choice: UsSupportMailImportChoice = { connectionId, expectedMailboxRevision: 1, message: { uid: draft.uid, version: draft.expectedMessageVersion, subject: '<script>Supplier invoice</script>', sender: 'Accounts <accounts@example.test>', receivedAt: 1791600000, attachments: [{ id: draft.attachmentId, name: 'invoice.pdf', sizeBytes: 4096 }] }, attachment: { id: draft.attachmentId, name: 'invoice.pdf', sizeBytes: 4096 } };
async function result(patch: Record<string, unknown> = {}, command = input) { return { schemaVersion: 1, organizationId: org, userId: user, role: 'owner', workspaceId, requestId: command.requestId, requestHash: await hashUsMailboxImportRequest(org, user, command), document: original(), replayed: false, ...patch }; }
const json = (value: unknown, status = 200) => Response.json(value, { status });
function fixture(patch: Partial<Parameters<typeof createBrowserUsMailImportSession>[0]> = {}) { const fetcher = vi.fn<typeof fetch>(); return { fetcher, session: createBrowserUsMailImportSession({ organizationId: org, expectedUserId: user, role: 'owner', workspaceId, fetch: fetcher, newId: () => requestId, ...patch }) }; }
const noop = () => {};
function content(language: 'fr' | 'de' | 'it' | 'en', patch: Partial<Parameters<typeof UsSupportMailImportContent>[0]> = {}) { return renderToStaticMarkup(createElement(UsSupportMailImportContent, { language, choice, document: null, replayed: false, busy: false, pending: false, blocked: false, error: '', onConfirm: noop, onCancel: noop, onRetry: noop, ...patch })); }

describe('US Support H2b explicit import browser session', () => {
  it('sends one explicit secret-free scoped schema4 command and validates its receipt hash', async () => {
    const { session, fetcher } = fixture(); expect(fetcher).not.toHaveBeenCalled(); fetcher.mockResolvedValueOnce(json(await result())); expect(await session.import(draft)).toEqual({ document: original(), replayed: false });
    expect(fetcher.mock.calls[0][0]).toBe(`/api/international/workspaces/${org}/support-mailbox/import`); expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'Content-Type': 'application/json', 'X-Zentra-Expected-User': user, 'X-Zentra-Erp-Schema-Version': '4' } });
    const body = fetcher.mock.calls[0][1]?.body; if (typeof body !== 'string') throw Error('Expected JSON'); expect(JSON.parse(body)).toEqual(input); expect(body).not.toContain('token'); expect(body).not.toContain('invoice.pdf'); expect(session.hasPending()).toBe(false); session.dispose();
  });
  it('retains exact identity, connection/version and request ID after lost ACK; retry needs no current mailbox/key', async () => {
    const { session, fetcher } = fixture(); fetcher.mockRejectedValueOnce(Error('private-provider-detail')).mockResolvedValueOnce(json(await result({ replayed: true }))); await expect(session.import(draft)).rejects.toMatchObject({ code: 'service_unavailable' }); expect(session.hasPending()).toBe(true);
    await expect(session.import({ ...draft, connectionId: documentId, expectedMailboxRevision: 3 })).rejects.toMatchObject({ code: 'pending_operation' }); expect(await session.retry()).toEqual({ document: original(), replayed: true }); expect(fetcher.mock.calls[1][1]?.body).toBe(fetcher.mock.calls[0][1]?.body); expect(session.hasPending()).toBe(false); session.dispose();
  });
  for (const code of ['mailbox_attachment_unavailable', 'mailbox_credentials_rejected', 'invalid_mailbox_import_request']) it(`releases an authoritative first ${code}422 before any claim`, async () => {
    const { session, fetcher } = fixture(); fetcher.mockResolvedValueOnce(json({ error: code }, 422)).mockResolvedValueOnce(json(await result())); await expect(session.import(draft)).rejects.toMatchObject({ code }); expect(session.hasPending()).toBe(false); await session.import(draft); session.dispose();
  });
  for (const code of ['mailbox_attachment_unavailable', 'invalid_mailbox_import_request']) it(`retains pending after a timed-out first call followed by retry ${code}422`, async () => {
    const { session, fetcher } = fixture({ timeoutMs: 10 }); let finish!: (response: Response) => void; const committed = await result({ replayed: true }); fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(json({ error: code }, 422)).mockResolvedValueOnce(json(committed));
    await expect(session.import(draft)).rejects.toMatchObject({ code: 'service_unavailable' }); await expect(session.retry()).rejects.toMatchObject({ code }); expect(session.hasPending()).toBe(true); finish(json(committed)); await session.retry(); expect(fetcher.mock.calls.every(call => call[1]?.body === fetcher.mock.calls[0][1]?.body)).toBe(true); expect(session.hasPending()).toBe(false); session.dispose();
  });
  for (const code of ['mailbox_import_connection_changed', 'mailbox_revision_conflict', 'mailbox_source_conflict', 'configuration_changed', 'supplier_upgrade_required']) it(`preserves exact request on ${code}409`, async () => {
    const { session, fetcher } = fixture(); fetcher.mockResolvedValueOnce(json({ error: code }, 409)).mockResolvedValueOnce(json(await result({ replayed: true }))); await expect(session.import(draft)).rejects.toMatchObject({ code }); expect(session.hasPending()).toBe(true); await session.retry(); expect(fetcher.mock.calls[1][1]?.body).toBe(fetcher.mock.calls[0][1]?.body); session.dispose();
  });
  for (const status of [401, 402, 403]) it(`purges pending on ${status} before waiting for the body`, async () => {
    const { session, fetcher } = fixture(), cancel = vi.fn(); fetcher.mockRejectedValueOnce(Error('lost')).mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status })); await expect(session.import(draft)).rejects.toMatchObject({ code: 'service_unavailable' }); await expect(session.retry()).rejects.toMatchObject({ code: 'access_lost', status, denied: true }); expect(session.hasPending()).toBe(false); expect(cancel).toHaveBeenCalledOnce(); await expect(session.retry()).rejects.toMatchObject({ code: 'session_changed' }); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('purges on a closed import gate without requiring a refreshed mailbox', async () => {
    const { session, fetcher } = fixture(); fetcher.mockResolvedValueOnce(json({ error: 'feature_unavailable' }, 404)); await expect(session.import(draft)).rejects.toMatchObject({ denied: true }); expect(session.hasPending()).toBe(false); await expect(session.retry()).rejects.toMatchObject({ code: 'session_changed' });
  });
  for (const patch of [{ organizationId: documentId }, { userId: documentId }, { role: 'admin' }, { workspaceId: documentId }]) it(`purges a receipt outside captured scope ${JSON.stringify(patch)}`, async () => {
    const { session, fetcher } = fixture(); fetcher.mockResolvedValueOnce(json(await result(patch))); await expect(session.import(draft)).rejects.toMatchObject({ code: 'session_changed', denied: true }); expect(session.hasPending()).toBe(false);
  });
  for (const patch of [{ requestId: documentId }, { requestHash: 'b'.repeat(64) }, { schemaVersion: 2 }, { replayed: 'yes' }, { providerKey: 'private' }]) it(`preserves pending on malformed or mismatched receipt ${JSON.stringify(patch)}`, async () => {
    const { session, fetcher } = fixture(); fetcher.mockResolvedValueOnce(json(await result(patch))).mockResolvedValueOnce(json(await result({ replayed: true }))); await expect(session.import(draft)).rejects.toMatchObject({ code: 'invalid_response' }); expect(session.hasPending()).toBe(true); await session.retry(); session.dispose();
  });
  it('accepts the canonical existing original without inventing a filename/creator or new proposal', async () => {
    const { session, fetcher } = fixture(), existing = original({ createdBy: documentId, fileName: 'first-upload.pdf' }); fetcher.mockResolvedValueOnce(json(await result({ document: existing, replayed: true }))); expect((await session.import(draft)).document).toEqual(existing); expect(fetcher).toHaveBeenCalledOnce(); session.dispose();
  });
  for (const document of [original({ stored: false }), original({ mediaType: 'text/plain' }), { ...original(), documentText: 'private' }]) it('rejects an unconfirmed, unsupported or private document DTO without acknowledging pending', async () => {
    const { session, fetcher } = fixture(); fetcher.mockResolvedValueOnce(json(await result({ document }))); await expect(session.import(draft)).rejects.toMatchObject({ code: 'invalid_response' }); expect(session.hasPending()).toBe(true); session.dispose();
  });
  for (const role of ['accountant', 'member', 'read_only'] as const) it(`refuses ${role} without making a request`, () => { const fetcher = vi.fn<typeof fetch>(); expect(() => fixture({ role, fetch: fetcher })).toThrow(); expect(fetcher).not.toHaveBeenCalled(); });
  it('does not send malformed locators or silently introduce a second command', async () => {
    const { session, fetcher } = fixture(); for (const patch of [{ uid: '../123' }, { expectedMailboxRevision: 0 }, { connectionId: 'foreign' }, { attachmentId: 'bad/part' }, { expectedMessageVersion: '' }]) await expect(session.import({ ...draft, ...patch })).rejects.toMatchObject({ code: 'invalid_mailbox_import_request' }); expect(fetcher).not.toHaveBeenCalled(); expect(session.hasPending()).toBe(false); session.dispose();
  });
  it('bounds responses and never exposes arbitrary provider errors', async () => {
    const { session, fetcher } = fixture(); fetcher.mockResolvedValueOnce(new Response(' '.repeat(16_385), { headers: { 'Content-Type': 'application/json' } })).mockResolvedValueOnce(json({ error: 'private-secret-upstream' }, 503)); await expect(session.import(draft)).rejects.toMatchObject({ code: 'invalid_response' }); await expect(session.retry()).rejects.toMatchObject({ code: 'service_unavailable' }); expect(session.hasPending()).toBe(true); session.dispose();
  });
  it('disposes during a delayed body, cancels its stream and never returns a late receipt', async () => {
    const { session, fetcher } = fixture(), cancel = vi.fn(); fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { headers: { 'Content-Type': 'application/json' } })); const pending = session.import(draft); const rejected = expect(pending).rejects.toMatchObject({ code: 'session_changed', denied: true }); await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce()); session.dispose(); await rejected; expect(session.hasPending()).toBe(false); expect(cancel).toHaveBeenCalledOnce();
  });
});

describe('US Support H2b confirmation and recovery interface', () => {
  for (const language of ['fr', 'de', 'it', 'en'] as const) {
    it(`renders ${language} storage-only confirmation with readable source and no secret/IDs`, () => {
      const html = content(language), c = usSupportMailImportCopy[language]; for (const key of ['title', 'help', 'confirm', 'back', 'file', 'from'] as const) expect(html).toContain(c[key]); expect(html).toContain('invoice.pdf'); expect(html).toContain('&lt;script&gt;Supplier invoice&lt;/script&gt;'); expect(html).not.toContain('<script>'); expect(html).not.toContain(connectionId); expect(html).not.toContain(workspaceId); expect(html).not.toContain('type="password"'); expect(html).toContain('tabindex="-1"');
    });
    it(`keeps ${language} exact retry available after the mailbox disappeared`, () => {
      const html = content(language, { choice: null, pending: true }), c = usSupportMailImportCopy[language]; expect(html).toContain(c.pending); expect(html).toContain(c.memory); expect(html).toContain(c.retry); expect(html).not.toContain('disabled=""'); expect(html).not.toContain(c.confirm);
    });
    it(`renders ${language} canonical success with standalone navigation and no analysis control`, () => {
      const html = content(language, { choice: null, document: original(), replayed: true, documentsHref: '/compte/espaces/us/company?reglage=gestion#us-supplier-originals' }), c = usSupportMailImportCopy[language]; expect(html).toContain(c.duplicate); expect(html).toContain('canonical invoice.pdf'); expect(html).toContain(c.open); expect(html).toContain('href="/compte/espaces/us/company?reglage=gestion#us-supplier-originals"'); expect(html).not.toContain(c.confirm); expect(html).not.toContain('type="checkbox"');
    });
  }
  it('locks retry for another operation but not its own pending state', () => { expect(content('en', { choice: null, pending: true, blocked: true })).toMatch(/<button type="button" class="account-button" disabled="">Retry the same import<\/button>/); });
  it('uses client navigation when supplied, without introducing a second standalone link', () => { const html = content('en', { choice: null, document: original(), onOpenDocuments: noop, documentsHref: '/elsewhere' }); expect(html).toContain('<button type="button" class="account-button secondary">View supplier originals</button>'); expect(html).not.toContain('<a '); });
  for (const [name, sizeBytes, allowed] of [['invoice.pdf', 1, true], ['original.PNG', 6 * 1024 * 1024, true], ['scan.jpeg', 42, true], ['invite.ics', 42, false], ['empty.pdf', 0, false], ['big.pdf', 6 * 1024 * 1024 + 1, false]] as const) it(`offers import eligibility for ${name}/${sizeBytes}: ${allowed}`, () => { expect(canImportUsMailAttachment({ id: 'part', name, sizeBytes })).toBe(allowed); });
  it('changes H2a attachment controls only behind the import gate and excludes unsupported calendar files', () => {
    const props = { language: 'en' as const, projection: { schemaVersion: 1 as const, organizationId: org, userId: user, role: 'owner' as const, workspaceId, revision: 1, canManage: true, connection: { id: connectionId, provider: 'infomaniak' as const, email: 'info@example.test', verifiedAt: 1791600000 } }, messages: { schemaVersion: 1 as const, organizationId: org, userId: user, role: 'owner' as const, workspaceId, connectionId, revision: 1, offset: 0, nextOffset: null, messages: [{ ...choice.message, attachments: [choice.attachment, { id: 'calendar', name: 'invite.ics', sizeBytes: 42 }] }] }, email: '', token: '', review: null, busy: false, loading: false, reading: false, pending: false, terminal: false, error: '', saved: false, onEmail: noop, onToken: noop, onReview: noop, onDisconnect: noop, onBack: noop, onConfirm: noop, onRetry: noop, onRefresh: noop, onRead: noop };
    const closed = renderToStaticMarkup(createElement(UsSupportMailboxContent, props)), open = renderToStaticMarkup(createElement(UsSupportMailboxContent, { ...props, importEnabled: true })); expect(closed).not.toContain(usSupportMailImportCopy.en.choose); expect(open.match(/>Save original<\/button>/g)).toHaveLength(1); expect(open).toContain(usSupportMailImportCopy.en.unsupported); expect(open).toContain(usSupportMailImportCopy.en.limitation);
  });
  it('keeps the import session independent of mailbox revision and invokes commit callbacks after release', () => {
    const source = readFileSync(new URL('../../components/account/us-support-mail-import.tsx', import.meta.url), 'utf8'), parent = readFileSync(new URL('../../components/account/us-support-mailbox-panel.tsx', import.meta.url), 'utf8'); expect(source).toContain('[identity, usable]'); expect(source).not.toContain('localStorage'); expect(source).not.toContain('sessionStorage'); expect(source).toContain('callbacks?.onBusy(false); if (committed) refs.current.onImported?.()'); expect(parent).toContain('importInvalidation.current?.()'); expect(parent).toContain('registerInvalidation={registerImportInvalidation}'); expect(parent).toContain('importContent={owned && !terminal && importEnabled && read?.canManage');
  });
});
