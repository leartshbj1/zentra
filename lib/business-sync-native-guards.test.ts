import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
vi.mock('./runtime', () => ({ database: vi.fn(), fileArchive: vi.fn() }));
import { transactionTransitionQueries } from './business-sync-transaction-transitions';
import {
  nativeGuardContract,
  serverNativeGuards,
  receiverNativeGuards,
  nativeGuardReadColumns,
  nativeGuardField,
} from './business-sync-native-guard-contract';
import { nativeGuardViewSql } from './business-sync-native-guards';
import { nativeGuardDigests } from './business-sync-native-guard-digests';
import { transitionRows } from './business-sync-transition-rows';
import type { TransactionChange } from './business-sync-transaction-format';
import { database } from './runtime';

export function nativeFixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE business_sync_transaction_validations(transfer_id TEXT PRIMARY KEY,phase TEXT,checked_changes INTEGER,next_change_chunk INTEGER,failed_rule TEXT,failed_change INTEGER,updated_at TEXT);
    CREATE TABLE business_sync_transaction_changes(transaction_id TEXT,organization_id TEXT,table_name TEXT,row_key_json TEXT,sequence TEXT,part_index INTEGER,change_index INTEGER);
    CREATE TABLE business_sync_versions(transfer_id TEXT,organization_id TEXT,table_name TEXT,row_key_json TEXT,row_json TEXT,UNIQUE(transfer_id,table_name,row_key_json));
    CREATE TABLE business_sync_row_order(transfer_id TEXT,table_name TEXT,row_key_json TEXT,source_rowid TEXT,UNIQUE(transfer_id,table_name,row_key_json));
    CREATE TABLE business_sync_transaction_accounting_states(transfer_id TEXT,validator_sha256 TEXT,table_name TEXT,row_key_json TEXT,row_json TEXT,UNIQUE(transfer_id,validator_sha256,table_name,row_key_json));`);
  return db;
}
it('accounts for every trusted native BEFORE guard and keeps the local timer context explicit', () => {
  expect(nativeGuardContract.native_schema_version).toBe(61);
  expect(nativeGuardContract.data_schema_version).toBe(60);
  expect(nativeGuardContract.guards).toHaveLength(391);
  expect(serverNativeGuards).toHaveLength(390);
  expect(receiverNativeGuards).toEqual([
    'project_tasks_active_timer_close_guard',
  ]);
});

type Row = Record<string, unknown>;
const sha = (payload: string) =>
  createHash('sha256').update(payload).digest('hex');
function scenario() {
  const db = nativeFixture();
  db.exec(
    "INSERT INTO business_sync_transaction_validations VALUES('tx','transitions',0,0,NULL,NULL,'original')",
  );
  const common = [
    'tx',
    'org',
    'device',
    'generation',
    'manifest',
    'attempt',
    'review',
    1,
    'projected',
    '',
    '',
    0,
    0,
    0,
    'validator',
  ];
  const args = (
    table: string,
    before: Row | null,
    after: Row | null,
    index = 0,
    digest: string | null = null,
  ) => [
    ...common,
    0,
    'source',
    'now',
    index,
    table,
    JSON.stringify([(before ?? after)!.id]),
    before === null ? null : JSON.stringify(before),
    after === null ? null : JSON.stringify(after),
    Math.floor(index / 200),
    index % 200,
    digest,
  ];
  const source = (
    table: string,
    id: string,
    row: Row,
    transfer = 'source',
    organization = 'org',
  ) =>
    db
      .prepare(
        'INSERT OR REPLACE INTO business_sync_versions VALUES(?,?,?,?,?)',
      )
      .run(
        transfer,
        organization,
        table,
        JSON.stringify([id]),
        JSON.stringify(row),
      );
  const state = (
    table: string,
    id: string,
    row: Row | null,
    validator = 'validator',
  ) =>
    db
      .prepare(
        'INSERT OR REPLACE INTO business_sync_transaction_accounting_states VALUES(?,?,?,?,?)',
      )
      .run(
        'tx',
        validator,
        table,
        JSON.stringify([id]),
        row === null ? null : JSON.stringify(row),
      );
  const order = (id: string, value: number) =>
    db
      .prepare('INSERT OR REPLACE INTO business_sync_row_order VALUES(?,?,?,?)')
      .run('tx', 'stock_movements', JSON.stringify([id]), String(value));
  const check = (
    table: string,
    before: Row | null,
    after: Row | null,
    index = 0,
  ) => {
    db.prepare(transactionTransitionQueries('SELECT 1').native[table]).run(
      ...args(table, before, after, index),
    );
    return db
      .prepare(
        'SELECT phase,failed_rule,failed_change FROM business_sync_transaction_validations',
      )
      .get();
  };
  return { db, args, source, state, order, check };
}

it('checks stock against canonical insertion order and excludes future movements', () => {
  const f = scenario();
  try {
    f.source('stock_movements', 'older', {
      id: 'older',
      catalog_item_id: 'item',
      sequence: 900,
      balance_after_milli: 1000,
    });
    f.source('stock_movements', 'latest', {
      id: 'latest',
      catalog_item_id: 'item',
      sequence: 1,
      balance_after_milli: 2000,
    });
    f.order('older', 1);
    f.order('latest', 2);
    f.source(
      'stock_movements',
      'future',
      { id: 'future', catalog_item_id: 'item', balance_after_milli: 3000 },
      'tx',
    );
    f.order('future', 3);
    f.db
      .prepare(
        'INSERT INTO business_sync_transaction_changes VALUES(?,?,?,?,?,?,?)',
      )
      .run('tx', 'org', 'stock_movements', '["future"]', '101', 0, 100);
    const before = { id: 'item', track_stock: 1, stock_quantity_milli: 1000 };
    expect(
      f.check('catalog_items', before, {
        ...before,
        stock_quantity_milli: 2000,
      }),
    ).toMatchObject({ phase: 'transitions' });
    expect(
      f.check('catalog_items', before, {
        ...before,
        stock_quantity_milli: 3000,
      }),
    ).toMatchObject({
      phase: 'invalid',
      failed_rule: 'native:catalog_items_stock_balance_guard',
    });
  } finally {
    f.db.close();
  }
});
it('uses changed stock state and rejects a missing canonical order', () => {
  const f = scenario();
  try {
    f.source('stock_movements', 'opening', {
      id: 'opening',
      catalog_item_id: 'item',
      balance_after_milli: 1000,
    });
    f.order('opening', 1);
    f.state('stock_movements', 'latest', {
      id: 'latest',
      catalog_item_id: 'item',
      sequence: 2,
      balance_after_milli: 2000,
    });
    const item = { id: 'item', track_stock: 1, stock_quantity_milli: 2000 };
    const before = { ...item, stock_quantity_milli: 1000 };
    expect(f.check('catalog_items', before, item)).toMatchObject({
      phase: 'transitions',
    });
    f.db.exec('DELETE FROM business_sync_row_order');
    expect(f.check('catalog_items', before, item)).toMatchObject({
      phase: 'invalid',
      failed_rule: 'native:missing-stock-order',
    });
  } finally {
    f.db.close();
  }
});
it('does not revive a deleted dependency or accept a missing earlier projection', () => {
  const f = scenario();
  try {
    f.source('stock_movements', 'opening', {
      id: 'opening',
      catalog_item_id: 'item',
      balance_after_milli: 1000,
    });
    f.order('opening', 1);
    f.state('stock_movements', 'opening', null);
    const bindings = f.args('catalog_items', null, { id: 'item' }).slice(0, 17);
    expect(
      f.db
        .prepare(`SELECT * FROM (${transitionRows('stock_movements')})`)
        .all(...bindings),
    ).toEqual([]);
    f.db
      .prepare(
        'INSERT INTO business_sync_transaction_changes VALUES(?,?,?,?,?,?,?)',
      )
      .run('tx', 'org', 'stock_movements', '["lost"]', '1', 0, 0);
    const item = { id: 'item', track_stock: 1, stock_quantity_milli: 0 };
    expect(f.check('catalog_items', item, item, 1)).toMatchObject({
      phase: 'invalid',
      failed_rule: 'native:missing-state:catalog_items',
    });
  } finally {
    f.db.close();
  }
});

function digestRuntime(db: DatabaseSync) {
  vi.mocked(database).mockReturnValue({
    prepare: (sql: string) => ({
      bind: (...values: (string | number | null)[]) => ({
        all: async () => ({ results: db.prepare(sql).all(...values) }),
      }),
    }),
  } as unknown as ReturnType<typeof database>);
}
const event = (
  table: string,
  id: string,
  after: Row | null,
): TransactionChange => ({
  sequence: '1',
  table,
  key_json: JSON.stringify([id]),
  operation: after === null ? 'delete' : 'insert',
  before_json: null,
  after_json: after === null ? null : JSON.stringify(after),
  source_rowid: '1',
  files_before: [],
  files_after: [],
});
it('hashes exact source bytes, isolates the organization and follows assessment changes in page order', async () => {
  const f = scenario();
  try {
    digestRuntime(f.db);
    const original =
      ' {"preuve":"Été à Genève 🌄","montant":9007199254740993} ';
    const replacement = '{"preuve":"Révision\\nconfirmée"}';
    f.source('payslip_small_salary_assessments', 'salary', {
      assessment_json: original,
      assessment_sha256: 'untrusted',
    });
    f.source(
      'payslip_small_salary_assessments',
      'foreign',
      { assessment_json: original },
      'source',
      'another-org',
    );
    const changes = [
      event('payslips', 'salary', { id: 'salary' }),
      event('payslip_small_salary_assessments', 'salary', {
        payslip_id: 'salary',
        assessment_json: replacement,
        assessment_sha256: 'wrong',
      }),
      event('payslips', 'salary', { id: 'salary' }),
      event('payslip_small_salary_assessments', 'salary', null),
      event('payslips', 'salary', { id: 'salary' }),
      event('payslips', 'foreign', { id: 'foreign' }),
      event('employees', 'person', { id: 'person' }),
    ];
    expect(
      await nativeGuardDigests('tx', 'org', 'validator', 'source', changes),
    ).toEqual([
      sha(original),
      sha(replacement),
      sha(replacement),
      null,
      null,
      null,
      null,
    ]);
  } finally {
    f.db.close();
  }
});
it('resumes from exact current assessment state, preserves tombstones and ignores another validator', async () => {
  const f = scenario();
  try {
    digestRuntime(f.db);
    for (const id of ['changed', 'deleted', 'stale'])
      f.source('payslip_small_salary_assessments', id, {
        assessment_json: 'source',
      });
    f.state('payslip_small_salary_assessments', 'changed', {
      assessment_json: 'current',
    });
    f.state('payslip_small_salary_assessments', 'deleted', null);
    f.state(
      'payslip_small_salary_assessments',
      'stale',
      { assessment_json: 'other-attempt' },
      'old-validator',
    );
    expect(
      await nativeGuardDigests(
        'tx',
        'org',
        'validator',
        'source',
        ['changed', 'deleted', 'stale', 'missing'].map((id) =>
          event('payslips', id, { id }),
        ),
      ),
    ).toEqual([sha('current'), null, sha('source'), null]);
  } finally {
    f.db.close();
  }
});
it('fails closed when a stored assessment is not text', async () => {
  const f = scenario();
  try {
    digestRuntime(f.db);
    f.source('payslip_small_salary_assessments', 'salary', {
      assessment_json: 42,
    });
    await expect(
      nativeGuardDigests('tx', 'org', 'validator', 'source', [
        event('payslips', 'salary', { id: 'salary' }),
      ]),
    ).rejects.toMatchObject({ status: 503 });
  } finally {
    f.db.close();
  }
});

it('preserves the native fiscal date result across all seven sources and blank dates', () => {
  const db = new DatabaseSync(':memory:');
  try {
    for (const [table, cols] of Object.entries(nativeGuardReadColumns))
      db.exec(
        `CREATE TABLE "${table}" (${cols.map((c) => `"${c}"`).join(',') || '__exists'})`,
      );
    const put = (table: string, row: Row) =>
      db
        .prepare(
          `INSERT INTO "${table}" (${Object.keys(row)
            .map((c) => `"${c}"`)
            .join(',')}) VALUES (${Object.keys(row)
            .map(() => '?')
            .join(',')})`,
        )
        .run(...(Object.values(row) as (string | number | null)[]));
    put('invoices', { id: 'invoice', issue_date: '2026-06-01' });
    put('invoice_items', { id: 'sale', invoice_id: 'invoice' });
    for (const date of ['2026-05-01', '2026-07-01', null, ' '])
      put('payments', { invoice_id: 'invoice', date });
    put('supplier_invoices', { id: 'purchase', document_date: '2026-04-01' });
    put('supplier_invoice_items', {
      id: 'goods',
      supplier_invoice_id: 'purchase',
    });
    put('supplier_payments', {
      supplier_invoice_id: 'purchase',
      date: '2026-03-01',
    });
    put('supplier_credit_notes', { id: 'credit', document_date: '2026-02-01' });
    put('supplier_credit_note_items', {
      id: 'returned',
      supplier_credit_note_id: 'credit',
    });
    put('expenses', {
      id: 'expense',
      date: '2026-06-01',
      paid_at: '2026-01-01',
    });
    put('expenses', { id: 'unpaid', date: '2026-08-01', paid_at: null });
    put('expenses', { id: 'blank', date: ' ', paid_at: '' });
    const native = nativeGuardContract.views.vat_source_fiscal_dates;
    const expected = db
      .prepare(native + ' ORDER BY source_type,source_id')
      .all();
    const adapted = db
      .prepare(
        nativeGuardViewSql('vat_source_fiscal_dates', native) +
          ' ORDER BY source_type,source_id',
      )
      .all();
    expect(adapted).toEqual(expected);
    expect(adapted).toEqual([
      {
        source_type: 'expense',
        source_id: 'expense',
        fiscal_date: '2026-01-01',
      },
      {
        source_type: 'expense',
        source_id: 'unpaid',
        fiscal_date: '2026-08-01',
      },
      {
        source_type: 'invoice_item',
        source_id: 'sale',
        fiscal_date: '2026-05-01',
      },
      {
        source_type: 'supplier_credit_note_item',
        source_id: 'returned',
        fiscal_date: '2026-02-01',
      },
      {
        source_type: 'supplier_invoice_item',
        source_id: 'goods',
        fiscal_date: '2026-03-01',
      },
    ]);
  } finally {
    db.close();
  }
});
it('compiles every generated native query without depending on native business tables or custom functions', () => {
  const db = nativeFixture();
  try {
    const queries = transactionTransitionQueries('SELECT 1').native;
    for (const [table, sql] of Object.entries(queries)) {
      expect(Buffer.byteLength(sql), table).toBeLessThanOrEqual(100000);
      expect(
        () => db.prepare('EXPLAIN ' + sql).all(...Array(26).fill(null)),
        table,
      ).not.toThrow();
    }
  } finally {
    db.close();
  }
});

it('keeps SQLite column comparison affinity and exact integer values in JSON-backed guards', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE original(total_cents INTEGER,number TEXT)');
    const image = '{"total_cents":9007199254740993,"number":"01"}';
    db.prepare(
      "INSERT INTO original SELECT json_extract(?1,'$.total_cents'),json_extract(?1,'$.number')",
    ).run(image);
    const conditions = [
      "total_cents='9007199254740993'",
      'number=1',
      "number='01'",
      'total_cents IS NULL',
    ];
    const columns = ['total_cents', 'number']
      .map(
        (c) =>
          `${nativeGuardField('invoices', c, `json_extract(?1,'$.${c}')`)} AS ${c}`,
      )
      .join(',');
    for (const condition of conditions) {
      expect(
        db
          .prepare(
            `WITH incoming AS (SELECT ${columns}) SELECT ${condition} ok FROM incoming`,
          )
          .get(image),
      ).toEqual(db.prepare(`SELECT ${condition} ok FROM original`).get());
    }
    expect(
      db
        .prepare(
          "SELECT json_extract(?1,'$.total_cents')='9007199254740993' ok",
        )
        .get(image),
    ).toEqual({ ok: 0 });
  } finally {
    db.close();
  }
});
