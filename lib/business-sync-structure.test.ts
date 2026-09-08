import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import protocol from '../desktop/src-tauri/src/business_sync_tables.json';
import {
  compileStructuralRules,
  structuralRules,
  structuralSchema,
} from './business-sync-structure';
import { sqlChecks, sqlUniqueIndex } from './business-sync-sql-rules';

let db: DatabaseSync;
let native: DatabaseSync;
const transfer = '11111111-1111-4111-8111-111111111111';
const org = 'org_first';
const other = '22222222-2222-4222-8222-222222222222';
const tables = protocol.tables as Record<
  string,
  { key: string[]; columns: string[] }
>;
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  for (const name of readdirSync(new URL('../drizzle/', import.meta.url))
    .filter((n) => n.endsWith('.sql'))
    .sort())
    db.exec(
      readFileSync(new URL(`../drizzle/${name}`, import.meta.url), 'utf8'),
    );
  db.exec(`INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,livemode,updated_at) VALUES('sub','cus','price','active',2000000000,0,1),('sub_other','cus_other','price','active',2000000000,0,1);
    INSERT INTO organizations VALUES('${org}','First','sub','owner',1,1),('org_other','Other','sub_other','other',1,1);
    INSERT INTO business_sync_transfers(transfer_id,organization_id,installation_id,created_by,generation,kind,state,base_revision,manifest_json,manifest_sha256,created_at)
      VALUES('${transfer}','${org}','pc','owner','generation','bootstrap','uploaded',0,'{}','hash','2026-09-08'),('${other}','org_other','pc2','other','generation2','bootstrap','uploaded',0,'{}','hash','2026-09-08');`);
  native = new DatabaseSync(':memory:');
  for (const table of Object.values(structuralSchema.tables))
    native.exec(table.sql);
  native.exec(
    "INSERT INTO settings(id,onboarding_completed,company_name,created_at,updated_at) VALUES(1,1,'Entreprise fictive','2026-09-08','2026-09-08')",
  );
});
afterEach(() => {
  native?.close();
  db?.close();
});

function stageNative() {
  for (const [name, rule] of Object.entries(tables)) {
    for (const row of native
      .prepare(
        `SELECT json_array(${rule.key.join(',')}) AS key_json,json_object(${rule.columns.flatMap((c) => [`'${c}'`, `"${c}"`]).join(',')}) AS row_json FROM "${name}"`,
      )
      .all()) {
      db.prepare(
        'INSERT INTO business_sync_versions(transfer_id,organization_id,table_name,row_key_json,row_json,row_sha256) VALUES(?,?,?,?,?,?)',
      ).run(transfer, org, name, row.key_json, row.row_json, 'hash');
    }
  }
}
function violations(filter = structuralRules) {
  return filter
    .filter((rule) => {
      const values: (string | number)[] = [transfer, org];
      if (rule.kind === 'count')
        values.push(
          native.prepare(`SELECT COUNT(*) n FROM "${rule.table}"`).get()!
            .n as number,
        );
      return db.prepare(rule.sql).get(...values) !== undefined;
    })
    .map((r) => r.id);
}
function mutate(table: string, key: string, patch: Record<string, unknown>) {
  const identity = JSON.stringify([key]);
  const row = db
    .prepare(
      'SELECT row_json FROM business_sync_versions WHERE transfer_id=? AND table_name=? AND row_key_json=?',
    )
    .get(transfer, table, identity)!;
  const value = { ...JSON.parse(row.row_json as string), ...patch };
  db.prepare(
    'UPDATE business_sync_versions SET row_json=? WHERE transfer_id=? AND table_name=? AND row_key_json=?',
  ).run(JSON.stringify(value), transfer, table, identity);
}
function stageRow(table: string, key: string, data: Record<string, unknown>) {
  db.prepare(
    'INSERT INTO business_sync_versions(transfer_id,organization_id,table_name,row_key_json,row_json,row_sha256) VALUES(?,?,?,?,?,?)',
  ).run(
    transfer,
    org,
    table,
    JSON.stringify([key]),
    JSON.stringify(data),
    'hash',
  );
}

it('compiles every checked constraint and accepts native empty business tables', () => {
  stageNative();
  expect(Object.keys(structuralSchema.tables)).toHaveLength(106);
  expect(compileStructuralRules()).toEqual(structuralRules);
  expect(violations()).toEqual([]);
  expect(structuralRules.filter((r) => r.kind === 'unique')).toHaveLength(205);
  expect(structuralRules.filter((r) => r.kind === 'foreign_key')).toHaveLength(
    225,
  );
});

