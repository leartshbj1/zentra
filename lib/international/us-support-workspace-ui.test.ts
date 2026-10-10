import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserUsSupportWorkspaceSession, UsSupportWorkspaceContent, UsSupportWorkspacePanel, usSupportWorkspaceCopy } from '../../components/account/us-support-workspace-panel';
import type { UsSupportWorkspaceProjection } from './us-support-workspace-contract';

const org = '11111111-1111-4111-8111-111111111111', user = '22222222-2222-4222-8222-222222222222', requestId = '33333333-3333-4333-8333-333333333333', workspaceId = '44444444-4444-4444-8444-444444444444';
const projection = (patch: Partial<UsSupportWorkspaceProjection> = {}): UsSupportWorkspaceProjection => ({ schemaVersion: 1, organizationId: org, userId: user, role: 'owner', canCreate: true, stage: 'registry_only', mailboxAvailable: false, classificationAvailable: false, workspace: null, ...patch });
const prepared = () => projection({ canCreate: false, workspace: { schemaVersion: 1, organizationId: org, workspaceId, ownerUserId: user, connectedBy: user, name: 'Customer service', revision: 1, createdAt: 1_791_600_000 } });
const result = () => ({ projection: prepared(), receipt: { schemaVersion: 1, organizationId: org, requestId, workspaceId, actorUserId: user, createdAt: 1_791_600_000 }, replayed: false });
const json = (value: unknown, status = 200) => Response.json(value, { status });
function fixture() { const fetcher = vi.fn<typeof fetch>(); return { fetcher, session: createBrowserUsSupportWorkspaceSession({ organizationId: org, expectedUserId: user, role: 'owner', fetch: fetcher, newId: () => requestId }) }; }
const noop = () => {};
function content(language: 'fr' | 'de' | 'it' | 'en', value: UsSupportWorkspaceProjection | null, patch: Partial<Parameters<typeof UsSupportWorkspaceContent>[0]> = {}) {
  return renderToStaticMarkup(createElement(UsSupportWorkspaceContent, { language, projection: value, name: '', busy: false, loading: false, pending: false, terminal: false, error: '', saved: false, onName: noop, onSubmit: noop, onRetry: noop, onRefresh: noop, ...patch }));
}

afterEach(() => vi.useRealTimers());
describe('US Support H1 preparation UI', () => {
  for (const language of ['fr', 'de', 'it', 'en'] as const) {
    it(`renders honest ${language} preparation without mailbox, legacy links or guessed company facts`, () => {
      const html = content(language, projection()), c = usSupportWorkspaceCopy[language];
      expect(html).toContain(c.title); expect(html).toContain(c.limitation); expect(html).toContain(c.prepare); expect(html).toContain(c.nameHelp);
      expect(html).toContain('name="supportWorkspaceName"'); expect(html).toContain('value=""'); expect(html).toContain('minLength="2"'); expect(html).toContain('maxLength="100"');
      expect(html).not.toContain('<a '); expect(html).not.toContain('type="email"'); expect(html).not.toContain('type="password"'); expect(html).not.toContain('/support/espace');
    });
    it(`renders registered ${language} state with the H2 limitation and no second creation`, () => {
      const html = content(language, prepared()), c = usSupportWorkspaceCopy[language];
      expect(html).toContain(c.prepared); expect(html).toContain('Customer service'); expect(html).toContain(c.limitation); expect(html).not.toContain('<form'); expect(html).not.toContain(workspaceId); expect(html).not.toContain(user);
    });
  }
  for (const role of ['accountant', 'member', 'read_only'] as const) it(`allows ${role} to read without a creation control`, () => {
    const html = content('en', projection({ role, canCreate: false })); expect(html).toContain(usSupportWorkspaceCopy.en.member); expect(html).not.toContain('<form');
  });
  it('keeps exact retry actionable while locking the creation fields', () => {
    const html = content('en', projection(), { pending: true, name: 'Customer service' }); expect(html).toContain(usSupportWorkspaceCopy.en.pending); expect(html).toContain(usSupportWorkspaceCopy.en.memory);
    expect(html).toMatch(/<input[^>]*disabled=""/); expect(html).toMatch(/<button type="button" class="account-button">Retry the same request<\/button>/);
  });
  it('escapes stored names and shows an accessible field error', () => {
    const value = prepared(); const html = content('en', { ...value, workspace: { ...value.workspace!, name: '<img src=x>' } }); expect(html).toContain('&lt;img src=x&gt;'); expect(html).not.toContain('<img ');
    const invalid = content('en', projection(), { error: 'invalid_support_request' }); expect(invalid).toContain('aria-invalid="true"'); expect(invalid).toContain('role="alert"'); expect(invalid).toContain(usSupportWorkspaceCopy.en.invalid);
  });
  it('renders initial loading and a gate/access loss without private state or creation', () => {
    const loading = renderToStaticMarkup(createElement(UsSupportWorkspacePanel, { organizationId: org, expectedUserId: user, role: 'owner', language: 'en' })); expect(loading).toContain(usSupportWorkspaceCopy.en.loading); expect(loading).not.toContain('<form');
    const denied = renderToStaticMarkup(createElement(UsSupportWorkspacePanel, { organizationId: org, expectedUserId: user, role: 'owner', language: 'en', admitted: false })); expect(denied).toContain(usSupportWorkspaceCopy.en.denied); expect(denied).not.toContain('<form');
  });
  it('integrates outside financial-ready and purchasing-role gates with synchronous access purge', () => {
    const source = readFileSync(new URL('../../components/account/us-erp-workbench.tsx', import.meta.url), 'utf8');
    expect(source).toContain('supportWorkspaceEnabled?: boolean'); expect(source).toContain('supportWorkspaceEnabled = false'); expect(source).toContain('supportInvalidation.current?.()');
    const panel = source.indexOf('{supportWorkspaceEnabled && <UsSupportWorkspacePanel'), financial = source.indexOf("{read?.status === 'ready' && <>", panel);
    expect(panel).toBeGreaterThan(0); expect(financial).toBeGreaterThan(panel); expect(source.slice(panel, source.indexOf('/>}', panel))).not.toContain('canPurchase');
  });
});

