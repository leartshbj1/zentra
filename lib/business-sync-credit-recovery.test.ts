import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { creditRecoveryRules } from './business-sync-credit-recovery';
import { sha256Hex } from './account-security';

let db: DatabaseSync;
type Row = Record<string, unknown>;
const transfer = 'transfer',
  organization = 'org';
function put(table: string, id: string, row: Row) {
  db.prepare(
    'INSERT OR REPLACE INTO business_sync_versions VALUES(?,?,?,?,?)',
  ).run(
    transfer,
    organization,
    table,
    JSON.stringify([id]),
    JSON.stringify({ id, ...row }),
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
function patch(table: string, id: string, fields: Row) {
  put(table, id, { ...get(table, id), ...fields });
}
function snapshot(id: string) {
  return {
    entry: get('journal_entries', id),
    lines: db
      .prepare(
        "SELECT row_json FROM business_sync_versions WHERE table_name='journal_lines' AND json_extract(row_json,'$.journal_entry_id')=? ORDER BY row_key_json",
      )
      .all(id)
      .map((row) => JSON.parse(row.row_json as string)),
  };
}
function entry(
  id: string,
  type: string,
  source: string,
  date: string,
  values: [string, number, number, string][],
  event = 'issue',
) {
  put('journal_entries', id, {
    number: id,
    entry_date: date,
    source_type: type,
    source_id: source,
    source_event: event,
    status: 'posted',
    reversal_of: null,
  });
  values.forEach(([account, debit, credit, memo], index) =>
    put('journal_lines', `${id}-${index}`, {
      journal_entry_id: id,
      account_id: account,
      debit_cents: debit,
      credit_cents: credit,
      currency: 'CHF',
      memo,
      project_id: null,
      client_id: 'client',
      employee_id: null,
    }),
  );
}
const deferred = 'TVA à régulariser · contre-prestations reçues';
const release = 'Reclassement TVA à régulariser';
const due = 'TVA due sur encaissement';
function check() {
  return creditRecoveryRules
    .filter((rule) => db.prepare(rule.sql).get(transfer, organization))
    .map((rule) => rule.id);
}
type ProofDocument = {
  source_json: {
    row: Row | string;
    journals: { entry: Row; lines: Row[] }[];
    fallback_due_account?: string;
  };
  snapshot_json: { entry: Row | string; lines: Row[] };
};
function alterProof<Field extends keyof ProofDocument>(
  id: string,
  field: Field,
  alter: (value: ProofDocument[Field]) => void,
) {
  const value = JSON.parse(
    get('customer_credit_recovery_postings', id)[field] as string,
  );
  alter(value);
  patch('customer_credit_recovery_postings', id, {
    [field]: JSON.stringify(value),
  });
}
beforeEach(async () => {
  db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE business_sync_versions(transfer_id TEXT,organization_id TEXT,table_name TEXT,row_key_json TEXT,row_json TEXT,UNIQUE(transfer_id,organization_id,table_name,row_key_json))',
  );
  for (const [id, type] of [
    ['ar', 'asset'],
    ['bank', 'asset'],
    ['revenue', 'revenue'],
    ['pending', 'liability'],
    ['due', 'liability'],
  ])
    put('accounts', id, { account_type: type });
  const shared = {
    status: 'emise',
    currency: 'CHF',
    client_id: 'client',
    project_id: null,
  };
  put('invoices', 'invoice', {
    ...shared,
    type: 'facture',
    number: 'F-1',
    issue_date: '2026-08-01',
    total_cents: 10810,
    vat_cents: 810,
    original_invoice_id: null,
  });
  put('invoices', 'credit', {
    ...shared,
    type: 'avoir',
    number: 'A-1',
    issue_date: '2026-08-15',
    total_cents: -5405,
    vat_cents: -405,
    original_invoice_id: 'invoice',
  });
  put('payments', 'payment', {
    invoice_id: 'invoice',
    date: '2026-09-01',
    amount_cents: 3000,
    created_at: '2026-09-01T12:00:00Z',
  });
  entry('original', 'invoice', 'invoice', '2026-08-01', [
    ['ar', 10810, 0, 'Créance client'],
    ['revenue', 0, 10000, 'Produit facturé'],
    ['pending', 0, 810, deferred],
  ]);
  entry('old-credit', 'invoice', 'credit', '2026-08-15', [
    ['ar', 0, 5405, 'Réduction créance client'],
    ['revenue', 5000, 0, 'Extourne produit'],
    ['pending', 405, 0, 'Extourne TVA à régulariser'],
  ]);
  entry(
    'old-bank',
    'payment',
    'payment',
    '2026-09-01',
    [
      ['bank', 3000, 0, 'Encaissement'],
      ['ar', 0, 3000, 'Règlement créance'],
    ],
    'invoice:invoice',
  );
  entry(
    'old-vat',
    'vat_cash_reclassification',
    'payment',
    '2026-09-01',
    [
      ['pending', 225, 0, release],
      ['due', 0, 225, due],
    ],
    'invoice:invoice',
  );
  entry(
    'correct-credit',
    'customer_credit_recovery',
    'credit-proof',
    '2026-08-15',
    [
      ['pending', 0, 405, 'Rétablissement TVA historique de l’avoir'],
      ['pending', 405, 0, 'TVA de l’avoir en attente de règlement'],
    ],
    'credit',
  );
  entry(
    'correct-payment',
    'customer_credit_recovery',
    'payment-proof',
    '2026-09-01',
    [
      ['pending', 0, 1, release],
      ['due', 1, 0, due],
    ],
    'payment',
  );
  const credit = get('invoices', 'credit');
  delete credit.status;
  delete credit.type;
  put('customer_credit_recovery_postings', 'credit-proof', {
    recovery_id: 'recovery',
    original_invoice_id: 'invoice',
    source_type: 'credit',
    source_id: 'credit',
    date: '2026-08-15',
    source_json: JSON.stringify({
      row: credit,
      journals: [snapshot('old-credit')],
    }),
    parts_json: '[]',
    expected_vat_cents: 405,
    due_change_cents: 0,
    journal_entry_id: 'correct-credit',
    snapshot_json: JSON.stringify(snapshot('correct-credit')),
  });
  put('customer_credit_recovery_postings', 'payment-proof', {
    recovery_id: 'recovery',
    original_invoice_id: 'invoice',
    source_type: 'payment',
    source_id: 'payment',
    date: '2026-09-01',
    source_json: JSON.stringify({
      row: get('payments', 'payment'),
      journals: [snapshot('old-bank'), snapshot('old-vat')],
      fallback_due_account: 'due',
    }),
    parts_json: JSON.stringify([
      { invoice_item_id: 'line', gross_cents: 3000, vat_cents: 224 },
    ]),
    expected_vat_cents: 224,
    due_change_cents: -1,
    journal_entry_id: 'correct-payment',
    snapshot_json: JSON.stringify(snapshot('correct-payment')),
  });
  const history = JSON.stringify({
    documents: [get('invoices', 'invoice'), get('invoices', 'credit')],
    items: [],
    payments: [get('payments', 'payment')],
    journals: ['original', 'old-credit', 'old-bank', 'old-vat'].map(snapshot),
    registered: [],
    settlements: [],
  });
  put('customer_credit_recoveries', 'recovery', {
    request_id: 'request',
    original_invoice_id: 'invoice',
    request_json: JSON.stringify({
      request_id: 'request',
      original_invoice_id: 'invoice',
      source_token: await sha256Hex(history),
      confirm_vat_reconciliation: true,
      no_prior_refund: true,
      credits: [
        {
          credit_note_id: 'credit',
          applied_cents: 2703,
          application_date: '2026-08-20',
        },
      ],
    }),
    source_json: history,
    result_json: '{}',
    created_at: '2026-09-08',
  });
  put('customer_credit_recovery_tax_models', 'model', {
    original_invoice_id: 'invoice',
    recovery_id: 'recovery',
    model: 'received_v1',
  });
});
afterEach(() => db.close());
it('accepts immutable legacy sources and the exact negative one-cent correction', () => {
  expect(check()).toEqual([]);
});
it('rejects a correction and its jointly changed snapshot even when still balanced', () => {
  patch('journal_lines', 'correct-payment-0', { credit_cents: 2 });
  patch('journal_lines', 'correct-payment-1', { debit_cents: 2 });
  patch('customer_credit_recovery_postings', 'payment-proof', {
    snapshot_json: JSON.stringify(snapshot('correct-payment')),
  });
  expect(check()).toContain('credit_recovery:correction_lines');
});
it('requires explicit reconciliation, original identity and the complete proof set', () => {
  const request = JSON.parse(
    get('customer_credit_recoveries', 'recovery').request_json as string,
  );
  request.confirm_vat_reconciliation = false;
  patch('customer_credit_recoveries', 'recovery', {
    request_json: JSON.stringify(request),
  });
  expect(check()).toContain('credit_recovery:request');
  db.prepare(
    "DELETE FROM business_sync_versions WHERE table_name='customer_credit_recovery_postings' AND row_key_json=?",
  ).run(JSON.stringify(['payment-proof']));
  expect(check()).toContain('credit_recovery:history');
  expect(check()).toContain('credit_recovery:correction');
});
it.each(['{}', 'null', '["x",null,5]', 'broken'])(
  'fails closed for malformed source %s',
  (source) => {
    patch('customer_credit_recovery_postings', 'payment-proof', {
      source_json: source,
    });
    expect(check()).toContain('credit_recovery:source');
  },
);
it('protects all saved journal fields and line identities', () => {
  alterProof('credit-proof', 'snapshot_json', (value) => {
    value.lines[0].created_at = 'changed';
  });
  expect(check()).toContain('credit_recovery:snapshot');
});
it('rejects substituted old bank, source rows and reversed historical journals', () => {
  patch('payments', 'payment', { amount_cents: 3001 });
  expect(check()).toContain('credit_recovery:source_row');
  entry('reverse', 'manual', 'x', '2026-09-08', []);
  patch('journal_entries', 'reverse', { reversal_of: 'original' });
  expect(check()).toContain('credit_recovery:snapshot_links');
});
it('preserves historical accounts even when deactivated', () => {
  patch('accounts', 'pending', { active: 0 });
  patch('accounts', 'due', { active: 0 });
  expect(check()).toEqual([]);
});
it('requires a matching recovery tax model for every proof', () => {
  patch('customer_credit_recovery_tax_models', 'model', {
    recovery_id: 'foreign',
  });
  expect(check()).toContain('credit_recovery:model');
  db.exec(
    "DELETE FROM business_sync_versions WHERE table_name='customer_credit_recovery_tax_models'",
  );
  expect(check()).toContain('credit_recovery:model');
});
it('uses the saved liability account for a positive correction without an old VAT journal', () => {
  db.exec(
    "DELETE FROM business_sync_versions WHERE table_name='journal_lines' AND json_extract(row_json,'$.journal_entry_id')='old-vat'; DELETE FROM business_sync_versions WHERE table_name='journal_entries' AND json_extract(row_json,'$.id')='old-vat'",
  );
  alterProof('payment-proof', 'source_json', (value) => {
    value.journals = value.journals.filter(
      (journal) => journal.entry.id !== 'old-vat',
    );
  });
  const history = JSON.parse(
    get('customer_credit_recoveries', 'recovery').source_json as string,
  );
  history.journals = ['original', 'old-credit', 'old-bank'].map(snapshot);
  patch('customer_credit_recoveries', 'recovery', {
    source_json: JSON.stringify(history),
  });
  patch('journal_lines', 'correct-payment-0', {
    debit_cents: 224,
    credit_cents: 0,
  });
  patch('journal_lines', 'correct-payment-1', {
    debit_cents: 0,
    credit_cents: 224,
  });
  patch('customer_credit_recovery_postings', 'payment-proof', {
    due_change_cents: 224,
    snapshot_json: JSON.stringify(snapshot('correct-payment')),
  });
  expect(check()).toEqual([]);
  alterProof('payment-proof', 'source_json', (value) => {
    value.fallback_due_account = 'bank';
  });
  expect(check()).toContain('credit_recovery:payment_basis');
});
it('requires every immutable historical invoice item', () => {
  put('invoice_items', 'historical-item', {
    invoice_id: 'invoice',
    description: 'Ligne historique',
    total_cents: 10810,
  });
  expect(check()).toContain('credit_recovery:history_links');
  const history = JSON.parse(
    get('customer_credit_recoveries', 'recovery').source_json as string,
  );
  history.items = [get('invoice_items', 'historical-item')];
  patch('customer_credit_recoveries', 'recovery', {
    source_json: JSON.stringify(history),
  });
  expect(check()).toEqual([]);
  patch('invoice_items', 'historical-item', {
    description: 'Description remplacée',
  });
  expect(check()).toContain('credit_recovery:history_rows');
});
it('accepts reordered arrays by stable entry and line identity', () => {
  alterProof('payment-proof', 'source_json', (value) => {
    value.journals.reverse();
    value.journals.forEach((j) => j.lines.reverse());
  });
  alterProof('credit-proof', 'snapshot_json', (value) => value.lines.reverse());
  expect(check()).toEqual([]);
});
it('rejects missing or duplicated journal lines and a foreign original', () => {
  alterProof('credit-proof', 'snapshot_json', (value) =>
    value.lines.push(value.lines[0]),
  );
  expect(check()).toContain('credit_recovery:snapshot_shape');
  patch('customer_credit_recovery_postings', 'payment-proof', {
    original_invoice_id: 'foreign',
  });
  expect(check()).toContain('credit_recovery:model');
});
it('requires no correction journal for a zero delta', () => {
  db.exec(
    "DELETE FROM business_sync_versions WHERE table_name='journal_lines' AND json_extract(row_json,'$.journal_entry_id')='correct-payment'; DELETE FROM business_sync_versions WHERE table_name='journal_entries' AND json_extract(row_json,'$.id')='correct-payment'",
  );
  patch('customer_credit_recovery_postings', 'payment-proof', {
    expected_vat_cents: 225,
    due_change_cents: 0,
    journal_entry_id: null,
    snapshot_json: 'null',
  });
  expect(check()).toEqual([]);
  patch('customer_credit_recovery_postings', 'payment-proof', {
    snapshot_json: '{}',
  });
  expect(check()).toContain('credit_recovery:correction');
});
it('rejects a due-account substitution in both the correction and saved snapshot', () => {
  patch('journal_lines', 'correct-payment-1', { account_id: 'pending' });
  patch('customer_credit_recovery_postings', 'payment-proof', {
    snapshot_json: JSON.stringify(snapshot('correct-payment')),
  });
  expect(check()).toContain('credit_recovery:correction_lines');
});
it('detects a one-cent source difference above JavaScript integer precision', () => {
  const rule = creditRecoveryRules.find(
    (r) => r.id === 'credit_recovery:source_row',
  )!;
  db.exec(
    "UPDATE business_sync_versions SET row_json=json_set(row_json,'$.amount_cents',9007199254740993) WHERE table_name='payments'; UPDATE business_sync_versions SET row_json=json_set(row_json,'$.source_json',json_set(json_extract(row_json,'$.source_json'),'$.row.amount_cents',9007199254740993)) WHERE table_name='customer_credit_recovery_postings' AND json_extract(row_json,'$.source_type')='payment'",
  );
  expect(db.prepare(rule.sql).get(transfer, organization)).toBeUndefined();
  db.exec(
    "UPDATE business_sync_versions SET row_json=json_set(row_json,'$.source_json',json_set(json_extract(row_json,'$.source_json'),'$.row.amount_cents',9007199254740992)) WHERE table_name='customer_credit_recovery_postings' AND json_extract(row_json,'$.source_type')='payment'",
  );
  expect(db.prepare(rule.sql).get(transfer, organization)).toBeDefined();
});
it('refuses removed historical journals, changed historical payments and malformed nested objects', () => {
  const history = JSON.parse(
    get('customer_credit_recoveries', 'recovery').source_json as string,
  );
  history.journals.pop();
  history.payments[0].amount_cents++;
  patch('customer_credit_recoveries', 'recovery', {
    source_json: JSON.stringify(history),
  });
  expect(check()).toContain('credit_recovery:history_links');
  expect(check()).toContain('credit_recovery:history_rows');
  alterProof('payment-proof', 'source_json', (value) => {
    value.row = 'bad object';
  });
  alterProof('credit-proof', 'snapshot_json', (value) => {
    value.entry = 'bad entry';
  });
  expect(check()).toContain('credit_recovery:source');
  expect(check()).toContain('credit_recovery:snapshot_shape');
});
