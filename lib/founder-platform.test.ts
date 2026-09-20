import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { generateKeyPairSync, sign } from 'node:crypto';
const mocks = vi.hoisted(() => ({
  db: null as unknown,
  env: {} as Record<string, string>,
  verify: vi.fn(),
  decide: vi.fn(),
}));
vi.mock('@/lib/runtime', () => ({
  database: () => mocks.db,
  runtimeValue: (key: string) => mocks.env[key] || '',
}));
vi.mock('@/lib/support/jev', () => ({ verifyPlatformApiKey: mocks.verify }));
vi.mock('@/lib/automation/provider', () => ({
  JevDecisionProvider: class {
    decide = mocks.decide;
  },
}));
import { POST } from '../app/api/founder/platform/route';
import { PLATFORM_DOMAIN, platformState } from './founder-platform';
import { decisionApiKey } from './automation/config';
import { SupportError } from './support/types';
const keys = generateKeyPairSync('ed25519');
let sql: DatabaseSync;
function prepared(query: string) {
  let args: SQLInputValue[] = [];
  const p = {
    bind: (...v: SQLInputValue[]) => {
      args = v;
      return p;
    },
    first: async () => sql.prepare(query).get(...args) || null,
    all: async () => ({ results: sql.prepare(query).all(...args) }),
    run: async () => ({
      meta: { changes: Number(sql.prepare(query).run(...args).changes) },
    }),
  };
  return p;
}
beforeEach(() => {
  vi.resetAllMocks();
  sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  const dir = new URL('../drizzle/', import.meta.url);
  for (const f of readdirSync(dir)
    .filter((n) => n.endsWith('.sql'))
    .sort())
    sql.exec(readFileSync(new URL(f, dir), 'utf8'));
  mocks.db = {
    prepare: prepared,
    batch: async (statements: ReturnType<typeof prepared>[]) => {
      sql.exec('BEGIN');
      try {
        const results = [];
        for (const s of statements) results.push(await s.run());
        sql.exec('COMMIT');
        return results;
      } catch (e) {
        sql.exec('ROLLBACK');
        throw e;
      }
    },
  };
  mocks.env = {
    FOUNDER_ADMIN_PUBLIC_KEY_B64URL: keys.publicKey.export({ format: 'jwk' })
      .x!,
    SUPPORT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64url'),
  };
  mocks.verify.mockImplementation(async (key) => key);
  mocks.decide.mockResolvedValue({ latencyMs: 1 });
});
afterEach(() => sql.close());
function signed(action: unknown, domain = PLATFORM_DOMAIN) {
  const payload = Buffer.from(
    JSON.stringify({
      version: 1,
      timestamp: Math.floor(Date.now() / 1000),
      nonce: crypto.randomUUID(),
      action,
    }),
  ).toString('base64url');
  return {
    payload,
    signature: sign(
      null,
      Buffer.from(domain + payload),
      keys.privateKey,
    ).toString('base64url'),
  };
}
const call = async (action: unknown, domain = PLATFORM_DOMAIN, origin = '') => {
  const response = await POST(
    new Request('https://zentra.test/api/founder/platform', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(origin ? { Origin: origin } : {}),
      },
      body: JSON.stringify(signed(action, domain)),
    }),
  );
  return { status: response.status, body: await response.json() };
};
const save = (apiKey = 'jev-secret-fixture') => ({
  operation: 'save_key',
  apiKey,
  expectedRevision: 'initial',
  operationId: crypto.randomUUID(),
});
it('keeps platform signatures separate from access grants and browser requests', async () => {
  expect(
    (await call({ operation: 'state' }, 'zentra-founder-access-v1\n')).status,
  ).toBe(401);
  expect(
    (await call({ operation: 'state' }, PLATFORM_DOMAIN, 'https://zentra.test'))
      .status,
  ).toBe(403);
  expect((await call({ operation: 'state', apiKey: 'secret' })).status).toBe(
    400,
  );
  expect((await call({ operation: 'state' })).body).toMatchObject({
    configured: false,
    revision: 'initial',
  });
  expect(mocks.verify).not.toHaveBeenCalled();
});
it('validates both products, encrypts the shared key and never returns or audits its cleartext', async () => {
  const action = save(),
    result = await call(action);
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ configured: true, verified: true });
  expect(mocks.verify).toHaveBeenCalledWith(action.apiKey);
  expect(mocks.decide).toHaveBeenCalledTimes(1);
  expect(await decisionApiKey()).toBe(action.apiKey);
  expect(
    JSON.stringify(sql.prepare('SELECT * FROM support_platform_secrets').all()),
  ).not.toContain(action.apiKey);
  expect(
    JSON.stringify(
      sql.prepare('SELECT * FROM founder_platform_operations').all(),
    ),
  ).not.toContain(action.apiKey);
  expect(JSON.stringify(result.body)).not.toContain(action.apiKey);
  expect(JSON.stringify(await platformState())).not.toContain(action.apiKey);
  const tested = await call({ operation: 'test' });
  expect(tested.body).toMatchObject({
    verified: true,
    supportVerified: true,
    automationVerified: true,
  });
});
it('recovers the same write after a lost response without resending a paid verification', async () => {
  const action = save();
  await call(action);
  expect((await call(action)).body).toMatchObject({ replayed: true });
  expect(mocks.verify).toHaveBeenCalledTimes(1);
  expect((await call({ ...action, apiKey: 'another-key' })).status).toBe(409);
  expect((await call(save('replacement-key'))).status).toBe(409);
  expect(await decisionApiKey()).toBe(action.apiKey);
});
it('preserves the working key when verification fails', async () => {
  await call(save());
  const state = await platformState();
  mocks.verify.mockRejectedValue(new SupportError('Clé refusée.', 401));
  expect(
    (await call({ ...save('rejected'), expectedRevision: state.revision }))
      .status,
  ).toBe(401);
  expect(await decisionApiKey()).toBe('jev-secret-fixture');
});
it('does not overwrite a concurrently changed key', async () => {
  await call(save());
  const before = await platformState();
  mocks.verify.mockImplementation(async (key) => {
    sql.exec(
      "UPDATE support_platform_secrets SET secret='new-encrypted-value'",
    );
    return key;
  });
  const response = await call({
    ...save('replacement'),
    expectedRevision: before.revision,
  });
  expect(response.status).toBe(409);
  expect(
    sql.prepare('SELECT secret FROM support_platform_secrets').get()?.secret,
  ).toBe('new-encrypted-value');
  expect(
    sql.prepare('SELECT COUNT(*) AS n FROM founder_platform_operations').get()
      ?.n,
  ).toBe(1);
});
