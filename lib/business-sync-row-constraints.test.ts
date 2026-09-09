import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('./runtime', () => ({ database: vi.fn(), fileArchive: vi.fn() }));
import protocol from '../desktop/src-tauri/src/business_sync_tables.json';
import { structuralSchema } from './business-sync-structure';
import { transactionTransitionQueries } from './business-sync-transaction-transitions';
import { rowStructureContract } from './business-sync-row-contract';

const tables = protocol.tables as Record<
  string,
  { key: string[]; columns: string[] }
>;
const instances: DatabaseSync[] = [];
afterEach(() => {
  for (const db of instances.splice(0)) db.close();
});
function database() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=OFF');
  instances.push(db);
  return db;
}
const stamp = '2026-09-09';
type Scalar = string | number | null;
function image(table: string, supplied: Record<string, Scalar>) {
  const native = database();
  native.exec(structuralSchema.tables[table].sql);
  const fields = Object.keys(supplied);
  native
    .prepare(
      `INSERT INTO "${table}"(${fields.map((c) => `"${c}"`).join(',')}) VALUES(${fields.map(() => '?').join(',')})`,
    )
    .run(...Object.values(supplied));
  return native
    .prepare(
      `SELECT json_object(${tables[table].columns.flatMap((c) => [`'${c}'`, `"${c}"`]).join(',')}) image FROM "${table}"`,
    )
    .get()!.image as string;
}
function project(id: string, code: string | null) {
  return image('projects', {
    id,
    code,
    name: 'Projet fictif',
    created_at: stamp,
    updated_at: stamp,
  });
}
function match(id: string, receipt: string | null = null) {
  return image('supplier_invoice_matches', {
    id,
    request_id: '11111111-1111-4111-8111-111111111111',
    supplier_invoice_id: 'invoice',
    supplier_invoice_item_id: 'item',
    supplier_order_id: 'order',
    supplier_order_line_id: 'line',
    supplier_receipt_line_id: receipt,
    quantity_milli: 1000,
    net_cents: 100,
    vat_cents: 8,
    total_cents: 108,
    created_at: stamp,
  });
}
function email(id: string, message: string | null) {
  return image('supplier_email_invoice_imports', {
    supplier_invoice_id: id,
    source_sha256: (id === 'first' ? 'a' : 'b').repeat(64),
    source_message_id: message,
    source_file_name: 'facture.eml',
    attachment_sha256: 'c'.repeat(64),
    attachment_id: `attachment-${id}`,
    created_at: stamp,
  });
}
function vat(id: string, end: string | null) {
  return image('vat_profiles', {
    id,
    effective_from: '2026-01-01',
    effective_to: end,
    reporting_method: 'effective',
    form_of_reporting: 'agreed',
    periodicity: 'quarterly',
    created_at: stamp,
    updated_at: stamp,
  });
}
function fixture() {
  const db = database(),
    native = database();
  db.exec(`CREATE TABLE business_sync_transaction_validations(transfer_id TEXT PRIMARY KEY,phase TEXT,checked_changes INTEGER,next_change_chunk INTEGER,failed_rule TEXT,failed_change INTEGER,updated_at TEXT);
    INSERT INTO business_sync_transaction_validations VALUES('tx','transitions',0,0,NULL,NULL,'original');
    CREATE TABLE business_sync_transaction_changes(transaction_id TEXT,organization_id TEXT,table_name TEXT,row_key_json TEXT,sequence TEXT,part_index INTEGER,change_index INTEGER);
    CREATE TABLE business_sync_versions(transfer_id TEXT,organization_id TEXT,table_name TEXT,row_key_json TEXT,row_json TEXT,UNIQUE(transfer_id,table_name,row_key_json));
    CREATE TABLE business_sync_row_order(transfer_id TEXT,table_name TEXT,row_key_json TEXT,source_rowid TEXT,UNIQUE(transfer_id,table_name,row_key_json));
    CREATE TABLE business_sync_transaction_accounting_states(transfer_id TEXT,validator_sha256 TEXT,table_name TEXT,row_key_json TEXT,row_json TEXT,UNIQUE(transfer_id,validator_sha256,table_name,row_key_json));`);
  // The oracle has the actual native schema and indexes. FK relationships and
  // BEFORE guards have separate suites; these tests isolate row constraints.
  for (const table of Object.values(structuralSchema.tables))
    native.exec(table.sql);
  for (const table of Object.values(structuralSchema.tables))
    for (const index of table.unique) if (index.sql) native.exec(index.sql);
  const queries = transactionTransitionQueries('SELECT 1');
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
  const key = (table: string, row: string) =>
    db
      .prepare(
        `SELECT json_array(${tables[table].key.map((c) => `json_extract(?1,'$.${c}')`).join(',')}) k`,
      )
      .get(row)!.k as string;
  const bindings = (
    table: string,
    before: string | null,
    after: string | null,
    index = 0,
  ) => [
    ...common,
    0,
    'source',
    'now',
    index,
    table,
    key(table, (before ?? after)!),
    before,
    after,
    Math.floor(index / 200),
    index % 200,
  ];
  const status = () =>
    db
      .prepare(
        'SELECT phase,failed_rule,failed_change FROM business_sync_transaction_validations',
      )
      .get()!;
  const applyNative = (table: string, row: string) =>
    native
      .prepare(
        `INSERT INTO "${table}"(${tables[table].columns.map((c) => `"${c}"`).join(',')}) SELECT ${tables[table].columns.map((c) => `json_extract(?1,'$.${c}')`).join(',')}`,
      )
      .run(row);
  const source = (
    table: string,
    row: string,
    organization = 'org',
    transfer = 'source',
  ) =>
    db
      .prepare('INSERT INTO business_sync_versions VALUES(?,?,?,?,?)')
      .run(transfer, organization, table, key(table, row), row);
  const seed = (table: string, row: string) => {
    source(table, row);
    applyNative(table, row);
  };
  const probe = (
    table: string,
    after: string,
    before: string | null = null,
  ) => {
    db.exec(
      "UPDATE business_sync_transaction_validations SET phase='transitions',failed_rule=NULL,failed_change=NULL",
    );
    db.prepare(queries.row[table]).run(...bindings(table, before, after));
    return status().failed_rule;
  };
  const step = (
    table: string,
    before: string | null,
    after: string | null,
    index: number,
  ) => {
    const args = bindings(table, before, after, index);
    db.prepare(
      'INSERT INTO business_sync_transaction_changes VALUES(?,?,?,?,?,?,?)',
    ).run(
      'tx',
      'org',
      table,
      args[20],
      String(index + 1),
      Math.floor(index / 200),
      index % 200,
    );
    db.prepare(queries.row[table]).run(...args);
    db.prepare(queries.accountingRow).run(...args);
    return status();
  };
  const patch = (row: string, changes: string) =>
    db.prepare('SELECT json_patch(?1,?2) image').get(row, changes)!
      .image as string;
  return {
    db,
    native,
    seed,
    source,
    probe,
    step,
    patch,
    applyNative,
    status,
    bindings,
    queries,
  };
}

