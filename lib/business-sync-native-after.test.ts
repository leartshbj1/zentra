import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('./runtime', () => ({ database: vi.fn(), fileArchive: vi.fn() }));
import schema from '../desktop/src-tauri/src/business_sync_schema.json';
import protocol from '../desktop/src-tauri/src/business_sync_tables.json';
import {
  nativeAfterGuardContract,
  nativeGuardViews,
} from './business-sync-native-guard-contract';
import { transactionTransitionQueries } from './business-sync-transaction-transitions';

type Row = Record<string, string | number | null>;
const instances: DatabaseSync[] = [];
afterEach(() => {
  for (const db of instances.splice(0)) db.close();
});
function fixture() {
  const db = new DatabaseSync(':memory:'),
    native = new DatabaseSync(':memory:');
  instances.push(db, native);
  db.exec(`CREATE TABLE business_sync_transaction_validations(transfer_id TEXT PRIMARY KEY,phase TEXT,checked_changes INTEGER,next_change_chunk INTEGER,failed_rule TEXT,failed_change INTEGER,updated_at TEXT);
    INSERT INTO business_sync_transaction_validations VALUES('tx','transitions',0,0,NULL,NULL,'original');
    CREATE TABLE business_sync_transaction_changes(transaction_id TEXT,organization_id TEXT,table_name TEXT,row_key_json TEXT,sequence TEXT,part_index INTEGER,change_index INTEGER);
    CREATE TABLE business_sync_versions(transfer_id TEXT,organization_id TEXT,table_name TEXT,row_key_json TEXT,row_json TEXT,UNIQUE(transfer_id,table_name,row_key_json));
    CREATE TABLE business_sync_row_order(transfer_id TEXT,table_name TEXT,row_key_json TEXT,source_rowid TEXT,UNIQUE(transfer_id,table_name,row_key_json));
    CREATE TABLE business_sync_transaction_accounting_states(transfer_id TEXT,validator_sha256 TEXT,table_name TEXT,row_key_json TEXT,row_json TEXT,UNIQUE(transfer_id,validator_sha256,table_name,row_key_json));`);
  // Independent oracle: native table affinities, original views and AFTER
  // trigger bodies. Other constraints/BEFORE guards have their own suites.
  for (const [name, table] of Object.entries(schema.tables))
    native.exec(
      `CREATE TABLE "${name}"(${table.columns.map((c) => `"${c.name}" ${c.type}`).join(',')})`,
    );
  for (const [name, sql] of Object.entries(nativeGuardViews))
    native.exec(`CREATE VIEW "${name}" AS ${sql}`);
  const key = (table: string, row: Row) =>
    JSON.stringify(
      (protocol.tables as Record<string, { key: string[] }>)[table].key.map(
        (k) => row[k],
      ),
    );
  const insert = (table: string, row: Row) =>
    native
      .prepare(
        `INSERT INTO "${table}"(${Object.keys(row)
          .map((c) => `"${c}"`)
          .join(',')}) VALUES(${Object.keys(row)
          .map(() => '?')
          .join(',')})`,
      )
      .run(...Object.values(row));
  const source = (table: string, row: Row, transfer = 'source') => {
    db.prepare('INSERT INTO business_sync_versions VALUES(?,?,?,?,?)').run(
      transfer,
      'org',
      table,
      key(table, row),
      JSON.stringify(row),
    );
    if (transfer === 'source') insert(table, row);
  };
  let installed = false;
  const oracle = (table: string, row: Row) => {
    if (!installed) {
      for (const g of nativeAfterGuardContract.guards) {
        expect(g.operation).toBe('insert');
        native.exec(
          `CREATE TRIGGER ${g.name} AFTER INSERT ON ${g.table} WHEN ${g.condition} BEGIN SELECT RAISE(ABORT,'${g.message.replaceAll("'", "''")}'); END`,
        );
      }
      installed = true;
    }
    native.exec('SAVEPOINT probe');
    try {
      insert(table, row);
      return null;
    } catch (error) {
      return String(error);
    } finally {
      native.exec('ROLLBACK TO probe; RELEASE probe');
    }
  };
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
  const queries = transactionTransitionQueries('SELECT 1');
  const bindings = (table: string, row: Row, index = 0) => [
    ...common,
    0,
    'source',
    'now',
    index,
    table,
    key(table, row),
    null,
    JSON.stringify(row),
    Math.floor(index / 200),
    index % 200,
    null,
  ];
  const check = (
    table: string,
    row: Row,
    expected: string | null,
    index = 0,
  ) => {
    db.exec(
      "UPDATE business_sync_transaction_validations SET phase='transitions',failed_rule=NULL,failed_change=NULL",
    );
    const args = bindings(table, row, index);
    db.prepare(queries.after[table]).run(...args);
    const result = db
      .prepare(
        'SELECT phase,failed_rule,failed_change FROM business_sync_transaction_validations',
      )
      .get()!;
    expect(result.failed_rule).toBe(
      expected === null ? null : `native:${expected}`,
    );
    if (expected) expect(result.failed_change).toBe(index);
    const nativeError = oracle(table, row);
    // SQLite does not guarantee trigger execution order; several native
    // guards may reject the same row. The server chooses catalog order.
    if (expected)
      expect(
        nativeAfterGuardContract.guards.some(
          (g) => g.table === table && nativeError?.includes(g.message),
        ),
      ).toBe(true);
    else expect(nativeError).toBeNull();
  };
  return { db, source, check, bindings, queries };
}

