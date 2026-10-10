import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { SupabaseServerClient } from '../supabase-server';
import { createSupabaseErpStore } from './runtime-store';
import { executeErp } from './runtime';
import type { FinancialAuthority } from './accounting/ledger';
import type { CompanyConfiguration } from './types';

// RAM-only SQL-chain rehearsal. Reuses the real baseline/bootstrap from
// new-us-workspace-admission.postgres.test.ts, including its storage metadata
// stub. No hosted URL/key, provider, D1, real customer data or persistent DB.
// PGlite serializes connections; this does not prove concurrent hosted behavior.
// Environment feature gates and the six other live platform triggers are outside
// this SQL fixture. Installing a schema is never a grant to enable those gates.
const directory = process.env.PGLITE_MODULE_DIR, enabled = Boolean(directory && isAbsolute(directory));
type Row = Record<string, unknown>;
type Sql = { exec(sql: string): Promise<unknown>; query<T = Row>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> };
type Db = Sql & { close(): Promise<void>; transaction<T>(task: (sql: Sql) => Promise<T>): Promise<T> };
type Role = 'service_role' | 'anon' | 'authenticated';
let db: Db;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const migrationDirectory = new URL('../../supabase/migrations/', import.meta.url);
const baselines = ['202609140100_company_profiles', '202609140200_company_collaboration', '202609200300_company_content'];
const migrations = [
  '20261007194528_international_workspace_country_config',
  '20261007222349_international_us_erp_persistence',
  '20261007224820_international_us_erp_delta_stream',
  '20261007225725_international_us_erp_seller_snapshot',
  '20261008001726_new_us_workspace_admission',
  '20261008013200_international_tax_proof_allowlist',
  '20261008034422_international_us_seller_profile',
  '20261008044402_international_us_tax_profile',
  '20261008060826_international_us_tax_operations',
  '20261008081825_international_us_purchasing_v2',
  '20261008105120_international_us_projects_v3',
  '20261008161118_international_us_journal_periods_v4',
  '20261008172520_international_us_tax_invoice_capability_v2',
  '20261008184605_international_us_bank_reconciliation',
  '20261008194930_international_us_supplier_proposals',
  '20261008210008_international_us_automation_analysis',
  '20261009215104_international_us_workspace_sync_heads',
  '20261009222319_international_us_tax_test_merchant',
  '20261009224607_international_us_tax_invoice_preparation',
] as const;
const legacyNames = ['zentra_commit_workspace', 'zentra_reserve_workspace_numbers', 'zentra_prepare_content', 'zentra_reserve_content_blob', 'zentra_claim_content_cleanup'];
const legacyTables = ['zentra_workspaces', 'zentra_company_profiles', 'zentra_workspace_snapshots', 'zentra_workspace_chunks', 'zentra_workspace_content_parts', 'zentra_workspace_content_blobs', 'zentra_workspace_number_reservations'];

// Exact function body supplied by root's read-only pg_get_functiondef metadata
// capture on 2026-10-10; owner postgres, event ensure_rls enabled O, client EXECUTE
// revoked. This is a fixture of that one observed trigger, not the whole platform.
const observedRlsTrigger = `CREATE OR REPLACE FUNCTION public.rls_auto_enable()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$;
revoke execute on function public.rls_auto_enable() from public,anon,authenticated;
create event trigger ensure_rls on ddl_command_end execute function public.rls_auto_enable();`;