it('covers the full shared schema and each native unique index', () => {
  expect(Object.keys(rowStructureContract)).toHaveLength(106);
  expect(
    Object.values(rowStructureContract).flatMap((t) => t.unique),
  ).toHaveLength(205);
  for (const [name, table] of Object.entries(rowStructureContract))
    expect(table.columns.map((c) => c.name).sort()).toEqual(
      [...tables[name].columns].sort(),
    );
});

it('requires complete typed row images, preserves nullable fields and exact i64 values', () => {
  const f = fixture(),
    base = project('new', null);
  expect(f.probe('projects', base)).toBeNull();
  for (const raw of [
    '"100"',
    'true',
    '1.5',
    '9223372036854775808',
    '-9223372036854775809',
  ]) {
    expect(
      f.probe('projects', f.patch(base, `{"budget_cents":${raw}}`)),
      raw,
    ).toBe('row:fields:projects');
  }
  expect(f.probe('projects', f.patch(base, '{"name":null}'))).toBe(
    'row:fields:projects',
  );
  const missingNullable = f.db
    .prepare("SELECT json_remove(?,'$.notes') image")
    .get(base)!.image as string;
  expect(f.probe('projects', missingNullable)).toBe('row:fields:projects');
  const line = image('quote_items', {
    id: 'line',
    quote_id: 'quote',
    description: 'Prestation',
    quantity: 1.25,
    created_at: stamp,
    updated_at: stamp,
  });
  for (const raw of ['9223372036854775807', '-9223372036854775808']) {
    expect(
      f.probe('quote_items', f.patch(line, `{"unit_price_cents":${raw}}`)),
    ).toBeNull();
  }
  expect(f.probe('quote_items', line)).toBeNull();
  expect(f.probe('quote_items', f.patch(line, '{"quantity":2}'))).toBeNull();
  expect(f.probe('quote_items', f.patch(line, '{"quantity":"1.25"}'))).toBe(
    'row:fields:quote_items',
  );
});

