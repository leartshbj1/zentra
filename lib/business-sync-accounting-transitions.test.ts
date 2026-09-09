import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
vi.mock('./runtime', () => ({ database: vi.fn(), fileArchive: vi.fn() }));
import { transactionTransitionQueries } from './business-sync-transaction-transitions';
import { transitionParentPredicates } from './business-sync-transition-state';
import { transitionRowColumns } from './business-sync-transition-rows';
import {
  postedPayslipFields,
  validatedSupplierFields,
  validatedSupplierCreditFields,
} from './business-sync-accounting-transitions';
import immutable from './business-sync-native-immutability.json';
import { transactionImmutabilityRules } from './business-sync-transaction-immutability';
import contract from '../desktop/src-tauri/src/business_sync_tables.json';

type Row = Record<string, unknown>;
const digest = (row: Row) =>
  createHash('sha256').update(JSON.stringify(row)).digest('hex');
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE business_sync_transaction_validations(transfer_id TEXT PRIMARY KEY,phase TEXT,checked_changes INTEGER,next_change_chunk INTEGER,failed_rule TEXT,failed_change INTEGER,updated_at TEXT);
    INSERT INTO business_sync_transaction_validations VALUES('tx','transitions',0,0,NULL,NULL,'original');
    CREATE TABLE business_sync_transaction_changes(transaction_id TEXT,organization_id TEXT,table_name TEXT,row_key_json TEXT,sequence TEXT,part_index INTEGER,change_index INTEGER,operation TEXT,after_sha256 TEXT);
    CREATE INDEX business_sync_transaction_row_timeline ON business_sync_transaction_changes(transaction_id,table_name,row_key_json,part_index,change_index);
    CREATE TABLE business_sync_versions(transfer_id TEXT,organization_id TEXT,table_name TEXT,row_key_json TEXT,row_json TEXT,row_sha256 TEXT,UNIQUE(transfer_id,table_name,row_key_json));
    CREATE TABLE business_sync_row_order(transfer_id TEXT,table_name TEXT,row_key_json TEXT,source_rowid TEXT,UNIQUE(transfer_id,table_name,row_key_json));
    CREATE TABLE business_sync_transaction_document_states(transfer_id TEXT,validator_sha256 TEXT,table_name TEXT,row_key_json TEXT,issued INTEGER,UNIQUE(transfer_id,validator_sha256,table_name,row_key_json));
    CREATE TABLE business_sync_transaction_accounting_states(transfer_id TEXT,validator_sha256 TEXT,table_name TEXT,row_key_json TEXT,row_json TEXT,UNIQUE(transfer_id,validator_sha256,table_name,row_key_json));`);
  db.exec(
    readFileSync(
      new URL('../drizzle/0028_previous_wilson_fisk.sql', import.meta.url),
      'utf8',
    ).replaceAll('--> statement-breakpoint', ''),
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
  let position = 0;
  const put = (transfer: string, table: string, row: Row) =>
    db
      .prepare(
        'INSERT OR REPLACE INTO business_sync_versions VALUES(?,?,?,?,?,?)',
      )
      .run(
        transfer,
        'org',
        table,
        JSON.stringify([row.id]),
        JSON.stringify(row),
        digest(row),
      );
  const source = (table: string, row: Row) => {
    put('source', table, row);
    put('tx', table, row);
  };
  const metadata = (
    table: string,
    id: unknown,
    op: string,
    index: number,
    after: Row | null,
  ) =>
    db
      .prepare(
        'INSERT INTO business_sync_transaction_changes VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(
        'tx',
        'org',
        table,
        JSON.stringify([id]),
        String(index + 1),
        Math.floor(index / 200),
        index % 200,
        op,
        after ? digest(after) : null,
      );
  const args = (
    table: string,
    before: Row | null,
    after: Row | null,
    index = position,
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
  ];
  const step = (table: string, before: Row | null, after: Row | null) => {
    const bindings = args(table, before, after);
    metadata(
      table,
      (before ?? after)!.id,
      before === null ? 'insert' : after === null ? 'delete' : 'update',
      position++,
      after,
    );
    if (after) put('tx', table, after);
    else
      db.prepare(
        'DELETE FROM business_sync_versions WHERE transfer_id=? AND table_name=? AND row_key_json=?',
      ).run('tx', table, JSON.stringify([before!.id]));
    if (queries.reject[table])
      db.prepare(queries.reject[table]).run(...bindings);
    if (Object.hasOwn(transitionParentPredicates, table))
      db.prepare(queries.document).run(...bindings);
    if (Object.hasOwn(transitionRowColumns, table))
      db.prepare(queries.accountingRow).run(...bindings);
    return db
      .prepare(
        'SELECT phase,failed_rule,failed_change FROM business_sync_transaction_validations',
      )
      .get()!;
  };
  const future = (table: string, row: Row) => {
    put('tx', table, row);
    metadata(table, row.id, 'insert', 1000, row);
  };
  return { db, source, step, future, args, queries, put };
}
const invoice = {
  id: 'invoice',
  status: 'validated',
  document_date: '2026-09-08',
  total_cents: 10000,
  paid_cents: 0,
  credited_cents: 0,
};
const salary = {
  id: 'salary',
  status: 'comptabilise',
  employee_id: 'employee',
  net_cents: 470300,
  payment_date: null,
  payment_reference: null,
  payment_journal_entry_id: null,
};
const journal = (kind: string, id: string, event: string) => ({
  id: 'journal',
  source_type: kind,
  source_id: id,
  source_event: event,
  entry_date: '2026-09-08',
});
const paid = {
  ...salary,
  status: 'paye',
  payment_date: '2026-09-08',
  payment_reference: 'SALAIRE',
  payment_journal_entry_id: 'journal',
};
const payment = {
  id: 'payment',
  supplier_invoice_id: 'invoice',
  amount_cents: 3000,
  date: '2026-09-08',
  journal_entry_id: 'journal',
};
const draftCredit = {
  id: 'credit',
  status: 'draft',
  document_date: '2026-09-08',
  net_cents: 2000,
  vat_cents: 0,
  total_cents: 2000,
  number: null,
  validation_journal_entry_id: null,
  validated_at: null,
  snapshot_json: null,
};
const validatedCredit = {
  ...draftCredit,
  status: 'validated',
  number: 'AF-1',
  validation_journal_entry_id: 'credit-journal',
  validated_at: '2026-09-08',
  snapshot_json: '{}',
};
function creditSource(f: ReturnType<typeof fixture>) {
  f.source('supplier_credit_notes', draftCredit);
  f.source('supplier_credit_note_items', {
    id: 'credit-item',
    supplier_credit_note_id: 'credit',
    line_net_cents: 2000,
    line_vat_cents: 0,
    line_total_cents: 2000,
  });
  f.source('journal_entries', {
    ...journal('supplier_credit_note', 'credit', 'validate'),
    id: 'credit-journal',
  });
}
function supplierPostingSource(f: ReturnType<typeof fixture>) {
  const draft = {
    ...invoice,
    status: 'draft',
    reference_normalized: 'ACHAT-1',
    due_date: '2026-09-30',
    net_cents: 9000,
    vat_cents: 1000,
    validation_journal_entry_id: null,
  };
  const posted = {
    ...draft,
    status: 'validated',
    validation_journal_entry_id: 'journal',
  };
  const item = {
    id: 'item',
    supplier_invoice_id: 'invoice',
    line_net_cents: 9000,
    line_vat_cents: 1000,
    line_total_cents: 10000,
    posted_expense_account_id: 'expense',
  };
  f.source('supplier_invoices', draft);
  f.source('supplier_invoice_items', item);
  f.source(
    'journal_entries',
    journal('supplier_invoice', 'invoice', 'validate'),
  );
  return { draft, posted, item };
}

it.each(['reference', 'paid', 'credited', 'due', 'account', 'totals'])(
  'rejects premature supplier validation with invalid %s',
  (problem) => {
    const f = fixture();
    try {
      const { draft, posted, item } = supplierPostingSource(f);
      const after = { ...posted };
      if (problem === 'reference') after.reference_normalized = ' ';
      if (problem === 'paid') after.paid_cents = 1;
      if (problem === 'credited') after.credited_cents = 1;
      if (problem === 'due') after.due_date = '2026-01-01';
      if (problem === 'account')
        f.source('supplier_invoice_items', {
          ...item,
          posted_expense_account_id: null,
        });
      if (problem === 'totals')
        f.source('supplier_invoice_items', { ...item, line_net_cents: 8000 });
      expect(f.step('supplier_invoices', draft, after)).toMatchObject({
        phase: 'invalid',
        failed_rule: 'transition:supplier-invoice-posting',
      });
    } finally {
      f.db.close();
    }
  },
);
it.each(['future-fix', 'deleted', 'missing-state'])(
  'does not substitute final supplier items for their current state (%s)',
  (scenario) => {
    const f = fixture();
    try {
      const { draft, posted, item } = supplierPostingSource(f);
      if (scenario === 'future-fix') {
        f.source('supplier_invoice_items', { ...item, line_net_cents: 8000 });
        f.future('supplier_invoice_items', item);
      } else if (scenario === 'deleted') {
        f.step('supplier_invoice_items', item, null);
        f.future('supplier_invoice_items', item);
      } else {
        f.step('supplier_invoice_items', item, item);
        f.db.exec('DELETE FROM business_sync_transaction_accounting_states');
      }
      expect(f.step('supplier_invoices', draft, posted)).toMatchObject({
        phase: 'invalid',
        failed_rule: 'transition:supplier-invoice-posting',
      });
    } finally {
      f.db.close();
    }
  },
);
it('uses the earlier line update and ignores later replacements when validating an actual supplier total', () => {
  const f = fixture();
  try {
    const { draft, posted, item } = supplierPostingSource(f);
    const original = { ...item, posted_expense_account_id: null };
    f.source('supplier_invoice_items', original);
    expect(f.step('supplier_invoice_items', original, item).phase).toBe(
      'transitions',
    );
    expect(f.step('supplier_invoices', draft, posted).phase).toBe(
      'transitions',
    );
  } finally {
    f.db.close();
  }
});
it.each([0, 1, 2])(
  'checks both individual and cumulative supplier matching tolerances (%s one-cent deviations)',
  (deviations) => {
    const f = fixture();
    try {
      const { draft, posted } = supplierPostingSource(f);
      for (let i = 0; i < 2; i++) {
        f.source('supplier_order_lines', {
          id: `order-${i}`,
          quantity_milli: 1000,
          line_net_cents: 4500,
          line_vat_cents: 500,
          line_total_cents: 5000,
        });
        f.source('supplier_invoice_matches', {
          id: `match-${i}`,
          supplier_invoice_id: 'invoice',
          supplier_order_line_id: `order-${i}`,
          quantity_milli: 1000,
          net_cents: 4500 + (i < deviations ? 1 : 0),
          vat_cents: 500,
          total_cents: 5000 + (i < deviations ? 1 : 0),
        });
      }
      expect(f.step('supplier_invoices', draft, posted).phase).toBe(
        deviations <= 1 ? 'transitions' : 'invalid',
      );
    } finally {
      f.db.close();
    }
  },
);
it.each(['source', 'earlier', 'future'])(
  'uses only accounting periods already closed at credit validation (%s)',
  (when) => {
    const f = fixture();
    try {
      creditSource(f);
      const period = {
        id: 'period',
        status: 'closed',
        date_from: '2026-01-01',
        date_to: '2026-12-31',
      };
      if (when === 'source') f.source('accounting_periods', period);
      else if (when === 'earlier') f.step('accounting_periods', null, period);
      else f.future('accounting_periods', period);
      expect(
        f.step('supplier_credit_notes', draftCredit, validatedCredit).phase,
      ).toBe(when === 'future' ? 'transitions' : 'invalid');
    } finally {
      f.db.close();
    }
  },
);
it.each(['earlier', 'future'])(
  'does not apply credit allocations before their creation (%s)',
  (when) => {
    const f = fixture();
    try {
      creditSource(f);
      const allocation = {
        id: 'allocation',
        supplier_credit_note_id: 'credit',
        supplier_invoice_id: 'invoice',
        event_type: 'apply',
        amount_cents: 2001,
      };
      if (when === 'earlier')
        f.step('supplier_credit_allocations', null, allocation);
      else f.future('supplier_credit_allocations', allocation);
      expect(
        f.step('supplier_credit_notes', draftCredit, validatedCredit).phase,
      ).toBe(when === 'future' ? 'transitions' : 'invalid');
    } finally {
      f.db.close();
    }
  },
);

it.skipIf(!process.env.ZENTRA_ACCOUNTING_TRANSITION_QA)(
  'matches unconditional guards from the current migrated native schema',
  () => {
    const triggers = JSON.parse(
      readFileSync(
        `${process.env.ZENTRA_ACCOUNTING_TRANSITION_QA}/native-triggers.json`,
        'utf8',
      ),
    ) as string[];
    const extracted: Record<'update' | 'delete', Set<string>> = {
      update: new Set(),
      delete: new Set(),
    };
    for (const sql of triggers) {
      const match = sql.match(
        /^CREATE TRIGGER(?: IF NOT EXISTS)? \w+\s+BEFORE (UPDATE|DELETE) ON (\w+)\s+BEGIN\s+SELECT RAISE\(ABORT\s*,\s*'(?:[^']|'')*'\);\s*END\s*;?$/i,
      );
      if (match && Object.hasOwn(contract.tables, match[2]))
        extracted[match[1].toLowerCase() as 'update' | 'delete'].add(match[2]);
    }
    for (const op of ['update', 'delete'] as const)
      expect([...extracted[op]].sort()).toEqual(immutable[op]);
  },
);

it.each(['9007199254740993', '9223372036854775807'])(
  'compares supplier payment totals exactly at %s cents',
  (amount) => {
    const f = fixture();
    try {
      f.source('supplier_payments', payment);
      f.db
        .prepare(
          "UPDATE business_sync_versions SET row_json=json_set(row_json,'$.amount_cents',json(?)) WHERE table_name='supplier_payments'",
        )
        .run(amount);
      const original = `{"id":"invoice","status":"validated","total_cents":${amount},"paid_cents":0,"credited_cents":0}`;
      const exact = `{"id":"invoice","status":"validated","total_cents":${amount},"paid_cents":${amount},"credited_cents":0}`;
      const args = f.args('supplier_invoices', invoice, invoice);
      args[21] = original;
      args[22] = exact;
      f.db.prepare(f.queries.reject.supplier_invoices).run(...args);
      expect(
        f.db
          .prepare('SELECT phase FROM business_sync_transaction_validations')
          .get()?.phase,
      ).toBe('transitions');
      args[22] = exact.replace(
        `"paid_cents":${amount}`,
        `"paid_cents":${BigInt(amount) - BigInt(1)}`,
      );
      f.db.prepare(f.queries.reject.supplier_invoices).run(...args);
      expect(
        f.db
          .prepare('SELECT phase FROM business_sync_transaction_validations')
          .get()?.phase,
      ).toBe('invalid');
    } finally {
      f.db.close();
    }
  },
);

it('rejects payment sums exceeding signed 64-bit cents without overflowing SQLite', () => {
  const f = fixture();
  try {
    f.source('supplier_payments', payment);
    f.source('supplier_payments', { ...payment, id: 'extra', amount_cents: 1 });
    f.db.exec(
      "UPDATE business_sync_versions SET row_json=json_set(row_json,'$.amount_cents',9223372036854775807) WHERE row_key_json='[\"payment\"]'",
    );
    expect(f.step('supplier_invoices', invoice, invoice).phase).toBe('invalid');
  } finally {
    f.db.close();
  }
});

it.each([
  ['payslips_posted_no_update', postedPayslipFields],
  ['supplier_invoices_validated_guard', validatedSupplierFields],
  ['supplier_credit_notes_validated_guard', validatedSupplierCreditFields],
] as const)(
  'matches the latest native frozen fields of %s',
  (trigger, fields) => {
    const native = readFileSync(
      new URL('../desktop/src-tauri/src/schema.rs', import.meta.url),
      'utf8',
    );
    const blocks = [
      ...native.matchAll(
        new RegExp(
          `CREATE TRIGGER(?: IF NOT EXISTS)? ${trigger}\\b[\\s\\S]*?END;`,
          'g',
        ),
      ),
    ];
    expect(blocks.length).toBeGreaterThan(0);
    const actual = [
      ...blocks.at(-1)![0].matchAll(/NEW\.(\w+) IS (?:NOT )?OLD\.\1/g),
    ]
      .map((m) => m[1])
      .filter(
        (f) =>
          !['payment_date', 'payment_journal_entry_id', 'status'].includes(f),
      );
    expect([...fields].filter((f) => f !== 'status').sort()).toEqual(
      actual.sort(),
    );
  },
);
it('distinguishes unconditional updates from conditional deletions', () => {
  const f = fixture();
  try {
    for (const operation of ['update', 'delete', 'insert'] as const)
      for (const table of new Set([
        ...immutable.update,
        ...immutable.delete,
        'clients',
        'supplier_credit_allocations',
        'attachments',
      ])) {
        f.db.exec('DELETE FROM business_sync_transaction_changes');
        f.db
          .prepare(
            'INSERT INTO business_sync_transaction_changes VALUES(?,?,?,?,?,?,?,?,NULL)',
          )
          .run('tx', 'org', table, '["id"]', '1', 0, 0, operation);
        const rejected =
          f.db.prepare(transactionImmutabilityRules[0].sql).get('tx', 'org') !==
          undefined;
        expect(rejected, `${table} ${operation}`).toBe(
          operation === 'insert' ? false : immutable[operation].includes(table),
        );
      }
  } finally {
    f.db.close();
  }
});
it.each(['update', 'delete'])(
  'blocks %s of a posted expense only once its journal exists',
  (operation) => {
    const f = fixture();
    try {
      const original = { id: 'expense', total_cents: 10000 };
      f.source('expenses', original);
      f.future('journal_entries', journal('expense', 'expense', 'post'));
      expect(
        f.step('expenses', original, { ...original, total_cents: 11000 }).phase,
      ).toBe('transitions');
      f.step('journal_entries', null, journal('expense', 'expense', 'post'));
      expect(
        f.step(
          'expenses',
          { ...original, total_cents: 11000 },
          operation === 'delete' ? null : original,
        ),
      ).toMatchObject({
        phase: 'invalid',
        failed_rule: 'transition:posted-expense',
      });
    } finally {
      f.db.close();
    }
  },
);
it.each(['source', 'earlier', 'future', 'wrong'])(
  'requires an earlier correct payroll journal (%s)',
  (kind) => {
    const f = fixture();
    try {
      f.source('payslips', salary);
      const proof = journal(
        'payslip',
        kind === 'wrong' ? 'someone-else' : 'salary',
        'payment',
      );
      if (kind === 'source' || kind === 'wrong')
        f.source('journal_entries', proof);
      else if (kind === 'future') f.future('journal_entries', proof);
      else f.step('journal_entries', null, proof);
      expect(f.step('payslips', salary, paid).phase).toBe(
        kind === 'source' || kind === 'earlier' ? 'transitions' : 'invalid',
      );
    } finally {
      f.db.close();
    }
  },
);
it.each(['employee_id', 'net_cents', 'payment_reference'])(
  'does not rewrite payroll %s when marking or repairing payment',
  (field) => {
    const f = fixture();
    try {
      f.source('journal_entries', journal('payslip', 'salary', 'payment'));
      const before =
        field === 'payment_reference'
          ? { ...paid, payment_journal_entry_id: null }
          : salary;
      f.source('payslips', before);
      expect(
        f.step('payslips', before, {
          ...paid,
          [field]: field === 'net_cents' ? 1 : 'rewritten',
        }).phase,
      ).toBe('invalid');
    } finally {
      f.db.close();
    }
  },
);
it('repairs legacy payment proof while preserving its existing date and reference', () => {
  const f = fixture();
  try {
    const legacy = { ...paid, payment_journal_entry_id: null };
    f.source('payslips', legacy);
    f.source('journal_entries', journal('payslip', 'salary', 'payment'));
    expect(f.step('payslips', legacy, paid).phase).toBe('transitions');
    expect(f.step('payslips', paid, paid).phase).toBe('invalid');
  } finally {
    f.db.close();
  }
});
it.each([
  ['supplier_invoices', 'supplier_invoice_items', 'supplier_invoice_id'],
  [
    'supplier_credit_notes',
    'supplier_credit_note_items',
    'supplier_credit_note_id',
  ],
] as const)(
  'requires both %s item parents to exist and remain drafts',
  (table, items, column) => {
    for (const target of ['locked', 'deleted', 'missing']) {
      const f = fixture();
      try {
        const draft = { id: 'draft', status: 'draft' };
        f.source(table, draft);
        f.source(table, { id: 'locked', status: 'validated' });
        f.step(table, null, { id: 'deleted', status: 'draft' });
        f.step(table, { id: 'deleted', status: 'draft' }, null);
        const line = { id: 'line', [column]: 'draft' };
        expect(f.step(items, null, line).phase).toBe('transitions');
        expect(f.step(items, line, { ...line, [column]: target }).phase).toBe(
          'invalid',
        );
      } finally {
        f.db.close();
      }
    }
  },
);
it.each(['source', 'earlier', 'future', 'wrong', 'overpaid'])(
  'checks supplier payment chronology and exact open balance (%s)',
  (kind) => {
    const f = fixture();
    try {
      f.source('supplier_invoices', invoice);
      const proof = journal(
        'supplier_payment',
        'payment',
        kind === 'wrong' ? 'invoice:other' : 'invoice:invoice',
      );
      if (kind === 'future') f.future('journal_entries', proof);
      else if (kind === 'earlier') f.step('journal_entries', null, proof);
      else f.source('journal_entries', proof);
      const input = {
        ...payment,
        amount_cents: kind === 'overpaid' ? 10001 : 3000,
      };
      expect(f.step('supplier_payments', null, input).phase).toBe(
        ['source', 'earlier'].includes(kind) ? 'transitions' : 'invalid',
      );
      if (['source', 'earlier'].includes(kind))
        expect(
          f.step('supplier_invoices', invoice, { ...invoice, paid_cents: 3000 })
            .phase,
        ).toBe('transitions');
    } finally {
      f.db.close();
    }
  },
);
it('ignores future payments when checking an earlier invoice total', () => {
  const f = fixture();
  try {
    f.source('supplier_invoices', invoice);
    f.future('supplier_payments', payment);
    expect(
      f.step('supplier_invoices', invoice, { ...invoice, paid_cents: 3000 })
        .phase,
    ).toBe('invalid');
  } finally {
    f.db.close();
  }
});
it('applies credit only after validation and accounts for subsequent reversals', () => {
  const f = fixture();
  try {
    const credit = draftCredit;
    const allocation = {
      id: 'allocation',
      supplier_credit_note_id: 'credit',
      supplier_invoice_id: 'invoice',
      amount_cents: 2000,
      event_type: 'apply',
    };
    f.source('supplier_invoices', invoice);
    creditSource(f);
    f.step('supplier_credit_allocations', null, allocation);
    expect(f.step('supplier_invoices', invoice, invoice).phase).toBe(
      'transitions',
    );
    expect(f.step('supplier_credit_notes', credit, validatedCredit).phase).toBe(
      'transitions',
    );
    const credited = { ...invoice, credited_cents: 2000 };
    expect(f.step('supplier_invoices', invoice, credited).phase).toBe(
      'transitions',
    );
    f.step('supplier_credit_allocations', null, {
      ...allocation,
      id: 'reversal',
      event_type: 'reverse',
    });
    expect(f.step('supplier_invoices', credited, invoice).phase).toBe(
      'transitions',
    );
    expect(f.step('supplier_credit_allocations', allocation, null).phase).toBe(
      'invalid',
    );
  } finally {
    f.db.close();
  }
});
it.each([true, false])(
  'does not make a future replacement credit allocation visible through its old key (same image=%s)',
  (sameImage) => {
    const f = fixture();
    try {
      const draft = draftCredit;
      const old = {
        id: 'allocation',
        supplier_credit_note_id: 'credit',
        supplier_invoice_id: 'invoice',
        amount_cents: 2000,
        event_type: 'apply',
      };
      f.source('supplier_invoices', invoice);
      creditSource(f);
      f.source('supplier_credit_notes', { id: 'other', status: 'validated' });
      f.source('supplier_credit_allocations', old);
      const replacement = sameImage
        ? old
        : { ...old, supplier_credit_note_id: 'other', amount_cents: 3000 };
      f.future('supplier_credit_allocations', replacement);
      expect(f.step('supplier_invoices', invoice, invoice).phase).toBe(
        'transitions',
      );
      f.step('supplier_credit_allocations', old, null);
      f.future('supplier_credit_allocations', replacement);
      expect(
        f.step('supplier_credit_notes', draft, validatedCredit).phase,
      ).toBe('transitions');
      expect(f.step('supplier_invoices', invoice, invoice).phase).toBe(
        'transitions',
      );
      f.step('supplier_credit_allocations', null, replacement);
      expect(
        f.step('supplier_invoices', invoice, {
          ...invoice,
          credited_cents: replacement.amount_cents,
        }).phase,
      ).toBe('transitions');
    } finally {
      f.db.close();
    }
  },
);

it.each(['source', 'earlier', 'future'])(
  'respects the order in which later payroll periods become validated (%s)',
  (when) => {
    const f = fixture();
    try {
      const current = {
        id: 'current',
        employee_id: 'employee',
        period: '2026-08',
        status: 'valide',
      };
      const later = {
        id: 'later',
        employee_id: 'employee',
        period: '2026-09',
        status: 'valide',
      };
      f.source('payslips', current);
      if (when === 'source') f.source('payslips', later);
      else if (when === 'earlier')
        expect(f.step('payslips', null, later).phase).toBe('transitions');
      else f.future('payslips', later);
      expect(
        f.step('payslips', current, { ...current, gross_cents: 10000 }).phase,
      ).toBe(when === 'future' ? 'transitions' : 'invalid');
    } finally {
      f.db.close();
    }
  },
);
it.each(['payslips', 'payslip_items', 'payslip_contributions'])(
  'seals earlier validated %s when a later period is validated',
  (table) => {
    for (const operation of ['insert', 'update', 'delete']) {
      const f = fixture();
      try {
        const current = {
          id: 'current',
          employee_id: 'employee',
          period: '2026-08',
          status: 'valide',
        };
        f.source('payslips', current);
        f.source('payslips', { ...current, id: 'later', period: '2026-09' });
        const row =
          table === 'payslips'
            ? current
            : { id: 'line', payslip_id: 'current' };
        expect(
          f.step(
            table,
            operation === 'insert' ? null : row,
            operation === 'delete' ? null : row,
          ),
        ).toMatchObject({
          phase: 'invalid',
          failed_rule:
            table === 'payslips'
              ? 'transition:payroll-period-order'
              : `transition:${table.replaceAll('_', '-')}-period-order`,
        });
      } finally {
        f.db.close();
      }
    }
  },
);
it.each(['year', 'employee', 'draft'])(
  'does not seal an earlier payroll for unrelated %s',
  (difference) => {
    const f = fixture();
    try {
      const current = {
        id: 'current',
        employee_id: 'employee',
        period: '2026-08',
        status: 'valide',
      };
      const later = { ...current, id: 'later', period: '2026-09' };
      if (difference === 'year') later.period = '2027-09';
      if (difference === 'employee') later.employee_id = 'other';
      if (difference === 'draft') later.status = 'brouillon';
      f.source('payslips', current);
      f.source('payslips', later);
      expect(f.step('payslips', current, current).phase).toBe('transitions');
    } finally {
      f.db.close();
    }
  },
);
it('uses the current payroll state when a later draft becomes validated and then is deleted before the final snapshot', () => {
  const f = fixture();
  try {
    const current = {
      id: 'current',
      employee_id: 'employee',
      period: '2026-08',
      status: 'valide',
    };
    const draft = {
      ...current,
      id: 'later',
      period: '2026-09',
      status: 'brouillon',
    };
    f.source('payslips', current);
    f.source('payslips', draft);
    expect(
      f.step('payslips', draft, { ...draft, status: 'valide' }).phase,
    ).toBe('transitions');
    f.db.exec(
      "DELETE FROM business_sync_versions WHERE transfer_id='tx' AND table_name='payslips' AND row_key_json='[\"later\"]'",
    );
    expect(f.step('payslips', current, current)).toMatchObject({
      phase: 'invalid',
      failed_rule: 'transition:payroll-period-order',
    });
  } finally {
    f.db.close();
  }
});
it.each([
  ['invoices', 'invoice_items', 'invoice_id'],
  ['quotes', 'quote_items', 'quote_id'],
  ['payslips', 'payslip_items', 'payslip_id'],
] as const)(
  'refuses moving a line into a frozen or absent %s parent',
  (table, items, key) => {
    for (const target of ['frozen', 'missing']) {
      const f = fixture();
      try {
        f.source(table, { id: 'draft', number: null, status: 'brouillon' });
        f.source(table, {
          id: 'frozen',
          number: 'F-1',
          status: 'comptabilise',
        });
        const line = { id: 'line', [key]: 'draft' };
        expect(f.step(items, line, { ...line, [key]: target }).phase).toBe(
          'invalid',
        );
      } finally {
        f.db.close();
      }
    }
  },
);

it('uses the partial journal source index instead of scanning an entire accounting history', () => {
  const f = fixture();
  try {
    const plan = f.db
      .prepare('EXPLAIN QUERY PLAN ' + f.queries.reject.expenses)
      .all(...f.args('expenses', { id: 'expense' }, null));
    expect(
      plan.some((row) =>
        String(row.detail).includes('business_sync_journal_source'),
      ),
    ).toBe(true);
  } finally {
    f.db.close();
  }
});
