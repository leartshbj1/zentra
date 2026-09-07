import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  db: vi.fn(),
  files: vi.fn(),
  session: vi.fn(),
  rate: vi.fn(),
}));
vi.mock('@/lib/runtime', () => ({
  database: mocks.db,
  fileArchive: mocks.files,
}));
vi.mock('@/lib/account', async (original) => ({
  ...(await original<typeof import('./account')>()),
  requireDeviceSession: mocks.session,
  enforceAccountRateLimit: mocks.rate,
}));
import { GET as list, POST as begin } from '../app/api/backups/route';
import {
  GET as get,
  POST as complete,
  DELETE as remove,
} from '../app/api/backups/item/route';
import { GET as download, PUT as upload } from '../app/api/backups/chunk/route';
import { AccountPublicError, sha256Hex } from './account-security';
import {
  BACKUP_CHUNK_BYTES,
  MAX_BACKUPS,
  type BackupManifest,
} from './workspace-backup';

let db: DatabaseSync;
const files = new Map<string, Uint8Array>();
const id = 'ac513271-44d4-47e5-8830-2bb40cd5dced';
const bytes = new TextEncoder().encode('PK\x03\x04fixture archive');
const origin = 'https://zentra.test/api/backups';
const owner = {
  organizationId: 'org_first',
  role: 'owner',
  installationId: 'pc_first',
  userId: 'owner',
  sessionId: 'session',
};
const objects = {
  put: vi.fn(async (key: string, body: Uint8Array) => {
    files.set(key, body.slice());
  }),
  get: vi.fn(async (key: string) => {
    const body = files.get(key);
    return body ? { body: Uint8Array.from(body) } : null;
  }),
  delete: vi.fn(async (key: string | string[]) => {
    for (const k of typeof key === 'string' ? [key] : key) files.delete(k);
  }),
};
function prepared(sql: string) {
  const statement = db.prepare(sql);
  let args: (string | number | null)[] = [];
  const result = {
    bind: (...v: typeof args) => {
      args = v;
      return result;
    },
    first: async () => statement.get(...args) ?? null,
    all: async () => ({ results: statement.all(...args) }),
    run: async () => ({
      meta: { changes: Number(statement.run(...args).changes) },
    }),
  };
  return result;
}
beforeEach(() => {
  vi.clearAllMocks();
  files.clear();
  db = new DatabaseSync(':memory:');
  const folder = new URL('../drizzle/', import.meta.url);
  for (const name of readdirSync(folder)
    .filter((n) => n.endsWith('.sql'))
    .sort())
    db.exec(readFileSync(new URL(name, folder), 'utf8'));
  db.exec(
    "INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at) VALUES('sub_test','cus_test','price_test','active',2000000000,0,1); INSERT INTO organizations VALUES('org_first','First','sub_test','owner',1,1);",
  );
  mocks.db.mockReturnValue({ prepare: prepared });
  mocks.files.mockReturnValue(objects);
  mocks.session.mockResolvedValue(owner);
});
afterEach(() => db.close());
async function manifest(parts = [bytes]): Promise<BackupManifest> {
  const all = Buffer.concat(parts);
  return {
    format: 'zentra-cloud-backup',
    version: 1,
    app_version: '1.45.0',
    sha256: await sha256Hex(all),
    size_bytes: all.length,
    chunks: await Promise.all(
      parts.map(async (part) => ({
        sha256: await sha256Hex(part),
        size_bytes: part.length,
      })),
    ),
  };
}
const item = (method = 'GET', backup = id) =>
  new Request(`${origin}/item?id=${backup}`, { method });
const part = (index = 0, backup = id) =>
  `${origin}/chunk?id=${backup}&index=${index}`;