it('matches SQLite CHECK rejection while allowing SQL NULL in nullable constraints', () => {
  const f = fixture(),
    row = match('m');
  for (const values of [
    '{"quantity_milli":0}',
    '{"net_cents":-1}',
    '{"total_cents":109}',
    '{"request_id":"wrong"}',
  ]) {
    const bad = f.patch(row, values);
    expect(() => f.applyNative('supplier_invoice_matches', bad)).toThrow(
      /CHECK/,
    );
    expect(f.probe('supplier_invoice_matches', bad)).toBe(
      'row:check:supplier_invoice_matches',
    );
  }
  expect(f.probe('vat_profiles', vat('open', null))).toBeNull();
});

it('records malformed nested JSON as an invalid row instead of throwing and retrying forever', () => {
  const f = fixture();
  const invoice = image('invoices', {
    id: 'invoice',
    client_id: 'client',
    title: 'Facture fictive',
    created_at: stamp,
    updated_at: stamp,
  });
  const invalid = f.patch(invoice, '{"deposit_basis_json":"broken"}');
  expect(() => f.applyNative('invoices', invalid)).toThrow(
    /CHECK|malformed JSON/,
  );
  expect(f.probe('invoices', invalid)).toBe('row:check:invoices');
  expect(
    f.probe('invoices', f.patch(invoice, '{"deposit_basis_json":"[]"}')),
  ).toBeNull();
});

it('matches partial project code uniqueness and ignores the same row and other company snapshots', () => {
  const f = fixture(),
    first = project('first', 'P-26');
  f.seed('projects', first);
  expect(() => f.applyNative('projects', project('second', 'P-26'))).toThrow(
    /UNIQUE/,
  );
  expect(f.probe('projects', project('second', 'P-26'))).toBe(
    'row:unique:idx_projects_code',
  );
  expect(f.probe('projects', first, first)).toBeNull();
  for (const code of ['', null]) {
    f.applyNative('projects', project(`native-${String(code)}`, code));
    expect(
      f.probe('projects', project(`new-${String(code)}`, code)),
    ).toBeNull();
  }
  f.source('projects', project('other-company', 'PRIVATE'), 'other');
  f.source('projects', project('other-version', 'OLD'), 'org', 'historical');
  expect(f.probe('projects', project('new-private', 'PRIVATE'))).toBeNull();
  expect(f.probe('projects', project('new-old', 'OLD'))).toBeNull();
});

it('matches composite employee-period uniqueness', () => {
  const f = fixture();
  const payslip = (id: string, period: string) =>
    image('payslips', {
      id,
      employee_id: 'employee',
      period,
      created_at: stamp,
      updated_at: stamp,
    });
  f.seed('payslips', payslip('first', '2026-09'));
  const duplicate = payslip('second', '2026-09');
  expect(() => f.applyNative('payslips', duplicate)).toThrow(/UNIQUE/);
  expect(f.probe('payslips', duplicate)).toBe(
    'row:unique:sqlite_autoindex_payslips_2',
  );
  expect(f.probe('payslips', payslip('next', '2026-10'))).toBeNull();
});

