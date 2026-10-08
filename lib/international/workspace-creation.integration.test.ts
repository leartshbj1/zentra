import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { d1WorkspaceCreationStore } from './workspace-creation-d1';
import { createOrResumeUsWorkspace, publicWorkspaceCreation, WorkspaceCreationError, type WorkspaceCreationIntent, type WorkspaceCreationPorts, type WorkspaceCreationRequest } from './workspace-creation';
import type { CompanyConfiguration } from './types';

// Explicit local opt-in. SQLite uses every D1 migration 0000..0086; PostgreSQL
// uses real collaboration/content and the complete international SQL chain.
// No live URL, key, identity, persistent directory, network or production data.
// Node SQLite is not Cloudflare D1; PGlite is one serialized WASM connection.
// This proves local service/store/RPC compatibility and recovery, not distributed
// transactions, two-connection races, PostgREST or staging/production readiness.
const moduleDirectory = process.env.PGLITE_MODULE_DIR;
const enabled = !!moduleDirectory && isAbsolute(moduleDirectory);
type PgRow = Record<string, unknown>;
type PgSql = {
  exec(sql: string): Promise<unknown>;
  query<T = PgRow>(sql: string, parameters?: unknown[]): Promise<{ rows: T[] }>;
};
type PgDatabase = PgSql & { transaction<T>(task: (sql: PgSql) => Promise<T>): Promise<T>; close(): Promise<void> };
let postgres: PgDatabase;
const sqliteDatabases: DatabaseSync[] = [];
const actor = '10000000-0000-4000-8000-000000000011';
const chOrganization = '10000000-0000-4000-8000-000000000012';
const timestamp = '2026-10-08T02:00:00.000Z';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const legacyPgTables = [
  'zentra_workspaces', 'zentra_workspace_snapshots', 'zentra_workspace_chunks',
  'zentra_workspace_content_parts', 'zentra_workspace_content_blobs',
  'zentra_workspace_number_reservations', 'zentra_workspace_country_configs', 'zentra_workspace_country_config_changes',
];
const usBusinessTables = [
  'zentra_us_erp_heads', 'zentra_us_erp_records', 'zentra_us_erp_receipts', 'zentra_us_erp_ledger_audit',
  'zentra_us_erp_streams', 'zentra_us_erp_events',
  'zentra_us_tax_provider_bindings', 'zentra_us_tax_provider_binding_changes',
  'zentra_us_tax_operations', 'zentra_us_tax_invoice_links',
];
let chPgBefore: Record<string, unknown[]>;
let d1MigrationSources: { name: string; sql: string }[];
let internationalMigrations: string[];

