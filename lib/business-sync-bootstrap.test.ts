import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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
import { DELETE, GET, POST, PUT } from '../app/api/sync/bootstrap/route';
import { AccountPublicError, sha256Hex } from './account-security';
import { validateBootstrapStructure } from './business-sync-validation';
import { validateBootstrapIntegrity } from './business-sync-integrity';
import {
  abandonBootstrap,
  beginBootstrap,
  bootstrapManifest,
  bootstrapStatus,
  businessSyncContractHash,
  uploadBootstrapChunk,
} from './business-sync-bootstrap';

let db: DatabaseSync;
let blobs: Map<string, Uint8Array>;
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
type Scalar = string | number | null;
function prepared(sql: string) {
  let values: Scalar[] = [];
  const result = {
    bind: (...args: Scalar[]) => {
      values = args;
      return result;
    },
    execute: () => ({
      meta: { changes: Number(db.prepare(sql).run(...values).changes) },
    }),
    run: async () => result.execute(),
    first: async () => db.prepare(sql).get(...values) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...values) }),
  };
  return result;
}
beforeEach(() => {
  vi.clearAllMocks();
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  const folder = new URL('../drizzle/', import.meta.url);
  for (const file of readdirSync(folder)
    .filter((name) => name.endsWith('.sql'))
    .sort())
    db.exec(readFileSync(new URL(file, folder), 'utf8'));
  db.exec(
    "INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at) VALUES('sub','cus','price','active',2000000000,0,1),('sub2','cus2','price','active',2000000000,0,1); INSERT INTO organizations VALUES('org_first','First','sub','owner',1,1),('org_other','Other','sub2','other',1,1)",
  );
  mocks.db.mockReturnValue({
    prepare: prepared,
    batch: async (statements: ReturnType<typeof prepared>[]) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map((statement) => statement.execute());
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
    put: vi.fn(async (key: string, bytes: Uint8Array) => {
      blobs.set(key, Uint8Array.from(bytes));
      return {};
    }),
    delete: vi.fn(async (keys: string | string[]) => {
      for (const key of typeof keys === 'string' ? [keys] : keys)
        blobs.delete(key);
    }),
    list: vi.fn(async ({ prefix }: { prefix: string }) => ({
      objects: [...blobs.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key })),
      truncated: false,
    })),
  });
  mocks.session.mockResolvedValue(owner);
});
afterEach(() => db.close());

