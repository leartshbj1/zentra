import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountPublicError } from '@/lib/account-security';
import { QuoteLedgerError } from './ledger-types';
import { ActionEngineError } from './types';
import { CanonicalQuoteError } from './canonical-quote';
const calls = vi.hoisted(() => ({
  session: vi.fn(),
  rate: vi.fn(),
  reserve: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock('@/lib/account', () => ({
  requireDeviceSession: calls.session,
  enforceSyncRateLimit: calls.rate,
  accountNoStoreHeaders: () => ({
    'Cache-Control': 'no-store',
    Vary: 'Authorization',
  }),
}));
vi.mock('./device-reservation', () => ({
  reserveDeviceSupportQuote: calls.reserve,
}));
vi.mock('./device-confirmation', () => ({
  confirmDeviceSupportQuote: calls.confirm,
}));
import { handleDeviceQuoteExecution } from './device-execution-handler';

const input = {
  schemaVersion: 1,
  operation: 'reserve',
  sourceId: 'synthetic-mail',
  proposalId: 'synthetic-proposal',
};
const reservationId = '00000000-0000-4000-8000-000000000001';
const publicationSnapshotId = '00000000-0000-4000-8000-000000000002';
const receipt = Object.freeze({
  organizationId: 'synthetic-company',
  proposalId: input.proposalId,
  fingerprint: 'a'.repeat(64),
  customerId: '00000000-0000-4000-8000-000000000003',
  quoteId: '00000000-0000-4000-8000-000000000004',
  quoteNumber: null,
  status: 'draft',
  requiresHumanValidation: true,
});
function request(
  body: unknown = input,
  headers: HeadersInit = {},
  url = 'https://zentra.invalid/private-device-execution',
) {
  const capturedHeaders = new Headers({
    Authorization: 'Bearer synthetic-device-token',
    'Content-Type': 'application/json',
  });
  new Headers(headers).forEach((value, key) => capturedHeaders.set(key, value));
  return new Request(url, {
    method: 'POST',
    headers: capturedHeaders,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  calls.session.mockResolvedValue({
    organizationId: 'synthetic-company',
    userId: 'synthetic-user',
    installationId: '00000000-0000-4000-8000-000000000005',
  });
  calls.rate.mockResolvedValue(undefined);
  calls.reserve.mockResolvedValue({
    state: 'held',
    proposalId: input.proposalId,
  });
  calls.confirm.mockResolvedValue(receipt);
});
afterEach(() => vi.restoreAllMocks());
async function error(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(await response.json()).toMatchObject({
    schemaVersion: 1,
    state: 'error',
    code,
  });
}

describe('unexposed real device execution handler perimeter', () => {
  it('authenticates the device, rate-limits, then passes only captured selectors to A8', async () => {
    const req = request();
    const response = await handleDeviceQuoteExecution(req);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      schemaVersion: 1,
      state: 'held',
      proposalId: input.proposalId,
    });
    expect(calls.reserve).toHaveBeenCalledExactlyOnceWith(expect.any(Request), {
      sourceId: input.sourceId,
      proposalId: input.proposalId,
    });
    expect(calls.reserve.mock.calls[0][0].headers.get('Authorization')).toBe(
      'Bearer synthetic-device-token',
    );
    expect(calls.rate).toHaveBeenCalledExactlyOnceWith(
      expect.any(Request),
      'action-engine-device-execution',
      'synthetic-company:00000000-0000-4000-8000-000000000005',
      500,
    );
    expect(calls.session.mock.invocationCallOrder[0]).toBeLessThan(
      calls.rate.mock.invocationCallOrder[0],
    );
    expect(calls.rate.mock.invocationCallOrder[0]).toBeLessThan(
      calls.reserve.mock.invocationCallOrder[0],
    );
    expect(calls.confirm).not.toHaveBeenCalled();
  });
  it('returns an A7 receipt bound to the exact four captured selectors', async () => {
    const body = {
      ...input,
      operation: 'confirm',
      reservationId,
      publicationSnapshotId,
    };
    const response = await handleDeviceQuoteExecution(request(body));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      schemaVersion: 1,
      state: 'confirmed',
      sourceId: input.sourceId,
      proposalId: input.proposalId,
      reservationId,
      publicationSnapshotId,
      receipt,
    });
    expect(calls.confirm).toHaveBeenCalledExactlyOnceWith(expect.any(Request), {
      sourceId: input.sourceId,
      proposalId: input.proposalId,
      reservationId,
      publicationSnapshotId,
    });
    expect(calls.reserve).not.toHaveBeenCalled();
  });
  it('never authorizes from a website cookie without a device bearer', async () => {
    await error(
      await handleDeviceQuoteExecution(
        request(input, {
          Authorization: '',
          Cookie: 'zentra_session=synthetic-browser-cookie',
        }),
      ),
      401,
      'forbidden',
    );
    expect(calls.session).not.toHaveBeenCalled();
  });
  it.each(['GET', 'PUT', 'DELETE'])(
    'rejects %s without reading/authenticating',
    async (method) => {
      const response = await handleDeviceQuoteExecution(
        new Request('https://zentra.invalid/private-device-execution', {
          method,
        }),
      );
      expect(response.headers.get('Allow')).toBe('POST');
      await error(response, 405, 'invalid_request');
      expect(calls.session).not.toHaveBeenCalled();
    },
  );
  it('refuses query-controlled operations', async () => {
    await error(
      await handleDeviceQuoteExecution(
        request(
          input,
          {},
          'https://zentra.invalid/private-device-execution?tenant=other',
        ),
      ),
      400,
      'invalid_request',
    );
    expect(calls.session).not.toHaveBeenCalled();
  });
  it.each(['text/plain', 'application/x-www-form-urlencoded', ''])(
    'rejects content type %s',
    async (type) => {
      await error(
        await handleDeviceQuoteExecution(
          request(input, { 'Content-Type': type }),
        ),
        415,
        'invalid_request',
      );
      expect(calls.reserve).not.toHaveBeenCalled();
    },
  );
  it.each([
    '',
    'null',
    '[]',
    '{}',
    '{"schemaVersion":1,}',
    '{"schemaVersion":01}',
    '{"schemaVersion":1}{}',
    JSON.stringify({ ...input, actor: { organizationId: 'another-company' } }),
    JSON.stringify({ ...input, expectedWorkspaceScope: 'untrusted' }),
    JSON.stringify({ ...input, price: 1 }),
    JSON.stringify({ ...input, operation: 'issue' }),
    JSON.stringify({ ...input, operation: 'confirm' }),
    JSON.stringify({ ...input, sourceId: ['synthetic-mail'] }),
    JSON.stringify({ ...input, schemaVersion: '1' }),
    JSON.stringify({ ...input, sourceId: 'x'.repeat(161) }),
    '{"schemaVersion":1,"operation":"reserve","sourceId":"hidden","sourceId":"synthetic-mail","proposalId":"synthetic-proposal"}',
    '{"schemaVersion":1,"operation":"reserve","sourceId":"hidden","source\\u0049d":"synthetic-mail","proposalId":"synthetic-proposal"}',
    '{"schemaVersion":1,"schemaVersion":1,"operation":"reserve","sourceId":"synthetic-mail","proposalId":"synthetic-proposal"}',
  ])(
    'rejects invalid/ambiguous request without calling either business composition: %s',
    async (body) => {
      await error(
        await handleDeviceQuoteExecution(request(body)),
        400,
        'invalid_request',
      );
      expect(calls.reserve).not.toHaveBeenCalled();
      expect(calls.confirm).not.toHaveBeenCalled();
    },
  );
  it('accepts whitespace and escaped, unique JSON selector keys', async () => {
    const body =
      ' \n { "schemaVersion": 1, "operation": "reserve", "source\\u0049d":"synthetic-mail", "proposalId":"synthetic-proposal" } \t ';
    const response = await handleDeviceQuoteExecution(request(body));
    expect(response.status).toBe(200);
    expect(calls.reserve.mock.calls[0][1]).toEqual({
      sourceId: input.sourceId,
      proposalId: input.proposalId,
    });
  });
  it('counts streamed UTF-8 bytes, not character count', async () => {
    await error(
      await handleDeviceQuoteExecution(
        request({ ...input, sourceId: 'é'.repeat(1100) }),
      ),
      413,
      'invalid_request',
    );
    expect(calls.reserve).not.toHaveBeenCalled();
  });
  it('rejects an excessive declared length without reading the body', async () => {
    await error(
      await handleDeviceQuoteExecution(
        request(input, { 'Content-Length': '2049' }),
      ),
      413,
      'invalid_request',
    );
    expect(calls.reserve).not.toHaveBeenCalled();
  });
  it('rejects malformed UTF-8', async () => {
    const req = new Request('https://zentra.invalid/private-device-execution', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer synthetic',
        'Content-Type': 'application/json',
      },
      body: new Uint8Array([0xc3, 0x28]),
    });
    await error(await handleDeviceQuoteExecution(req), 400, 'invalid_request');
  });
  it.each([
    [new AccountPublicError('private account facts', 403), 403, 'forbidden'],
    [
      new AccountPublicError('private subscription facts', 402),
      403,
      'forbidden',
    ],
    [
      new AccountPublicError('private quota facts', 429),
      429,
      'service_unavailable',
    ],
    [new ActionEngineError('forbidden'), 403, 'forbidden'],
    [new ActionEngineError('stale_plan'), 409, 'stale_plan'],
    [new QuoteLedgerError('conflict'), 409, 'review_required'],
    [new QuoteLedgerError('forbidden'), 403, 'forbidden'],
    [new CanonicalQuoteError('invalid_publication'), 409, 'review_required'],
    [new QuoteLedgerError('service_unavailable'), 503, 'service_unavailable'],
    [
      new Error('Bearer private-secret SELECT user_email database detail'),
      503,
      'service_unavailable',
    ],
  ] as const)(
    'returns bounded error %s without secrets',
    async (reason, status, code) => {
      calls.reserve.mockRejectedValue(reason);
      const response = await handleDeviceQuoteExecution(request());
      const body = await response.clone().text();
      expect(body).not.toMatch(/private|SELECT|Bearer|user_email/);
      await error(response, status, code);
    },
  );
  it('does not read or reserve after failed authentication', async () => {
    calls.session.mockRejectedValue(new AccountPublicError('expired', 401));
    await error(await handleDeviceQuoteExecution(request()), 401, 'forbidden');
    expect(calls.rate).not.toHaveBeenCalled();
    expect(calls.reserve).not.toHaveBeenCalled();
  });
  it('does not retry or reserve when the device subscription has expired', async () => {
    calls.session.mockRejectedValue(
      new AccountPublicError('expired subscription', 402),
    );
    const response = await handleDeviceQuoteExecution(request());
    await error(response, 403, 'forbidden');
    expect(response.headers.has('Retry-After')).toBe(false);
    expect(calls.rate).not.toHaveBeenCalled();
    expect(calls.reserve).not.toHaveBeenCalled();
    expect(calls.confirm).not.toHaveBeenCalled();
  });
  it('never claims a missing creation when confirmation fails after local work', async () => {
    calls.confirm.mockRejectedValue(new CanonicalQuoteError('review_required'));
    const response = await handleDeviceQuoteExecution(
      request({
        ...input,
        operation: 'confirm',
        reservationId,
        publicationSnapshotId,
      }),
    );
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.message).not.toContain('Aucun nouveau devis');
    expect(body.code).toBe('review_required');
  });
});
