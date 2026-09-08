import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { DeviceSessionContext } from './account';
import contract from '../desktop/src-tauri/src/business_sync_tables.json';
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
import { AccountPublicError, sha256Hex } from './account-security';
import {
  abandonBootstrap,
  businessSyncContractHash,
} from './business-sync-bootstrap';
import {
  BUSINESS_FILE_PART_BYTES,
  beginBusinessFiles,
  businessFileManifest,
  businessFilePath,
  businessFileStatus,
  businessFilesStatus,
  cleanupBootstrapFiles,
  completeBusinessFiles,
  uploadBusinessFilePage,
  uploadBusinessFilePart,
  verifyBusinessFile,
} from './business-sync-files';
import * as pagesHttp from '../app/api/sync/bootstrap/files/route';
import * as fileHttp from '../app/api/sync/bootstrap/file/route';

let db: DatabaseSync;
let blobs: Map<string, Uint8Array>;
let id: string;
let failPartReceipt = false;
const owner: DeviceSessionContext = {
  organizationId: 'org_first',
  organizationName: 'First',
  installationId: 'pc_first',
  userId: 'owner',
  role: 'owner',
  sessionId: 'session',
  subscriptionId: 'sub',
  entitlementValidUntil: 2_000_000_000,
};
type Scalar = string | number | null;
function prepared(sql: string) {
  let values: Scalar[] = [];
  const statement = {
    bind: (...args: Scalar[]) => {
      values = args;
      return statement;
    },
    execute: () => {
      if (
        failPartReceipt &&
        sql.includes('INSERT OR IGNORE INTO business_sync_file_parts')
      ) {
        failPartReceipt = false;
        throw new Error('D1 receipt interrupted');
      }
      return {
        meta: { changes: Number(db.prepare(sql).run(...values).changes) },
      };
    },
    run: async () => statement.execute(),
    first: async () => db.prepare(sql).get(...values) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...values) }),
  };
  return statement;
}
beforeEach(async () => {
  vi.clearAllMocks();
  failPartReceipt = false;
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  const folder = new URL('../drizzle/', import.meta.url);
  for (const name of readdirSync(folder)
    .filter((name) => name.endsWith('.sql'))
    .sort())
    db.exec(readFileSync(new URL(name, folder), 'utf8'));
  db.exec(
    "INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at) VALUES('sub','cus','price','active',2000000000,0,1); INSERT INTO organizations VALUES('org_first','First','sub','owner',1,1)",
  );
  mocks.db.mockReturnValue({
    prepare: prepared,
    batch: async (statements: ReturnType<typeof prepared>[]) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = statements.map((statement) => statement.execute());
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  });
  blobs = new Map();
  mocks.files.mockReturnValue({
    put: vi.fn(
      async (
        key: string,
        bytes: Uint8Array,
        options?: { onlyIf?: unknown },
      ) => {
        if (options?.onlyIf && blobs.has(key)) return null;
        blobs.set(key, Uint8Array.from(bytes));
        return { key };
      },
    ),
    get: vi.fn(async (key: string) => {
      const bytes = blobs.get(key);
      return bytes
        ? {
            size: bytes.length,
            body: new Response(Uint8Array.from(bytes)).body,
          }
        : null;
    }),
    delete: vi.fn(async (keys: string | string[]) => {
      for (const key of typeof keys === 'string' ? [keys] : keys)
        blobs.delete(key);
    }),
    list: vi.fn(
      async ({
        prefix,
        cursor,
        limit,
      }: {
        prefix: string;
        cursor?: string;
        limit: number;
      }) => {
        const keys = [...blobs.keys()]
          .sort()
          .filter((key) => key.startsWith(prefix) && (!cursor || key > cursor));
        const selected = keys.slice(0, limit);
        return {
          objects: selected.map((key) => ({ key })),
          truncated: keys.length > selected.length,
          cursor: selected.at(-1),
        };
      },
    ),
  });
  mocks.session.mockResolvedValue(owner);
  id = crypto.randomUUID();
  const manifest = {
    format: 'zentra-business-bootstrap',
    version: 1,
    schema_version: 60,
    contract_sha256: await businessSyncContractHash(),
    tables: Object.fromEntries(
      Object.keys(contract.tables)
        .sort()
        .map((name) => [name, name === 'settings' ? 1 : 0]),
    ),
    chunks: [{ sha256: 'a'.repeat(64), size_bytes: 1, row_count: 1 }],
    row_count: 1,
    size_bytes: 1,
  };
  // Row transfer is covered in business-sync-bootstrap.test.ts. This suite starts
  // at its durable "uploaded, head=0" boundary and exercises real migrated SQL.
  db.prepare(
    "INSERT INTO business_sync_spaces VALUES(?,?,?,'initializing',0,'owner','now')",
  ).run(owner.organizationId, 'generation', id);
  db.prepare(
    "INSERT INTO business_sync_transfers(transfer_id,organization_id,installation_id,created_by,generation,kind,state,base_revision,manifest_json,manifest_sha256,created_at) VALUES(?,?,?,'owner','generation','bootstrap','uploaded',0,?,'hash','now')",
  ).run(
    id,
    owner.organizationId,
    owner.installationId,
    JSON.stringify(manifest),
  );
});
afterEach(() => db.close());
const request = (bytes: Uint8Array, sha?: string) =>
  new Request('https://test.invalid/file', {
    method: 'PUT',
    body: Uint8Array.from(bytes),
    headers: sha ? { 'x-content-sha256': sha } : {},
  });
