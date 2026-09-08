import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { transactionClosureRules } from './business-sync-transaction-closure';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE business_sync_versions(transfer_id TEXT,organization_id TEXT,table_name TEXT,row_key_json TEXT,row_json TEXT,row_sha256 TEXT); CREATE UNIQUE INDEX rows_identity ON business_sync_versions(transfer_id,table_name,row_key_json)',
  );
  const put = (
    transfer: string,
    table: string,
    id: string,
    value: Record<string, unknown>,
  ) => {
    const raw = JSON.stringify({ id, ...value });
    db.prepare(
      'INSERT OR REPLACE INTO business_sync_versions VALUES(?,?,?,?,?,?)',
    ).run(transfer, 'org', table, JSON.stringify([id]), raw, raw);
  };
  const both = (table: string, id: string, value: Record<string, unknown>) => {
    put('source', table, id, value);
    put('candidate', table, id, value);
  };
  both('accounting_periods', 'closed', {
    date_from: '2025-10-01',
    date_to: '2025-12-31',
    status: 'closed',
  });
  const invalid = (id: string) => {
    const rule = transactionClosureRules.find((r) => r.id === id)!;
    return (
      db
        .prepare(rule.sql)
        .get('candidate', 'org', ...(rule.source ? ['source'] : [])) !==
      undefined
    );
  };
  return { db, put, both, invalid };
}
it('accepts an unchanged closed history and compiles every closure rule', () => {
  const f = fixture();
  try {
    for (const rule of transactionClosureRules)
      expect(f.invalid(rule.id), rule.id).toBe(false);
  } finally {
    f.db.close();
  }
});
it('checks many adjacent periods and detects an overlap at the end of the history', () => {
  const f = fixture();
  try {
    f.db.exec('BEGIN');
    for (let i = 0; i < 5000; i++) {
      const date = new Date(Date.UTC(2026, 0, 1 + i))
        .toISOString()
        .slice(0, 10);
      f.put('candidate', 'accounting_periods', `period-${i}`, {
        date_from: date,
        date_to: date,
        status: 'open',
      });
    }
    f.db.exec('COMMIT');
    expect(f.invalid('closed:period-dates')).toBe(false);
    const end = new Date(Date.UTC(2026, 0, 5000)).toISOString().slice(0, 10);
    f.put('candidate', 'accounting_periods', 'overlap', {
      date_from: end,
      date_to: end,
      status: 'open',
    });
    expect(f.invalid('closed:period-dates')).toBe(true);
  } finally {
    f.db.close();
  }
});
it.each([
  ['2025-02-01', true],
  ['2025-12-31', true],
  ['2026-01-01', false],
  ['2026-02-30', true],
  ['2026-2-01', true],
])(
  'checks cumulative closure and canonical journal date %s',
  (entry_date, expected) => {
    const f = fixture();
    try {
      f.put('candidate', 'journal_entries', 'new', { entry_date });
      expect(f.invalid('closed:journal-dates')).toBe(expected);
    } finally {
      f.db.close();
    }
  },
);
it('preserves historical entries but refuses new lines on their closed dates', () => {
  const f = fixture();
  try {
    f.both('journal_entries', 'old', { entry_date: '2025-02-01' });
    f.both('journal_lines', 'old-line', { journal_entry_id: 'old' });
    expect(f.invalid('closed:journal-dates')).toBe(false);
    expect(f.invalid('closed:journal-lines')).toBe(false);
    f.put('candidate', 'journal_lines', 'extra', { journal_entry_id: 'old' });
    expect(f.invalid('closed:journal-lines')).toBe(true);
  } finally {
    f.db.close();
  }
});
it('uses the original cutoff when a transaction closes a new year after its final entries', () => {
  const f = fixture();
  try {
    f.both('accounting_periods', 'next', {
      date_from: '2026-01-01',
      date_to: '2026-12-31',
      status: 'open',
    });
    f.put('candidate', 'journal_entries', 'closing', {
      entry_date: '2026-12-31',
    });
    f.put('candidate', 'accounting_periods', 'next', {
      date_from: '2026-01-01',
      date_to: '2026-12-31',
      status: 'closed',
    });
    expect(f.invalid('closed:period-history')).toBe(false);
    expect(f.invalid('closed:journal-dates')).toBe(false);
    expect(f.invalid('closed:period-dates')).toBe(false);
  } finally {
    f.db.close();
  }
});
it('refuses reopening or deleting a closed period, overlapping periods and invalid period dates', () => {
  const f = fixture();
  try {
    f.put('candidate', 'accounting_periods', 'closed', {
      date_from: '2025-10-01',
      date_to: '2025-12-31',
      status: 'open',
    });
    expect(f.invalid('closed:period-history')).toBe(true);
    f.db.exec(
      "DELETE FROM business_sync_versions WHERE transfer_id='candidate'",
    );
    expect(f.invalid('closed:period-history')).toBe(true);
    f.put('candidate', 'accounting_periods', 'a', {
      date_from: '2026-01-01',
      date_to: '2026-03-31',
      status: 'open',
    });
    f.put('candidate', 'accounting_periods', 'b', {
      date_from: '2026-03-31',
      date_to: '2026-06-30',
      status: 'open',
    });
    expect(f.invalid('closed:period-dates')).toBe(true);
    f.put('candidate', 'accounting_periods', 'b', {
      date_from: '2026-04-31',
      date_to: '2026-06-30',
      status: 'open',
    });
    expect(f.invalid('closed:period-dates')).toBe(true);
  } finally {
    f.db.close();
  }
});
it('allows later payment of historical invoices but refuses new backdated invoice issuance and payments', () => {
  const f = fixture();
  try {
    f.both('invoices', 'old', { number: 'F-2025-1', issue_date: '2025-05-01' });
    f.both('invoices', 'draft', { number: null, issue_date: '2025-05-01' });
    f.put('candidate', 'payments', 'paid-now', {
      invoice_id: 'old',
      date: '2026-01-05',
    });
    expect(f.invalid('closed:invoice-issuance')).toBe(false);
    expect(f.invalid('closed:payment-dates')).toBe(false);
    f.put('candidate', 'invoices', 'draft', {
      number: 'F-2025-2',
      issue_date: '2025-05-01',
    });
    expect(f.invalid('closed:invoice-issuance')).toBe(true);
    f.put('candidate', 'payments', 'paid-before', {
      invoice_id: 'old',
      date: '2025-12-31',
    });
    expect(f.invalid('closed:payment-dates')).toBe(true);
  } finally {
    f.db.close();
  }
});
it('keeps old expense fiscal fields fixed while allowing a first payment after the closed date', () => {
  const f = fixture();
  const before = {
    date: '2025-02-01',
    supplier: 'Fournisseur',
    net_cents: 10000,
    vat_cents: 810,
    total_cents: 10810,
    payment_status: 'pending',
    paid_at: null,
  };
  try {
    f.both('expenses', 'expense', before);
    f.put('candidate', 'expenses', 'expense', {
      ...before,
      note: 'Note interne',
    });
    expect(f.invalid('closed:expense-history')).toBe(false);
    f.put('candidate', 'expenses', 'expense', {
      ...before,
      payment_status: 'paid',
      paid_at: '2026-02-01',
    });
    expect(f.invalid('closed:expense-history')).toBe(false);
    f.put('candidate', 'expenses', 'expense', {
      ...before,
      payment_status: 'paid',
      paid_at: '2025-12-31',
    });
    expect(f.invalid('closed:expense-history')).toBe(true);
    f.put('candidate', 'expenses', 'expense', { ...before, supplier: 'Autre' });
    expect(f.invalid('closed:expense-history')).toBe(true);
    f.db.exec(
      "DELETE FROM business_sync_versions WHERE table_name='expenses' AND transfer_id='candidate'",
    );
    expect(f.invalid('closed:expense-history')).toBe(true);
  } finally {
    f.db.close();
  }
});
it('blocks backdated supplier validation and VAT adjustments, but accepts dates after closure', () => {
  const f = fixture();
  try {
    f.both('supplier_invoices', 'supplier', {
      document_date: '2025-12-31',
      status: 'draft',
    });
    f.put('candidate', 'supplier_invoices', 'supplier', {
      document_date: '2025-12-31',
      status: 'validated',
    });
    expect(f.invalid('closed:supplier-validation')).toBe(true);
    f.put('candidate', 'supplier_invoices', 'supplier', {
      document_date: '2026-01-01',
      status: 'validated',
    });
    expect(f.invalid('closed:supplier-validation')).toBe(false);
    f.put('candidate', 'vat_adjustments', 'correction', {
      adjustment_date: '2025-12-31',
    });
    expect(f.invalid('closed:vat-adjustment-dates')).toBe(true);
    f.put('candidate', 'vat_adjustments', 'correction', {
      adjustment_date: '2026-01-01',
    });
    expect(f.invalid('closed:vat-adjustment-dates')).toBe(false);
  } finally {
    f.db.close();
  }
});
