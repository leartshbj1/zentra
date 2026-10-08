import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// Real collaboration/content/country DDL in isolated PostgreSQL WASM, never a
// reduced parent fixture or a production connection. PGlite serializes queries:
// these tests DO NOT prove races between two real PostgreSQL connections.
const moduleDirectory = process.env.PGLITE_MODULE_DIR;
const enabled = !!moduleDirectory && isAbsolute(moduleDirectory);
type Json = null | string | number | boolean | Json[] | JsonObject;
type JsonObject = { [key: string]: Json };
type Row = Record<string, unknown>;
type State = Record<string, JsonObject[]>;
type Sql = { exec(sql: string): Promise<unknown>; query(sql: string, values?: unknown[]): Promise<{ rows: Row[] }> };
type Database = Sql & { transaction<T>(task: (sql: Sql) => Promise<T>): Promise<T>; close(): Promise<void> };
type Intent = { organizationId: string; creationId: string; actorUserId: string; requestId: string; configuration: JsonObject; fingerprint: string };
let database: Database;
const bodies = new Map<string, string>();
const argumentNames = new Map<string, string[]>();
const legacyNames = ['zentra_commit_workspace', 'zentra_reserve_workspace_numbers', 'zentra_prepare_content', 'zentra_reserve_content_blob', 'zentra_claim_content_cleanup'];
const legacyTables = ['zentra_workspaces', 'zentra_workspace_snapshots', 'zentra_workspace_chunks', 'zentra_workspace_content_parts', 'zentra_workspace_content_blobs', 'zentra_workspace_number_reservations', 'zentra_workspace_country_configs', 'zentra_workspace_country_config_changes'];
const existingCHOrganization = randomUUID();
let existingCHBefore: State;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected a JSON object from the local database');
  return value as JsonObject;
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Expected a string from the local database');
  return value;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) throw new TypeError('Expected string argument names from the local database');
  return value as string[];
}
function configuration(organizationId: string): JsonObject {
  return { schemaVersion: 1, organizationId, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York',
    address: { country: 'US', line1: '10 Fictitious Avenue', postalCode: '10001', city: 'New York', subdivision: 'NY' },
    accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'unconfigured' }, ein: '12-3456789' };
}
function intention(): Intent {
  const organizationId = randomUUID();
  return { organizationId, creationId: randomUUID(), actorUserId: randomUUID(), requestId: randomUUID(), configuration: configuration(organizationId), fingerprint: hash(randomUUID()) };
}
async function asRole(role: 'service_role' | 'anon' | 'authenticated', sql: string, values?: unknown[]): Promise<Row[]> {
  return database.transaction(async transaction => {
    await transaction.exec(`set local role ${role}`);
    return (await transaction.query(sql, values)).rows;
  });
}
async function admit(intent: Intent, role: 'service_role' | 'anon' | 'authenticated' = 'service_role'): Promise<JsonObject> {
  return object((await asRole(role, 'select public.zentra_admit_new_us_workspace_v1($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::jsonb,$6) as receipt',
    [intent.organizationId, intent.creationId, intent.actorUserId, intent.requestId, JSON.stringify(intent.configuration), intent.fingerprint]))[0].receipt);
}
async function legacyParent(organizationId: string): Promise<void> {
  await asRole('service_role', "insert into public.zentra_workspaces(organization_id,updated_by) values($1,'fictitious-owner')", [organizationId]);
}
async function state(organizationId: string, tables = [...legacyTables, 'zentra_workspace_us_admissions']): Promise<State> {
  const result: State = {};
  for (const table of tables) {
    result[table] = (await database.query(`select to_jsonb(r) as row from public.${table} r where organization_id=$1 order by to_jsonb(r)::text`, [organizationId])).rows.map(row => object(row.row));
  }
  return result;
}
const part = { sha256: hash('synthetic bytes'), size_bytes: 3 };
const manifest = { format: 'zentra-cloud-backup', version: 1, app_version: '1.90.15', sha256: part.sha256, size_bytes: 3, chunks: [part] };
async function snapshot(organizationId: string): Promise<string> {
  const id = randomUUID();
  await asRole('service_role', 'insert into public.zentra_workspace_snapshots(organization_id,id,installation_id,created_by,base_revision,manifest,size_bytes) values($1,$2,\'fixture-pc\',\'fictitious-owner\',0,$3,3)', [organizationId, id, JSON.stringify(manifest)]);
  return id;
}