const count = (table: string) =>
  Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
async function entry(path: string, bytes: Uint8Array) {
  return { path, sha256: await sha256Hex(bytes), size_bytes: bytes.length };
}
async function fixture(entries: Awaited<ReturnType<typeof entry>>[], version: 1 | 2 = 1) {
  const pages: Uint8Array[] = [];
  for (let index = 0; index < entries.length; index += 200)
    pages.push(
      new TextEncoder().encode(
        JSON.stringify({
          version,
          files: entries.slice(index, index + 200),
        }),
      ),
    );
  const manifest = {
    format: 'zentra-business-files',
    version,
    pages: await Promise.all(
      pages.map(async (bytes, index) => ({
        sha256: await sha256Hex(bytes),
        size_bytes: bytes.length,
        file_count: entries.slice(index * 200, (index + 1) * 200).length,
      })),
    ),
    file_count: entries.length,
    size_bytes: entries.reduce((sum, file) => sum + file.size_bytes, 0),
  };
  return { manifest, pages };
}
async function catalog(entries: Awaited<ReturnType<typeof entry>>[]) {
  const f = await fixture(entries);
  await beginBusinessFiles(owner, id, f.manifest);
  for (const [index, bytes] of f.pages.entries())
    await uploadBusinessFilePage(owner, id, index, request(bytes));
  return f;
}

it('catalogue v2 keeps attachment and export storage distinct and transfers exact bytes', async () => {
  const document = new TextEncoder().encode('Document de projet'),
    xml = new TextEncoder().encode('<tva>export historique</tva>');
  const entries = [await entry('attachments/tva.xml', document), await entry('exports/tva.xml', xml)];
  const f = await fixture(entries, 2);
  expect(businessFileManifest(f.manifest).version).toBe(2);
  await beginBusinessFiles(owner, id, f.manifest);
  await uploadBusinessFilePage(owner, id, 0, request(f.pages[0]));
  for (const [index, file] of entries.entries()) {
    await put(file.sha256, 0, index === 0 ? document : xml);
    await verifyBusinessFile(owner, id, file.sha256);
  }
  expect(await completeBusinessFiles(owner, id)).toMatchObject({state: 'uploaded', replication_active: false});
  expect(db.prepare('SELECT path FROM business_sync_file_entries WHERE transfer_id=? ORDER BY path').all(id))
    .toEqual([{path: 'attachments/tva.xml'}, {path: 'exports/tva.xml'}]);
  await expect(beginBusinessFiles(owner, id, {...f.manifest, version: 1})).rejects.toMatchObject({status: 409});
});

it.each(['plan.pdf', 'attachments', 'exports/dossier/tva.xml', 'backups/archive.zip',
  'attachments/.business-sync-pending/blobs/secret', 'attachments/.BUSINESS-SYNC-PENDING/references/private'])
