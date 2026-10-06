import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/runtime', () => ({ database: vi.fn(), runtimeValue: () => '' }));
import { runPostFinanceReconciliation } from './postfinance-reconciliation-route';
import { POST } from '@/app/api/payments/postfinance/reconcile/route';
const token = 'synthetic_scheduler_token_'.padEnd(43, 'x');
function dependencies(patch: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = {
    POSTFINANCE_RECONCILIATION_ENABLED: 'true',
    POSTFINANCE_RECONCILIATION_TOKEN: token,
    POSTFINANCE_WEBHOOKS_ENABLED: 'true',
    POSTFINANCE_API_ORIGIN: 'https://checkout.postfinance.ch',
    POSTFINANCE_APPLICATION_USER_ID: '512',
    POSTFINANCE_AUTHENTICATION_KEY_BASE64: btoa(
      String.fromCharCode(...new Uint8Array(32).fill(7)),
    ),
    POSTFINANCE_SPACE_ID: '405',
    POSTFINANCE_WEBHOOK_LISTENERS_JSON: JSON.stringify([
      { id: 10, entityId: 20, technicalName: 'Transaction' },
    ]),
    POSTFINANCE_RECONCILIATION_KINDS_JSON: JSON.stringify([
      { listenerId: 10, kind: 'transaction' },
    ]),
    ...patch,
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    throw new Error('No merchant request in route gate test.');
  });
  const database = vi.fn(
    () =>
      ({
        batch: async () => {
          throw Error(
            'Guard-only fixture must never execute a provisioning batch.',
          );
        },
        prepare: () => {
          const statement = {
            bind: () => statement,
            run: async () => ({ meta: { changes: 0 } }),
            first: async () => null,
          };
          return statement;
        },
      }) as unknown as Pick<D1Database, 'prepare' | 'batch'>,
  );
  return { read: (key: string) => env[key] ?? '', fetch, database };
}
function request(
  authorization = `Bearer ${token}`,
  options: { body?: string; suffix?: string; method?: string } = {},
) {
  return new Request(
    'https://zentra.example.test/api/payments/postfinance/reconcile' +
      (options.suffix ?? ''),
    {
      method: options.method ?? 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      ...(options.body === undefined ? {} : { body: options.body }),
    },
  );
}
beforeEach(() => vi.restoreAllMocks());
describe('private, independently disabled PostFinance worker route', () => {
  it('keeps the real route disabled with absent server flags', async () => {
    expect((await POST(request())).status).toBe(503);
  });
  it.each(['', 'false', 'TRUE', '1'])(
    'does not accept request flags when server flag is %s',
    async (value) => {
      const deps = dependencies({ POSTFINANCE_RECONCILIATION_ENABLED: value });
      const response = await runPostFinanceReconciliation(request(), deps);
      expect(response.status).toBe(503);
      expect(deps.database).not.toHaveBeenCalled();
      expect(deps.fetch).not.toHaveBeenCalled();
    },
  );
  it.each([
    '',
    `Bearer ${'z'.repeat(43)}`,
    'Basic abc',
    `Bearer ${'z'.repeat(200)}`,
  ])('rejects a missing or wrong scheduler secret', async (auth) => {
    const deps = dependencies();
    const response = await runPostFinanceReconciliation(request(auth), deps);
    expect(response.status).toBe(401);
    expect(deps.database).not.toHaveBeenCalled();
    expect(deps.fetch).not.toHaveBeenCalled();
  });
  it.each([
    { POSTFINANCE_RECONCILIATION_TOKEN: '' },
    { POSTFINANCE_WEBHOOKS_ENABLED: 'false' },
    { POSTFINANCE_RECONCILIATION_KINDS_JSON: '[]' },
    {
      POSTFINANCE_RECONCILIATION_KINDS_JSON: JSON.stringify([
        { listenerId: 11, kind: 'transaction' },
      ]),
    },
    {
      POSTFINANCE_RECONCILIATION_KINDS_JSON: JSON.stringify([
        { listenerId: 10, kind: 'transaction', enabled: true },
      ]),
    },
    {
      POSTFINANCE_RECONCILIATION_KINDS_JSON: JSON.stringify([
        { listenerId: 10, kind: 'unapproved' },
      ]),
    },
  ])('fails closed for invalid server configuration', async (patch) => {
    const deps = dependencies(patch);
    const response = await runPostFinanceReconciliation(request(), deps);
    expect([401, 503]).toContain(response.status);
    expect(deps.database).not.toHaveBeenCalled();
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain(token);
  });
  it.each([undefined, '{}'])(
    'returns honest idle counters with scheduler envelope %s and no merchant calls',
    async (body) => {
      const deps = dependencies();
      const response = await runPostFinanceReconciliation(
        request(undefined, { body }),
        deps,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toContain('no-store');
      expect(await response.json()).toEqual({
        state: 'processed',
        claimed: 0,
        completed: 0,
        waiting: 0,
        lost: 0,
      });
      expect(deps.database).toHaveBeenCalledOnce();
      expect(deps.fetch).not.toHaveBeenCalled();
    },
  );
  it.each([
    { body: '{"enabled":true,"maximumJobs":4}' },
    { suffix: '?enabled=true' },
    { body: '[]' },
    { body: ' '.repeat(65) + '{}' },
    { method: 'GET' },
  ])(
    'rejects caller-controlled work before database and provider %j',
    async (options) => {
      const deps = dependencies();
      const response = await runPostFinanceReconciliation(
        request(undefined, options),
        deps,
      );
      expect(response.status).toBe(400);
      expect(deps.database).not.toHaveBeenCalled();
      expect(deps.fetch).not.toHaveBeenCalled();
    },
  );
});
