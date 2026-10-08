import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserTaxProfileError, createBrowserTaxProfileSession } from './browser-tax-profile-session';
import type { TaxProfileStore, UsTaxFacts, UsTaxProfileDeclared, UsTaxProfileReceipt, UsTaxProfileState } from './us-tax-profile';
import { createUsTaxProfileHandlers } from './us-tax-profile-server';
import { AccountPublicError } from '../account-security';
import type { FinancialAuthority } from './accounting/ledger';
import type { CompanyConfiguration } from './types';

const organizationId = 'fictitious-us-tax', expectedUserId = 'fictitious-owner';
const requestId = '10000000-0000-4000-8000-000000000001';
const facts: UsTaxFacts = { schemaVersion: 1, legalName: 'Private TEST business', taxOrigin: { country: 'US', line1: '123 Private TEST Avenue', city: 'New York', subdivision: 'NY', postalCode: '10001' }, timeZone: 'America/New_York' };
const empty: UsTaxProfileState = { status: 'unconfigured', organizationId, revision: 0, verification: 'unverified' };
const state = (revision = 1, declared = facts): UsTaxProfileDeclared => ({ status: 'declared', organizationId, revision, facts: declared, updatedBy: expectedUserId, updatedAt: '2026-10-08T12:34:56.123456Z', verification: 'unverified' });
const receipt = (revision = 1, declared = facts): UsTaxProfileReceipt => ({ ...state(revision, declared) as UsTaxProfileReceipt, requestId, replayed: false });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const fetcher = vi.fn<typeof fetch>(), newId = vi.fn(() => requestId), onAccessDenied = vi.fn();
  const session = createBrowserTaxProfileSession({ organizationId, expectedUserId, fetch: fetcher, newId, onAccessDenied });
  const load = async (value: UsTaxProfileState = empty) => { fetcher.mockResolvedValueOnce(json(value)); return session.load(); };
  return { fetcher, newId, onAccessDenied, session, load };
}
afterEach(() => vi.useRealTimers());