('catalogue v2 rejects an unclassified or private storage path: %s', async (path) => {
  const f = await fixture([await entry(path, new Uint8Array([1]))], 2);
  await beginBusinessFiles(owner, id, f.manifest);
  await expect(uploadBusinessFilePage(owner, id, 0, request(f.pages[0]))).rejects.toThrow();
  expect(count('business_sync_file_entries')).toBe(0);
  expect(count('business_sync_file_pages')).toBe(0);
});

it.each([1, 2] as const)('rejects pages from a different catalogue version than v%d', async (version) => {
  const f = await fixture([await entry('attachments/file.txt', new Uint8Array([1]))], version === 1 ? 2 : 1);
  await beginBusinessFiles(owner, id, {...f.manifest, version});
  await expect(uploadBusinessFilePage(owner, id, 0, request(f.pages[0]))).rejects.toThrow();
  expect(count('business_sync_file_entries')).toBe(0);
});

it('refuses unknown catalogue versions before creating a transfer catalogue', async () => {
  const f = await fixture([], 2);
  await expect(beginBusinessFiles(owner, id, {...f.manifest, version: 3})).rejects.toThrow();
  expect(count('business_sync_file_sets')).toBe(0);
});
async function put(sha: string, index: number, bytes: Uint8Array) {
  return uploadBusinessFilePart(
    owner,
    id,
    sha,
    index,
    request(bytes, await sha256Hex(bytes)),
  );
}

