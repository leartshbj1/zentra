import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountPublicError } from '@/lib/account-security';
import { QuotePreparationError } from './intake-types';
import { QuoteLedgerError } from './ledger-types';
import { ActionEngineError, type StoredQuoteProposal } from './types';
import { captureQuotePlan } from './validation';

const calls = vi.hoisted(() => ({
  session: vi.fn(),
  rate: vi.fn(),
  discover: vi.fn(),
  prepare: vi.fn(),
}));
vi.mock('@/lib/account', () => ({
  requireDeviceSession: calls.session,
  enforceSyncRateLimit: calls.rate,
  accountNoStoreHeaders: () => ({
    'Cache-Control': 'no-store',
    Vary: 'Authorization',
  }),
}));
vi.mock('./device-work-discovery', () => ({
  discoverDeviceSupportQuoteWork: calls.discover,
}));
vi.mock('./device-preparation', () => ({
  prepareDeviceSupportQuote: calls.prepare,
}));
import { handleDeviceQuoteWork } from './device-work-handler';

const origin = 'https://zentra.invalid/private-device-work';
const session = Object.freeze({
  organizationId: 'synthetic-company',
  userId: 'synthetic-user',
  installationId: '00000000-0000-4000-8000-000000000005',
});
const sourceId = 'synthetic-mail';
const discoverInput = { schemaVersion: 1, operation: 'discover' };
const prepareInput = { schemaVersion: 1, operation: 'prepare', sourceId };