describe('private owner-bound declarative US tax browser transport', () => {
  it.each(['', '../other', 'https://other.example', ' bad', 'a'.repeat(129)])('rejects unsafe workspace %s locally', organizationId => {
    expect(() => createBrowserTaxProfileSession({ organizationId, expectedUserId })).toThrow(BrowserTaxProfileError);
  });
  it.each(['', ' other', 'other ', 'user\n', 'a'.repeat(257)])('rejects imprecise Auth user %s locally', expectedUserId => {
    expect(() => createBrowserTaxProfileSession({ organizationId, expectedUserId })).toThrow(BrowserTaxProfileError);
  });
  it('uses only a scoped same-origin cookie GET and refuses writes without fresh owner read', async () => {
    const f = fixture();
    await expect(f.session.submit(facts, 0)).rejects.toMatchObject({ code: 'read_required', outcome: 'rejected' });
    expect(f.fetcher).not.toHaveBeenCalled(); expect(await f.load()).toEqual(empty);
    const [url, init] = f.fetcher.mock.calls[0];
    expect(url).toBe(`/api/international/workspaces/${organizationId}/tax-profile`);
    expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json', 'X-Zentra-Expected-User': expectedUserId } });
    expect(init?.body).toBeUndefined(); expect(new Headers(init?.headers).has('Authorization')).toBe(false); expect(f.newId).not.toHaveBeenCalled();
  });
  it('returns frozen private declarations while preserving microseconds and never granting verification', async () => {
    const f = fixture(), output = await f.load(state());
    expect(output).toEqual(state()); expect(Object.isFrozen(output)).toBe(true);
    if (output.status !== 'declared') throw new Error('Invalid fixture');
    expect(Object.isFrozen(output.facts)).toBe(true); expect(Object.isFrozen(output.facts.taxOrigin)).toBe(true);
    expect(output.facts).not.toBe(facts); expect(output.verification).toBe('unverified');
  });
  it.each([
    { ...empty, organizationId: 'foreign' }, { ...empty, revision: 1 }, { ...empty, facts },
    { ...state(), organizationId: 'foreign' }, { ...state(), verification: 'verified' }, { ...state(), role: 'owner' },
    { ...state(), facts: { ...facts, providerAccount: 'acct_PRIVATE' } }, { ...state(), updatedAt: '2026-02-30T00:00:00Z' },
    { ...state(), updatedAt: '2026-10-08' }, { ...state(), facts: { ...facts, legalName: ' Not canonical ' } },
  ])('refuses malformed or granted private GET %j and cannot write afterwards', async input => {
    const f = fixture(); await f.load(); f.fetcher.mockResolvedValueOnce(json(input));
    await expect(f.session.load()).rejects.toMatchObject({ code: 'invalid_response', outcome: 'rejected' });
    await expect(f.session.submit(facts, 0)).rejects.toMatchObject({ code: 'read_required' });
  });
  it('rejects private projection getters without invoking them', async () => {
    const f = fixture(), getter = vi.fn(() => 'declared'), value = { ...state() };
    Object.defineProperty(value, 'status', { enumerable: true, get: getter });
    f.fetcher.mockResolvedValueOnce({ ok: true, status: 200, json: async () => value } as Response);
    await expect(f.session.load()).rejects.toMatchObject({ code: 'invalid_response' }); expect(getter).not.toHaveBeenCalled();
  });
  it('sends only a deeply copied declarative body with a distinct CAS revision and canonical UUID', async () => {
    const f = fixture(); await f.load(); f.newId.mockReturnValueOnce('10000000-0000-4000-8ABC-000000000001');
    f.fetcher.mockResolvedValueOnce(json({ ...receipt(), requestId: '10000000-0000-4000-8abc-000000000001' }));
    await f.session.submit({ ...facts, legalName: ' Private TEST business ' }, 0);
    const [, init] = f.fetcher.mock.calls[1];
    expect(init?.method).toBe('PUT'); expect(JSON.parse(init?.body as string)).toEqual({ expectedRevision: 0, requestId: '10000000-0000-4000-8abc-000000000001', facts });
    expect(init?.body).not.toMatch(/role|provider|authority|subscription|verification|organizationId|EIN/);
    expect(f.session.hasPending()).toBe(false);
    await expect(f.session.submit(facts, 1)).rejects.toMatchObject({ code: 'read_required' });
  });
  it.each([
    { ...facts, legalName: '' }, { ...facts, legalName: 'x'.repeat(257) }, { ...facts, legalName: '\ud800' },
    { ...facts, taxOrigin: { ...facts.taxOrigin, city: '\udc00' } }, { ...facts, timeZone: 'Europe/Zurich' },
    { ...facts, providerVerified: true }, { ...facts, taxOrigin: { ...facts.taxOrigin, country: 'CH' } },
  ])('returns a stable local 422 before allocating a UUID or making I/O %j', async input => {
    const f = fixture(); await f.load(); await expect(f.session.submit(input as UsTaxFacts, 0)).rejects.toMatchObject({ code: 'invalid_request', status: 422, outcome: 'rejected' });
    expect(f.newId).not.toHaveBeenCalled(); expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.session.hasPending()).toBe(false);
  });
  it.each([-1, 0.5, NaN, Number.MAX_SAFE_INTEGER - 1])('refuses invalid expected revision %s without allocating a key', async revision => {
    const f = fixture(); await f.load(); await expect(f.session.submit(facts, revision)).rejects.toMatchObject({ code: 'invalid_request' }); expect(f.newId).not.toHaveBeenCalled();
  });
  it('snapshots facts before newId can mutate the original form', async () => {
    const f = fixture(); await f.load(); const draft = structuredClone(facts);
    f.newId.mockImplementationOnce(() => { (draft.taxOrigin as { line1: string }).line1 = 'Changed after validation'; return requestId; });
    f.fetcher.mockResolvedValueOnce(json(receipt())); await f.session.submit(draft, 0);
    expect(JSON.parse(f.fetcher.mock.calls[1][1]?.body as string).facts).toEqual(facts);
  });
  it('does not let a UUID callback resurrect an explicitly invalidated private session', async () => {
    const f = fixture(); await f.load(); f.newId.mockImplementationOnce(() => { f.session.invalidate(); return requestId; });
    await expect(f.session.submit(facts, 0)).rejects.toMatchObject({ code: 'session_changed', outcome: 'unauthorized' });
    expect(f.session.hasPending()).toBe(false); expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it('validates nested private form descriptors without invoking getters', async () => {
    const f = fixture(); await f.load(); const getter = vi.fn(() => 'Private address'), draft = structuredClone(facts);
    Object.defineProperty(draft.taxOrigin, 'line1', { enumerable: true, get: getter });
    await expect(f.session.submit(draft, 0)).rejects.toMatchObject({ code: 'invalid_request', status: 422 });
    expect(getter).not.toHaveBeenCalled(); expect(f.newId).not.toHaveBeenCalled(); expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it.each(['network', '503', 'malformed'] as const)('preserves exact RAM envelope after %s, rechecks owner before retry, and returns historical receipt', async failure => {
    const f = fixture(); await f.load(); const draft = structuredClone(facts);
    if (failure === 'network') f.fetcher.mockRejectedValueOnce(new TypeError('PRIVATE error text'));
    else f.fetcher.mockResolvedValueOnce(failure === '503' ? json({ error: 'service_unavailable' }, 503) : json({ not: 'receipt' }));
    await expect(f.session.submit(draft, 0)).rejects.toMatchObject({ outcome: 'uncertain' });
    (draft.taxOrigin as { city: string }).city = 'Changed draft'; expect(f.session.hasPending()).toBe(true);
    await expect(f.session.submit(draft, 0)).rejects.toMatchObject({ code: 'pending_operation' });
    const newer = state(2, { ...facts, legalName: 'Newer private TEST business' });
    f.fetcher.mockResolvedValueOnce(json(newer)).mockResolvedValueOnce(json({ ...receipt(), replayed: true }));
    expect(await f.session.retry()).toEqual({ ...receipt(), replayed: true });
    expect(f.fetcher.mock.calls[2][1]?.method).toBe('GET'); expect(f.fetcher.mock.calls[3][1]?.body).toBe(f.fetcher.mock.calls[1][1]?.body);
    expect(f.newId).toHaveBeenCalledOnce(); await expect(f.session.submit(facts, 1)).rejects.toMatchObject({ code: 'read_required' });
    expect(await f.load(newer)).toEqual(newer);
  });
  it.each(['revision_conflict', 'request_id_conflict'])('clears pending for SQL precommit %s, requiring GET and an explicit new request', async error => {
    const f = fixture(); await f.load(); f.fetcher.mockResolvedValueOnce(json({ error }, 409));
    await expect(f.session.submit(facts, 0)).rejects.toMatchObject({ code: error, status: 409, outcome: 'rejected' });
    expect(f.session.hasPending()).toBe(false); await expect(f.session.retry()).rejects.toMatchObject({ code: 'no_pending_operation' });
    await expect(f.session.submit(facts, 1)).rejects.toMatchObject({ code: 'read_required' });
    await f.load(state()); f.newId.mockReturnValueOnce('10000000-0000-4000-8000-000000000002');
    f.fetcher.mockResolvedValueOnce(json({ ...receipt(2), requestId: '10000000-0000-4000-8000-000000000002' })); await f.session.submit(facts, 1);
    expect(f.newId).toHaveBeenCalledTimes(2);
  });
  it.each([[409, 'configuration_changed'], [409, 'workspace_unavailable'], [422, 'invalid_request'], [404, 'feature_unavailable'], [429, 'rate_limited'], [503, 'service_unavailable']] as const)('does not mistake potentially postcommit %s/%s for a reliable rejection', async (status, error) => {
    const f = fixture(); await f.load(); f.fetcher.mockResolvedValueOnce(json({ error }, status));
    await expect(f.session.submit(facts, 0)).rejects.toMatchObject({ code: error, status, outcome: 'uncertain' }); expect(f.session.hasPending()).toBe(true);
  });
  it.each([401, 402, 403])('purges private pending immediately at HTTP %s, without reading a private/stalled body', async status => {
    const f = fixture(); await f.load(); const denied = json({ error: 'PRIVATE details' }, status), parser = vi.spyOn(denied, 'json').mockReturnValue(new Promise<never>(() => {}));
    f.fetcher.mockResolvedValueOnce(denied);
    await expect(f.session.submit(facts, 0)).rejects.toMatchObject({ status, outcome: 'unauthorized' });
    expect(parser).not.toHaveBeenCalled(); expect(f.session.hasPending()).toBe(false); expect(f.onAccessDenied).toHaveBeenCalledOnce();
    await expect(f.session.retry()).rejects.toMatchObject({ code: 'no_pending_operation' });
    await expect(f.session.submit(facts, 0)).rejects.toMatchObject({ code: 'read_required' });
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([401, 402, 403])('refuses retry before PUT if fresh owner confirmation returns %s', async status => {
    const f = fixture(); await f.load(); f.fetcher.mockRejectedValueOnce(new Error('Response lost'));
    await expect(f.session.submit(facts, 0)).rejects.toMatchObject({ outcome: 'uncertain' });
    f.fetcher.mockResolvedValueOnce(json({ error: 'forbidden' }, status));
    await expect(f.session.retry()).rejects.toMatchObject({ status, outcome: 'unauthorized' });
    expect(f.session.hasPending()).toBe(false); expect(f.fetcher.mock.calls.map(call => call[1]?.method)).toEqual(['GET', 'PUT', 'GET']);
  });
  it('a failed retry confirmation keeps outcome uncertain but does not send private facts again', async () => {
    const f = fixture(); await f.load(); f.fetcher.mockRejectedValueOnce(new Error('Lost write')); await expect(f.session.submit(facts, 0)).rejects.toMatchObject({ outcome: 'uncertain' });
    f.fetcher.mockRejectedValueOnce(new Error('Lost read')); await expect(f.session.retry()).rejects.toMatchObject({ outcome: 'uncertain' });
    expect(f.session.hasPending()).toBe(true); expect(f.fetcher.mock.calls.at(-1)?.[1]?.body).toBeUndefined();
  });
  it('a malformed retry confirmation never resends private facts or substitutes a granted head', async () => {
    const f = fixture(); await f.load(); f.fetcher.mockRejectedValueOnce(new Error('Lost write')); await expect(f.session.submit(facts, 0)).rejects.toMatchObject({ outcome: 'uncertain' });
    f.fetcher.mockResolvedValueOnce(json({ ...state(), verification: 'verified' }));
    await expect(f.session.retry()).rejects.toMatchObject({ code: 'invalid_response', outcome: 'uncertain' });
    expect(f.session.hasPending()).toBe(true); expect(f.fetcher.mock.calls.map(call => call[1]?.method)).toEqual(['GET', 'PUT', 'GET']);
  });
  it.each([
    { ...receipt(), organizationId: 'foreign' }, { ...receipt(), updatedBy: 'other-user' }, { ...receipt(), requestId: '20000000-0000-4000-8000-000000000001' },
    { ...receipt(), revision: 2 }, { ...receipt(), facts: { ...facts, legalName: 'Different facts' } },
    { ...receipt(), verification: 'verified' }, { ...receipt(), replayed: 'false' }, { ...receipt(), providerProof: 'fake' },
  ])('withholds malformed, foreign or privileged receipt %j while preserving transient recovery', async input => {
    const f = fixture(); await f.load(); f.fetcher.mockResolvedValueOnce(json(input));
    await expect(f.session.submit(facts, 0)).rejects.toMatchObject({ code: 'invalid_response', outcome: 'uncertain' }); expect(f.session.hasPending()).toBe(true);
  });
  it('normalizes unsafe or unrecognized public error bodies without echoing facts or provider text', async () => {
    const f = fixture(); await f.load(); f.fetcher.mockResolvedValueOnce(json({ error: 'PRIVATE tax details', facts }, 500));
    await expect(f.session.submit(facts, 0)).rejects.toMatchObject({ code: 'service_unavailable', message: 'service_unavailable', outcome: 'uncertain' });
  });
  it('invalidates pending RAM and old responses synchronously on explicit logout or cross-channel refusal', async () => {
    const f = fixture(); await f.load(); const late = deferred<Response>(); f.fetcher.mockReturnValueOnce(late.promise);
    const write = f.session.submit(facts, 0).catch(error => error); f.session.invalidate();
    expect(f.session.hasPending()).toBe(false); expect(f.fetcher.mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(true);
    expect(await write).toMatchObject({ code: 'session_changed', outcome: 'unauthorized' });
    late.resolve(json(receipt())); expect(f.onAccessDenied).not.toHaveBeenCalled();
    await expect(f.session.submit(facts, 0)).rejects.toMatchObject({ code: 'read_required' });
    expect(await f.load()).toEqual(empty);
  });
  it('blocks a retry when logout occurs during fresh owner GET, even if fetch ignores abort', async () => {
    const f = fixture(); await f.load(); f.fetcher.mockRejectedValueOnce(new Error('Lost write')); await expect(f.session.submit(facts, 0)).rejects.toMatchObject({ outcome: 'uncertain' });
    const late = deferred<Response>(); f.fetcher.mockReturnValueOnce(late.promise); const retry = f.session.retry().catch(error => error);
    f.session.invalidate(); expect(await retry).toMatchObject({ outcome: 'unauthorized' }); late.resolve(json(state()));
    expect(f.session.hasPending()).toBe(false); expect(f.fetcher.mock.calls.map(call => call[1]?.method)).toEqual(['GET', 'PUT', 'GET']);
  });
  it('withholds a delayed PUT after parallel owner denial and cannot recover its purged private envelope', async () => {
    const f = fixture(); await f.load(); const late = deferred<Response>(); f.fetcher.mockReturnValueOnce(late.promise);
    const write = f.session.submit(facts, 0).catch(error => error);
    f.fetcher.mockResolvedValueOnce(json({ error: 'forbidden' }, 403)); await expect(f.session.load()).rejects.toMatchObject({ outcome: 'unauthorized' });
    expect(await write).toMatchObject({ outcome: 'unauthorized' }); late.resolve(json(receipt()));
    expect(f.session.hasPending()).toBe(false); await expect(f.session.retry()).rejects.toMatchObject({ code: 'no_pending_operation' });
  });
  it('rejects reversed reads and a read from before a completed conflict without reopening writes', async () => {
    const f = fixture(), late = deferred<Response>(); f.fetcher.mockReturnValueOnce(late.promise); const old = f.session.load().catch(error => error);
    await f.load(); f.fetcher.mockResolvedValueOnce(json({ error: 'revision_conflict' }, 409));
    await expect(f.session.submit(facts, 0)).rejects.toMatchObject({ code: 'revision_conflict' }); late.resolve(json(empty));
    expect(await old).toMatchObject({ code: 'stale_read' }); await expect(f.session.submit(facts, 0)).rejects.toMatchObject({ code: 'read_required' });
  });
  it('a failed later read removes the previous owner-read admission', async () => {
    const f = fixture(); await f.load(); f.fetcher.mockRejectedValueOnce(new TypeError('Lost read'));
    await expect(f.session.load()).rejects.toMatchObject({ outcome: 'rejected' });
    await expect(f.session.submit(facts, 0)).rejects.toMatchObject({ code: 'read_required' }); expect(f.newId).not.toHaveBeenCalled();
  });
  it('does not accept owner confirmation during a write as fresh afterwards', async () => {
    const f = fixture(); await f.load(); const late = deferred<Response>(); f.fetcher.mockReturnValueOnce(late.promise); const write = f.session.submit(facts, 0);
    await f.load(state()); late.resolve(json(receipt())); await write;
    await expect(f.session.submit(facts, 1)).rejects.toMatchObject({ code: 'read_required' });
  });
  it.each(['fetch', 'json'] as const)('bounds the whole %s write stage to thirty seconds and only retains transient recovery', async stage => {
    vi.useFakeTimers(); const f = fixture(); await f.load(); const forever = new Promise<never>(() => {}), stalled = json({}); vi.spyOn(stalled, 'json').mockReturnValue(forever);
    f.fetcher.mockImplementationOnce(async () => stage === 'fetch' ? forever : stalled);
    const write = f.session.submit(facts, 0).catch(error => error); await vi.advanceTimersByTimeAsync(30_000);
    expect(await write).toMatchObject({ code: 'response_timeout', outcome: 'uncertain' }); expect(f.session.hasPending()).toBe(true);
    expect(f.fetcher.mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(true);
  });
  it('never carries one user or tenant envelope into another session and never persists it', async () => {
    const f = fixture(); await f.load(); f.fetcher.mockRejectedValueOnce(new Error('Lost write')); await expect(f.session.submit(facts, 0)).rejects.toMatchObject({ outcome: 'uncertain' });
    const otherFetch = vi.fn<typeof fetch>(); const other = createBrowserTaxProfileSession({ organizationId: 'other-us', expectedUserId: 'other-owner', fetch: otherFetch });
    expect(other.hasPending()).toBe(false); await expect(other.retry()).rejects.toMatchObject({ code: 'no_pending_operation' }); expect(otherFetch).not.toHaveBeenCalled();
    f.session.dispose(); expect(f.session.hasPending()).toBe(false);
    await expect(f.session.load()).rejects.toMatchObject({ code: 'session_disposed', outcome: 'unauthorized' });
  });
  it('invalidates an already received JSON promise on dispose and does not resurrect facts', async () => {
    const f = fixture(), value = json(state()), late = deferred<unknown>(); vi.spyOn(value, 'json').mockReturnValue(late.promise); f.fetcher.mockResolvedValueOnce(value);
    const read = f.session.load().catch(error => error); await Promise.resolve(); f.session.dispose();
    expect(await read).toMatchObject({ code: 'session_disposed', outcome: 'unauthorized' }); late.resolve(state());
    expect(f.session.hasPending()).toBe(false); expect(f.fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
});

/** Actual HTTP/service guards, injected Auth and in-memory RPC fixture. This is
 * not PostgreSQL durability, hosted Auth, D1 admission or provider evidence. */
function boundaryFixture() {
  let actor: FinancialAuthority = { organizationId, userId: expectedUserId, role: 'owner', managementEntitled: true, timestamp: '2026-10-08T12:34:56.123456Z' };
  let head: UsTaxProfileState = empty, commits = 0, unavailable = false;
  const config: CompanyConfiguration = { schemaVersion: 1, organizationId, country: 'US', currency: 'USD', language: 'en', timeZone: facts.timeZone, address: facts.taxOrigin, accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'unconfigured' } };
  const receipts = new Map<string, UsTaxProfileReceipt>(), hooks: { commit?: () => void } = {};
  const rpc = vi.fn(async (name: string, args: Readonly<Record<string, unknown>>) => {
    if (name === 'zentra_read_us_tax_profile') return structuredClone(head);
    const earlier = receipts.get(args.p_request_id as string);
    if (earlier) return { ...earlier, replayed: true };
    commits++; head = { ...state(args.p_expected_revision as number + 1, args.p_facts as UsTaxFacts), updatedBy: args.p_actor as string };
    const result: UsTaxProfileReceipt = { ...head as UsTaxProfileReceipt, requestId: args.p_request_id as string, replayed: false };
    receipts.set(result.requestId, structuredClone(result)); hooks.commit?.(); return result;
  });
  const store: TaxProfileStore = { async rpc<T>(name: string, args: Readonly<Record<string, unknown>>): Promise<T> { return await rpc(name, args) as T; } };
  const handlers = createUsTaxProfileHandlers({ enabled: async () => true, authority: async () => { if (unavailable) throw new AccountPublicError('Private outage details', 503); return { mode: 'browser', actor: { ...actor } }; }, configuration: async () => config, rateLimit: async () => {}, store: () => store, diagnostic: () => {} });
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const requestHeaders = new Headers(init?.headers); requestHeaders.set('Origin', 'https://zentra.test');
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const request = new Request(new URL(path, 'https://zentra.test'), { ...init, headers: requestHeaders });
    return init?.method === 'PUT' ? handlers.PUT(request, organizationId) : handlers.GET(request, organizationId);
  });
  const onAccessDenied = vi.fn(), session = createBrowserTaxProfileSession({ organizationId, expectedUserId, fetch: fetcher, newId: () => requestId, onAccessDenied });
  return { session, fetcher, rpc, hooks, onAccessDenied, commits: () => commits, role: (role: FinancialAuthority['role']) => { actor = { ...actor, role }; }, user: (userId: string) => { actor = { ...actor, userId }; }, unavailable: (value: boolean) => { unavailable = value; } };
}
describe('private browser through actual owner HTTP guards and service with synthetic RPC', () => {
  it.each(['admin', 'accountant', 'member', 'read_only'] as const)('does not admit %s to read facts or retry under a claimed owner', async role => {
    const f = boundaryFixture(); f.role(role);
    await expect(f.session.load()).rejects.toMatchObject({ status: 403, outcome: 'unauthorized' });
    await expect(f.session.submit(facts, 0)).rejects.toMatchObject({ code: 'read_required' });
    expect(f.rpc).not.toHaveBeenCalled(); expect(f.onAccessDenied).toHaveBeenCalledOnce();
  });
  it('recovers postcommit503 only after fresh same-owner GET with the exact envelope, once', async () => {
    const f = boundaryFixture(); await f.session.load(); f.hooks.commit = () => f.unavailable(true);
    await expect(f.session.submit(facts, 0)).rejects.toMatchObject({ status: 503, outcome: 'uncertain' }); expect(f.commits()).toBe(1); expect(f.session.hasPending()).toBe(true);
    f.unavailable(false); const result = await f.session.retry(); expect(result.replayed).toBe(true); expect(f.commits()).toBe(1);
    expect(f.fetcher.mock.calls.map(call => call[1]?.method)).toEqual(['GET', 'PUT', 'GET', 'PUT']);
    expect(f.fetcher.mock.calls[1][1]?.body).toBe(f.fetcher.mock.calls[3][1]?.body);
    expect(await f.session.load()).toMatchObject({ status: 'declared', revision: 1, verification: 'unverified' });
  });
  it('purges a postcommit role-revoked receipt without retrying it after role restoration', async () => {
    const f = boundaryFixture(); await f.session.load(); f.hooks.commit = () => f.role('member');
    await expect(f.session.submit(facts, 0)).rejects.toMatchObject({ status: 403, outcome: 'unauthorized' });
    expect(f.commits()).toBe(1); expect(f.session.hasPending()).toBe(false); f.role('owner');
    await expect(f.session.retry()).rejects.toMatchObject({ code: 'no_pending_operation' });
    expect(await f.session.load()).toMatchObject({ revision: 1, facts }); expect(f.commits()).toBe(1);
  });
  it('the expected-user fence prevents private retry under another authorized owner account', async () => {
    const f = boundaryFixture(); await f.session.load(); f.hooks.commit = () => f.unavailable(true);
    await expect(f.session.submit(facts, 0)).rejects.toMatchObject({ outcome: 'uncertain' }); f.unavailable(false); f.user('another-owner');
    await expect(f.session.retry()).rejects.toMatchObject({ status: 401, outcome: 'unauthorized' });
    expect(f.session.hasPending()).toBe(false); expect(f.commits()).toBe(1); expect(f.fetcher.mock.calls.at(-1)?.[1]?.method).toBe('GET');
    expect(f.rpc).toHaveBeenCalledTimes(2);
  });
});