it('resumes a paginated catalogue and multi-part files, deduplicates shared bytes and leaves replication inactive', async () => {
  const bytes = new Uint8Array(BUSINESS_FILE_PART_BYTES + 31).fill(23),
    logo = new TextEncoder().encode('Fictitious logo');
  const file = await entry('plans/source.pdf', bytes),
    brand = await entry('branding/logo.png', logo),
    empty = await entry('notes/empty.txt', new Uint8Array());
  const entries = [
    file,
    brand,
    empty,
    ...Array.from({ length: 198 }, (_, index) => ({
      ...file,
      path: `project-${index}/copy.pdf`,
    })),
  ];
  const f = await fixture(entries),
    beginning = await beginBusinessFiles(owner, id, f.manifest);
  expect(beginning).toMatchObject({
    state: 'cataloguing',
    file_count: 201,
    total_blobs: 0,
  });
  await uploadBusinessFilePage(owner, id, 1, request(f.pages[1]));
  expect(
    (await beginBusinessFiles(owner, id, f.manifest)).manifest_sha256,
  ).toBe(beginning.manifest_sha256);
  await uploadBusinessFilePage(owner, id, 0, request(f.pages[0]));
  await uploadBusinessFilePage(owner, id, 1, request(f.pages[1]));
  expect(count('business_sync_file_entries')).toBe(201);
  expect(count('business_sync_file_blobs')).toBe(3);
  await expect(completeBusinessFiles(owner, id)).rejects.toMatchObject({
    status: 409,
  });
  await put(file.sha256, 1, bytes.slice(BUSINESS_FILE_PART_BYTES));
  await expect(
    verifyBusinessFile(owner, id, file.sha256),
  ).rejects.toMatchObject({ status: 409 });
  await put(file.sha256, 0, bytes.slice(0, BUSINESS_FILE_PART_BYTES));
  const repeat = await put(
    file.sha256,
    0,
    bytes.slice(0, BUSINESS_FILE_PART_BYTES),
  );
  expect(repeat.uploaded_parts).toHaveLength(2);
  expect((await verifyBusinessFile(owner, id, file.sha256)).verified).toBe(
    true,
  );
  await put(brand.sha256, 0, logo);
  await verifyBusinessFile(owner, id, brand.sha256);
  const completed = await completeBusinessFiles(owner, id);
  expect(completed).toMatchObject({
    state: 'uploaded',
    total_blobs: 3,
    verified_blobs: 3,
    replication_active: false,
  });
  expect(await completeBusinessFiles(owner, id)).toEqual(completed);
  expect(await verifyBusinessFile(owner, id, file.sha256)).toMatchObject({
    verified: true,
  });
  expect(blobs.size).toBe(3);
  expect(count('document_number_reservations')).toBe(0);
  expect(
    db.prepare('SELECT state,head_revision FROM business_sync_spaces').get(),
  ).toMatchObject({ state: 'initializing', head_revision: 0 });
});
it('accepts an empty catalogue and empty files without uploading invented content', async () => {
  const f = await fixture([]);
  expect(await beginBusinessFiles(owner, id, f.manifest)).toMatchObject({
    state: 'uploaded',
    total_blobs: 0,
  });
  expect(await completeBusinessFiles(owner, id)).toMatchObject({
    state: 'uploaded',
    verified_blobs: 0,
  });
  expect(blobs.size).toBe(0);
});
it('rejects a transport checksum error before storage and detects a different full file even with valid part checksums', async () => {
  const original = new Uint8Array([1, 2, 3]),
    wrong = new Uint8Array([1, 2, 4]),
    file = await entry('invoice.pdf', original);
  await catalog([file]);
  await expect(
    uploadBusinessFilePart(
      owner,
      id,
      file.sha256,
      0,
      request(wrong, file.sha256),
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(blobs.size).toBe(0);
  await put(file.sha256, 0, wrong);
  await expect(
    verifyBusinessFile(owner, id, file.sha256),
  ).rejects.toMatchObject({ status: 409 });
  await expect(completeBusinessFiles(owner, id)).rejects.toMatchObject({
    status: 409,
  });
  expect((await businessFileStatus(owner, id, file.sha256)).verified).toBe(
    false,
  );
});
it('detects a stored fragment disappearing or changing before whole-file verification', async () => {
  const bytes = new Uint8Array([11, 12]),
    file = await entry('photo.png', bytes);
  await catalog([file]);
  await put(file.sha256, 0, bytes);
  const key = [...blobs.keys()][0];
  blobs.set(key, new Uint8Array([11, 13]));
  await expect(
    verifyBusinessFile(owner, id, file.sha256),
  ).rejects.toMatchObject({ status: 409 });
  await expect(put(file.sha256, 0, bytes)).rejects.toMatchObject({
    status: 409,
  });
  blobs.delete(key);
  await expect(
    verifyBusinessFile(owner, id, file.sha256),
  ).rejects.toMatchObject({ status: 409 });
  expect((await businessFileStatus(owner, id, file.sha256)).verified).toBe(
    false,
  );
});
it('repeats a lost R2 response and a lost D1 receipt without replacing stored bytes', async () => {
  const bytes = new Uint8Array([12, 13]),
    file = await entry('photo.png', bytes);
  await catalog([file]);
  mocks
    .files()
    .put.mockImplementationOnce(async (key: string, value: Uint8Array) => {
      blobs.set(key, Uint8Array.from(value));
      throw new Error('response lost');
    });
  await expect(put(file.sha256, 0, bytes)).rejects.toThrow('response lost');
  expect(blobs.size).toBe(1);
  expect(count('business_sync_file_parts')).toBe(0);
  failPartReceipt = true;
  await expect(put(file.sha256, 0, bytes)).rejects.toThrow(
    'D1 receipt interrupted',
  );
  expect(count('business_sync_file_parts')).toBe(0);
  const state = await put(file.sha256, 0, bytes);
  expect(state.uploaded_parts).toHaveLength(1);
  await expect(
    put(file.sha256, 0, new Uint8Array([13, 14])),
  ).rejects.toMatchObject({ status: 409 });
  expect([...blobs.values()][0]).toEqual(bytes);
  expect((await verifyBusinessFile(owner, id, file.sha256)).verified).toBe(
    true,
  );
});
it('refuses conflicting catalogues, case-colliding paths across pages and a hash with two sizes atomically', async () => {
  const file = await entry('photo.png', new Uint8Array([1]));
  const entries = Array.from({ length: 200 }, (_, index) => ({
    ...file,
    path: `photo-${index}.png`,
  }));
  const f = await fixture([...entries, { ...file, path: 'PHOTO-0.png' }]);
  await beginBusinessFiles(owner, id, f.manifest);
  await uploadBusinessFilePage(owner, id, 0, request(f.pages[0]));
  await expect(
    uploadBusinessFilePage(owner, id, 1, request(f.pages[1])),
  ).rejects.toMatchObject({ status: 409 });
  expect(count('business_sync_file_entries')).toBe(200);
  expect(count('business_sync_file_pages')).toBe(1);
  await expect(
    beginBusinessFiles(owner, id, {
      ...f.manifest,
      size_bytes: f.manifest.size_bytes + 1,
    }),
  ).rejects.toMatchObject({ status: 409 });
});
it('rolls back a whole catalogue page for contradictory file sizes or total bytes', async () => {
  const first = await entry('first.txt', new Uint8Array([1])),
    second = { ...first, path: 'second.txt', size_bytes: 2 };
  let f = await fixture([first, second]);
  await beginBusinessFiles(owner, id, f.manifest);
  await expect(
    uploadBusinessFilePage(owner, id, 0, request(f.pages[0])),
  ).rejects.toThrow();
  expect(count('business_sync_file_entries')).toBe(0);
  db.prepare('DELETE FROM business_sync_file_sets WHERE transfer_id=?').run(id);
  f = await fixture([first]);
  await beginBusinessFiles(owner, id, { ...f.manifest, size_bytes: 2 });
  await expect(
    uploadBusinessFilePage(owner, id, 0, request(f.pages[0])),
  ).rejects.toMatchObject({ status: 409 });
  for (const table of [
    'business_sync_file_entries',
    'business_sync_file_blobs',
    'business_sync_file_pages',
  ])
    expect(count(table)).toBe(0);
});
it.each([
  '../secret',
  '/absolute',
  'a\\b',
  'C:/file',
  'CON.txt',
  'x/Lpt1.pdf',
  'a//b',
  'space ',
  'trailing.',
  'a\u0000b',
  '\ud800',
  'é'.repeat(513),
])('rejects a nonportable file path: %j', (path) => {
  expect(() => businessFilePath(path)).toThrow();
});
it('bounds catalogues, pages, files and fragment indexes before storing data', async () => {
  expect(businessFilePath('projet/Plan été 😀.pdf')).toBe(
    'projet/Plan été 😀.pdf',
  );
  const file = await entry('photo.png', new Uint8Array([1]));
  const f = await fixture([file]);
  for (const bad of [
    { ...f.manifest, file_count: 50_001 },
    { ...f.manifest, size_bytes: 10 * 1024 ** 3 + 1 },
    { ...f.manifest, unknown: true },
    { ...f.manifest, pages: [] },
    { ...f.manifest, file_count: 1.5 },
  ])
    expect(() => businessFileManifest(bad)).toThrow();
  await catalog([file]);
  for (const index of [-1, 1, 128, 0.5, Number.NaN])
    await expect(
      put(file.sha256, index, new Uint8Array([1])),
    ).rejects.toThrow();
  await expect(
    put(file.sha256, 0, new Uint8Array([1, 2])),
  ).rejects.toMatchObject({ status: 413 });
  expect(blobs.size).toBe(0);
});
it('enforces role, company, device, complete catalogue and source publication gates', async () => {
  const bytes = new Uint8Array([1]),
    file = await entry('a.pdf', bytes),
    f = await fixture([file]);
  await beginBusinessFiles(owner, id, f.manifest);
  await expect(put(file.sha256, 0, bytes)).rejects.toMatchObject({
    status: 409,
  });
  await uploadBusinessFilePage(owner, id, 0, request(f.pages[0]));
  for (const session of [
    { ...owner, role: 'member' as const },
    { ...owner, role: 'accountant' as const },
    { ...owner, role: 'read_only' as const },
    { ...owner, organizationId: 'another-company' },
    { ...owner, installationId: 'another-device' },
  ]) {
    for (const operation of [
      () => beginBusinessFiles(session, id, f.manifest),
      () => businessFilesStatus(session, id),
      () => uploadBusinessFilePage(session, id, 0, request(f.pages[0])),
      () => businessFileStatus(session, id, file.sha256),
      () =>
        uploadBusinessFilePart(
          session,
          id,
          file.sha256,
          0,
          request(bytes, file.sha256),
        ),
      () => verifyBusinessFile(session, id, file.sha256),
      () => completeBusinessFiles(session, id),
    ])
      await expect(operation()).rejects.toThrow();
  }
  expect(blobs.size).toBe(0);
  db.exec("UPDATE business_sync_spaces SET state='ready',head_revision=1");
  await expect(put(file.sha256, 0, bytes)).rejects.toMatchObject({
    status: 409,
  });
  await expect(
    cleanupBootstrapFiles(owner.organizationId, id),
  ).rejects.toMatchObject({ status: 409 });
  await expect(abandonBootstrap(owner, id)).rejects.toMatchObject({
    status: 409,
  });
  expect(count('business_sync_file_entries')).toBe(1);
});
it('cancels a late upload, removes its metadata and leaves another company untouched', async () => {
  const bytes = new Uint8Array([1]),
    file = await entry('a.pdf', bytes);
  await catalog([file]);
  const untouched = 'business-sync/another-company/another-transfer/files/keep';
  blobs.set(untouched, bytes);
  mocks
    .files()
    .put.mockImplementationOnce(async (key: string, value: Uint8Array) => {
      await abandonBootstrap(
        { ...owner, role: 'admin', installationId: 'replacement' },
        id,
      );
      blobs.set(key, value);
      return { key };
    });
  await expect(put(file.sha256, 0, bytes)).rejects.toMatchObject({
    status: 409,
  });
  expect([...blobs.keys()]).toEqual([untouched]);
  for (const table of [
    'business_sync_file_entries',
    'business_sync_file_blobs',
    'business_sync_file_parts',
    'business_sync_file_pages',
    'business_sync_file_sets',
  ])
    expect(count(table)).toBe(0);
  const orphan = `business-sync/${owner.organizationId}/${id}/files/late/0`;
  blobs.set(orphan, bytes);
  await abandonBootstrap(owner, id);
  expect([...blobs.keys()]).toEqual([untouched]);
  await expect(
    beginBusinessFiles(owner, id, (await fixture([file])).manifest),
  ).rejects.toMatchObject({ status: 409 });
});
it('does not mark a file verified when cancellation occurs during the final read', async () => {
  const bytes = new Uint8Array([1]),
    file = await entry('a.pdf', bytes);
  await catalog([file]);
  await put(file.sha256, 0, bytes);
  mocks.files().get.mockImplementationOnce(async () => {
    await abandonBootstrap(owner, id);
    return { size: bytes.length, body: new Response(bytes).body };
  });
  await expect(
    verifyBusinessFile(owner, id, file.sha256),
  ).rejects.toMatchObject({ status: 409 });
  expect(count('business_sync_file_blobs')).toBe(0);
  expect(blobs.size).toBe(0);
});
it('removes a large abandoned prefix in pages and resumes interrupted cleanup', async () => {
  for (let index = 0; index < 1205; index++)
    blobs.set(
      `business-sync/${owner.organizationId}/${id}/files/${index.toString().padStart(4, '0')}`,
      new Uint8Array(),
    );
  const originalDelete = mocks.files().delete.getMockImplementation();
  mocks.files().delete.mockImplementationOnce(async () => {
    throw new Error('storage temporarily unavailable');
  });
  await expect(abandonBootstrap(owner, id)).rejects.toThrow(
    'storage temporarily unavailable',
  );
  mocks.files().delete.mockImplementation(originalDelete);
  expect((await abandonBootstrap(owner, id)).state).toBe('abandoned');
  expect(blobs.size).toBe(0);
});
it('requires authentication on every file route and rejects malformed indexes without reading the payload', async () => {
  mocks.session.mockRejectedValue(
    new AccountPublicError('Connexion requise.', 401),
  );
  for (const [routes, methods] of [
    [pagesHttp, ['GET', 'POST', 'PUT']],
    [fileHttp, ['GET', 'POST', 'PUT']],
  ] as const) {
    for (const method of methods) {
      const response = await routes[method](
        new Request('https://test.invalid/api/sync/bootstrap/files', {
          method,
        }),
      );
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toContain('no-store');
    }
  }
  mocks.session.mockResolvedValue(owner);
  for (const index of ['', '-1', '01', '1.0', 'NaN']) {
    expect(
      (
        await pagesHttp.PUT(
          new Request(
            `https://test.invalid/api?transfer_id=${id}&page=${index}`,
            { method: 'PUT' },
          ),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await fileHttp.PUT(
          new Request(
            `https://test.invalid/api?transfer_id=${id}&part=${index}`,
            { method: 'PUT' },
          ),
        )
      ).status,
    ).toBe(400);
  }
  expect(blobs.size).toBe(0);
});