async function start(m?: BackupManifest, backup = id) {
  return begin(
    new Request(origin, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        backup_id: backup,
        manifest: m || (await manifest()),
      }),
    }),
  );
}
async function send(content = bytes, index = 0) {
  return upload(
    new Request(part(index), { method: 'PUT', body: Uint8Array.from(content) }),
  );
}
async function saved() {
  expect((await start()).status).toBe(200);
  expect((await send()).status).toBe(200);
  expect((await complete(item('POST'))).status).toBe(200);
}
it('restores exactly the bytes of a completed backup on a different authorized installation', async () => {
  await saved();
  mocks.session.mockResolvedValue({
    ...owner,
    installationId: 'new_pc',
    role: 'admin',
  });
  const listing = (await (await list(new Request(origin))).json()) as {
    backups: Record<string, unknown>[];
  };
  expect(listing.backups).toHaveLength(1);
  expect(listing.backups[0]).toMatchObject({
    state: 'complete',
    installation_id: 'pc_first',
  });
  expect(listing.backups[0]).not.toHaveProperty('manifest_json');
  const metadata = (await (await get(item())).json()) as {
    manifest: BackupManifest;
  };
  expect(metadata.manifest).toEqual(await manifest());
  const response = await download(new Request(part()));
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  expect(response.headers.get('Cache-Control')).toContain('no-store');
  expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
});
it('resumes a lost acknowledgement without duplicating or replacing the completed revision', async () => {
  await saved();
  const original = await (await get(item())).json();
  expect((await start()).status).toBe(200);
  expect((await send()).status).toBe(200);
  expect((await complete(item('POST'))).status).toBe(200);
  expect(await (await get(item())).json()).toEqual(original);
  expect(files.size).toBe(1);
  const changed = await manifest([new TextEncoder().encode('changed')]);
  expect((await start(changed)).status).toBe(409);
  expect((await send(new TextEncoder().encode('corrupt'))).status).toBe(400);
});
it('does not publish an interrupted transfer and resumes its missing chunks', async () => {
  const first = new Uint8Array(BACKUP_CHUNK_BYTES).fill(65);
  const m = await manifest([first, bytes]);
  expect((await start(m)).status).toBe(200);
  expect((await send(first)).status).toBe(200);
  expect((await complete(item('POST'))).status).toBe(409);
  expect((await get(item())).status).toBe(409);
  expect((await download(new Request(part()))).status).toBe(409);
  objects.put.mockRejectedValueOnce(new Error('network interrupted'));
  expect((await send(bytes, 1)).status).toBe(500);
  expect((await complete(item('POST'))).status).toBe(409);
  expect((await send(bytes, 1)).status).toBe(200);
  expect((await complete(item('POST'))).status).toBe(200);
  expect(
    new Uint8Array(await (await download(new Request(part(1)))).arrayBuffer()),
  ).toEqual(bytes);
});
it('never crosses organizations for listing, overwrite, completion, download or deletion', async () => {
  await saved();
  mocks.session.mockResolvedValue({ ...owner, organizationId: 'org_other' });
  expect(await (await list(new Request(origin))).json()).toMatchObject({
    backups: [],
  });
  for (const response of [
    await get(item()),
    await complete(item('POST')),
    await download(new Request(part())),
    await send(),
    await remove(item('DELETE')),
  ])
    expect(response.status).toBe(404);
  expect(files.size).toBe(1);
});
it.each(['member', 'accountant', 'read_only'])(
  'rejects complete-company access for the %s role',
  async (role) => {
    await saved();
    mocks.session.mockResolvedValue({ ...owner, role });
    for (const response of [
      await list(new Request(origin)),
      await start(),
      await get(item()),
      await complete(item('POST')),
      await download(new Request(part())),
      await send(),
      await remove(item('DELETE')),
    ])
      expect(response.status).toBe(403);
  },
);
it('rejects revoked sessions on every endpoint', async () => {
  mocks.session.mockRejectedValue(new AccountPublicError('Révoqué', 401));
  for (const response of [
    await list(new Request(origin)),
    await start(),
    await get(item()),
    await complete(item('POST')),
    await download(new Request(part())),
    await send(),
    await remove(item('DELETE')),
  ])
    expect(response.status).toBe(401);
  expect(files.size).toBe(0);
});
it('rejects invalid manifests, traversal, oversized and altered payloads without publishing', async () => {
  const m = await manifest();
  for (const bad of [
    { ...m, size_bytes: m.size_bytes + 1 },
    { ...m, sha256: '../x' },
    { ...m, chunks: [] },
    { ...m, version: 2 },
    { ...m, chunks: [null] },
    { ...m, chunks: [...m.chunks, ...m.chunks] },
  ])
    expect((await start(bad as BackupManifest)).status).toBe(400);
  expect((await start(m, '../something')).status).toBe(400);
  await start();
  expect((await send(new Uint8Array(bytes.length).fill(1))).status).toBe(400);
  expect(
    (
      await upload(
        new Request(part(), {
          method: 'PUT',
          headers: { 'Content-Length': String(BACKUP_CHUNK_BYTES + 1) },
        }),
      )
    ).status,
  ).toBe(413);
  for (const index of ['-1', '0.0', '', '1', '01'])
    expect(
      (await download(new Request(`${origin}/chunk?id=${id}&index=${index}`)))
        .status,
    ).toBe(409);
  expect(files.size).toBe(0);
});
it('keeps deleted backups deleted even when uploads and completion arrive late', async () => {
  await saved();
  expect((await remove(item('DELETE'))).status).toBe(200);
  expect(files.size).toBe(0);
  expect((await remove(item('DELETE'))).status).toBe(200);
  for (const response of [
    await start(),
    await send(),
    await complete(item('POST')),
    await get(item()),
    await download(new Request(part())),
  ])
    expect(response.status).toBe(410);
  expect(await (await list(new Request(origin))).json()).toMatchObject({
    backups: [],
  });
});
it('cleans up bytes uploaded concurrently with deletion and refuses completion', async () => {
  await start();
  objects.put.mockImplementationOnce(async (key, body) => {
    await remove(item('DELETE'));
    files.set(key, body.slice());
  });
  expect((await send()).status).toBe(410);
  expect(files.size).toBe(0);
  expect((await complete(item('POST'))).status).toBe(410);
});
it('keeps failed storage cleanup visible and retryable without allowing restoration', async () => {
  await saved();
  objects.delete.mockRejectedValueOnce(new Error('storage unavailable'));
  expect((await remove(item('DELETE'))).status).toBe(500);
  expect(files.size).toBe(1);
  expect(await (await list(new Request(origin))).json()).toMatchObject({
    backups: [{ state: 'deleting' }],
  });
  expect((await get(item())).status).toBe(410);
  expect((await start()).status).toBe(410);
  expect((await remove(item('DELETE'))).status).toBe(200);
  expect(files.size).toBe(0);
  expect(await (await list(new Request(origin))).json()).toMatchObject({
    backups: [],
  });
});
it('bounds organization storage reservations and frees them only after deletion', async () => {
  await start();
  const row = db.prepare('SELECT * FROM workspace_backups LIMIT 1').get()!;
  const insert = db.prepare(
    "INSERT INTO workspace_backups(backup_id,organization_id,installation_id,created_by,manifest_json,size_bytes,state,created_at) VALUES(?,'org_first','pc_first','owner',?,?,'uploading',?)",
  );
  for (let i = 1; i < MAX_BACKUPS; i++)
    insert.run(
      `reserved-${i}`,
      row.manifest_json!,
      row.size_bytes!,
      row.created_at!,
    );
  const next = 'fc513271-44d4-47e5-8830-2bb40cd5dced';
  expect((await start(undefined, next)).status).toBe(409);
  await remove(item('DELETE'));
  expect((await start(undefined, next)).status).toBe(200);
});