it.skipIf(!process.env.ZENTRA_NATIVE_BOOTSTRAP_QA)(
  'accepts the actual native frozen bootstrap and preserves every original row byte for byte',
  async () => {
    const folder = process.env.ZENTRA_NATIVE_BOOTSTRAP_QA!;
    const prepared = JSON.parse(
      readFileSync(join(folder, 'prepared.json'), 'utf8'),
    );
    const session = { ...owner, installationId: prepared.installation_id };
    expect(prepared.organization_id).toBe(session.organizationId);
    expect(prepared.manifest.contract_sha256).toBe(
      await businessSyncContractHash(),
    );
    expect(prepared.manifest.tables.clients).toBe(204);
    expect(prepared.manifest.tables.invoices).toBe(1);
    expect(prepared.manifest.tables.payments).toBe(1);
    expect(prepared.manifest.tables.journal_entries).toBe(2);
    expect(prepared.manifest.tables.journal_lines).toBe(4);
    expect(prepared.files).toHaveLength(1);
    await beginBootstrap(session, prepared.transfer_id, prepared.manifest);
    for (let index = 0; index < prepared.manifest.chunks.length; index++) {
      const bytes = Uint8Array.from(
        readFileSync(
          join(folder, 'rows', `${index.toString().padStart(4, '0')}.json`),
        ),
      );
      await uploadBootstrapChunk(
        session,
        prepared.transfer_id,
        index,
        uploadRequest(bytes),
      );
      // A lost response repeats exactly the durable native chunk.
      await uploadBootstrapChunk(
        session,
        prepared.transfer_id,
        index,
        uploadRequest(bytes),
      );
      for (const row of JSON.parse(new TextDecoder().decode(bytes)).rows) {
        const stored = db
          .prepare(
            'SELECT row_json,row_sha256 FROM business_sync_versions WHERE transfer_id=? AND table_name=? AND row_key_json=?',
          )
          .get(prepared.transfer_id, row.table, row.key_json);
        expect(stored).toMatchObject({
          row_json: row.row_json,
          row_sha256: await sha256Hex(row.row_json),
        });
      }
    }
    expect(count('business_sync_versions')).toBe(prepared.manifest.row_count);
    expect(
      db
        .prepare(
          "SELECT SUM(json_extract(row_json,'$.debit_cents')) AS debit,SUM(json_extract(row_json,'$.credit_cents')) AS credit FROM business_sync_versions WHERE transfer_id=? AND table_name='journal_lines'",
        )
        .get(prepared.transfer_id),
    ).toMatchObject({ debit: 130000, credit: 130000 });
    expect(await bootstrapStatus(session, prepared.transfer_id)).toMatchObject({
      state: 'uploaded',
      replication_active: false,
    });
    expect(
      db
        .prepare(
          'SELECT state,head_revision FROM business_sync_spaces WHERE organization_id=?',
        )
        .get(session.organizationId),
    ).toMatchObject({ state: 'initializing', head_revision: 0 });
    let checked = await validateBootstrapStructure(
      session,
      prepared.transfer_id,
    );
    for (
      let attempt = 0;
      attempt < 100 && checked.state === 'checking';
      attempt++
    )
      checked = await validateBootstrapStructure(session, prepared.transfer_id);
    expect(checked).toMatchObject({
      state: 'valid',
      replication_active: false,
    });
    let integrity = await validateBootstrapIntegrity(
      session,
      prepared.transfer_id,
    );
    for (
      let attempt = 0;
      attempt < 100 && !['valid', 'invalid'].includes(integrity.state);
      attempt++
    )
      integrity = await validateBootstrapIntegrity(
        session,
        prepared.transfer_id,
      );
    expect(integrity).toMatchObject({
      state: 'valid',
      verified_audit_entries: prepared.manifest.tables.audit_log,
      replication_active: false,
    });
    expect(count('business_sync_integrity_checks')).toBe(1);
    expect(count('business_sync_audit_nodes')).toBe(
      prepared.manifest.tables.audit_log,
    );
    await abandonBootstrap(session, prepared.transfer_id);
    expect(count('business_sync_integrity_checks')).toBe(0);
    expect(count('business_sync_audit_nodes')).toBe(0);
  },
);

it('cancels only the selected unpublished preparation and permits a new generation from another administrator device', async () => {
  const f = await fixture();
  await beginBootstrap(owner, f.id, f.manifest);
  await uploadBootstrapChunk(owner, f.id, 0, uploadRequest(f.bytes[0]));
  const cancelled = await abandonBootstrap(
    { ...owner, role: 'admin', installationId: 'replacement' },
    f.id,
  );
  expect(cancelled.state).toBe('abandoned');
  expect(count('business_sync_spaces')).toBe(0);
  expect(count('business_sync_versions')).toBe(0);
  expect(count('business_sync_transfer_chunks')).toBe(0);
  expect(count('business_sync_structural_checks')).toBe(0);
  expect(blobs.size).toBe(0);
  await expect(beginBootstrap(owner, f.id, f.manifest)).rejects.toMatchObject({
    status: 409,
  });
  expect(count('business_sync_spaces')).toBe(0);
  const next = await beginBootstrap(owner, crypto.randomUUID(), f.manifest);
  await abandonBootstrap(owner, f.id);
  expect(count('business_sync_spaces')).toBe(1);
  expect(
    db.prepare('SELECT bootstrap_transfer_id FROM business_sync_spaces').get()!
      .bootstrap_transfer_id,
  ).toBe(next.transfer_id);
  await expect(
    uploadBootstrapChunk(owner, f.id, 0, uploadRequest(f.bytes[0])),
  ).rejects.toMatchObject({ status: 409 });
});

it('removes structural receipts when a fully uploaded preparation is cancelled', async () => {
  const f = await fixture();
  await beginBootstrap(owner, f.id, f.manifest);
  for (let index = 0; index < f.bytes.length; index++)
    await uploadBootstrapChunk(
      owner,
      f.id,
      index,
      uploadRequest(f.bytes[index]),
    );
  await validateBootstrapStructure(owner, f.id);
  expect(count('business_sync_structural_checks')).toBe(1);
  await abandonBootstrap(owner, f.id);
  expect(count('business_sync_structural_checks')).toBe(0);
});

