import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  issuedInvoiceFields,
  transactionImmutabilityRules,
} from './business-sync-transaction-immutability';

it('protects every frozen invoice field from the latest native trigger, including deposit conditions', () => {
  const native = readFileSync(
    new URL('../desktop/src-tauri/src/schema.rs', import.meta.url),
    'utf8',
  );
  const last = native
    .slice(
      native.lastIndexOf('CREATE TRIGGER invoices_issued_financial_no_update'),
    )
    .split('END;')[0];
  const fields = [...last.matchAll(/NEW\.(\w+) IS NOT OLD\.\1/g)].map(
    (m) => m[1],
  );
  expect([...issuedInvoiceFields].sort()).toEqual(fields.sort());
});

it('rejects removal, replacement and insertion of issued lines while accepting legitimate draft edits', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(
      'CREATE TABLE business_sync_versions(transfer_id TEXT,organization_id TEXT,table_name TEXT,row_key_json TEXT,row_json TEXT,row_sha256 TEXT)',
    );
    const put = (
      transfer: string,
      table: string,
      id: string,
      data: Record<string, unknown>,
    ) =>
      db
        .prepare('INSERT INTO business_sync_versions VALUES(?,?,?,?,?,?)')
        .run(
          transfer,
          'org',
          table,
          JSON.stringify([id]),
          JSON.stringify(data),
          JSON.stringify(data),
        );
    const invalid = () =>
      db
        .prepare(transactionImmutabilityRules[2].sql)
        .get('candidate', 'org', 'source') !== undefined;
    put('source', 'invoices', 'invoice', { id: 'invoice', number: 'F-2026-1' });
    put('source', 'invoice_items', 'line', {
      id: 'line',
      invoice_id: 'invoice',
      description: 'Origine',
    });
    put('candidate', 'invoice_items', 'line', {
      id: 'line',
      invoice_id: 'invoice',
      description: 'Origine',
    });
    expect(invalid()).toBe(false);
    db.exec(
      "UPDATE business_sync_versions SET row_sha256='changed' WHERE transfer_id='candidate'",
    );
    expect(invalid()).toBe(true);
    db.exec("DELETE FROM business_sync_versions WHERE transfer_id='candidate'");
    expect(invalid()).toBe(true);
    put('candidate', 'invoice_items', 'line', {
      id: 'line',
      invoice_id: 'invoice',
      description: 'Origine',
    });
    put('candidate', 'invoice_items', 'new', {
      id: 'new',
      invoice_id: 'invoice',
      description: 'Ajout',
    });
    expect(invalid()).toBe(true);
    db.exec(
      "UPDATE business_sync_versions SET row_json=json_set(row_json,'$.number',NULL) WHERE table_name='invoices'",
    );
    expect(invalid()).toBe(false);
  } finally {
    db.close();
  }
});
