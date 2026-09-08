import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { creditSettlementRules as rules } from './business-sync-credit-settlements';
let db: DatabaseSync;
let serial: number;
type Row = Record<string, unknown>;
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  serial = 0;
  db.exec(
    'CREATE TABLE business_sync_versions(transfer_id TEXT,organization_id TEXT,table_name TEXT,row_key_json TEXT,row_json TEXT)',
  );
  for (const [id, account_type] of [
    ['ar', 'asset'],
    ['bank', 'asset'],
    ['other-ar', 'asset'],
    ['revenue', 'revenue'],
    ['deferred', 'liability'],
    ['due', 'liability'],
  ])
    insert('accounts', id, { account_type, active: 0 });
  insert('accounting_settings', 'settings', { enabled: 1 });
});
afterEach(() => db.close());
function insert(table: string, id: string, row: Row, org = 'first') {
  db.prepare('INSERT INTO business_sync_versions VALUES(?,?,?,?,?)').run(
    'transfer',
    org,
    table,
    JSON.stringify([id]),
    JSON.stringify({ id, ...row }),
  );
}
function all(table: string): Row[] {
  return db
    .prepare('SELECT row_json FROM business_sync_versions WHERE table_name=?')
    .all(table)
    .map((r) => JSON.parse(r.row_json as string));
}
function patch(table: string, id: string, changes: Row) {
  db.prepare(
    "UPDATE business_sync_versions SET row_json=json_patch(row_json,?) WHERE table_name=? AND json_extract(row_json,'$.id')=?",
  ).run(JSON.stringify(changes), table, id);
}
function remove(table: string, id?: string) {
  db.prepare(
    "DELETE FROM business_sync_versions WHERE table_name=? AND (? IS NULL OR json_extract(row_json,'$.id')=?)",
  ).run(table, id ?? null, id ?? null);
}
function check(id?: string) {
  const selected = id ? rules.filter((r) => r.id === id) : rules;
  expect(selected.length).toBeGreaterThan(0);
  for (const rule of selected) {
    if (db.prepare(rule.sql).get('transfer', 'first')) return rule.id;
  }
  return null;
}
function entry(
  id: string,
  source_type: string,
  source_id: string,
  source_event: string,
  date: string,
) {
  insert('journal_entries', id, {
    number: 'J-' + id,
    entry_date: date,
    description: 'Pièce de contrôle',
    status: 'posted',
    source_type,
    source_id,
    source_event,
    reversal_of: null,
  });
}
function line(
  journal: string,
  account: string,
  amount: number,
  memo: string,
  project: string | null = null,
) {
  const id = 'line-' + journal + '-' + serial++;
  insert('journal_lines', id, {
    journal_entry_id: journal,
    account_id: account,
    debit_cents: Math.max(amount, 0),
    credit_cents: Math.max(-amount, 0),
    memo,
    currency: 'CHF',
    client_id: 'client',
    project_id: project,
    employee_id: null,
  });
  return id;
}
function documents() {
  for (const [id, type, total, date] of [
    ['invoice', 'facture', 10000, '2026-02-01'],
    ['credit', 'avoir', -5000, '2026-03-01'],
  ] as const) {
    insert('invoices', id, {
      type,
      number: 'F-' + id,
      status: 'emise',
      issue_date: date,
      client_id: 'client',
      project_id: null,
      currency: 'CHF',
      total_cents: total,
      vat_cents: 0,
      original_invoice_id: id === 'credit' ? 'invoice' : null,
    });
    insert('invoice_items', 'item-' + id, {
      invoice_id: id,
      position: 0,
      line_total_cents: total,
      line_vat_cents: 0,
    });
    entry('entry-' + id, 'invoice', id, 'issue', date);
    line(
      'entry-' + id,
      'ar',
      total,
      type === 'avoir' ? 'Réduction créance client' : 'Créance client',
    );
    line(
      'entry-' + id,
      'revenue',
      -total,
      type === 'avoir' ? 'Extourne produit' : 'Produit facturé',
    );
  }
  insert('customer_credit_documents', 'registry', {
    credit_note_id: 'credit',
    model: 'dated_v1',
  });
}
function proof(id: string) {
  const snapshot = {
    entry: all('journal_entries').find((r) => r.id === 'posting-' + id),
    lines: all('journal_lines').filter(
      (r) => r.journal_entry_id === 'posting-' + id,
    ),
  };
  const existing = all('customer_credit_settlement_postings').some(
    (r) => r.id === 'proof-' + id,
  );
  const data = {
    settlement_id: id,
    journal_entry_id: 'posting-' + id,
    snapshot_json: JSON.stringify(snapshot),
  };
  if (existing)
    patch('customer_credit_settlement_postings', 'proof-' + id, data);
  else insert('customer_credit_settlement_postings', 'proof-' + id, data);
}
function settlement(
  id: string,
  amount = 5000,
  kind = 'apply',
  reverses: string | null = null,
  date = '2026-03-01',
  sequence = 1,
) {
  const refund = kind.endsWith('refund');
  const reference = reverses
    ? String(
        all('customer_credit_settlements').find((r) => r.id === reverses)!
          .reference,
      )
    : 'REF-' + id;
  const input = {
    request_id: 'request-' + id,
    credit_note_id: 'credit',
    event_type: kind,
    invoice_id: refund ? null : 'invoice',
    date,
    amount_cents: amount,
    bank_account_id: refund ? 'bank' : null,
    reference,
    reason: 'Règlement de contrôle',
  };
  const payload = reverses
    ? {
        operation: 'reverse',
        input: {
          request_id: input.request_id,
          settlement_id: reverses,
          date,
          reason: input.reason,
        },
      }
    : { operation: 'record', input };
  insert('customer_credit_settlements', id, {
    ...input,
    sequence,
    created_at: date + 'T12:00:00Z',
    reverses_id: reverses,
    request_json: JSON.stringify(payload),
  });
  const sign = reverses ? -1 : 1;
  for (const side of refund ? ['credit'] : ['credit', 'invoice'])
    insert('customer_credit_settlement_lines', id + '-' + side, {
      settlement_id: id,
      side,
      invoice_item_id: 'item-' + side,
      gross_cents: amount * sign,
      vat_cents: 0,
    });
  entry('posting-' + id, 'customer_credit_settlement', id, kind, date);
  line('posting-' + id, 'ar', amount * sign, 'Règlement de l’avoir client');
  line(
    'posting-' + id,
    refund ? 'bank' : 'ar',
    -amount * sign,
    refund ? 'Remboursement au client' : 'Imputation sur facture client',
  );
  proof(id);
}
it('accepts an empty ledger and an application, reversal, refund and reapplication', () => {
  expect(check()).toBeNull();
  documents();
  settlement('first');
  settlement('reverse', 5000, 'reverse_apply', 'first', '2026-03-02', 2);
  settlement('refund', 2000, 'refund', null, '2026-03-03', 3);
  settlement('again', 3000, 'apply', null, '2026-03-04', 4);
  expect(check()).toBeNull();
});
it.each([
  ['client_id', 'another-client'],
  ['currency', 'EUR'],
  ['status', 'annulee'],
  ['issue_date', '2026-04-01'],
])('rejects another or invalid target invoice (%s)', (field, value) => {
  documents();
  settlement('first');
  patch('invoices', 'invoice', { [field]: value });
  expect(check()).toBe('credit_settlements:source');
});
it('requires issued registered credit notes and a real calendar date', () => {
  documents();
  settlement('first');
  patch('invoices', 'credit', { type: 'facture' });
  expect(check()).toBe('credit_documents:source');
  patch('invoices', 'credit', { type: 'avoir' });
  patch('customer_credit_settlements', 'first', { date: '2026-02-30' });
  expect(check()).toBe('credit_settlements:source');
});
it('rejects a request payload which no longer describes the stored money', () => {
  documents();
  settlement('first');
  const row = all('customer_credit_settlements')[0];
  const payload = JSON.parse(row.request_json as string);
  payload.input.amount_cents = 4999;
  patch('customer_credit_settlements', 'first', {
    request_json: JSON.stringify(payload),
  });
  expect(check()).toBe('credit_settlements:request');
});
it('does not coerce monetary strings in immutable request payloads', () => {
  documents();
  settlement('first');
  const payload = JSON.parse(
    all('customer_credit_settlements')[0].request_json as string,
  );
  payload.input.amount_cents = '5000';
  patch('customer_credit_settlements', 'first', {
    request_json: JSON.stringify(payload),
  });
  expect(check()).toBe('credit_settlements:request');
});
it('does not borrow the target invoice from another enterprise', () => {
  documents();
  settlement('first');
  db.exec(
    "UPDATE business_sync_versions SET organization_id='another-enterprise' WHERE table_name='invoices' AND json_extract(row_json,'$.id')='invoice'",
  );
  expect(check()).toBe('credit_settlements:source');
});

