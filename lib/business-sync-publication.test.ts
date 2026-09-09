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
import {
  beginBusinessTransaction,
  businessTransactionStatus,
  uploadBusinessTransactionChunk,
} from './business-sync-transactions';
import {
  transactionManifest,
  transactionChanges,
  type TransactionChange,
  type TransactionManifest,
} from './business-sync-transaction-format';
import * as transactionHttp from '../app/api/sync/transactions/route';
import * as transactionFileHttp from '../app/api/sync/transactions/file/route';
import * as reviewHttp from '../app/api/sync/transactions/review/route';
import {
  beginBusinessTransactionReview,
  businessTransactionReviewStatus,
  reviewBusinessTransaction,
  TRANSACTION_REVIEW_VERSION,
} from './business-sync-transaction-review';
import { auditHashFields } from './business-sync-audit';
import {
  businessTransactionValidationStatus,
  validateBusinessTransaction,
  transactionCreditProjectionSql,
  TRANSACTION_VALIDATION_VERSION,
  transactionTransitionSql,
} from './business-sync-transaction-validation';
import * as transactionValidationHttp from '../app/api/sync/transactions/validate/route';
import {
  businessTransactionFileStatus,
  uploadBusinessTransactionFilePart,
  verifyBusinessTransactionFile,
} from './business-sync-transaction-files';

