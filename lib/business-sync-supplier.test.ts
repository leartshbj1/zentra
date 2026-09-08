import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { supplierRules } from './business-sync-supplier';

type Row = Record<string, unknown>;
let db: DatabaseSync;
let sequence: number;
function put(table: string, id: string, value: Row) {
  db.prepare(
    'INSERT OR REPLACE INTO business_sync_versions VALUES(?,?,?,?,?)',
  ).run(
    'transfer',
    'org',
    table,
    JSON.stringify([id]),
    JSON.stringify({ id, ...value }),
  );
}
function get(table: string, id: string): Row {
  return JSON.parse(
    db
      .prepare(
        'SELECT row_json FROM business_sync_versions WHERE table_name=? AND row_key_json=?',
      )
      .get(table, JSON.stringify([id]))!.row_json as string,
  );
}
function patch(table: string, id: string, value: Row) {
  put(table, id, { ...get(table, id), ...value });
}
function check() {
  return supplierRules
    .filter((rule) => db.prepare(rule.sql).get('transfer', 'org'))
    .map((rule) => rule.id);
}
function entry(
  id: string,
  type: string,
  source: string,
  event: string,
  date: string,
  lines: [string, number, number, string][],
) {
  put('journal_entries', id, {
    source_type: type,
    source_id: source,
    source_event: event,
    entry_date: date,
    status: 'posted',
    reversal_of: null,
  });
  lines.forEach(([account, debit, credit, memo], index) =>
    put('journal_lines', `${id}-${index}`, {
      journal_entry_id: id,
      account_id: account,
      debit_cents: debit,
      credit_cents: credit,
      currency: 'CHF',
      memo,
      project_id: null,
      client_id: null,
      employee_id: null,
    }),
  );
}
function freeze(credit: boolean) {
  const table = credit ? 'supplier_credit_notes' : 'supplier_invoices';
  const items = credit
    ? 'supplier_credit_note_items'
    : 'supplier_invoice_items';
  const id = credit ? 'credit' : 'invoice';
  const snapshot = {
    schema: `elyko.${credit ? 'supplier_credit_note' : 'supplier_invoice'}_snapshot.v1`,
    captured_at: '2026-08-03',
    [credit ? 'credit_note' : 'document']: get(table, id),
    items: [get(items, `${id}-item`)],
    allocations: [],
  };
  patch(table, id, { snapshot_json: JSON.stringify(snapshot) });
}
function apply(
  id: string,
  amount: number,
  date: string,
  reverses: string | null = null,
) {
  put('supplier_credit_allocations', id, {
    request_id: `request-${id}`,
    supplier_credit_note_id: 'credit',
    supplier_invoice_id: 'invoice',
    event_type: reverses ? 'reverse' : 'apply',
    amount_cents: amount,
    effective_date: date,
    reverses_allocation_id: reverses,
    sequence: ++sequence,
    created_at: `${date}T12:00:00Z`,
  });
  const previous = get('supplier_invoices', 'invoice').credited_cents as number;
  patch('supplier_invoices', 'invoice', {
    credited_cents: previous + (reverses ? -amount : amount),
  });
}
function refund(
  id: string,
  amount: number,
  date: string,
  reverses: string | null = null,
) {
  put('supplier_credit_refunds', id, {
    supplier_credit_note_id: 'credit',
    event_type: reverses ? 'reverse' : 'refund',
    reverses_id: reverses,
    date,
    amount_cents: amount,
    bank_account_id: 'bank',
    payable_account_id: 'payable',
    journal_entry_id: id,
    reason: 'Virement reçu',
    sequence: ++sequence,
    created_at: `${date}T12:00:00Z`,
  });
  entry(
    id,
    'supplier_credit_refund',
    id,
    reverses ? 'reverse' : 'refund',
    date,
    [
      ['bank', reverses ? 0 : amount, reverses ? amount : 0, 'Virement reçu'],
      [
        'payable',
        reverses ? amount : 0,
        reverses ? 0 : amount,
        'Virement reçu',
      ],
    ],
  );
}
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  sequence = 0;
  db.exec(
    'CREATE TABLE business_sync_versions(transfer_id TEXT,organization_id TEXT,table_name TEXT,row_key_json TEXT,row_json TEXT,UNIQUE(transfer_id,organization_id,table_name,row_key_json))',
  );
  for (const [id, type] of [
    ['bank', 'asset'],
    ['vat', 'asset'],
    ['payable', 'liability'],
    ['expense', 'expense'],
    ['other-expense', 'expense'],
  ])
    put('accounts', id, { account_type: type });
  for (const credit of [false, true]) {
    const id = credit ? 'credit' : 'invoice',
      table = credit ? 'supplier_credit_notes' : 'supplier_invoices';
    const net = credit ? 500 : 1000,
      vat = credit ? 41 : 81,
      total = net + vat;
    put(table, id, {
      supplier_id: 'supplier',
      supplier_name: 'Fournisseur',
      reference: 'REF',
      reference_normalized: 'REF',
      status: 'validated',
      document_date: credit ? '2026-08-03' : '2026-08-01',
      currency: 'CHF',
      net_cents: net,
      vat_cents: vat,
      total_cents: total,
      paid_cents: 0,
      credited_cents: 0,
      project_id: null,
      note: null,
      created_at: '2026-08-01',
      validation_journal_entry_id: id,
    });
    put(
      credit ? 'supplier_credit_note_items' : 'supplier_invoice_items',
      `${id}-item`,
      {
        [credit ? 'supplier_credit_note_id' : 'supplier_invoice_id']: id,
        description: 'Marchandises',
        quantity_milli: 1000,
        unit_price_cents: net,
        discount_bp: 0,
        vat_bp: 810,
        line_net_cents: net,
        line_vat_cents: vat,
        line_total_cents: total,
        posted_expense_account_id: 'expense',
        project_id: null,
      },
    );
    entry(
      id,
      credit ? 'supplier_credit_note' : 'supplier_invoice',
      id,
      'validate',
      credit ? '2026-08-03' : '2026-08-01',
      [
        ['expense', credit ? 0 : net, credit ? net : 0, 'Marchandises'],
        [
          'vat',
          credit ? 0 : vat,
          credit ? vat : 0,
          credit
            ? 'Correction TVA préalable fournisseur'
            : 'TVA préalable fournisseur',
        ],
        [
          'payable',
          credit ? total : 0,
          credit ? 0 : total,
          credit ? 'Avoir sur dette fournisseur' : 'Dette fournisseur',
        ],
      ],
    );
    freeze(credit);
  }
});
afterEach(() => db.close());
it('accepts both native purchase journal directions and exact snapshots', () =>
  expect(check()).toEqual([]));
