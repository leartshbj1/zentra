import { afterEach, describe, expect, it, vi } from 'vitest';
import { JevDecisionProvider, JEV_MODEL } from '../automation/provider';
import { JEV_ENDPOINT } from '../automation/transport';
import { DecisionFailure, type DecisionInput } from '../automation/types';
import { createUsSingleDispatchProvider } from './us-analysis-provider';

const input: DecisionInput = { state: { document: 'Untrusted fixture invoice' }, questions: { kind: { instructions: 'Choose a printed type.', options: { invoice: 'Invoice', other: 'Other' } } } };
const valid = () => ({ model: JEV_MODEL, answers: { kind: { type: 'choice', choice: 'invoice', confidence: 0.99, probabilities: { invoice: 0.99, other: 0.01 } } } });
afterEach(() => vi.useRealTimers());

describe('US single-dispatch provider: injected HTTP only, no external calls', () => {
  it('authorizes before a single pinned POST, and rejects another decide on the same fence', async () => {
    const order: string[] = [], authorize = vi.fn(async () => { order.push('admission'); });
    const fetcher = vi.fn<typeof fetch>(async (url, options) => { order.push('http');
      expect(url).toBe(JEV_ENDPOINT); expect(options).toMatchObject({ method: 'POST', redirect: 'manual' });
      expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer local-test-key');
      expect(JSON.parse(String(options?.body))).toMatchObject({ model: JEV_MODEL });
      expect(options?.signal).toBeInstanceOf(AbortSignal); return Response.json(valid());
    });
    const provider = createUsSingleDispatchProvider({ apiKey: 'local-test-key', authorize, fetcher });
    expect((await provider.decide(input)).model).toBe(JEV_MODEL);
    await expect(provider.decide(input)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(order).toEqual(['admission', 'http']); expect(fetcher).toHaveBeenCalledTimes(1); expect(authorize).toHaveBeenCalledTimes(1);
  });
  it.each([429, 502, 503, 504, 529])('does not retry an ambiguous HTTP %s', async status => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('private upstream body', { status, headers: { 'Retry-After': '0' } }));
    const provider = createUsSingleDispatchProvider({ apiKey: 'local-test-key', authorize: async () => {}, fetcher });
    await expect(provider.decide(input)).rejects.toMatchObject({ code: status === 429 ? 'rate_limit' : 'unavailable' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('keeps the default shared CH retry behavior intact', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 503, headers: { 'Retry-After': '0' } })).mockResolvedValueOnce(Response.json(valid()));
    const sleep = vi.fn(async () => {});
    await new JevDecisionProvider('local-test-key', fetcher, 6000, sleep).decide(input);
    expect(fetcher).toHaveBeenCalledTimes(2); expect(sleep).toHaveBeenCalledTimes(1);
  });
  it.each(['', null, undefined])('preserves the historical CH model fallback for %s while the explicit expectedModel option refuses it', async model => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ...valid(), model }));
    const legacy = new JevDecisionProvider('local-test-key', fetcher, 6000, async () => {});
    expect((await legacy.decide(input)).model).toBe(JEV_MODEL);
    const strict = new JevDecisionProvider('local-test-key', fetcher, 6000, async () => {}, { retry: false, expectedModel: JEV_MODEL });
    await expect(strict.decide(input)).rejects.toMatchObject({ code: 'invalid_response' }); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not emit HTTP when fresh admission fails', async () => {
    const fetcher = vi.fn<typeof fetch>(), authorize = vi.fn(async () => { throw new DecisionFailure('authentication'); });
    await expect(createUsSingleDispatchProvider({ apiKey: 'local-test-key', authorize, fetcher }).decide(input)).rejects.toMatchObject({ code: 'authentication' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('bounds admission, response headers and response body by one deadline', async () => {
    vi.useFakeTimers();
    for (const stage of ['admission', 'headers', 'body'] as const) {
      const fetcher = vi.fn<typeof fetch>(async () => stage === 'headers' ? new Promise<Response>(() => {}) : new Response(new ReadableStream<Uint8Array>({ start() {} })));
      const provider = createUsSingleDispatchProvider({ apiKey: 'local-test-key', timeoutMs: 40, authorize: async () => { if (stage === 'admission') await new Promise<void>(() => {}); }, fetcher });
      const assertion = expect(provider.decide(input)).rejects.toMatchObject({ code: 'timeout' });
      await vi.advanceTimersByTimeAsync(41); await assertion;
      expect(fetcher).toHaveBeenCalledTimes(stage === 'admission' ? 0 : 1);
    }
  });
  it('does not await an upstream cancel promise after a rejection', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {})), fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 503 }));
    const assertion = expect(createUsSingleDispatchProvider({ apiKey: 'local-test-key', timeoutMs: 40, authorize: async () => {}, fetcher }).decide(input)).rejects.toMatchObject({ code: 'unavailable' });
    await vi.advanceTimersByTimeAsync(41); await assertion; expect(cancel).toHaveBeenCalledTimes(1);
  });
  it.each(['jev-1.12.0', 'another/model', 'jev 1.13.0', '', null, undefined])('refuses an unconfirmed provider model %s', async model => {
    const body = { ...valid(), model }, fetcher = vi.fn<typeof fetch>(async () => Response.json(body));
    await expect(createUsSingleDispatchProvider({ apiKey: 'local-test-key', authorize: async () => {}, fetcher }).decide(input)).rejects.toMatchObject({ code: 'invalid_response' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(['json', 'oversized', 'answers'] as const)('rejects malformed %s without leaking upstream text', async kind => {
    const fetcher = vi.fn<typeof fetch>(async () => kind === 'json' ? new Response('private-secret invalid json') : kind === 'oversized' ? new Response('x'.repeat(64001)) : Response.json({ model: JEV_MODEL, answers: {} }));
    const error = await createUsSingleDispatchProvider({ apiKey: 'local-test-key', authorize: async () => {}, fetcher }).decide(input).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(DecisionFailure); expect(error).toMatchObject({ code: 'invalid_response', message: 'invalid_response' });
  });
  it.each([0, -1, 10001, Infinity])('rejects an invalid local deadline %s before HTTP', timeoutMs => {
    const fetcher = vi.fn<typeof fetch>();
    expect(() => createUsSingleDispatchProvider({ apiKey: 'local-test-key', timeoutMs, authorize: async () => {}, fetcher })).toThrow(DecisionFailure); expect(fetcher).not.toHaveBeenCalled();
  });
});
