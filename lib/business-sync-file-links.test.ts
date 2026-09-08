import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { businessFileLinksSql } from './business-sync-file-links';
it('binds referenced files, logos, old payroll paths and VAT export hashes to the published catalogue', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(
      'CREATE TABLE business_sync_versions(transfer_id TEXT,organization_id TEXT,table_name TEXT,row_json TEXT); CREATE TABLE business_sync_file_entries(transfer_id TEXT,path TEXT,sha256 TEXT,size_bytes INTEGER)',
    );
    const put = (table: string, value: unknown) =>
      db
        .prepare('INSERT INTO business_sync_versions VALUES(?,?,?,?)')
        .run('transfer', 'org', table, JSON.stringify(value));
    for (const path of [
      'attachments/photo.jpg',
      'attachments/branding/logo.png',
      'attachments/payroll-imports/pay.png',
      'exports/vat.xml',
      'exports/closing.zip',
    ])
      db.prepare('INSERT INTO business_sync_file_entries VALUES(?,?,?,?)').run(
        'transfer',
        path,
        'hash',
        30,
      );
    put('attachments', {
      id: 'a',
      stored_name: 'photo.jpg',
      sha256: 'hash',
      size_bytes: 30,
    });
    put('company_brand_assets', {
      id: 'brand',
      file_name: 'logo.png',
      sha256: 'hash',
      byte_size: 30,
    });
    put('settings', { id: 1, logo_path: 'C:\\Old PC\\branding\\logo.png' });
    put('payroll_document_imports', {
      id: 'pay',
      stored_path: 'C:\\Old PC\\payroll-imports\\pay.png',
      file_sha256: 'hash',
      file_size: 30,
    });
    put('payroll_document_imports', {
      id: 'relative',
      stored_path: 'payroll-imports/pay.png',
      file_sha256: 'hash',
      file_size: 30,
    });
    put('vat_return_exports', {
      id: 'vat',
      file_name: 'vat.xml',
      xml_sha256: 'hash',
    });
    put('closing_package_exports', { id: 'closing', file_name: 'closing.zip' });
    expect(
      db.prepare(businessFileLinksSql).get('transfer', 'org'),
    ).toBeUndefined();
    db.exec(
      "UPDATE business_sync_file_entries SET sha256='changed' WHERE path='exports/vat.xml'",
    );
    expect(db.prepare(businessFileLinksSql).get('transfer', 'org')).toEqual({
      table_name: 'vat_return_exports',
      id: 'vat',
    });
    db.exec(
      "UPDATE business_sync_file_entries SET sha256='hash'; UPDATE business_sync_versions SET row_json=json_set(row_json,'$.stored_path','C:/../payroll-imports/pay.png') WHERE table_name='payroll_document_imports'",
    );
    expect(
      db.prepare(businessFileLinksSql).get('transfer', 'org'),
    ).toMatchObject({ table_name: 'payroll_document_imports' });
  } finally {
    db.close();
  }
});