function initialRequest(requestId = randomUUID()): WorkspaceCreationRequest {
  return {
    requestId, confirmationVersion: 1, companyName: 'Fictitious US company',
    configuration: {
      schemaVersion: 1, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York',
      address: { country: 'US', line1: '10 Fictitious Avenue', postalCode: '10001', city: 'New York', subdivision: 'NY' },
      accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'unconfigured' }, ein: '12-3456789',
    },
  };
}
async function serviceSql<T = PgRow>(sql: string, values?: unknown[]): Promise<T[]> {
  return postgres.transaction(async transaction => {
    await transaction.exec('set local role service_role');
    return (await transaction.query<T>(sql, values)).rows;
  });
}
async function pgRows(organizationId: string, tables = legacyPgTables): Promise<Record<string, unknown[]>> {
  const result: Record<string, unknown[]> = {};
  for (const table of tables) {
    result[table] = (await postgres.query<{ row: unknown }>(`select to_jsonb(r) as row from public.${table} r where organization_id=$1 order by to_jsonb(r)::text`, [organizationId])).rows.map(row => row.row);
  }
  return result;
}
function allNonIntentD1Rows(database: DatabaseSync): Record<string, unknown[]> {
  const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name<>'international_workspace_creation_intents' ORDER BY name").all();
  const result: Record<string, unknown[]> = {};
  for (const table of tables) {
    const name = String(table.name);
    const rows = database.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"').all();
    result[name] = rows;
  }
  return result;
}
async function seedPgCH(): Promise<void> {
  const snapshotId = randomUUID();
  const digest = hash('abc');
  const manifest = { format: 'zentra-cloud-backup', version: 1, app_version: '1.90.15', sha256: digest, size_bytes: 3, chunks: [{ sha256: digest, size_bytes: 3 }] };
  await serviceSql('insert into public.zentra_workspaces(organization_id,updated_by) values($1,$2)', [chOrganization, actor]);
  await serviceSql('insert into public.zentra_workspace_snapshots(organization_id,id,installation_id,created_by,base_revision,manifest,size_bytes) values($1,$2,$3,$4,0,$5,3)', [chOrganization, snapshotId, 'fictitious-ch-pc', actor, JSON.stringify(manifest)]);
  await serviceSql('insert into public.zentra_workspace_chunks values($1,$2,0,$3,3)', [chOrganization, snapshotId, digest]);
  await serviceSql('insert into public.zentra_workspace_content_parts values($1,$2,0,$3,3)', [chOrganization, snapshotId, digest]);
  await serviceSql("insert into public.zentra_workspace_content_blobs(organization_id,sha256,size_bytes,state) values($1,$2,3,'uploading')", [chOrganization, digest]);
  await serviceSql('select public.zentra_commit_workspace($1,$2,$3,$4)', [chOrganization, snapshotId, 'fictitious-ch-pc', actor]);
  await serviceSql("select public.zentra_reserve_workspace_numbers($1,$2,$3,'F',2026,125,2)", [chOrganization, 'fictitious-ch-pc', randomUUID()]);
  const configuration: CompanyConfiguration = {
    schemaVersion: 1, organizationId: chOrganization, country: 'CH', currency: 'CHF', language: 'fr', timeZone: 'Europe/Zurich',
    address: { country: 'CH', line1: '10 Rue Fictive', postalCode: '1201', city: 'Genève', subdivision: 'GE' },
    accountingBasis: 'accrual', invoiceNumberPrefix: 'F', taxConfiguration: { status: 'unconfigured' },
  };
  await serviceSql('select public.zentra_put_workspace_country_config($1,$2,0,$3,$4)', [chOrganization, actor, randomUUID(), JSON.stringify(configuration)]);
  chPgBefore = await pgRows(chOrganization);
}

