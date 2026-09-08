import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
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
  beginBootstrap,
  uploadBootstrapChunk,
  abandonBootstrap,
  bootstrapManifest,
  businessSyncContractHash,
  type BootstrapManifest,
} from './business-sync-bootstrap';
import {
  beginBusinessFiles,
  uploadBusinessFilePage,
  uploadBusinessFilePart,
  verifyBusinessFile,
  completeBusinessFiles,
  BUSINESS_FILE_PART_BYTES,
} from './business-sync-files';
import { structuralSchema } from './business-sync-structure';
import { validateBootstrapStructure } from './business-sync-validation';
import { validateBootstrapIntegrity } from './business-sync-integrity';
import {
  publishBootstrap,
  publishedHistory,
} from './business-sync-publication';
import {
  historyHead,
  historyChunk,
  historyFilePage,
  historyFilePart,
} from './business-sync-history';
import { reserveDocumentNumbers } from './document-number-reservations';
import * as publishHttp from '../app/api/sync/bootstrap/publish/route';
import * as historyHttp from '../app/api/sync/history/route';
import * as fileHttp from '../app/api/sync/history/file/route';

let db: DatabaseSync, blobs: Map<string, Uint8Array>;
let beforeBatch: ((sql: string[]) => Promise<void>) | undefined;
let failStatement: ((sql: string) => void) | undefined;
type Scalar = string | number | null;
function prepare(sql: string) {
  let values: Scalar[] = [];
  const s = {
    sql,
    bind: (...args: Scalar[]) => {
      expect(args.length).toBeLessThanOrEqual(100);
      values = args;
      return s;
    },
    execute: () => {
      failStatement?.(sql);
      return {
        meta: { changes: Number(db.prepare(sql).run(...values).changes) },
      };
    },
    run: async () => s.execute(),
    first: async () => db.prepare(sql).get(...values) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...values) }),
  };
  return s;
}
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
const second: DeviceSessionContext = {
  ...owner,
  installationId: 'pc_second',
  userId: 'colleague',
  sessionId: 'second-session',
  role: 'member',
};
beforeEach(() => {
  vi.clearAllMocks();
  beforeBatch = undefined;
  failStatement = undefined;
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  const folder = new URL('../drizzle/', import.meta.url);
  for (const name of readdirSync(folder)
    .filter((n) => n.endsWith('.sql'))
    .sort())
    db.exec(readFileSync(new URL(name, folder), 'utf8'));
  db.exec(
    "INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at) VALUES('sub','cus','price','active',2000000000,0,1),('sub2','cus2','price','active',2000000000,0,1); INSERT INTO organizations VALUES('org_first','First','sub','owner',1,1),('org_other','Other','sub2','other',1,1)",
  );
  mocks.db.mockReturnValue({
    prepare,
    batch: async (statements: ReturnType<typeof prepare>[]) => {
      await beforeBatch?.(statements.map((s) => s.sql));
      db.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map((s) => s.execute());
        db.exec('COMMIT');
        return results;
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
            arrayBuffer: async () => Uint8Array.from(bytes).buffer,
          }
        : null;
    }),
    delete: vi.fn(async (keys: string | string[]) => {
      for (const key of typeof keys === 'string' ? [keys] : keys)
        blobs.delete(key);
    }),
    list: vi.fn(async ({ prefix }: { prefix: string }) => ({
      objects: [...blobs.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((key) => ({ key })),
      truncated: false,
    })),
  });
  mocks.session.mockResolvedValue(owner);
});
afterEach(() => db.close());
const encode = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));
const request = (bytes: Uint8Array, sha?: string) =>
  new Request('https://test.invalid/upload', {
    method: 'PUT',
    body: Uint8Array.from(bytes),
    headers: sha ? { 'x-content-sha256': sha } : {},
  });
const count = (table: string) =>
  Number(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n);