it('resumes failed cancellation cleanup and does not free the organization until cleanup completes', async () => {
  const f = await fixture();
  await beginBootstrap(owner, f.id, f.manifest);
  await uploadBootstrapChunk(owner, f.id, 0, uploadRequest(f.bytes[0]));
  mocks
    .files()
    .delete.mockRejectedValueOnce(new Error('storage cleanup unavailable'));
  await expect(abandonBootstrap(owner, f.id)).rejects.toThrow(
    'cleanup unavailable',
  );
  expect((await bootstrapStatus(owner, f.id)).state).toBe('abandoning');
  await expect(
    beginBootstrap(owner, crypto.randomUUID(), f.manifest),
  ).rejects.toMatchObject({ status: 409 });
  expect((await abandonBootstrap(owner, f.id)).state).toBe('abandoned');
  expect(blobs.size).toBe(0);
});

it('cleans a late in-flight upload instead of reviving an abandoned generation', async () => {
  const f = await fixture();
  await beginBootstrap(owner, f.id, f.manifest);
  let entered!: () => void;
  let release!: () => void;
  const writing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    release = resolve;
  });
  mocks
    .files()
    .put.mockImplementationOnce(async (key: string, bytes: Uint8Array) => {
      entered();
      await resumed;
      blobs.set(key, Uint8Array.from(bytes));
      return {};
    });
  const late = uploadBootstrapChunk(owner, f.id, 0, uploadRequest(f.bytes[0]));
  await writing;
  await abandonBootstrap(owner, f.id);
  release();
  await expect(late).rejects.toMatchObject({ status: 409 });
  expect(blobs.size).toBe(0);
  expect(count('business_sync_versions')).toBe(0);
  expect(count('business_sync_spaces')).toBe(0);
});

it('cannot cancel a foreign or committed history and keeps the HTTP cancellation role gate', async () => {
  const f = await fixture();
  await beginBootstrap(owner, f.id, f.manifest);
  await uploadBootstrapChunk(owner, f.id, 0, uploadRequest(f.bytes[0]));
  await expect(
    abandonBootstrap({ ...owner, organizationId: 'org_other' }, f.id),
  ).rejects.toMatchObject({ status: 404 });
  mocks.session.mockResolvedValue({ ...owner, role: 'member' });
  expect(
    (
      await DELETE(
        new Request(
          `https://zentra.test/api/sync/bootstrap?transfer_id=${f.id}`,
          { method: 'DELETE' },
        ),
      )
    ).status,
  ).toBe(403);
  db.exec(
    "UPDATE business_sync_transfers SET state='committed',revision=1; UPDATE business_sync_spaces SET state='ready',head_revision=1",
  );
  await expect(abandonBootstrap(owner, f.id)).rejects.toMatchObject({
    status: 409,
  });
  expect(blobs.size).toBe(1);
  expect(count('business_sync_versions')).toBe(1);
  expect(mocks.files().delete).not.toHaveBeenCalled();
});

const rules = contract.tables as Record<
  string,
  { key: string[]; columns: string[] }
>;
function row(table: string, patch: Record<string, Scalar>) {
  const data = Object.fromEntries(
    rules[table].columns.map((field) => [field, patch[field] ?? null]),
  );
  return {
    table,
    key_json: JSON.stringify(rules[table].key.map((field) => data[field])),
    row_json: JSON.stringify(data),
  };
}
function settings() {
  return row('settings', {
    id: 1,
    onboarding_completed: 1,
    company_name: 'Société fictive',
    currency: 'CHF',
  });
}
function client(id = 'client-1') {
  return row('clients', {
    id,
    name: 'Client fictif',
    notes: 'Conditions :\nDeuxième ligne 🏗️',
    created_at: '2026-09-08',
    updated_at: '2026-09-08',
  });
}
async function fixture(groups = [[settings()], [client()]]) {
  const bytes = groups.map((rows) =>
    new TextEncoder().encode(JSON.stringify({ version: 1, rows })),
  );
  const counts = Object.fromEntries(
    Object.keys(rules).map((table) => [table, 0]),
  );
  for (const group of groups) for (const row of group) counts[row.table]++;
  const chunks = await Promise.all(
    bytes.map(async (part, index) => ({
      sha256: await sha256Hex(part),
      size_bytes: part.length,
      row_count: groups[index].length,
    })),
  );
  const manifest = {
    format: 'zentra-business-bootstrap',
    version: 1,
    schema_version: 60,
    contract_sha256: await businessSyncContractHash(),
    tables: counts,
    chunks,
    size_bytes: bytes.reduce((sum, part) => sum + part.length, 0),
    row_count: groups.flat().length,
  };
  return { id: crypto.randomUUID(), bytes, manifest };
}
function uploadRequest(bytes: Uint8Array<ArrayBuffer>) {
  return new Request('https://zentra.test/api/sync/bootstrap', {
    method: 'PUT',
    body: bytes,
  });
}
function count(table: string) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count;
}