async function fixture() {
  const sqlite = new DatabaseSync(':memory:'); sqliteDatabases.push(sqlite);
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const migration of d1MigrationSources) {
    try { sqlite.exec(migration.sql); }
    catch (error) { throw new Error(`Complete D1 schema failed at ${migration.name}`, { cause: error }); }
  }
  sqlite.prepare('INSERT INTO subscriptions(subscription_id,customer_id,price_id,status,current_period_end,updated_at,seat_limit) VALUES(?,?,?,?,0,0,1)').run('sub_fictitious_ch', 'cus_fictitious_ch', 'price_fictitious_ch', 'canceled');
  sqlite.prepare('INSERT INTO organizations(organization_id,name,subscription_id,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,0,0)').run(chOrganization, 'Entreprise CH fictive', 'sub_fictitious_ch', actor);
  sqlite.prepare("INSERT INTO organization_members(membership_id,organization_id,user_id,email,role,joined_at) VALUES(?,?,?,?,'owner',0)").run('mem_fictitious_ch', chOrganization, actor, 'owner@example.invalid');
  sqlite.prepare('INSERT INTO document_number_reservations(organization_id,request_id,installation_id,created_by,prefix,year,minimum,count,start_value,end_value,created_at) VALUES(?,?,?,?,?,2026,125,2,125,126,?)').run(chOrganization, randomUUID(), 'fictitious-ch-pc', actor, 'F', timestamp);
  const chD1Before = allNonIntentD1Rows(sqlite);
  let loseD1Confirmation = false;
  let losePgResponse = false;
  const adapter = {
    prepare(sql: string) {
      return { bind(...values: (string | number | null)[]) {
        return {
          async first() { return sqlite.prepare(sql).get(...values) ?? null; },
          async run() {
            const result = sqlite.prepare(sql).run(...values);
            if (loseD1Confirmation && sql.startsWith('UPDATE international_workspace_creation_intents') && Number(result.changes) === 1) {
              loseD1Confirmation = false;
              throw new Error('Fictitious D1 response lost after committed confirmation');
            }
            return { success: true, meta: { changes: Number(result.changes) } };
          },
        };
      } };
    },
  } as unknown as Pick<D1Database, 'prepare'>;
  const receipts: unknown[] = [];
  const allocateId = vi.fn(() => randomUUID());
  const admit = vi.fn(async (intent: WorkspaceCreationIntent) => {
    try {
      const rows = await serviceSql<{ receipt: unknown }>('select public.zentra_admit_new_us_workspace_v1($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::jsonb,$6) as receipt', [intent.organizationId, intent.creationId, intent.actorUserId, intent.requestId, JSON.stringify(intent.configuration), intent.fingerprint]);
      receipts.push(rows[0].receipt);
      if (losePgResponse) { losePgResponse = false; throw new Error('Fictitious PG response lost after committed admission'); }
      return rows[0].receipt;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code === 'PA003') throw new WorkspaceCreationError('workspace_not_new', 409);
      if (code === 'PA002') throw new WorkspaceCreationError('request_id_conflict', 409);
      throw new WorkspaceCreationError('service_unavailable', 503);
    }
  });
  const ports: WorkspaceCreationPorts = {
    store: d1WorkspaceCreationStore(adapter), allocateId, now: () => timestamp,
    fingerprint: async value => hash(value), admit, revalidate: vi.fn(async () => undefined),
  };
  return {
    sqlite, ports, receipts, allocateId, admit, request: initialRequest(),
    loseNextPgResponse() { losePgResponse = true; },
    loseNextD1ConfirmationResponse() { loseD1Confirmation = true; },
    restartStore(): WorkspaceCreationPorts { return { ...ports, store: d1WorkspaceCreationStore(adapter) }; },
    async unchangedCH() {
      expect(allNonIntentD1Rows(sqlite)).toEqual(chD1Before);
      expect(await pgRows(chOrganization)).toEqual(chPgBefore);
      expect((await pgRows(chOrganization, ['zentra_workspace_us_admissions'])).zentra_workspace_us_admissions).toEqual([]);
    },
  };
}
async function assertSinglePending(f: Awaited<ReturnType<typeof fixture>>, intent: WorkspaceCreationIntent): Promise<void> {
  expect(intent.state).toBe('postgres_confirmed');
  const row = f.sqlite.prepare('SELECT * FROM international_workspace_creation_intents WHERE organization_id=?').get(intent.organizationId);
  expect(row).toMatchObject({ state: 'postgres_confirmed', actor_user_id: actor, request_id: f.request.requestId, own_subscription_id: null });
  expect(f.sqlite.prepare('SELECT count(*) total FROM international_workspace_creation_intents').get()).toEqual({ total: 1 });
  for (const table of ['organizations', 'organization_members', 'device_sessions', 'document_number_reservations']) {
    expect(f.sqlite.prepare(`SELECT count(*) total FROM ${table} WHERE organization_id=?`).get(intent.organizationId)).toEqual({ total: 0 });
  }
  const pg = await pgRows(intent.organizationId, [...legacyPgTables, 'zentra_workspace_us_admissions', ...usBusinessTables]);
  expect(pg.zentra_workspaces).toHaveLength(1);
  expect(pg.zentra_workspaces[0]).toMatchObject({ organization_id: intent.organizationId, revision: 0, snapshot_id: null, number_floors: [], updated_by: actor });
  expect(pg.zentra_workspace_us_admissions).toHaveLength(1);
  expect(pg.zentra_workspace_country_configs).toHaveLength(1);
  expect(pg.zentra_workspace_country_config_changes).toHaveLength(1);
  expect(pg.zentra_workspace_country_config_changes[0]).toMatchObject({ request_id: f.request.requestId, previous_revision: 0, revision: 1, changed_by: actor, config: intent.configuration, changed_at: intent.receipt?.updatedAt });
  for (const table of [...legacyPgTables.filter(name => !['zentra_workspaces', 'zentra_workspace_country_configs', 'zentra_workspace_country_config_changes'].includes(name)), ...usBusinessTables]) expect(pg[table]).toEqual([]);
  await f.unchangedCH();
}