type Entry = { path: string; sha256: string; size_bytes: number };
type Fixture = {
  id: string;
  manifest: BootstrapManifest;
  chunks: Uint8Array[];
  entries: Entry[];
  contents: Map<string, Uint8Array>;
};
async function fixture(): Promise<Fixture> {
  const native = new DatabaseSync(':memory:');
  let row_json: string;
  try {
    native.exec(structuralSchema.tables.settings.sql);
    native.exec(
      "INSERT INTO settings(id,onboarding_completed,company_name,created_at,updated_at) VALUES(1,1,'Entreprise fictive','2026-09-08','2026-09-08')",
    );
    row_json = native
      .prepare(
        `SELECT json_object(${contract.tables.settings.columns.flatMap((c) => [`'${c}'`, `"${c}"`]).join(',')}) json FROM settings`,
      )
      .get()!.json as string;
  } finally {
    native.close();
  }
  const chunks = [
    encode({
      version: 1,
      rows: [
        {
          table: 'settings',
          key_json: '[1]',
          row_json,
          sha256: await sha256Hex(row_json),
        },
      ],
    }),
  ];
  const manifest = await bootstrapManifest({
    format: 'zentra-business-bootstrap',
    version: 2,
    schema_version: 60,
    contract_sha256: await businessSyncContractHash(),
    tables: Object.fromEntries(
      Object.keys(contract.tables).map((t) => [t, t === 'settings' ? 1 : 0]),
    ),
    chunks: [
      {
        sha256: await sha256Hex(chunks[0]),
        size_bytes: chunks[0].length,
        row_count: 1,
      },
    ],
    row_count: 1,
    size_bytes: chunks[0].length,
    numbering_floors: [
      { prefix: 'A', year: 2025, minimum: 1_000_000_000 },
      { prefix: 'F', year: 2026, minimum: 81 },
    ],
  });
  const bytes = new TextEncoder().encode(
    'Conditions\nAcompte 30 %\nÉchéance à 30 jours.',
  );
  const sha256 = await sha256Hex(bytes);
  return {
    id: crypto.randomUUID(),
    manifest,
    chunks,
    entries: [
      { path: 'attachments/conditions.txt', sha256, size_bytes: bytes.length },
    ],
    contents: new Map([[sha256, bytes]]),
  };
}
async function stage(f: Fixture, session = owner, withFiles = true) {
  await beginBootstrap(session, f.id, f.manifest);
  for (const [i, bytes] of f.chunks.entries())
    await uploadBootstrapChunk(session, f.id, i, request(bytes));
  const pages: Uint8Array[] = [];
  for (let offset = 0; offset < f.entries.length; offset += 200)
    pages.push(
      encode({ version: 2, files: f.entries.slice(offset, offset + 200) }),
    );
  if (withFiles) {
    await beginBusinessFiles(session, f.id, {
      format: 'zentra-business-files',
      version: 2,
      pages: await Promise.all(
        pages.map(async (b, i) => ({
          sha256: await sha256Hex(b),
          size_bytes: b.length,
          file_count: f.entries.slice(i * 200, (i + 1) * 200).length,
        })),
      ),
      file_count: f.entries.length,
      size_bytes: f.entries.reduce((n, e) => n + e.size_bytes, 0),
    });
    for (const [i, bytes] of pages.entries())
      await uploadBusinessFilePage(session, f.id, i, request(bytes));
    for (const [sha, bytes] of f.contents) {
      for (
        let offset = 0;
        offset < bytes.length;
        offset += BUSINESS_FILE_PART_BYTES
      ) {
        const part = bytes.slice(offset, offset + BUSINESS_FILE_PART_BYTES);
        await uploadBusinessFilePart(
          session,
          f.id,
          sha,
          offset / BUSINESS_FILE_PART_BYTES,
          request(part, await sha256Hex(part)),
        );
      }
      await verifyBusinessFile(session, f.id, sha);
    }
    await completeBusinessFiles(session, f.id);
  }
  return pages;
}
async function validate(id: string, session = owner) {
  let structure = await validateBootstrapStructure(session, id);
  for (let n = 0; n < 100 && structure.state === 'checking'; n++)
    structure = await validateBootstrapStructure(session, id);
  expect(structure).toMatchObject({ state: 'valid' });
  let integrity = await validateBootstrapIntegrity(session, id);
  for (
    let n = 0;
    n < 500 && !['valid', 'invalid'].includes(integrity.state);
    n++
  )
    integrity = await validateBootstrapIntegrity(session, id);
  expect(integrity).toMatchObject({ state: 'valid' });
  return integrity;
}
async function ready() {
  const f = await fixture();
  const pages = await stage(f);
  await validate(f.id);
  return { ...f, pages };
}
function unpublished() {
  expect(count('business_sync_publications')).toBe(0);
  expect(count('business_sync_number_floors')).toBe(0);
  expect(
    db.prepare('SELECT state,head_revision FROM business_sync_spaces').get(),
  ).toMatchObject({ state: 'initializing', head_revision: 0 });
}
it('publishes one immutable revision atomically, delivers original bytes to a colleague and retains historical numbering', async () => {
  const f = await ready();
  expect(await historyHead(second)).toEqual({
    state: 'uninitialized',
    head_revision: 0,
  });
  await expect(historyChunk(second, f.id, '0')).rejects.toMatchObject({
    status: 404,
  });
  const receipt = await publishBootstrap(owner, f.id);
  expect(receipt).toMatchObject({
    transfer_id: f.id,
    revision: 1,
    row_count: 1,
    file_count: 1,
    audit_entries: 0,
  });
  expect(await publishBootstrap(owner, f.id)).toEqual(receipt);
  expect(count('business_sync_publications')).toBe(1);
  expect((await historyHead(second)).receipt).toEqual(receipt);
  expect((await historyChunk(second, f.id, '0')).bytes).toEqual(f.chunks[0]);
  expect((await historyFilePage(second, f.id, '0')).bytes).toEqual(f.pages[0]);
  expect(
    (await historyFilePart(second, f.id, f.entries[0].sha256, '0')).bytes,
  ).toEqual(f.contents.get(f.entries[0].sha256));
  expect(
    (
      await reserveDocumentNumbers(second, {
        request_id: crypto.randomUUID(),
        prefix: 'F',
        year: 2026,
        minimum: 1,
        count: 5,
      })
    ).start_value,
  ).toBe(81);
  await expect(
    reserveDocumentNumbers(second, {
      request_id: crypto.randomUUID(),
      prefix: 'A',
      year: 2025,
      minimum: 1,
      count: 1,
    }),
  ).rejects.toMatchObject({ status: 409 });
  const objects = [...blobs.keys()];
  await expect(abandonBootstrap(owner, f.id)).rejects.toMatchObject({
    status: 409,
  });
  expect([...blobs.keys()]).toEqual(objects);
});
it('recovers a lost publication response and simultaneous retries without changing the original receipt', async () => {
  const f = await ready();
  const results = await Promise.all(
    Array.from({ length: 4 }, () => publishBootstrap(owner, f.id)),
  );
  for (const r of results) expect(r).toEqual(results[0]);
  expect(count('business_sync_publications')).toBe(1);
  expect(count('business_sync_number_floors')).toBe(2);
});
it('rolls back the receipt and counters when committing fails, then retries successfully', async () => {
  const f = await ready();
  failStatement = (sql) => {
    if (sql.startsWith("UPDATE business_sync_transfers SET state='committed'"))
      throw new Error('D1 interrupted');
  };
  await expect(publishBootstrap(owner, f.id)).rejects.toThrow('D1 interrupted');
  unpublished();
  failStatement = undefined;
  expect((await publishBootstrap(owner, f.id)).revision).toBe(1);
});
it('cancellation winning before the atomic batch cannot publish or reserve numbers', async () => {
  const f = await ready();
  beforeBatch = async (sql) => {
    if (sql[0].includes('INSERT OR IGNORE INTO business_sync_publications')) {
      beforeBatch = undefined;
      await abandonBootstrap(owner, f.id);
    }
  };
  await expect(publishBootstrap(owner, f.id)).rejects.toMatchObject({
    status: 409,
  });
  expect(count('business_sync_publications')).toBe(0);
  expect(count('business_sync_number_floors')).toBe(0);
  expect(blobs.size).toBe(0);
  expect(await historyHead(second)).toEqual({
    state: 'uninitialized',
    head_revision: 0,
  });
});
it.each(['checks', 'file'])(
  'rechecks %s inside the transaction after preflight',
  async (kind) => {
    const f = await ready();
    beforeBatch = async (sql) => {
      if (sql[0].includes('INSERT OR IGNORE INTO business_sync_publications')) {
        beforeBatch = undefined;
        db.exec(
          kind === 'checks'
            ? "UPDATE business_sync_integrity_checks SET state='accounting'"
            : 'UPDATE business_sync_file_blobs SET verified_at=NULL',
        );
      }
    };
    await expect(publishBootstrap(owner, f.id)).rejects.toMatchObject({
      status: 409,
    });
    unpublished();
  },
);
it('limits publication to the original owner/admin device, allows authorized reads and isolates other companies', async () => {
  const f = await ready();
  for (const session of [
    second,
    { ...second, role: 'read_only' as const },
    { ...owner, installationId: 'other-pc' },
    { ...owner, organizationId: 'org_other' },
  ])
    await expect(publishBootstrap(session, f.id)).rejects.toThrow();
  unpublished();
  await publishBootstrap(owner, f.id);
  expect(
    await publishedHistory({ ...second, organizationId: 'org_other' }, f.id),
  ).toBeNull();
  await expect(
    historyFilePart(
      { ...second, organizationId: 'org_other' },
      f.id,
      f.entries[0].sha256,
      '0',
    ),
  ).rejects.toMatchObject({ status: 404 });
  mocks.session.mockResolvedValue({ ...second, role: 'read_only' });
  const result = await historyHttp.GET(
    new Request(
      `https://test.invalid/api/sync/history?kind=rows&transfer_id=${f.id}&index=0`,
    ),
  );
  expect(result.status).toBe(200);
  expect(result.headers.get('cache-control')).toContain('no-store');
  expect(new Uint8Array(await result.arrayBuffer())).toEqual(f.chunks[0]);
  expect(
    (
      await publishHttp.POST(
        new Request('https://test.invalid/api/sync/bootstrap/publish', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ transfer_id: f.id }),
        }),
      )
    ).status,
  ).toBe(403);
});
it('requires a complete modern history and linked files before publication', async () => {
  const f = await fixture();
  await stage(f, owner, false);
  await expect(publishBootstrap(owner, f.id)).rejects.toMatchObject({
    status: 409,
  });
  await validate(f.id);
  await expect(publishBootstrap(owner, f.id)).rejects.toMatchObject({
    status: 409,
  });
  unpublished();
});
it('rejects missing referenced company logos even when all received files are verified', async () => {
  const f = await ready();
  // Model a changed reference after preflight; the final atomic file-link guard
  // must still protect the published revision.
  beforeBatch = async (sql) => {
    if (sql[0].includes('INSERT OR IGNORE INTO business_sync_publications')) {
      beforeBatch = undefined;
      db.exec(
        "UPDATE business_sync_versions SET row_json=json_set(row_json,'$.logo_path','C:/old/branding/missing.png') WHERE table_name='settings'",
      );
    }
  };
  await expect(publishBootstrap(owner, f.id)).rejects.toMatchObject({
    status: 409,
  });
  unpublished();
});
it('keeps old row manifests stageable but refuses to publish them without historical counter evidence', async () => {
  const f = await fixture();
  const legacy = { ...f.manifest, version: 1 };
  delete legacy.numbering_floors;
  f.manifest = await bootstrapManifest(legacy);
  await stage(f);
  await validate(f.id);
  await expect(publishBootstrap(owner, f.id)).rejects.toMatchObject({
    status: 409,
  });
  unpublished();
});
it('executes publication, counter reservation and second-device reads using the real D1 runtime', async () => {
  const require = createRequire(import.meta.url);
  const { Miniflare } = createRequire(require.resolve('wrangler'))('miniflare');
  const runtime = new Miniflare({
    modules: true,
    script:
      'export default {fetch(){return new Response("Canonical D1 test")}}',
    d1Databases: ['DB'],
    compatibilityDate: '2026-05-15',
  });
  try {
    const d1: D1Database = await runtime.getD1Database('DB');
    const folder = new URL('../drizzle/', import.meta.url);
    for (const name of readdirSync(folder)
      .filter((n) => n.endsWith('.sql'))
      .sort()) {
      const statements = readFileSync(new URL(name, folder), 'utf8')
        .split('--> statement-breakpoint')
        .map((sql) => sql.trim())
        .filter(Boolean);
      await d1.batch(statements.map((sql) => d1.prepare(sql)));
    }
    await d1.batch([
      d1.prepare(
        "INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at) VALUES('sub','cus','price','active',2000000000,0,1)",
      ),
      d1.prepare(
        "INSERT INTO organizations VALUES('org_first','First','sub','owner',1,1)",
      ),
    ]);
    mocks.db.mockReturnValue(d1);
    const f = await fixture(),
      pages = await stage(f);
    await validate(f.id);
    const receipt = await publishBootstrap(owner, f.id);
    expect(await publishBootstrap(owner, f.id)).toEqual(receipt);
    expect((await historyChunk(second, f.id, '0')).bytes).toEqual(f.chunks[0]);
    expect((await historyFilePage(second, f.id, '0')).bytes).toEqual(pages[0]);
    expect(
      (
        await reserveDocumentNumbers(second, {
          request_id: crypto.randomUUID(),
          prefix: 'F',
          year: 2026,
          minimum: 1,
          count: 1,
        })
      ).start_value,
    ).toBe(81);
  } finally {
    await runtime.dispose();
  }
}, 60_000);
it.each(['rows', 'catalogue', 'binary'])(
  'detects altered or missing %s on a second device',
  async (kind) => {
    const f = await ready();
    await publishBootstrap(owner, f.id);
    const key = [...blobs.keys()].find((k) =>
      kind === 'rows'
        ? !k.includes('/files/')
        : kind === 'catalogue'
          ? k.includes('/files/catalogue/')
          : k.endsWith(`/${f.entries[0].sha256}/0`),
    )!;
    const read = () =>
      kind === 'rows'
        ? historyChunk(second, f.id, '0')
        : kind === 'catalogue'
          ? historyFilePage(second, f.id, '0')
          : historyFilePart(second, f.id, f.entries[0].sha256, '0');
    const wrong = Uint8Array.from(blobs.get(key)!);
    wrong[0] ^= 1;
    blobs.set(key, wrong);
    await expect(read()).rejects.toMatchObject({ status: 503 });
    blobs.delete(key);
    await expect(read()).rejects.toMatchObject({ status: 503 });
  },
);
it('requires a valid session on every public history endpoint', async () => {
  mocks.session.mockRejectedValue(
    new AccountPublicError('Connexion requise.', 401),
  );
  for (const [method, call] of [
    ['GET', historyHttp.GET],
    ['GET', fileHttp.GET],
    ['POST', publishHttp.POST],
  ] as const) {
    const r = await call(new Request('https://test.invalid/api', { method }));
    expect(r.status).toBe(401);
    expect(r.headers.get('cache-control')).toContain('no-store');
  }
  expect(mocks.files).not.toHaveBeenCalled();
});
it.skipIf(!process.env.ZENTRA_CANONICAL_QA)(
  'publishes the real native supplier/accounting history and delivers all exact chunks, documents and exports to a second account',
  async () => {
    const folder = process.env.ZENTRA_CANONICAL_QA!;
    const native = JSON.parse(
      readFileSync(join(folder, 'prepared.json'), 'utf8'),
    );
    const session = { ...owner, installationId: native.installation_id };
    const f: Fixture = {
      id: native.transfer_id,
      manifest: native.manifest,
      entries: native.files,
      chunks: native.manifest.chunks.map((_: unknown, i: number) =>
        Uint8Array.from(
          readFileSync(
            join(folder, 'rows', `${i.toString().padStart(4, '0')}.json`),
          ),
        ),
      ),
      contents: new Map(
        native.files.map((e: Entry) => [
          e.sha256,
          Uint8Array.from(readFileSync(join(folder, 'files', e.sha256))),
        ]),
      ),
    };
    const pages = await stage(f, session);
    const integrity = await validate(f.id, session);
    const receipt = await publishBootstrap(session, f.id);
    const output = process.env.ZENTRA_CANONICAL_DOWNLOAD_OUTPUT;
    if (output) {
      mkdirSync(output);
      for (const name of ['rows', 'catalogue', 'files'])
        mkdirSync(join(output, name));
      writeFileSync(
        join(output, 'history.json'),
        JSON.stringify(await historyHead(second)),
        { flag: 'wx' },
      );
      for (const [i] of f.chunks.entries())
        writeFileSync(
          join(output, 'rows', `${i.toString().padStart(4, '0')}.json`),
          (await historyChunk(second, f.id, String(i))).bytes,
          { flag: 'wx' },
        );
      for (const [i] of pages.entries())
        writeFileSync(
          join(output, 'catalogue', `${i.toString().padStart(4, '0')}.json`),
          (await historyFilePage(second, f.id, String(i))).bytes,
          { flag: 'wx' },
        );
      for (const [sha, bytes] of f.contents) {
        const parts: Uint8Array[] = [];
        for (
          let offset = 0;
          offset < bytes.length;
          offset += BUSINESS_FILE_PART_BYTES
        )
          parts.push(
            (
              await historyFilePart(
                second,
                f.id,
                sha,
                String(offset / BUSINESS_FILE_PART_BYTES),
              )
            ).bytes,
          );
        writeFileSync(join(output, 'files', sha), Buffer.concat(parts), {
          flag: 'wx',
        });
      }
    }
    expect(receipt.audit_entries).toBe(1087);
    expect(receipt.last_audit_hash).toBe(integrity.last_audit_hash);
    for (const [i, bytes] of f.chunks.entries())
      expect((await historyChunk(second, f.id, String(i))).bytes).toEqual(
        bytes,
      );
    for (const [i, bytes] of pages.entries())
      expect((await historyFilePage(second, f.id, String(i))).bytes).toEqual(
        bytes,
      );
    for (const [sha, bytes] of f.contents) {
      const received: Uint8Array[] = [];
      for (
        let offset = 0;
        offset < bytes.length;
        offset += BUSINESS_FILE_PART_BYTES
      )
        received.push(
          (
            await historyFilePart(
              second,
              f.id,
              sha,
              String(offset / BUSINESS_FILE_PART_BYTES),
            )
          ).bytes,
        );
      expect(Buffer.concat(received)).toEqual(Buffer.from(bytes));
    }
    expect(
      (
        await reserveDocumentNumbers(second, {
          request_id: crypto.randomUUID(),
          prefix: 'J',
          year: 2026,
          minimum: 1,
          count: 1,
        })
      ).start_value,
    ).toBe(41);
  },
  60_000,
);