it('classifies all seven AFTER financial guards and nine explicit row effects', () => {
  expect(nativeAfterGuardContract.guards).toHaveLength(7);
  expect(nativeAfterGuardContract.effects).toHaveLength(9);
  expect(
    nativeAfterGuardContract.guards.every((g) => !g.local_reads.length),
  ).toBe(true);
});

it('includes the inserted customer settlement in both credit and invoice balances', () => {
  const f = fixture();
  f.source('invoices', {
    id: 'credit',
    total_cents: -10000,
    type: 'avoir',
    number: 'A-1',
    status: 'emise',
  });
  f.source('customer_credit_documents', { credit_note_id: 'credit' });
  f.source('invoices', {
    id: 'invoice',
    total_cents: 10000,
    type: 'facture',
    number: 'F-1',
    status: 'emise',
  });
  f.source('payments', {
    id: 'payment',
    invoice_id: 'invoice',
    amount_cents: 9000,
  });
  const row = {
    id: 'new',
    credit_note_id: 'credit',
    event_type: 'refund',
    invoice_id: null,
    amount_cents: 10000,
  };
  f.check('customer_credit_settlements', row, null);
  f.check(
    'customer_credit_settlements',
    { ...row, amount_cents: 10001 },
    'customer_credit_settlement_balance',
  );
  f.check(
    'customer_credit_settlements',
    { ...row, event_type: 'apply', invoice_id: 'invoice', amount_cents: 1000 },
    null,
  );
  f.check(
    'customer_credit_settlements',
    { ...row, event_type: 'apply', invoice_id: 'invoice', amount_cents: 1001 },
    'customer_credit_settlement_balance',
  );
});

it('checks the newly inserted expense refund and both historical timelines', () => {
  const f = fixture();
  f.source('expenses', {
    id: 'expense',
    payment_status: 'paid',
    currency: 'CHF',
    net_cents: 100,
    vat_cents: 8,
  });
  const row = {
    id: 'new',
    expense_id: 'expense',
    event_type: 'refund',
    net_cents: 100,
    vat_cents: 8,
    credit_date: '2026-09-10',
    payment_date: '2026-09-10',
  };
  f.check('expense_refunds', row, null);
  f.check(
    'expense_refunds',
    { ...row, net_cents: 101 },
    'expense_refund_bounds',
  );
  f.check('expense_refunds', { ...row, vat_cents: 9 }, 'expense_refund_bounds');
  // Seed after constructing a fresh oracle so no additional guards intervene.
  const timeline = fixture();
  timeline.source('expenses', {
    id: 'expense',
    payment_status: 'paid',
    currency: 'CHF',
    net_cents: 100,
    vat_cents: 8,
  });
  timeline.source('expense_refunds', { ...row, id: 'original' });
  const reversal = { ...row, event_type: 'reverse' };
  timeline.check('expense_refunds', reversal, null);
  timeline.check(
    'expense_refunds',
    { ...reversal, credit_date: '2026-09-09' },
    'expense_refund_timeline_bounds',
  );
  timeline.check(
    'expense_refunds',
    { ...reversal, payment_date: '2026-09-09' },
    'expense_refund_timeline_bounds',
  );
});

it.each(['allocation', 'refund'] as const)(
  'checks the incoming supplier %s against the other settlement kind',
  (kind) => {
    const f = fixture();
    f.source('supplier_credit_notes', {
      id: 'credit',
      total_cents: 10000,
      status: 'validated',
    });
    const table =
      kind === 'allocation'
        ? 'supplier_credit_allocations'
        : 'supplier_credit_refunds';
    const other =
      kind === 'allocation'
        ? 'supplier_credit_refunds'
        : 'supplier_credit_allocations';
    f.source(other, {
      id: 'previous',
      supplier_credit_note_id: 'credit',
      event_type: kind === 'allocation' ? 'refund' : 'apply',
      amount_cents: 5000,
      [kind === 'allocation' ? 'date' : 'effective_date']: '2026-09-10',
    });
    const row = {
      id: 'new',
      supplier_credit_note_id: 'credit',
      event_type: kind === 'allocation' ? 'apply' : 'refund',
      amount_cents: 5000,
      [kind === 'allocation' ? 'effective_date' : 'date']: '2026-09-10',
    };
    f.check(table, row, null);
    f.check(
      table,
      { ...row, amount_cents: 5001 },
      kind === 'allocation'
        ? 'supplier_credit_allocation_refund_balance'
        : 'supplier_credit_refund_balance',
    );
  },
);