// The perimeter uses the actual closed plan/proposal codec and SHA digest.
// Authentication, rate limiting and the two private compositions are mocked;
// these tests do not claim database authorization or provider execution.
function proposal(review = false): StoredQuoteProposal {
  const plan = captureQuotePlan({
    schemaVersion: 1,
    engineVersion: 'action-engine-quote-v1',
    kind: 'prepare_quote_draft',
    organizationId: session.organizationId,
    contextRevision: 'context-v1',
    sourceId,
    sourceRevision: 'mail-v1',
    status: review ? 'needs_review' : 'ready',
    reasons: review ? ['missing_article'] : [],
    customer: review
      ? null
      : {
          kind: 'new',
          name: 'Private customer',
          email: 'private@example.test',
        },
    title: 'Private mail subject',
    currency: 'CHF',
    lines: review
      ? []
      : [
          {
            articleId: 'radiator-a',
            articleRevision: 'article-v1',
            description: 'Private article',
            unit: 'pièce',
            quantityMilli: 3000,
            unitPriceCents: 19901,
            taxRateBp: 810,
            netCents: 59703,
            evidence: 'Private mail body: installer 3 radiateurs',
          },
        ],
    netCents: review ? 0 : 59703,
    confidence: review ? null : 0.99,
    requiresHumanValidation: true,
  });
  return {
    id: 'synthetic-proposal',
    organizationId: session.organizationId,
    plan,
    fingerprint: createHash('sha256')
      .update(JSON.stringify(plan), 'utf8')
      .digest('hex'),
  };
}
function request(
  body: unknown = discoverInput,
  headers: HeadersInit = {},
  url = origin,
): Request {
  const captured = new Headers({
    Authorization: 'Bearer synthetic-device-token',
    'Content-Type': 'application/json',
  });
  new Headers(headers).forEach((value, key) => captured.set(key, value));
  return new Request(url, {
    method: 'POST',
    headers: captured,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
async function failure(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(response.headers.get('Vary')).toBe('Authorization');
  expect(response.headers.has('Retry-After')).toBe(false);
  const body = await response.json();
  expect(body).toEqual({
    schemaVersion: 1,
    state: 'error',
    code,
    message: expect.any(String),
  });
  expect(JSON.stringify(body)).not.toMatch(
    /private|SELECT|Bearer|example\.test|password/,
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  calls.session.mockResolvedValue(session);
  calls.rate.mockResolvedValue(undefined);
  calls.discover.mockResolvedValue({ sourceIds: [], nextCursor: null });
  calls.prepare.mockResolvedValue(proposal());
});
afterEach(() => vi.restoreAllMocks());

describe('private device work handler perimeter', () => {
  it('authenticates and rate-limits before returning default discovery selectors', async () => {
    calls.discover.mockResolvedValue({
      sourceIds: [sourceId],
      nextCursor: null,
    });
    const response = await handleDeviceQuoteWork(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Vary')).toBe('Authorization');
    expect(await response.json()).toEqual({
      schemaVersion: 1,
      state: 'discovered',
      sourceIds: [sourceId],
      nextCursor: null,
    });
    expect(calls.discover).toHaveBeenCalledExactlyOnceWith(
      expect.any(Request),
      {
        limit: 20,
        cursor: null,
      },
    );
    expect(calls.rate).toHaveBeenCalledExactlyOnceWith(
      expect.any(Request),
      'action-engine-device-work',
      session.organizationId + ':' + session.installationId,
      500,
    );
    expect(calls.session.mock.invocationCallOrder[0]).toBeLessThan(
      calls.rate.mock.invocationCallOrder[0],
    );
    expect(calls.rate.mock.invocationCallOrder[0]).toBeLessThan(
      calls.discover.mock.invocationCallOrder[0],
    );
    expect(calls.prepare).not.toHaveBeenCalled();
  });

  it('passes the explicit limit/cursor and preserves a closed next-page response', async () => {
    calls.discover.mockResolvedValue({
      sourceIds: [sourceId],
      nextCursor: 'bmV4dA',
    });
    const response = await handleDeviceQuoteWork(
      request({
        ...discoverInput,
        limit: 1,
        cursor: 'cHJpb3I',
      }),
    );
    expect(response.status).toBe(200);
    expect(calls.discover.mock.calls[0][1]).toEqual({
      limit: 1,
      cursor: 'cHJpb3I',
    });
    expect(await response.json()).toEqual({
      schemaVersion: 1,
      state: 'discovered',
      sourceIds: [sourceId],
      nextCursor: 'bmV4dA',
    });
  });

  it('admits the dedicated 4096-character cursor above the A10 2KiB execution limit', async () => {
    const cursor = 'a'.repeat(4096),
      body = JSON.stringify({ ...discoverInput, limit: 50, cursor });
    expect(new TextEncoder().encode(body).length).toBeGreaterThan(2048);
    const response = await handleDeviceQuoteWork(request(body));
    expect(response.status).toBe(200);
    expect(calls.discover.mock.calls[0][1]).toEqual({ limit: 50, cursor });
  });

  it('returns only the ready summary bound to the authenticated tenant and source', async () => {
    const prepared = proposal();
    calls.prepare.mockResolvedValue(prepared);
    const response = await handleDeviceQuoteWork(request(prepareInput));
    expect(response.status).toBe(200);
    expect(calls.prepare).toHaveBeenCalledExactlyOnceWith(
      expect.any(Request),
      sourceId,
    );
    expect(calls.discover).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({
      schemaVersion: 1,
      state: 'prepared',
      sourceId,
      proposalId: prepared.id,
      fingerprint: prepared.fingerprint,
      disposition: 'ready',
      reasons: [],
      requiresHumanValidation: true,
    });
  });

  it('keeps needs-review reasons without exposing the plan, client, mail or prices', async () => {
    const prepared = proposal(true);
    calls.prepare.mockResolvedValue(prepared);
    const response = await handleDeviceQuoteWork(request(prepareInput));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      schemaVersion: 1,
      state: 'prepared',
      sourceId,
      proposalId: prepared.id,
      fingerprint: prepared.fingerprint,
      disposition: 'needs_review',
      reasons: ['missing_article'],
      requiresHumanValidation: true,
    });
  });

  it.each(['GET', 'DELETE'])(
    'refuses %s before authentication or any work',
    async (method) => {
      const response = await handleDeviceQuoteWork(
        new Request(origin, { method }),
      );
      expect(response.headers.get('Allow')).toBe('POST');
      await failure(response, 405, 'invalid_request');
      expect(calls.session).not.toHaveBeenCalled();
      expect(calls.discover).not.toHaveBeenCalled();
      expect(calls.prepare).not.toHaveBeenCalled();
    },
  );

  it('refuses query-controlled operations before authentication', async () => {
    await failure(
      await handleDeviceQuoteWork(
        request(discoverInput, {}, origin + '?operation=prepare'),
      ),
      400,
      'invalid_request',
    );
    expect(calls.session).not.toHaveBeenCalled();
  });

  it.each(['', 'Basic synthetic'])(
    'does not use a website cookie in place of bearer %s',
    async (authorization) => {
      await failure(
        await handleDeviceQuoteWork(
          request(discoverInput, {
            Authorization: authorization,
            Cookie: 'zentra_session=synthetic-browser-cookie',
          }),
        ),
        401,
        'forbidden',
      );
      expect(calls.session).not.toHaveBeenCalled();
      expect(calls.rate).not.toHaveBeenCalled();
    },
  );

  it('requires JSON content type after admission and before reading/dispatch', async () => {
    await failure(
      await handleDeviceQuoteWork(
        request(discoverInput, { 'Content-Type': 'text/plain' }),
      ),
      415,
      'invalid_request',
    );
    expect(calls.session).toHaveBeenCalledOnce();
    expect(calls.rate).toHaveBeenCalledOnce();
    expect(calls.discover).not.toHaveBeenCalled();
    expect(calls.prepare).not.toHaveBeenCalled();
  });

  it.each([
    { ...discoverInput, actor: 'untrusted' },
    { ...discoverInput, operation: 'execute' },
    { ...discoverInput, schemaVersion: '1' },
    { ...discoverInput, limit: 0 },
    { ...discoverInput, limit: 51 },
    { ...discoverInput, cursor: 'a'.repeat(4097) },
    { ...prepareInput, plan: 'untrusted' },
    { ...prepareInput, sourceId: 'mail😀' },
  ])(
    'refuses a malformed or overprivileged closed selector: %j',
    async (body) => {
      await failure(
        await handleDeviceQuoteWork(request(body)),
        400,
        'invalid_request',
      );
      expect(calls.discover).not.toHaveBeenCalled();
      expect(calls.prepare).not.toHaveBeenCalled();
    },
  );

  it.each([
    '{"schemaVersion":1,"operation":"discover","limit":1,"limit":20}',
    '{"schemaVersion":1,"operation":"prepare","sourceId":"other","source\\u0049d":"synthetic-mail"}',
    '{"schemaVersion":1,"operation":"discover","cursor":{"scope":"other"}}',
    '{"schemaVersion":1,"operation":"discover"}{}',
  ])(
    'rejects ambiguous or non-flat JSON before either composition: %s',
    async (body) => {
      await failure(
        await handleDeviceQuoteWork(request(body)),
        400,
        'invalid_request',
      );
      expect(calls.discover).not.toHaveBeenCalled();
      expect(calls.prepare).not.toHaveBeenCalled();
    },
  );

  it('accepts whitespace, escaped unique keys and a JSON charset parameter', async () => {
    const body =
      ' \n {"schemaVersion":1,"operation":"prepare","source\\u0049d":"synthetic-mail"}\t';
    expect(
      (
        await handleDeviceQuoteWork(
          request(body, { 'Content-Type': 'APPLICATION/JSON; charset=utf-8' }),
        )
      ).status,
    ).toBe(200);
    expect(calls.prepare).toHaveBeenCalledExactlyOnceWith(
      expect.any(Request),
      sourceId,
    );
  });

  it('accepts exactly 8192 UTF-8 bytes without raising the A10 execution limit', async () => {
    const body = JSON.stringify(discoverInput),
      padded = body + ' '.repeat(8192 - body.length);
    expect(new TextEncoder().encode(padded).length).toBe(8192);
    expect((await handleDeviceQuoteWork(request(padded))).status).toBe(200);
    expect(calls.discover).toHaveBeenCalledOnce();
  });

  it('rejects 8193 streamed bytes even when the declared length understates the body', async () => {
    const body = JSON.stringify(discoverInput),
      padded = body + ' '.repeat(8193 - body.length);
    await failure(
      await handleDeviceQuoteWork(request(padded, { 'Content-Length': '100' })),
      413,
      'invalid_request',
    );
    expect(calls.discover).not.toHaveBeenCalled();
  });

  it('counts UTF-8 bytes instead of JavaScript string length', async () => {
    const body = JSON.stringify({ ...discoverInput, cursor: 'é'.repeat(4100) });
    expect(body.length).toBeLessThan(8192);
    await failure(
      await handleDeviceQuoteWork(request(body)),
      413,
      'invalid_request',
    );
    expect(calls.discover).not.toHaveBeenCalled();
  });

  it('refuses excessive declared length without pulling from the stream', async () => {
    const pull = vi.fn(),
      body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
    const req = new Request(origin, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer synthetic',
        'Content-Type': 'application/json',
        'Content-Length': '8193',
      },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    await failure(await handleDeviceQuoteWork(req), 413, 'invalid_request');
    expect(pull).not.toHaveBeenCalled();
    expect(calls.discover).not.toHaveBeenCalled();
  });

  it('rejects malformed UTF-8 rather than repairing the selector', async () => {
    const req = new Request(origin, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer synthetic',
        'Content-Type': 'application/json',
      },
      body: new Uint8Array([0xc3, 0x28]),
    });
    await failure(await handleDeviceQuoteWork(req), 400, 'invalid_request');
    expect(calls.discover).not.toHaveBeenCalled();
  });

  it.each([
    [401, 401, 'forbidden'],
    [402, 403, 'forbidden'],
    [403, 403, 'forbidden'],
    [429, 429, 'service_unavailable'],
    [500, 503, 'service_unavailable'],
  ] as const)(
    'bounds authentication failure %s without rate/body/business work',
    async (authStatus, status, code) => {
      calls.session.mockRejectedValue(
        new AccountPublicError('private account facts', authStatus),
      );
      await failure(await handleDeviceQuoteWork(request()), status, code);
      expect(calls.session).toHaveBeenCalledOnce();
      expect(calls.rate).not.toHaveBeenCalled();
      expect(calls.discover).not.toHaveBeenCalled();
      expect(calls.prepare).not.toHaveBeenCalled();
    },
  );

  it('does not dispatch or retry after device rate rejection', async () => {
    calls.rate.mockRejectedValue(
      new AccountPublicError('private quota facts', 429),
    );
    await failure(
      await handleDeviceQuoteWork(request(prepareInput)),
      429,
      'service_unavailable',
    );
    expect(calls.rate).toHaveBeenCalledOnce();
    expect(calls.prepare).not.toHaveBeenCalled();
    expect(calls.discover).not.toHaveBeenCalled();
  });

  it('detaches bearer and content-type headers before the authentication await', async () => {
    const req = request(prepareInput);
    calls.session.mockImplementation(async (captured: Request) => {
      req.headers.set('Authorization', 'Bearer other-device');
      req.headers.set('Content-Type', 'text/plain');
      expect(captured.headers.get('Authorization')).toBe(
        'Bearer synthetic-device-token',
      );
      return session;
    });
    expect((await handleDeviceQuoteWork(req)).status).toBe(200);
    for (const call of [
      calls.rate.mock.calls[0],
      calls.prepare.mock.calls[0],
    ]) {
      expect((call[0] as Request).headers.get('Authorization')).toBe(
        'Bearer synthetic-device-token',
      );
      expect((call[0] as Request).headers.get('Content-Type')).toBe(
        'application/json',
      );
    }
  });

  it.each([
    [new QuotePreparationError('held'), 409, 'busy'],
    [new QuotePreparationError('uncertain'), 409, 'uncertain'],
    [new QuotePreparationError('forbidden'), 403, 'forbidden'],
    [new QuotePreparationError('conflict'), 409, 'review_required'],
    [
      new QuotePreparationError('service_unavailable'),
      503,
      'service_unavailable',
    ],
    [new ActionEngineError('forbidden'), 403, 'forbidden'],
    [new ActionEngineError('stale_plan'), 409, 'stale_plan'],
    [new QuoteLedgerError('invalid_record'), 409, 'review_required'],
    [new QuoteLedgerError('service_unavailable'), 503, 'service_unavailable'],
    [
      new Error('Bearer private-password SELECT user_email'),
      503,
      'service_unavailable',
    ],
  ] as const)(
    'bounds preparation failure %s and never retries the composition',
    async (reason, status, code) => {
      calls.prepare.mockRejectedValue(reason);
      await failure(
        await handleDeviceQuoteWork(request(prepareInput)),
        status,
        code,
      );
      expect(calls.prepare).toHaveBeenCalledOnce();
      expect(calls.discover).not.toHaveBeenCalled();
    },
  );

  it('rejects malformed discovery results instead of claiming an empty queue', async () => {
    for (const result of [
      { sourceIds: [sourceId, sourceId], nextCursor: null },
      { sourceIds: [], nextCursor: 'bmV4dA' },
      { sourceIds: [], nextCursor: null, plan: 'private' },
    ]) {
      calls.discover.mockResolvedValue(result);
      await failure(
        await handleDeviceQuoteWork(request()),
        503,
        'service_unavailable',
      );
    }
  });

  it('refuses wrong-tenant, wrong-source and invalid-SHA internal proposals', async () => {
    const valid = proposal();
    for (const result of [
      { ...valid, organizationId: 'another-company' },
      { ...valid, plan: { ...valid.plan, sourceId: 'another-mail' } },
      { ...valid, fingerprint: 'a'.repeat(64) },
    ]) {
      calls.prepare.mockResolvedValue(result);
      await failure(
        await handleDeviceQuoteWork(request(prepareInput)),
        503,
        'service_unavailable',
      );
    }
  });

  it('does not encode extended or unsafe internal plans as a harmless summary', async () => {
    const valid = proposal();
    for (const result of [
      { ...valid, privateMail: 'private' },
      { ...valid, plan: { ...valid.plan, requiresHumanValidation: false } },
      { ...valid, plan: { ...valid.plan, reasons: ['unknown_reason'] } },
    ]) {
      calls.prepare.mockResolvedValue(result);
      await failure(
        await handleDeviceQuoteWork(request(prepareInput)),
        503,
        'service_unavailable',
      );
    }
  });

  it('rejects accessor-based results without executing the getter', async () => {
    const getter = vi.fn(() => [sourceId]);
    const raw = Object.defineProperty({ nextCursor: null }, 'sourceIds', {
      enumerable: true,
      get: getter,
    });
    calls.discover.mockResolvedValue(raw);
    await failure(
      await handleDeviceQuoteWork(request()),
      503,
      'service_unavailable',
    );
    expect(getter).not.toHaveBeenCalled();
  });
});