it('parses checks and expression indexes without treating quoted text or comments as SQL syntax', () => {
  expect(
    sqlChecks(
      `CREATE TABLE x(a TEXT CHECK (length(a)>0 AND a<>'CHECK (x)'), b INTEGER /* CHECK (false) */ CHECK ((b+1)>0), "check" TEXT DEFAULT 'x')`,
    ),
  ).toEqual(["length(a)>0 AND a<>'CHECK (x)'", '(b+1)>0']);
  expect(
    sqlUniqueIndex(
      `CREATE UNIQUE INDEX "on" ON x(IFNULL(a,','), b COLLATE NOCASE DESC) WHERE a<>')';`,
    ),
  ).toEqual({
    expressions: ["IFNULL(a,',')", 'b COLLATE NOCASE'],
    where: "a<>')'",
  });
  expect(() => sqlChecks('CREATE TABLE x(a CHECK (a>0)')).not.toThrow();
  expect(() => sqlChecks('CREATE TABLE x(a CHECK (a>0')).toThrow();
  expect(() =>
    sqlChecks("CREATE TABLE x(a CHECK (a<>'unterminated)"),
  ).toThrow();
});

it('rejects missing required fields, SQLite storage type changes and native CHECK violations', () => {
  native.exec(
    "INSERT INTO clients(id,name,created_at,updated_at) VALUES('client','Client fictif','2026-09-08','2026-09-08')",
  );
  stageNative();
  const checks = structuralRules.filter((r) =>
    ['clients', 'settings'].includes(r.table),
  );
  expect(violations(checks)).toEqual([]);
  mutate('clients', 'client', { name: null });
  expect(violations(checks)).toContain('clients:fields');
  mutate('clients', 'client', { name: 123 });
  expect(violations(checks)).toContain('clients:fields');
  db.exec(
    `UPDATE business_sync_versions SET row_json=json_set(row_json,'$.default_vat_bp',10001) WHERE table_name='settings'`,
  );
  expect(violations(checks)).toContain('settings:check');
});

it('finds a broken project relation without accepting the same key from another company', () => {
  native.exec(
    "INSERT INTO clients(id,name,created_at,updated_at) VALUES('client','Client fictif','2026-09-08','2026-09-08'); INSERT INTO projects(id,client_id,name,created_at,updated_at) VALUES('project','client','Projet fictif','2026-09-08','2026-09-08')",
  );
  stageNative();
  const checks = structuralRules.filter(
    (r) => r.table === 'projects' && r.kind === 'foreign_key',
  );
  expect(violations(checks)).toEqual([]);
  db.prepare(
    "UPDATE business_sync_versions SET transfer_id=?,organization_id='org_other' WHERE table_name='clients'",
  ).run(other);
  expect(violations(checks)).toHaveLength(1);
});

it('honors nullable and partial unique indexes instead of rejecting every unused reference', () => {
  native.exec(
    "INSERT INTO projects(id,code,name,created_at,updated_at) VALUES('one','','Premier','2026-09-08','2026-09-08'),('two','','Second','2026-09-08','2026-09-08')",
  );
  stageNative();
  const checks = structuralRules.filter(
    (r) => r.table === 'projects' && r.kind === 'unique',
  );
  expect(violations(checks)).toEqual([]);
  mutate('projects', 'one', { code: 'P-001' });
  mutate('projects', 'two', { code: 'P-001' });
  expect(violations(checks)).toEqual(['projects:unique:idx_projects_code']);
  mutate('projects', 'two', { code: null });
  expect(violations(checks)).toEqual([]);
});

it('enforces expression uniqueness, partial open VAT profiles and case-insensitive message identities', () => {
  stageRow('supplier_invoice_matches', 'one', {
    id: 'one',
    supplier_invoice_item_id: 'item',
    supplier_order_line_id: 'order',
    supplier_receipt_line_id: null,
  });
  stageRow('supplier_invoice_matches', 'two', {
    id: 'two',
    supplier_invoice_item_id: 'item',
    supplier_order_line_id: 'order',
    supplier_receipt_line_id: '',
  });
  const matches = structuralRules.filter(
    (r) => r.table === 'supplier_invoice_matches' && r.kind === 'unique',
  );
  expect(violations(matches)).toHaveLength(1);
  mutate('supplier_invoice_matches', 'two', {
    supplier_receipt_line_id: 'receipt',
  });
  expect(violations(matches)).toEqual([]);
  stageRow('supplier_email_invoice_imports', 'one', {
    supplier_invoice_id: 'one',
    source_message_id: 'Message@Example.ch',
  });
  stageRow('supplier_email_invoice_imports', 'two', {
    supplier_invoice_id: 'two',
    source_message_id: 'message@example.ch',
  });
  const messages = structuralRules.filter(
    (r) => r.table === 'supplier_email_invoice_imports' && r.kind === 'unique',
  );
  expect(violations(messages)).toHaveLength(1);
  mutate('supplier_email_invoice_imports', 'two', { source_message_id: null });
  expect(violations(messages)).toEqual([]);
  stageRow('vat_profiles', 'one', {
    id: 'one',
    effective_from: '2025-01-01',
    effective_to: null,
  });
  stageRow('vat_profiles', 'two', {
    id: 'two',
    effective_from: '2026-01-01',
    effective_to: null,
  });
  const vat = structuralRules.filter(
    (r) => r.table === 'vat_profiles' && r.kind === 'unique',
  );
  expect(violations(vat)).toHaveLength(1);
  mutate('vat_profiles', 'one', { effective_to: '2025-12-31' });
  expect(violations(vat)).toEqual([]);
});