it('stages the exact rows durably, resumes missing chunks and never activates replication on receipt alone', async () => {
  const f = await fixture();
  const begun = await beginBootstrap(owner, f.id, f.manifest);
  expect(begun.state).toBe('uploading');
  const first = await uploadBootstrapChunk(
    owner,
    f.id,
    0,
    uploadRequest(f.bytes[0]),
  );
  expect(first.uploaded_chunks.map((part) => part.chunk_index)).toEqual([0]);
  // A fresh request has no in-memory continuation state.
  const resumed = await beginBootstrap(owner, f.id, f.manifest);
  expect(resumed.generation).toBe(begun.generation);
  expect(resumed.uploaded_chunks).toEqual(first.uploaded_chunks);
  const finished = await uploadBootstrapChunk(
    owner,
    f.id,
    1,
    uploadRequest(f.bytes[1]),
  );
  expect(finished).toMatchObject({
    state: 'uploaded',
    replication_active: false,
  });
  expect(count('business_sync_versions')).toBe(2);
  expect(count('business_sync_transfer_chunks')).toBe(2);
  expect(blobs.size).toBe(2);
  expect(
    db.prepare('SELECT state,head_revision FROM business_sync_spaces').get(),
  ).toMatchObject({ state: 'initializing', head_revision: 0 });
  expect(
    db
      .prepare(
        'SELECT row_json,row_sha256 FROM business_sync_versions WHERE table_name=?',
      )
      .get('clients'),
  ).toMatchObject({
    row_json: client().row_json,
    row_sha256: await sha256Hex(client().row_json),
  });
  expect(count('document_number_reservations')).toBe(0);
});

it('preserves SQLite REAL representations and embedded JSON text without changing the conflict hash', async () => {
  const item = row('invoice_items', {
    id: 'line-1',
    invoice_id: 'invoice-1',
    quantity: 1,
    unit_price_cents: 1000,
  });
  item.row_json = item.row_json.replace('"quantity":1', '"quantity":1.0');
  const f = await fixture([[settings(), item]]);
  await beginBootstrap(owner, f.id, f.manifest);
  await uploadBootstrapChunk(owner, f.id, 0, uploadRequest(f.bytes[0]));
  const stored = db
    .prepare(
      "SELECT row_json,row_sha256 FROM business_sync_versions WHERE table_name='invoice_items'",
    )
    .get()!;
  expect(stored.row_json).toBe(item.row_json);
  expect(stored.row_sha256).toBe(await sha256Hex(item.row_json));
  expect(stored.row_sha256).not.toBe(
    await sha256Hex(JSON.stringify(JSON.parse(item.row_json))),
  );
});

it('accepts a full 200-row fragment and still bounds the streamed HTTP body before storing it', async () => {
  const f = await fixture([
    [
      settings(),
      ...Array.from({ length: 199 }, (_, index) => client(`client-${index}`)),
    ],
  ]);
  await beginBootstrap(owner, f.id, f.manifest);
  const overflow = new Uint8Array(f.bytes[0].length + 1);
  overflow.set(f.bytes[0]);
  await expect(
    uploadBootstrapChunk(owner, f.id, 0, uploadRequest(overflow)),
  ).rejects.toMatchObject({ status: 413 });
  expect(count('business_sync_versions')).toBe(0);
  expect(
    (await uploadBootstrapChunk(owner, f.id, 0, uploadRequest(f.bytes[0])))
      .state,
  ).toBe('uploaded');
  expect(count('business_sync_versions')).toBe(200);
});

it('handles competing initializers atomically and repeated lost responses without changing the winning generation', async () => {
  const f = await fixture();
  const outcomes = await Promise.allSettled([
    beginBootstrap(owner, f.id, f.manifest),
    beginBootstrap(
      { ...owner, installationId: 'second-pc' },
      crypto.randomUUID(),
      f.manifest,
    ),
  ]);
  expect(
    outcomes.filter((result) => result.status === 'fulfilled'),
  ).toHaveLength(1);
  expect(count('business_sync_spaces')).toBe(1);
  expect(count('business_sync_transfers')).toBe(1);
  const winner = await bootstrapStatus(owner, f.id);
  const repeated = await Promise.all(
    Array.from({ length: 4 }, () => beginBootstrap(owner, f.id, f.manifest)),
  );
  expect(
    repeated.every((result) => result.generation === winner.generation),
  ).toBe(true);
  const uploads = await Promise.all(
    Array.from({ length: 4 }, () =>
      uploadBootstrapChunk(owner, f.id, 0, uploadRequest(f.bytes[0])),
    ),
  );
  expect(uploads.every((result) => result.uploaded_chunks.length === 1)).toBe(
    true,
  );
  expect(count('business_sync_versions')).toBe(1);
});