it('validates 6000 complete settlement proofs and detects a damaged final proof', () => {
  documents();
  settlement('first', 1);
  const templates = db
    .prepare(
      "SELECT table_name,row_json FROM business_sync_versions WHERE table_name LIKE 'customer_credit_settlement%' OR (table_name='journal_entries' AND json_extract(row_json,'$.source_type')='customer_credit_settlement') OR (table_name='journal_lines' AND json_extract(row_json,'$.journal_entry_id')='posting-first')",
    )
    .all() as { table_name: string; row_json: string }[];
  for (const row of templates)
    remove(row.table_name, JSON.parse(row.row_json).id);
  patch('invoices', 'credit', { total_cents: -6000 });
  patch('invoice_items', 'item-credit', { line_total_cents: -6000 });
  for (const row of all('journal_lines').filter(
    (r) => r.journal_entry_id === 'entry-credit',
  ))
    patch('journal_lines', String(row.id), {
      debit_cents: row.debit_cents ? 6000 : 0,
      credit_cents: row.credit_cents ? 6000 : 0,
    });
  db.exec('BEGIN');
  for (let n = 0; n < 6000; n++)
    for (const template of templates) {
      const row = JSON.parse(
        template.row_json.replaceAll(
          'first',
          'scale-' + String(n).padStart(4, '0'),
        ),
      );
      if (template.table_name === 'customer_credit_settlements')
        row.sequence = n + 1;
      insert(template.table_name, row.id, row);
    }
  db.exec('COMMIT');
  expect(check()).toBeNull();
  const row = all('customer_credit_settlement_postings').find(
    (r) => r.id === 'proof-scale-5999',
  )!;
  const saved = JSON.parse(row.snapshot_json as string);
  saved.entry.description = 'Corruption dans la dernière preuve';
  patch('customer_credit_settlement_postings', String(row.id), {
    snapshot_json: JSON.stringify(saved),
  });
  expect(check('credit_settlements:proof_snapshot')).toBe(
    'credit_settlements:proof_snapshot',
  );
}, 15000);
it('requires a reversal of the same original with its original cents and chronology', () => {
  documents();
  settlement('first', 2000);
  settlement('reverse', 2000, 'reverse_apply', 'first', '2026-03-02', 2);
  patch('customer_credit_settlements', 'reverse', { sequence: 1 });
  expect(check()).toBe('credit_settlements:reversal');
  patch('customer_credit_settlements', 'reverse', { sequence: 2 });
  patch('customer_credit_settlement_lines', 'reverse-credit', {
    vat_cents: -1,
  });
  expect(check('credit_settlements:reversal_parts')).toBe(
    'credit_settlements:reversal_parts',
  );
});
it('requires every document line, including zero allocations, and the exact document side', () => {
  documents();
  settlement('first');
  remove('customer_credit_settlement_lines', 'first-invoice');
  expect(check()).toBe('credit_settlements:line_source');
  insert('customer_credit_settlement_lines', 'first-invoice', {
    settlement_id: 'first',
    side: 'invoice',
    invoice_item_id: 'item-credit',
    gross_cents: 5000,
    vat_cents: 0,
  });
  expect(check()).toBe('credit_settlements:line_source');
});
it('detects a missing cent in a split even when it is below every individual bound', () => {
  documents();
  settlement('first');
  patch('customer_credit_settlement_lines', 'first-credit', {
    gross_cents: 4999,
  });
  expect(check()).toBe('credit_settlements:line_totals');
});
it('rejects spending an unavailable credit even when a later reversal repairs the final balance', () => {
  documents();
  settlement('first', 4000);
  settlement('second', 4000, 'refund', null, '2026-03-02', 2);
  settlement('reverse', 4000, 'reverse_apply', 'first', '2026-03-03', 3);
  expect(check()).toBe('credit_settlements:chronology');
});
it('includes payments in the target invoice timeline and stable same-date ordering', () => {
  documents();
  settlement('first', 4000);
  settlement('reverse', 4000, 'reverse_apply', 'first', '2026-03-02', 2);
  insert('payments', 'payment', {
    invoice_id: 'invoice',
    date: '2026-03-01',
    created_at: '2026-03-01T13:00:00Z',
    amount_cents: 7000,
  });
  expect(check()).toBe('credit_settlements:chronology');
  patch('payments', 'payment', {
    date: '2026-03-02',
    created_at: '2026-03-02T13:00:00Z',
  });
  expect(check()).toBeNull();
});
it('checks prefix balances beyond int64 without overflowing before a later cancellation', () => {
  documents();
  db.prepare(
    "UPDATE business_sync_versions SET row_json=json_set(row_json,'$.total_cents',-9223372036854775807) WHERE table_name='invoices' AND json_extract(row_json,'$.id')='credit'",
  ).run();
  for (let n = 0; n < 1100; n++) {
    insert('customer_credit_settlements', 'application-' + n, {
      credit_note_id: 'credit',
      invoice_id: null,
      event_type: 'refund',
      date: '2026-03-01',
      created_at: 'same',
      sequence: n + 1,
      amount_cents: 9000000000000000,
    });
    insert('customer_credit_settlements', 'reversal-' + n, {
      credit_note_id: 'credit',
      invoice_id: null,
      event_type: 'reverse_refund',
      date: '2026-03-02',
      created_at: 'same',
      sequence: n + 1101,
      amount_cents: 9000000000000000,
    });
  }
  expect(check('credit_settlements:chronology')).toBe(
    'credit_settlements:chronology',
  );
});
it('refuses unregistered legacy credits on a document with a dated application', () => {
  documents();
  settlement('first', 2000);
  insert('invoices', 'legacy', {
    type: 'avoir',
    number: 'AV-legacy',
    status: 'emise',
    total_cents: -1000,
    original_invoice_id: 'invoice',
  });
  expect(check()).toBe('credit_settlements:source');
});
it('compares complete proof objects without depending on key or line array ordering', () => {
  documents();
  settlement('first');
  const saved = JSON.parse(
    all('customer_credit_settlement_postings')[0].snapshot_json as string,
  );
  saved.lines.reverse();
  saved.entry = Object.fromEntries(Object.entries(saved.entry).reverse());
  patch('customer_credit_settlement_postings', 'proof-first', {
    snapshot_json: JSON.stringify(saved),
  });
  expect(check()).toBeNull();
  saved.entry.description = 'A different description';
  patch('customer_credit_settlement_postings', 'proof-first', {
    snapshot_json: JSON.stringify(saved),
  });
  expect(check()).toBe('credit_settlements:proof_snapshot');
});
it('rejects malformed, duplicated and extended journal proof content', () => {
  documents();
  settlement('first');
  const original = JSON.parse(
    all('customer_credit_settlement_postings')[0].snapshot_json as string,
  );
  for (const saved of [
    null,
    { ...original, extra: true },
    { ...original, lines: [...original.lines, original.lines[0]] },
  ]) {
    patch('customer_credit_settlement_postings', 'proof-first', {
      snapshot_json: JSON.stringify(saved),
    });
    expect(check()).toMatch(/^credit_settlements:proof_/);
  }
});
it('detects a one-cent proof mismatch above JavaScript integer precision', () => {
  documents();
  settlement('first');
  db.exec(
    "UPDATE business_sync_versions SET row_json=json_set(row_json,'$.debit_cents',9007199254740993) WHERE table_name='journal_lines' AND json_extract(row_json,'$.journal_entry_id')='posting-first' AND json_extract(row_json,'$.debit_cents')>0",
  );
  db.exec(
    "UPDATE business_sync_versions SET row_json=json_set(row_json,'$.snapshot_json',json_set(json_extract(row_json,'$.snapshot_json'),'$.lines[0].debit_cents',9007199254740993)) WHERE table_name='customer_credit_settlement_postings'",
  );
  expect(check('credit_settlements:proof_snapshot')).toBeNull();
  db.exec(
    "UPDATE business_sync_versions SET row_json=json_set(row_json,'$.snapshot_json',json_set(json_extract(row_json,'$.snapshot_json'),'$.lines[0].debit_cents',9007199254740992)) WHERE table_name='customer_credit_settlement_postings'",
  );
  expect(check('credit_settlements:proof_snapshot')).toBe(
    'credit_settlements:proof_snapshot',
  );
});
it('rejects a changed historical account even after a forged snapshot is updated to match', () => {
  documents();
  settlement('first');
  const target = all('journal_lines').find(
    (r) => r.journal_entry_id === 'posting-first' && r.debit_cents === 5000,
  )!;
  patch('journal_lines', String(target.id), { account_id: 'other-ar' });
  proof('first');
  expect(check()).toBe('credit_settlements:posting_lines');
});
it('refuses generic reversal of a protected settlement journal, including a restored reversal', () => {
  documents();
  settlement('first');
  entry('reverse', 'reversal', 'posting-first', 'reverse', '2026-03-02');
  patch('journal_entries', 'reverse', { reversal_of: 'posting-first' });
  entry('restore', 'reversal', 'reverse', 'reverse', '2026-03-03');
  patch('journal_entries', 'restore', { reversal_of: 'reverse' });
  expect(check()).toBe('credit_settlements:posting_source');
});
it('preserves missing postings from disabled accounting or closed history but detects unlinked journals', () => {
  documents();
  settlement('first');
  remove('customer_credit_settlement_postings');
  expect(check()).toBe('credit_settlements:posting_source');
  remove('journal_entries', 'posting-first');
  expect(check()).toBe('credit_settlements:posting_required');
  patch('accounting_settings', 'settings', { enabled: 0 });
  expect(check()).toBeNull();
  patch('accounting_settings', 'settings', { enabled: 1 });
  insert('accounting_periods', 'closed', {
    status: 'closed',
    date_to: '2026-03-31',
  });
  expect(check()).toBeNull();
});