it('reports deleted optional fields and count mismatches before dependent constraints', () => {
  stageNative();
  db.exec(
    "UPDATE business_sync_versions SET row_json=json_remove(row_json,'$.email') WHERE table_name='settings'",
  );
  expect(
    violations(structuralRules.filter((r) => r.kind === 'fields')),
  ).toEqual(['settings:fields']);
  db.exec("DELETE FROM business_sync_versions WHERE table_name='settings'");
  expect(violations(structuralRules.filter((r) => r.kind === 'count'))).toEqual(
    ['settings:count'],
  );
  const firstConstraint = structuralRules.findIndex((r) => r.kind === 'check');
  expect(
    structuralRules
      .slice(firstConstraint)
      .some((r) => ['count', 'fields'].includes(r.kind)),
  ).toBe(false);
});

it('checks a large project history with an indexed parent join and finds a missing final parent', () => {
  const check = structuralRules.find(
    (r) => r.table === 'projects' && r.kind === 'foreign_key',
  )!;
  const plan = db
    .prepare(`EXPLAIN QUERY PLAN ${check.sql}`)
    .all(transfer, org)
    .map((row) => String(row.detail));
  expect(
    plan.some((detail) =>
      /SEARCH parents USING AUTOMATIC .*INDEX/.test(detail),
    ),
  ).toBe(true);
  const insert = db.prepare(
    'INSERT INTO business_sync_versions(transfer_id,organization_id,table_name,row_key_json,row_json,row_sha256) VALUES(?,?,?,?,?,?)',
  );
  db.exec('BEGIN');
  for (let index = 0; index < 50_000; index++) {
    insert.run(
      transfer,
      org,
      'clients',
      JSON.stringify([`client-${index}`]),
      JSON.stringify({ id: `client-${index}` }),
      'hash',
    );
    insert.run(
      transfer,
      org,
      'projects',
      JSON.stringify([`project-${index}`]),
      JSON.stringify({ id: `project-${index}`, client_id: `client-${index}` }),
      'hash',
    );
  }
  db.exec('COMMIT');
  expect(violations([check])).toEqual([]);
  db.prepare(
    "DELETE FROM business_sync_versions WHERE table_name='clients' AND row_key_json=?",
  ).run(JSON.stringify(['client-49999']));
  expect(violations([check])).toEqual([check.id]);
});

it.skipIf(!process.env.ZENTRA_NATIVE_BOOTSTRAP_QA)(
  'validates the actual native invoice and payment fixture without changing stored row bytes',
  () => {
    const folder = process.env.ZENTRA_NATIVE_BOOTSTRAP_QA!;
    const prepared = JSON.parse(
      readFileSync(join(folder, 'prepared.json'), 'utf8'),
    );
    for (let index = 0; index < prepared.manifest.chunks.length; index++) {
      const chunk = JSON.parse(
        readFileSync(
          join(folder, 'rows', `${String(index).padStart(4, '0')}.json`),
          'utf8',
        ),
      );
      for (const row of chunk.rows)
        db.prepare(
          'INSERT INTO business_sync_versions(transfer_id,organization_id,table_name,row_key_json,row_json,row_sha256) VALUES(?,?,?,?,?,?)',
        ).run(transfer, org, row.table, row.key_json, row.row_json, 'hash');
    }
    const failures: string[] = [];
    for (const rule of structuralRules) {
      const params: (string | number)[] = [transfer, org];
      if (rule.kind === 'count')
        params.push(prepared.manifest.tables[rule.table]);
      if (db.prepare(rule.sql).get(...params)) failures.push(rule.id);
    }
    expect(failures).toEqual([]);
  },
);