describe('US Support H1 tab-owned browser session', () => {
  it('uses scoped no-store browser requests and creates only after an explicit valid action', async () => {
    const { session, fetcher } = fixture(); fetcher.mockResolvedValueOnce(json(projection())).mockResolvedValueOnce(json(result()));
    await session.load(); expect(fetcher).toHaveBeenCalledTimes(1); expect(session.hasPending()).toBe(false);
    const readOptions = fetcher.mock.calls[0][1]!; expect(readOptions).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error' }); expect(readOptions.headers).toMatchObject({ 'X-Zentra-Expected-User': user });
    await session.create('  Customer service  '); expect(fetcher.mock.calls[1][0]).toBe(`/api/international/workspaces/${org}/support-workspace`);
    expect(fetcher.mock.calls[1][1]).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Zentra-Expected-User': user }, body: JSON.stringify({ schemaVersion: 1, requestId, name: 'Customer service' }) }); expect(session.hasPending()).toBe(false); session.dispose();
  });
  it('retains the exact request after a lost response, even if a GET finds the committed workspace', async () => {
    const { session, fetcher } = fixture(); fetcher.mockResolvedValueOnce(json(projection())).mockRejectedValueOnce(new Error('private provider detail')).mockResolvedValueOnce(json(prepared())).mockResolvedValueOnce(json({ ...result(), replayed: true }));
    await session.load(); await expect(session.create('Customer service')).rejects.toMatchObject({ code: 'service_unavailable' }); expect(session.hasPending()).toBe(true);
    await session.load(); expect(session.hasPending()).toBe(true); await expect(session.create('Another workspace')).rejects.toMatchObject({ code: 'pending_operation' });
    await session.retry(); expect(fetcher.mock.calls[3][1]?.body).toBe(fetcher.mock.calls[1][1]?.body); expect(session.hasPending()).toBe(false); session.dispose();
  });
  for (const status of [401, 402, 403]) it(`purges pending immediately on ${status} without waiting for an error body`, async () => {
    const { session, fetcher } = fixture(), cancel = vi.fn();
    fetcher.mockResolvedValueOnce(json(projection())).mockRejectedValueOnce(new Error('lost')).mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status }));
    await session.load(); await expect(session.create('Customer service')).rejects.toMatchObject({ code: 'service_unavailable' }); expect(session.hasPending()).toBe(true);
    await expect(session.retry()).rejects.toMatchObject({ status, denied: true }); expect(session.hasPending()).toBe(false); expect(cancel).toHaveBeenCalledOnce();
    await expect(session.retry()).rejects.toMatchObject({ code: 'session_changed', denied: true }); expect(fetcher).toHaveBeenCalledTimes(3);
  });
  for (const patch of [{ userId: workspaceId }, { role: 'admin' as const }, { organizationId: workspaceId }]) it(`rejects a response outside captured scope ${JSON.stringify(patch)}`, async () => {
    const { session, fetcher } = fixture(); fetcher.mockResolvedValueOnce(json(projection(patch))); await expect(session.load()).rejects.toMatchObject({ code: patch.organizationId ? 'invalid_response' : 'session_changed' }); session.dispose();
  });
  for (const patch of [{ mailboxAvailable: true }, { classificationAvailable: true }, { stage: 'active' }, { canCreate: false }]) it(`refuses invented H2 capability or inconsistent creation readiness ${JSON.stringify(patch)}`, async () => {
    const { session, fetcher } = fixture(); fetcher.mockResolvedValueOnce(json({ ...projection(), ...patch })); await expect(session.load()).rejects.toMatchObject({ code: 'invalid_response' }); session.dispose();
  });
  it('does not let a delayed GET replace a committed mutation', async () => {
    const { session, fetcher } = fixture(); let complete!: (response: Response) => void;
    fetcher.mockResolvedValueOnce(json(projection())).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; })).mockResolvedValueOnce(json(result()));
    await session.load(); const stale = session.load(); await session.create('Customer service'); complete(json(projection())); await expect(stale).rejects.toMatchObject({ code: 'stale_read' });
    await expect(session.create('Another workspace')).rejects.toMatchObject({ code: 'read_required' }); expect(session.hasPending()).toBe(false); session.dispose();
  });
  it('requires read readiness and a valid explicit name without sending a mutation', async () => {
    const { session, fetcher } = fixture(); await expect(session.create('Customer service')).rejects.toMatchObject({ code: 'read_required' }); fetcher.mockResolvedValueOnce(json(projection())); await session.load();
    for (const name of ['', 'x', 'x'.repeat(101), 'Bad\u0000name']) await expect(session.create(name)).rejects.toMatchObject({ code: 'invalid_support_request' });
    expect(fetcher).toHaveBeenCalledTimes(1); expect(session.hasPending()).toBe(false); session.dispose();
  });
  it('keeps malformed success and transient configuration conflicts pending for exact retry', async () => {
    const { session, fetcher } = fixture(); fetcher.mockResolvedValueOnce(json(projection())).mockResolvedValueOnce(json({ ...result(), receipt: { ...result().receipt, requestId: workspaceId } })).mockResolvedValueOnce(json({ error: 'configuration_changed' }, 409)).mockResolvedValueOnce(json(result()));
    await session.load(); await expect(session.create('Customer service')).rejects.toMatchObject({ code: 'invalid_response' }); expect(session.hasPending()).toBe(true);
    await expect(session.retry()).rejects.toMatchObject({ code: 'configuration_changed' }); expect(session.hasPending()).toBe(true); await session.retry();
    expect(fetcher.mock.calls.slice(1).every(call => call[1]?.body === fetcher.mock.calls[1][1]?.body)).toBe(true); session.dispose();
  });
  it('bounds streamed responses and never exposes arbitrary error details', async () => {
    const { session, fetcher } = fixture(); fetcher.mockResolvedValueOnce(new Response(' '.repeat(16_385), { headers: { 'Content-Type': 'application/json' } })).mockResolvedValueOnce(json({ error: 'secret-provider-account' }, 503));
    await expect(session.load()).rejects.toMatchObject({ code: 'invalid_response' }); await expect(session.load()).rejects.toMatchObject({ code: 'service_unavailable' }); session.dispose();
  });
  it('bounds a lost mutation and preserves its request until explicit disposal', async () => {
    vi.useFakeTimers(); const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(projection())).mockImplementationOnce(() => new Promise(() => {}));
    const session = createBrowserUsSupportWorkspaceSession({ organizationId: org, expectedUserId: user, role: 'owner', fetch: fetcher, newId: () => requestId, timeoutMs: 10 }); await session.load();
    const rejected = expect(session.create('Customer service')).rejects.toMatchObject({ code: 'service_unavailable' }); await vi.advanceTimersByTimeAsync(11); await rejected;
    expect(session.hasPending()).toBe(true); session.dispose(); expect(session.hasPending()).toBe(false); await expect(session.retry()).rejects.toMatchObject({ code: 'session_changed' });
  });
  it('disposes promptly during a delayed body and refuses its late result', async () => {
    const { session, fetcher } = fixture(); let finish!: () => void, cancelled = false; const cancel = vi.fn(() => { cancelled = true; });
    fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { finish = () => { if (!cancelled) { controller.enqueue(new TextEncoder().encode(JSON.stringify(projection()))); controller.close(); } }; }, cancel }), { headers: { 'Content-Type': 'application/json' } }));
    const rejected = expect(session.load()).rejects.toMatchObject({ code: 'session_changed', denied: true }); await Promise.resolve(); await Promise.resolve(); session.dispose(); await rejected; finish(); expect(cancel).toHaveBeenCalledOnce(); expect(session.hasPending()).toBe(false);
  });
});
