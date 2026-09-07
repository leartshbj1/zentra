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
vi.mock('@/lib/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./account')>()),
  requireDeviceSession: mocks.session,
  enforceAccountRateLimit: mocks.rate,
}));
import { GET, PUT, DELETE } from '../app/api/projects/sync/route';
import { GET as download } from '../app/api/projects/sync/file/route';
import { AccountPublicError, sha256Hex } from './account-security';
import {
  MAX_PROJECT_FILE_BYTES,
  type ProjectDocumentEvent,
} from './project-sync';
let db: DatabaseSync;
const files = new Map<string, Uint8Array>();
const project = 'bb88571d-b341-4414-a8b8-946c1200cbec';
const id = 'a1a42ca9-68d2-434d-b9f5-efaa0409be77';
const origin = 'https://zentra.test/api/projects/sync';
const url = (document = id) => `${origin}?id=${document}&projectId=${project}`;
const content = new TextEncoder().encode('Plan du projet\nDeuxième ligne');
const objects = {
  put: vi.fn(async (key: string, bytes: Uint8Array) => {
    files.set(key, bytes.slice());
  }),
  delete: vi.fn(async (key: string) => {
    files.delete(key);
  }),
  get: vi.fn(async (key: string) => {
    const bytes = files.get(key);
    return bytes ? { body: bytes } : null;
  }),
};
function prepared(sql: string) {
  const statement = db.prepare(sql);
  let args: (string | number | null)[] = [];
  const result = {
    bind: (...values: typeof args) => {
      args = values;
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
  mocks.session.mockResolvedValue({
    organizationId: 'org_first',
    role: 'owner',
    sessionId: 'session',
  });
});
afterEach(() => db.close());
async function upload(
  bytes = content,
  document = id,
  name = 'Plan général.txt',
  projectName = 'Maison été',
) {
  return PUT(
    new Request(url(document), {
      method: 'PUT',
      headers: {
        'X-Zentra-Name': encodeURIComponent(name),
        'X-Zentra-Project': encodeURIComponent(projectName),
        'X-Zentra-Sha256': await sha256Hex(bytes),
        'Content-Type': 'application/octet-stream',
      },
      body: Uint8Array.from(bytes),
    }),
  );
}
async function feed(after = 0) {
  return (await (
    await GET(new Request(`${origin}?after=${after}`))
  ).json()) as {
    events: ProjectDocumentEvent[];
    cursor: number;
    hasMore: boolean;
  };
}
it('retries an acknowledged upload without duplicating and downloads exact offline bytes', async () => {
  expect((await upload()).status).toBe(200);
  expect((await upload()).status).toBe(200);
  const list = await feed();
  expect(list.events).toHaveLength(1);
  expect(list.events[0]).toMatchObject({
    project_name: 'Maison été',
    original_name: 'Plan général.txt',
    size_bytes: content.length,
  });
  expect(list.events[0]).not.toHaveProperty('object_key');
  const response = await download(new Request(`${origin}/file?id=${id}`));
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(content);
  expect(response.headers.get('Cache-Control')).toContain('no-store');
  expect(response.headers.get('Content-Disposition')).toContain('attachment;');
  expect((await feed(list.cursor)).events).toEqual([]);
});
it('does not expose a file or its metadata to another organization', async () => {
  await upload();
  mocks.session.mockResolvedValue({
    organizationId: 'org_other',
    role: 'owner',
  });
  expect((await feed()).events).toEqual([]);
  expect((await download(new Request(`${origin}/file?id=${id}`))).status).toBe(
    404,
  );
});
it('records deletion before a late offline upload and never resurrects its bytes', async () => {
  expect((await DELETE(new Request(url(), { method: 'DELETE' }))).status).toBe(
    200,
  );
  expect(await (await upload()).json()).toEqual({ deleted: true });
  expect(files.size).toBe(0);
  expect(
    (await feed()).events.map((event: { action: string }) => event.action),
  ).toEqual(['deleted']);
  expect((await download(new Request(`${origin}/file?id=${id}`))).status).toBe(
    410,
  );
});
it('replays deletion after a lost acknowledgement and removes the cached server object', async () => {
  await upload();
  const before = await feed();
  await DELETE(new Request(url(), { method: 'DELETE' }));
  await DELETE(new Request(url(), { method: 'DELETE' }));
  expect((await feed(before.cursor)).events).toHaveLength(1);
  expect(files.size).toBe(0);
  expect(await (await upload()).json()).toEqual({ deleted: true });
});
it('rejects replacement of an immutable file and preserves the original', async () => {
  await upload();
  expect((await upload(new TextEncoder().encode('changed'))).status).toBe(409);
  const response = await download(new Request(`${origin}/file?id=${id}`));
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(content);
});
it('keeps an interrupted upload retryable without advertising a missing file', async () => {
  objects.put.mockRejectedValueOnce(new Error('network interrupted'));
  expect((await upload()).status).toBe(500);
  expect((await feed()).events).toEqual([]);
  expect((await upload()).status).toBe(200);
  expect((await feed()).events).toHaveLength(1);
});
it('honors a deletion racing with object storage', async () => {
  objects.put.mockImplementationOnce(async (key, bytes) => {
    files.set(key, bytes);
    await DELETE(new Request(url(), { method: 'DELETE' }));
  });
  expect(await (await upload()).json()).toEqual({ deleted: true });
  expect(files.size).toBe(0);
  expect(
    (await feed()).events.map((event: { action: string }) => event.action),
  ).toEqual(['deleted']);
});
it('requires authentication and denies writes for read-only members', async () => {
  mocks.session.mockRejectedValueOnce(
    new AccountPublicError('Connexion requise', 401),
  );
  expect((await GET(new Request(origin))).status).toBe(401);
  mocks.session.mockResolvedValue({
    organizationId: 'org_first',
    role: 'read_only',
  });
  expect((await upload()).status).toBe(403);
  expect((await DELETE(new Request(url(), { method: 'DELETE' }))).status).toBe(
    403,
  );
  expect((await GET(new Request(origin))).status).toBe(200);
});
it('rejects traversal, executable content, corruption and an oversized declared body', async () => {
  expect((await upload(content, id, '../secret.txt')).status).toBe(400);
  expect((await upload(content, id, 'photo.jpg')).status).toBe(400);
  const headers = {
    'X-Zentra-Name': 'plan.txt',
    'X-Zentra-Project': 'Projet',
    'X-Zentra-Sha256': '0'.repeat(64),
  };
  expect(
    (await PUT(new Request(url(), { method: 'PUT', headers, body: content })))
      .status,
  ).toBe(400);
  expect(
    (
      await PUT(
        new Request(url(), {
          method: 'PUT',
          headers: {
            ...headers,
            'Content-Length': String(MAX_PROJECT_FILE_BYTES + 1),
          },
          body: content,
        }),
      )
    ).status,
  ).toBe(413);
  expect(files.size).toBe(0);
});
