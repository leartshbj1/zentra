import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { postingRules } from './business-sync-postings';
import { accountingRules } from './business-sync-accounting';
let db: DatabaseSync;
let sequence: number;
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  sequence = 0;
  db.exec(
    'CREATE TABLE business_sync_versions(transfer_id TEXT,organization_id TEXT,table_name TEXT,row_key_json TEXT,row_json TEXT)',
  );
  record('settings', 'settings', { currency: 'CHF' });
  record('accounting_settings', 'accounting', { enabled: 0 });
  for (const [id, type] of [
    ['ar', 'asset'],
    ['bank', 'asset'],
    ['input_vat', 'asset'],
    ['other_ar', 'asset'],
    ['revenue', 'revenue'],
    ['expense', 'expense'],
    ['due_vat', 'liability'],
    ['deferred', 'liability'],
    ['payable', 'liability'],
    ['salary', 'liability'],
  ])
    record('accounts', id, { account_type: type });
});
afterEach(() => db.close());
function record(
  table: string,
  id: string,
  data: Record<string, unknown>,
  org = 'first',
  transfer = 'transfer',
) {
  db.prepare('INSERT INTO business_sync_versions VALUES(?,?,?,?,?)').run(
    transfer,
    org,
    table,
    JSON.stringify([id]),
    JSON.stringify({ id, ...data }),
  );
}
function patch(table: string, id: string, data: Record<string, unknown>) {
  db.prepare(
    "UPDATE business_sync_versions SET row_json=json_patch(row_json,?) WHERE table_name=? AND json_extract(row_json,'$.id')=?",
  ).run(JSON.stringify(data), table, id);
}
function entry(
  id: string,
  kind = 'manual',
  source = id,
  event = 'post',
  reversal: string | null = null,
  date = '2026-09-08',
) {
  record('journal_entries', id, {
    number: 'J-' + id,
    source_type: kind,
    source_id: source,
    source_event: event,
    reversal_of: reversal,
    entry_date: date,
  });
}
function line(
  entry: string,
  account: string,
  debit: number,
  credit: number,
  memo: string | null = null,
  extra: Record<string, unknown> = {},
) {
  const id = 'line-' + sequence++;
  record('journal_lines', id, {
    journal_entry_id: entry,
    account_id: account,
    debit_cents: debit,
    credit_cents: credit,
    currency: 'CHF',
    memo,
    project_id: null,
    client_id: null,
    employee_id: null,
    ...extra,
  });
  return id;
}
function failures() {
  return postingRules
    .filter((rule) => db.prepare(rule.sql).get('transfer', 'first'))
    .map((rule) => rule.id);
}
function balanced() {
  expect(
    accountingRules
      .filter((rule) => db.prepare(rule.sql).get('transfer', 'first'))
      .map((rule) => rule.id),
  ).toEqual([]);
}
function reverse(parent: string, id: string, date = '2026-09-08') {
  entry(id, 'journal_reversal', parent, 'reverse', parent, date);
  const original = db
    .prepare(
      "SELECT row_json FROM business_sync_versions WHERE table_name='journal_lines' AND json_extract(row_json,'$.journal_entry_id')=?",
    )
    .all(parent);
  for (const row of original) {
    const l = JSON.parse(row.row_json as string);
    line(
      id,
      l.account_id,
      l.credit_cents,
      l.debit_cents,
      'Extourne J-' + parent,
      {
        currency: l.currency,
        project_id: l.project_id,
        client_id: l.client_id,
        employee_id: l.employee_id,
      },
    );
  }
}
function invoice(id = 'invoice', vat = 0) {
  record('invoices', id, {
    type: 'standard',
    status: 'emise',
    number: 'F-' + id,
    issue_date: '2026-09-08',
    currency: 'CHF',
    total_cents: 100000 + vat,
    vat_cents: vat,
    original_invoice_id: null,
    subtotal_cents: 100000,
    discount_cents: 0,
  });
  entry('issue-' + id, 'invoice', id, 'issue');
  line('issue-' + id, 'ar', 100000 + vat, 0, 'Créance client');
  line('issue-' + id, 'revenue', 0, 100000, 'Produit facturé');
  if (vat) line('issue-' + id, 'due_vat', 0, vat, 'TVA due');
}
function payment(id = 'payment', amount = 30000) {
  record('payments', id, {
    invoice_id: 'invoice',
    date: '2026-09-08',
    amount_cents: amount,
  });
  entry('payment-' + id, 'payment', id, 'invoice:invoice');
  line('payment-' + id, 'bank', amount, 0, 'Encaissement');
  return line('payment-' + id, 'ar', 0, amount, 'Règlement créance');
}
it('matches issued invoice and payment amount, currency, date and original receivable account', () => {
  invoice();
  const paidLine = payment();
  balanced();
  expect(failures()).toEqual([]);
  patch('journal_lines', paidLine, { account_id: 'other_ar' });
  balanced();
  expect(failures()).toEqual(['posting:payment']);
  patch('journal_lines', paidLine, { account_id: 'ar' });
  patch('payments', 'payment', { amount_cents: 30001 });
  balanced();
  expect(failures()).toEqual(['posting:payment']);
  patch('payments', 'payment', { amount_cents: 30000, date: '2026-09-09' });
  expect(failures()).toEqual(['posting:payment']);
});
it('rejects a balanced invoice on the wrong revenue account type or in another currency', () => {
  invoice('invoice', 8100);
  balanced();
  expect(failures()).toEqual([]);
  patch('accounts', 'revenue', { account_type: 'liability' });
  balanced();
  expect(failures()).toEqual(['posting:invoice']);
  patch('accounts', 'revenue', { account_type: 'revenue' });
  db.exec(
    "UPDATE business_sync_versions SET row_json=json_set(row_json,'$.currency','EUR') WHERE table_name='journal_lines'",
  );
  balanced();
  expect(failures()).toEqual(['posting:invoice']);
});
it('uses the historical VAT profile and rejects the wrong deferred VAT posting', () => {
  invoice('invoice', 8100);
  record('vat_profiles', 'profile', {
    effective_from: '2026-01-01',
    effective_to: null,
    form_of_reporting: 'received',
  });
  expect(failures()).toEqual(['posting:invoice']);
  db.exec(
    "UPDATE business_sync_versions SET row_json=json_set(row_json,'$.memo','TVA à régulariser · contre-prestations reçues','$.account_id','deferred') WHERE table_name='journal_lines' AND json_extract(row_json,'$.memo')='TVA due'",
  );
  expect(failures()).toEqual([]);
});
it('matches a credit note to the original revenue and receivable accounts', () => {
  invoice('invoice', 8100);
  record('invoices', 'credit', {
    type: 'avoir',
    status: 'emise',
    number: 'A-1',
    issue_date: '2026-09-08',
    currency: 'CHF',
    total_cents: -54050,
    vat_cents: -4050,
    original_invoice_id: 'invoice',
    subtotal_cents: -50000,
    discount_cents: 0,
  });
  entry('credit-entry', 'invoice', 'credit', 'issue');
  const revenue = line('credit-entry', 'revenue', 50000, 0, 'Extourne produit');
  line('credit-entry', 'due_vat', 4050, 0, 'Extourne TVA');
  line('credit-entry', 'ar', 0, 54050, 'Réduction créance client');
  balanced();
  expect(failures()).toEqual([]);
  record('accounts', 'another_revenue', { account_type: 'revenue' });
  patch('journal_lines', revenue, { account_id: 'another_revenue' });
  balanced();
  expect(failures()).toEqual(['posting:credit_accounts']);
});
it('preserves invoice reversal and restoration parity and rejects a still-cancelled posting', () => {
  invoice();
  reverse('issue-invoice', 'reverse');
  balanced();
  expect(failures()).toContain('posting:required');
  patch('invoices', 'invoice', { status: 'annulee' });
  expect(failures()).toEqual([]);
  reverse('reverse', 'restore');
  balanced();
  expect(failures()).toEqual(['posting:cancelled_invoice']);
  patch('invoices', 'invoice', { status: 'emise' });
  expect(failures()).toEqual([]);
});
it('refuses a reversal fork, unreachable cycle, altered dimensions and a date before its parent', () => {
  entry('root');
  line('root', 'bank', 100, 0, null, { project_id: 'project' });
  line('root', 'ar', 0, 100);
  reverse('root', 'reverse');
  expect(failures()).toEqual([]);
  patch('journal_entries', 'reverse', { entry_date: '2026-09-07' });
  expect(failures()).toEqual(['reversal:date']);
  patch('journal_entries', 'reverse', { entry_date: '2026-09-08' });
  db.exec(
    "UPDATE business_sync_versions SET row_json=json_set(row_json,'$.project_id','wrong') WHERE table_name='journal_lines' AND json_extract(row_json,'$.journal_entry_id')='reverse' AND json_extract(row_json,'$.account_id')='bank'",
  );
  balanced();
  expect(failures()).toEqual(['reversal:lines']);
  reverse('root', 'fork');
  expect(failures()).toContain('reversal:fork');
  entry('cycle1', 'manual', 'cycle1', 'post', 'cycle2');
  entry('cycle2', 'manual', 'cycle2', 'post', 'cycle1');
  expect(failures()).toContain('reversal:chain');
});
it('compares reversal line multisets including duplicate lines without relying on UUID order or memo text', () => {
  entry('root');
  line('root', 'bank', 50, 0);
  line('root', 'bank', 50, 0);
  line('root', 'ar', 0, 100);
  reverse('root', 'reverse');
  balanced();
  expect(failures()).toEqual([]);
  const ids = db
    .prepare(
      "SELECT json_extract(row_json,'$.id') id FROM business_sync_versions WHERE table_name='journal_lines' AND json_extract(row_json,'$.journal_entry_id')='reverse' AND json_extract(row_json,'$.account_id')='bank'",
    )
    .all();
  patch('journal_lines', ids[0].id as string, { credit_cents: 100 });
  db.prepare(
    "DELETE FROM business_sync_versions WHERE table_name='journal_lines' AND json_extract(row_json,'$.id')=?",
  ).run(ids[1].id);
  balanced();
  expect(failures()).toEqual(['reversal:lines']);
});
it('protects automatic postings from using the same account on both sides while allowing manual journals', () => {
  entry('root');
  line('root', 'bank', 100, 0);
  line('root', 'bank', 0, 100);
  balanced();
  expect(failures()).toEqual([]);
  patch('journal_entries', 'root', { source_type: 'automatic' });
  expect(failures()).toEqual(['posting:automatic_sides']);
  patch('journal_entries', 'root', {
    source_type: 'customer_credit_settlement',
  });
  expect(failures()).toEqual([]);
});
it('requires current enabled accounting sources but preserves disabled and closed unposted history', () => {
  record('invoices', 'historical', {
    type: 'standard',
    status: 'emise',
    number: 'F-1',
    issue_date: '2025-12-31',
    currency: 'CHF',
    total_cents: 100,
    vat_cents: 0,
    subtotal_cents: 100,
    discount_cents: 0,
  });
  expect(failures()).toEqual([]);
  patch('accounting_settings', 'accounting', { enabled: 1 });
  expect(failures()).toEqual(['posting:required']);
  record('accounting_periods', 'closed', {
    status: 'closed',
    date_to: '2025-12-31',
  });
  expect(failures()).toEqual([]);
  patch('invoices', 'historical', { issue_date: '2026-01-01' });
  expect(failures()).toEqual(['posting:required']);
});
it('keeps a fully deducted final invoice as evidence without inventing a zero journal posting', () => {
  patch('accounting_settings', 'accounting', { enabled: 1 });
  record('invoices', 'zero', {
    type: 'finale',
    status: 'emise',
    number: 'F-1',
    issue_date: '2026-09-08',
    currency: 'CHF',
    total_cents: 0,
    vat_cents: 0,
    subtotal_cents: 0,
    discount_cents: 0,
  });
  expect(failures()).toEqual(['posting:required']);
  record('quote_invoice_pairs', 'pair', { balance_invoice_id: 'zero' });
  expect(failures()).toEqual([]);
});
it('rejects a source borrowed from another company or transfer even after reversal', () => {
  entry('issue', 'invoice', 'invoice', 'issue');
  line('issue', 'ar', 100, 0, 'Créance client');
  line('issue', 'revenue', 0, 100, 'Produit facturé');
  reverse('issue', 'reverse');
  record('invoices', 'invoice', { total_cents: 100 }, 'other');
  record('invoices', 'invoice', { total_cents: 100 }, 'first', 'other');
  expect(failures()).toEqual(['posting:source']);
});
it('verifies expense and supplier postings and the original supplier liability account', () => {
  record('expenses', 'expense', {
    date: '2026-09-08',
    paid_at: null,
    payment_status: 'paid',
    currency: 'CHF',
    net_cents: 1000,
    vat_cents: 81,
    total_cents: 1081,
  });
  entry('expense-entry', 'expense', 'expense', 'create');
  line('expense-entry', 'expense', 1000, 0, 'Charge');
  line('expense-entry', 'input_vat', 81, 0, 'TVA préalable');
  line('expense-entry', 'bank', 0, 1081, 'Paiement dépense');
  record('supplier_invoices', 'supplier', {
    document_date: '2026-09-08',
    status: 'validated',
    currency: 'CHF',
    net_cents: 1000,
    vat_cents: 81,
    total_cents: 1081,
    validation_journal_entry_id: 'supplier-entry',
  });
  entry('supplier-entry', 'supplier_invoice', 'supplier', 'validate');
  line('supplier-entry', 'expense', 600, 0, 'Marchandise');
  line('supplier-entry', 'expense', 400, 0, 'Transport');
  line('supplier-entry', 'input_vat', 81, 0, 'TVA préalable fournisseur');
  line('supplier-entry', 'payable', 0, 1081, 'Dette fournisseur');
  record('supplier_payments', 'payment', {
    supplier_invoice_id: 'supplier',
    date: '2026-09-08',
    amount_cents: 300,
    journal_entry_id: 'supplier-payment',
  });
  entry('supplier-payment', 'supplier_payment', 'payment', 'invoice:supplier');
  const debit = line(
    'supplier-payment',
    'payable',
    300,
    0,
    'Règlement dette fournisseur',
  );
  line('supplier-payment', 'bank', 0, 300, 'Paiement fournisseur');
  balanced();
  expect(failures()).toEqual([]);
  patch('journal_lines', debit, { account_id: 'salary' });
  balanced();
  expect(failures()).toEqual(['posting:supplier_payment']);
  patch('supplier_invoices', 'supplier', {
    validation_journal_entry_id: 'wrong',
  });
  expect(failures()).toContain('posting:supplier_invoice');
});
it('matches payroll accrual, reimbursements and bank payment without rebuilding historical account mappings', () => {
  record('payslips', 'salary', {
    period: '2026-09',
    status: 'paye',
    gross_cents: 500000,
    net_cents: 460000,
    employer_costs_cents: 60000,
    payment_date: '2026-09-30',
    payment_journal_entry_id: 'salary-payment',
  });
  record('payslip_items', 'reimbursement', {
    payslip_id: 'salary',
    kind: 'reimbursement',
    amount_cents: 10000,
  });
  entry('salary-entry', 'payslip', 'salary', 'post');
  line('salary-entry', 'expense', 500000, 0, 'Salaire brut');
  line('salary-entry', 'expense', 60000, 0, 'Charges employeur');
  line('salary-entry', 'expense', 10000, 0, 'Frais');
  line('salary-entry', 'salary', 0, 460000, 'Salaire net dû');
  line('salary-entry', 'payable', 0, 110000, 'Charges sociales');
  entry('salary-payment', 'payslip', 'salary', 'payment', null, '2026-09-30');
  const paid = line(
    'salary-payment',
    'salary',
    460000,
    0,
    'Extinction salaire net dû · septembre',
  );
  line(
    'salary-payment',
    'bank',
    0,
    460000,
    'Paiement bancaire du salaire · septembre',
  );
  balanced();
  expect(failures()).toEqual([]);
  patch('payslip_items', 'reimbursement', { amount_cents: 10001 });
  expect(failures()).toEqual(['posting:payslip_total']);
  patch('payslip_items', 'reimbursement', { amount_cents: 10000 });
  patch('journal_lines', paid, { account_id: 'payable' });
  balanced();
  expect(failures()).toEqual(['posting:payslip_payment']);
});
it('walks a 65000-entry reversal chain using an indexed parent lookup and detects a disconnected cycle', () => {
  db.exec('BEGIN');
  for (let i = 0; i < 65000; i++)
    entry(
      String(i),
      'manual',
      String(i),
      'post',
      i === 0 ? null : String(i - 1),
    );
  db.exec('COMMIT');
  const rule = postingRules.find((r) => r.id === 'reversal:chain')!;
  expect(db.prepare(rule.sql).get('transfer', 'first')).toBeUndefined();
  const plan = db
    .prepare('EXPLAIN QUERY PLAN ' + rule.sql)
    .all('transfer', 'first')
    .map((r) => r.detail as string);
  expect(
    plan.some(
      (detail) =>
        detail.includes('AUTOMATIC') && detail.includes('reversal_of'),
    ),
  ).toBe(true);
  entry('cycle1', 'manual', 'cycle1', 'post', 'cycle2');
  entry('cycle2', 'manual', 'cycle2', 'post', 'cycle1');
  expect(db.prepare(rule.sql).get('transfer', 'first')).toBeDefined();
});
it('uses indexed journal lookups across a large invoice and payment history and detects its final mismatched posting', () => {
  db.exec('BEGIN');
  for (let i = 0; i < 3000; i++) {
    invoice('invoice-' + i, 8100);
    record('payments', 'payment-' + i, {
      invoice_id: 'invoice-' + i,
      date: '2026-09-08',
      amount_cents: 30000,
    });
    entry(
      'payment-entry-' + i,
      'payment',
      'payment-' + i,
      'invoice:invoice-' + i,
    );
    line('payment-entry-' + i, 'bank', 30000, 0, 'Encaissement');
    line('payment-entry-' + i, 'ar', 0, 30000, 'Règlement créance');
  }
  db.exec('COMMIT');
  const rule = postingRules.find((r) => r.id === 'posting:invoice')!;
  expect(db.prepare(rule.sql).get('transfer', 'first')).toBeUndefined();
  const plan = db
    .prepare('EXPLAIN QUERY PLAN ' + rule.sql)
    .all('transfer', 'first')
    .map((r) => r.detail as string);
  expect(
    plan.some(
      (detail) =>
        detail.includes('AUTOMATIC') && detail.includes('journal_entry_id'),
    ),
  ).toBe(true);
  expect(plan.some((detail) => detail.includes('MATERIALIZE profiles'))).toBe(
    true,
  );
  const paymentRule = postingRules.find((r) => r.id === 'posting:payment')!;
  expect(db.prepare(paymentRule.sql).get('transfer', 'first')).toBeUndefined();
  const paymentPlan = db
    .prepare('EXPLAIN QUERY PLAN ' + paymentRule.sql)
    .all('transfer', 'first')
    .map((r) => r.detail as string);
  expect(
    paymentPlan.some((detail) => detail.includes('MATERIALIZE payments')),
  ).toBe(true);
  patch('payments', 'payment-2999', { amount_cents: 30001 });
  expect(db.prepare(paymentRule.sql).get('transfer', 'first')).toMatchObject({
    __key: 'payment-entry-2999',
  });
  patch('invoices', 'invoice-2999', { total_cents: 108101 });
  expect(db.prepare(rule.sql).get('transfer', 'first')).toMatchObject({
    __key: 'issue-invoice-2999',
  });
});