it('rejects altered manifests, foreign companies and foreign installations without leaving an orphan initialization', async () => {
  const f = await fixture();
  await beginBootstrap(owner, f.id, f.manifest);
  const changed = await fixture([[settings()], [client('different')]]);
  await expect(
    beginBootstrap(owner, f.id, changed.manifest),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    bootstrapStatus({ ...owner, installationId: 'other-pc' }, f.id),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    bootstrapStatus({ ...owner, organizationId: 'org_other' }, f.id),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    beginBootstrap({ ...owner, organizationId: 'org_other' }, f.id, f.manifest),
  ).rejects.toThrow();
  expect(count('business_sync_spaces')).toBe(1);
  expect(count('business_sync_transfers')).toBe(1);
});

it('refuses damaged or truncated bytes before blob and database writes', async () => {
  const f = await fixture();
  await beginBootstrap(owner, f.id, f.manifest);
  const changed = Uint8Array.from(f.bytes[0]);
  changed[0] ^= 1;
  await expect(
    uploadBootstrapChunk(owner, f.id, 0, uploadRequest(changed)),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    uploadBootstrapChunk(owner, f.id, 0, uploadRequest(f.bytes[0].slice(1))),
  ).rejects.toMatchObject({ status: 409 });
  expect(blobs.size).toBe(0);
  expect(count('business_sync_versions')).toBe(0);
});

it('rolls back an entire chunk when a later row repeats a key from an earlier chunk', async () => {
  const f = await fixture([
    [settings(), client()],
    [client('new-client'), client()],
  ]);
  await beginBootstrap(owner, f.id, f.manifest);
  await uploadBootstrapChunk(owner, f.id, 0, uploadRequest(f.bytes[0]));
  await expect(
    uploadBootstrapChunk(owner, f.id, 1, uploadRequest(f.bytes[1])),
  ).rejects.toMatchObject({ status: 409 });
  expect(count('business_sync_versions')).toBe(2);
  expect(count('business_sync_transfer_chunks')).toBe(1);
  expect(
    db
      .prepare(
        'SELECT COUNT(*) AS count FROM business_sync_versions WHERE row_key_json=\'["new-client"]\'',
      )
      .get()!.count,
  ).toBe(0);
});

it('enforces declared table counts inside the batch transaction', async () => {
  const f = await fixture([[settings(), client()], [client('second')]]);
  f.manifest.tables.clients = 1;
  f.manifest.tables.projects = 1;
  await beginBootstrap(owner, f.id, f.manifest);
  await uploadBootstrapChunk(owner, f.id, 0, uploadRequest(f.bytes[0]));
  await expect(
    uploadBootstrapChunk(owner, f.id, 1, uploadRequest(f.bytes[1])),
  ).rejects.toMatchObject({ status: 409 });
  expect(count('business_sync_versions')).toBe(2);
  expect((await bootstrapStatus(owner, f.id)).state).toBe('uploading');
});

it('retries after a storage outage and repairs a lost sealing response from durable receipts', async () => {
  const f = await fixture([[settings(), client()]]);
  await beginBootstrap(owner, f.id, f.manifest);
  mocks
    .files()
    .put.mockRejectedValueOnce(new Error('temporary storage outage'));
  await expect(
    uploadBootstrapChunk(owner, f.id, 0, uploadRequest(f.bytes[0])),
  ).rejects.toThrow('storage outage');
  expect(count('business_sync_versions')).toBe(0);
  await uploadBootstrapChunk(owner, f.id, 0, uploadRequest(f.bytes[0]));
  db.exec("UPDATE business_sync_transfers SET state='uploading'");
  const retry = await uploadBootstrapChunk(
    owner,
    f.id,
    0,
    uploadRequest(f.bytes[0]),
  );
  expect(retry.state).toBe('uploaded');
  expect(count('business_sync_versions')).toBe(2);
  db.exec("UPDATE business_sync_transfer_chunks SET sha256='corrupted'");
  await expect(
    uploadBootstrapChunk(owner, f.id, 0, uploadRequest(f.bytes[0])),
  ).rejects.toMatchObject({ status: 409 });
});