it('preserves NOCASE through projected aliases without folding non-ASCII characters', () => {
  const f = fixture();
  f.seed(
    'supplier_email_invoice_imports',
    email('first', '<ReCu-É@exemple.ch>'),
  );
  const duplicate = email('second', '<recu-É@exemple.ch>');
  expect(() =>
    f.applyNative('supplier_email_invoice_imports', duplicate),
  ).toThrow(/UNIQUE/);
  expect(f.probe('supplier_email_invoice_imports', duplicate)).toBe(
    'row:unique:idx_supplier_email_invoice_imports_message_id',
  );
  expect(
    f.probe(
      'supplier_email_invoice_imports',
      email('second', '<recu-é@exemple.ch>'),
    ),
  ).toBeNull();
});

it('matches expression indexes for absent receipts and a single open-ended VAT profile', () => {
  const f = fixture();
  f.seed('supplier_invoice_matches', match('first'));
  for (const receipt of [null, '']) {
    const duplicate = match('second', receipt);
    expect(() => f.applyNative('supplier_invoice_matches', duplicate)).toThrow(
      /UNIQUE/,
    );
    expect(f.probe('supplier_invoice_matches', duplicate)).toBe(
      'row:unique:idx_supplier_invoice_matches_unique',
    );
  }
  expect(
    f.probe('supplier_invoice_matches', match('second', 'different')),
  ).toBeNull();
  f.seed('vat_profiles', vat('first', null));
  expect(() => f.applyNative('vat_profiles', vat('second', null))).toThrow(
    /UNIQUE/,
  );
  expect(f.probe('vat_profiles', vat('second', null))).toBe(
    'row:unique:idx_vat_profiles_open_ended',
  );
  expect(f.probe('vat_profiles', vat('closed', '2026-06-30'))).toBeNull();
});

it.each(['delete', 'rename'] as const)(
  'releases a unique value after an earlier %s, including a chunk boundary',
  (operation) => {
    const f = fixture(),
      original = project('first', 'P-26');
    f.seed('projects', original);
    const after = operation === 'delete' ? null : project('first', 'RENAMED');
    expect(f.step('projects', original, after, 199).phase).toBe('transitions');
    expect(f.step('projects', null, project('second', 'P-26'), 200).phase).toBe(
      'transitions',
    );
    expect(
      f.step('projects', null, project('third', 'P-26'), 201),
    ).toMatchObject({
      phase: 'invalid',
      failed_rule: 'row:unique:idx_projects_code',
      failed_change: 201,
    });
    expect(
      f.db
        .prepare(
          'SELECT COUNT(*) n FROM business_sync_transaction_accounting_states WHERE row_key_json=?',
        )
        .get('["third"]')!.n,
    ).toBe(0);
  },
);

it('does not borrow a future delete and refuses missing or other-validator intermediate projections', () => {
  const f = fixture(),
    original = project('first', 'P-26');
  f.seed('projects', original);
  f.db.exec(
    `INSERT INTO business_sync_transaction_changes VALUES('tx','org','projects','["first"]','20',0,20)`,
  );
  expect(
    f.step('projects', null, project('second', 'P-26'), 0).failed_rule,
  ).toBe('row:unique:idx_projects_code');
  f.db.exec(
    "UPDATE business_sync_transaction_validations SET phase='transitions',failed_rule=NULL; UPDATE business_sync_transaction_changes SET change_index=0 WHERE sequence='20'; INSERT INTO business_sync_transaction_accounting_states VALUES('tx','other-validator','projects','[\"first\"]',NULL)",
  );
  expect(
    f.step('projects', null, project('third', 'AVAILABLE'), 1).failed_rule,
  ).toBe('row:missing-state:projects');
});

it('cannot alter a failed or concurrently changed validation checkpoint', () => {
  const f = fixture();
  f.seed('projects', project('first', 'DUPLICATE'));
  const args = f.bindings('projects', null, project('second', 'DUPLICATE'));
  f.db.exec(
    'UPDATE business_sync_transaction_validations SET checked_changes=16',
  );
  f.db.prepare(f.queries.row.projects).run(...args);
  expect(f.status().phase).toBe('transitions');
  f.db.exec(
    "UPDATE business_sync_transaction_validations SET phase='invalid',failed_rule='earlier',failed_change=3,checked_changes=0",
  );
  f.db.prepare(f.queries.row.projects).run(...args);
  expect(f.status()).toMatchObject({
    phase: 'invalid',
    failed_rule: 'earlier',
    failed_change: 3,
  });
});
