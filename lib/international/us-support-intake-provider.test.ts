import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UsMailboxError, type UsMailboxConnection } from './us-support-mailbox-contract';
import { createUsSupportIntakeProvider, type UsSupportIntakeScan } from './us-support-intake-provider';

const at = 1791600000;
function fixture() {
  const connection: UsMailboxConnection = { id: randomUUID(), provider: 'infomaniak', email: 'private@example.test', mailboxId: 'private-box', folderId: 'inbox',
    revision: 1, tokenSha256: 'a'.repeat(64), credentialsCiphertext: null, verifiedAt: at, connectedBy: randomUUID() };
  const raw: { threads: unknown[] } = { threads: [{ date: at, messages: [{ uid: '42@inbox', folder_id: 'inbox', date: at, body: 'Private body', from: [{ email: 'sender@example.test' }] }] }] };
  const detail: Record<string, unknown> = { uid: '42@inbox', folder_id: 'inbox', date: at, body: '<p>Private body</p>', attachments: [{ resource: 'https://foreign.example.test/private' }] };
  const calls: { url: URL; init?: RequestInit }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => { const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url); calls.push({ url, init }); return Response.json({ result: 'success', data: url.pathname.endsWith('/message') ? raw : detail }); });
  const provider = createUsSupportIntakeProvider(fetcher), check = vi.fn(async () => {});
  const discover = (scan: UsSupportIntakeScan = { offset: 0, sinceAt: at }) => provider.discover(connection, 'fixture-key', scan, check);
  return { connection, raw, detail, calls, fetcher, provider, check, discover };
}
beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('bounded US intake discovery with synthetic Infomaniak responses', () => {
  it('performs one fixed-origin read and returns body-free references', async () => {
    const f = fixture(), result = await f.discover();
    expect(result).toEqual({ offset: 0, threadCount: 1, nextOffset: null, references: [{ uid: '42', versionHint: String(at), receivedAt: at }], issues: [] });
    expect(f.fetcher).toHaveBeenCalledOnce();
    const { url, init } = f.calls[0]; expect(url.origin).toBe('https://mail.infomaniak.com'); expect(url.pathname).toBe('/api/mail/private-box/folder/inbox/message');
    expect([...url.searchParams]).toEqual([['offset', '0'], ['thread', 'off'], ['severywhere', '0'], ['limit', '20'], ['sfromdate', new Date((at - 86400) * 1000).toISOString().slice(0, 10) + ' 00:00:00']]);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual' }); expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-key');
    expect(f.check.mock.calls.length).toBeGreaterThanOrEqual(5); expect(JSON.stringify(result)).not.toMatch(/Private|sender@example|fixture-key|private-box|https:/);
    expect(Object.isFrozen(result.references)).toBe(true); expect(Object.isFrozen(result.references[0])).toBe(true);
  });
  it('uses thread counts, walks every message and has no UI offset200 ceiling', async () => {
    const f = fixture(); f.raw.threads = Array.from({ length: 20 }, (_, i) => ({ messages: [{ uid: `${i * 2 + 1}@inbox`, date: at }, { uid: `${i * 2 + 2}@inbox`, date: at }] }));
    const result = await f.discover({ offset: 240, sinceAt: at }); expect(result.references).toHaveLength(40); expect(result).toMatchObject({ offset: 240, threadCount: 20, nextOffset: 260 });
  });
  it('preserves an immutable lower search boundary across pages and empty pages end the cycle', async () => {
    const f = fixture(); f.raw.threads = [];
    expect(await f.discover({ offset: 400, sinceAt: at })).toEqual({ offset: 400, threadCount: 0, nextOffset: null, references: [], issues: [] });
    expect(f.calls[0].url.searchParams.get('sfromdate')).toBe(new Date((at - 86400) * 1000).toISOString().slice(0, 10) + ' 00:00:00');
  });
  it('never invents a message version from the parent thread date', async () => {
    const f = fixture(); f.raw.threads = [{ date: at, messages: [{ uid: '42@inbox' }] }];
    expect((await f.discover()).references).toEqual([{ uid: '42', versionHint: null, receivedAt: at }]);
  });
  it.each([undefined, null, 'not-a-date', {}, 0, 1791600000.5, ' leading ', 'bad\u202e'])('keeps unusable date hint %j unresolved', async date => {
    const f = fixture(); f.raw.threads = [{ messages: [{ uid: '42@inbox', date }] }];
    expect((await f.discover()).references).toEqual([{ uid: '42', versionHint: null, receivedAt: null }]);
  });
  it.each(['1791600000', '2026-10-10T00:00:00Z', 1791600000000])('keeps the exact valid own version %j', async date => {
    const f = fixture(); f.raw.threads = [{ messages: [{ uid: '42@inbox', date }] }];
    expect((await f.discover()).references[0].versionHint).toBe(String(date));
  });
  it.each([{}, { messages: [] }, null, { messages: 'private malformed message' }])('records a bounded missing-message issue without dropping healthy threads %j', async poison => {
    const f = fixture(); f.raw.threads.unshift(poison); const result = await f.discover();
    expect(result.references).toHaveLength(1); expect(result.issues).toEqual([{ code: 'missing_messages', threadIndex: 0, messageIndex: null, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
    expect(JSON.stringify(result)).not.toContain('private malformed'); expect(result.threadCount).toBe(2);
  });
  it.each([undefined, '42', '42@other', '42@inbox@other', 'x@inbox', '1/2@inbox', '1'.repeat(21) + '@inbox'])('does not claim an uncorroborated UID %j', async uid => {
    const f = fixture(); f.raw.threads.unshift({ messages: [{ uid, body: 'Private poison body' }] }); const result = await f.discover();
    expect(result.references).toEqual([{ uid: '42', versionHint: String(at), receivedAt: at }]); expect(result.issues[0]).toMatchObject({ code: 'invalid_reference', threadIndex: 0, messageIndex: 0 });
    expect(JSON.stringify(result)).not.toContain('Private poison');
  });
  it('records contradictory folder metadata and oversized threads while healthy messages continue', async () => {
    const f = fixture(); f.raw.threads.unshift({ messages: [{ uid: '43@inbox', folder_id: 'other' }] }, { messages: Array.from({ length: 51 }, (_, i) => ({ uid: `${i}@inbox` })) });
    const result = await f.discover(); expect(result.references).toHaveLength(1); expect(result.issues.map(issue => issue.code)).toEqual(['wrong_folder', 'oversized_thread']);
  });
  it('deduplicates repeated UIDs but makes conflicting hints visible', async () => {
    const f = fixture(); f.raw.threads.push({ messages: [{ uid: '42@inbox', date: at }, { uid: '42@inbox', date: at + 1 }] });
    const result = await f.discover(); expect(result.references).toHaveLength(1); expect(result.issues).toHaveLength(1); expect(result.issues[0].code).toBe('invalid_reference');
  });
  it('allows the exact bounded1000 references without truncating them', async () => {
    const f = fixture(); f.raw.threads = Array.from({ length: 20 }, (_, i) => ({ messages: Array.from({ length: 50 }, (_, j) => ({ uid: `${i * 50 + j}@inbox`, date: at })) }));
    const result = await f.discover(); expect(result.references).toHaveLength(1000); expect(result.issues).toEqual([]); expect(result.nextOffset).toBe(20);
  });
  it.each([{ offset: 1, sinceAt: at }, { offset: -20, sinceAt: at }, { offset: Number.MAX_SAFE_INTEGER, sinceAt: at }, { offset: 0, sinceAt: 0 }, { offset: 0, sinceAt: Infinity }, { offset: 0, sinceAt: at, url: 'https://foreign.example.test' }])('refuses malformed scan arguments before I/O %j', async scan => {
    const f = fixture(); await expect(f.discover(scan)).rejects.toMatchObject({ code: 'invalid_intake_request', status: 422 }); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each([null, {}, { threads: {} }, { threads: Array.from({ length: 21 }, () => ({ messages: [] })) }])('refuses malformed global page shape without claiming a cursor %j', async data => {
    const f = fixture(), fetcher = vi.fn<typeof fetch>(async () => Response.json({ result: 'success', data }));
    await expect(createUsSupportIntakeProvider(fetcher).discover(f.connection, 'fixture-key', { offset: 0, sinceAt: at }, f.check)).rejects.toMatchObject({ code: 'intake_provider_unavailable', status: 503 }); expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([302, 429, 500])('does not follow redirects or retry provider status %s', async status => {
    const f = fixture(), fetcher = vi.fn<typeof fetch>(async () => new Response('private upstream diagnostic', { status, headers: { Location: 'https://foreign.example.test' } }));
    await expect(createUsSupportIntakeProvider(fetcher).discover(f.connection, 'fixture-key', { offset: 0, sinceAt: at }, f.check)).rejects.toMatchObject({ code: 'intake_provider_unavailable', message: 'intake_provider_unavailable' }); expect(fetcher).toHaveBeenCalledOnce();
  });
  it('bounds the raw streaming response and never silently truncates it', async () => {
    const f = fixture(), fetcher = vi.fn<typeof fetch>(async () => Response.json({ result: 'success', data: { threads: [], body: 'x'.repeat(2_000_001) } }));
    await expect(createUsSupportIntakeProvider(fetcher).discover(f.connection, 'fixture-key', { offset: 0, sinceAt: at }, f.check)).rejects.toMatchObject({ code: 'intake_provider_unavailable' });
  });
  it('preserves fresh authority loss instead of replacing it with an upstream error', async () => {
    const f = fixture(); let denied = false;
    const fetcher: typeof fetch = async () => { denied = true; return Response.json({ result: 'success', data: f.raw }); };
    await expect(createUsSupportIntakeProvider(fetcher).discover(f.connection, 'fixture-key', { offset: 0, sinceAt: at }, async () => { if (denied) throw new UsMailboxError('forbidden', 403); })).rejects.toMatchObject({ code: 'forbidden', status: 403 });
  });
  it.each(['fetch', 'stream'] as const)('applies its total deadline during %s and cancels the actual transport', async phase => {
    vi.useFakeTimers(); const f = fixture(), cancel = vi.fn(); let signal: AbortSignal | null | undefined;
    const fetcher: typeof fetch = async (_input, init) => { signal = init?.signal; return phase === 'fetch' ? new Promise<Response>(() => {}) : new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{"result":"success","data":')); }, cancel })); };
    const assertion = expect(createUsSupportIntakeProvider(fetcher).discover(f.connection, 'fixture-key', { offset: 0, sinceAt: at }, f.check)).rejects.toMatchObject({ code: 'intake_provider_unavailable', status: 503 });
    await vi.advanceTimersByTimeAsync(12_000); await assertion; expect(signal?.aborted).toBe(true); if (phase === 'stream') expect(cancel).toHaveBeenCalledOnce();
  });
});

describe('strict private version resolution without body retention', () => {
  it('returns only exact corroborated own version/date and never follows attachment URLs', async () => {
    const f = fixture(); expect(await f.provider.resolveVersion(f.connection, 'fixture-key', '42', f.check)).toEqual({ messageVersion: String(at), receivedAt: at });
    expect(f.calls).toHaveLength(1); expect(f.calls[0].url.href).toBe('https://mail.infomaniak.com/api/mail/private-box/folder/inbox/message/42?prefered_format=html&with=auto_uncrypt,thread_context');
  });
  it.each([undefined, '42', '43@inbox', '42@other'])('rejects an uncorroborated detail UID %j', async uid => {
    const f = fixture(); f.detail.uid = uid; await expect(f.provider.resolveVersion(f.connection, 'fixture-key', '42', f.check)).rejects.toMatchObject({ code: 'intake_source_conflict', status: 409 });
  });
  it('rejects a contradictory detail folder', async () => {
    const f = fixture(); f.detail.folder_id = 'other'; await expect(f.provider.resolveVersion(f.connection, 'fixture-key', '42', f.check)).rejects.toMatchObject({ code: 'intake_source_conflict' });
  });
  it.each([undefined, null, 0, 'bad-date', '1791600000\u202e', 1791600000.25])('requires a usable exact detail date %j', async date => {
    const f = fixture(); f.detail.date = date; await expect(f.provider.resolveVersion(f.connection, 'fixture-key', '42', f.check)).rejects.toMatchObject({ code: 'intake_source_unavailable', status: 422 });
  });
  it('rejects caller locator injection before I/O', async () => {
    const f = fixture(); await expect(f.provider.resolveVersion(f.connection, 'fixture-key', '42/../../foreign', f.check)).rejects.toMatchObject({ code: 'invalid_intake_request' }); expect(f.fetcher).not.toHaveBeenCalled();
  });
});
