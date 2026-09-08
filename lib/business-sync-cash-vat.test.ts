import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { cashVatRules } from './business-sync-cash-vat';
let db: DatabaseSync;
let counter: number;
const deferred = 'TVA à régulariser · contre-prestations reçues';
const release = 'Reclassement TVA à régulariser';
const due = 'TVA due sur encaissement';
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  counter = 0;
  db.exec(
    'CREATE TABLE business_sync_versions(transfer_id TEXT,organization_id TEXT,table_name TEXT,row_key_json TEXT,row_json TEXT)',
  );
  for (const [id, account_type] of [
    ['ar', 'asset'],
    ['revenue', 'revenue'],
    ['deferred', 'liability'],
    ['due', 'liability'],
    ['other', 'liability'],
  ])
    record('accounts', id, { account_type });
});
afterEach(() => db.close());
function record(
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
    JSON.stringify({ id, ...data }),
  );
}
function patch(table: string, id: string, data: Record<string, unknown>) {
  db.prepare(
    "UPDATE business_sync_versions SET row_json=json_patch(row_json,?) WHERE table_name=? AND json_extract(row_json,'$.id')=?",
  ).run(JSON.stringify(data), table, id);
}
function journal(
  id: string,
  kind: string,
  source: string,
  event: string,
  date = '2026-01-01',
) {
  record('journal_entries', id, {
    number: 'J-' + id,
    source_type: kind,
    source_id: source,
    source_event: event,
    entry_date: date,
    reversal_of: null,
  });
}
function line(
  entry: string,
  account: string,
  debit: number,
  credit: number,
  memo: string,
  currency = 'CHF',
) {
  const id = 'line-' + counter++;
  record('journal_lines', id, {
    journal_entry_id: entry,
    account_id: account,
    debit_cents: debit,
    credit_cents: credit,
    memo,
    currency,
  });
  return id;
}
function invoice(
  id = 'invoice',
  total = 108100,
  vat = 8100,
  hasDeferred = true,
) {
  record('invoices', id, {
    type: 'facture',
    status: 'emise',
    number: 'F-' + id,
    total_cents: total,
    vat_cents: vat,
    currency: 'CHF',
    original_invoice_id: null,
  });
  journal('entry-' + id, 'invoice', id, 'issue');
  line('entry-' + id, 'ar', total, 0, 'Créance client');
  line('entry-' + id, 'revenue', 0, total - vat, 'Produit facturé');
  if (vat)
    line(
      'entry-' + id,
      hasDeferred ? 'deferred' : 'due',
      0,
      vat,
      hasDeferred ? deferred : 'TVA due',
    );
}
function payment(
  id: string,
  amount: number,
  vat: number,
  invoiceId = 'invoice',
  date = '2026-02-01',
) {
  record('payments', id, {
    invoice_id: invoiceId,
    date,
    created_at: date + 'T12:00:00Z',
    amount_cents: amount,
  });
  if (vat) {
    journal(
      'vat-' + id,
      'vat_cash_reclassification',
      id,
      'invoice:' + invoiceId,
      date,
    );
    line('vat-' + id, 'deferred', vat, 0, release);
    line('vat-' + id, 'due', 0, vat, due);
  }
}
function failures() {
  return cashVatRules
    .filter((r) => db.prepare(r.sql).get('transfer', 'first'))
    .map((r) => r.id);
}
function credit(
  id: string,
  total: number,
  vatDeferred: number,
  vatDue = 0,
  date = '2026-02-15',
) {
  record('invoices', id, {
    type: 'avoir',
    status: 'emise',
    number: 'A-' + id,
    total_cents: -total,
    vat_cents: -vatDeferred - vatDue,
    currency: 'CHF',
    original_invoice_id: 'invoice',
  });
  journal('entry-' + id, 'invoice', id, 'issue', date);
  line('entry-' + id, 'ar', 0, total, 'Réduction créance client');
  line(
    'entry-' + id,
    'revenue',
    total - vatDeferred - vatDue,
    0,
    'Extourne produit',
  );
  if (vatDeferred)
    line(
      'entry-' + id,
      'deferred',
      vatDeferred,
      0,
      'Extourne TVA à régulariser',
    );
  if (vatDue)
    line('entry-' + id, 'due', vatDue, 0, 'Extourne TVA due encaissée');
}
it('accepts an unpaid cash-basis invoice and exact successive partial payments', () => {
  invoice();
  expect(failures()).toEqual([]);
  const first = Math.floor((8100 * 33333 + 108100 / 2) / 108100);
  payment('p1', 33333, first);
  expect(failures()).toEqual([]);
  payment('p2', 74767, 8100 - first, 'invoice', '2026-03-01');
  expect(failures()).toEqual([]);
});
it('detects VAT shifted between reporting periods even when the final total is unchanged', () => {
  invoice();
  payment('p1', 33333, 2000);
  payment('p2', 74767, 6100, 'invoice', '2026-03-01');
  expect(failures()).toEqual(['vat_cash:payment_schedule']);
});
it('keeps cent rounding in stable same-day created-at and ID order', () => {
  invoice('invoice', 3, 1);
  payment('first', 1, 0);
  payment('second', 1, 1);
  payment('third', 1, 0);
  expect(failures()).toEqual([]);
  patch('payments', 'first', { created_at: '2026-02-01T13:00:00Z' });
  expect(failures()).toEqual(['vat_cash:payment_schedule']);
});
it('rejects a missing cash posting or a mismatched cumulative tax amount', () => {
  invoice();
  payment('p1', 54050, 0);
  expect(failures()).toEqual([
    'vat_cash:legacy_total',
    'vat_cash:payment_schedule',
  ]);
});
it('checks historic deferred accounts, currency, source date and exact two-line shape', () => {
  invoice();
  payment('p1', 54050, 4050);
  expect(failures()).toEqual([]);
  patch('journal_entries', 'vat-p1', { entry_date: '2026-03-01' });
  expect(failures()).toContain('vat_cash:source');
  patch('journal_entries', 'vat-p1', { entry_date: '2026-02-01' });
  db.exec(
    "UPDATE business_sync_versions SET row_json=json_set(row_json,'$.account_id','other') WHERE table_name='journal_lines' AND json_extract(row_json,'$.memo')='Reclassement TVA à régulariser'",
  );
  expect(failures()).toContain('vat_cash:lines');
  db.exec(
    "UPDATE business_sync_versions SET row_json=json_set(row_json,'$.account_id','deferred','$.currency','EUR') WHERE table_name='journal_lines' AND json_extract(row_json,'$.memo')='Reclassement TVA à régulariser'",
  );
  expect(failures()).toContain('vat_cash:lines');
});
it('refuses a cash posting without a deferred original or an own-company source', () => {
  invoice('invoice', 108100, 8100, false);
  payment('p1', 54050, 4050);
  expect(failures()).toContain('vat_cash:lines');
  db.exec(
    "UPDATE business_sync_versions SET organization_id='another' WHERE table_name='payments'",
  );
  expect(failures()).toContain('vat_cash:source');
});
it('accepts a legacy credit against the unpaid part and checks both VAT credit accounts', () => {
  invoice();
  payment('p1', 54050, 4050);
  credit('credit', 54050, 4050);
  expect(failures()).toEqual([]);
  db.exec(
    "UPDATE business_sync_versions SET row_json=json_set(row_json,'$.debit_cents',4051) WHERE table_name='journal_lines' AND json_extract(row_json,'$.memo')='Extourne TVA à régulariser'",
  );
  expect(failures()).toContain('vat_cash:legacy_total');
});
it('does not apply the legacy formula to dated settlements or an adopted recovery dossier', () => {
  invoice();
  payment('p1', 54050, 1000);
  record('customer_credit_settlements', 'settlement', {
    invoice_id: 'invoice',
  });
  expect(failures()).toEqual([]);
  db.exec(
    "DELETE FROM business_sync_versions WHERE table_name='customer_credit_settlements'",
  );
  record('customer_credit_recovery_tax_models', 'model', {
    original_invoice_id: 'invoice',
  });
  expect(failures()).toEqual([]);
  // Ordinary source, account and currency controls still apply to these dossiers.
  patch('journal_entries', 'vat-p1', { source_event: 'wrong' });
  expect(failures()).toContain('vat_cash:source');
});
it('excludes reversed postings and accepts a restored inverse chain', () => {
  invoice();
  payment('p1', 54050, 4050);
  journal('reverse', 'journal_reversal', 'vat-p1', 'reverse');
  patch('journal_entries', 'reverse', { reversal_of: 'vat-p1' });
  expect(failures()).toEqual([
    'vat_cash:legacy_total',
    'vat_cash:payment_schedule',
  ]);
  journal('restore', 'journal_reversal', 'reverse', 'reverse');
  patch('journal_entries', 'restore', { reversal_of: 'reverse' });
  expect(failures()).toEqual([]);
});
