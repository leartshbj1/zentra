import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserErpError } from './browser-erp-session';
import { ERP_SCHEMA_HEADER } from './erp-schema-capability';
import { createBrowserUsWorkspaceSyncSession } from './browser-us-workspace-sync-session';
import type { UsWorkspaceSyncHeads } from './us-workspace-sync-heads';

const org = '11111111-1111-4111-8111-111111111111', user = '22222222-2222-4222-8222-222222222222';
const options = { organizationId: org, expectedUserId: user, role: 'owner' as const, supportedSchemaVersion: 4 as const };
const head = (): UsWorkspaceSyncHeads => ({ schemaVersion: 1, organizationId: org, role: 'owner', erp: { schemaVersion: 4, organizationId: org, revision: 2 }, channels: { supplierProposals: 'a'.repeat(64), bankReconciliations: 'b'.repeat(64), sellerProfile: null, taxProfile: null, team: null, supplierAnalysis: null } });
afterEach(() => { vi.useRealTimers(); });
function deferred() { let resolve!: (response: Response) => void; const promise = new Promise<Response>(done => { resolve = done; }); return { promise, resolve }; }

describe('browser compact US workspace sync heads', () => {
  it('uses one same-origin uncached GET with actor/schema fences, no mutation or grants', async () => {
    const fetcher = vi.fn(async () => Response.json(head())), session = createBrowserUsWorkspaceSyncSession({ ...options, fetch: fetcher });
    const result = await session.load(); expect(result).toEqual(head()); expect(Object.isFrozen(result.channels)).toBe(true);
    expect(fetcher.mock.calls[0]).toEqual([`/api/international/workspaces/${org}/sync-heads`, expect.objectContaining({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', headers: expect.objectContaining({ 'X-Zentra-Expected-User': user, [ERP_SCHEMA_HEADER]: '4' }) })]); session.dispose();
  });
  it.each([401, 402, 403])('rejects access denial %s before attempting a body read and closes the session', async status => {
    const response = new Response(new ReadableStream({ start() {} }), { status }), reader = vi.spyOn(response.body!, 'getReader');
    const session = createBrowserUsWorkspaceSyncSession({ ...options, fetch: async () => response });
    await expect(session.load()).rejects.toMatchObject({ status, outcome: 'unauthorized' }); expect(reader).not.toHaveBeenCalled(); await expect(session.load()).rejects.toMatchObject({ code: 'session_disposed', outcome: 'unauthorized' });
  });
  it('purges a late valid read after another read observes access loss', async () => {
    const old = deferred(); let n = 0; const session = createBrowserUsWorkspaceSyncSession({ ...options, fetch: async () => ++n === 1 ? old.promise : Response.json({ error: 'forbidden' }, { status: 403 }) });
    const pending = session.load(); await expect(session.load()).rejects.toMatchObject({ status: 403 }); old.resolve(Response.json(head())); await expect(pending).rejects.toMatchObject({ outcome: 'unauthorized' });
  });
  it('rejects a current role change and stops further reads', async () => {
    const session = createBrowserUsWorkspaceSyncSession({ ...options, fetch: async () => Response.json({ ...head(), role: 'admin' }) });
    await expect(session.load()).rejects.toMatchObject({ code: 'session_changed', outcome: 'unauthorized' }); await expect(session.load()).rejects.toMatchObject({ code: 'session_disposed' });
  });
  it.each([
    { ...head(), organizationId: 'other' },
    { ...head(), token: 'private-do-not-accept' },
    { ...head(), channels: { ...head().channels, supplierProposals: 'arbitrary' } },
    { ...head(), channels: { ...head().channels, other: 'a'.repeat(64) } },
    { ...head(), erp: { ...head().erp!, organizationId: 'other' } },
    { ...head(), role: 'admin', channels: { ...head().channels, taxProfile: 'a'.repeat(64) } },
  ])('refuses malformed or cross-scope heads', async value => {
    const session = createBrowserUsWorkspaceSyncSession({ ...options, fetch: async () => Response.json(value) }); await expect(session.load()).rejects.toMatchObject({ code: 'invalid_response' }); session.dispose();
  });
  it('bounds both declared and streamed response bytes', async () => {
    for (const response of [new Response('{}', { headers: { 'Content-Length': '4097' } }), new Response(' '.repeat(4097))]) {
      const session = createBrowserUsWorkspaceSyncSession({ ...options, fetch: async () => response }); await expect(session.load()).rejects.toMatchObject({ code: 'invalid_response' }); session.dispose();
    }
  });
  it('does not pass private server text through an error', async () => {
    const session = createBrowserUsWorkspaceSyncSession({ ...options, fetch: async () => Response.json({ error: 'private-secret@example.test' }, { status: 503 }) });
    await expect(session.load()).rejects.toMatchObject({ code: 'service_unavailable', message: 'service_unavailable' }); session.dispose();
  });
  it('preserves bounded retry-after for the scheduler', async () => {
    const session = createBrowserUsWorkspaceSyncSession({ ...options, fetch: async () => Response.json({ error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '120' } }) });
    await expect(session.load()).rejects.toMatchObject({ code: 'rate_limited', retryAfterMs: 120_000 }); session.dispose();
  });
  it('does not apply an older overlapping response', async () => {
    const old = deferred(); let n = 0; const session = createBrowserUsWorkspaceSyncSession({ ...options, fetch: async () => ++n === 1 ? old.promise : Response.json(head()) });
    const pending = session.load(); await expect(session.load()).resolves.toEqual(head()); old.resolve(Response.json(head())); await expect(pending).rejects.toMatchObject({ code: 'stale_read' }); session.dispose();
  });
  it('times out a stalled body, cancels its stream and clears the timer', async () => {
    vi.useFakeTimers(); const cancel = vi.fn(), session = createBrowserUsWorkspaceSyncSession({ ...options, fetch: async () => new Response(new ReadableStream({ start() {}, cancel })) });
    const promise = session.load(); const rejected = expect(promise).rejects.toMatchObject({ code: 'response_timeout' }); await vi.advanceTimersByTimeAsync(8_000); await rejected;
    expect(cancel).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0); session.dispose();
  });
  it('contains raw network failures in the public BrowserErpError family', async () => {
    const session = createBrowserUsWorkspaceSyncSession({ ...options, fetch: async () => { throw new Error('private transport debug'); } });
    await expect(session.load()).rejects.toBeInstanceOf(BrowserErpError); await expect(session.load()).rejects.toMatchObject({ message: 'response_unavailable' }); session.dispose();
  });
});
