import contract from '../desktop/src-tauri/src/business_sync_tables.json';
import schema from '../desktop/src-tauri/src/business_sync_schema.json';
import { AccountPublicError, sha256Hex } from './account-security';
import { appendStateRow } from './business-sync-state-hash';
import { sourceRowid } from './business-sync-order';

export const STATE_PAGE_ROWS = 64;
export const STATE_PAGE_BYTES = 4 * 1024 * 1024;
export const STATE_MAX_ROWS = 200_000;
export const STATE_MAX_BYTES = 512 * 1024 * 1024;
const MAX_ROW_BYTES = 1024 * 1024;
const encoder = new TextEncoder();
export type StateCursor = {
  last_table: string;
  last_key: string;
  rows: number;
  bytes: number;
  sha256: string;
};
type Meta = {
  table_name: string;
  row_key_json: string;
  size_bytes: number;
  source_rowid: string | null;
};
function fail(): never {
  throw new AccountPublicError(
    'Les données à vérifier sont absentes, altérées ou dépassent les limites de réception.',
    503,
  );
}
export function validStateCursor(cursor: StateCursor) {
  if (
    !Number.isSafeInteger(cursor.rows) ||
    cursor.rows < 0 ||
    cursor.rows > STATE_MAX_ROWS ||
    !Number.isSafeInteger(cursor.bytes) ||
    cursor.bytes < 0 ||
    cursor.bytes > STATE_MAX_BYTES ||
    typeof cursor.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(cursor.sha256) ||
    typeof cursor.last_table !== 'string' ||
    typeof cursor.last_key !== 'string' ||
    (cursor.rows === 0
      ? cursor.last_table !== '' || cursor.last_key !== '' || cursor.bytes !== 0
      : !Object.hasOwn(contract.tables, cursor.last_table) ||
        !cursor.last_key ||
        encoder.encode(cursor.last_key).length > 1024)
  )
    fail();
}
// JSON values, including i64 money, are normalized entirely by SQLite. Parsing
// and serializing row JSON in JavaScript would silently round large integers.
export function stateRowSql(table: string) {
  const rule = contract.tables[table as keyof typeof contract.tables];
  if (!rule) fail();
  const primary = schema.tables[
    table as keyof typeof schema.tables
  ].columns.filter((c) => c.primary_key_position > 0);
  const alias =
    primary.length === 1 && primary[0].type.toUpperCase() === 'INTEGER'
      ? primary[0].name
      : null;
  const fields = rule.columns.map((c) => `'${c}'`).join(',');
  return `SELECT v.row_json,v.row_sha256,
    json_object(${rule.columns.flatMap((c) => [`'${c}'`, `json_extract(v.row_json,'$.${c}')`]).join(',')}) normalized,
    json_array(${rule.key.map((c) => `json_extract(v.row_json,'$.${c}')`).join(',')}) normalized_key,
    ((SELECT COUNT(*) FROM json_each(v.row_json))=${rule.columns.length}
      AND (SELECT COUNT(DISTINCT key) FROM json_each(v.row_json))=${rule.columns.length}
      AND NOT EXISTS(SELECT 1 FROM json_each(v.row_json) WHERE key NOT IN (${fields}) OR type NOT IN ('null','text','integer','real'))
      ${alias ? `AND CAST(json_extract(v.row_json,'$.${alias}') AS TEXT)=?5` : ''}) valid_fields
    FROM business_sync_versions v WHERE v.transfer_id=?1 AND v.organization_id=?2 AND v.table_name=?3 AND v.row_key_json=?4 AND ?5 IS NOT NULL`;
}

// A caller must pin the immutable source/candidate and CAS this returned cursor
// against its authenticated validation attempt. This function never commits.
export async function fingerprintStatePage(
  db: D1Database,
  transfer: string,
  organization: string,
  old: StateCursor,
) {
  validStateCursor(old);
  const metadata = (
    await db
      .prepare(`SELECT v.table_name,v.row_key_json,length(CAST(v.row_json AS BLOB)) size_bytes,o.source_rowid
    FROM business_sync_versions v LEFT JOIN business_sync_row_order o ON o.transfer_id=v.transfer_id AND o.table_name=v.table_name AND o.row_key_json=v.row_key_json
    WHERE v.transfer_id=? AND v.organization_id=? AND (v.table_name,v.row_key_json)>(?,?)
    ORDER BY v.table_name,v.row_key_json LIMIT ?`)
      .bind(
        transfer,
        organization,
        old.last_table,
        old.last_key,
        STATE_PAGE_ROWS,
      )
      .all<Meta>()
  ).results;
  const next = { ...old };
  let rawBytes = 0,
    pageBytes = 0,
    processed = 0;
  for (const meta of metadata) {
    if (
      !Object.hasOwn(contract.tables, meta.table_name) ||
      typeof meta.row_key_json !== 'string' ||
      encoder.encode(meta.row_key_json).length > 1024 ||
      !Number.isSafeInteger(meta.size_bytes) ||
      meta.size_bytes < 1 ||
      meta.size_bytes > MAX_ROW_BYTES ||
      meta.source_rowid === null
    )
      fail();
    const rowid = sourceRowid(meta.source_rowid, meta.table_name, {});
    if (rawBytes + meta.size_bytes > STATE_PAGE_BYTES) break;
    const row = await db
      .prepare(stateRowSql(meta.table_name))
      .bind(transfer, organization, meta.table_name, meta.row_key_json, rowid)
      .first<{
        row_json: string;
        row_sha256: string;
        normalized: string;
        normalized_key: string;
        valid_fields: number;
      }>();
    if (
      !row ||
      row.valid_fields !== 1 ||
      row.normalized_key !== meta.row_key_json ||
      typeof row.row_json !== 'string' ||
      typeof row.normalized !== 'string' ||
      encoder.encode(row.row_json).length !== meta.size_bytes ||
      (await sha256Hex(row.row_json)) !== row.row_sha256
    )
      fail();
    const size = encoder.encode(row.normalized).length;
    if (size > MAX_ROW_BYTES || size < 1) fail();
    if (pageBytes + size > STATE_PAGE_BYTES) break;
    if (next.rows + 1 > STATE_MAX_ROWS || next.bytes + size > STATE_MAX_BYTES)
      fail();
    next.sha256 = await appendStateRow(
      next.sha256,
      meta.table_name,
      meta.row_key_json,
      rowid,
      row.normalized,
    );
    next.rows++;
    next.bytes += size;
    next.last_table = meta.table_name;
    next.last_key = meta.row_key_json;
    rawBytes += meta.size_bytes;
    pageBytes += size;
    processed++;
  }
  return {
    cursor: next,
    complete:
      metadata.length < STATE_PAGE_ROWS && processed === metadata.length,
    processed,
  };
}
