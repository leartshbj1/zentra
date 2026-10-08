import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserSellerError, createBrowserSellerSession } from './browser-seller-session';
import type { UsSellerProfile, UsSellerProfileReceipt, UsSellerProfileState } from './seller-profile';

const organizationId = 'fictitious-us-seller', expectedUserId = 'fictitious-owner';
const requestId = '10000000-0000-4000-8000-000000000001';
const profile: UsSellerProfile = { displayName: 'Fictitious business', contactEmail: 'owner@example.test', contactPhone: '+1 212 555 0100' };
const empty: UsSellerProfileState = { status: 'unconfigured', organizationId, revision: 0 };
const state = (revision = 1, identity = profile): UsSellerProfileState => ({ status: 'configured', organizationId, revision, profile: identity, updatedBy: expectedUserId, updatedAt: '2026-10-08T12:34:56.123456+00:00' });
const receipt = (revision = 1, identity = profile): UsSellerProfileReceipt => ({ ...state(revision, identity) as UsSellerProfileReceipt, requestId, replayed: false });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const fetcher = vi.fn<typeof fetch>(), newId = vi.fn(() => requestId);
  const session = createBrowserSellerSession({ organizationId, expectedUserId, fetch: fetcher, newId });
  const load = async (value: UsSellerProfileState = empty) => { fetcher.mockResolvedValueOnce(json(value)); return session.load(); };
  return { fetcher, newId, session, load };
}
afterEach(() => vi.useRealTimers());