describe.runIf(enabled)('strict new US admission on complete local PostgreSQL schemas', () => {
  beforeAll(async () => {
    const manifest = object(JSON.parse(await readFile(join(moduleDirectory!, 'package.json'), 'utf8')));
    expect(manifest.name).toBe('@electric-sql/pglite');
    const { PGlite } = createRequire(import.meta.url)(join(moduleDirectory!, 'dist/index.cjs')) as { PGlite: new () => Database };
    database = new PGlite();
    await database.exec('create role anon; create role authenticated; create role service_role bypassrls; create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]); grant usage on schema public to service_role;');
    for (const name of ['202609140200_company_collaboration', '202609200300_company_content', '20261007194528_international_workspace_country_config']) {
      await database.exec(await readFile(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), 'utf8'));
    }
    // Existing CH records are created before the additive migration, including
    // prepared data, numbering and national receipts on the full old schemas.
    await legacyParent(existingCHOrganization);
    const existingSnapshot = await snapshot(existingCHOrganization);
    await asRole('service_role', 'insert into public.zentra_workspace_chunks values($1,$2,0,$3,3)', [existingCHOrganization, existingSnapshot, part.sha256]);
    await asRole('service_role', 'insert into public.zentra_workspace_content_parts values($1,$2,0,$3,3)', [existingCHOrganization, existingSnapshot, part.sha256]);
    await asRole('service_role', "insert into public.zentra_workspace_content_blobs(organization_id,sha256,size_bytes,state) values($1,$2,3,'uploading')", [existingCHOrganization, part.sha256]);
    await asRole('service_role', "select public.zentra_commit_workspace($1,$2,'fixture-pc','fictitious-owner')", [existingCHOrganization, existingSnapshot]);
    await asRole('service_role', "select public.zentra_reserve_workspace_numbers($1,'fixture-pc',$2,'F',2026,125,2)", [existingCHOrganization, randomUUID()]);
    const chConfiguration: JsonObject = { ...configuration(existingCHOrganization), country: 'CH', currency: 'CHF', language: 'fr', timeZone: 'Europe/Zurich',
      address: { country: 'CH', line1: '10 Rue Fictive', postalCode: '1201', city: 'Genève', subdivision: 'GE' } };
    delete chConfiguration.ein;
    await asRole('service_role', 'select public.zentra_put_workspace_country_config($1,$2,0,$3,$4)', [existingCHOrganization, 'fictitious-owner', randomUUID(), JSON.stringify(chConfiguration)]);
    existingCHBefore = await state(existingCHOrganization, legacyTables);
    for (const row of (await database.query("select proname,prosrc,proargnames from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname=any($1::text[])", [legacyNames])).rows) {
      bodies.set(string(row.proname), string(row.prosrc)); argumentNames.set(string(row.proname), strings(row.proargnames));
    }
    await database.exec(await readFile(new URL('../../supabase/migrations/20261008001726_new_us_workspace_admission.sql', import.meta.url), 'utf8'));
  }, 20_000);
  afterAll(async () => { await database?.close(); });

  it('preserves every pre-existing CH record and receipt after the additive migration', async () => {
    expect(await state(existingCHOrganization, legacyTables)).toEqual(existingCHBefore);
    expect((await state(existingCHOrganization)).zentra_workspace_us_admissions).toEqual([]);
  });

  it('allocates the full fresh parent, immutable proof and initial national receipt in one call, then replays exactly', async () => {
    const intent = intention(); const first = await admit(intent);
    expect(first).toEqual({ creationId: intent.creationId, organizationId: intent.organizationId, actorUserId: intent.actorUserId,
      requestId: intent.requestId, configurationFingerprint: intent.fingerprint, configuration: intent.configuration,
      revision: 1, updatedBy: intent.actorUserId, updatedAt: expect.any(String), replayed: false });
    expect(await admit(intent)).toEqual({ ...first, replayed: true });
    const stored = await state(intent.organizationId);
    expect(stored.zentra_workspaces).toHaveLength(1);
    expect(stored.zentra_workspaces[0]).toMatchObject({ revision: 0, snapshot_id: null, number_floors: [], updated_by: intent.actorUserId });
    expect(stored.zentra_workspace_us_admissions).toHaveLength(1);
    expect(stored.zentra_workspace_country_configs[0]).toMatchObject({ revision: 1, config: intent.configuration });
    expect(stored.zentra_workspace_country_config_changes).toHaveLength(1);
    expect(stored.zentra_workspace_country_config_changes[0]).toMatchObject({ request_id: intent.requestId, previous_revision: 0, revision: 1, previous_config: null, changed_by: intent.actorUserId, config: intent.configuration, changed_at: first.updatedAt });
    for (const table of ['zentra_workspace_snapshots', 'zentra_workspace_chunks', 'zentra_workspace_content_parts', 'zentra_workspace_content_blobs', 'zentra_workspace_number_reservations']) expect(stored[table]).toEqual([]);
  });

  it('ties every identity, opaque fingerprint and exact JSONB configuration to the replay', async () => {
    const intent = intention(); await admit(intent);
    const before = await state(intent.organizationId);
    for (const patch of [{ creationId: randomUUID() }, { actorUserId: randomUUID() }, { requestId: randomUUID() },
      { fingerprint: hash('changed') }, { configuration: { ...intent.configuration, invoiceNumberPrefix: 'OTHER' } }]) {
      await expect(admit({ ...intent, ...patch })).rejects.toMatchObject({ code: 'PA002' });
    }
    const anotherOrg = randomUUID();
    await expect(admit({ ...intent, organizationId: anotherOrg, configuration: configuration(anotherOrg) })).rejects.toMatchObject({ code: 'PA002' });
    expect((await state(anotherOrg)).zentra_workspaces).toEqual([]);
    const anotherCreation = intention();
    await expect(admit({ ...anotherCreation, actorUserId: intent.actorUserId, requestId: intent.requestId })).rejects.toMatchObject({ code: 'PA002' });
    expect((await state(anotherCreation.organizationId)).zentra_workspaces).toEqual([]);
    expect(await state(intent.organizationId)).toEqual(before);
    const reordered = Object.fromEntries(Object.entries(intent.configuration).reverse());
    expect((await admit({ ...intent, configuration: reordered })).replayed).toBe(true);
  });

  it.each(['empty', 'snapshot-and-chunk', 'prepared-content', 'numbering'] as const)('rejects a pre-existing %s parent without adopting or changing anything', async variant => {
    const intent = intention(); await legacyParent(intent.organizationId);
    if (variant === 'snapshot-and-chunk' || variant === 'prepared-content') {
      const id = await snapshot(intent.organizationId);
      if (variant === 'snapshot-and-chunk') await asRole('service_role', 'insert into public.zentra_workspace_chunks values($1,$2,0,$3,3)', [intent.organizationId, id, part.sha256]);
      else {
        await asRole('service_role', 'insert into public.zentra_workspace_content_parts values($1,$2,0,$3,3)', [intent.organizationId, id, part.sha256]);
        await asRole('service_role', "insert into public.zentra_workspace_content_blobs(organization_id,sha256,size_bytes,state) values($1,$2,3,'uploading')", [intent.organizationId, part.sha256]);
      }
    }
    if (variant === 'numbering') {
      await asRole('service_role', 'update public.zentra_workspaces set number_floors=$2 where organization_id=$1', [intent.organizationId, JSON.stringify([{ prefix: 'F', year: 2026, minimum: 125 }])]);
      await asRole('service_role', "insert into public.zentra_workspace_number_reservations values($1,$2,'fixture-pc','F',2026,125,1,125,125)", [intent.organizationId, randomUUID()]);
    }
    const before = await state(intent.organizationId);
    await expect(admit(intent)).rejects.toMatchObject({ code: 'PA003' });
    expect(await state(intent.organizationId)).toEqual(before);
  });

  it('refuses invalid country, tax readiness, organization binding and fingerprint without creating partial records', async () => {
    for (const change of [{ fingerprint: 'bad' }, { fingerprint: 'A'.repeat(64) }, { configuration: { country: 'CH', currency: 'CHF' } },
      { configuration: { taxConfiguration: { status: 'configured' } } }, { configuration: { organizationId: randomUUID() } }, { configuration: { unexpected: true } }]) {
      const intent = intention();
      const changed = { ...intent, ...change, configuration: { ...intent.configuration, ...change.configuration } };
      await expect(admit(changed)).rejects.toMatchObject({ code: 'PA001' });
      expect((await state(intent.organizationId)).zentra_workspaces).toEqual([]);
    }
  });

  it('rolls back the strict parent and proof when the national receipt insert fails', async () => {
    const intent = intention();
    await database.exec("create function public.fixture_fail_country_receipt() returns trigger language plpgsql as $$ begin raise exception 'fixture_lost_receipt'; end $$; create trigger fixture_fail_country_receipt before insert on public.zentra_workspace_country_config_changes for each row execute function public.fixture_fail_country_receipt();");
    try { await expect(admit(intent)).rejects.toThrow('fixture_lost_receipt'); }
    finally { await database.exec('drop trigger fixture_fail_country_receipt on public.zentra_workspace_country_config_changes; drop function public.fixture_fail_country_receipt();'); }
    const stored = await state(intent.organizationId);
    for (const rows of Object.values(stored)) expect(rows).toEqual([]);
    expect((await admit(intent)).replayed).toBe(false);
  });

  it('keeps the admission immutable and refuses service-role direct proof writes or role escalation', async () => {
    const intent = intention(); await admit(intent); const before = await state(intent.organizationId);
    await expect(asRole('service_role', "insert into public.zentra_workspace_us_admissions select * from public.zentra_workspace_us_admissions where organization_id=$1", [intent.organizationId])).rejects.toMatchObject({ code: '42501' });
    await expect(asRole('service_role', 'update public.zentra_workspace_us_admissions set fingerprint=$2 where organization_id=$1', [intent.organizationId, hash('changed')])).rejects.toMatchObject({ code: '42501' });
    await expect(asRole('service_role', 'delete from public.zentra_workspace_us_admissions where organization_id=$1', [intent.organizationId])).rejects.toMatchObject({ code: '42501' });
    // SET ROLE keeps the original session user's powers. Authenticate this
    // local session as service_role so the fixture superuser cannot mask a grant.
    try {
      await expect(database.transaction(async tx => { await tx.exec('set local session authorization service_role'); await tx.exec('set local role zentra_us_admission_owner'); })).rejects.toMatchObject({ code: '42501' });
    } finally { await database.exec('set session authorization postgres; reset role;'); }
    expect((await database.query('select current_user,session_user')).rows[0]).toEqual({ current_user: 'postgres', session_user: 'postgres' });
    await expect(database.query('update public.zentra_workspace_us_admissions set fingerprint=$2 where organization_id=$1', [intent.organizationId, hash('changed')])).rejects.toMatchObject({ code: 'PA006' });
    await expect(database.query('delete from public.zentra_workspace_us_admissions where organization_id=$1', [intent.organizationId])).rejects.toMatchObject({ code: 'PA006' });
    expect(await state(intent.organizationId)).toEqual(before);
    const owner = (await database.query("select rolcanlogin,rolsuper,rolinherit,rolbypassrls from pg_catalog.pg_roles where rolname='zentra_us_admission_owner'")).rows[0];
    expect(owner).toEqual({ rolcanlogin: false, rolsuper: false, rolinherit: false, rolbypassrls: false });
  });

  it.each(['anon', 'authenticated'] as const)('denies %s every admission API/table and direct private definer path', async role => {
    const intent = intention();
    await expect(admit(intent, role)).rejects.toMatchObject({ code: '42501' });
    await expect(asRole(role, 'select * from public.zentra_workspace_us_admissions')).rejects.toMatchObject({ code: '42501' });
    await expect(asRole(role, 'select zentra_admission_private.admit_new_us_workspace_v1($1,$2,$3,$4,$5,$6)', [intent.organizationId, intent.creationId, intent.actorUserId, intent.requestId, JSON.stringify(intent.configuration), intent.fingerprint])).rejects.toMatchObject({ code: '42501' });
    expect((await state(intent.organizationId)).zentra_workspaces).toEqual([]);
  });

  it('requires an exact durable admission for ordinary initial US country RPC and direct receipt/config writes', async () => {
    const intent = intention(); await legacyParent(intent.organizationId); const before = await state(intent.organizationId);
    await expect(asRole('service_role', 'select public.zentra_put_workspace_country_config($1,$2,0,$3,$4)', [intent.organizationId, intent.actorUserId, intent.requestId, JSON.stringify(intent.configuration)])).rejects.toMatchObject({ code: 'PA005' });
    await expect(asRole('service_role', 'insert into public.zentra_workspace_country_config_changes(organization_id,request_id,previous_revision,revision,previous_config,config,changed_by) values($1,$2,0,1,null,$3,$4)', [intent.organizationId, intent.requestId, JSON.stringify(intent.configuration), intent.actorUserId])).rejects.toMatchObject({ code: 'PA005' });
    await expect(asRole('service_role', "insert into public.zentra_workspace_country_configs(organization_id,config,country,currency,revision,updated_by) values($1,$2,'US','USD',1,$3)", [intent.organizationId, JSON.stringify(intent.configuration), intent.actorUserId])).rejects.toMatchObject({ code: 'PA005' });
    expect(await state(intent.organizationId)).toEqual(before);
  });

  it('blocks every legacy direct write, ON CONFLICT parent preparation and legacy RPC on an admitted US workspace', async () => {
    const intent = intention(); await admit(intent); const before = await state(intent.organizationId); const snapshotId = randomUUID();
    const writes: [string, unknown[]][] = [
      ["insert into public.zentra_workspaces(organization_id,updated_by) values($1,'fixture') on conflict do nothing", [intent.organizationId]],
      ['update public.zentra_workspaces set revision=1 where organization_id=$1', [intent.organizationId]],
      ['update public.zentra_workspaces set number_floors=$2 where organization_id=$1', [intent.organizationId, '[{"prefix":"F","year":2026,"minimum":500}]']],
      ['delete from public.zentra_workspaces where organization_id=$1', [intent.organizationId]],
      ["insert into public.zentra_workspace_snapshots(organization_id,id,installation_id,created_by,base_revision,manifest,size_bytes) values($1,$2,'fixture','fixture',0,$3,3)", [intent.organizationId, snapshotId, JSON.stringify(manifest)]],
      ['insert into public.zentra_workspace_chunks values($1,$2,0,$3,3)', [intent.organizationId, snapshotId, part.sha256]],
      ['insert into public.zentra_workspace_content_parts values($1,$2,0,$3,3)', [intent.organizationId, snapshotId, part.sha256]],
      ["insert into public.zentra_workspace_content_blobs(organization_id,sha256,size_bytes,state) values($1,$2,3,'uploading')", [intent.organizationId, part.sha256]],
      ["insert into public.zentra_workspace_number_reservations values($1,$2,'fixture','F',2026,1,1,1,1)", [intent.organizationId, randomUUID()]],
      ["select public.zentra_commit_workspace($1,$2,'fixture','fixture')", [intent.organizationId, snapshotId]],
      ["select public.zentra_reserve_workspace_numbers($1,'fixture',$2,'F',2026,1,1)", [intent.organizationId, randomUUID()]],
      ["select public.zentra_prepare_content($1,$2,'fixture','fixture',0,$3,$4,$5,true,'[]')", [intent.organizationId, snapshotId, JSON.stringify(manifest), JSON.stringify([part]), hash('manifest')]],
      ["select public.zentra_reserve_content_blob($1,$2,'fixture','fixture',$3,3)", [intent.organizationId, snapshotId, part.sha256]],
      ['select public.zentra_claim_content_cleanup($1)', [intent.organizationId]],
    ];
    for (const [sql, values] of writes) await expect(asRole('service_role', sql, values), sql).rejects.toMatchObject({ code: 'PA004' });
    expect(await state(intent.organizationId)).toEqual(before);
  });

  it('checks both old and new tenant ids on direct legacy parent and child updates', async () => {
    const legacy = randomUUID(); await legacyParent(legacy); const snapshotId = await snapshot(legacy);
    await asRole('service_role', 'insert into public.zentra_workspace_chunks values($1,$2,0,$3,3)', [legacy, snapshotId, part.sha256]);
    await asRole('service_role', 'insert into public.zentra_workspace_content_parts values($1,$2,0,$3,3)', [legacy, snapshotId, part.sha256]);
    await asRole('service_role', "insert into public.zentra_workspace_content_blobs(organization_id,sha256,size_bytes,state) values($1,$2,3,'ready')", [legacy, part.sha256]);
    const intent = intention(); await admit(intent); const before = await state(legacy);
    await expect(asRole('service_role', 'update public.zentra_workspaces set organization_id=$2 where organization_id=$1', [intent.organizationId, randomUUID()])).rejects.toMatchObject({ code: 'PA004' });
    await expect(asRole('service_role', 'update public.zentra_workspaces set organization_id=$2 where organization_id=$1', [legacy, intent.organizationId])).rejects.toMatchObject({ code: 'PA004' });
    for (const table of ['zentra_workspace_snapshots', 'zentra_workspace_chunks', 'zentra_workspace_content_parts', 'zentra_workspace_content_blobs']) {
      await expect(asRole('service_role', `update public.${table} set organization_id=$2 where organization_id=$1`, [legacy, intent.organizationId])).rejects.toMatchObject({ code: 'PA004' });
    }
    expect(await state(legacy)).toEqual(before);
  });

  it('preserves real CH content preparation, commit, deduplication and shared number receipts, with historical RPC bodies unchanged', async () => {
    const organizationId = randomUUID(), snapshotId = randomUUID();
    const prepare = (id: string, revision: number) => asRole('service_role', "select public.zentra_prepare_content($1,$2,'fixture-pc','fictitious-owner',$3,$4,$5,$6,true,$7) as receipt", [organizationId, id, revision, JSON.stringify(manifest), JSON.stringify([part]), hash('manifest'), JSON.stringify([{ prefix: 'F', year: 2026, minimum: 125 }])]);
    expect(object((await prepare(snapshotId, 0))[0].receipt).missing).toEqual([part.sha256]);
    const reserved = object((await asRole('service_role', "select public.zentra_reserve_content_blob($1,$2,'fixture-pc','fictitious-owner',$3,3) as receipt", [organizationId, snapshotId, part.sha256]))[0].receipt);
    expect(reserved.ready).toBe(false);
    await asRole('service_role', "update public.zentra_workspace_content_blobs set state='ready' where organization_id=$1", [organizationId]);
    const commit = (await asRole('service_role', "select public.zentra_commit_workspace($1,$2,'fixture-pc','fictitious-owner') as receipt", [organizationId, snapshotId]))[0].receipt;
    expect(commit).toMatchObject({ committed: true, revision: 1, snapshotId });
    expect(object((await prepare(randomUUID(), 1))[0].receipt).missing).toEqual([]);
    const requestId = randomUUID();
    const number = () => asRole('service_role', "select public.zentra_reserve_workspace_numbers($1,'fixture-pc',$2,'F',2026,1,2) as receipt", [organizationId, requestId]);
    const first = (await number())[0].receipt; expect(first).toMatchObject({ start_value: 125, end_value: 126 });
    expect((await number())[0].receipt).toEqual(first);
    expect((await asRole('service_role', 'select public.zentra_claim_content_cleanup($1) as receipt', [organizationId]))[0].receipt).toEqual([]);
    for (const row of (await database.query("select proname,prosrc from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='zentra_admission_private' and proname=any($1::text[])", [legacyNames])).rows) expect(row.prosrc).toBe(bodies.get(string(row.proname)));
    for (const row of (await database.query("select proname,proargnames from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname=any($1::text[])", [legacyNames])).rows) expect(row.proargnames).toEqual(argumentNames.get(string(row.proname)));
    const functions = (await database.query("select n.nspname,p.prosecdef,pg_catalog.pg_get_userbyid(p.proowner) as owner,p.proconfig from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where p.proname in ('zentra_admit_new_us_workspace_v1','admit_new_us_workspace_v1') order by n.nspname")).rows;
    expect(functions).toEqual([
      { nspname: 'public', prosecdef: false, owner: expect.any(String), proconfig: ['search_path=""'] },
      { nspname: 'zentra_admission_private', prosecdef: true, owner: 'zentra_us_admission_owner', proconfig: ['search_path=""'] },
    ]);
  });

  it('replays the immutable initial configuration after a subsequent permitted US country update', async () => {
    const intent = intention(); const first = await admit(intent);
    const updated = { ...intent.configuration, address: { ...object(intent.configuration.address), line1: '20 Fictitious Avenue' }, ein: '98-7654321' };
    expect(object((await asRole('service_role', 'select public.zentra_put_workspace_country_config($1,$2,1,$3,$4) as receipt', [intent.organizationId, intent.actorUserId, randomUUID(), JSON.stringify(updated)]))[0].receipt).revision).toBe(2);
    expect(await admit(intent)).toEqual({ ...first, replayed: true });
    expect((await state(intent.organizationId)).zentra_workspace_country_configs[0].config).toEqual(updated);
  });

  it('retains the country updater and rejects US to CH, CH to US and old/new tenant reassignment', async () => {
    const intent = intention(); await admit(intent);
    const usBefore = await state(intent.organizationId);
    const chBefore = await state(existingCHOrganization);
    const anotherOrganization = randomUUID(); await legacyParent(anotherOrganization);
    const chForUS: JsonObject = { ...object(existingCHBefore.zentra_workspace_country_configs[0].config), organizationId: intent.organizationId };
    await expect(asRole('service_role', 'select public.zentra_put_workspace_country_config($1,$2,1,$3,$4)', [intent.organizationId, intent.actorUserId, randomUUID(), JSON.stringify(chForUS)])).rejects.toMatchObject({ code: 'PZ003' });
    await expect(asRole('service_role', "update public.zentra_workspace_country_configs set config=$2,country='CH',currency='CHF',revision=2 where organization_id=$1", [intent.organizationId, JSON.stringify(chForUS)])).rejects.toMatchObject({ code: 'PZ003' });
    await expect(asRole('service_role', 'select public.zentra_put_workspace_country_config($1,$2,1,$3,$4)', [existingCHOrganization, 'fictitious-owner', randomUUID(), JSON.stringify(configuration(existingCHOrganization))])).rejects.toMatchObject({ code: 'PZ003' });
    for (const source of [intent.organizationId, existingCHOrganization]) {
      await expect(asRole('service_role', 'update public.zentra_workspace_country_configs set organization_id=$2,config=$3,revision=2 where organization_id=$1', [source, anotherOrganization, JSON.stringify(configuration(anotherOrganization))])).rejects.toMatchObject({ code: 'PZ003' });
    }
    expect(await state(intent.organizationId)).toEqual(usBefore);
    expect(await state(existingCHOrganization)).toEqual(chBefore);
    expect((await state(anotherOrganization)).zentra_workspace_country_configs).toEqual([]);
  });
});
