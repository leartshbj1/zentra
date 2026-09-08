import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DeviceSessionContext } from './account';
const mocks = vi.hoisted(() => ({
  db: vi.fn(),
  session: vi.fn(),
  rate: vi.fn(),
}));
vi.mock('@/lib/runtime', () => ({ database: mocks.db }));
vi.mock('@/lib/account', async (original) => ({
  ...(await original<typeof import('./account')>()),
  requireDeviceSession: mocks.session,
  enforceAccountRateLimit: mocks.rate,
}));
import { POST } from '../app/api/sync/numbers/route';
import { AccountPublicError } from './account-security';
import {
  MAX_DOCUMENT_NUMBER,
  reserveDocumentNumbers,
  numberReservationRequest,
} from './document-number-reservations';

let db: DatabaseSync;
const id = 'ac513271-44d4-47e5-8830-2bb40cd5dced';
const base = {
  request_id: id,
  prefix: 'F',
  year: 2026,
  minimum: 1,
  count: 100,
};
const owner: DeviceSessionContext = {
  organizationId: 'org_first',
  organizationName: 'First',
  installationId: 'pc_first',
  userId: 'owner',
  role: 'owner',
  sessionId: 'session',
  subscriptionId: 'sub',
  entitlementValidUntil: 2000000000,
};
function prepared(sql: string) {
  const statement = db.prepare(sql);
  let args: (string | number | null)[] = [];
  const result = {
    bind: (...values: typeof args) => {
      args = values;
      return result;
    },
    run: async () => ({
      meta: { changes: Number(statement.run(...args).changes) },
    }),
    first: async () => statement.get(...args) ?? null,
  };
  return result;
}
beforeEach(() => {
  vi.clearAllMocks();
  db = new DatabaseSync(':memory:');
  const folder = new URL('../drizzle/', import.meta.url);
  for (const file of readdirSync(folder)
    .filter((n) => n.endsWith('.sql'))
    .sort())
    db.exec(readFileSync(new URL(file, folder), 'utf8'));
  db.exec(
    "INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at) VALUES('sub','cus','price','active',2000000000,0,1),('sub2','cus2','price','active',2000000000,0,1); INSERT INTO organizations VALUES('org_first','First','sub','owner',1,1),('org_other','Other','sub2','other',1,1)",
  );
  db.exec(
    "INSERT INTO business_sync_spaces VALUES('org_first','generation','bootstrap-first','ready',1,'owner','2026-09-08'),('org_other','other-generation','bootstrap-other','ready',1,'other','2026-09-08')",
  );
  mocks.db.mockReturnValue({ prepare: prepared });
  mocks.session.mockResolvedValue(owner);
});
afterEach(() => db.close());
function request(body: Record<string, unknown> = base) {
  return new Request('https://zentra.test/api/sync/numbers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
it('reserves disjoint ranges atomically for competing devices using the same numbering prefix', async () => {
  const responses = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      reserveDocumentNumbers(
        { ...owner, installationId: `pc_${i}` },
        { ...base, request_id: crypto.randomUUID() },
      ),
    ),
  );
  const ranges = responses.sort((a, b) => a.start_value - b.start_value);
  for (let i = 0; i < ranges.length; i++)
    expect([ranges[i].start_value, ranges[i].end_value]).toEqual([
      i * 100 + 1,
      (i + 1) * 100,
    ]);
  expect(
    new Set(
      ranges.flatMap((r) =>
        Array.from({ length: 100 }, (_, i) => r.start_value + i),
      ),
    ).size,
  ).toBe(2000);
});
it('replays the same request without consuming more numbers after a lost acknowledgement', async () => {
  const all = await Promise.all(
    Array.from({ length: 5 }, () => reserveDocumentNumbers(owner, base)),
  );
  expect(all.every((v) => v.start_value === 1 && v.end_value === 100)).toBe(
    true,
  );
  const next = await reserveDocumentNumbers(owner, {
    ...base,
    request_id: crypto.randomUUID(),
  });
  expect(next.start_value).toBe(101);
});
it('never recycles a revoked device range and respects the imported historical minimum', async () => {
  await reserveDocumentNumbers(owner, { ...base, minimum: 1250 });
  db.exec("UPDATE subscriptions SET status='canceled'");
  const next = await reserveDocumentNumbers(
    { ...owner, installationId: 'replacement' },
    { ...base, request_id: crypto.randomUUID() },
  );
  expect([next.start_value, next.end_value]).toEqual([1350, 1449]);
  const raised = await reserveDocumentNumbers(owner, {
    ...base,
    request_id: crypto.randomUUID(),
    minimum: 8000,
  });
  expect(raised.start_value).toBe(8000);
});
it.each([{ prefix: 'D' }, { year: 2027 }, { minimum: 2 }, { count: 50 }])(
  'rejects a request identifier reused with a changed input %j',
  async (patch) => {
    await reserveDocumentNumbers(owner, base);
    await expect(
      reserveDocumentNumbers(owner, { ...base, ...patch }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      db
        .prepare('SELECT COUNT(*) AS count FROM document_number_reservations')
        .get()!.count,
    ).toBe(1);
  },
);
it('binds each reservation to its company and installation and separates years and prefixes', async () => {
  await reserveDocumentNumbers(owner, base);
  await expect(
    reserveDocumentNumbers({ ...owner, installationId: 'pc_other' }, base),
  ).rejects.toMatchObject({ status: 409 });
  const otherCompany = await reserveDocumentNumbers(
    { ...owner, organizationId: 'org_other' },
    base,
  );
  expect(otherCompany.start_value).toBe(1);
  for (const patch of [{ prefix: 'D' }, { year: 2027 }]) {
    const separate = await reserveDocumentNumbers(owner, {
      ...base,
      ...patch,
      request_id: crypto.randomUUID(),
    });
    expect(separate.start_value).toBe(1);
  }
});
it('normalizes existing prefix syntax and bounds requests before writing', async () => {
  expect(numberReservationRequest({ ...base, prefix: '  f-ab  ' }).prefix).toBe(
    'F-AB',
  );
  for (const patch of [
    { prefix: '../F' },
    { prefix: '_F' },
    { count: 0 },
    { count: 1001 },
    { minimum: 0 },
    { minimum: MAX_DOCUMENT_NUMBER },
    { year: 2026.5 },
    { year: '2026' },
    { request_id: 'invalid' },
  ]) {
    expect((await POST(request({ ...base, ...patch }))).status).toBe(400);
  }
  expect(
    db
      .prepare('SELECT COUNT(*) AS count FROM document_number_reservations')
      .get()!.count,
  ).toBe(0);
});
it('refuses exhausted ranges without an integer wrap or a partial reservation', async () => {
  await reserveDocumentNumbers(owner, {
    ...base,
    minimum: MAX_DOCUMENT_NUMBER - 99,
  });
  await expect(
    reserveDocumentNumbers(owner, { ...base, request_id: crypto.randomUUID() }),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    db
      .prepare('SELECT COUNT(*) AS count FROM document_number_reservations')
      .get()!.count,
  ).toBe(1);
});
it('uses the authenticated company instead of caller identifiers and refuses restricted or revoked access', async () => {
  const response = await POST(
    request({
      ...base,
      organization_id: 'org_other',
      installation_id: 'foreign',
    }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    organization_id: 'org_first',
    installation_id: 'pc_first',
  });
  expect(response.headers.get('Cache-Control')).toContain('no-store');
  mocks.session.mockResolvedValue({ ...owner, role: 'read_only' });
  expect((await POST(request())).status).toBe(403);
  mocks.session.mockRejectedValue(new AccountPublicError('revoked', 401));
  expect((await POST(request())).status).toBe(401);
  mocks.session.mockRejectedValue(new AccountPublicError('expired', 402));
  expect((await POST(request())).status).toBe(402);
});

it('never allocates a number before the authoritative company bootstrap is published', async () => {
  db.exec("DELETE FROM business_sync_spaces WHERE organization_id='org_first'");
  const missing = await POST(request());
  expect(missing.status).toBe(409);
  expect(await missing.json()).toMatchObject({
    error: expect.stringContaining('historique'),
  });
  db.exec(
    "INSERT INTO business_sync_spaces VALUES('org_first','generation','bootstrap','initializing',0,'owner','2026-09-08')",
  );
  expect((await POST(request())).status).toBe(409);
  db.exec(
    "UPDATE business_sync_spaces SET state='ready' WHERE organization_id='org_first'",
  );
  expect((await POST(request())).status).toBe(409);
  expect(
    db
      .prepare('SELECT COUNT(*) AS count FROM document_number_reservations')
      .get()!.count,
  ).toBe(0);
});

it('keeps historical reservations but refuses to replay them while the shared history is unavailable', async () => {
  await reserveDocumentNumbers(owner, base);
  db.exec(
    "UPDATE business_sync_spaces SET state='initializing' WHERE organization_id='org_first'",
  );
  await expect(reserveDocumentNumbers(owner, base)).rejects.toMatchObject({
    status: 409,
  });
  await expect(
    reserveDocumentNumbers(owner, { ...base, request_id: crypto.randomUUID() }),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    db
      .prepare('SELECT COUNT(*) AS count FROM document_number_reservations')
      .get()!.count,
  ).toBe(1);
});