it.each(['allocation', 'refund'] as const)(
  'does not use a later supplier %s to fund an earlier reversal',
  (kind) => {
    const f = fixture();
    f.source('supplier_credit_notes', {
      id: 'credit',
      total_cents: 10000,
      status: 'validated',
    });
    const table =
      kind === 'allocation'
        ? 'supplier_credit_allocations'
        : 'supplier_credit_refunds';
    const date = kind === 'allocation' ? 'effective_date' : 'date';
    const row = {
      id: 'new',
      supplier_credit_note_id: 'credit',
      event_type: kind === 'allocation' ? 'apply' : 'refund',
      amount_cents: 10000,
      [date]: '2026-09-10',
    };
    f.source(table, { ...row, id: 'original' });
    const reversal = {
      ...row,
      event_type: kind === 'allocation' ? 'reverse_apply' : 'reverse_refund',
    };
    f.check(table, reversal, null);
    f.check(
      table,
      { ...reversal, [date]: '2026-09-09' },
      kind === 'allocation'
        ? 'supplier_credit_allocation_refund_chronology'
        : 'supplier_credit_refund_chronology',
    );
  },
);

it('rejects an over-refund without borrowing a compensating event from the final candidate', () => {
  const f = fixture();
  f.source('expenses', {
    id: 'expense',
    payment_status: 'paid',
    currency: 'CHF',
    net_cents: 100,
    vat_cents: 0,
  });
  const row = {
    id: 'new',
    expense_id: 'expense',
    event_type: 'refund',
    net_cents: 101,
    vat_cents: 0,
    credit_date: '2026-09-10',
    payment_date: '2026-09-10',
  };
  f.source(
    'expense_refunds',
    { ...row, id: 'future', event_type: 'reverse' },
    'tx',
  );
  f.db.exec(
    `INSERT INTO business_sync_transaction_changes VALUES('tx','org','expense_refunds','["future"]','202',1,1)`,
  );
  f.check('expense_refunds', row, 'expense_refund_bounds', 200);
  expect(
    f.db
      .prepare(
        'SELECT COUNT(*) n FROM business_sync_transaction_accounting_states',
      )
      .get()!.n,
  ).toBe(0);
});

it('runs rejection and same-date reversal in the D1 engine without advancing projections', async () => {
  const require = createRequire(import.meta.url);
  const { Miniflare } = createRequire(require.resolve('wrangler'))('miniflare');
  const runtime = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("After guard test")}}',
    d1Databases: ['DB'],
    compatibilityDate: '2026-05-15',
  });
  try {
    const f = fixture();
    f.source('expenses', {
      id: 'expense',
      payment_status: 'paid',
      currency: 'CHF',
      net_cents: 100,
      vat_cents: 0,
    });
    const original = {
      id: 'original',
      expense_id: 'expense',
      event_type: 'refund',
      net_cents: 100,
      vat_cents: 0,
      credit_date: '2026-09-10',
      payment_date: '2026-09-10',
    };
    f.source('expense_refunds', original);
    f.source(
      'expense_refunds',
      { ...original, id: 'future', event_type: 'reverse' },
      'tx',
    );
    const d1: D1Database = await runtime.getD1Database('DB');
    for (const table of f.db
      .prepare("SELECT name,sql FROM sqlite_master WHERE type='table'")
      .all()) {
      await d1.prepare(String(table.sql)).run();
      for (const row of f.db
        .prepare(`SELECT * FROM "${String(table.name)}"`)
        .all())
        await d1
          .prepare(
            `INSERT INTO "${String(table.name)}" VALUES(${Object.keys(row)
              .map(() => '?')
              .join(',')})`,
          )
          .bind(...Object.values(row))
          .run();
    }
    const cases: [Row, string | null][] = [
      [{ ...original, id: 'new', net_cents: 1 }, 'expense_refund_bounds'],
      [
        {
          ...original,
          id: 'new',
          event_type: 'reverse',
          credit_date: '2026-09-09',
        },
        'expense_refund_timeline_bounds',
      ],
      [{ ...original, id: 'new', event_type: 'reverse' }, null],
    ];
    for (const [row, rule] of cases) {
      await d1
        .prepare(
          "UPDATE business_sync_transaction_validations SET phase='transitions',failed_rule=NULL,failed_change=NULL",
        )
        .run();
      await d1
        .prepare(f.queries.after.expense_refunds)
        .bind(...f.bindings('expense_refunds', row))
        .run();
      expect(
        await d1
          .prepare(
            'SELECT phase,failed_rule,checked_changes FROM business_sync_transaction_validations',
          )
          .first(),
      ).toEqual({
        phase: rule ? 'invalid' : 'transitions',
        failed_rule: rule ? `native:${rule}` : null,
        checked_changes: 0,
      });
      expect(
        await d1
          .prepare(
            'SELECT COUNT(*) n FROM business_sync_transaction_accounting_states',
          )
          .first(),
      ).toEqual({ n: 0 });
    }
  } finally {
    await runtime.dispose();
  }
}, 30_000);
