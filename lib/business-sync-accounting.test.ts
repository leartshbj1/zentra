import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { accountingRules } from './business-sync-accounting';
let db: DatabaseSync;
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE business_sync_versions(transfer_id TEXT,organization_id TEXT,table_name TEXT,row_key_json TEXT,row_json TEXT)',
  );
});
afterEach(() => db.close());
function row(
  table: string,
  id: string,
  data: Record<string, unknown>,
  org = 'first',
) {
  db.prepare('INSERT INTO business_sync_versions VALUES(?,?,?,?,?)').run(
    'transfer',
    org,
    table,
    JSON.stringify([id]),
    JSON.stringify(data),
  );
}
function entry(id = 'entry') {
  row('journal_entries', id, { id });
}
let index = 0;
function line(
  debit: number,
  credit: number,
  currency = 'CHF',
  entry_id = 'entry',
  org = 'first',
) {
  row(
    'journal_lines',
    `line-${index++}`,
    {
      journal_entry_id: entry_id,
      currency,
      debit_cents: debit,
      credit_cents: credit,
    },
    org,
  );
}
function failures() {
  return accountingRules
    .filter((rule) => db.prepare(rule.sql).get('transfer', 'first'))
    .map((rule) => rule.id);
}
it('accepts balanced positive postings and refuses empty or one-sided entries', () => {
  entry();
  expect(failures()).toContain('journal:lines');
  line(100, 0);
  expect(failures()).toContain('journal:balance');
  line(0, 100);
  expect(failures()).toEqual([]);
  line(0, 0);
  expect(failures()).toContain('journal:sides');
});
it('does not balance one currency or one company against another', () => {
  entry();
  line(100, 0, 'CHF');
  line(0, 100, 'EUR');
  expect(failures()).toContain('journal:balance');
  db.exec(
    "DELETE FROM business_sync_versions WHERE table_name='journal_lines'",
  );
  line(100, 0);
  line(0, 100, 'CHF', 'entry', 'other');
  expect(failures()).toContain('journal:balance');
});
it('detects one missing cent beyond the safe JavaScript integer range', () => {
  entry();
  line(9_000_000_000_000_000, 0);
  line(9_000_000_000_000_000, 0);
  line(0, 9_000_000_000_000_000);
  line(0, 8_999_999_999_999_999);
  expect(failures()).toEqual(['journal:balance']);
  line(0, 1);
  expect(failures()).toEqual([]);
});
it('reports a native integer overflow without triggering a SQLite aggregate exception', () => {
  entry();
  for (let i = 0; i < 1025; i++) {
    line(9_000_000_000_000_000, 0);
    line(0, 9_000_000_000_000_000);
  }
  expect(failures()).toEqual(['journal:balance', 'journal:range']);
});
it('checks the combined native integer cap even when each currency is balanced', () => {
  entry();
  for (let i = 0; i < 1025; i++) {
    const currency = i % 2 === 0 ? 'CHF' : 'EUR';
    line(9_000_000_000_000_000, 0, currency);
    line(0, 9_000_000_000_000_000, currency);
  }
  expect(failures()).toEqual(['journal:range']);
});
