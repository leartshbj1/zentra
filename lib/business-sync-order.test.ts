import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import {
  sourceRowid,
  sharedRowid,
  sourceAuditOrderSql,
} from './business-sync-order';

it('preserves signed SQLite order without Number rounding and verifies integer aliases', () => {
  for (const value of [
    '0',
    '1',
    '-7',
    '9007199254740993',
    '9223372036854775807',
    '-9223372036854775808',
  ])
    expect(sourceRowid(value, 'audit_log', {})).toBe(value);
  for (const value of [
    '01',
    '+1',
    '-0',
    '1.0',
    '1e3',
    '9223372036854775808',
    '-9223372036854775809',
    1,
    null,
  ])
    expect(() => sourceRowid(value, 'audit_log', {})).toThrow();
  expect(sourceRowid('1', 'settings', { id: 1 })).toBe('1');
  expect(() => sourceRowid('2', 'settings', { id: 1 })).toThrow();
  expect(sourceRowid('41', 'stock_movements', { id: 'movement' })).toBe('41');
  expect(sharedRowid('settings', { id: 1 })).toBe('1');
  expect(sharedRowid('clients', { id: 'client' })).toBeNull();
  expect(sharedRowid('stock_movements', { id: 'movement' })).toBeNull();
});
it('rejects an inverted audit order, including exact positions larger than the JS integer limit', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(
      "CREATE TABLE business_sync_transfers(transfer_id TEXT,organization_id TEXT); INSERT INTO business_sync_transfers VALUES('transfer','org'); CREATE TABLE business_sync_audit_nodes(transfer_id TEXT,validator_sha256 TEXT,row_key TEXT,entry_hash TEXT,previous_hash TEXT); CREATE TABLE business_sync_row_order(transfer_id TEXT,table_name TEXT,row_key_json TEXT,source_rowid TEXT)",
    );
    const row = (id: string, previous: string | null, position: string) => {
      db.prepare('INSERT INTO business_sync_audit_nodes VALUES(?,?,?,?,?)').run(
        'transfer',
        'validator',
        JSON.stringify([id]),
        id,
        previous,
      );
      db.prepare('INSERT INTO business_sync_row_order VALUES(?,?,?,?)').run(
        'transfer',
        'audit_log',
        JSON.stringify([id]),
        position,
      );
    };
    row('z', null, '9007199254740993');
    row('a', 'z', '9007199254740994');
    expect(
      db
        .prepare(sourceAuditOrderSql)
        .get('transfer', 'org', null, null, null, null, 'validator'),
    ).toBeUndefined();
    db.exec(
      "UPDATE business_sync_row_order SET source_rowid='9007199254740992' WHERE row_key_json='[\"a\"]'",
    );
    expect(
      db
        .prepare(sourceAuditOrderSql)
        .get('transfer', 'org', null, null, null, null, 'validator'),
    ).toBeDefined();
  } finally {
    db.close();
  }
});