let db: DatabaseSync, blobs: Map<string, Uint8Array>;
let beforeBatch: ((sql: string[]) => Promise<void>) | undefined;
let failStatement: ((sql: string) => void) | undefined;
let beforeRun: ((sql: string) => Promise<void>) | undefined;
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
    run: async () => {
      if (beforeRun) await beforeRun(sql);
      return s.execute();
    },
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
  beforeRun = undefined;
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
      version: 2,
      rows: [
        {
          table: 'settings',
          key_json: '[1]',
          row_json,
          source_rowid: '1',
        },
      ],
    }),
  ];
  const manifest = await bootstrapManifest({
    format: 'zentra-business-bootstrap',
    version: 3,
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

function transactionClient(
  id = 'client-transaction',
  notes = 'Conditions\nAcompte : 30 %',
) {
  const local = new DatabaseSync(':memory:');
  try {
    local.exec(structuralSchema.tables.clients.sql);
    local
      .prepare(
        "INSERT INTO clients(id,name,notes,created_at,updated_at) VALUES(?,'Client fictif',?,'2026-09-08','2026-09-08')",
      )
      .run(id, notes);
    return local
      .prepare(
        `SELECT json_object(${contract.tables.clients.columns.flatMap((c) => [`'${c}'`, `"${c}"`]).join(',')}) image FROM clients`,
      )
      .get()!.image as string;
  } finally {
    local.close();
  }
}
function transactionInsert(
  sequence = '9007199254740993',
  id = 'client-transaction',
): TransactionChange {
  return {
    sequence,
    table: 'clients',
    key_json: JSON.stringify([id]),
    operation: 'insert',
    before_json: null,
    after_json: transactionClient(id),
    source_rowid: sequence,
    files_before: [],
    files_after: [],
  };
}
async function transactionFixture(
  parts = [[transactionInsert()]],
  published?: { generation: string; transfer_id: string },
) {
  const receipt =
    published ??
    (await (async () => {
      const f = await ready();
      return publishBootstrap(owner, f.id);
    })());
  const actor = { ...second, installationId: crypto.randomUUID() };
  const chunks = parts.map((changes) => encode({ version: 1, changes }));
  const manifest: TransactionManifest = {
    format: 'zentra-business-transaction',
    version: 1,
    schema_version: 60,
    contract_sha256: await businessSyncContractHash(),
    organization_id: actor.organizationId,
    installation_id: actor.installationId,
    generation: receipt.generation,
    capture_generation: crypto.randomUUID(),
    bootstrap_transfer_id: receipt.transfer_id,
    transaction_id: crypto.randomUUID(),
    base_revision: 1,
    first_sequence: parts[0][0].sequence,
    last_sequence: parts.at(-1)!.at(-1)!.sequence,
    change_count: parts.flat().length,
    size_bytes: chunks.reduce((n, c) => n + c.length, 0),
    chunks: await Promise.all(
      chunks.map(async (bytes, i) => ({
        sha256: await sha256Hex(bytes),
        size_bytes: bytes.length,
        change_count: parts[i].length,
      })),
    ),
    files: [],
  };
  return { manifest, chunks, actor, receipt };
}

async function receiveTransaction(
  f: Awaited<ReturnType<typeof transactionFixture>>,
) {
  await beginBusinessTransaction(f.actor, JSON.stringify(f.manifest));
  for (const [i, bytes] of f.chunks.entries())
    await uploadBusinessTransactionChunk(
      f.actor,
      f.manifest.transaction_id,
      i,
      request(bytes),
    );
  return f;
}
async function projectTransaction(actor: DeviceSessionContext, id: string) {
  let status = await beginBusinessTransactionReview(actor, id);
  for (
    let pass = 0;
    pass < 100 && ['copying', 'applying'].includes(status.state);
    pass++
  )
    status = await reviewBusinessTransaction(actor, id);
  expect(['copying', 'applying']).not.toContain(status.state);
  return status;
}
async function validateTransaction(actor: DeviceSessionContext, id: string) {
  let status = await validateBusinessTransaction(actor, id);
  for (
    let i = 0;
    i < 500 && !['valid', 'invalid', 'stale'].includes(status.phase);
    i++
  )
    status = await validateBusinessTransaction(actor, id);
  expect(['valid', 'invalid', 'stale']).toContain(status.phase);
  return status;
}

function transactionDocument(
  table: 'invoices' | 'quotes',
  values: Record<string, unknown>,
) {
  const local = new DatabaseSync(':memory:');
  try {
    local.exec('PRAGMA foreign_keys=OFF');
    local.exec(structuralSchema.tables[table].sql);
    const data = {
      id: 'intermediate',
      client_id: 'client-transaction',
      title: 'Document',
      created_at: '2026-09-08',
      updated_at: '2026-09-08',
      ...values,
    };
    local
      .prepare(
        `INSERT INTO ${table}(${Object.keys(data).join(',')}) VALUES(${Object.keys(
          data,
        )
          .map(() => '?')
          .join(',')})`,
      )
      .run(...(Object.values(data) as Scalar[]));
    return local
      .prepare(
        `SELECT json_object(${contract.tables[table].columns.flatMap((c) => [`'${c}'`, `"${c}"`]).join(',')}) image FROM ${table}`,
      )
      .get()!.image as string;
  } finally {
    local.close();
  }
}
function documentChanges(
  table: 'invoices' | 'quotes',
  rewrite = true,
): TransactionChange[] {
  const draft = transactionDocument(table, {});
  const issued = transactionDocument(table, {
    number: 'F-2026-999',
    status: table === 'invoices' ? 'emise' : 'envoye',
    issue_date: '2026-09-08',
  });
  const changed = JSON.stringify({
    ...JSON.parse(issued),
    notes: 'Réécriture interdite',
  });
  const pairs: (string | null)[][] = rewrite
    ? [
        [null, draft],
        [draft, issued],
        [issued, changed],
        [changed, issued],
        [issued, null],
      ]
    : [
        [null, draft],
        [
          draft,
          JSON.stringify({
            ...JSON.parse(draft),
            notes: 'Conditions\nAcompte',
          }),
        ],
        [
          JSON.stringify({
            ...JSON.parse(draft),
            notes: 'Conditions\nAcompte',
          }),
          null,
        ],
      ];
  return pairs.map(([before_json, after_json], i) => ({
    sequence: String(i + 2),
    table,
    key_json: '["intermediate"]',
    operation:
      before_json === null
        ? 'insert'
        : after_json === null
          ? 'delete'
          : 'update',
    before_json,
    after_json,
    source_rowid: '1',
    files_before: [],
    files_after: [],
  }));
}
async function atTransitions(actor: DeviceSessionContext, id: string) {
  let status = await validateBusinessTransaction(actor, id);
  for (
    let i = 0;
    i < 200 && !['transitions', 'valid', 'invalid'].includes(status.phase);
    i++
  )
    status = await validateBusinessTransaction(actor, id);
  expect(status.phase).toBe('transitions');
  return status;
}

it.for([false, true])(
  'rejects intermediate structural failures even when every temporary project is deleted (D1=%s)',
  { timeout: 60_000 },
  async (useD1) => {
    const real = useD1 ? await realD1Fixture() : null;
    try {
      const local = new DatabaseSync(':memory:');
      let first: string, secondProject: string;
      try {
        local.exec('PRAGMA foreign_keys=OFF');
        local.exec(structuralSchema.tables.projects.sql);
        local.exec(
          "INSERT INTO projects(id,code,name,created_at,updated_at) VALUES('first','P-2026','Projet fictif','2026-09-09','2026-09-09'),('second','P-2026','Autre projet','2026-09-09','2026-09-09')",
        );
        const rows = local
          .prepare(
            `SELECT json_object(${contract.tables.projects.columns.flatMap((c) => [`'${c}'`, `"${c}"`]).join(',')}) image FROM projects ORDER BY id`,
          )
          .all();
        first = rows[0].image as string;
        secondProject = rows[1].image as string;
      } finally {
        local.close();
      }
      let receipt: { generation: string; transfer_id: string } | undefined;
      for (const failure of ['unique', 'fields', 'check'] as const) {
        const malformed = JSON.stringify({
          ...JSON.parse(first),
          progress: failure === 'fields' ? '50' : 101,
        });
        const pairs =
          failure === 'unique'
            ? [
                [null, first],
                [null, secondProject],
                [secondProject, null],
                [first, null],
              ]
            : [
                [null, first],
                [first, malformed],
                [malformed, first],
                [first, null],
              ];
        const changes: TransactionChange[] = pairs.map(
          ([before_json, after_json], index) => {
            const identity = JSON.parse((before_json ?? after_json)!).id;
            return {
              table: 'projects',
              key_json: JSON.stringify([identity]),
              sequence: String(index + 1),
              source_rowid: identity === 'first' ? '1' : '2',
              operation:
                before_json === null
                  ? 'insert'
                  : after_json === null
                    ? 'delete'
                    : 'update',
              before_json,
              after_json,
              files_before: [],
              files_after: [],
            };
          },
        );
        const f = await receiveTransaction(
          await transactionFixture([changes], receipt),
        );
        receipt = f.receipt;
        await projectTransaction(f.actor, f.manifest.transaction_id);
        expect(
          await validateTransaction(f.actor, f.manifest.transaction_id),
        ).toMatchObject({
          phase: 'invalid',
          failed_change: 1,
          failed_rule:
            failure === 'unique'
              ? 'row:unique:idx_projects_code'
              : `row:${failure}:projects`,
          snapshot_validated: false,
        });
        expect((await historyHead(f.actor)).head_revision).toBe(1);
        const sql =
          "SELECT COUNT(*) n FROM business_sync_versions WHERE transfer_id=? AND table_name='projects'";
        const canonical = real
          ? await real.d1.prepare(sql).bind(receipt.transfer_id).first()
          : db.prepare(sql).get(receipt.transfer_id);
        expect(canonical).toMatchObject({ n: 0 });
      }
    } finally {
      await real?.runtime.dispose();
    }
  },
);

it.for([false, true])(
  'records an intermediate malformed invoice JSON as a stable rejection (D1=%s)',
  { timeout: 30_000 },
  async (useD1) => {
    const real = useD1 ? await realD1Fixture() : null;
    try {
      const changes = documentChanges('invoices', false);
      const invalid = JSON.stringify({
        ...JSON.parse(changes[1].after_json!),
        deposit_basis_json: 'broken',
      });
      changes[1].after_json = invalid;
      changes[2].before_json = invalid;
      const f = await receiveTransaction(
        await transactionFixture([[transactionInsert('1'), ...changes]]),
      );
      await projectTransaction(f.actor, f.manifest.transaction_id);
      const rejected = {
        phase: 'invalid',
        failed_change: 2,
        failed_rule: 'row:check:invoices',
        snapshot_validated: false,
      };
      expect(
        await validateTransaction(f.actor, f.manifest.transaction_id),
      ).toMatchObject(rejected);
      expect(
        await validateBusinessTransaction(f.actor, f.manifest.transaction_id),
      ).toMatchObject(rejected);
      expect((await historyHead(f.actor)).head_revision).toBe(1);
    } finally {
      await real?.runtime.dispose();
    }
  },
);

it.each(['invoices', 'quotes'] as const)(
  'rejects intermediate issued %s rewrites even if the final snapshot has no document',
  async (table) => {
    const f = await receiveTransaction(
      await transactionFixture([
        [transactionInsert('1'), ...documentChanges(table)],
      ]),
    );
    const id = f.manifest.transaction_id;
    expect((await projectTransaction(f.actor, id)).state).toBe('projected');
    expect(await validateTransaction(f.actor, id)).toMatchObject({
      phase: 'invalid',
      failed_rule: `transition:issued-${table}`,
      failed_change: 3,
      snapshot_validated: false,
    });
    expect((await historyHead(f.actor)).head_revision).toBe(1);
    const draft = await receiveTransaction(
      await transactionFixture(
        [[transactionInsert('1'), ...documentChanges(table, false)]],
        f.receipt,
      ),
    );
    await projectTransaction(draft.actor, draft.manifest.transaction_id);
    expect(
      (await validateTransaction(draft.actor, draft.manifest.transaction_id))
        .phase,
    ).toBe('valid');
  },
);

it('retains issued state across original fragments and SQL pages, including exact large sequence numbers', async () => {
  const changes = [
    transactionInsert('1'),
    ...Array.from({ length: 197 }, (_, i) =>
      transactionInsert('1', `pad-${i}`),
    ),
    ...documentChanges('invoices'),
  ].map((c, i) => ({
    ...c,
    sequence: String(BigInt('9007199254740993') + BigInt(i)),
  }));
  const f = await receiveTransaction(
    await transactionFixture([changes.slice(0, 200), changes.slice(200)]),
  );
  await projectTransaction(f.actor, f.manifest.transaction_id);
  expect(
    await validateTransaction(f.actor, f.manifest.transaction_id),
  ).toMatchObject({
    phase: 'invalid',
    failed_rule: 'transition:issued-invoices',
    failed_change: 200,
    checked_changes: 200,
  });
  expect(
    db
      .prepare(
        'SELECT issued FROM business_sync_transaction_document_states WHERE transfer_id=?',
      )
      .get(f.manifest.transaction_id),
  ).toEqual({ issued: 1 });
});

it('rolls back document state and its transition cursor together and never accepts a changed original fragment', async () => {
  const f = await receiveTransaction(
    await transactionFixture([
      [transactionInsert('1'), ...documentChanges('invoices', false)],
    ]),
  );
  const id = f.manifest.transaction_id;
  await projectTransaction(f.actor, id);
  await atTransitions(f.actor, id);
  const original = businessEvidence();
  failStatement = (sql) => {
    if (
      sql.startsWith(
        'UPDATE business_sync_transaction_validations SET checked_changes',
      )
    )
      throw new Error('transition checkpoint failure');
  };
  await expect(validateBusinessTransaction(f.actor, id)).rejects.toThrow(
    'transition checkpoint failure',
  );
  failStatement = undefined;
  expect(await businessTransactionValidationStatus(f.actor, id)).toMatchObject({
    phase: 'transitions',
    checked_changes: 0,
  });
  expect(
    db
      .prepare(
        'SELECT COUNT(*) n FROM business_sync_transaction_document_states WHERE transfer_id=?',
      )
      .get(id),
  ).toEqual({ n: 0 });
  expect(
    db
      .prepare(
        'SELECT COUNT(*) n FROM business_sync_transaction_accounting_states WHERE transfer_id=?',
      )
      .get(id),
  ).toEqual({ n: 0 });
  expect(businessEvidence()).toEqual(original);
  const key = [...blobs.keys()].find((k) =>
    k.includes(`/transactions/${f.manifest.capture_generation}/${id}/`),
  )!;
  const bytes = blobs.get(key)!;
  blobs.set(key, new Uint8Array(bytes.length));
  await expect(validateBusinessTransaction(f.actor, id)).rejects.toMatchObject({
    status: 503,
  });
  expect(
    (await businessTransactionValidationStatus(f.actor, id)).checked_changes,
  ).toBe(0);
  blobs.set(key, bytes);
  expect((await validateTransaction(f.actor, id)).phase).toBe('valid');
});

it('serializes transition retries, preserves metadata evidence and stops if the canonical revision changes', async () => {
  const documents = documentChanges('invoices', false);
  const changes = [
    transactionInsert('1'),
    documents[0],
    ...Array.from({ length: 40 }, (_, i) =>
      transactionInsert('1', `padding-${i}`),
    ),
    ...documents.slice(1),
  ].map((c, i) => ({ ...c, sequence: String(i + 1) }));
  const f = await receiveTransaction(await transactionFixture([changes]));
  const id = f.manifest.transaction_id;
  await projectTransaction(f.actor, id);
  await atTransitions(f.actor, id);
  const meta = db
    .prepare(
      'SELECT after_sha256 FROM business_sync_transaction_changes WHERE transaction_id=? AND change_index=0',
    )
    .get(id)!;
  db.prepare(
    'UPDATE business_sync_transaction_changes SET after_sha256=? WHERE transaction_id=? AND change_index=0',
  ).run('0'.repeat(64), id);
  await expect(validateBusinessTransaction(f.actor, id)).rejects.toMatchObject({
    status: 503,
  });
  expect(
    (await businessTransactionValidationStatus(f.actor, id)).checked_changes,
  ).toBe(0);
  db.prepare(
    'UPDATE business_sync_transaction_changes SET after_sha256=? WHERE transaction_id=? AND change_index=0',
  ).run(meta.after_sha256, id);
  let arrivals = 0,
    release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  beforeBatch = async (sql) => {
    if (
      !sql.some((s) =>
        s.startsWith(
          'UPDATE business_sync_transaction_validations SET checked_changes',
        ),
      )
    )
      return;
    if (++arrivals === 2) release();
    await barrier;
  };
  await Promise.all([
    validateBusinessTransaction(f.actor, id),
    validateBusinessTransaction(f.actor, id),
  ]);
  beforeBatch = undefined;
  expect(arrivals).toBe(2);
  expect(
    (await businessTransactionValidationStatus(f.actor, id)).checked_changes,
  ).toBe(12);
  expect(
    db
      .prepare(
        'SELECT COUNT(*) n FROM business_sync_transaction_document_states WHERE transfer_id=?',
      )
      .get(id),
  ).toEqual({ n: 1 });
  const evidence = businessEvidence();
  beforeBatch = async () => {
    beforeBatch = undefined;
    db.exec('UPDATE business_sync_spaces SET head_revision=2');
  };
  expect(await validateBusinessTransaction(f.actor, id)).toMatchObject({
    phase: 'stale',
    checked_changes: 12,
    snapshot_validated: false,
  });
  expect(businessEvidence()).toEqual(evidence);
  expect((await historyHead(f.actor)).head_revision).toBe(2);
});

const operationalScenarios = [
  'stock-entry',
  'stock-exit',
  'stock-correction',
  'supplier-receipt',
  'supplier-receipt-reversal',
  'delivery',
  'delivery-reversal',
  'quote-delete',
] as const;
it.for([
  ['invoices', false],
  ['quotes', false],
  ['invoices', true],
  ['quotes', true],
  ['expense', false],
  ['payroll', false],
  ['payroll-post', false],
  ['payroll-adult-post', false],
  ['payroll-adult-validate', false],
  ['supplier-validate', false],
  ['supplier-payment', false],
  ['supplier-credit', false],
  ['expense', true],
  ['payroll', true],
  ['payroll-post', true],
  ['payroll-adult-post', true],
  ['payroll-adult-validate', true],
  ['supplier-validate', true],
  ['supplier-payment', true],
  ['supplier-credit', true],
  ['expense-refund', false],
  ['expense-refund-reversal', false],
  ['supplier-refund', false],
  ['supplier-refund-reversal', false],
  ['expense-refund', true],
  ['expense-refund-reversal', true],
  ['supplier-refund', true],
  ['supplier-refund-reversal', true],
  ...operationalScenarios.flatMap(
    (name) =>
      [
        [name, false],
        [name, true],
      ] as const,
  ),
] as const)(
  'validates actual native %s operations including intermediate accounting states (D1=%s)',
  { timeout: 60_000 },
  async ([table, useD1], context) => {
    const document = table === 'invoices' || table === 'quotes';
    const operational = (operationalScenarios as readonly string[]).includes(
      table,
    );
    const root = document
      ? process.env.ZENTRA_DOCUMENT_TRANSITION_QA
      : operational
        ? process.env.ZENTRA_OPERATIONAL_TRANSITION_QA
        : process.env.ZENTRA_ACCOUNTING_TRANSITION_QA;
    if (!root) return context.skip();
    const real = useD1 ? await realD1Fixture() : null;
    try {
      const folder = join(root, table);
      const rows = JSON.parse(
        readFileSync(join(folder, 'source.json'), 'utf8'),
      ) as {
        table: string;
        key_json: string;
        row_json: string;
        source_rowid: string;
      }[];
      const source = await fixture();
      source.chunks = [];
      const tables = Object.fromEntries(
        Object.keys(contract.tables).map((t) => [t, 0]),
      );
      for (const row of rows) tables[row.table]++;
      for (let i = 0; i < rows.length; i += 200)
        source.chunks.push(
          encode({ version: 2, rows: rows.slice(i, i + 200) }),
        );
      source.manifest = await bootstrapManifest({
        ...source.manifest,
        tables,
        row_count: rows.length,
        size_bytes: source.chunks.reduce((n, p) => n + p.length, 0),
        chunks: await Promise.all(
          source.chunks.map(async (bytes, i) => ({
            sha256: await sha256Hex(bytes),
            size_bytes: bytes.length,
            row_count: rows.slice(i * 200, i * 200 + 200).length,
          })),
        ),
      });
      await stage(source);
      await validate(source.id);
      const receipt = await publishBootstrap(owner, source.id);
      const original = JSON.parse(
        readFileSync(join(folder, 'manifest.json'), 'utf8'),
      ) as TransactionManifest;
      expect(original.files).toEqual([]);
      const bytes = original.chunks.map(
        (_, i) =>
          new Uint8Array(
            readFileSync(join(folder, `${String(i).padStart(4, '0')}.json`)),
          ),
      );
      const parts = bytes.map(
        (b) =>
          JSON.parse(new TextDecoder().decode(b))
            .changes as TransactionChange[],
      );
      const f = await transactionFixture(parts, receipt);
      Object.assign(f.manifest, {
        installation_id: original.installation_id,
        capture_generation: original.capture_generation,
        transaction_id: original.transaction_id,
      });
      f.actor = { ...f.actor, installationId: original.installation_id };
      expect(f.chunks).toEqual(bytes);
      await receiveTransaction(f);
      expect(
        (await projectTransaction(f.actor, f.manifest.transaction_id)).state,
      ).toBe('projected');
      if (
        !useD1 &&
        [
          'payroll',
          'payroll-post',
          'supplier-validate',
          'supplier-credit',
          'stock-entry',
        ].includes(table)
      ) {
        await atTransitions(f.actor, f.manifest.transaction_id);
        const checkpoint = validationEvidence(f.manifest.transaction_id);
        failStatement = (sql) => {
          if (
            sql.includes(
              'INSERT INTO business_sync_transaction_accounting_states',
            )
          )
            throw new Error('accounting state write failed');
        };
        await expect(
          validateBusinessTransaction(f.actor, f.manifest.transaction_id),
        ).rejects.toThrow('accounting state write failed');
        failStatement = undefined;
        expect(validationEvidence(f.manifest.transaction_id)).toEqual(
          checkpoint,
        );
      }
      expect(
        await validateTransaction(f.actor, f.manifest.transaction_id),
      ).toMatchObject({
        phase: 'valid',
        snapshot_validated: true,
        checked_changes: original.change_count,
        business_validated: false,
        canonical_committed: false,
      });
      expect((await historyHead(f.actor)).head_revision).toBe(1);
      for (const [i, b] of source.chunks.entries())
        expect(
          (await historyChunk(f.actor, source.id, String(i))).bytes,
        ).toEqual(b);
      if (operational) {
        const expected = JSON.parse(
          readFileSync(join(folder, 'final.json'), 'utf8'),
        ) as { table: string; key_json: string; row_json: string }[];
        const sql =
          'SELECT table_name,row_key_json,row_json FROM business_sync_versions WHERE transfer_id=?';
        const actual = real
          ? (await real.d1.prepare(sql).bind(f.manifest.transaction_id).all())
              .results
          : db.prepare(sql).all(f.manifest.transaction_id);
        const sorted = (rows: { table: string; key: string; row: string }[]) =>
          rows.sort((a, b) =>
            `${a.table}\0${a.key}`.localeCompare(`${b.table}\0${b.key}`),
          );
        expect(
          sorted(
            actual.map((r) => ({
              table: String(r.table_name),
              key: String(r.row_key_json),
              row: String(r.row_json),
            })),
          ),
        ).toEqual(
          sorted(
            expected.map((r) => ({
              table: r.table,
              key: r.key_json,
              row: r.row_json,
            })),
          ),
        );
        if (table !== 'quote-delete') {
          const missingBalance = parts
            .flat()
            .filter((c) => c.table !== 'catalog_items')
            .map((c, i) => ({
              ...c,
              sequence: String(BigInt(original.first_sequence) + BigInt(i)),
            }));
          const missing = await receiveTransaction(
            await transactionFixture([missingBalance], receipt),
          );
          await projectTransaction(
            missing.actor,
            missing.manifest.transaction_id,
          );
          expect(
            await validateTransaction(
              missing.actor,
              missing.manifest.transaction_id,
            ),
          ).toMatchObject({ phase: 'invalid', snapshot_validated: false });
          expect((await historyHead(missing.actor)).head_revision).toBe(1);
        }
        return;
      }
      if (table === 'payroll-adult-validate') {
        const changes = parts.flat();
        const assessmentIndex = changes.findIndex(
          (c) => c.table === 'payslip_small_salary_assessments',
        );
        expect(assessmentIndex).toBeGreaterThanOrEqual(0);
        const damaged = changes.map((c, i) =>
          i === assessmentIndex
            ? {
                ...c,
                after_json: JSON.stringify({
                  ...JSON.parse(c.after_json!),
                  assessment_sha256: '0'.repeat(64),
                }),
              }
            : c,
        );
        const forged = await receiveTransaction(
          await transactionFixture([damaged], receipt),
        );
        await projectTransaction(forged.actor, forged.manifest.transaction_id);
        expect(
          await validateTransaction(
            forged.actor,
            forged.manifest.transaction_id,
          ),
        ).toMatchObject({
          phase: 'invalid',
          failed_rule:
            'native:payslip_small_salary_assessments_integrity_insert_guard',
          failed_change: assessmentIndex,
          snapshot_validated: false,
        });
      }
      if (table === 'supplier-validate' || table === 'supplier-credit') {
        const changes = parts.flat();
        const target =
          table === 'supplier-validate'
            ? 'supplier_invoices'
            : 'supplier_credit_notes';
        const postingIndex = changes.findIndex(
          (c) =>
            c.table === target &&
            c.operation === 'update' &&
            JSON.parse(c.after_json!).status === 'validated',
        );
        const entryIndex = changes.findIndex(
          (c) => c.table === 'journal_entries',
        );
        expect(postingIndex).toBeGreaterThan(entryIndex);
        const [premature] = changes.splice(postingIndex, 1);
        changes.splice(entryIndex, 0, premature);
        const reordered = changes.map((c, i) => ({
          ...c,
          sequence: String(BigInt(original.first_sequence) + BigInt(i)),
        }));
        const prematureFixture = await transactionFixture([reordered], receipt);
        await receiveTransaction(prematureFixture);
        await projectTransaction(
          prematureFixture.actor,
          prematureFixture.manifest.transaction_id,
        );
        expect(
          await validateTransaction(
            prematureFixture.actor,
            prematureFixture.manifest.transaction_id,
          ),
        ).toMatchObject({
          phase: 'invalid',
          failed_rule:
            table === 'supplier-validate'
              ? 'transition:supplier-invoice-posting'
              : 'transition:supplier-credit-posting',
          failed_change: entryIndex,
          snapshot_validated: false,
        });
      }
      if (table === 'supplier-validate' && !useD1) {
        const extended = [
          ...Array.from({ length: 198 }, (_, i) =>
            transactionInsert(String(i + 1), `padding-${i}`),
          ),
          ...parts.flat(),
        ].map((c, i) => ({ ...c, sequence: String(i + 1) }));
        const chunks = [extended.slice(0, 200), extended.slice(200)];
        const long = await transactionFixture(chunks, receipt);
        await receiveTransaction(long);
        await projectTransaction(long.actor, long.manifest.transaction_id);
        expect(
          await validateTransaction(long.actor, long.manifest.transaction_id),
        ).toMatchObject({ phase: 'valid', checked_changes: extended.length });
        const lost = await transactionFixture(chunks, receipt);
        await receiveTransaction(lost);
        await projectTransaction(lost.actor, lost.manifest.transaction_id);
        await atTransitions(lost.actor, lost.manifest.transaction_id);
        let status = await businessTransactionValidationStatus(
          lost.actor,
          lost.manifest.transaction_id,
        );
        for (let i = 0; i < 20 && status.checked_changes < 200; i++)
          status = await validateBusinessTransaction(
            lost.actor,
            lost.manifest.transaction_id,
          );
        expect(status).toMatchObject({
          phase: 'transitions',
          checked_changes: 200,
        });
        db.prepare(
          'DELETE FROM business_sync_transaction_accounting_states WHERE transfer_id=?',
        ).run(lost.manifest.transaction_id);
        expect(
          await validateBusinessTransaction(
            lost.actor,
            lost.manifest.transaction_id,
          ),
        ).toMatchObject({
          phase: 'invalid',
          failed_rule: 'native:missing-state:journal_lines',
          checked_changes: 200,
          failed_change: 200,
        });
      }
      const refundTable = table.startsWith('expense-refund')
        ? 'expense_refunds'
        : table.startsWith('supplier-refund')
          ? 'supplier_credit_refunds'
          : null;
      const targetTable =
        refundTable ??
        (document
          ? table === 'invoices'
            ? 'invoice_items'
            : 'quote_items'
          : table === 'expense'
            ? 'expenses'
            : table.startsWith('payroll')
              ? 'payslips'
              : table === 'supplier-credit'
                ? 'supplier_credit_notes'
                : 'supplier_invoices');
      const finalChange = parts
        .flat()
        .filter((c) => c.table === targetTable && c.after_json !== null)
        .at(-1);
      const item = finalChange
        ? { ...finalChange, row_json: finalChange.after_json! }
        : rows.find((r) => r.table === targetTable)!;
      const rewritten =
        table === 'payroll-adult-validate'
          ? JSON.stringify({
              ...JSON.parse(item.row_json),
              gross_cents: JSON.parse(item.row_json).gross_cents + 1,
            })
          : JSON.stringify({
              ...JSON.parse(item.row_json),
              [refundTable
                ? 'reason'
                : document
                  ? 'description'
                  : table.startsWith('payroll')
                    ? 'notes'
                    : 'note']: 'Texte réécrit après comptabilisation',
            });
      const change: TransactionChange = {
        sequence: String(BigInt(original.last_sequence) + BigInt(1)),
        table: targetTable,
        key_json: item.key_json,
        operation: 'update',
        before_json: item.row_json,
        after_json: rewritten,
        source_rowid: item.source_rowid,
        files_before: [],
        files_after: [],
      };
      const bad = await transactionFixture(
        [
          ...parts,
          [
            change,
            {
              ...change,
              sequence: String(BigInt(original.last_sequence) + BigInt(2)),
              before_json: rewritten,
              after_json: item.row_json,
            },
          ],
        ],
        receipt,
      );
      await receiveTransaction(bad);
      await projectTransaction(bad.actor, bad.manifest.transaction_id);
      expect(
        await validateTransaction(bad.actor, bad.manifest.transaction_id),
      ).toMatchObject({
        phase: 'invalid',
        failed_rule: refundTable
          ? 'immutable:append-only'
          : document
            ? table === 'invoices'
              ? 'transition:issued-invoice-items'
              : 'transition:issued-quote-items'
            : table === 'expense'
              ? 'transition:posted-expense'
              : table === 'payroll-adult-validate'
                ? 'native:payslips_small_salary_posted_trace_update_guard'
                : table.startsWith('payroll')
                  ? 'transition:posted-payslip'
                  : table === 'supplier-credit'
                    ? 'transition:validated-supplier-credit'
                    : 'transition:validated-supplier-invoice',
        failed_change: refundTable ? null : original.change_count,
        snapshot_validated: false,
      });
    } finally {
      await real?.runtime.dispose();
    }
  },
);

it('validates a complete subsequent snapshot without applying it or changing canonical receipts', async () => {
  const f = await receiveTransaction(await transactionFixture());
  const id = f.manifest.transaction_id;
  await expect(validateBusinessTransaction(f.actor, id)).rejects.toMatchObject({
    status: 404,
  });
  await projectTransaction(f.actor, id);
  expect(await businessTransactionValidationStatus(f.actor, id)).toMatchObject({
    phase: 'pending',
    snapshot_validated: false,
  });
  const status = await validateTransaction(f.actor, id);
  expect(status).toMatchObject({
    phase: 'valid',
    snapshot_validated: true,
    business_validated: false,
    canonical_committed: false,
    replication_active: false,
    credit_projection: { phase: 'valid' },
  });
  expect(await validateBusinessTransaction(f.actor, id)).toEqual(status);
  expect((await historyHead(f.actor)).head_revision).toBe(1);
  expect(
    db
      .prepare('SELECT state FROM business_sync_transfers WHERE transfer_id=?')
      .get(id),
  ).toEqual({ state: 'received' });
  mocks.session.mockRejectedValue(
    new AccountPublicError('Session requise.', 401),
  );
  for (const [method, handler] of [
    ['GET', transactionValidationHttp.GET],
    ['POST', transactionValidationHttp.POST],
  ] as const) {
    const response = await handler(
      new Request(
        `https://example.test/api/sync/transactions/validate?transaction_id=${id}`,
        { method },
      ),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toContain('no-store');
  }
});

async function legacyTransactionValidation(version = 1) {
  const f = await receiveTransaction(await transactionFixture());
  const id = f.manifest.transaction_id;
  await projectTransaction(f.actor, id);
  const status = await validateTransaction(f.actor, id);
  expect(status.phase).toBe('valid');
  const legacyHash = 'a'.repeat(64);
  db.prepare(
    'UPDATE business_sync_transaction_validations SET algorithm_version=1,validator_sha256=?,next_accounting_rule=97 WHERE transfer_id=?',
  ).run(legacyHash, id);
  db.prepare(
    'UPDATE business_sync_credit_projection SET validator_sha256=? WHERE transfer_id=?',
  ).run(legacyHash, id);
  db.prepare(
    'INSERT INTO business_sync_credit_lines(transfer_id,validator_sha256,document_id,item_id,position,gross,vat,remaining) VALUES(?,?,?,?,?,?,?,?)',
  ).run(id, legacyHash, 'legacy-document', 'legacy-item', 0, 100, 8, 100);
  db.prepare(
    'INSERT INTO business_sync_credit_movements(transfer_id,validator_sha256,document_id,movement_id,kind,date,created_at,sequence,amount) VALUES(?,?,?,?,?,?,?,?,?)',
  ).run(
    id,
    legacyHash,
    'legacy-document',
    'legacy-movement',
    'refund',
    '2026-01-01',
    '2026-01-01T00:00:00Z',
    0,
    100,
  );
  db.prepare(
    'UPDATE business_sync_transaction_validations SET algorithm_version=? WHERE transfer_id=?',
  ).run(version, id);
  db.prepare(
    'INSERT INTO business_sync_transaction_document_states VALUES(?,?,?,?,?)',
  ).run(id, legacyHash, 'invoices', '["legacy-document"]', 1);
  db.prepare(
    'INSERT INTO business_sync_transaction_accounting_states VALUES(?,?,?,?,?)',
  ).run(id, legacyHash, 'payslips', '["legacy-salary"]', '{"status":"paye"}');
  db.prepare(
    'INSERT INTO business_sync_transaction_effects VALUES(?,?,?,?,?,?,?,?)',
  ).run(
    id,
    legacyHash,
    'stock_movements_apply_balance',
    0,
    'catalog_items',
    '["old"]',
    null,
    '{"id":"old"}',
  );
  return { ...f, id, legacyHash };
}
const derivedValidationTables = [
  'business_sync_transaction_validations',
  'business_sync_credit_projection',
  'business_sync_credit_lines',
  'business_sync_credit_movements',
  'business_sync_transaction_document_states',
  'business_sync_transaction_accounting_states',
  'business_sync_transaction_effects',
];
function validationEvidence(id: string) {
  return derivedValidationTables.map((table) =>
    db.prepare(`SELECT * FROM ${table} WHERE transfer_id=?`).all(id),
  );
}
function businessEvidence() {
  return {
    rows: db
      .prepare(
        'SELECT * FROM business_sync_versions ORDER BY transfer_id,table_name,row_key_json',
      )
      .all(),
    changes: db
      .prepare(
        'SELECT * FROM business_sync_transaction_changes ORDER BY transaction_id,sequence',
      )
      .all(),
    blobs: [...blobs.entries()].map(([key, bytes]) => [
      key,
      Buffer.from(bytes).toString('hex'),
    ]),
  };
}

it.each([1, 2, 3, 4, 5, 6, 7, 8])(
  'upgrades legacy validation v%s atomically and rechecks the preserved candidate without losing original evidence',
  async (version) => {
    const f = await legacyTransactionValidation(version);
    const derived = validationEvidence(f.id);
    const original = businessEvidence();
    // Reading status cannot silently discard the old receipt or its calculations.
    await expect(
      businessTransactionValidationStatus(f.actor, f.id),
    ).rejects.toMatchObject({ status: 409 });
    expect(validationEvidence(f.id)).toEqual(derived);
    failStatement = (sql) => {
      if (
        sql.startsWith(
          'UPDATE business_sync_transaction_validations SET validator_sha256',
        )
      )
        throw new Error('upgrade interrupted');
    };
    await expect(validateBusinessTransaction(f.actor, f.id)).rejects.toThrow(
      'upgrade interrupted',
    );
    expect(validationEvidence(f.id)).toEqual(derived);
    expect(businessEvidence()).toEqual(original);
    failStatement = undefined;
    const resumed = await validateBusinessTransaction(f.actor, f.id);
    expect(resumed).toMatchObject({
      algorithm_version: TRANSACTION_VALIDATION_VERSION,
      phase: 'structure',
      snapshot_validated: false,
      checked_accounting_rules: 0,
    });
    expect(resumed.validator_sha256).not.toBe(f.legacyHash);
    for (const table of derivedValidationTables.slice(1))
      expect(
        db
          .prepare(
            `SELECT COUNT(*) n FROM ${table} WHERE transfer_id=? AND validator_sha256=?`,
          )
          .get(f.id, f.legacyHash),
      ).toEqual({ n: 0 });
    expect(businessEvidence()).toEqual(original);
    const validated = await validateTransaction(f.actor, f.id);
    expect(validated).toMatchObject({
      phase: 'valid',
      snapshot_validated: true,
      algorithm_version: TRANSACTION_VALIDATION_VERSION,
      canonical_committed: false,
      replication_active: false,
    });
    expect(await validateBusinessTransaction(f.actor, f.id)).toEqual(validated);
    expect((await historyHead(f.actor)).head_revision).toBe(1);
  },
);

it('never downgrades newer validations or resets another review attempt', async () => {
  const f = await legacyTransactionValidation();
  db.prepare(
    'UPDATE business_sync_transaction_validations SET algorithm_version=? WHERE transfer_id=?',
  ).run(TRANSACTION_VALIDATION_VERSION + 1, f.id);
  const future = validationEvidence(f.id);
  await expect(
    validateBusinessTransaction(f.actor, f.id),
  ).rejects.toMatchObject({ status: 409 });
  expect(validationEvidence(f.id)).toEqual(future);
  db.prepare(
    'UPDATE business_sync_transaction_validations SET algorithm_version=1,attempt=? WHERE transfer_id=?',
  ).run(crypto.randomUUID(), f.id);
  const differentAttempt = validationEvidence(f.id);
  await expect(
    validateBusinessTransaction(f.actor, f.id),
  ).rejects.toMatchObject({ status: 409 });
  expect(validationEvidence(f.id)).toEqual(differentAttempt);
});

it('preserves old validation calculations when a canonical revision wins the upgrade batch', async () => {
  const f = await legacyTransactionValidation();
  const derived = validationEvidence(f.id),
    original = businessEvidence();
  beforeBatch = async () => {
    beforeBatch = undefined;
    db.exec('UPDATE business_sync_spaces SET head_revision=2');
  };
  await expect(
    validateBusinessTransaction(f.actor, f.id),
  ).rejects.toMatchObject({ status: 409 });
  expect(validationEvidence(f.id)).toEqual(derived);
  expect(businessEvidence()).toEqual(original);
  expect((await historyHead(f.actor)).head_revision).toBe(2);
});

it('allows overlapping legacy upgrade requests without restarting an upgraded checkpoint', async () => {
  const f = await legacyTransactionValidation();
  const original = businessEvidence();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrivals = 0;
  beforeBatch = async (sql) => {
    if (
      !sql.some((s) =>
        s.startsWith(
          'UPDATE business_sync_transaction_validations SET validator_sha256',
        ),
      )
    )
      return;
    if (++arrivals === 2) release();
    await barrier;
  };
  const responses = await Promise.all([
    validateBusinessTransaction(f.actor, f.id),
    validateBusinessTransaction(f.actor, f.id),
  ]);
  beforeBatch = undefined;
  expect(arrivals).toBe(2);
  expect(responses[0].validator_sha256).toBe(responses[1].validator_sha256);
  const current = await businessTransactionValidationStatus(f.actor, f.id);
  expect(current.checked_structural_rules).toBeGreaterThanOrEqual(
    Math.max(...responses.map((r) => r.checked_structural_rules)),
  );
  expect(current.algorithm_version).toBe(TRANSACTION_VALIDATION_VERSION);
  expect(businessEvidence()).toEqual(original);
  expect((await validateTransaction(f.actor, f.id)).phase).toBe('valid');
});

it('rejects reopening a published closed period while allowing later client changes without changing historical documents', async () => {
  const source = await fixture();
  const closed = {
    id: crypto.randomUUID(),
    name: 'Exercice clos',
    date_from: '2025-01-01',
    date_to: '2025-12-31',
    status: 'closed',
    closed_at: '2026-01-15T12:00:00Z',
    created_at: '2025-01-01',
    updated_at: '2026-01-15',
  };
  const image = JSON.stringify(closed),
    key = JSON.stringify([closed.id]);
  const chunk = JSON.parse(new TextDecoder().decode(source.chunks[0]));
  chunk.rows.push({
    table: 'accounting_periods',
    key_json: key,
    row_json: image,
    source_rowid: '1',
  });
  source.chunks = [encode(chunk)];
  source.manifest = await bootstrapManifest({
    ...source.manifest,
    tables: { ...source.manifest.tables, accounting_periods: 1 },
    row_count: 2,
    size_bytes: source.chunks[0].length,
    chunks: [
      {
        sha256: await sha256Hex(source.chunks[0]),
        size_bytes: source.chunks[0].length,
        row_count: 2,
      },
    ],
  });
  await stage(source);
  await validate(source.id);
  const receipt = await publishBootstrap(owner, source.id);
  const original = businessEvidence();
  const valid = await receiveTransaction(
    await transactionFixture([[transactionInsert('1')]], receipt),
  );
  await projectTransaction(valid.actor, valid.manifest.transaction_id);
  expect(
    (await validateTransaction(valid.actor, valid.manifest.transaction_id))
      .phase,
  ).toBe('valid');
  const reopening: TransactionChange = {
    sequence: '1',
    table: 'accounting_periods',
    key_json: key,
    operation: 'update',
    before_json: image,
    after_json: JSON.stringify({ ...closed, status: 'open', closed_at: null }),
    source_rowid: '1',
    files_before: [],
    files_after: [],
  };
  const invalid = await receiveTransaction(
    await transactionFixture([[reopening]], receipt),
  );
  await projectTransaction(invalid.actor, invalid.manifest.transaction_id);
  expect(
    await validateTransaction(invalid.actor, invalid.manifest.transaction_id),
  ).toMatchObject({
    phase: 'invalid',
    failed_rule: 'closed:period-history',
    snapshot_validated: false,
    canonical_committed: false,
  });
  expect(
    db
      .prepare(
        'SELECT row_json FROM business_sync_versions WHERE transfer_id=? AND table_name=?',
      )
      .get(source.id, 'accounting_periods'),
  ).toEqual({ row_json: image });
  expect((await historyHead(owner)).head_revision).toBe(1);
  for (const [k, hex] of original.blobs)
    expect(Buffer.from(blobs.get(k as string)!).toString('hex')).toBe(hex);
});

it('detects candidate row loss and invalid native fields instead of trusting its projected marker', async () => {
  const f = await receiveTransaction(await transactionFixture());
  const id = f.manifest.transaction_id;
  await projectTransaction(f.actor, id);
  db.prepare(
    "DELETE FROM business_sync_versions WHERE transfer_id=? AND table_name='clients'",
  ).run(id);
  expect(await validateTransaction(f.actor, id)).toMatchObject({
    phase: 'invalid',
    failed_rule: 'clients:count',
    snapshot_validated: false,
  });
  const bad = transactionInsert('1');
  bad.after_json = JSON.stringify({
    ...JSON.parse(bad.after_json!),
    name: null,
  });
  const other = await receiveTransaction(
    await transactionFixture([[bad]], f.receipt),
  );
  await projectTransaction(other.actor, other.manifest.transaction_id);
  expect(
    await validateTransaction(other.actor, other.manifest.transaction_id),
  ).toMatchObject({
    phase: 'invalid',
    failed_rule: 'clients:fields',
    snapshot_validated: false,
  });
});

it('keeps validation checkpoints atomic on error, serializes concurrent requests and stops after canonical changes', async () => {
  const f = await receiveTransaction(await transactionFixture());
  const id = f.manifest.transaction_id;
  await projectTransaction(f.actor, id);
  failStatement = (sql) => {
    if (sql.startsWith('UPDATE business_sync_transaction_validations'))
      throw new Error('checkpoint failure');
  };
  await expect(validateBusinessTransaction(f.actor, id)).rejects.toThrow(
    'checkpoint failure',
  );
  expect(await businessTransactionValidationStatus(f.actor, id)).toMatchObject({
    checked_structural_rules: 0,
  });
  failStatement = undefined;
  const single = await validateBusinessTransaction(f.actor, id);
  db.prepare(
    'UPDATE business_sync_transaction_validations SET next_structural_rule=0 WHERE transfer_id=?',
  ).run(id);
  let arrivals = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  beforeRun = async (sql) => {
    if (!sql.startsWith('UPDATE business_sync_transaction_validations')) return;
    if (++arrivals === 2) release();
    await barrier;
  };
  await Promise.all([
    validateBusinessTransaction(f.actor, id),
    validateBusinessTransaction(f.actor, id),
  ]);
  beforeRun = undefined;
  expect(await businessTransactionValidationStatus(f.actor, id)).toMatchObject({
    checked_structural_rules: single.checked_structural_rules,
  });
  db.exec('UPDATE business_sync_spaces SET head_revision=2');
  await expect(validateBusinessTransaction(f.actor, id)).rejects.toThrow(
    'révision partagée',
  );
  expect((await historyHead(f.actor)).head_revision).toBe(2);
});

it('cannot finish a credit projection after a new canonical revision wins its mutation batch', async () => {
  const f = await receiveTransaction(await transactionFixture());
  const id = f.manifest.transaction_id;
  await projectTransaction(f.actor, id);
  let status = await validateBusinessTransaction(f.actor, id);
  for (let i = 0; i < 100 && status.phase !== 'projecting'; i++)
    status = await validateBusinessTransaction(f.actor, id);
  expect(status.phase).toBe('projecting');
  beforeBatch = async () => {
    beforeBatch = undefined;
    db.exec('UPDATE business_sync_spaces SET head_revision=2');
  };
  await expect(validateBusinessTransaction(f.actor, id)).rejects.toThrow();
  expect(
    db
      .prepare(
        'SELECT phase FROM business_sync_transaction_validations WHERE transfer_id=?',
      )
      .get(id),
  ).toEqual({ phase: 'projecting' });
  expect(
    db
      .prepare(
        "SELECT json_extract(state_json,'$.phase') phase FROM business_sync_credit_projection WHERE transfer_id=?",
      )
      .get(id),
  ).toEqual({ phase: 'documents' });
  expect((await historyHead(f.actor)).head_revision).toBe(2);
});

it('projects exact insert/update/delete images without overwriting the canonical history or reusing deleted ordering positions', async () => {
  const first = transactionInsert('1', 'first');
  const changed = transactionClient(
    'first',
    'Conditions\nDeuxième ligne : été.',
  );
  const update: TransactionChange = {
    ...first,
    sequence: '2',
    operation: 'update',
    before_json: first.after_json,
    after_json: changed,
  };
  const remove: TransactionChange = {
    ...first,
    sequence: '3',
    operation: 'delete',
    before_json: changed,
    after_json: null,
  };
  const last = transactionInsert('4', 'last');
  const f = await receiveTransaction(
    await transactionFixture([[first, update, remove, last]]),
  );
  const id = f.manifest.transaction_id;
  expect(await projectTransaction(f.actor, id)).toMatchObject({
    state: 'projected',
    applied_changes: 4,
    copied_rows: 1,
    next_chunk: 1,
    audit_entries: 0,
    financial_validated: false,
    canonical_committed: false,
    replication_active: false,
  });
  expect(
    db
      .prepare(
        "SELECT row_json FROM business_sync_versions WHERE transfer_id=? AND table_name='clients'",
      )
      .all(id),
  ).toEqual([{ row_json: last.after_json }]);
  expect(
    db
      .prepare(
        "SELECT source_rowid FROM business_sync_row_order WHERE transfer_id=? AND table_name='clients'",
      )
      .all(id),
  ).toEqual([{ source_rowid: '2' }]);
  expect(
    db
      .prepare(
        'SELECT count(*) n FROM business_sync_versions WHERE transfer_id=?',
      )
      .get(f.receipt.transfer_id),
  ).toEqual({ n: 1 });
  expect((await historyHead(f.actor)).head_revision).toBe(1);
  expect(count('business_sync_audit_branches')).toBe(0);
  expect(await reviewBusinessTransaction(f.actor, id)).toEqual(
    await businessTransactionReviewStatus(f.actor, id),
  );
  const stored = db
    .prepare(
      'SELECT object_key FROM business_sync_transaction_parts WHERE transaction_id=?',
    )
    .get(id)!.object_key as string;
  expect(blobs.get(stored)).toEqual(f.chunks[0]);
  expect(
    db
      .prepare(
        'SELECT part_index,change_index,canonical_rowid FROM business_sync_transaction_canonical_order WHERE transfer_id=? ORDER BY part_index,change_index',
      )
      .all(id),
  ).toEqual([
    { part_index: 0, change_index: 0, canonical_rowid: '1' },
    { part_index: 0, change_index: 1, canonical_rowid: '1' },
    { part_index: 0, change_index: 2, canonical_rowid: '1' },
    { part_index: 0, change_index: 3, canonical_rowid: '2' },
  ]);
});

it('records a before-image conflict without changing the committed row or hiding the original modification', async () => {
  const base = await ready();
  const receipt = await publishBootstrap(owner, base.id);
  const actual = db
    .prepare('SELECT row_json FROM business_sync_versions WHERE transfer_id=?')
    .get(base.id)!.row_json as string;
  const before = JSON.stringify({
    ...JSON.parse(actual),
    company_name: 'Autre version',
  });
  const after = JSON.stringify({
    ...JSON.parse(actual),
    company_name: 'Modification hors ligne',
  });
  const change: TransactionChange = {
    sequence: '1',
    table: 'settings',
    key_json: '[1]',
    operation: 'update',
    before_json: before,
    after_json: after,
    source_rowid: '1',
    files_before: [],
    files_after: [],
  };
  const f = await receiveTransaction(
    await transactionFixture([[change]], receipt),
  );
  expect(
    await projectTransaction(f.actor, f.manifest.transaction_id),
  ).toMatchObject({
    state: 'conflict',
    applied_changes: 0,
    conflicts: [
      {
        table_name: 'settings',
        row_key_json: '[1]',
        change_index: 0,
        expected_sha256: await sha256Hex(before),
        current_sha256: await sha256Hex(actual),
        incoming_sha256: await sha256Hex(after),
        reason: 'before_mismatch',
      },
    ],
  });
  expect(
    db
      .prepare(
        "SELECT row_json FROM business_sync_versions WHERE table_name='settings'",
      )
      .all(),
  ).toEqual([{ row_json: actual }, { row_json: actual }]);
  expect((await historyHead(f.actor)).head_revision).toBe(1);
});

it('preserves shared integer primary keys when replacing a candidate row', async () => {
  const base = await ready();
  const receipt = await publishBootstrap(owner, base.id);
  const row = db
    .prepare('SELECT row_json FROM business_sync_versions WHERE transfer_id=?')
    .get(base.id)!.row_json as string;
  const remove: TransactionChange = {
    sequence: '1',
    table: 'settings',
    key_json: '[1]',
    operation: 'delete',
    before_json: row,
    after_json: null,
    source_rowid: '1',
    files_before: [],
    files_after: [],
  };
  const insert: TransactionChange = {
    ...remove,
    sequence: '2',
    operation: 'insert',
    before_json: null,
    after_json: row,
  };
  const f = await receiveTransaction(
    await transactionFixture([[remove, insert]], receipt),
  );
  expect(
    await projectTransaction(f.actor, f.manifest.transaction_id),
  ).toMatchObject({ state: 'projected', applied_changes: 2 });
  expect(
    db
      .prepare(
        'SELECT source_rowid FROM business_sync_row_order WHERE transfer_id=?',
      )
      .get(f.manifest.transaction_id),
  ).toEqual({ source_rowid: '1' });
});

it('rolls back failed candidate copies and applications, and resumes simultaneous retries exactly once', async () => {
  const f = await receiveTransaction(await transactionFixture());
  const id = f.manifest.transaction_id;
  await beginBusinessTransactionReview(f.actor, id);
  failStatement = (sql) => {
    if (sql.startsWith('INSERT INTO business_sync_row_order'))
      throw new Error('copy failure');
  };
  await expect(reviewBusinessTransaction(f.actor, id)).rejects.toThrow(
    'copy failure',
  );
  expect(
    db
      .prepare(
        'SELECT count(*) n FROM business_sync_versions WHERE transfer_id=?',
      )
      .get(id),
  ).toEqual({ n: 0 });
  expect(await businessTransactionReviewStatus(f.actor, id)).toMatchObject({
    copied_rows: 0,
    applied_changes: 0,
  });
  failStatement = undefined;
  await Promise.all([
    reviewBusinessTransaction(f.actor, id),
    reviewBusinessTransaction(f.actor, id),
  ]);
  expect(await businessTransactionReviewStatus(f.actor, id)).toMatchObject({
    copied_rows: 1,
  });
  await reviewBusinessTransaction(f.actor, id);
  failStatement = (sql) => {
    if (sql.startsWith('INSERT INTO business_sync_versions'))
      throw new Error('application failure');
  };
  await expect(reviewBusinessTransaction(f.actor, id)).rejects.toThrow(
    'application failure',
  );
  expect(
    db
      .prepare(
        "SELECT last_value FROM business_sync_candidate_order WHERE transfer_id=? AND table_name='clients'",
      )
      .get(id),
  ).toEqual({ last_value: 0 });
  expect(
    db
      .prepare(
        'SELECT COUNT(*) n FROM business_sync_transaction_canonical_order WHERE transfer_id=?',
      )
      .get(id),
  ).toEqual({ n: 0 });
  failStatement = undefined;
  await Promise.all([
    reviewBusinessTransaction(f.actor, id),
    reviewBusinessTransaction(f.actor, id),
  ]);
  expect(await businessTransactionReviewStatus(f.actor, id)).toMatchObject({
    state: 'projected',
    applied_changes: 1,
  });
  expect(
    db
      .prepare(
        "SELECT source_rowid FROM business_sync_row_order WHERE transfer_id=? AND table_name='clients'",
      )
      .get(id),
  ).toEqual({ source_rowid: '1' });
});

it('stops candidate writes when the canonical head changes immediately before the batch', async () => {
  const f = await receiveTransaction(await transactionFixture());
  const id = f.manifest.transaction_id;
  await beginBusinessTransactionReview(f.actor, id);
  await reviewBusinessTransaction(f.actor, id);
  await reviewBusinessTransaction(f.actor, id);
  beforeBatch = async () => {
    beforeBatch = undefined;
    db.exec('UPDATE business_sync_spaces SET head_revision=2');
  };
  expect(await reviewBusinessTransaction(f.actor, id)).toMatchObject({
    state: 'stale',
    applied_changes: 0,
  });
  expect(
    db
      .prepare(
        "SELECT count(*) n FROM business_sync_versions WHERE transfer_id=? AND table_name='clients'",
      )
      .get(id),
  ).toEqual({ n: 0 });
});

it('resumes within large fragments and records the original change offset on a later conflict', async () => {
  const changes = Array.from({ length: 65 }, (_, i) =>
    transactionInsert(String(i + 1), `client-${i}`),
  );
  changes[40] = {
    ...changes[40],
    operation: 'update',
    before_json: changes[40].after_json,
    after_json: transactionClient('client-40', 'Un autre état'),
  };
  const f = await receiveTransaction(await transactionFixture([changes]));
  const id = f.manifest.transaction_id;
  await beginBusinessTransactionReview(f.actor, id);
  await reviewBusinessTransaction(f.actor, id);
  await reviewBusinessTransaction(f.actor, id);
  beforeBatch = async (sql) => {
    expect(sql.length).toBeLessThanOrEqual(100);
  };
  expect(await reviewBusinessTransaction(f.actor, id)).toMatchObject({
    state: 'applying',
    applied_changes: 12,
    next_chunk: 0,
  });
  for (let pass = 0; pass < 2; pass++)
    await reviewBusinessTransaction(f.actor, id);
  expect(await reviewBusinessTransaction(f.actor, id)).toMatchObject({
    state: 'conflict',
    applied_changes: 36,
    next_chunk: 0,
    conflicts: [{ part_index: 0, change_index: 40, reason: 'before_mismatch' }],
  });
  expect((await historyHead(f.actor)).head_revision).toBe(1);
});

it('requires verified documents and the original authorized device for transaction reviews', async () => {
  const f = await fileTransaction(encode('Plan à conserver'));
  const id = f.manifest.transaction_id;
  await expect(beginBusinessTransactionReview(f.actor, id)).rejects.toThrow();
  expect(count('business_sync_transaction_reviews')).toBe(0);
  await uploadBusinessTransactionFilePart(
    f.actor,
    id,
    f.sha,
    0,
    request(f.content, f.sha),
  );
  await verifyBusinessTransactionFile(f.actor, id, f.sha);
  await beginBusinessTransactionReview(f.actor, id);
  for (const actor of [
    { ...f.actor, organizationId: 'org_other' },
    { ...f.actor, installationId: crypto.randomUUID() },
    { ...f.actor, role: 'read_only' as const },
  ]) {
    await expect(businessTransactionReviewStatus(actor, id)).rejects.toThrow();
    await expect(reviewBusinessTransaction(actor, id)).rejects.toThrow();
  }
  expect(await projectTransaction(f.actor, id)).toMatchObject({
    state: 'projected',
    applied_changes: 2,
  });
  mocks.session.mockRejectedValue(
    new AccountPublicError('Session requise.', 401),
  );
  for (const [method, handler] of [
    ['GET', reviewHttp.GET],
    ['POST', reviewHttp.POST],
  ] as const) {
    const result = await handler(
      new Request(
        `https://example.test/api/sync/transactions/review?transaction_id=${id}`,
        { method },
      ),
    );
    expect(result.status).toBe(401);
    expect(result.headers.get('cache-control')).toContain('no-store');
  }
});

function reviewEvidence(id: string) {
  return [
    'business_sync_transaction_reviews',
    'business_sync_versions',
    'business_sync_row_order',
    'business_sync_candidate_order',
    'business_sync_transaction_canonical_order',
    'business_sync_transaction_conflicts',
    ...derivedValidationTables,
  ].map((table) =>
    db
      .prepare(`SELECT * FROM ${table} WHERE transfer_id=? ORDER BY rowid`)
      .all(id),
  );
}
function originalReviewEvidence(id: string) {
  return {
    changes: businessEvidence().changes,
    blobs: businessEvidence().blobs,
    source: db
      .prepare(
        "SELECT v.* FROM business_sync_versions v JOIN business_sync_transfers t ON t.transfer_id=v.transfer_id WHERE t.state='committed' ORDER BY v.sequence",
      )
      .all(),
    envelope: db
      .prepare('SELECT * FROM business_sync_transfers WHERE transfer_id=?')
      .get(id),
  };
}
async function legacyReview() {
  const f = await receiveTransaction(await transactionFixture());
  const id = f.manifest.transaction_id;
  await projectTransaction(f.actor, id);
  await validateTransaction(f.actor, id);
  db.prepare(
    'UPDATE business_sync_transaction_reviews SET algorithm_version=1,validator_sha256=? WHERE transfer_id=?',
  ).run('a'.repeat(64), id);
  db.prepare(
    'DELETE FROM business_sync_transaction_canonical_order WHERE transfer_id=?',
  ).run(id);
  return { ...f, id };
}
it('upgrades legacy reviews atomically and rebuilds canonical positions from original evidence', async () => {
  const f = await legacyReview(),
    original = originalReviewEvidence(f.id),
    old = reviewEvidence(f.id);
  await expect(
    businessTransactionReviewStatus(f.actor, f.id),
  ).rejects.toMatchObject({ status: 409 });
  expect(reviewEvidence(f.id)).toEqual(old);
  failStatement = (sql) => {
    if (
      sql.startsWith(
        'UPDATE business_sync_transaction_reviews SET algorithm_version',
      )
    )
      throw new Error('upgrade interruption');
  };
  await expect(beginBusinessTransactionReview(f.actor, f.id)).rejects.toThrow(
    'upgrade interruption',
  );
  expect(reviewEvidence(f.id)).toEqual(old);
  expect(originalReviewEvidence(f.id)).toEqual(original);
  failStatement = undefined;
  const result = await beginBusinessTransactionReview(f.actor, f.id);
  expect(result).toMatchObject({
    algorithm_version: TRANSACTION_REVIEW_VERSION,
    state: 'copying',
    copied_rows: 0,
    applied_changes: 0,
  });
  expect(validationEvidence(f.id).every((rows) => rows.length === 0)).toBe(
    true,
  );
  expect(originalReviewEvidence(f.id)).toEqual(original);
  expect((await projectTransaction(f.actor, f.id)).state).toBe('projected');
  expect(
    db
      .prepare(
        'SELECT canonical_rowid FROM business_sync_transaction_canonical_order WHERE transfer_id=?',
      )
      .all(f.id),
  ).toEqual([{ canonical_rowid: '1' }]);
  expect((await validateTransaction(f.actor, f.id)).phase).toBe('valid');
  expect(originalReviewEvidence(f.id)).toEqual(original);
});
it('never downgrades future review algorithms or resets an unrecognized current contract', async () => {
  const f = await legacyReview();
  for (const version of [
    TRANSACTION_REVIEW_VERSION,
    TRANSACTION_REVIEW_VERSION + 1,
    0,
  ]) {
    db.prepare(
      'UPDATE business_sync_transaction_reviews SET algorithm_version=? WHERE transfer_id=?',
    ).run(version, f.id);
    const before = reviewEvidence(f.id);
    await expect(
      beginBusinessTransactionReview(f.actor, f.id),
    ).rejects.toMatchObject({ status: 409 });
    expect(reviewEvidence(f.id)).toEqual(before);
  }
});
it('keeps legacy review data when the canonical head changes before an upgrade', async () => {
  const f = await legacyReview(),
    before = reviewEvidence(f.id),
    original = originalReviewEvidence(f.id);
  beforeBatch = async () => {
    beforeBatch = undefined;
    db.exec('UPDATE business_sync_spaces SET head_revision=2');
  };
  await expect(
    beginBusinessTransactionReview(f.actor, f.id),
  ).rejects.toMatchObject({ status: 409 });
  expect(reviewEvidence(f.id)).toEqual(before);
  expect(originalReviewEvidence(f.id)).toEqual(original);
});
it('shares one upgraded review attempt across simultaneous retries', async () => {
  const f = await legacyReview(),
    original = originalReviewEvidence(f.id);
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrivals = 0;
  beforeBatch = async (sql) => {
    if (
      !sql.some((s) =>
        s.startsWith(
          'UPDATE business_sync_transaction_reviews SET algorithm_version',
        ),
      )
    )
      return;
    if (++arrivals === 2) release();
    await barrier;
  };
  const responses = await Promise.all([
    beginBusinessTransactionReview(f.actor, f.id),
    beginBusinessTransactionReview(f.actor, f.id),
  ]);
  beforeBatch = undefined;
  expect(arrivals).toBe(2);
  expect(responses[0].attempt).toBe(responses[1].attempt);
  expect(responses[0].algorithm_version).toBe(TRANSACTION_REVIEW_VERSION);
  expect(originalReviewEvidence(f.id)).toEqual(original);
  expect((await projectTransaction(f.actor, f.id)).state).toBe('projected');
  expect(
    db
      .prepare(
        'SELECT COUNT(*) n FROM business_sync_transaction_canonical_order WHERE transfer_id=?',
      )
      .get(f.id),
  ).toEqual({ n: 1 });
});
it('cannot finish a candidate with a missing canonical event position', async () => {
  const f = await receiveTransaction(
    await transactionFixture([
      Array.from({ length: 13 }, (_, i) =>
        transactionInsert(String(i + 1), `ordered-${i}`),
      ),
    ]),
  );
  const id = f.manifest.transaction_id;
  await beginBusinessTransactionReview(f.actor, id);
  await reviewBusinessTransaction(f.actor, id);
  await reviewBusinessTransaction(f.actor, id);
  expect((await reviewBusinessTransaction(f.actor, id)).applied_changes).toBe(
    12,
  );
  db.prepare(
    'DELETE FROM business_sync_transaction_canonical_order WHERE transfer_id=? AND change_index=0',
  ).run(id);
  expect(await reviewBusinessTransaction(f.actor, id)).toMatchObject({
    state: 'invalid',
    failed_rule: 'candidate:canonical-order',
    applied_changes: 12,
  });
  expect((await historyHead(f.actor)).head_revision).toBe(1);
});

it('refuses altered stored transaction bytes and missing or mismatched source ordering before projection', async () => {
  const f = await receiveTransaction(await transactionFixture());
  const id = f.manifest.transaction_id;
  await beginBusinessTransactionReview(f.actor, id);
  db.prepare(
    "UPDATE business_sync_row_order SET source_rowid='2' WHERE transfer_id=?",
  ).run(f.receipt.transfer_id);
  await expect(reviewBusinessTransaction(f.actor, id)).rejects.toThrow();
  db.prepare(
    "UPDATE business_sync_row_order SET source_rowid='1' WHERE transfer_id=?",
  ).run(f.receipt.transfer_id);
  await reviewBusinessTransaction(f.actor, id);
  await reviewBusinessTransaction(f.actor, id);
  const key = db
    .prepare(
      'SELECT object_key FROM business_sync_transaction_parts WHERE transaction_id=?',
    )
    .get(id)!.object_key as string;
  const bytes = Uint8Array.from(blobs.get(key)!);
  bytes[0] ^= 1;
  blobs.set(key, bytes);
  await expect(reviewBusinessTransaction(f.actor, id)).rejects.toMatchObject({
    status: 503,
  });
  expect(await businessTransactionReviewStatus(f.actor, id)).toMatchObject({
    state: 'applying',
    applied_changes: 0,
  });
});

it.each([
  ['9007199254740992', '9007199254740993', 'projected'],
  ['9223372036854775806', '9223372036854775807', 'projected'],
  ['9223372036854775807', null, 'conflict'],
])(
  'keeps canonical ordering exact at SQLite boundary %s',
  async (floor, expected, state) => {
    const f = await receiveTransaction(await transactionFixture());
    const id = f.manifest.transaction_id;
    // A previous revision may retain an order floor after deleting older rows.
    db.prepare(
      "INSERT INTO business_sync_candidate_order VALUES(?,'clients',CAST(? AS INTEGER))",
    ).run(f.receipt.transfer_id, floor);
    expect(await projectTransaction(f.actor, id)).toMatchObject({ state });
    const row = db
      .prepare(
        "SELECT source_rowid FROM business_sync_row_order WHERE transfer_id=? AND table_name='clients'",
      )
      .get(id);
    if (expected) {
      expect(row).toEqual({ source_rowid: expected });
      expect(
        db
          .prepare(
            'SELECT canonical_rowid FROM business_sync_transaction_canonical_order WHERE transfer_id=?',
          )
          .get(id),
      ).toEqual({ canonical_rowid: expected });
    } else {
      expect(row).toBeUndefined();
      expect(await businessTransactionReviewStatus(f.actor, id)).toMatchObject({
        conflicts: [{ reason: 'order_exhausted' }],
      });
    }
  },
);

it('resumes an established device audit branch and rejects replay of its committed source sequence', async () => {
  const anchor = 'b'.repeat(64);
  const f = await receiveTransaction(
    await transactionFixture([
      [await auditChange('9007199254740994', 'continued-audit', anchor)],
    ]),
  );
  const m = f.manifest;
  db.prepare(
    'INSERT INTO business_sync_audit_branches VALUES(?,?,?,?,?,?,?)',
  ).run(
    m.organization_id,
    m.generation,
    m.installation_id,
    m.capture_generation,
    anchor,
    '9007199254740993',
    1,
  );
  expect(await projectTransaction(f.actor, m.transaction_id)).toMatchObject({
    state: 'projected',
    audit_entries: 1,
  });
  expect(
    db
      .prepare(
        'SELECT last_hash,last_sequence FROM business_sync_audit_branches',
      )
      .get(),
  ).toEqual({ last_hash: anchor, last_sequence: '9007199254740993' });
  const next = await receiveTransaction(
    await transactionFixture(
      [[await auditChange('9007199254740993', 'old-audit', anchor)]],
      f.receipt,
    ),
  );
  db.prepare(
    'INSERT INTO business_sync_audit_branches VALUES(?,?,?,?,?,?,?)',
  ).run(
    next.manifest.organization_id,
    next.manifest.generation,
    next.manifest.installation_id,
    next.manifest.capture_generation,
    anchor,
    '9007199254740993',
    1,
  );
  await expect(
    beginBusinessTransactionReview(next.actor, next.manifest.transaction_id),
  ).rejects.toThrow('plus récente');
});

async function auditChange(
  sequence: string,
  id: string,
  previous_hash: string | null = null,
): Promise<TransactionChange> {
  const row: Record<string, unknown> = {
    id,
    occurred_at: '2026-09-08T12:00:00Z',
    actor: 'local_user',
    action: 'create',
    entity_type: 'client',
    entity_id: 'fictif',
    payload_json: '{"notes":"Deux lignes\\nÉté"}',
    previous_hash,
  };
  row.entry_hash = await sha256Hex(
    [previous_hash ?? '', ...auditHashFields.map((field) => row[field])].join(
      '\n',
    ),
  );
  return {
    sequence,
    table: 'audit_log',
    key_json: JSON.stringify([id]),
    operation: 'insert',
    before_json: null,
    after_json: JSON.stringify(row),
    source_rowid: sequence,
    files_before: [],
    files_after: [],
  };
}

it('verifies separate original audit branches without rewriting either hash chain or advancing an origin receipt', async () => {
  const a = await receiveTransaction(
    await transactionFixture([[await auditChange('1', 'first-audit')]]),
  );
  const b = await receiveTransaction(
    await transactionFixture(
      [[await auditChange('1', 'other-audit')]],
      a.receipt,
    ),
  );
  for (const f of [a, b]) {
    expect(
      await projectTransaction(f.actor, f.manifest.transaction_id),
    ).toMatchObject({ state: 'projected', audit_entries: 1 });
    expect(
      db
        .prepare(
          "SELECT row_json FROM business_sync_versions WHERE transfer_id=? AND table_name='audit_log'",
        )
        .get(f.manifest.transaction_id),
    ).toEqual({
      row_json: JSON.parse(new TextDecoder().decode(f.chunks[0])).changes[0]
        .after_json,
    });
  }
  expect(count('business_sync_audit_branches')).toBe(0);
  expect((await historyHead(a.actor)).head_revision).toBe(1);
});

it.each(['hash', 'parent', 'immutable'])(
  'rejects an invalid audit %s without projecting unaudited row changes',
  async (rule) => {
    const audit = await auditChange(
      '2',
      'audit',
      rule === 'parent' ? 'a'.repeat(64) : null,
    );
    if (rule === 'hash')
      audit.after_json = audit.after_json!.replace(
        'local_user',
        'changed_user',
      );
    if (rule === 'immutable') {
      audit.operation = 'delete';
      audit.before_json = audit.after_json;
      audit.after_json = null;
    }
    const f = await receiveTransaction(
      await transactionFixture([[transactionInsert('1'), audit]]),
    );
    expect(
      await projectTransaction(f.actor, f.manifest.transaction_id),
    ).toMatchObject({
      state: 'invalid',
      failed_rule: `audit:${rule}`,
      applied_changes: 0,
      audit_entries: 0,
    });
    expect(
      db
        .prepare(
          'SELECT count(*) n FROM business_sync_versions WHERE transfer_id=?',
        )
        .get(f.manifest.transaction_id),
    ).toEqual({ n: 1 });
  },
);

it('receives later transaction bytes idempotently without advancing the canonical history or rounding source sequences', async () => {
  const { manifest, chunks, actor } = await transactionFixture();
  const initialVersions = count('business_sync_versions');
  expect(
    await beginBusinessTransaction(actor, JSON.stringify(manifest)),
  ).toMatchObject({ state: 'receiving', canonical_committed: false });
  const first = await uploadBusinessTransactionChunk(
    actor,
    manifest.transaction_id,
    0,
    request(chunks[0]),
  );
  expect(first).toMatchObject({
    state: 'awaiting_validation',
    canonical_committed: false,
    replication_active: false,
  });
  expect(
    await uploadBusinessTransactionChunk(
      actor,
      manifest.transaction_id,
      0,
      request(chunks[0]),
    ),
  ).toEqual(first);
  expect(
    await beginBusinessTransaction(actor, JSON.stringify(manifest)),
  ).toEqual(first);
  expect(count('business_sync_transaction_parts')).toBe(1);
  expect(count('business_sync_transaction_changes')).toBe(1);
  expect(
    db
      .prepare(
        'SELECT sequence,source_rowid,after_sha256 FROM business_sync_transaction_changes',
      )
      .get(),
  ).toEqual({
    sequence: '9007199254740993',
    source_rowid: '9007199254740993',
    after_sha256: await sha256Hex(transactionClient()),
  });
  const stored = db
    .prepare('SELECT object_key FROM business_sync_transaction_parts')
    .get()!.object_key as string;
  expect(blobs.get(stored)).toEqual(chunks[0]);
  expect(count('business_sync_versions')).toBe(initialVersions);
  expect(await historyHead(actor)).toMatchObject({ head_revision: 1 });
});

it('rolls back every part receipt and row metadata on a database failure, then resumes the retained original bytes', async () => {
  const { manifest, chunks, actor } = await transactionFixture([
    [transactionInsert('1', 'a'), transactionInsert('2', 'b')],
  ]);
  await beginBusinessTransaction(actor, JSON.stringify(manifest));
  failStatement = (sql) => {
    if (sql.includes('INSERT INTO business_sync_transaction_changes'))
      throw new Error('database unavailable');
  };
  await expect(
    uploadBusinessTransactionChunk(
      actor,
      manifest.transaction_id,
      0,
      request(chunks[0]),
    ),
  ).rejects.toThrow();
  expect(count('business_sync_transaction_parts')).toBe(0);
  expect(count('business_sync_transaction_changes')).toBe(0);
  failStatement = undefined;
  expect(
    await uploadBusinessTransactionChunk(
      actor,
      manifest.transaction_id,
      0,
      request(chunks[0]),
    ),
  ).toMatchObject({ state: 'awaiting_validation' });
  expect(count('business_sync_transaction_changes')).toBe(2);
});

it('checks intermediate images across chunk boundaries and never calls invalid received rows applied', async () => {
  const insert = transactionInsert('1');
  const update: TransactionChange = {
    ...insert,
    sequence: '2',
    operation: 'update',
    before_json: transactionClient(
      'client-transaction',
      'another previous state',
    ),
    after_json: transactionClient('client-transaction', 'last state'),
  };
  const { manifest, chunks, actor } = await transactionFixture([
    [insert],
    [update],
  ]);
  await beginBusinessTransaction(actor, JSON.stringify(manifest));
  expect(
    await uploadBusinessTransactionChunk(
      actor,
      manifest.transaction_id,
      1,
      request(chunks[1]),
    ),
  ).toMatchObject({ state: 'receiving' });
  expect(
    await uploadBusinessTransactionChunk(
      actor,
      manifest.transaction_id,
      0,
      request(chunks[0]),
    ),
  ).toMatchObject({ state: 'invalid', canonical_committed: false });
  expect(await historyHead(actor)).toMatchObject({ head_revision: 1 });
});

it('isolates later transactions by company, device, capture generation and role, including races after blob storage', async () => {
  const { manifest, chunks, actor } = await transactionFixture();
  await expect(
    beginBusinessTransaction(
      { ...actor, role: 'read_only' },
      JSON.stringify(manifest),
    ),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    beginBusinessTransaction(
      { ...actor, installationId: crypto.randomUUID() },
      JSON.stringify(manifest),
    ),
  ).rejects.toMatchObject({ status: 403 });
  await beginBusinessTransaction(actor, JSON.stringify(manifest));
  await expect(
    businessTransactionStatus(
      { ...actor, organizationId: 'org_other' },
      manifest.transaction_id,
    ),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    beginBusinessTransaction(
      actor,
      JSON.stringify({ ...manifest, base_revision: 2 }),
    ),
  ).rejects.toThrow();
  beforeBatch = async (sql) => {
    if (sql.some((s) => s.includes('business_sync_transaction_parts'))) {
      beforeBatch = undefined;
      db.prepare(
        'UPDATE business_sync_spaces SET generation=? WHERE organization_id=?',
      ).run(crypto.randomUUID(), actor.organizationId);
    }
  };
  await expect(
    uploadBusinessTransactionChunk(
      actor,
      manifest.transaction_id,
      0,
      request(chunks[0]),
    ),
  ).rejects.toThrow();
  expect(count('business_sync_transaction_parts')).toBe(0);
  expect(count('business_sync_transaction_changes')).toBe(0);
});

it('rejects duplicate envelope keys, altered hashes, unknown fields, local-only rows and replayed source sequences', async () => {
  const { manifest, chunks, actor } = await transactionFixture();
  const raw = JSON.stringify(manifest);
  await expect(
    transactionManifest(raw.replace('"version":1', '"version":0,"version":1')),
  ).rejects.toThrow();
  await expect(
    transactionManifest(JSON.stringify({ ...manifest, unexpected: true })),
  ).rejects.toThrow();
  const changed = JSON.parse(new TextDecoder().decode(chunks[0]));
  changed.changes[0].table = 'app_license';
  expect(() => transactionChanges(encode(changed), manifest, 0)).toThrow();
  await beginBusinessTransaction(actor, raw);
  await expect(
    uploadBusinessTransactionChunk(
      actor,
      manifest.transaction_id,
      0,
      request(encode(changed)),
    ),
  ).rejects.toThrow();
  await uploadBusinessTransactionChunk(
    actor,
    manifest.transaction_id,
    0,
    request(chunks[0]),
  );
  const duplicate = { ...manifest, transaction_id: crypto.randomUUID() };
  await beginBusinessTransaction(actor, JSON.stringify(duplicate));
  await expect(
    uploadBusinessTransactionChunk(
      actor,
      duplicate.transaction_id,
      0,
      request(chunks[0]),
    ),
  ).rejects.toThrow();
  expect(count('business_sync_transaction_parts')).toBe(1);
  expect(count('business_sync_transaction_changes')).toBe(1);
});

it('authenticates every later-transaction endpoint and preserves no-store on rejection', async () => {
  mocks.session.mockRejectedValue(
    new AccountPublicError('Connexion nécessaire.', 401),
  );
  for (const handler of [
    transactionHttp.GET,
    transactionHttp.POST,
    transactionHttp.PUT,
    transactionFileHttp.GET,
    transactionFileHttp.POST,
    transactionFileHttp.PUT,
  ]) {
    const response = await handler(
      new Request('https://example.test/api/sync/transactions'),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toContain('no-store');
  }
});

async function fileTransaction(
  content: Uint8Array,
  published?: { generation: string; transfer_id: string },
) {
  const base = await transactionFixture(undefined, published);
  const sha = await sha256Hex(content),
    size = content.length;
  const local = new DatabaseSync(':memory:');
  let row: string;
  try {
    for (const table of Object.values(structuralSchema.tables))
      local.exec(table.sql);
    local
      .prepare(
        "INSERT INTO attachments(id,original_name,stored_name,size_bytes,sha256,created_at,updated_at) VALUES('doc','plan.txt','plan.txt',?,?,'x','x')",
      )
      .run(size, sha);
    row = local
      .prepare(
        `SELECT json_object(${contract.tables.attachments.columns.flatMap((c) => [`'${c}'`, `"${c}"`]).join(',')}) image FROM attachments`,
      )
      .get()!.image as string;
  } finally {
    local.close();
  }
  const proof = {
    root: 'attachments' as const,
    path: 'plan.txt',
    sha256: sha,
    size_bytes: size,
  };
  const insert: TransactionChange = {
    sequence: '1',
    table: 'attachments',
    key_json: '["doc"]',
    operation: 'insert',
    before_json: null,
    after_json: row,
    source_rowid: '1',
    files_before: [],
    files_after: [proof],
  };
  const deletion: TransactionChange = {
    ...insert,
    sequence: '2',
    operation: 'delete',
    before_json: row,
    after_json: null,
    files_before: [proof],
    files_after: [],
  };
  const bytes = encode({ version: 1, changes: [insert, deletion] });
  const manifest: TransactionManifest = {
    ...base.manifest,
    first_sequence: '1',
    last_sequence: '2',
    change_count: 2,
    size_bytes: bytes.length,
    chunks: [
      {
        sha256: await sha256Hex(bytes),
        size_bytes: bytes.length,
        change_count: 2,
      },
    ],
    files: [{ sha256: sha, size_bytes: size }],
  };
  await beginBusinessTransaction(base.actor, JSON.stringify(manifest));
  expect(
    await uploadBusinessTransactionChunk(
      base.actor,
      manifest.transaction_id,
      0,
      request(bytes),
    ),
  ).toMatchObject({
    state: 'awaiting_files',
    files_pending: 1,
    pending_files: [manifest.files[0]],
  });
  return { ...base, manifest, sha, content };
}
it('receives deleted transaction documents out of order, resumes exact parts and verifies the complete file without acknowledging business changes', async () => {
  const content = new Uint8Array(BUSINESS_FILE_PART_BYTES + 19).fill(37),
    f = await fileTransaction(content),
    id = f.manifest.transaction_id;
  expect(await businessTransactionFileStatus(f.actor, id, f.sha)).toMatchObject(
    { verified: false, uploaded_parts: [] },
  );
  await expect(
    verifyBusinessTransactionFile(f.actor, id, f.sha),
  ).rejects.toThrow('manquent');
  for (const index of [1, 0, 0]) {
    const part = content.slice(
      index * BUSINESS_FILE_PART_BYTES,
      (index + 1) * BUSINESS_FILE_PART_BYTES,
    );
    await uploadBusinessTransactionFilePart(
      f.actor,
      id,
      f.sha,
      index,
      request(part, await sha256Hex(part)),
    );
  }
  const verified = await verifyBusinessTransactionFile(f.actor, id, f.sha);
  expect(verified).toMatchObject({
    verified: true,
    canonical_committed: false,
  });
  expect(verified.uploaded_parts).toHaveLength(2);
  expect(await verifyBusinessTransactionFile(f.actor, id, f.sha)).toEqual(
    verified,
  );
  expect(await businessTransactionStatus(f.actor, id)).toMatchObject({
    state: 'awaiting_validation',
    files_pending: 0,
    pending_files: [],
    canonical_committed: false,
  });
  expect(
    db.prepare('SELECT head_revision FROM business_sync_spaces').get()!
      .head_revision,
  ).toBe(1);
  expect(count('business_sync_versions')).toBe(1);
  const keys = [...blobs.keys()]
    .filter((k) =>
      k.includes(`/transactions/${f.manifest.capture_generation}/${id}/files/`),
    )
    .sort();
  expect(keys).toHaveLength(2);
  expect(
    Buffer.concat(keys.map((k) => blobs.get(k)!)).equals(Buffer.from(content)),
  ).toBe(true);
});
it('rejects changed upload bytes, changed retained bytes and a whole-file hash that does not match otherwise valid parts', async () => {
  const f = await fileTransaction(encode({ original: 'Plan du projet' })),
    id = f.manifest.transaction_id;
  const changed = Uint8Array.from(f.content);
  changed[0] ^= 1;
  await expect(
    uploadBusinessTransactionFilePart(
      f.actor,
      id,
      f.sha,
      0,
      request(changed, f.sha),
    ),
  ).rejects.toThrow('altéré');
  expect(count('business_sync_file_parts')).toBe(1); // Initial bootstrap document only.
  await uploadBusinessTransactionFilePart(
    f.actor,
    id,
    f.sha,
    0,
    request(changed, await sha256Hex(changed)),
  );
  await expect(
    verifyBusinessTransactionFile(f.actor, id, f.sha),
  ).rejects.toThrow('origine');
  expect(
    (await businessTransactionFileStatus(f.actor, id, f.sha)).verified,
  ).toBe(false);
  await expect(
    uploadBusinessTransactionFilePart(
      f.actor,
      id,
      f.sha,
      0,
      request(f.content, f.sha),
    ),
  ).rejects.toThrow('autre contenu');
  const key = [...blobs.keys()].find(
    (k) => k.includes(`/transactions/`) && k.endsWith(`/files/${f.sha}/0`),
  )!;
  blobs.set(key, f.content);
  await expect(
    verifyBusinessTransactionFile(f.actor, id, f.sha),
  ).rejects.toThrow('altéré');
});
it('verifies an empty retained transaction document without inventing a binary fragment', async () => {
  const f = await fileTransaction(new Uint8Array());
  await expect(
    uploadBusinessTransactionFilePart(
      f.actor,
      f.manifest.transaction_id,
      f.sha,
      0,
      request(new Uint8Array(), f.sha),
    ),
  ).rejects.toThrow('figure pas');
  expect(
    await verifyBusinessTransactionFile(
      f.actor,
      f.manifest.transaction_id,
      f.sha,
    ),
  ).toMatchObject({ verified: true, uploaded_parts: [] });
  expect(
    await businessTransactionStatus(f.actor, f.manifest.transaction_id),
  ).toMatchObject({ files_pending: 0, state: 'awaiting_validation' });
});
it('keeps file metadata atomic after SQL failure and refuses other companies, devices, roles and generation changes during storage', async () => {
  const f = await fileTransaction(encode({ file: 'Confidentiel fictif' })),
    id = f.manifest.transaction_id;
  for (const actor of [
    { ...f.actor, organizationId: 'org_other' },
    { ...f.actor, installationId: crypto.randomUUID() },
    { ...f.actor, role: 'read_only' as const },
  ]) {
    await expect(
      businessTransactionFileStatus(actor, id, f.sha),
    ).rejects.toThrow();
    await expect(
      uploadBusinessTransactionFilePart(
        actor,
        id,
        f.sha,
        0,
        request(f.content, f.sha),
      ),
    ).rejects.toThrow();
  }
  await expect(
    businessTransactionFileStatus(f.actor, id, 'a'.repeat(64)),
  ).rejects.toThrow();
  failStatement = (sql) => {
    if (sql.includes('INSERT OR IGNORE INTO business_sync_file_parts'))
      throw new Error('Interrupted receipt');
  };
  await expect(
    uploadBusinessTransactionFilePart(
      f.actor,
      id,
      f.sha,
      0,
      request(f.content, f.sha),
    ),
  ).rejects.toThrow('Interrupted receipt');
  expect(
    db
      .prepare(
        'SELECT COUNT(*) n FROM business_sync_file_blobs WHERE transfer_id=?',
      )
      .get(id)!.n,
  ).toBe(0);
  expect(
    db
      .prepare(
        'SELECT COUNT(*) n FROM business_sync_file_parts WHERE transfer_id=?',
      )
      .get(id)!.n,
  ).toBe(0);
  failStatement = undefined;
  await uploadBusinessTransactionFilePart(
    f.actor,
    id,
    f.sha,
    0,
    request(f.content, f.sha),
  );
  beforeBatch = async () => {
    beforeBatch = undefined;
    db.prepare('UPDATE business_sync_spaces SET generation=?').run(
      crypto.randomUUID(),
    );
  };
  await expect(
    verifyBusinessTransactionFile(f.actor, id, f.sha),
  ).rejects.toThrow();
  expect(
    db
      .prepare(
        'SELECT verified_at FROM business_sync_file_blobs WHERE transfer_id=?',
      )
      .get(id)!.verified_at,
  ).toBeNull();
});

it('cannot publish a complete validated history with missing source ordering', async () => {
  const f = await ready();
  db.exec('DELETE FROM business_sync_row_order');
  await expect(publishBootstrap(owner, f.id)).rejects.toThrow();
  unpublished();
});
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
  const body = JSON.parse(new TextDecoder().decode(f.chunks[0]));
  body.version = 1;
  delete body.rows[0].source_rowid;
  f.chunks[0] = encode(body);
  legacy.chunks = [
    {
      ...legacy.chunks[0],
      sha256: await sha256Hex(f.chunks[0]),
      size_bytes: f.chunks[0].length,
    },
  ];
  legacy.size_bytes = f.chunks[0].length;
  f.manifest = await bootstrapManifest(legacy);
  await stage(f);
  await validate(f.id);
  await expect(publishBootstrap(owner, f.id)).rejects.toMatchObject({
    status: 409,
  });
  unpublished();
});
async function realD1Fixture() {
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
    return { runtime, d1 };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
it('prepares canonical event positions and upgrades reviews within 100 D1 queries per request', async () => {
  const { runtime, d1 } = await realD1Fixture();
  try {
    const f = await receiveTransaction(
      await transactionFixture([
        Array.from({ length: 65 }, (_, i) =>
          transactionInsert(String(i + 1), `bounded-${i}`),
        ),
      ]),
    );
    const id = f.manifest.transaction_id;
    let queries = 0,
      peak = 0;
    const wrap = (native: D1PreparedStatement) => ({
      native,
      bind(...values: Scalar[]) {
        return wrap(native.bind(...values));
      },
      async first(column?: string) {
        queries++;
        return column === undefined ? native.first() : native.first(column);
      },
      async all() {
        queries++;
        return native.all();
      },
      async run() {
        queries++;
        return native.run();
      },
    });
    mocks.db.mockReturnValue({
      prepare: (sql: string) => wrap(d1.prepare(sql)),
      batch: async (statements: ReturnType<typeof wrap>[]) => {
        queries += statements.length;
        return d1.batch(statements.map((s) => s.native));
      },
    });
    const requestPass = async <T>(action: () => Promise<T>) => {
      queries = 0;
      const result = await action();
      peak = Math.max(peak, queries);
      expect(queries).toBeLessThanOrEqual(100);
      return result;
    };
    let status = await requestPass(() =>
      beginBusinessTransactionReview(f.actor, id),
    );
    while (['copying', 'applying'].includes(status.state))
      status = await requestPass(() => reviewBusinessTransaction(f.actor, id));
    expect(status).toMatchObject({
      state: 'projected',
      applied_changes: 65,
      algorithm_version: TRANSACTION_REVIEW_VERSION,
    });
    expect(peak).toBeGreaterThan(70);
    const before = await d1
      .prepare(
        'SELECT change_index,canonical_rowid FROM business_sync_transaction_canonical_order WHERE transfer_id=? ORDER BY part_index,change_index',
      )
      .bind(id)
      .all();
    expect(before.results).toEqual(
      Array.from({ length: 65 }, (_, i) => ({
        change_index: i,
        canonical_rowid: String(i + 1),
      })),
    );
    await d1
      .prepare(
        'UPDATE business_sync_transaction_reviews SET algorithm_version=1,validator_sha256=? WHERE transfer_id=?',
      )
      .bind('a'.repeat(64), id)
      .run();
    status = await requestPass(() =>
      beginBusinessTransactionReview(f.actor, id),
    );
    expect(status).toMatchObject({ state: 'copying', applied_changes: 0 });
    while (['copying', 'applying'].includes(status.state))
      status = await requestPass(() => reviewBusinessTransaction(f.actor, id));
    expect(status.state).toBe('projected');
    expect(
      (
        await d1
          .prepare(
            'SELECT change_index,canonical_rowid FROM business_sync_transaction_canonical_order WHERE transfer_id=? ORDER BY part_index,change_index',
          )
          .bind(id)
          .all()
      ).results,
    ).toEqual(before.results);
    expect((await historyHead(f.actor)).head_revision).toBe(1);
    console.info(
      'QA_CANONICAL_ORDER',
      JSON.stringify({
        events: 65,
        peakQueries: peak,
        upgradeReplayed: true,
        headRevision: 1,
      }),
    );
  } finally {
    await runtime.dispose();
  }
}, 120_000);
it('compiles every intermediate accounting query against actual D1 limits', async () => {
  const { runtime, d1 } = await realD1Fixture();
  try {
    const { reject, native, after, row, effects, ...other } =
      transactionTransitionSql;
    const nativeQueries = Object.fromEntries(
      Object.entries(native).map(([key, sql]) => [`native:${key}`, sql]),
    );
    const afterQueries = Object.fromEntries(
      Object.entries(after).map(([key, sql]) => [`after:${key}`, sql]),
    );
    const rowQueries = Object.fromEntries(
      Object.entries(row).map(([key, sql]) => [`row:${key}`, sql]),
    );
    for (const [key, sql] of Object.entries({
      ...reject,
      ...nativeQueries,
      ...afterQueries,
      ...rowQueries,
      ...Object.fromEntries(
        Object.entries(effects.record).map(([key, sql]) => [
          `effect:${key}`,
          sql,
        ]),
      ),
      'effect:check': effects.check,
      'effect:consume': effects.consume,
      'effect:finish': effects.finish,
      ...other,
    })) {
      expect(new TextEncoder().encode(sql).length, key).toBeLessThanOrEqual(
        100_000,
      );
      const parameters = Math.max(
        ...[...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])),
      );
      expect(parameters, key).toBeLessThanOrEqual(100);
      try {
        await d1
          .prepare(sql)
          .bind(...Array(parameters).fill(null))
          .run();
      } catch (error) {
        throw new Error(`Transition query ${key} failed`, { cause: error });
      }
    }
  } finally {
    await runtime.dispose();
  }
}, 30_000);
it('executes publication, counter reservation, second-device reads and bounded transaction staging using the real D1 runtime', async () => {
  const { runtime, d1 } = await realD1Fixture();
  try {
    // Compile every candidate credit statement against D1, including branches
    // not reached by the small fixture. No transfer identity makes the guard
    // inactive; LIMIT and integer work fields still use valid scalar values.
    for (const [key, sql] of Object.entries(transactionCreditProjectionSql)) {
      expect(new TextEncoder().encode(sql).length).toBeLessThanOrEqual(100_000);
      const parameters = Math.max(
        ...[...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])),
      );
      const values: Scalar[] = Array(parameters).fill(null);
      values[5] = 10;
      for (const index of [7, 8, 14]) values[index] = '0';
      for (const index of [9, 10, 11, 17]) values[index] = 0;
      values[18] = '{}';
      try {
        await d1
          .prepare(sql)
          .bind(...values)
          .run();
      } catch (error) {
        throw new Error(`Candidate credit query ${key} failed`, {
          cause: error,
        });
      }
    }
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
    const inserts = Array.from({ length: 200 }, (_, i) =>
      transactionInsert(String(i + 1), `client-${i}`),
    );
    const update: TransactionChange = {
      ...inserts[0],
      sequence: '201',
      operation: 'update',
      before_json: inserts[0].after_json,
      after_json: transactionClient(
        'client-0',
        'Modifié après la première partie',
      ),
    };
    const sent = await transactionFixture([inserts, [update]], receipt);
    await beginBusinessTransaction(sent.actor, JSON.stringify(sent.manifest));
    // Out-of-order delivery still seals one ordered, complete operation.
    await uploadBusinessTransactionChunk(
      sent.actor,
      sent.manifest.transaction_id,
      1,
      request(sent.chunks[1]),
    );
    const received = await uploadBusinessTransactionChunk(
      sent.actor,
      sent.manifest.transaction_id,
      0,
      request(sent.chunks[0]),
    );
    expect(received).toMatchObject({
      state: 'awaiting_validation',
      canonical_committed: false,
    });
    expect(
      await uploadBusinessTransactionChunk(
        sent.actor,
        sent.manifest.transaction_id,
        0,
        request(sent.chunks[0]),
      ),
    ).toEqual(received);
    expect(
      await d1
        .prepare('SELECT COUNT(*) n FROM business_sync_transaction_changes')
        .first('n'),
    ).toBe(201);
    expect(
      await projectTransaction(sent.actor, sent.manifest.transaction_id),
    ).toMatchObject({
      state: 'projected',
      applied_changes: 201,
      copied_rows: 1,
      next_chunk: 2,
      canonical_committed: false,
    });
    expect(
      await validateTransaction(sent.actor, sent.manifest.transaction_id),
    ).toMatchObject({
      phase: 'valid',
      snapshot_validated: true,
      canonical_committed: false,
    });
    expect(
      await d1
        .prepare(
          'SELECT count(*) n FROM business_sync_versions WHERE transfer_id=?',
        )
        .bind(sent.manifest.transaction_id)
        .first('n'),
    ).toBe(201);
    expect(
      await d1
        .prepare(
          "SELECT row_json FROM business_sync_versions WHERE transfer_id=? AND table_name='clients' AND row_key_json='[\"client-0\"]'",
        )
        .bind(sent.manifest.transaction_id)
        .first('row_json'),
    ).toBe(update.after_json);
    expect(
      await d1
        .prepare(
          "SELECT source_rowid FROM business_sync_row_order WHERE transfer_id=? AND table_name='clients' AND row_key_json='[\"client-199\"]'",
        )
        .bind(sent.manifest.transaction_id)
        .first('source_rowid'),
    ).toBe('200');
    const duplicate = { ...sent.manifest, transaction_id: crypto.randomUUID() };
    await beginBusinessTransaction(sent.actor, JSON.stringify(duplicate));
    await expect(
      uploadBusinessTransactionChunk(
        sent.actor,
        duplicate.transaction_id,
        0,
        request(sent.chunks[0]),
      ),
    ).rejects.toThrow();
    expect(
      await d1
        .prepare(
          'SELECT COUNT(*) n FROM business_sync_transaction_parts WHERE transaction_id=?',
        )
        .bind(duplicate.transaction_id)
        .first('n'),
    ).toBe(0);
    const document = await fileTransaction(
      new Uint8Array(BUSINESS_FILE_PART_BYTES + 7).fill(81),
      receipt,
    );
    for (const index of [1, 0]) {
      const bytes = document.content.slice(
        index * BUSINESS_FILE_PART_BYTES,
        (index + 1) * BUSINESS_FILE_PART_BYTES,
      );
      await uploadBusinessTransactionFilePart(
        document.actor,
        document.manifest.transaction_id,
        document.sha,
        index,
        request(bytes, await sha256Hex(bytes)),
      );
    }
    expect(
      await verifyBusinessTransactionFile(
        document.actor,
        document.manifest.transaction_id,
        document.sha,
      ),
    ).toMatchObject({ verified: true, canonical_committed: false });
    expect(
      await businessTransactionStatus(
        document.actor,
        document.manifest.transaction_id,
      ),
    ).toMatchObject({
      state: 'awaiting_validation',
      files_pending: 0,
      pending_files: [],
    });
    expect(
      await d1
        .prepare('SELECT head_revision FROM business_sync_spaces')
        .first('head_revision'),
    ).toBe(1);
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
    if (process.env.ZENTRA_TRANSACTION_QA) {
      const folder = process.env.ZENTRA_TRANSACTION_QA;
      const original: TransactionManifest = JSON.parse(
        readFileSync(join(folder, 'manifest.json'), 'utf8'),
      );
      // Only rebind the QA transport to this newly published copy of the same
      // native history. Original client/audit row bytes and hashes stay intact.
      const manifest = {
        ...original,
        generation: receipt.generation,
        bootstrap_transfer_id: receipt.transfer_id,
      };
      const actor = { ...second, installationId: original.installation_id };
      const chunks = manifest.chunks.map(
        (_, i) =>
          new Uint8Array(
            readFileSync(join(folder, `${String(i).padStart(4, '0')}.json`)),
          ),
      );
      await receiveTransaction({ manifest, chunks, actor, receipt });
      expect(
        await projectTransaction(actor, manifest.transaction_id),
      ).toMatchObject({
        state: 'projected',
        copied_rows: 1365,
        applied_changes: 2,
        audit_entries: 1,
        financial_validated: false,
        canonical_committed: false,
      });
      expect(
        await validateTransaction(actor, manifest.transaction_id),
      ).toMatchObject({
        phase: 'valid',
        snapshot_validated: true,
        credit_projection: { phase: 'valid' },
        canonical_committed: false,
      });
      expect(
        db
          .prepare(
            'SELECT count(*) n FROM business_sync_versions WHERE transfer_id=?',
          )
          .get(manifest.transaction_id),
      ).toEqual({ n: 1367 });
      expect(
        db
          .prepare(
            "SELECT count(*) n FROM business_sync_versions WHERE transfer_id=? AND table_name='audit_log'",
          )
          .get(manifest.transaction_id),
      ).toEqual({ n: 1088 });
      expect((await historyHead(actor)).head_revision).toBe(1);
      for (const table of ['invoices', 'journal_entries'] as const) {
        const source = db
          .prepare(
            `SELECT v.row_json,o.source_rowid FROM business_sync_versions v JOIN business_sync_row_order o ON o.transfer_id=v.transfer_id AND o.table_name=v.table_name AND o.row_key_json=v.row_key_json WHERE v.transfer_id=? AND v.table_name=? AND (?<>'invoices' OR json_extract(v.row_json,'$.number') IS NOT NULL) LIMIT 1`,
          )
          .get(f.id, table, table)!;
        const original = source.row_json as string;
        const image = JSON.parse(original);
        // Balanced totals cannot authorize rewriting issued text or a journal.
        // Restoring that journal afterward must not erase the attempted change.
        const after =
          table === 'invoices'
            ? JSON.stringify({
                ...image,
                notes: 'Condition changée après émission',
              })
            : JSON.stringify({ ...image, description: 'Texte réécrit' });
        const change: TransactionChange = {
          sequence: '1',
          table,
          key_json: JSON.stringify([image.id]),
          operation: 'update',
          before_json: original,
          after_json: after,
          source_rowid: source.source_rowid as string,
          files_before: [],
          files_after: [],
        };
        const bad = await receiveTransaction(
          await transactionFixture(
            [
              [
                change,
                ...(table === 'journal_entries'
                  ? [
                      {
                        ...change,
                        sequence: '2',
                        before_json: after,
                        after_json: original,
                      },
                    ]
                  : []),
              ],
            ],
            receipt,
          ),
        );
        await projectTransaction(bad.actor, bad.manifest.transaction_id);
        expect(
          await validateTransaction(bad.actor, bad.manifest.transaction_id),
        ).toMatchObject({
          phase: 'invalid',
          failed_rule:
            table === 'invoices'
              ? 'immutable:issued-invoices'
              : 'immutable:append-only',
          snapshot_validated: false,
        });
        expect((await historyHead(actor)).head_revision).toBe(1);
      }
    }
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
