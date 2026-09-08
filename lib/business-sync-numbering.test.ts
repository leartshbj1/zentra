import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import {
  historicalNumberFloorsSql,
  numberingFloors,
} from './business-sync-numbering';
it('retains deleted-draft counters, old prefixes, journal series and exhaustion without mixing companies', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(
      'CREATE TABLE business_sync_versions(transfer_id TEXT,organization_id TEXT,table_name TEXT,row_json TEXT); CREATE TABLE business_sync_transfers(transfer_id TEXT,organization_id TEXT,manifest_json TEXT)',
    );
    db.prepare('INSERT INTO business_sync_transfers VALUES(?,?,?)').run(
      'transfer',
      'org',
      JSON.stringify({
        numbering_floors: [
          { prefix: 'F', year: 2026, minimum: 81 },
          { prefix: 'J', year: 2024, minimum: 90 },
        ],
      }),
    );
    for (const [company, table, number] of [
      ['org', 'invoices', 'F-2026-0007'],
      ['org', 'quotes', 'OLD-F-2025-0200'],
      ['org', 'journal_entries', 'J-2024-000150'],
      ['org', 'invoices', 'X-2026-9223372036854775807'],
      ['org', 'invoices', 'LETTER-2026-something'],
      ['org', 'invoices', 'F-2026-0000000060'],
      ['other', 'invoices', 'F-2026-000900'],
    ])
      db.prepare('INSERT INTO business_sync_versions VALUES(?,?,?,?)').run(
        'transfer',
        company,
        table,
        JSON.stringify({ number }),
      );
    expect(
      db.prepare(historicalNumberFloorsSql).all('transfer', 'org'),
    ).toEqual([
      { prefix: 'F', year: 2026, minimum: 81 },
      { prefix: 'J', year: 2024, minimum: 151 },
      { prefix: 'OLD-F', year: 2025, minimum: 201 },
      { prefix: 'X', year: 2026, minimum: 1_000_000_000 },
    ]);
  } finally {
    db.close();
  }
});
it('requires sorted unique, bounded and exact native floor objects', () => {
  const valid = [
    { prefix: 'F', year: 2026, minimum: 81 },
    { prefix: 'J', year: 2026, minimum: 1_000_000_000 },
  ];
  expect(numberingFloors(valid)).toEqual(valid);
  for (const value of [
    null,
    {},
    [valid[1], valid[0]],
    [valid[0], valid[0]],
    [{ ...valid[0], minimum: 0 }],
    [{ ...valid[0], minimum: 1_000_000_001 }],
    [{ ...valid[0], prefix: 'f' }],
    [{ ...valid[0], year: 1899 }],
    [{ ...valid[0], private: true }],
  ])
    expect(() => numberingFloors(value)).toThrow();
});
