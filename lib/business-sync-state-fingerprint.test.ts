import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import vectors from '../desktop/src-tauri/src/business_sync_state_hash_vectors.json';
import contract from '../desktop/src-tauri/src/business_sync_tables.json';
import schema from '../desktop/src-tauri/src/business_sync_schema.json';
import {
  appendStateRow,
  initialStateHash,
  STATE_FINGERPRINT_VERSION,
} from './business-sync-state-hash';
import {
  fingerprintStatePage,
  STATE_MAX_BYTES,
  STATE_MAX_ROWS,
  STATE_PAGE_BYTES,
  STATE_PAGE_ROWS,
  type StateCursor,
} from './business-sync-state-fingerprint';

type Row = {
  table: string;
  key_json: string;
  source_rowid: string;
  row_json: string;
};
let db: DatabaseSync, queries: number;
let metadataPlan: string[];
const d1 = {
  prepare(sql: string) {
    let values: (string | number | null)[] = [];
    const statement = {
      bind(...args: (string | number | null)[]) {
        values = args;
        return statement;
      },
      async first() {
        queries++;
        return db.prepare(sql).get(...values) ?? null;
      },
      async all() {
        queries++;
        metadataPlan = db
          .prepare('EXPLAIN QUERY PLAN ' + sql)
          .all(...values)
          .map((row) => String(row.detail));
        return { results: db.prepare(sql).all(...values) };
      },
    };
    return statement;
  },
} as unknown as D1Database;
beforeEach(() => {
  queries = 0;
  metadataPlan = [];
  db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE business_sync_versions(transfer_id TEXT,organization_id TEXT,table_name TEXT,row_key_json TEXT,row_json TEXT,row_sha256 TEXT,PRIMARY KEY(transfer_id,table_name,row_key_json));
CREATE TABLE business_sync_row_order(transfer_id TEXT,table_name TEXT,row_key_json TEXT,source_rowid TEXT,PRIMARY KEY(transfer_id,table_name,row_key_json));`);
});
afterEach(() => db.close());
function digest(raw: string) {
  return createHash('sha256').update(raw).digest('hex');
}
function insert(row: Row, transfer = 'source', organization = 'company') {
  db.prepare('INSERT INTO business_sync_versions VALUES(?,?,?,?,?,?)').run(
    transfer,
    organization,
    row.table,
    row.key_json,
    row.row_json,
    digest(row.row_json),
  );
  db.prepare('INSERT INTO business_sync_row_order VALUES(?,?,?,?)').run(
    transfer,
    row.table,
    row.key_json,
    row.source_rowid,
  );
}
async function start(): Promise<StateCursor> {
  return {
    last_table: '',
    last_key: '',
    rows: 0,
    bytes: 0,
    sha256: await initialStateHash(),
  };
}
function client(id: string, notes = 'Échéance\nAcompte 😀'): Row {
  const native = new DatabaseSync(':memory:');
  try {
    native.exec(schema.tables.clients.sql);
    native
      .prepare(
        "INSERT INTO clients(id,name,notes,created_at,updated_at) VALUES(?,'Client',?,'now','now')",
      )
      .run(id, notes);
    const raw = native
      .prepare(
        `SELECT json_object(${contract.tables.clients.columns.flatMap((c) => [`'${c}'`, `"${c}"`]).join(',')}) row_json FROM clients`,
      )
      .get()!.row_json as string;
    return {
      table: 'clients',
      key_json: JSON.stringify([id]),
      source_rowid: '1',
      row_json: raw,
    };
  } finally {
    native.close();
  }
}
function oracle(rows: Row[]) {
  let head = createHash('sha256').update('zentra-business-state-v2\0').digest();
  for (const row of [...rows].sort(
    (a, b) =>
      Buffer.compare(Buffer.from(a.table), Buffer.from(b.table)) ||
      Buffer.compare(Buffer.from(a.key_json), Buffer.from(b.key_json)),
  )) {
    const hash = createHash('sha256')
      .update('zentra-business-state-row-v2\0')
      .update(head);
    for (const value of [
      row.table,
      row.key_json,
      row.source_rowid,
      row.row_json,
    ]) {
      const bytes = Buffer.from(value),
        size = Buffer.alloc(8);
      size.writeBigUInt64BE(BigInt(bytes.length));
      hash.update(size).update(bytes);
    }
    head = hash.digest();
  }
  return head.toString('hex');
}
it('matches independently generated SHA256 vectors and rejects malformed saved heads', async () => {
  expect(STATE_FINGERPRINT_VERSION).toBe(vectors.version);
  let head = await initialStateHash();
  expect(head).toBe(vectors.seed);
  for (const row of vectors.rows) {
    head = await appendStateRow(
      head,
      ...(row.fields as [string, string, string, string]),
    );
    expect(head).toBe(row.sha256);
  }
  await expect(
    appendStateRow('invalid', 'clients', '[]', '1', '{}'),
  ).rejects.toThrow('empreinte');
});
it('is independent of retries, page boundaries and insertion order, including SQLite Unicode ordering', async () => {
  const rows = Array.from({ length: 135 }, (_, i) => ({
    ...client(i === 1 ? '\ue000' : i === 2 ? '😀' : `row-${i}`),
    source_rowid: String(i + 1),
  }));
  for (const row of [...rows].reverse()) insert(row);
  let cursor = await start(),
    passes = 0;
  while (true) {
    queries = 0;
    const old = { ...cursor };
    const page = await fingerprintStatePage(d1, 'source', 'company', cursor);
    expect(queries).toBeLessThanOrEqual(STATE_PAGE_ROWS + 1);
    expect(page.processed).toBeLessThanOrEqual(64);
    expect(await fingerprintStatePage(d1, 'source', 'company', old)).toEqual(
      page,
    );
    expect(cursor).toEqual(old);
    cursor = page.cursor;
    passes++;
    if (page.complete) break;
    expect(passes).toBeLessThan(10);
  }
  expect(passes).toBe(3);
  expect(cursor.rows).toBe(rows.length);
  expect(cursor.sha256).toBe(oracle(rows));
  expect(
    metadataPlan.some((detail) =>
      detail.includes('(table_name,row_key_json)>(?,?)'),
    ),
  ).toBe(true);
  expect(
    metadataPlan.some((detail) => detail.includes('USE TEMP B-TREE')),
  ).toBe(false);
});
it('normalizes JSON using SQLite without rounding i64 amounts or confusing row order with origin sequences', async () => {
  const native = new DatabaseSync(':memory:');
  let row: Row;
  try {
    native.exec(schema.tables.catalog_items.sql);
    native.exec(
      "INSERT INTO catalog_items(id,kind,name,sales_price_cents,purchase_cost_cents,created_at,updated_at) VALUES('item','service','Précis',9223372036854775807,9007199254740993,'now','now')",
    );
    row = {
      table: 'catalog_items',
      key_json: '["item"]',
      source_rowid: '-9223372036854775808',
      row_json: native
        .prepare(
          `SELECT json_object(${contract.tables.catalog_items.columns.flatMap((c) => [`'${c}'`, `"${c}"`]).join(',')}) row_json FROM catalog_items`,
        )
        .get()!.row_json as string,
    };
  } finally {
    native.close();
  }
  insert(row);
  const base = (
    await fingerprintStatePage(d1, 'source', 'company', await start())
  ).cursor.sha256;
  expect(base).toBe(oracle([row]));
  // Whitespace changes the raw envelope hash, but not the normalized state.
  const spaced = ' ' + row.row_json + '\n';
  db.prepare('UPDATE business_sync_versions SET row_json=?,row_sha256=?').run(
    spaced,
    digest(spaced),
  );
  expect(
    (await fingerprintStatePage(d1, 'source', 'company', await start())).cursor
      .sha256,
  ).toBe(base);
  db.prepare(
    "UPDATE business_sync_row_order SET source_rowid='9223372036854775807'",
  ).run();
  expect(
    (await fingerprintStatePage(d1, 'source', 'company', await start())).cursor
      .sha256,
  ).not.toBe(base);
});
it.each([
  'hash',
  'missing-order',
  'overflow-order',
  'duplicate',
  'unknown',
  'missing',
  'object',
  'wrong-key',
  'null-row',
  'foreign-table',
  'alias',
])('refuses corrupt %s data without advancing a cursor', async (kind) => {
  const row = client('one');
  insert(row);
  let raw = row.row_json;
  if (kind === 'hash')
    db.exec("UPDATE business_sync_versions SET row_sha256='bad'");
  if (kind === 'missing-order') db.exec('DELETE FROM business_sync_row_order');
  if (kind === 'overflow-order')
    db.exec(
      "UPDATE business_sync_row_order SET source_rowid='9223372036854775808'",
    );
  if (kind === 'duplicate') raw = raw.replace('{', '{"id":"one",');
  if (kind === 'unknown') raw = raw.replace('"notes":', '"unexpected":');
  if (kind === 'missing') {
    const parsed = JSON.parse(raw);
    delete parsed.notes;
    raw = JSON.stringify(parsed);
  }
  if (kind === 'object') raw = raw.replace('"name":"Client"', '"name":{}');
  if (kind === 'wrong-key') raw = raw.replace('"id":"one"', '"id":"two"');
  if (kind === 'null-row')
    db.exec('UPDATE business_sync_versions SET row_json=NULL');
  if (kind === 'foreign-table')
    db.exec("UPDATE business_sync_versions SET table_name='device_sessions'");
  if (kind === 'alias') {
    db.exec(
      'DELETE FROM business_sync_versions;DELETE FROM business_sync_row_order',
    );
    const native = new DatabaseSync(':memory:');
    try {
      native.exec(schema.tables.settings.sql);
      native.exec(
        "INSERT INTO settings(id,company_name,created_at,updated_at) VALUES(1,'Fictive','now','now')",
      );
      raw = native
        .prepare(
          `SELECT json_object(${contract.tables.settings.columns.flatMap((c) => [`'${c}'`, `"${c}"`]).join(',')}) row_json FROM settings`,
        )
        .get()!.row_json as string;
      insert({
        table: 'settings',
        key_json: '[1]',
        source_rowid: '2',
        row_json: raw,
      });
    } finally {
      native.close();
    }
  } else if (raw !== row.row_json)
    db.prepare('UPDATE business_sync_versions SET row_json=?,row_sha256=?').run(
      raw,
      digest(raw),
    );
  const cursor = await start(),
    old = { ...cursor };
  await expect(
    fingerprintStatePage(d1, 'source', 'company', cursor),
  ).rejects.toThrow();
  expect(cursor).toEqual(old);
});
it('bounds byte-heavy pages, the full dossier, and rejects oversized rows and forged cursors', async () => {
  for (let i = 0; i < 8; i++)
    insert({
      ...client(`large-${i}`, 'é'.repeat(350000)),
      source_rowid: String(i + 1),
    });
  const first = await fingerprintStatePage(
    d1,
    'source',
    'company',
    await start(),
  );
  expect(first.processed).toBeLessThan(8);
  expect(first.cursor.bytes).toBeLessThanOrEqual(STATE_PAGE_BYTES);
  expect(first.complete).toBe(false);
  for (const cursor of [
    { ...first.cursor, rows: STATE_MAX_ROWS },
    { ...first.cursor, bytes: STATE_MAX_BYTES },
    { ...first.cursor, rows: -1 },
    { ...first.cursor, sha256: '0' },
  ])
    await expect(
      fingerprintStatePage(d1, 'source', 'company', cursor),
    ).rejects.toThrow();
  db.exec(
    'DELETE FROM business_sync_versions;DELETE FROM business_sync_row_order',
  );
  insert(client('oversized', 'x'.repeat(1024 * 1024)));
  await expect(
    fingerprintStatePage(d1, 'source', 'company', await start()),
  ).rejects.toThrow();
});
it('matches the actual native SQLite export across all shared tables', async (context) => {
  const path = process.env.ZENTRA_STATE_FINGERPRINT_QA;
  if (!path) return context.skip();
  const native = JSON.parse(readFileSync(path, 'utf8')) as {
    version: number;
    sha256: string;
    rows: Row[];
  };
  expect(native.version).toBe(STATE_FINGERPRINT_VERSION);
  expect(native.rows.length).toBeGreaterThan(130);
  for (const row of native.rows) insert(row);
  let cursor = await start();
  for (let i = 0; i < 20; i++) {
    const page = await fingerprintStatePage(d1, 'source', 'company', cursor);
    cursor = page.cursor;
    if (page.complete) break;
  }
  expect(cursor.rows).toBe(native.rows.length);
  expect(cursor.sha256).toBe(native.sha256);
  expect(cursor.sha256).toBe(oracle(native.rows));
});