describe('cookie-only US seller browser transport', () => {
  it.each(['', '../other', 'https://other.example', ' bad', 'a'.repeat(129)])('refuses malformed workspace %s before a request', organizationId => {
    expect(() => createBrowserSellerSession({ organizationId, expectedUserId })).toThrow(BrowserSellerError);
  });
  it.each(['', ' other', 'other ', 'user\n', 'a'.repeat(257)])('requires a precise expected Auth user %s', expectedUserId => {
    expect(() => createBrowserSellerSession({ organizationId, expectedUserId })).toThrow(BrowserSellerError);
  });
  it('reads an explicitly empty profile with cookies, no cache, no bearer or role grant', async () => {
    const f = fixture(); expect(await f.load()).toEqual(empty);
    const [url, init] = f.fetcher.mock.calls[0];
    expect(url).toBe(`/api/international/workspaces/${organizationId}/seller`);
    expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', headers: { Accept: 'application/json', 'X-Zentra-Expected-User': expectedUserId } });
    expect(init?.body).toBeUndefined(); expect(new Headers(init?.headers).has('Authorization')).toBe(false);
    expect(f.newId).not.toHaveBeenCalled(); expect(f.session.hasPending()).toBe(false);
  });
  it('requires a fresh read before the first write and owns a frozen canonical state', async () => {
    const f = fixture(); await expect(f.session.submit(profile, 0)).rejects.toMatchObject({ code: 'read_required', outcome: 'rejected' });
    const input = state(); const output = await f.load(input);
    expect(Object.isFrozen(output)).toBe(true);
    if (output.status !== 'configured') throw new Error('Fixture invalid');
    expect(Object.isFrozen(output.profile)).toBe(true); expect(output.updatedAt).toBe('2026-10-08T12:34:56.123456+00:00');
    expect(output).not.toBe(input); expect(output.profile).not.toBe(profile);
  });
  it.each([
    { ...empty, organizationId: 'other' }, { ...empty, revision: 1 }, { ...empty, profile }, { ...state(), organizationId: 'other' },
    { ...state(), profile: { ...profile, ein: '12-3456789' } }, { ...state(), role: 'owner' }, { ...state(), updatedAt: '2026-02-30T00:00:00Z' },
    { ...state(), profile: { ...profile, displayName: ' Business ' } }, { ...state(), updatedAt: '2026-10-08' },
  ])('rejects malformed, foreign or privileged GET projection %j', async input => {
    const f = fixture(); f.fetcher.mockResolvedValue(json(input));
    await expect(f.session.load()).rejects.toMatchObject({ code: 'invalid_response', outcome: 'rejected' });
    await expect(f.session.submit(profile, 0)).rejects.toMatchObject({ code: 'read_required' });
  });
  it('does not invoke a getter when validating a projection', async () => {
    const f = fixture(), getter = vi.fn(() => 'configured');
    const input = { organizationId, revision: 1, profile, updatedBy: expectedUserId, updatedAt: '2026-10-08T12:00:00Z' };
    Object.defineProperty(input, 'status', { enumerable: true, get: getter });
    f.fetcher.mockResolvedValue({ ok: true, status: 200, json: async () => input } as Response);
    await expect(f.session.load()).rejects.toMatchObject({ code: 'invalid_response' }); expect(getter).not.toHaveBeenCalled();
  });
  it('uses a distinct seller revision and sends only three profile fields plus CAS/key', async () => {
    const f = fixture(); await f.load(); f.fetcher.mockResolvedValueOnce(json(receipt()));
    expect(await f.session.submit(profile, 0)).toEqual(receipt());
    const [, init] = f.fetcher.mock.calls[1]; expect(init?.method).toBe('PUT');
    expect(JSON.parse(init?.body as string)).toEqual({ expectedRevision: 0, requestId, profile });
    expect(init?.body).not.toMatch(/authority|role|organizationId|subscription|taxConfiguration|ein/);
    expect(f.session.hasPending()).toBe(false);
    await expect(f.session.submit(profile, 1)).rejects.toMatchObject({ code: 'read_required' });
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([{ displayName: '' }, { ...profile, contactEmail: 'bad' }, { ...profile, role: 'owner' }, { ...profile, displayName: 'a'.repeat(257) }])('rejects invalid public input before allocating a key %j', async input => {
    const f = fixture(); await f.load(); await expect(f.session.submit(input, 0)).rejects.toMatchObject({ code: 'invalid_request', outcome: 'rejected' });
    expect(f.newId).not.toHaveBeenCalled(); expect(f.fetcher).toHaveBeenCalledTimes(1); expect(f.session.hasPending()).toBe(false);
  });
  it.each([-1, Number.MAX_SAFE_INTEGER, 0.5, NaN])('rejects unsafe revision %s locally', async revision => {
    const f = fixture(); await f.load(); await expect(f.session.submit(profile, revision)).rejects.toMatchObject({ code: 'invalid_request' }); expect(f.newId).not.toHaveBeenCalled();
  });
  it('canonicalizes whitespace and key casing once without retaining editable form references', async () => {
    const f = fixture(); f.newId.mockReturnValue('10000000-0000-4000-8ABC-000000000001'); await f.load();
    f.fetcher.mockResolvedValueOnce(json({ ...receipt(), requestId: '10000000-0000-4000-8abc-000000000001' }));
    await f.session.submit({ ...profile, displayName: ' Fictitious business ' }, 0);
    expect(JSON.parse(f.fetcher.mock.calls[1][1]?.body as string)).toMatchObject({ requestId: '10000000-0000-4000-8abc-000000000001', profile });
  });
  it('recovers an uncertain result with the byte-identical PUT and key even after the original draft changes', async () => {
    const f = fixture(); await f.load(); const draft = { ...profile };
    f.fetcher.mockResolvedValueOnce(json({ error: 'service_unavailable' }, 503));
    await expect(f.session.submit(draft, 0)).rejects.toMatchObject({ code: 'service_unavailable', outcome: 'uncertain' });
    draft.displayName = 'Changed form'; expect(f.session.hasPending()).toBe(true);
    await expect(f.session.submit(draft, 0)).rejects.toMatchObject({ code: 'pending_operation' });
    f.fetcher.mockResolvedValueOnce(json({ ...receipt(), replayed: true }));
    const recovered = await f.session.retry(); expect(recovered.replayed).toBe(true);
    expect(f.fetcher.mock.calls[2][1]?.body).toBe(f.fetcher.mock.calls[1][1]?.body); expect(f.newId).toHaveBeenCalledOnce();
    await expect(f.session.submit(profile, 1)).rejects.toMatchObject({ code: 'read_required' });
    const latest = state(2, { displayName: 'A newer profile' }); expect(await f.load(latest)).toEqual(latest);
  });
  it.each(['revision_conflict', 'request_id_conflict'])('treats only verified %s as a rejected write requiring read and explicit new submission', async code => {
    const f = fixture(); await f.load(); f.fetcher.mockResolvedValueOnce(json({ error: code }, 409));
    await expect(f.session.submit(profile, 0)).rejects.toMatchObject({ code, status: 409, outcome: 'rejected' });
    expect(f.session.hasPending()).toBe(false); await expect(f.session.retry()).rejects.toMatchObject({ code: 'no_pending_operation' });
    await expect(f.session.submit(profile, 1)).rejects.toMatchObject({ code: 'read_required' });
    await f.load(state()); f.newId.mockReturnValueOnce('10000000-0000-4000-8000-000000000002');
    f.fetcher.mockResolvedValueOnce(json({ ...receipt(2), requestId: '10000000-0000-4000-8000-000000000002' }));
    await f.session.submit(profile, 1); expect(f.newId).toHaveBeenCalledTimes(2);
  });
  it.each([[409, 'configuration_changed'], [409, 'workspace_unavailable'], [422, 'invalid_request'], [404, 'feature_unavailable'], [429, 'service_unavailable'], [503, 'service_unavailable']] as const)('retains exact recovery after potentially postcommit %s/%s', async (status, error) => {
    const f = fixture(); await f.load(); f.fetcher.mockResolvedValueOnce(json({ error }, status));
    await expect(f.session.submit(profile, 0)).rejects.toMatchObject({ outcome: 'uncertain' }); expect(f.session.hasPending()).toBe(true);
  });
  it.each([401, 402, 403])('retains a pending write but hides unauthorized response status %s', async status => {
    const f = fixture(); await f.load(); f.fetcher.mockResolvedValueOnce(new Response('not-json private text', { status }));
    await expect(f.session.submit(profile, 0)).rejects.toMatchObject({ status, outcome: 'unauthorized' });
    expect(f.session.hasPending()).toBe(true); f.fetcher.mockResolvedValueOnce(json({ ...receipt(), replayed: true }));
    expect((await f.session.retry()).replayed).toBe(true); expect(f.fetcher.mock.calls[1][1]?.body).toBe(f.fetcher.mock.calls[2][1]?.body);
  });
  it('does not expose arbitrary provider errors or extra error fields', async () => {
    const f = fixture(); await f.load(); f.fetcher.mockResolvedValueOnce(json({ error: 'SECRET from a provider', address: 'private' }, 500));
    await expect(f.session.submit(profile, 0)).rejects.toMatchObject({ code: 'service_unavailable', outcome: 'uncertain' });
  });
  it.each([
    { ...receipt(), organizationId: 'foreign' }, { ...receipt(), updatedBy: 'another-user' }, { ...receipt(), requestId: '20000000-0000-4000-8000-000000000001' },
    { ...receipt(), revision: 2 }, { ...receipt(), profile: { displayName: 'Wrong identity' } }, { ...receipt(), replayed: 'false' }, { ...receipt(), subscriptionActive: true },
  ])('retains recovery for an invalid or unbound receipt %j', async input => {
    const f = fixture(); await f.load(); f.fetcher.mockResolvedValueOnce(json(input));
    await expect(f.session.submit(profile, 0)).rejects.toMatchObject({ code: 'invalid_response', outcome: 'uncertain' }); expect(f.session.hasPending()).toBe(true);
  });
  it('refuses concurrent writes and returns no stale GET from before a write', async () => {
    const f = fixture(); await f.load(); const get = deferred<Response>(), put = deferred<Response>();
    f.fetcher.mockReturnValueOnce(get.promise); const reading = f.session.load().catch(error => error);
    f.fetcher.mockReturnValueOnce(put.promise); const writing = f.session.submit(profile, 0);
    await expect(f.session.retry()).rejects.toMatchObject({ code: 'pending_operation' });
    get.resolve(json(empty)); expect(await reading).toMatchObject({ code: 'stale_read' });
    put.resolve(json(receipt())); await writing; expect(f.fetcher).toHaveBeenCalledTimes(3);
  });
  it('rejects out-of-order reads and invalidates a delayed read on another denied read', async () => {
    const f = fixture(), first = deferred<Response>(); f.fetcher.mockReturnValueOnce(first.promise);
    const older = f.session.load().catch(error => error); await f.load(state()); first.resolve(json(empty));
    expect(await older).toMatchObject({ code: 'stale_read' });
    const late = deferred<Response>(); f.fetcher.mockReturnValueOnce(late.promise); const held = f.session.load().catch(error => error);
    f.fetcher.mockResolvedValueOnce(json({ error: 'forbidden' }, 403)); await expect(f.session.load()).rejects.toMatchObject({ outcome: 'unauthorized' });
    late.resolve(json(state())); expect(await held).toMatchObject({ code: 'stale_read' });
  });
  it.each([401, 402, 403])('withholds an authorized delayed PUT after a parallel denied read %s, then permits exact recovery', async status => {
    const f = fixture(); await f.load(); const late = deferred<Response>(); f.fetcher.mockReturnValueOnce(late.promise);
    const write = f.session.submit(profile, 0).catch(error => error);
    f.fetcher.mockResolvedValueOnce(json({ error: 'forbidden' }, status)); await expect(f.session.load()).rejects.toMatchObject({ status, outcome: 'unauthorized' });
    late.resolve(json(receipt())); expect(await write).toMatchObject({ code: 'session_changed', outcome: 'unauthorized' }); expect(f.session.hasPending()).toBe(true);
    f.fetcher.mockResolvedValueOnce(json({ ...receipt(), replayed: true })); expect((await f.session.retry()).replayed).toBe(true);
    expect(f.fetcher.mock.calls[1][1]?.body).toBe(f.fetcher.mock.calls[3][1]?.body); expect(f.newId).toHaveBeenCalledOnce();
  });
  it.each([401, 402, 403])('rejects immediately at HTTP %s without consuming a stalled/private body', async status => {
    const f = fixture(); await f.load(); const rejected = json({ error: 'private canary' }, status);
    const parser = vi.spyOn(rejected, 'json').mockReturnValue(new Promise<never>(() => {})); f.fetcher.mockResolvedValueOnce(rejected);
    await expect(f.session.submit(profile, 0)).rejects.toMatchObject({ status, outcome: 'unauthorized' });
    expect(parser).not.toHaveBeenCalled(); expect(f.fetcher.mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(true); expect(f.session.hasPending()).toBe(true);
  });
  it.each(['fetch', 'json'] as const)('times out the complete %s stage and retains write recovery', async stage => {
    vi.useFakeTimers(); const f = fixture(); await f.load(); const forever = new Promise<never>(() => {});
    const stalledJson = json({}); vi.spyOn(stalledJson, 'json').mockReturnValue(forever);
    f.fetcher.mockImplementationOnce(async () => stage === 'fetch' ? forever : stalledJson);
    const result = f.session.submit(profile, 0).catch(error => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toMatchObject({ code: 'response_timeout', outcome: 'uncertain' });
    expect(f.fetcher.mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(true); expect(f.session.hasPending()).toBe(true);
  });
  it('disposes pending RAM and rejects an already-authorized delayed response', async () => {
    const f = fixture(); await f.load(); const late = deferred<Response>(); f.fetcher.mockReturnValueOnce(late.promise);
    const write = f.session.submit(profile, 0).catch(error => error); f.session.dispose(); late.resolve(json(receipt()));
    expect(await write).toMatchObject({ code: 'session_disposed', outcome: 'unauthorized' }); expect(f.session.hasPending()).toBe(false);
    expect(f.fetcher.mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(true);
    await expect(f.session.load()).rejects.toMatchObject({ code: 'session_disposed' }); await expect(f.session.retry()).rejects.toMatchObject({ code: 'session_disposed' });
  });
});
