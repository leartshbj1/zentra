import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('./runtime', () => ({ database: vi.fn(), fileArchive: vi.fn() }));
import schema from '../desktop/src-tauri/src/business_sync_schema.json';
import protocol from '../desktop/src-tauri/src/business_sync_tables.json';
import { nativeAfterGuardContract } from './business-sync-native-guard-contract';
import {
  nativeEffects,
  splitNativeEffectSql,
} from './business-sync-native-effect-contract';
import { transactionTransitionQueries } from './business-sync-transaction-transitions';

const shared = protocol.tables as Record<
  string,
  { columns: string[]; key: string[] }
>;
type Row = Record<string, string | number | null>;
type Change = {
  table: string;
  key: string;
  before: string | null;
  after: string | null;
};
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
    CREATE TABLE business_sync_transaction_accounting_states(transfer_id TEXT,validator_sha256 TEXT,table_name TEXT,row_key_json TEXT,row_json TEXT,UNIQUE(transfer_id,validator_sha256,table_name,row_key_json));
    CREATE TABLE business_sync_transaction_effects(transfer_id TEXT,validator_sha256 TEXT,effect_name TEXT,cause_position INTEGER,table_name TEXT,row_key_json TEXT,before_json TEXT,after_json TEXT,UNIQUE(transfer_id,validator_sha256,table_name,row_key_json));`);
  for (const [name, table] of Object.entries(schema.tables))
    native.exec(
      `CREATE TABLE "${name}"(${table.columns.map((c) => `"${c.name}" ${c.type}`).join(',')})`,
    );
  const queries = transactionTransitionQueries('SELECT 1');
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
  let position = 0,
    checked = 0,
    installed = false;
  const row = (table: string, values: Row) =>
    JSON.stringify(
      Object.fromEntries(
        shared[table].columns.map((c) => [c, values[c] ?? null]),
      ),
    );
  const key = (table: string, raw: string) =>
    String(
      native
        .prepare(
          `SELECT json_array(${shared[table].key.map((c) => `json_extract(?1,'$.${c}')`).join(',')}) k`,
        )
        .get(raw)!.k,
    );
  const put = (table: string, raw: string) =>
    native
      .prepare(
        `INSERT INTO "${table}"(${shared[table].columns.map((c) => `"${c}"`).join(',')}) SELECT ${shared[table].columns.map((c) => `json_extract(?1,'$.${c}')`).join(',')}`,
      )
      .run(raw);
  const source = (table: string, values: Row) => {
    const raw = row(table, values);
    put(table, raw);
    db.prepare('INSERT INTO business_sync_versions VALUES(?,?,?,?,?)').run(
      'source',
      'org',
      table,
      key(table, raw),
      raw,
    );
    return raw;
  };
  const targets = () =>
    queries.effects.targets.flatMap((table) =>
      native
        .prepare(
          `SELECT json_array(${shared[table].key.map((c) => `"${c}"`).join(',')}) k,json_object(${shared[table].columns.flatMap((c) => [`'${c}'`, `"${c}"`]).join(',')}) r FROM "${table}"`,
        )
        .all()
        .map((r) => ({ table, key: String(r.k), raw: String(r.r) })),
    );
  const oracle = (table: string, before: string | null, after: string) => {
    if (!installed) {
      for (const effect of nativeEffects) native.exec(effect.sql);
      installed = true;
    }
    const original = targets();
    if (before)
      native
        .prepare(
          `UPDATE "${table}" SET ${shared[table].columns.map((c) => `"${c}"=json_extract(?1,'$.${c}')`).join(',')} WHERE ${shared[table].key.map((c) => `"${c}" IS json_extract(?2,'$.${c}')`).join(' AND ')}`,
        )
        .run(after, before);
    else put(table, after);
    const changes = targets().flatMap((current) => {
      const old =
        original.find((r) => r.table === current.table && r.key === current.key)
          ?.raw ?? null;
      return old === current.raw
        ? []
        : [
            {
              table: current.table,
              key: current.key,
              before: old,
              after: current.raw,
            },
          ];
    });
    return { cause: { table, key: key(table, after), before, after }, changes };
  };
  const status = () =>
    db
      .prepare(
        'SELECT phase,failed_rule,failed_change,checked_changes FROM business_sync_transaction_validations',
      )
      .get()!;
  const pending = () =>
    db
      .prepare(
        'SELECT * FROM business_sync_transaction_effects ORDER BY table_name,row_key_json',
      )
      .all();
  const bindings = (change: Change) => [
    ...common,
    checked,
    'source',
    'now',
    position,
    change.table,
    change.key,
    change.before,
    change.after,
    Math.floor(position / 200),
    position % 200,
  ];
  const step = (change: Change, finish = false) => {
    const args = bindings(change);
    db.prepare(
      'INSERT INTO business_sync_transaction_changes VALUES(?,?,?,?,?,?,?)',
    ).run(
      'tx',
      'org',
      change.table,
      change.key,
      String(position + 1),
      Math.floor(position / 200),
      position % 200,
    );
    db.prepare(queries.effects.check).run(...args);
    if (queries.effects.targets.includes(change.table))
      db.prepare(queries.effects.consume).run(...args);
    if (queries.effects.record[change.table])
      db.prepare(queries.effects.record[change.table]).run(...args);
    db.prepare(queries.accountingRow).run(...args);
    if (finish) db.prepare(queries.effects.finish).run(...args);
    position++;
    return status();
  };
  const checkpoint = () => {
    checked = position;
    db.prepare(
      'UPDATE business_sync_transaction_validations SET checked_changes=?',
    ).run(checked);
  };
  const verify = (result: ReturnType<typeof oracle>) => {
    expect(step(result.cause).phase).toBe('transitions');
    expect(pending().length).toBe(result.changes.length);
    for (const change of result.changes)
      expect(step(change).phase).toBe('transitions');
    expect(pending()).toEqual([]);
  };
  return {
    db,
    native,
    row,
    source,
    oracle,
    step,
    pending,
    verify,
    status,
    checkpoint,
    bindings,
    common,
    queries,
  };
}

it('uses exactly the seven shared native effects and rejects unbalanced trusted SQL', () => {
  expect(nativeEffects).toHaveLength(7);
  expect(nativeAfterGuardContract.effects).toHaveLength(9);
  expect(
    splitNativeEffectSql(
      "amount=(SELECT SUM(x) FROM a WHERE z='a, WHERE b'),note='it''s, fine'",
    ),
  ).toHaveLength(2);
  expect(() => splitNativeEffectSql("x='unfinished")).toThrow('Unbalanced');
});

function stock() {
  const f = fixture();
  f.source('catalog_items', {
    id: 'item',
    name: 'Materiel',
    stock_quantity_milli: 1000,
    updated_at: 'before',
  });
  return {
    f,
    result: f.oracle(
      'stock_movements',
      null,
      f.row('stock_movements', {
        id: 'movement',
        catalog_item_id: 'item',
        source_type: 'manual',
        balance_after_milli: 2000,
        created_at: 'after',
      }),
    ),
  };
}
it('matches the actual native stock update and preserves it across a resumed page', () => {
  const { f, result } = stock();
  expect(f.step(result.cause).phase).toBe('transitions');
  f.checkpoint();
  expect(f.step(result.changes[0], true).phase).toBe('transitions');
  expect(f.pending()).toEqual([]);
});
it('resumes pending native effects in D1 and rolls back consumption and cursor on failure', async () => {
  const { f, result } = stock();
  f.step(result.cause);
  f.checkpoint();
  const require = createRequire(import.meta.url);
  const { Miniflare } = createRequire(require.resolve('wrangler'))('miniflare');
  const runtime = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("Effects test")}}',
    d1Databases: ['DB'],
    compatibilityDate: '2026-05-15',
  });
  try {
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
    const change = result.changes[0],
      args = f.bindings(change);
    const statements = [
      d1.prepare(f.queries.effects.check).bind(...args),
      d1.prepare(f.queries.effects.consume).bind(...args),
      d1.prepare(f.queries.accountingRow).bind(...args),
      d1.prepare(f.queries.effects.finish).bind(...args),
      d1.prepare(f.queries.advance).bind(...f.common, 1, 1, 2, 'now', 2),
    ];
    await expect(
      d1.batch([
        ...statements,
        d1.prepare('INSERT INTO missing_failure_target VALUES(1)'),
      ]),
    ).rejects.toThrow();
    expect(
      await d1
        .prepare('SELECT COUNT(*) n FROM business_sync_transaction_effects')
        .first(),
    ).toEqual({ n: 1 });
    expect(
      await d1
        .prepare(
          'SELECT phase,checked_changes FROM business_sync_transaction_validations',
        )
        .first(),
    ).toEqual({ phase: 'transitions', checked_changes: 1 });
    await d1.batch(statements);
    expect(
      await d1
        .prepare('SELECT COUNT(*) n FROM business_sync_transaction_effects')
        .first(),
    ).toEqual({ n: 0 });
    const state = await d1
      .prepare(
        'SELECT phase,checked_changes FROM business_sync_transaction_validations',
      )
      .first();
    expect(state).toEqual({ phase: 'projecting', checked_changes: 2 });
    await d1.batch(statements);
    expect(
      await d1
        .prepare(
          'SELECT phase,checked_changes FROM business_sync_transaction_validations',
        )
        .first(),
    ).toEqual(state);
    expect(
      await d1
        .prepare(
          "SELECT json_extract(row_json,'$.stock_quantity_milli') quantity FROM business_sync_transaction_accounting_states WHERE table_name='catalog_items'",
        )
        .first(),
    ).toEqual({ quantity: 2000 });
  } finally {
    await runtime.dispose();
  }
}, 30_000);
it.each([
  'omitted',
  'quantity',
  'timestamp',
  'other-field',
  'before-image',
  'interleaved',
] as const)(
  'refuses a %s stock effect instead of accepting a later repair',
  (mode) => {
    const { f, result } = stock();
    if (mode === 'omitted')
      expect(f.step(result.cause, true)).toMatchObject({
        phase: 'invalid',
        failed_change: 0,
      });
    else {
      f.step(result.cause);
      const expected = result.changes[0],
        wrong = { ...expected };
      if (mode === 'interleaved')
        Object.assign(wrong, {
          table: 'bank_expense_reconciliation_registry',
          key: '["other"]',
          before: null,
          after: '{"id":"other","created_at":"after"}',
        });
      else if (mode === 'before-image')
        wrong.before = wrong.before!.replace(
          '"stock_quantity_milli":1000',
          '"stock_quantity_milli":999',
        );
      else
        wrong.after = JSON.stringify({
          ...JSON.parse(wrong.after!),
          [mode === 'quantity'
            ? 'stock_quantity_milli'
            : mode === 'timestamp'
              ? 'updated_at'
              : 'name']: mode === 'quantity' ? 3000 : 'wrong',
        });
      expect(f.step(wrong)).toMatchObject({
        phase: 'invalid',
        failed_change: 1,
      });
      expect(f.step(expected).phase).toBe('invalid');
      expect(f.pending()).toHaveLength(1);
    }
    expect(f.status().failed_rule).toBe(
      'native-effect:stock_movements_apply_balance',
    );
  },
);
it('does not expect a stock rewrite for a native opening movement', () => {
  const f = fixture();
  f.source('catalog_items', { id: 'item', stock_quantity_milli: 2000 });
  const result = f.oracle(
    'stock_movements',
    null,
    f.row('stock_movements', {
      id: 'opening',
      catalog_item_id: 'item',
      source_type: 'opening',
      balance_after_milli: 2000,
    }),
  );
  expect(result.changes).toEqual([]);
  f.verify(result);
});
it('omits the unchanged shared image just as native capture does', () => {
  const f = fixture();
  f.source('catalog_items', {
    id: 'item',
    stock_quantity_milli: 2000,
    updated_at: 'same',
  });
  const result = f.oracle(
    'stock_movements',
    null,
    f.row('stock_movements', {
      id: 'movement',
      catalog_item_id: 'item',
      source_type: 'manual',
      balance_after_milli: 2000,
      created_at: 'same',
    }),
  );
  expect(result.changes).toEqual([]);
  f.verify(result);
});
it('preserves an exact SQLite integer beyond JavaScript precision in the expected effect', () => {
  const f = fixture();
  f.source('catalog_items', { id: 'item', stock_quantity_milli: 1000 });
  const raw = f
    .row('stock_movements', {
      id: 'movement',
      catalog_item_id: 'item',
      source_type: 'manual',
      balance_after_milli: 0,
      created_at: 'after',
    })
    .replace(
      '"balance_after_milli":0',
      '"balance_after_milli":9007199254740993',
    );
  const result = f.oracle('stock_movements', null, raw);
  expect(result.changes[0].after).toContain('9007199254740993');
  f.verify(result);
});
it('matches the bank reconciliation registry created by the native trigger', () => {
  const f = fixture();
  const result = f.oracle(
    'bank_expense_reconciliations',
    null,
    f.row('bank_expense_reconciliations', {
      id: 'match',
      confirmed_at: '2026-09-09T10:00:00Z',
    }),
  );
  expect(result.changes).toHaveLength(1);
  f.verify(result);
});
it.each(['initial', 'prevalidation', 'prospective'] as const)(
  'matches the native employee %s decision history',
  (kind) => {
    const f = fixture();
    const data = {
      id: 'employee',
      small_salary_assessment_year: 2026,
      small_salary_decision_date: '2026-01-01',
      small_salary_sector: 'ordinary',
      small_salary_employee_requested_contributions: 0,
      small_salary_opening_gross_cents: 0,
      small_salary_opening_contributed_basis_cents: 0,
      small_salary_evidence_reference: 'signed',
      created_at: 'created',
      updated_at: 'updated',
    };
    let before: string | null = null;
    if (kind !== 'initial') {
      before = f.source('employees', data);
      f.source('employee_small_salary_decisions', {
        employee_id: 'employee',
        assessment_year: 2026,
        revision: 1,
        revision_kind: 'initial',
        decision_date: '2026-01-01',
        sector: 'ordinary',
        employee_requested_contributions: 0,
        opening_gross_cents: 0,
        opening_contributed_basis_cents: 0,
        evidence_reference: 'signed',
        created_at: 'created',
      });
      if (kind === 'prospective')
        f.source('payslips', {
          id: 'slip',
          employee_id: 'employee',
          period: '2026-01',
          status: 'valide',
        });
    }
    const result = f.oracle(
      'employees',
      before,
      f.row('employees', {
        ...data,
        small_salary_employee_requested_contributions:
          kind === 'initial' ? 0 : 1,
      }),
    );
    expect(result.changes).toHaveLength(1);
    expect(JSON.parse(result.changes[0].after!).revision_kind).toBe(
      kind === 'initial'
        ? 'initial'
        : kind === 'prospective'
          ? 'prospective_request'
          : 'prevalidation_correction',
    );
    f.verify(result);
  },
);
it.each(['payment', 'allocation', 'credit-validation'] as const)(
  'matches native supplier totals after %s, including multiple target invoices',
  (kind) => {
    const f = fixture();
    f.source('supplier_invoices', {
      id: 'invoice',
      paid_cents: 10,
      credited_cents: 0,
      updated_at: 'before',
    });
    let result: ReturnType<typeof f.oracle>;
    if (kind === 'payment') {
      f.source('supplier_payments', {
        id: 'previous',
        supplier_invoice_id: 'invoice',
        amount_cents: 10,
      });
      result = f.oracle(
        'supplier_payments',
        null,
        f.row('supplier_payments', {
          id: 'payment',
          supplier_invoice_id: 'invoice',
          amount_cents: -3,
          created_at: 'after',
        }),
      );
    } else {
      const credit = f.source('supplier_credit_notes', {
        id: 'credit',
        status: kind === 'allocation' ? 'validated' : 'draft',
      });
      if (kind === 'allocation')
        result = f.oracle(
          'supplier_credit_allocations',
          null,
          f.row('supplier_credit_allocations', {
            id: 'allocation',
            supplier_credit_note_id: 'credit',
            supplier_invoice_id: 'invoice',
            event_type: 'apply',
            amount_cents: 20,
            created_at: 'after',
          }),
        );
      else {
        f.source('supplier_invoices', {
          id: 'second',
          paid_cents: 0,
          credited_cents: 0,
          updated_at: 'before',
        });
        for (const id of ['invoice', 'second'])
          f.source('supplier_credit_allocations', {
            id: id + '-allocation',
            supplier_credit_note_id: 'credit',
            supplier_invoice_id: id,
            event_type: 'apply',
            amount_cents: 20,
          });
        result = f.oracle(
          'supplier_credit_notes',
          credit,
          JSON.stringify({
            ...JSON.parse(credit),
            status: 'validated',
            validated_at: 'after',
          }),
        );
      }
    }
    expect(result.changes).toHaveLength(kind === 'credit-validation' ? 2 : 1);
    f.verify(result);
  },
);
