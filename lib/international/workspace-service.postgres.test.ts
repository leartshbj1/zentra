import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { AccountPublicError } from '../account-security';
import { SupabaseServerError, type SupabaseQuery } from '../supabase-server';
import { getWorkspaceCountry, putWorkspaceCountry, type WorkspaceCountryActor, type WorkspaceCountryStore } from './workspace-service';
import { createWorkspaceCountryHandlers } from './workspace-server';
import { publicCompanyConfiguration } from './public-projection';
import type { CompanyConfiguration } from './types';

// Explicit opt-in, isolated in-memory PostgreSQL WASM. No live database URL,
// key, production identity, PostgREST connection or persistent directory.
const moduleDirectory = process.env.PGLITE_MODULE_DIR;
const enabled = !!moduleDirectory && isAbsolute(moduleDirectory);
type Sql = { exec(sql: string): Promise<unknown>; query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> };
type Database = Sql & { transaction<T>(task: (sql: Sql) => Promise<T>): Promise<T>; close(): Promise<void> };
const databases: Database[] = [];
afterEach(async () => { await Promise.all(databases.splice(0).map(database => database.close())); });
const org = 'fictitious-country-postgres';
const actor: WorkspaceCountryActor = { organizationId: org, userId: 'fictitious-owner', role: 'owner' };
const configuration: CompanyConfiguration = {
  schemaVersion: 1, organizationId: org, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York',
  address: { country: 'US', line1: '10 Fictitious Avenue', postalCode: '10001', city: 'New York', subdivision: 'NY' },
  accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'unconfigured' }, ein: '12-3456789',
};
const requestId = (number: number) => `10000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
async function fixture(initial = configuration) {
  const manifest = JSON.parse(await readFile(join(moduleDirectory!, 'package.json'), 'utf8'));
  expect(manifest.name).toBe('@electric-sql/pglite');
  const { PGlite } = createRequire(import.meta.url)(join(moduleDirectory!, 'dist/index.cjs')) as { PGlite: new () => Database };
  const database = new PGlite(); databases.push(database);
  await database.exec(`create role anon; create role authenticated; create role service_role;
    create table public.zentra_workspaces(organization_id text primary key);
    grant usage on schema public to service_role;
    grant select,update on public.zentra_workspaces to service_role;`);
  await database.query('insert into public.zentra_workspaces(organization_id) values ($1),($2)', [org, 'fictitious-foreign-country']);
  await database.exec(await readFile(new URL('../../supabase/migrations/20261007194528_international_workspace_country_config.sql', import.meta.url), 'utf8'));
  const calls: { operation: string; parameters: unknown }[] = [];
  let loseResponse = false;
  const store: WorkspaceCountryStore = {
    async select<T>(table: string, query?: SupabaseQuery): Promise<T[]> {
      const fields = query instanceof URLSearchParams ? Object.fromEntries(query.entries()) : query;
      if (!fields || fields.limit !== 1 || typeof fields.organization_id !== 'string' || !fields.organization_id.startsWith('eq.')) throw new Error('Unexpected synthetic query scope');
      const organizationId = fields.organization_id.slice(3);
      const sql = table === 'zentra_workspaces' ? 'select organization_id from public.zentra_workspaces where organization_id=$1 limit 1'
        : table === 'zentra_workspace_country_configs' ? 'select organization_id,schema_version,config,country,currency,revision::float8 as revision,updated_by,updated_at::text as updated_at from public.zentra_workspace_country_configs where organization_id=$1 limit 1'
        : table === 'zentra_workspace_country_config_changes' ? 'select organization_id,revision::float8 as revision,config from public.zentra_workspace_country_config_changes where organization_id=$1 and revision=$2 limit 1'
        : null;
      if (!sql) throw new Error('Unexpected synthetic relation');
      const values: unknown[] = [organizationId];
      if (table === 'zentra_workspace_country_config_changes') {
        if (typeof fields.revision !== 'string' || !/^eq\.[0-9]+$/.test(fields.revision)) throw new Error('Unexpected synthetic revision scope');
        values.push(fields.revision.slice(3));
      }
      calls.push({ operation: table, parameters: fields });
      try { return await database.transaction(async transaction => { await transaction.exec('set local role service_role'); return (await transaction.query<T>(sql, values)).rows; }); }
      catch (error) { throw new SupabaseServerError(400, (error as { code?: string }).code ?? 'synthetic_sql_error'); }
    },
    async rpc<T>(name: string, parameters: Record<string, unknown>): Promise<T> {
      if (name !== 'zentra_put_workspace_country_config') throw new Error('Unexpected synthetic RPC');
      calls.push({ operation: name, parameters });
      try {
        const result = await database.transaction(async transaction => {
          await transaction.exec('set local role service_role');
          return (await transaction.query<{ result: T }>('select public.zentra_put_workspace_country_config($1,$2,$3,$4::uuid,$5::jsonb) as result', [parameters.p_organization, parameters.p_actor, parameters.p_expected_revision, parameters.p_request_id, JSON.stringify(parameters.p_config)])).rows[0].result;
        });
        if (loseResponse) { loseResponse = false; throw new SupabaseServerError(503, 'synthetic_lost_response'); }
        return result;
      } catch (error) { if (error instanceof SupabaseServerError) throw error; throw new SupabaseServerError(400, (error as { code?: string }).code ?? 'synthetic_sql_error'); }
    },
  };
  await putWorkspaceCountry(store, actor, { expectedRevision: 0, requestId: requestId(1), configuration: initial });
  calls.length = 0;
  const count = async () => (await database.query<{ count: number }>('select count(*)::integer as count from public.zentra_workspace_country_config_changes where organization_id=$1', [org])).rows[0].count;
  return { database, store, calls, count, loseNextResponse() { loseResponse = true; } };
}

describe.skipIf(!enabled)('country private baseline and real PostgreSQL RPC', () => {
  it('preserves omitted EIN, then replays the exact old receipt after a later private EIN change', async () => {
    const f = await fixture(); const publicUpdate = { expectedRevision: 1, requestId: requestId(2), configuration: { ...publicCompanyConfiguration(configuration), language: 'fr' } };
    const first = await putWorkspaceCountry(f.store, actor, publicUpdate); expect(first).toMatchObject({ revision: 2, replayed: false, configuration: { ein: '12-3456789', language: 'fr' } });
    await putWorkspaceCountry(f.store, actor, { expectedRevision: 2, requestId: requestId(3), configuration: { ...configuration, language: 'fr', ein: '98-7654321' } });
    const replay = await putWorkspaceCountry(f.store, actor, publicUpdate); expect(replay).toMatchObject({ revision: 2, replayed: true, configuration: { ein: '12-3456789' } });
    expect(await getWorkspaceCountry(f.store, actor)).toMatchObject({ revision: 3, configuration: { ein: '98-7654321' } }); expect(await f.count()).toBe(3);
    expect(f.calls.filter(call => call.operation === 'zentra_workspace_country_config_changes')).toHaveLength(2);
  });
  it('retries an uncertain response with the same private baseline and produces no duplicate history', async () => {
    const f = await fixture(); const update = { expectedRevision: 1, requestId: requestId(2), configuration: publicCompanyConfiguration(configuration) };
    f.loseNextResponse(); await expect(putWorkspaceCountry(f.store, actor, update)).rejects.toMatchObject({ code: 'service_unavailable' });
    const replay = await putWorkspaceCountry(f.store, actor, update); expect(replay).toMatchObject({ revision: 2, replayed: true, configuration: { ein: '12-3456789' } }); expect(await f.count()).toBe(2);
  });
  it('does not invent a tax identifier when the historical record did not have one', async () => {
    const f = await fixture(publicCompanyConfiguration(configuration));
    const receipt = await putWorkspaceCountry(f.store, actor, { expectedRevision: 1, requestId: requestId(2), configuration: publicCompanyConfiguration(configuration) });
    expect(receipt.configuration).not.toHaveProperty('ein'); expect(await f.count()).toBe(2);
  });
  it('keeps missing historical baselines as an explicit conflict without falling back to the head', async () => {
    const f = await fixture(); const beforeWrite = async () => { throw new Error('Must not reach admission with unavailable baseline'); };
    await expect(putWorkspaceCountry(f.store, actor, { expectedRevision: 999, requestId: requestId(2), configuration: publicCompanyConfiguration(configuration) }, beforeWrite)).rejects.toMatchObject({ code: 'revision_conflict', status: 409 });
    expect(f.calls.map(call => call.operation)).toEqual(['zentra_workspace_country_config_changes']); expect(await f.count()).toBe(1);
  });
  it('performs final admission after the SQL baseline wait, without translating a revocation to a storage error', async () => {
    const f = await fixture();
    const beforeWrite = async () => { expect(f.calls.at(-1)?.operation).toBe('zentra_workspace_country_config_changes'); throw new AccountPublicError('Fictitious revoked owner', 401); };
    await expect(putWorkspaceCountry(f.store, actor, { expectedRevision: 1, requestId: requestId(2), configuration: publicCompanyConfiguration(configuration) }, beforeWrite)).rejects.toMatchObject({ status: 401 });
    expect(await f.count()).toBe(1); expect(f.calls.some(call => call.operation === 'zentra_put_workspace_country_config')).toBe(false);
  });
  it('uses the actual HTTP handler, private historical hydration and public response projection together', async () => {
    const f = await fixture(); let authorizations = 0;
    const handlers = createWorkspaceCountryHandlers({
      enabled: () => true, user: async () => null, membership: async () => { throw new Error('Native-only synthetic test'); },
      deviceSession: async () => { authorizations++; if (authorizations === 2) expect(f.calls.at(-1)?.operation).toBe('zentra_workspace_country_config_changes'); return { ...actor, sessionId: 'fixture-session', installationId: 'fixture-installation', subscriptionId: 'fixture-subscription' }; },
      management: async () => true, rateLimit: async () => {}, requireInitialUsAdmission: async () => { throw new Error('No first US admission in this existing-config fixture'); }, store: () => f.store,
    });
    const publicUpdate = { expectedRevision: 1, requestId: requestId(2), configuration: { ...publicCompanyConfiguration(configuration), language: 'de' } };
    const response = await handlers.PUT(new Request(`https://zentraapp.ch/api/international/workspaces/${org}/country`, { method: 'PUT', headers: { Authorization: 'Bearer zds_fictitious_fixture', 'Content-Type': 'application/json' }, body: JSON.stringify(publicUpdate) }), org);
    expect(response.status).toBe(200); expect((await response.json() as { configuration: CompanyConfiguration }).configuration).not.toHaveProperty('ein'); expect(authorizations).toBe(2);
    expect(await getWorkspaceCountry(f.store, actor)).toMatchObject({ revision: 2, configuration: { ein: '12-3456789', language: 'de' } }); expect(await f.count()).toBe(2);
  });
  it('blocks a native session revoked while the historical SQL lookup was awaiting', async () => {
    const f = await fixture(); let revoked = false;
    const store: WorkspaceCountryStore = { ...f.store, async select<T>(table: string, query?: SupabaseQuery): Promise<T[]> {
      const rows = await f.store.select<T>(table, query); if (table === 'zentra_workspace_country_config_changes') revoked = true; return rows;
    } };
    const handlers = createWorkspaceCountryHandlers({
      enabled: () => true, user: async () => null, membership: async () => { throw new Error('Native-only synthetic test'); },
      deviceSession: async () => { if (revoked) throw new AccountPublicError('Fictitious device revocation during baseline wait', 401); return { ...actor, sessionId: 'fixture-session', installationId: 'fixture-installation', subscriptionId: 'fixture-subscription' }; },
      management: async () => true, rateLimit: async () => {}, requireInitialUsAdmission: async () => { throw new Error('Not an initial country write'); }, store: () => store,
    });
    const response = await handlers.PUT(new Request(`https://zentraapp.ch/api/international/workspaces/${org}/country`, { method: 'PUT', headers: { Authorization: 'Bearer zds_fictitious_fixture', 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: 1, requestId: requestId(2), configuration: publicCompanyConfiguration(configuration) }) }), org);
    expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: 'unauthorized' }); expect(await f.count()).toBe(1);
    expect(f.calls.some(call => call.operation === 'zentra_put_workspace_country_config')).toBe(false);
  });
  it.each(['anon', 'authenticated'])('does not grant %s the private baseline table or country writer', async role => {
    const f = await fixture();
    await expect(f.database.transaction(async transaction => { await transaction.exec(`set local role ${role}`); await transaction.query('select config from public.zentra_workspace_country_config_changes where organization_id=$1', [org]); })).rejects.toMatchObject({ code: '42501' });
    await expect(f.database.transaction(async transaction => { await transaction.exec(`set local role ${role}`); await transaction.query('select public.zentra_put_workspace_country_config($1,$2,1,$3::uuid,$4::jsonb)', [org, actor.userId, requestId(2), JSON.stringify(configuration)]); })).rejects.toMatchObject({ code: '42501' });
    expect(await f.count()).toBe(1);
  });
  it('keeps the private history immutable, so request baselines cannot drift', async () => {
    const f = await fixture();
    await expect(f.database.query('update public.zentra_workspace_country_config_changes set config=$1::jsonb where organization_id=$2', [JSON.stringify({ ...configuration, ein: '98-7654321' }), org])).rejects.toMatchObject({ code: 'PZ005' });
    expect(await getWorkspaceCountry(f.store, actor)).toMatchObject({ revision: 1, configuration: { ein: '12-3456789' } }); expect(await f.count()).toBe(1);
  });
});
