import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ database: vi.fn() }));
vi.mock('./runtime', () => ({ database: mocks.database }));
import { enforcePasswordRecoveryRateLimit } from './password-recovery-rate-limit';
import { AccountPublicError } from './account-security';
import { authJsonError } from './supabase-auth-http';

let db: DatabaseSync;
const start = Date.parse('2026-09-20T02:28:00Z');
const request = (address = '192.0.2.1') =>
  new Request('https://zentra.example/api/auth/mot-de-passe', {
    headers: { 'CF-Connecting-IP': address },
  });
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(start);
  db = new DatabaseSync(':memory:');
  db.exec(
    readFileSync(
      new URL('../drizzle/0000_sweet_owl.sql', import.meta.url),
      'utf8',
    ),
  );
  mocks.database.mockReturnValue({
    prepare: (sql: string) => ({
      bind: (...values: SQLInputValue[]) => ({
        first: async () => db.prepare(sql).get(...values) ?? null,
      }),
    }),
  });
});
afterEach(() => {
  db.close();
  vi.useRealTimers();
});

it('accepts five requests across clock boundaries, blocks the sixth for 30 minutes, then reopens', async () => {
  for (let n = 0; n < 5; n++) {
    vi.setSystemTime(start + n * 60_000);
    await expect(
      enforcePasswordRecoveryRateLimit(request(), 'owner@example.test'),
    ).resolves.toBeUndefined();
  }
  const sixth = await enforcePasswordRecoveryRateLimit(
    request(),
    'owner@example.test',
  ).catch((error) => error as AccountPublicError);
  expect(sixth).toMatchObject({ status: 429, retryAfterSeconds: 1800 });
  const response = authJsonError(sixth);
  expect(response.status).toBe(429);
  expect(response.headers.get('Retry-After')).toBe('1800');
  expect(await response.json()).toMatchObject({
    retryAfterSeconds: 1800,
    error: expect.stringContaining('5 demandes'),
  });
  vi.setSystemTime(start + 33 * 60_000);
  await expect(
    enforcePasswordRecoveryRateLimit(request(), 'owner@example.test'),
  ).rejects.toMatchObject({ retryAfterSeconds: 60 });
  vi.setSystemTime(start + 34 * 60_000);
  await expect(
    enforcePasswordRecoveryRateLimit(request(), 'owner@example.test'),
  ).resolves.toBeUndefined();
});

it('never extends the cooldown when a user clicks again and rejects bursts atomically', async () => {
  const burst = await Promise.allSettled(
    Array.from({ length: 8 }, () =>
      enforcePasswordRecoveryRateLimit(request(), 'owner@example.test'),
    ),
  );
  expect(burst.filter((result) => result.status === 'fulfilled')).toHaveLength(
    5,
  );
  expect(burst.filter((result) => result.status === 'rejected')).toHaveLength(
    3,
  );
  vi.setSystemTime(start + 1799_000);
  await expect(
    enforcePasswordRecoveryRateLimit(request(), 'owner@example.test'),
  ).rejects.toMatchObject({ retryAfterSeconds: 1 });
  vi.setSystemTime(start + 1800_000);
  await expect(
    enforcePasswordRecoveryRateLimit(request(), 'owner@example.test'),
  ).resolves.toBeUndefined();
});

it('normalizes email and keeps its quota across devices while isolating other accounts', async () => {
  for (let n = 0; n < 5; n++)
    await enforcePasswordRecoveryRateLimit(request(), ' OWNER@example.test ');
  await expect(
    enforcePasswordRecoveryRateLimit(
      request('192.0.2.2'),
      'owner@example.test',
    ),
  ).rejects.toMatchObject({ status: 429 });
  await expect(
    enforcePasswordRecoveryRateLimit(request(), 'other@example.test'),
  ).resolves.toBeUndefined();
  const rows = db.prepare('SELECT rate_key FROM checkout_rate_limits').all();
  expect(JSON.stringify(rows)).not.toContain('owner@example.test');
});

it('resets an unused allowance after 30 minutes and caps requests across many emails', async () => {
  await enforcePasswordRecoveryRateLimit(request(), 'owner@example.test');
  vi.setSystemTime(start + 1800_000);
  for (let n = 0; n < 5; n++)
    await expect(
      enforcePasswordRecoveryRateLimit(request(), 'owner@example.test'),
    ).resolves.toBeUndefined();
  for (let n = 0; n < 15; n++)
    await enforcePasswordRecoveryRateLimit(
      request(),
      `person${n}@example.test`,
    );
  await expect(
    enforcePasswordRecoveryRateLimit(request(), 'extra@example.test'),
  ).rejects.toMatchObject({
    status: 429,
    message: expect.stringContaining('cette connexion'),
  });
});