describe.runIf(enabled)('US creation service → full SQLite D1 schema → real service-role PGlite RPC', () => {
  beforeAll(async () => {
    const files = (await readdir(new URL('../../drizzle/', import.meta.url))).filter(name => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 86).sort();
    expect(files.map(name => Number(name.slice(0, 4)))).toEqual(Array.from({ length: 87 }, (_, index) => index));
    d1MigrationSources = await Promise.all(files.map(async name => ({ name, sql: await readFile(new URL('../../drizzle/' + name, import.meta.url), 'utf8') })));
    const manifest = JSON.parse(await readFile(join(moduleDirectory!, 'package.json'), 'utf8')) as { name: string };
    expect(manifest.name).toBe('@electric-sql/pglite');
    const { PGlite } = createRequire(import.meta.url)(join(moduleDirectory!, 'dist/index.cjs')) as { PGlite: new () => PgDatabase };
    postgres = new PGlite();
    // storage.buckets is the local support table required by collaboration DDL;
    // no storage API or object upload is represented by this SQL-only fixture.
    await postgres.exec('create role anon; create role authenticated; create role service_role bypassrls; create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]); grant usage on schema public to service_role;');
    for (const name of ['202609140200_company_collaboration.sql', '202609200300_company_content.sql']) await postgres.exec(await readFile(new URL('../../supabase/migrations/' + name, import.meta.url), 'utf8'));
    internationalMigrations = (await readdir(new URL('../../supabase/migrations/', import.meta.url))).filter(name => /^2026100[78].*(?:international_|new_us_workspace_admission).*\.sql$/.test(name)).sort();
    expect(internationalMigrations).toEqual([
      '20261007194528_international_workspace_country_config.sql',
      '20261007222349_international_us_erp_persistence.sql',
      '20261007224820_international_us_erp_delta_stream.sql',
      '20261007225725_international_us_erp_seller_snapshot.sql',
      '20261008001726_new_us_workspace_admission.sql',
      '20261008013200_international_tax_proof_allowlist.sql',
      '20261008034422_international_us_seller_profile.sql',
      '20261008044402_international_us_tax_profile.sql',
      '20261008060826_international_us_tax_operations.sql',
    ]);
    for (const name of internationalMigrations) {
      await postgres.exec(await readFile(new URL('../../supabase/migrations/' + name, import.meta.url), 'utf8'));
      if (name === '20261007194528_international_workspace_country_config.sql') await seedPgCH();
    }
    expect(await pgRows(chOrganization)).toEqual(chPgBefore);
  }, 30_000);
  afterEach(() => { for (const sqlite of sqliteDatabases.splice(0)) sqlite.close(); });
  afterAll(async () => { await postgres?.close(); });

  it('validates the real RPC receipt and persists one pending creation without creating D1 access or altering CH', async () => {
    const f = await fixture();
    const saved = await createOrResumeUsWorkspace(actor, f.request, f.ports);
    expect(f.receipts[0]).toEqual({ creationId: saved.creationId, organizationId: saved.organizationId, actorUserId: actor, requestId: f.request.requestId, configurationFingerprint: saved.fingerprint, configuration: saved.configuration, revision: 1, updatedBy: actor, updatedAt: expect.any(String), replayed: false });
    expect(saved.receipt).toEqual(f.receipts[0]);
    expect(publicWorkspaceCreation(saved)).toMatchObject({ state: 'postgres_confirmed', setupStatus: 'us_subscription_required' });
    expect(publicWorkspaceCreation(saved).configuration.ein).toBeUndefined();
    await assertSinglePending(f, saved);
  });

  it('replays after restarting the D1 store without a second allocation or PG call', async () => {
    const f = await fixture(); const first = await createOrResumeUsWorkspace(actor, f.request, f.ports);
    const replay = await createOrResumeUsWorkspace(actor, f.request, f.restartStore());
    expect(replay).toEqual(first); expect(f.allocateId).toHaveBeenCalledTimes(2); expect(f.admit).toHaveBeenCalledOnce();
    await assertSinglePending(f, replay);
  });

  it('recovers a lost real PG commit response with the original parent, proof and initial receipt', async () => {
    const f = await fixture(); f.loseNextPgResponse();
    await expect(createOrResumeUsWorkspace(actor, f.request, f.ports)).rejects.toMatchObject({ code: 'service_unavailable', status: 503 });
    const reserved = await f.ports.store.find(actor, f.request.requestId);
    expect(reserved?.state).toBe('reserved'); expect(reserved?.receipt).toBeNull();
    const saved = await createOrResumeUsWorkspace(actor, f.request, f.restartStore());
    expect(saved.organizationId).toBe(reserved?.organizationId); expect(saved.creationId).toBe(reserved?.creationId);
    expect(saved.receipt?.replayed).toBe(true); expect(f.receipts[1]).toEqual({ ...f.receipts[0] as object, replayed: true });
    expect(f.allocateId).toHaveBeenCalledTimes(2); expect(f.admit).toHaveBeenCalledTimes(2);
    await assertSinglePending(f, saved);
  });

  it('recovers a lost D1 UPDATE response after its real SQL commit without repeating PG admission', async () => {
    const f = await fixture(); f.loseNextD1ConfirmationResponse();
    await expect(createOrResumeUsWorkspace(actor, f.request, f.ports)).rejects.toMatchObject({ code: 'service_unavailable', status: 503 });
    const durable = await f.ports.store.find(actor, f.request.requestId);
    expect(durable?.state).toBe('postgres_confirmed');
    const saved = await createOrResumeUsWorkspace(actor, f.request, f.restartStore());
    expect(saved).toEqual(durable); expect(f.allocateId).toHaveBeenCalledTimes(2); expect(f.admit).toHaveBeenCalledOnce();
    await assertSinglePending(f, saved);
  });

  it('refuses a pre-existing PG parent while retaining a closed D1 reservation instead of adopting it', async () => {
    const f = await fixture(); const existing = randomUUID();
    await serviceSql('insert into public.zentra_workspaces(organization_id,updated_by) values($1,$2)', [existing, actor]);
    const before = await pgRows(existing, [...legacyPgTables, 'zentra_workspace_us_admissions']);
    f.allocateId.mockReturnValueOnce(existing);
    await expect(createOrResumeUsWorkspace(actor, f.request, f.ports)).rejects.toMatchObject({ code: 'workspace_not_new', status: 409 });
    const reserved = await f.ports.store.find(actor, f.request.requestId);
    expect(reserved).toMatchObject({ organizationId: existing, state: 'reserved', receipt: null });
    expect(f.sqlite.prepare('SELECT count(*) total FROM organizations WHERE organization_id=?').get(existing)).toEqual({ total: 0 });
    expect(await pgRows(existing, [...legacyPgTables, 'zentra_workspace_us_admissions'])).toEqual(before);
    await f.unchangedCH();
  });

  it('keeps the actual full-SQL ready fence closed after a successful national admission', async () => {
    const f = await fixture(); const saved = await createOrResumeUsWorkspace(actor, f.request, f.ports);
    expect(() => f.sqlite.prepare("UPDATE international_workspace_creation_intents SET state='ready',own_subscription_id='fictitious-not-entitled' WHERE creation_id=?").run(saved.creationId)).toThrow('international_us_ready_not_admitted');
    await assertSinglePending(f, saved);
  });
});