it('rejects a forged balanced credit posting', () => {
  patch('journal_lines', 'credit-0', { credit_cents: 499 });
  patch('journal_lines', 'credit-1', { credit_cents: 42 });
  expect(check()).toContain('supplier_credit_notes:exact_posting');
});
it('binds charges to their frozen accounts, descriptions and projects', () => {
  patch('journal_lines', 'invoice-0', {
    account_id: 'other-expense',
    project_id: 'foreign',
  });
  expect(check()).toContain('supplier_invoices:exact_posting');
});
it('allows expense descriptions equal to a reserved accounting memo', () => {
  patch('supplier_invoice_items', 'invoice-item', {
    description: 'TVA préalable fournisseur',
  });
  patch('journal_lines', 'invoice-0', { memo: 'TVA préalable fournisseur' });
  freeze(false);
  expect(check()).toEqual([]);
});
it('keeps historical accounts valid after deactivation', () => {
  for (const id of ['vat', 'payable', 'expense'])
    patch('accounts', id, { active: 0 });
  expect(check()).toEqual([]);
});
it.each([false, true])(
  'accepts a legacy missing expense-account field only with an unambiguous original posting (credit=%s)',
  (credit) => {
    const table = credit ? 'supplier_credit_notes' : 'supplier_invoices';
    const itemTable = credit
      ? 'supplier_credit_note_items'
      : 'supplier_invoice_items';
    const id = credit ? 'credit' : 'invoice';
    const snapshot = JSON.parse(get(table, id).snapshot_json as string);
    delete snapshot.items[0].posted_expense_account_id;
    patch(table, id, { snapshot_json: JSON.stringify(snapshot) });
    patch(itemTable, `${id}-item`, { posted_expense_account_id: null });
    expect(check()).toEqual([]);
    // Today's default is irrelevant to an old immutable journal.
    put('accounting_settings', '1', { expense_account_id: 'other-expense' });
    expect(check()).toEqual([]);
    patch('journal_lines', `${id}-0`, { memo: 'Different purchase' });
    expect(check()).toContain(`${table}:posted_accounts`);
  },
);
it('refuses ambiguous legacy accounts and does not erase a frozen account', () => {
  patch('supplier_credit_note_items', 'credit-item', {
    posted_expense_account_id: null,
  });
  expect(check()).toContain('supplier_credit_notes:snapshot_rows');
  freeze(true);
  put('journal_lines', 'ambiguous', {
    ...get('journal_lines', 'credit-0'),
    account_id: 'other-expense',
  });
  expect(check()).toContain('supplier_credit_notes:posted_accounts');
  expect(check()).toContain('supplier_credit_notes:exact_posting');
});
it.each(['{}', 'null', 'broken', '["string",null]'])(
  'rejects a malformed frozen purchase %s',
  (snapshot) => {
    patch('supplier_credit_notes', 'credit', { snapshot_json: snapshot });
    expect(check()).toContain('supplier_credit_notes:snapshot_shape');
  },
);
it('requires the complete immutable item set', () => {
  const snapshot = JSON.parse(
    get('supplier_invoices', 'invoice').snapshot_json as string,
  );
  snapshot.items = [];
  patch('supplier_invoices', 'invoice', {
    snapshot_json: JSON.stringify(snapshot),
  });
  expect(check()).toContain('supplier_invoices:snapshot_rows');
});
it('rejects a changed source amount even when the new posting remains balanced', () => {
  patch('supplier_credit_note_items', 'credit-item', {
    line_net_cents: 501,
    line_total_cents: 542,
  });
  expect(check()).toContain('supplier_credit_note_items:exact_amounts');
  expect(check()).toContain('supplier_credit_notes:item_totals');
  expect(check()).toContain('supplier_credit_notes:snapshot_rows');
});
it('refuses a missing, foreign or reversed original journal', () => {
  patch('journal_entries', 'credit', { source_id: 'invoice' });
  expect(check()).toContain('supplier_credit_notes:source_journal');
  patch('journal_entries', 'credit', { source_id: 'credit' });
  put('journal_entries', 'reverse', { reversal_of: 'credit' });
  expect(check()).toContain('supplier_credit_notes:source_journal');
});
it('preserves exact refunds, reversals and the common credit balance', () => {
  refund('refund', 400, '2026-08-04');
  apply('allocation', 100, '2026-08-05');
  refund('reverse', 400, '2026-08-06', 'refund');
  refund('final', 441, '2026-08-07');
  expect(check()).toEqual([]);
  patch('journal_lines', 'final-0', { debit_cents: 440 });
  patch('journal_lines', 'final-1', { credit_cents: 440 });
  expect(check()).toContain('supplier_refunds:journal');
});
it('rejects a historical over-allocation even when a later reversal repairs the final balance', () => {
  refund('refund', 400, '2026-08-04');
  apply('allocation', 200, '2026-08-05');
  refund('reverse', 400, '2026-08-06', 'refund');
  expect(check()).not.toContain('supplier_settlements:balance');
  expect(check()).toContain('supplier_settlements:chronology');
});
it('checks refund account identity against its original credit', () => {
  refund('refund', 100, '2026-08-04');
  patch('supplier_credit_refunds', 'refund', { payable_account_id: 'bank' });
  expect(check()).toContain('supplier_refunds:source');
});
it('checks supplier identity and the recorded invoice credit total', () => {
  apply('allocation', 100, '2026-08-04');
  patch('supplier_invoices', 'invoice', {
    credited_cents: 101,
    supplier_id: 'foreign',
  });
  expect(check()).toContain('supplier_invoices:credited');
  expect(check()).toContain('supplier_allocations:source');
});
it('compares reversal order by effective date before the device clock', () => {
  apply('allocation', 100, '2026-08-04');
  apply('reverse', 100, '2026-08-05', 'allocation');
  patch('supplier_credit_allocations', 'reverse', {
    created_at: '2026-08-01T00:00:00Z',
  });
  expect(check()).toEqual([]);
  patch('supplier_credit_allocations', 'reverse', {
    effective_date: '2026-08-04',
  });
  expect(check()).toContain('supplier_allocations:reversal');
});
it('keeps unknown legacy settlement dates without inventing a chronology', () => {
  apply('legacy', 100, '2026-08-04');
  patch('supplier_credit_allocations', 'legacy', { effective_date: null });
  expect(check()).toEqual([]);
});
function freezeInitialAllocation(legacy = false) {
  apply('initial', 100, '2026-08-04');
  patch('supplier_credit_allocations', 'initial', {
    request_id: null,
    ...(legacy ? { effective_date: null } : {}),
  });
  const snapshot = JSON.parse(
    get('supplier_credit_notes', 'credit').snapshot_json as string,
  );
  const allocation = get('supplier_credit_allocations', 'initial');
  if (legacy) delete allocation.effective_date;
  snapshot.allocations = [allocation];
  patch('supplier_credit_notes', 'credit', {
    snapshot_json: JSON.stringify(snapshot),
  });
}
it.each([false, true])(
  'retains the frozen initial allocation set and later reversals (legacy=%s)',
  (legacy) => {
    freezeInitialAllocation(legacy);
    apply('later', 50, '2026-08-05');
    apply('reverse', 100, '2026-08-06', 'initial');
    expect(check()).toEqual([]);
    patch('supplier_credit_allocations', 'initial', {
      reason: 'Rewritten after validation',
    });
    expect(check()).toContain('supplier_credit_notes:allocation_snapshot_rows');
  },
);
it('rejects a missing frozen allocation or a new application disguised as a draft application', () => {
  freezeInitialAllocation();
  patch('supplier_credit_allocations', 'initial', { request_id: 'forged' });
  expect(check()).toContain('supplier_credit_notes:allocation_snapshot_rows');
  patch('supplier_credit_allocations', 'initial', { request_id: null });
  apply('not-frozen', 20, '2026-08-05');
  patch('supplier_credit_allocations', 'not-frozen', { request_id: null });
  expect(check()).toContain('supplier_credit_notes:allocation_snapshot_rows');
});
it('rejects duplicate or malformed frozen allocations', () => {
  freezeInitialAllocation();
  const snapshot = JSON.parse(
    get('supplier_credit_notes', 'credit').snapshot_json as string,
  );
  snapshot.allocations.push(snapshot.allocations[0]);
  patch('supplier_credit_notes', 'credit', {
    snapshot_json: JSON.stringify(snapshot),
  });
  expect(check()).toContain('supplier_credit_notes:allocation_snapshot_shape');
  snapshot.allocations = [null];
  patch('supplier_credit_notes', 'credit', {
    snapshot_json: JSON.stringify(snapshot),
  });
  expect(check()).toContain('supplier_credit_notes:allocation_snapshot_shape');
});
it('requires request identity on reversals and only permits initial applications on drafts', () => {
  apply('initial', 100, '2026-08-04');
  apply('reverse', 100, '2026-08-05', 'initial');
  patch('supplier_credit_allocations', 'reverse', { request_id: null });
  expect(check()).toContain('supplier_allocations:reversal');
  patch('supplier_credit_notes', 'credit', { status: 'draft' });
  expect(check()).toContain('supplier_allocations:source');
});
it('rounds large thousandths exactly even when the intermediate product exceeds i64', () => {
  const quantity = BigInt('999999999'),
    price = BigInt('9999999999'),
    net = (quantity * price + BigInt(500)) / BigInt(1000);
  expect(net > BigInt('9007199254740991')).toBe(true);
  db.prepare(
    "UPDATE business_sync_versions SET row_json=json_set(row_json,'$.quantity_milli',CAST(? AS INTEGER),'$.unit_price_cents',CAST(? AS INTEGER),'$.vat_bp',0,'$.line_net_cents',CAST(? AS INTEGER),'$.line_vat_cents',0,'$.line_total_cents',CAST(? AS INTEGER)) WHERE table_name='supplier_invoice_items'",
  ).run(String(quantity), String(price), String(net), String(net));
  const sql = supplierRules.find(
    (rule) => rule.id === 'supplier_invoice_items:exact_amounts',
  )!.sql;
  expect(db.prepare(sql).get('transfer', 'org')).toBeUndefined();
  db.exec(
    "UPDATE business_sync_versions SET row_json=json_set(row_json,'$.line_net_cents',json_extract(row_json,'$.line_net_cents')+1) WHERE table_name='supplier_invoice_items'",
  );
  expect(db.prepare(sql).get('transfer', 'org')).toBeDefined();
});
it('rejects an overflowing product instead of comparing rounded floating-point cents', () => {
  db.exec(
    "UPDATE business_sync_versions SET row_json=json_set(row_json,'$.quantity_milli',9223372036854775807,'$.unit_price_cents',9223372036854775807,'$.vat_bp',0) WHERE table_name='supplier_invoice_items'",
  );
  const sql = supplierRules.find(
    (rule) => rule.id === 'supplier_invoice_items:exact_amounts',
  )!.sql;
  expect(db.prepare(sql).get('transfer', 'org')).toBeDefined();
});
