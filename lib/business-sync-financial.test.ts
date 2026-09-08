import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { financialRules } from './business-sync-financial';
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
  data: Record<string, unknown>,
  org = 'first',
  transfer = 'transfer',
) {
  db.prepare('INSERT INTO business_sync_versions VALUES(?,?,?,?,?)').run(
    transfer,
    org,
    table,
    JSON.stringify([data.id ?? data.credit_note_id ?? data.quote_id]),
    JSON.stringify(data),
  );
}
function patch(table: string, id: string, value: Record<string, unknown>) {
  db.prepare(
    "UPDATE business_sync_versions SET row_json=json_patch(row_json,?) WHERE table_name=? AND json_extract(row_json,'$.id')=?",
  ).run(JSON.stringify(value), table, id);
}
function failures() {
  return financialRules
    .filter((rule) => db.prepare(rule.sql).get('transfer', 'first'))
    .map((rule) => rule.id);
}
function doc(
  id = 'i',
  value: Record<string, unknown> = {},
  table = 'invoices',
) {
  row(table, {
    id,
    type: 'standard',
    status: 'emise',
    number: id,
    issue_date: '2026-09-08',
    currency: 'CHF',
    client_id: null,
    project_id: null,
    quote_id: null,
    original_invoice_id: null,
    subtotal_cents: 0,
    discount_cents: 0,
    vat_cents: 0,
    total_cents: 0,
    paid_cents: 0,
    ...value,
  });
}
function item(
  id: string,
  parent: string,
  value: Record<string, unknown> = {},
  table = 'invoice_items',
) {
  row(table, {
    id,
    invoice_id: parent,
    quote_id: parent,
    quantity: 1,
    unit_price_cents: 0,
    discount_bp: 0,
    vat_bp: 0,
    line_net_cents: 0,
    line_vat_cents: 0,
    line_total_cents: 0,
    ...value,
  });
}
function simple(
  id: string,
  total: number,
  extra: Record<string, unknown> = {},
) {
  doc(id, { subtotal_cents: total, total_cents: total, ...extra });
  item(id + '-line', id, {
    unit_price_cents: total,
    line_net_cents: total,
    line_total_cents: total,
  });
}
it.each(['invoices', 'quotes'])(
  'compares %s details, discount and VAT against its stored totals',
  (table) => {
    const lines = table === 'invoices' ? 'invoice_items' : 'quote_items';
    doc(
      'd',
      {
        subtotal_cents: 100000,
        discount_cents: 10000,
        vat_cents: 7290,
        total_cents: 97290,
      },
      table,
    );
    item(
      'line',
      'd',
      {
        quantity: 1.25,
        unit_price_cents: 80000,
        discount_bp: 1000,
        vat_bp: 810,
        line_net_cents: 90000,
        line_vat_cents: 7290,
        line_total_cents: 97290,
      },
      lines,
    );
    expect(failures()).toEqual([]);
    patch(table, 'd', { vat_cents: 7291, total_cents: 97291 });
    expect(failures()).toContain(`${table}:totals`);
    patch(lines, 'line', { line_vat_cents: 7291, line_total_cents: 97291 });
    expect(failures()).toEqual([`${lines}:amounts`]);
  },
);
it('preserves negative credit and deposit deduction lines and rounds both half signs away from zero', () => {
  simple('credit', -30000, { type: 'avoir', original_invoice_id: 'original' });
  simple('original', 100000);
  doc('final', { subtotal_cents: 70000, total_cents: 70000, type: 'finale' });
  item('original-line', 'final', {
    unit_price_cents: 100000,
    line_net_cents: 100000,
    line_total_cents: 100000,
  });
  item('deduction', 'final', {
    unit_price_cents: -30000,
    line_net_cents: -30000,
    line_total_cents: -30000,
  });
  for (const sign of [-1, 1]) {
    doc('half' + sign, { subtotal_cents: sign, discount_cents: sign });
    item('half-line' + sign, 'half' + sign, {
      quantity: 0.5,
      unit_price_cents: sign,
      discount_bp: 5000,
    });
  }
  expect(failures()).toEqual([]);
});
it('keeps integer rate rounding exact when direct multiplication would overflow int64', () => {
  const base = 9_000_000_000_000_000;
  const discount = (BigInt(base) * BigInt(9999)) / BigInt(10000);
  const net = base - Number(discount);
  doc('large', {
    subtotal_cents: base,
    discount_cents: Number(discount),
    total_cents: net,
  });
  item('large-line', 'large', {
    unit_price_cents: base,
    discount_bp: 9999,
    line_net_cents: net,
    line_total_cents: net,
  });
  expect(failures()).toEqual([]);
});
it('detects one cent after cancellation of amounts whose running sum exceeds JavaScript precision', () => {
  doc('large');
  for (let at = 0; at < 2; at++)
    for (const sign of [-1, 1])
      item(`line-${at}-${sign}`, 'large', {
        unit_price_cents: sign * 9_000_000_000_000_000,
        line_net_cents: sign * 9_000_000_000_000_000,
        line_total_cents: sign * 9_000_000_000_000_000,
      });
  expect(failures()).toEqual([]);
  patch('invoices', 'large', { total_cents: 1 });
  expect(failures()).toEqual(['invoices:totals']);
});
it('reports oversized aggregates and nonrepresentable quantity products without a SQLite overflow', () => {
  doc('huge');
  for (let i = 0; i < 1025; i++)
    item('line-' + i, 'huge', {
      unit_price_cents: 9_000_000_000_000_000,
      line_net_cents: 9_000_000_000_000_000,
      line_total_cents: 9_000_000_000_000_000,
    });
  expect(failures()).toEqual(['invoices:totals']);
  patch('invoice_items', 'line-0', { quantity: 1e300 });
  expect(failures()).toContain('invoice_items:amounts');
});
it('matches received payments exactly and rejects payment on a draft or before issue', () => {
  simple('i', 100000, { paid_cents: 30000 });
  row('payments', {
    id: 'p',
    invoice_id: 'i',
    date: '2026-09-08',
    amount_cents: 30000,
  });
  expect(failures()).toEqual([]);
  patch('invoices', 'i', { paid_cents: 30001 });
  expect(failures()).toEqual(['invoices:paid']);
  patch('invoices', 'i', { paid_cents: 30000, status: 'brouillon' });
  expect(failures()).toContain('payments:invoice');
  patch('invoices', 'i', { status: 'emise' });
  patch('payments', 'p', { date: '2026-09-07' });
  expect(failures()).toEqual(['payments:invoice']);
});
it('includes legacy credits and only the applied portion of dated credits in the settled balance', () => {
  simple('i', 100000, { paid_cents: 60000 });
  row('payments', {
    id: 'p',
    invoice_id: 'i',
    date: '2026-09-08',
    amount_cents: 60000,
  });
  simple('credit', -50000, { type: 'avoir', original_invoice_id: 'i' });
  expect(failures()).toEqual(['invoices:settled']);
  row('customer_credit_documents', { credit_note_id: 'credit' });
  row('customer_credit_settlements', {
    id: 'apply',
    credit_note_id: 'credit',
    invoice_id: 'i',
    event_type: 'apply',
    amount_cents: 40000,
  });
  expect(failures()).toEqual([]);
  row('customer_credit_settlements', {
    id: 'refund',
    credit_note_id: 'credit',
    invoice_id: null,
    event_type: 'refund',
    amount_cents: 10000,
  });
  expect(failures()).toEqual([]);
  patch('customer_credit_settlements', 'refund', { amount_cents: 10001 });
  expect(failures()).toEqual(['credits:available']);
});
it('refuses excess credit reversals and respects a valid partial reversal', () => {
  simple('i', 100000);
  simple('credit', -50000, { type: 'avoir', original_invoice_id: 'i' });
  row('customer_credit_documents', { credit_note_id: 'credit' });
  row('customer_credit_settlements', {
    id: 'apply',
    credit_note_id: 'credit',
    invoice_id: 'i',
    event_type: 'apply',
    amount_cents: 30000,
  });
  row('customer_credit_settlements', {
    id: 'reverse',
    credit_note_id: 'credit',
    invoice_id: 'i',
    event_type: 'reverse_apply',
    amount_cents: 10000,
  });
  expect(failures()).toEqual([]);
  patch('customer_credit_settlements', 'reverse', { amount_cents: 30001 });
  expect(failures()).toEqual(['invoices:credit_balance', 'credits:reversals']);
});
it('does not borrow lines or payments from another company or transfer', () => {
  doc('i', { subtotal_cents: 100, total_cents: 100, paid_cents: 100 });
  for (const [org, transfer] of [
    ['other', 'transfer'],
    ['first', 'other'],
  ]) {
    row(
      'invoice_items',
      {
        id: 'wrong',
        invoice_id: 'i',
        unit_price_cents: 100,
        quantity: 1,
        line_net_cents: 100,
        line_vat_cents: 0,
        line_total_cents: 100,
        vat_bp: 0,
        discount_bp: 0,
      },
      org,
      transfer,
    );
    row(
      'payments',
      { id: 'wrong', invoice_id: 'i', amount_cents: 100 },
      org,
      transfer,
    );
  }
  expect(failures()).toEqual(['invoices:totals', 'invoices:paid']);
});
it('validates paired invoice totals and shared project, customer and quote identity', () => {
  doc('q', { subtotal_cents: 100000, total_cents: 100000 }, 'quotes');
  item(
    'q-line',
    'q',
    {
      unit_price_cents: 100000,
      line_net_cents: 100000,
      line_total_cents: 100000,
    },
    'quote_items',
  );
  simple('deposit', 30000, { type: 'acompte', quote_id: 'q' });
  simple('balance', 70000, { type: 'finale', quote_id: 'q' });
  row('quote_invoice_pairs', {
    quote_id: 'q',
    deposit_invoice_id: 'deposit',
    balance_invoice_id: 'balance',
  });
  expect(failures()).toEqual([]);
  patch('invoices', 'balance', { project_id: 'different' });
  expect(failures()).toEqual(['quote_invoice_pairs:documents']);
});
it('checks expense arithmetic and supplier payment totals and dates', () => {
  row('expenses', {
    id: 'expense',
    net_cents: 100,
    vat_cents: 8,
    total_cents: 108,
  });
  row('supplier_invoices', {
    id: 'supplier',
    status: 'validated',
    document_date: '2026-09-08',
    paid_cents: 50,
  });
  row('supplier_payments', {
    id: 'payment',
    supplier_invoice_id: 'supplier',
    date: '2026-09-08',
    amount_cents: 50,
  });
  expect(failures()).toEqual([]);
  patch('expenses', 'expense', { total_cents: 109 });
  patch('supplier_payments', 'payment', {
    amount_cents: 51,
    date: '2026-09-07',
  });
  expect(failures()).toEqual([
    'expenses:amounts',
    'supplier_invoices:paid',
    'supplier_payments:invoice',
  ]);
});