async function asRole<T = Row>(sql: string, values: unknown[] = [], role: Role = 'service_role'): Promise<T[]> {
  return db.transaction(async tx => { await tx.exec(`set local role ${role}`); return (await tx.query<T>(sql, values)).rows; });
}
async function result<T = Row>(sql: string, values: unknown[] = []): Promise<T> { return (await asRole<{ result: T }>(sql, values))[0].result; }
async function legacyState(org: string): Promise<Record<string, unknown[]>> {
  const state: Record<string, unknown[]> = {};
  for (const table of legacyTables) state[table] = (await asRole<{ row: unknown }>(`select to_jsonb(r) row from public.${table} r where organization_id=$1 order by to_jsonb(r)::text`, [org])).map(r => r.row);
  return state;
}
async function functions(schema: string, names = legacyNames) {
  return (await db.query<Row & { proname: string }>(`select p.proname,pg_get_function_identity_arguments(p.oid) arguments,p.prosrc,p.proargnames,p.prosecdef,
    pg_get_userbyid(p.proowner) owner,p.proconfig,p.proacl::text acl,
    has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,
    has_function_privilege('service_role',p.oid,'EXECUTE') service
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=$1 and p.proname=any($2::text[]) order by p.proname`, [schema, names])).rows;
}
const chOrg = randomUUID(), chOwner = randomUUID(), chSnapshot = randomUUID(), chPending = randomUUID(), chNumberRequest = randomUUID();
const part = { sha256: hash('fictitious legacy content'), size_bytes: 3 }, orphan = hash('fictitious orphan content');
const manifest = { format: 'zentra-cloud-backup', version: 1, app_version: '1.90.15', sha256: part.sha256, size_bytes: 3, chunks: [part] };
const prepare = (org: string, id: string, base: number, owner = chOwner) => result<{ missing: string[]; id: string }>("select public.zentra_prepare_content($1,$2,'fixture-pc',$3,$4,$5::jsonb,$6::jsonb,$7,false,'[]'::jsonb) result", [org, id, owner, base, JSON.stringify(manifest), JSON.stringify([part]), hash('fictitious manifest')]);
const reserveBlob = (org: string, id: string, owner = chOwner) => result<{ ready: boolean; storageKey: string }>("select public.zentra_reserve_content_blob($1,$2,'fixture-pc',$3,$4,3) result", [org, id, owner, part.sha256]);
const commit = (org: string, id: string, owner = chOwner) => result("select public.zentra_commit_workspace($1,$2,'fixture-pc',$3) result", [org, id, owner]);
const numbers = (org: string, request: string) => result("select public.zentra_reserve_workspace_numbers($1,'fixture-pc',$2,'F',2026,1,2) result", [org, request]);
let initialCH: Record<string, unknown[]>, legacyBefore: Row[], beforeNumber: Row, beforeBlob: { ready: boolean; storageKey: string };
type Inventory = {
  tables: { name: string; scope: string; exists: boolean }[];
  functions: { schema: string; name: string }[];
  schemas: { name: string; owner: string; acl: string }[];
  privateAdmissionRole: null | { name: string; login: boolean; superuser: boolean; bypassRls: boolean; inherit: boolean; createRole: boolean; createDb: boolean; replication: boolean; members: string[] | null; memberOf: string[] | null };
  privateAdmissionSchemaExists: boolean; migrationHistoryTableExists: boolean;
};
let rlsBefore: Row[], installedRows: Record<string, number>, inventoryBefore: Inventory, inventoryAfter: Inventory;
const preservedAt: string[] = [], migrationTables: string[] = [], migrationFunctions = new Set<string>();
const usConfig = (org: string): CompanyConfiguration => ({ schemaVersion: 1, organizationId: org, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York', address: { country: 'US', line1: '1 Fictitious Avenue', city: 'New York', subdivision: 'NY', postalCode: '10001' }, accountingBasis: 'accrual', invoiceNumberPrefix: 'TEST', taxConfiguration: { status: 'unconfigured' } });
async function admit(org = randomUUID()) {
  const userId = randomUUID(), creation = randomUUID(), request = randomUUID(), configuration = usConfig(org);
  const invoke = () => result('select public.zentra_admit_new_us_workspace_v1($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::jsonb,$6) result', [org, creation, userId, request, JSON.stringify(configuration), hash(org)]);
  const receipt = await invoke(); return { org, userId, configuration, receipt, invoke };
}
async function rlsMetadata() {
  return (await db.query("select e.evtname,e.evtevent,e.evtenabled,p.prosrc,p.prosecdef,p.proconfig,pg_get_userbyid(p.proowner) owner,p.proacl::text acl from pg_event_trigger e join pg_proc p on p.oid=e.evtfoid where e.evtname='ensure_rls'")).rows;
}
async function structuralInventory(): Promise<Inventory> {
  const sql = await readFile(new URL('../../docs/internationalization/US-STAGING-STRUCTURE-PREFLIGHT.sql', import.meta.url), 'utf8');
  const batches = await db.exec(sql) as { rows?: { metadata?: Inventory }[] }[];
  const inventory = batches.flatMap(batch => batch.rows ?? []).find(row => row.metadata)?.metadata;
  if (!inventory) throw new Error('Structural preflight did not return its metadata inventory');
  return inventory;
}

describe.skipIf(!enabled)('complete international staging SQL chain on populated real legacy schemas', () => {
  beforeAll(async () => {
    expect(JSON.parse(await readFile(join(directory!, 'package.json'), 'utf8')).name).toBe('@electric-sql/pglite');
    const { PGlite } = createRequire(import.meta.url)(join(directory!, 'dist/index.cjs')) as { PGlite: new () => Db }; db = new PGlite();
    await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);grant usage on schema public to service_role;');
    await db.exec(observedRlsTrigger); rlsBefore = await rlsMetadata();
    for (const name of baselines) await db.exec(await readFile(new URL(`${name}.sql`, migrationDirectory), 'utf8'));
    await asRole('insert into public.zentra_workspaces(organization_id,updated_by,number_floors) values($1,$2,$3::jsonb)', [chOrg, chOwner, JSON.stringify([{ prefix: 'F', year: 2026, minimum: 125 }])]);
    await asRole('insert into public.zentra_company_profiles(organization_id,profile,updated_by) values($1,$2::jsonb,$3)', [chOrg, JSON.stringify({ company_name: 'Fictitious unchanged CH company', currency: 'CHF', private_fixture: 'never public' }), chOwner]);
    await asRole("insert into public.zentra_workspace_snapshots(organization_id,id,installation_id,created_by,base_revision,manifest,size_bytes) values($1,$2,'fixture-pc',$3,0,$4::jsonb,3)", [chOrg, chSnapshot, chOwner, JSON.stringify(manifest)]);
    await asRole('insert into public.zentra_workspace_chunks values($1,$2,0,$3,3)', [chOrg, chSnapshot, part.sha256]);
    expect(await commit(chOrg, chSnapshot)).toMatchObject({ committed: true, revision: 1, snapshotId: chSnapshot });
    beforeNumber = await numbers(chOrg, chNumberRequest);
    expect((await prepare(chOrg, chPending, 1)).missing).toEqual([part.sha256]); beforeBlob = await reserveBlob(chOrg, chPending);
    await asRole("insert into public.zentra_workspace_content_blobs(organization_id,sha256,size_bytes,state,created_at) values($1,$2,3,'ready',now()-interval '2 hours')", [chOrg, orphan]);
    initialCH = await legacyState(chOrg); legacyBefore = await functions('public'); inventoryBefore = await structuralInventory();
    for (const name of migrations) {
      const sql = await readFile(new URL(`${name}.sql`, migrationDirectory), 'utf8');
      migrationTables.push(...[...sql.matchAll(/create\s+table\s+public\.([a-z_0-9]+)/gi)].map(m => m[1]));
      for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+public\.([a-z_0-9]+)/gi)) migrationFunctions.add(m[1]);
      try { await db.exec(sql); } catch (cause) { throw new Error(`Local chain migration failed: ${name}`, { cause }); }
      expect(await legacyState(chOrg), name).toEqual(initialCH); preservedAt.push(name);
    }
    inventoryAfter = await structuralInventory(); installedRows = {};
    for (const table of migrationTables) installedRows[table] = (await db.query<{ n: number }>(`select count(*)::integer n from public.${table}`)).rows[0].n;
  }, 60_000);
  afterAll(async () => { await db?.close(); });

  it('covers the 19-file reviewed staging snapshot and preserves populated CH rows after every migration', async () => {
    // This evidence is the structural snapshot reviewed before supplier
    // originals. Later additive migrations have their own full-chain tests;
    // they must not retroactively change this observed staging inventory.
    const boundary = `${migrations[migrations.length - 1]}.sql`;
    const actual = (await readdir(migrationDirectory)).filter(name => name <= boundary && /^\d+_(?:international_.+|new_us_workspace_admission)\.sql$/.test(name)).sort();
    expect(actual).toEqual(migrations.map(name => `${name}.sql`)); expect(preservedAt).toEqual(migrations);
    expect(await legacyState(chOrg)).toEqual(initialCH); expect(Object.values(initialCH).every(rows => rows.length > 0)).toBe(true);
  });
  it('installs 33 private tables without inventing country, US book, profile, provider, admission or review data', () => {
    expect(new Set(migrationTables).size).toBe(33); expect(Object.keys(installedRows)).toHaveLength(33);
    expect(Object.values(installedRows).every(n => n === 0)).toBe(true);
  });
  it('runs the catalogue-only preflight before and after the chain, including absent-table/history reporting', () => {
    expect(inventoryBefore.tables).toHaveLength(40); expect(inventoryAfter.tables).toHaveLength(40);
    expect(inventoryBefore.tables.filter(table => table.exists).map(table => table.name).sort()).toEqual([...legacyTables].sort());
    expect(inventoryBefore.tables.filter(table => !table.exists)).toHaveLength(33);
    expect(inventoryAfter.tables.every(table => table.exists)).toBe(true);
    expect(inventoryBefore.privateAdmissionSchemaExists).toBe(false); expect(inventoryAfter.privateAdmissionSchemaExists).toBe(true);
    expect(inventoryBefore.migrationHistoryTableExists).toBe(false); expect(inventoryAfter.migrationHistoryTableExists).toBe(false);
    const names = inventoryAfter.functions.map(fn => `${fn.schema}.${fn.name}`).sort();
    expect(names).toEqual([
      ...[...migrationFunctions, 'rls_auto_enable'].map(name => `public.${name}`),
      ...[...legacyNames, 'admit_new_us_workspace_v1'].map(name => `zentra_admission_private.${name}`),
    ].sort());
    expect(inventoryBefore.functions.map(fn => fn.name).sort()).toEqual([...legacyNames, 'rls_auto_enable'].sort());
    expect(inventoryBefore.schemas).toHaveLength(1); expect(inventoryAfter.schemas).toHaveLength(2);
    expect(inventoryAfter.schemas.find(schema => schema.name === 'public')?.owner).toBe(inventoryBefore.schemas[0].owner);
    const privateSchema = inventoryAfter.schemas.find(schema => schema.name === 'zentra_admission_private');
    expect(privateSchema).toMatchObject({ owner: 'postgres' }); expect(privateSchema?.acl).toContain('service_role=U/'); expect(privateSchema?.acl).toContain('zentra_us_admission_owner=U/');
    expect(inventoryBefore.privateAdmissionRole).toBeNull();
    expect(inventoryAfter.privateAdmissionRole).toEqual({ name: 'zentra_us_admission_owner', login: false, superuser: false, bypassRls: false, inherit: false, createRole: false, createDb: false, replication: false, members: ['postgres'], memberOf: null });
  });
  it('matches the dated read-only live legacy CRLF and ensure_rls LF body hashes', () => {
    // Root supplied these metadata-only prosrc MD5 values on 2026-10-10.
    // This binds the real baseline bodies to that observation, without importing
    // customer rows or claiming the remainder of the platform was reproduced.
    const observed: Record<string, string> = {
      zentra_claim_content_cleanup: 'b8d88ab0ff4bcced96347bdf055de93f',
      zentra_commit_workspace: 'cd437e4e023b4d8a257fd96873b35aab',
      zentra_prepare_content: 'ef6ea581bf091c1619863aa0219e3ac8',
      zentra_reserve_content_blob: 'c3aeb694b44f306f4c08903512912c4a',
      zentra_reserve_workspace_numbers: '105a9b5d8c96d27bffaf461dbcd2dc90',
    };
    // Decoded live metadata confirmed CRLF in every legacy body (9/21/28/16/16
    // line breaks); the initial LF-only assertion was wrong. Canonicalize only
    // checkout line endings to that observed form, preserving all SQL, comments,
    // indentation and whitespace. The five live hashes above remain unchanged.
    for (const row of legacyBefore) {
      const observedLineEndings = String(row.prosrc).replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
      expect(createHash('md5').update(observedLineEndings).digest('hex'), String(row.proname)).toBe(observed[String(row.proname)]);
    }
    expect(createHash('md5').update(String(rlsBefore[0].prosrc).replace(/\r\n/g, '\n')).digest('hex')).toBe('99be20677b456ea8d3be47bdd44fb369');
  });
  it('preserves the observed enabled ensure_rls body, owner, search_path and restricted ACL', async () => {
    expect(await rlsMetadata()).toEqual(rlsBefore);
    expect(rlsBefore).toMatchObject([{ evtname: 'ensure_rls', evtevent: 'ddl_command_end', evtenabled: 'O', prosecdef: true, owner: 'postgres', proconfig: ['search_path=pg_catalog'] }]);
    const acl = (await db.query("select has_function_privilege('anon','public.rls_auto_enable()','EXECUTE') anon,has_function_privilege('authenticated','public.rls_auto_enable()','EXECUTE') authenticated,has_function_privilege('service_role','public.rls_auto_enable()','EXECUTE') service")).rows;
    expect(acl).toEqual([{ anon: false, authenticated: false, service: false }]);
  });
  it('retains exact legacy bodies, arguments, postgres ownership, definer mode and effective ACL after relocation', async () => {
    expect(legacyBefore).toHaveLength(5); expect(await functions('zentra_admission_private')).toEqual(legacyBefore);
    for (const row of legacyBefore) expect(row).toMatchObject({ prosecdef: true, owner: 'postgres', proconfig: ['search_path=""'], anon: false, authenticated: false, service: true });
    const wrappers = await functions('public'); expect(wrappers).toHaveLength(5);
    for (const row of wrappers) {
      const original = legacyBefore.find(old => old.proname === row.proname)!;
      expect(row).toMatchObject({ arguments: original.arguments, proargnames: original.proargnames, prosecdef: false, owner: original.owner, proconfig: original.proconfig, acl: original.acl, anon: false, authenticated: false, service: true });
    }
  });
  it('keeps all new tables under RLS and denies client table/RPC privileges while admitting service reads', async () => {
    const rows = (await db.query("select c.relname,c.relrowsecurity,has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') anon,has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') authenticated,has_table_privilege('service_role',c.oid,'SELECT') service from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any($1::text[])", [migrationTables])).rows;
    expect(rows).toHaveLength(33); for (const row of rows) expect(row).toMatchObject({ relrowsecurity: true, anon: false, authenticated: false, service: true });
    const rpc = await functions('public', [...migrationFunctions]); expect(rpc.map(row => row.proname).sort()).toEqual([...migrationFunctions].sort());
    for (const row of rpc) expect(row).toMatchObject({ prosecdef: false, proconfig: ['search_path=""'], anon: false, authenticated: false });
    for (const role of ['anon', 'authenticated'] as const) {
      for (const table of migrationTables) await expect(asRole(`select count(*) from public.${table}`, [], role), `${role}:${table}`).rejects.toMatchObject({ code: '42501' });
      await expect(asRole('select public.zentra_read_us_erp_v4($1)', [chOrg], role)).rejects.toMatchObject({ code: '42501' });
      await expect(asRole('select public.zentra_read_us_tax_merchant_context($1,$2::jsonb)', [chOrg, '{}'], role)).rejects.toMatchObject({ code: '42501' });
    }
  });
  it('keeps the dedicated admission owner unloginable, without RLS bypass or service-role membership', async () => {
    expect((await db.query("select rolcanlogin,rolinherit,rolbypassrls from pg_roles where rolname='zentra_us_admission_owner'")).rows).toEqual([{ rolcanlogin: false, rolinherit: false, rolbypassrls: false }]);
    expect((await db.query("select pg_has_role('service_role','zentra_us_admission_owner','MEMBER') member,has_table_privilege('service_role','public.zentra_workspace_us_admissions','INSERT') admission_insert,has_schema_privilege('anon','zentra_admission_private','USAGE') anon,has_schema_privilege('authenticated','zentra_admission_private','USAGE') authenticated")).rows).toEqual([{ member: false, admission_insert: false, anon: false, authenticated: false }]);
    expect(await functions('zentra_admission_private', ['admit_new_us_workspace_v1'])).toMatchObject([{ prosecdef: true, owner: 'zentra_us_admission_owner', proconfig: ['search_path=""'], anon: false, authenticated: false, service: true }]);
  });
  it('executes all five real CH legacy RPCs under service_role, retaining v0/v1 content and exact numbering receipts', async () => {
    expect(await commit(chOrg, chSnapshot)).toMatchObject({ committed: true, revision: 1, snapshotId: chSnapshot });
    expect(await numbers(chOrg, chNumberRequest)).toEqual(beforeNumber);
    expect((await prepare(chOrg, chPending, 1)).missing).toEqual([part.sha256]); expect(await reserveBlob(chOrg, chPending)).toEqual(beforeBlob);
    await asRole("update public.zentra_workspace_content_blobs set state='ready' where organization_id=$1 and sha256=$2", [chOrg, part.sha256]);
    expect(await commit(chOrg, chPending)).toMatchObject({ committed: true, revision: 2, snapshotId: chPending });
    expect(await commit(chOrg, chPending)).toMatchObject({ committed: true, revision: 2, snapshotId: chPending });
    const next = randomUUID(); expect((await prepare(chOrg, next, 2)).missing).toEqual([]); expect(await reserveBlob(chOrg, next)).toEqual({ ready: true, storageKey: beforeBlob.storageKey });
    const request = randomUUID(), allocated = await numbers(chOrg, request); expect(allocated).toMatchObject({ start_value: 127, end_value: 128 }); expect(await numbers(chOrg, request)).toEqual(allocated);
    expect(await result('select public.zentra_claim_content_cleanup($1) result', [chOrg])).toEqual([{ sha256: orphan, storage_key: expect.any(String) }]);
    expect((await asRole('select profile from public.zentra_company_profiles where organization_id=$1', [chOrg]))[0]).toEqual({ profile: (initialCH.zentra_company_profiles[0] as Row).profile });
    expect(await asRole('select revision from public.zentra_workspace_country_configs where organization_id=$1', [chOrg])).toEqual([]);
  });
  it('admits and replays a new US parent while refusing adoption of the unchanged CH parent', async () => {
    const before = await legacyState(chOrg), us = await admit(); expect(us.receipt).toMatchObject({ organizationId: us.org, replayed: false });
    expect(await us.invoke()).toEqual({ ...us.receipt, replayed: true });
    await expect(admit(chOrg)).rejects.toMatchObject({ code: 'PA003' }); expect(await legacyState(chOrg)).toEqual(before);
    expect(await asRole('select revision,snapshot_id,number_floors from public.zentra_workspaces where organization_id=$1', [us.org])).toEqual([{ revision: 0, snapshot_id: null, number_floors: [] }]);
  });
  it('refuses all five legacy RPCs and direct legacy writes for admitted US without changing either tenant', async () => {
    const beforeCH = await legacyState(chOrg), us = await admit(), beforeUS = await legacyState(us.org), snapshotId = randomUUID();
    for (const task of [() => commit(us.org, snapshotId, us.userId), () => numbers(us.org, randomUUID()), () => prepare(us.org, snapshotId, 0, us.userId), () => reserveBlob(us.org, snapshotId, us.userId), () => result('select public.zentra_claim_content_cleanup($1) result', [us.org])]) await expect(task()).rejects.toMatchObject({ code: 'PA004' });
    await expect(asRole('update public.zentra_workspaces set revision=1 where organization_id=$1', [us.org])).rejects.toMatchObject({ code: 'PA004' });
    await expect(asRole("insert into public.zentra_workspace_content_blobs(organization_id,sha256,size_bytes,state) values($1,$2,3,'uploading')", [us.org, part.sha256])).rejects.toMatchObject({ code: 'PA004' });
    expect(await legacyState(us.org)).toEqual(beforeUS); expect(await legacyState(chOrg)).toEqual(beforeCH);
  });
  it('initializes and replays a real schema4 US book and contiguous delta without crossing into CH', async () => {
    const beforeCH = await legacyState(chOrg), us = await admit();
    const parameters: Record<string, string[]> = { zentra_read_us_erp_v4: ['p_organization'], zentra_us_erp_receipt_v4: ['p_organization', 'p_idempotency_key'], zentra_commit_us_erp: ['p_organization', 'p_expected_revision', 'p_header', 'p_changes', 'p_ledger_audit', 'p_receipt', 'p_actor'] };
    const client: Pick<SupabaseServerClient, 'rpc'> = { async rpc<T>(name: string, input: Record<string, unknown>): Promise<T> {
      const keys = parameters[name]; if (!keys) throw new Error('Unexpected local chain RPC');
      return result<T>(`select public.${name}(${keys.map((_, i) => `$${i + 1}`).join(',')}) result`, keys.map(k => typeof input[k] === 'object' ? JSON.stringify(input[k]) : input[k]));
    } };
    const store = createSupabaseErpStore(client, { supportedSchemaVersion: 4 }), actor: FinancialAuthority = { organizationId: us.org, userId: us.userId, role: 'owner', managementEntitled: true, timestamp: new Date().toISOString() };
    const dependencies = { store, configuration: us.configuration, actor, revalidate: async () => actor, taxProvider: async () => null };
    const request = { idempotencyKey: 'staging-chain-initialize', expectedRevision: 0, command: { type: 'initialize', periods: [{ id: '2026', start: '2026-01-01', end: '2026-12-31', status: 'open' }] } };
    const first = await executeErp(dependencies, request); expect(first).toMatchObject({ replayed: false, receipt: { revision: 1 } });
    expect(await executeErp(dependencies, request)).toEqual({ ...first, replayed: true }); expect(await store.read(us.org)).toMatchObject({ schemaVersion: 4, revision: 1, invoices: [], estimates: [] });
    expect(await result('select public.zentra_us_erp_delta_v4($1,0,10) result', [us.org])).toMatchObject({ schemaVersion: 4, fromRevision: 0, toRevision: 1, headRevision: 1, resetRequired: false, events: [{ revision: 1 }] });
    expect(await result('select public.zentra_read_us_erp_v4($1) result', [chOrg])).toBeNull(); expect(await legacyState(chOrg)).toEqual(beforeCH);
  });
  it('does not publish any private financial table through PostgreSQL publications', async () => {
    const published = (await db.query('select schemaname,tablename from pg_publication_tables where schemaname=\'public\' and tablename=any($1::text[])', [migrationTables])).rows;
    expect(published).toEqual([]);
  });
});