it.each([
  'unknown',
  'local',
  'missing',
  'key',
  'duplicate-field',
  'surrogate',
  'unsafe-number',
])(
  'rejects invalid or private row content (%s) before retaining data',
  async (kind) => {
    const item = client();
    if (kind === 'unknown') item.table = 'not_a_business_table';
    if (kind === 'local') item.table = 'license_state';
    if (kind === 'missing') item.row_json = JSON.stringify({ id: 'client-1' });
    if (kind === 'key') item.key_json = '["another"]';
    if (kind === 'duplicate-field')
      item.row_json = item.row_json.replace(
        '"id":',
        '"id":"first","\\u0069d":',
      );
    if (kind === 'surrogate')
      item.row_json = item.row_json.replace('Client fictif', '\\ud800');
    if (kind === 'unsafe-number')
      item.row_json = item.row_json.replace(
        '"name":"Client fictif"',
        '"name":9007199254740992',
      );
    const f = await fixture([[settings()], [client()]]);
    f.bytes[1] = new TextEncoder().encode(
      JSON.stringify({ version: 1, rows: [item] }),
    );
    f.manifest.chunks[1] = {
      sha256: await sha256Hex(f.bytes[1]),
      size_bytes: f.bytes[1].length,
      row_count: 1,
    };
    f.manifest.size_bytes = f.bytes[0].length + f.bytes[1].length;
    await beginBootstrap(owner, f.id, f.manifest);
    await expect(
      uploadBootstrapChunk(owner, f.id, 1, uploadRequest(f.bytes[1])),
    ).rejects.toMatchObject({ status: 400 });
    expect(blobs.size).toBe(0);
    expect(count('business_sync_versions')).toBe(0);
  },
);

it('rejects unsupported, incomplete and oversized manifests without creating an organization binding', async () => {
  const f = await fixture();
  for (const patch of [
    { contract_sha256: '0'.repeat(64) },
    { schema_version: 59 },
    { row_count: 3 },
    { tables: { settings: 1 } },
    { chunks: [{ ...f.manifest.chunks[0], size_bytes: 99_000_000 }] },
  ]) {
    await expect(
      bootstrapManifest({ ...f.manifest, ...patch }),
    ).rejects.toThrow();
  }
  expect(count('business_sync_spaces')).toBe(0);
});

it('applies authenticated role, company, installation, body limits and no-store HTTP behavior', async () => {
  const f = await fixture();
  const create = () =>
    new Request('https://zentra.test/api/sync/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transfer_id: f.id,
        manifest: f.manifest,
        organization_id: 'org_other',
        installation_id: 'forged',
      }),
    });
  for (const role of ['member', 'accountant', 'read_only']) {
    mocks.session.mockResolvedValue({ ...owner, role });
    expect((await POST(create())).status).toBe(403);
  }
  expect(count('business_sync_spaces')).toBe(0);
  mocks.session.mockResolvedValue({ ...owner, role: 'admin' });
  const response = await POST(create());
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toContain('no-store');
  expect(await response.json()).toMatchObject({
    organization_id: owner.organizationId,
    installation_id: owner.installationId,
  });
  const status = await GET(
    new Request(`https://zentra.test/api/sync/bootstrap?transfer_id=${f.id}`),
  );
  expect(status.status).toBe(200);
  const upload = await PUT(
    new Request(
      `https://zentra.test/api/sync/bootstrap?transfer_id=${f.id}&chunk=0`,
      { method: 'PUT', body: f.bytes[0] },
    ),
  );
  expect(upload.status).toBe(200);
  expect(
    (
      await PUT(
        new Request(
          `https://zentra.test/api/sync/bootstrap?transfer_id=${f.id}&chunk=0.5`,
          { method: 'PUT' },
        ),
      )
    ).status,
  ).toBe(400);
  mocks.session.mockRejectedValue(new AccountPublicError('revoked', 401));
  expect((await POST(create())).status).toBe(401);
  mocks.session.mockRejectedValue(new AccountPublicError('expired', 402));
  expect(
    (
      await GET(
        new Request(
          `https://zentra.test/api/sync/bootstrap?transfer_id=${f.id}`,
        ),
      )
    ).status,
  ).toBe(402);
});
