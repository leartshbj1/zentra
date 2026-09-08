import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
vi.mock('./runtime', () => ({ database: vi.fn(), fileArchive: vi.fn() }));
import {
  issuedQuoteFields,
  transactionTransitionQueries,
} from './business-sync-transaction-transitions';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE business_sync_transaction_validations(transfer_id TEXT PRIMARY KEY,phase TEXT,checked_changes INTEGER,next_change_chunk INTEGER,failed_rule TEXT,failed_change INTEGER,updated_at TEXT);
  INSERT INTO business_sync_transaction_validations VALUES('tx','transitions',0,0,NULL,NULL,'original');
  CREATE TABLE business_sync_transaction_changes(transaction_id TEXT,organization_id TEXT,table_name TEXT,row_key_json TEXT,sequence TEXT,part_index INTEGER,change_index INTEGER);
  CREATE INDEX business_sync_transaction_row_timeline ON business_sync_transaction_changes(transaction_id,table_name,row_key_json,part_index,change_index);
  CREATE TABLE business_sync_versions(transfer_id TEXT,organization_id TEXT,table_name TEXT,row_key_json TEXT,row_json TEXT,UNIQUE(transfer_id,table_name,row_key_json));
  CREATE TABLE business_sync_transaction_document_states(transfer_id TEXT,validator_sha256 TEXT,table_name TEXT,row_key_json TEXT,issued INTEGER,UNIQUE(transfer_id,validator_sha256,table_name,row_key_json));`);
  const q = transactionTransitionQueries('SELECT 1');
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
  const json = (v: Record<string, unknown> | string | null) =>
    typeof v === 'string' || v === null ? v : JSON.stringify(v);
  let index = 0;
  const step = (
    table: string,
    id: string,
    before: Record<string, unknown> | string | null,
    after: Record<string, unknown> | string | null,
  ) => {
    const args = [
      ...common,
      0,
      'source',
      'now',
      index++,
      table,
      JSON.stringify([id]),
      json(before),
      json(after),
      0,
      index - 1,
    ];
    db.prepare(
      'INSERT INTO business_sync_transaction_changes VALUES(?,?,?,?,?,?,?)',
    ).run(
      'tx',
      'org',
      table,
      JSON.stringify([id]),
      String(index),
      0,
      index - 1,
    );
    if (q.reject[table]) db.prepare(q.reject[table]).run(...args);
    if (table === 'invoices' || table === 'quotes')
      db.prepare(q.document).run(...args);
    return db
      .prepare(
        'SELECT phase,failed_rule,failed_change FROM business_sync_transaction_validations',
      )
      .get()!;
  };
  const source = (table: string, id: string, number: string | null) =>
    db
      .prepare('INSERT INTO business_sync_versions VALUES(?,?,?,?,?)')
      .run(
        'source',
        'org',
        table,
        JSON.stringify([id]),
        JSON.stringify({ id, number }),
      );
  return { db, step, source, common, queries: q };
}
it('seeks earlier parent changes by position instead of scanning thousands of later changes', () => {
  const f = fixture();
  try {
    f.source('invoices', 'doc', null);
    f.db.exec('BEGIN');
    const insert = f.db.prepare(
      'INSERT INTO business_sync_transaction_changes VALUES(?,?,?,?,?,?,?)',
    );
    for (let i = 0; i < 10000; i++)
      insert.run(
        'tx',
        'org',
        'invoices',
        '["doc"]',
        String(i + 100),
        50 + Math.floor(i / 200),
        i % 200,
      );
    f.db.exec('COMMIT');
    const line = JSON.stringify({ id: 'line', invoice_id: 'doc' });
    const plan = f.db
      .prepare('EXPLAIN QUERY PLAN ' + f.queries.reject.invoice_items)
      .all(
        ...f.common,
        0,
        'source',
        'now',
        0,
        'invoice_items',
        '["line"]',
        null,
        line,
        0,
        0,
      );
    expect(
      plan.some(
        (row) =>
          String(row.detail).includes(
            'business_sync_transaction_row_timeline',
          ) && String(row.detail).includes('(part_index,change_index)<'),
      ),
    ).toBe(true);
    expect(f.step('invoice_items', 'line', null, line).phase).toBe(
      'transitions',
    );
  } finally {
    f.db.close();
  }
});
it('matches the latest native frozen quote fields', () => {
  const native = readFileSync(
    new URL('../desktop/src-tauri/src/schema.rs', import.meta.url),
    'utf8',
  );
  const blocks = [
    ...native.matchAll(
      /CREATE TRIGGER(?: IF NOT EXISTS)? quotes_issued_financial_no_update[\s\S]*?END;/g,
    ),
  ];
  expect(blocks.length).toBeGreaterThan(0);
  const fields = [
    ...blocks.at(-1)![0].matchAll(/NEW\.(\w+) IS NOT OLD\.\1/g),
  ].map((m) => m[1]);
  expect([...issuedQuoteFields].sort()).toEqual(fields.sort());
});
it.each(['invoices', 'quotes'])(
  'freezes %s from the moment it is issued and preserves legitimate status changes',
  (table) => {
    const f = fixture();
    try {
      const draft = {
        id: 'doc',
        number: null,
        title: 'Avant',
        status: 'brouillon',
      };
      const edited = { ...draft, title: 'Conditions\nAcompte 30 %' };
      const issued = { ...edited, number: 'F-2026-1', status: 'emise' };
      expect(f.step(table, 'doc', null, draft).phase).toBe('transitions');
      expect(f.step(table, 'doc', draft, edited).phase).toBe('transitions');
      expect(f.step(table, 'doc', edited, issued).phase).toBe('transitions');
      expect(
        f.step(table, 'doc', issued, { ...issued, status: 'payee' }).phase,
      ).toBe('transitions');
      expect(
        f.step(table, 'doc', issued, { ...issued, title: 'Réécriture' }),
      ).toMatchObject({
        phase: 'invalid',
        failed_rule: `transition:issued-${table}`,
        failed_change: 4,
      });
      // A later restoration cannot erase the first forbidden transition.
      expect(
        f.step(table, 'doc', { ...issued, title: 'Réécriture' }, issued)
          .failed_change,
      ).toBe(4);
    } finally {
      f.db.close();
    }
  },
);
it.each(['invoices', 'quotes'])(
  'rejects deleting an issued %s even when it was absent from the source',
  (table) => {
    const f = fixture();
    try {
      const issued = { id: 'doc', number: '1' };
      f.step(table, 'doc', null, issued);
      expect(f.step(table, 'doc', issued, null).phase).toBe('invalid');
    } finally {
      f.db.close();
    }
  },
);
it.each([
  ['invoices', 'invoice_items', 'invoice_id'],
  ['quotes', 'quote_items', 'quote_id'],
])(
  'permits draft %s lines then refuses their insertion and rewriting after issue',
  (table, items, key) => {
    for (const operation of ['insert', 'update', 'delete']) {
      const f = fixture();
      try {
        const draft = { id: 'doc', number: null },
          issued = { ...draft, number: '1' },
          line = { id: 'line', [key]: 'doc', description: 'Ligne' };
        f.step(table, 'doc', null, draft);
        expect(f.step(items, 'line', null, line).phase).toBe('transitions');
        f.step(table, 'doc', draft, issued);
        const status = f.step(
          items,
          operation === 'insert' ? 'extra' : 'line',
          operation === 'insert' ? null : line,
          operation === 'delete' ? null : { ...line, description: 'Modifiée' },
        );
        expect(status).toMatchObject({
          phase: 'invalid',
          failed_rule: `transition:issued-${items.replaceAll('_', '-')}`,
        });
      } finally {
        f.db.close();
      }
    }
  },
);
it('uses an unchanged source parent without copying its whole document and keeps new draft parents distinct', () => {
  const f = fixture();
  try {
    f.source('invoices', 'old', 'F-1');
    f.step('invoices', 'new', null, { id: 'new', number: null });
    expect(
      f.step('invoice_items', 'draft-line', null, {
        id: 'draft-line',
        invoice_id: 'new',
      }).phase,
    ).toBe('transitions');
    expect(
      f.step('invoice_items', 'forbidden', null, {
        id: 'forbidden',
        invoice_id: 'old',
      }).phase,
    ).toBe('invalid');
    expect(
      f.db
        .prepare(
          'SELECT COUNT(*) n FROM business_sync_transaction_document_states',
        )
        .get(),
    ).toEqual({ n: 1 });
  } finally {
    f.db.close();
  }
});
it('permits the native QR freeze before issuance and refuses unfreezing or deleting it afterward', () => {
  for (const operation of ['update', 'delete']) {
    const f = fixture();
    try {
      const draft = { id: 'doc', number: null },
        qr = { invoice_id: 'doc', frozen_at: null },
        frozen = { ...qr, frozen_at: '2026-09-08' };
      f.step('invoices', 'doc', null, draft);
      expect(f.step('invoice_qr_bills', 'doc', null, qr).phase).toBe(
        'transitions',
      );
      expect(f.step('invoice_qr_bills', 'doc', qr, frozen).phase).toBe(
        'transitions',
      );
      f.step('invoices', 'doc', draft, { ...draft, number: 'F-1' });
      expect(
        f.step(
          'invoice_qr_bills',
          'doc',
          frozen,
          operation === 'delete' ? null : qr,
        ),
      ).toMatchObject({
        phase: 'invalid',
        failed_rule: 'transition:frozen-qr-bills',
      });
    } finally {
      f.db.close();
    }
  }
});
it('protects an issued parent QR even if its frozen_at is absent', () => {
  const f = fixture();
  try {
    f.source('invoices', 'doc', 'F-1');
    expect(
      f.step(
        'invoice_qr_bills',
        'doc',
        { invoice_id: 'doc', frozen_at: null },
        { invoice_id: 'doc', frozen_at: 'now' },
      ).phase,
    ).toBe('invalid');
  } finally {
    f.db.close();
  }
});
it('refuses to reuse an old draft when an intermediate parent state is missing', () => {
  const f = fixture();
  try {
    f.source('invoices', 'doc', null);
    f.step(
      'invoices',
      'doc',
      { id: 'doc', number: null },
      { id: 'doc', number: 'F-1' },
    );
    f.db.exec('DELETE FROM business_sync_transaction_document_states');
    expect(
      f.step('invoice_items', 'line', null, { id: 'line', invoice_id: 'doc' }),
    ).toMatchObject({
      phase: 'invalid',
      failed_rule: 'transition:issued-invoice-items',
    });
  } finally {
    f.db.close();
  }
});
it.each(['9007199254740993', '9223372036854775807'])(
  'compares frozen cents exactly at %s',
  (value) => {
    const f = fixture();
    try {
      const before = `{"id":"doc","number":"F-1","total_cents":${value}}`;
      const after = `{"id":"doc","number":"F-1","total_cents":${BigInt(value) - BigInt(1)}}`;
      expect(f.step('invoices', 'doc', before, after).phase).toBe('invalid');
    } finally {
      f.db.close();
    }
  },
);
