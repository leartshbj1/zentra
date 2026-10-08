import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AccountPublicError } from '../account-security';
import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import { countryConfiguration } from './country-config';
import { countrySubdivisions } from './addresses';
import { getUsTaxProfile, putUsTaxProfile, resolveUsTaxConfiguration, validateUsTaxFacts, type TaxProfileStore, type TaxProfileActor, type UsTaxFacts, type UsTaxProfileReceipt } from './us-tax-profile';
import { createUsTaxProfileHandlers, type UsTaxProfileServerDependencies } from './us-tax-profile-server';
import { createErpHandlers, type ErpServerDependencies } from './runtime-server';
import { createErpSyncHandlers } from './runtime-sync-server';
import { createSupabaseErpStore } from './runtime-store';
import { createSupabaseErpSyncStore } from './runtime-sync-store';
import type { CompanyConfiguration } from './types';
import type { FinancialAuthority } from './accounting/ledger';
import type { ErpCommand, ErpState } from './runtime-types';
import type { ErpDelta } from './runtime-sync';

// SQL-local evidence only. PGlite serializes one in-memory PostgreSQL WASM
// instance: no restart/crash, two-connection, hosted Auth/D1/PostgREST or provider proof.
const moduleDirectory = process.env.PGLITE_MODULE_DIR;
const enabled = Boolean(moduleDirectory && isAbsolute(moduleDirectory));
const migration = '20261008044402_international_us_tax_profile';
type Sql = { exec(sql: string): Promise<unknown>; query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> };
type Database = Sql & { transaction<T>(task: (sql: Sql) => Promise<T>): Promise<T>; close(): Promise<void> };
let db: Database, legacyBefore: unknown;
const chOrg = randomUUID(), chActor = randomUUID();
const facts: UsTaxFacts = { schemaVersion: 1, legalName: 'Fictitious Private Legal Name', taxOrigin: { country: 'US', line1: '1 Fictitious Street', city: 'New York', subdivision: 'NY', postalCode: '10001' }, timeZone: 'America/New_York' };
const configuration = (organizationId: string) => ({ schemaVersion: 1, organizationId, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York', address: facts.taxOrigin, accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'unconfigured' } });
const asRole = <T = Record<string, unknown>>(role: 'service_role' | 'anon' | 'authenticated', sql: string, values?: unknown[]) => db.transaction(async tx => { await tx.exec(`set local role ${role}`); return (await tx.query<T>(sql, values)).rows; });
const rawPut = (org: string | null, actor: string | null, revision: number | null, requestId: string | null, input: unknown) => asRole<{ result: unknown }>('service_role', 'select public.zentra_put_us_tax_profile($1,$2,$3,$4::uuid,$5::jsonb) as result', [org, actor, revision, requestId, JSON.stringify(input)]);
const count = async (org: string) => Number((await db.query<{ count: number }>('select count(*)::integer as count from public.zentra_us_tax_profile_changes where organization_id=$1', [org])).rows[0].count);
async function snapshotCH() {
  return (await db.query('select to_jsonb(p) as profile,(select to_jsonb(w) from public.zentra_workspaces w where w.organization_id=p.organization_id) as workspace,(select to_jsonb(c) from public.zentra_workspace_country_configs c where c.organization_id=p.organization_id) as country from public.zentra_company_profiles p where p.organization_id=$1', [chOrg])).rows;
}
async function fixture() {
  const organizationId = randomUUID(), userId = randomUUID(), actor: TaxProfileActor = { organizationId, userId, role: 'owner' };
  await asRole('service_role', 'select public.zentra_admit_new_us_workspace_v1($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::jsonb,$6)', [organizationId, randomUUID(), userId, randomUUID(), JSON.stringify(configuration(organizationId)), createHash('sha256').update(organizationId).digest('hex')]);
  let lose = false;
  const store: TaxProfileStore = { async rpc<T>(name: string, parameters: Readonly<Record<string, unknown>>): Promise<T> {
    const write = name === 'zentra_put_us_tax_profile';
    if (!write && name !== 'zentra_read_us_tax_profile') throw new Error('Unexpected local tax declaration RPC');
    try {
      const result = await asRole<{ result: T }>('service_role', write ? 'select public.zentra_put_us_tax_profile($1,$2,$3,$4::uuid,$5::jsonb) as result' : 'select public.zentra_read_us_tax_profile($1) as result', write ? [parameters.p_organization, parameters.p_actor, parameters.p_expected_revision, parameters.p_request_id, JSON.stringify(parameters.p_facts)] : [parameters.p_organization]);
      if (write && lose) { lose = false; throw new SupabaseServerError(503, 'synthetic_response_lost'); }
      return result[0].result;
    } catch (error) {
      if (error instanceof SupabaseServerError) throw error;
      throw new SupabaseServerError(400, (error as { code?: string }).code ?? 'fixture_sql');
    }
  } };
  return { actor, store, request: (expectedRevision = 0, declaration: UsTaxFacts = facts) => ({ expectedRevision, requestId: randomUUID(), facts: declaration }), loseNext() { lose = true; } };
}
async function httpFixture() {
  const f = await fixture(), organizationId = f.actor.organizationId;
  let denied: 401 | 402 | 403 | undefined;
  const hooks: { afterRead?: () => void; afterWrite?: () => void } = {};
  const diagnostics: unknown[] = [];
  const actor: FinancialAuthority = { ...f.actor, managementEntitled: true, timestamp: '2026-10-08T12:00:00Z' };
  const store: TaxProfileStore = { async rpc<T>(name: string, parameters: Readonly<Record<string, unknown>>): Promise<T> {
    const result = await f.store.rpc<T>(name, parameters);
    if (name === 'zentra_put_us_tax_profile') hooks.afterWrite?.(); else hooks.afterRead?.();
    return result;
  } };
  const dependencies: UsTaxProfileServerDependencies = {
    enabled: () => true,
    authority: async () => {
      if (denied === 401) throw new AccountPublicError('Private synthetic session revoked', 401);
      return { mode: 'browser', actor: { ...actor, ...(denied === 402 ? { managementEntitled: false } : denied === 403 ? { role: 'read_only' as const } : {}) } };
    },
    configuration: async () => configuration(organizationId) as CompanyConfiguration,
    store: () => store, rateLimit: async () => {}, diagnostic: event => { diagnostics.push(event); },
  };
  const url = `https://zentra.test/api/international/workspaces/${organizationId}/tax-profile`;
  const read = () => new Request(url, { headers: { 'X-Zentra-Expected-User': actor.userId } });
  const put = (input: unknown, headers: Record<string, string> = {}) => new Request(url, { method: 'PUT', headers: { Origin: 'https://zentra.test', 'Content-Type': 'application/json', 'X-Zentra-Expected-User': actor.userId, ...headers }, body: JSON.stringify(input) });
  return { ...f, actor, hooks, diagnostics, dependencies, handler: createUsTaxProfileHandlers(dependencies), read, put, deny(status?: 401 | 402 | 403) { denied = status; } };
}
const erpQueries: Record<string, { sql: string; keys: string[] }> = {
  zentra_read_us_erp: { sql: 'select public.zentra_read_us_erp($1) as result', keys: ['p_organization'] },
  zentra_us_erp_receipt: { sql: 'select public.zentra_us_erp_receipt($1,$2) as result', keys: ['p_organization', 'p_idempotency_key'] },
  zentra_commit_us_erp: { sql: 'select public.zentra_commit_us_erp($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb) as result', keys: ['p_organization', 'p_expected_revision', 'p_header', 'p_changes', 'p_ledger_audit', 'p_receipt', 'p_actor'] },
  zentra_us_erp_revision: { sql: 'select public.zentra_us_erp_revision($1) as result', keys: ['p_organization'] },
  zentra_us_erp_delta: { sql: 'select public.zentra_us_erp_delta($1,$2,$3) as result', keys: ['p_organization', 'p_after_revision', 'p_limit'] },
};
const erpClient: Pick<SupabaseServerClient, 'rpc'> = { async rpc<T>(name: string, parameters: Record<string, unknown>): Promise<T> {
  const query = erpQueries[name]; if (!query) throw new Error('Unexpected local ERP RPC');
  try { return (await asRole<{ result: T }>('service_role', query.sql, query.keys.map(key => typeof parameters[key] === 'object' ? JSON.stringify(parameters[key]) : parameters[key])))[0].result; }
  catch (error) { throw new SupabaseServerError(400, (error as { code?: string }).code ?? 'fixture_sql'); }
} };
const factsWith = (key: string, value: unknown) => ({ ...facts, [key]: value });
const addressWith = (key: string, value: unknown) => ({ ...facts, taxOrigin: { ...facts.taxOrigin, [key]: value } });
const invalidFacts: unknown[] = [null, [], 1, {}, factsWith('schemaVersion', 2), factsWith('schemaVersion', '1'), factsWith('legalName', null), factsWith('legalName', ''), factsWith('legalName', '  '), factsWith('legalName', ' padded '), factsWith('legalName', 'a'.repeat(257)), factsWith('taxOrigin', null), factsWith('taxOrigin', []), factsWith('timeZone', 'UTC'), factsWith('timeZone', 'Europe/Zurich'), factsWith('timeZone', 'US/Eastern'), factsWith('timeZone', ' America/New_York'), factsWith('timeZone', null), addressWith('country', 'CH'), addressWith('line1', null), addressWith('line1', ''), addressWith('line1', 'a'.repeat(201)), addressWith('line2', null), addressWith('line2', ''), addressWith('city', 'a'.repeat(121)), addressWith('subdivision', 'PR'), addressWith('subdivision', 'ny'), addressWith('postalCode', '1000'), addressWith('postalCode', '10001-123'), addressWith('postalCode', '10001\n'), addressWith('registration', 'forged')];

describe.runIf(enabled)('private US tax declarations through real local PostgreSQL RPC', () => {
  beforeAll(async () => {
    expect(JSON.parse(await readFile(join(moduleDirectory!, 'package.json'), 'utf8')).name).toBe('@electric-sql/pglite');
    const { PGlite } = createRequire(import.meta.url)(join(moduleDirectory!, 'dist/index.cjs')) as { PGlite: new () => Database };
    db = new PGlite();
    await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);grant usage on schema public to service_role;');
    for (const name of ['202609140100_company_profiles', '202609140200_company_collaboration', '202609200300_company_content', '20261007194528_international_workspace_country_config']) await db.exec(await readFile(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), 'utf8'));
    await db.query('insert into public.zentra_workspaces(organization_id,updated_by) values($1,$2)', [chOrg, chActor]);
    await db.query('insert into public.zentra_company_profiles(organization_id,profile,updated_by) values($1,$2::jsonb,$3)', [chOrg, JSON.stringify({ company_name: 'Unchanged CH identity', private_identifier: 'fixture-only' }), chActor]);
    const chConfiguration = { ...configuration(chOrg), country: 'CH', currency: 'CHF', language: 'fr', timeZone: 'Europe/Zurich', address: { country: 'CH', line1: '1 Rue Fictive', city: 'Genève', subdivision: 'GE', postalCode: '1201' } };
    await db.query('select public.zentra_put_workspace_country_config($1,$2,0,$3::uuid,$4::jsonb)', [chOrg, chActor, randomUUID(), JSON.stringify(chConfiguration)]);
    legacyBefore = await snapshotCH();
    for (const name of ['20261007222349_international_us_erp_persistence', '20261007224820_international_us_erp_delta_stream', '20261007225725_international_us_erp_seller_snapshot', '20261008001726_new_us_workspace_admission', '20261008013200_international_tax_proof_allowlist', '20261008034422_international_us_seller_profile']) await db.exec(await readFile(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), 'utf8'));
    // Model Supabase's permissive defaults, proving this migration removes them.
    await db.exec('alter default privileges in schema public grant all on tables to anon,authenticated,service_role;alter default privileges in schema public grant all on functions to anon,authenticated,service_role;');
    await db.exec(await readFile(new URL(`../../supabase/migrations/${migration}.sql`, import.meta.url), 'utf8'));
  }, 20_000);
  afterAll(async () => { await db?.close(); });

  it('preserves the legacy CH workspace/profile/country after migration and declaration writes', async () => {
    const f = await fixture(); await putUsTaxProfile(f.store, f.actor, f.request());
    expect(await snapshotCH()).toEqual(legacyBefore);
    expect((await db.query('select * from public.zentra_us_tax_profiles where organization_id=$1', [chOrg])).rows).toEqual([]);
  });
  it('starts unset and persists only unverified private facts with an exact head receipt', async () => {
    const f = await fixture();
    expect(await getUsTaxProfile(f.store, f.actor)).toEqual({ status: 'unconfigured', organizationId: f.actor.organizationId, revision: 0, verification: 'unverified' });
    const input = f.request(), receipt = await putUsTaxProfile(f.store, f.actor, input);
    expect(receipt).toMatchObject({ status: 'declared', organizationId: f.actor.organizationId, revision: 1, facts, verification: 'unverified', updatedBy: f.actor.userId, requestId: input.requestId, replayed: false });
    expect(await getUsTaxProfile(f.store, f.actor)).toEqual({ status: 'declared', organizationId: f.actor.organizationId, revision: 1, facts, verification: 'unverified', updatedBy: f.actor.userId, updatedAt: receipt.updatedAt });
    expect(await count(f.actor.organizationId)).toBe(1);
    expect(Object.isFrozen(receipt.facts.taxOrigin)).toBe(true);
  });
  it('replays the old exact receipt after a newer declaration without changing the head', async () => {
    const f = await fixture(), input = f.request(), first = await putUsTaxProfile(f.store, f.actor, input);
    const newer = { ...facts, legalName: 'Newer Fictitious Legal Name' };
    await putUsTaxProfile(f.store, f.actor, f.request(1, newer));
    expect(await putUsTaxProfile(f.store, f.actor, input)).toEqual({ ...first, replayed: true });
    expect(await getUsTaxProfile(f.store, f.actor)).toMatchObject({ revision: 2, facts: newer, verification: 'unverified' });
    expect(await count(f.actor.organizationId)).toBe(2);
  });
  it('recovers an already committed declaration after a lost RPC response without a second row', async () => {
    const f = await fixture(), input = f.request(); f.loseNext();
    await expect(putUsTaxProfile(f.store, f.actor, input)).rejects.toMatchObject({ code: 'service_unavailable', status: 503 });
    expect(await count(f.actor.organizationId)).toBe(1);
    expect(await putUsTaxProfile(f.store, f.actor, input)).toMatchObject({ requestId: input.requestId, revision: 1, replayed: true });
    expect(await count(f.actor.organizationId)).toBe(1);
  });
  it.each(['actor', 'revision', 'facts'] as const)('rejects reuse of a request with changed %s and preserves the old receipt', async changed => {
    const f = await fixture(), input = f.request(), first = await putUsTaxProfile(f.store, f.actor, input);
    const actor = changed === 'actor' ? { ...f.actor, userId: randomUUID() } : f.actor;
    const write = changed === 'revision' ? { ...input, expectedRevision: 1 } : changed === 'facts' ? { ...input, facts: { ...facts, legalName: 'Changed facts' } } : input;
    await expect(putUsTaxProfile(f.store, actor, write)).rejects.toMatchObject({ code: 'request_id_conflict', status: 409 });
    expect(await putUsTaxProfile(f.store, f.actor, input)).toEqual({ ...first, replayed: true });
    expect(await count(f.actor.organizationId)).toBe(1);
  });
  it('rejects stale CAS and isolates the same UUID in two admitted US workspaces', async () => {
    const a = await fixture(), b = await fixture(), input = a.request();
    await putUsTaxProfile(a.store, a.actor, input);
    await expect(putUsTaxProfile(a.store, a.actor, a.request())).rejects.toMatchObject({ code: 'revision_conflict', status: 409 });
    await putUsTaxProfile(b.store, b.actor, input);
    expect(await count(a.actor.organizationId)).toBe(1); expect(await count(b.actor.organizationId)).toBe(1);
  });
  it('rolls back both receipt and head when a surrounding transaction fails', async () => {
    const f = await fixture(), input = f.request();
    await expect(db.transaction(async tx => { await tx.exec('set local role service_role'); await tx.query('select public.zentra_put_us_tax_profile($1,$2,0,$3::uuid,$4::jsonb)', [f.actor.organizationId, f.actor.userId, input.requestId, JSON.stringify(facts)]); throw new Error('synthetic transaction rollback'); })).rejects.toThrow('synthetic transaction rollback');
    expect(await count(f.actor.organizationId)).toBe(0);
    expect(await getUsTaxProfile(f.store, f.actor)).toMatchObject({ status: 'unconfigured', revision: 0 });
  });
  it('keeps the resolver blocked before and after a declaration, and never returns private facts', async () => {
    const f = await fixture(); expect(await resolveUsTaxConfiguration(f.store, f.actor)).toEqual({ status: 'blocked', reason: 'tax_details_required', organizationId: f.actor.organizationId, revision: 0 });
    await putUsTaxProfile(f.store, f.actor, f.request());
    expect(await resolveUsTaxConfiguration(f.store, f.actor)).toEqual({ status: 'blocked', reason: 'provider_verification_required', organizationId: f.actor.organizationId, revision: 1 });
  });
  it('refuses non-owner service calls and preserves a beforeWrite Auth error without SQL', async () => {
    const f = await fixture(), denied = new AccountPublicError('private fixture revocation', 401);
    await expect(putUsTaxProfile(f.store, f.actor, f.request(), async () => { throw denied; })).rejects.toBe(denied);
    for (const role of ['admin', 'accountant', 'member', 'read_only'] as const) {
      await expect(getUsTaxProfile(f.store, { ...f.actor, role })).rejects.toMatchObject({ code: 'forbidden', status: 403 });
      await expect(putUsTaxProfile(f.store, { ...f.actor, role }, f.request())).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    }
    expect(await count(f.actor.organizationId)).toBe(0);
  });
  it('freezes the declared request and actor before the asynchronous Auth hook', async () => {
    const f = await fixture(), actor = { ...f.actor }, input = { ...f.request(), facts: { ...facts, taxOrigin: { ...facts.taxOrigin } } };
    const receipt = await putUsTaxProfile(f.store, actor, input, async () => { actor.organizationId = 'foreign'; actor.userId = 'other-user'; input.facts.legalName = 'Modified during Auth'; input.facts.taxOrigin.city = 'Changed city'; });
    expect(receipt).toMatchObject({ organizationId: f.actor.organizationId, updatedBy: f.actor.userId, facts });
  });

  it('runs real HTTP GET/PUT through the service and SQL RPC, retaining an old exact receipt after a new head', async () => {
    const f = await httpFixture(), org = f.actor.organizationId, request = f.request();
    const unset = await f.handler.GET(f.read(), org); expect(unset.status).toBe(200);
    expect(await unset.json()).toEqual({ status: 'unconfigured', organizationId: org, revision: 0, verification: 'unverified' });
    const response = await f.handler.PUT(f.put(request), org); expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('no-store'); expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    const first = await response.json() as UsTaxProfileReceipt; expect(first).toMatchObject({ requestId: request.requestId, revision: 1, facts, verification: 'unverified', replayed: false });
    const newer = { ...facts, legalName: 'Newer private declaration' };
    expect((await f.handler.PUT(f.put(f.request(1, newer)), org)).status).toBe(200);
    expect(await (await f.handler.PUT(f.put(request), org)).json()).toEqual({ ...first, replayed: true });
    expect(await (await f.handler.GET(f.read(), org)).json()).toMatchObject({ revision: 2, facts: newer, verification: 'unverified' }); expect(await count(org)).toBe(2);
  });
  it.each([401, 402, 403] as const)('withholds the real committed HTTP receipt after access changes to %s, then exact retry recovers one row', async status => {
    const f = await httpFixture(), org = f.actor.organizationId, input = f.request(); f.hooks.afterWrite = () => f.deny(status);
    const withheld = await f.handler.PUT(f.put(input), org); expect(withheld.status).toBe(status);
    expect(await withheld.json()).toEqual({ error: status === 401 ? 'unauthorized' : status === 402 ? 'management_entitlement_required' : 'forbidden' }); expect(await count(org)).toBe(1);
    delete f.hooks.afterWrite; f.deny();
    const recovered = await f.handler.PUT(f.put(input), org); expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ requestId: input.requestId, revision: 1, replayed: true, verification: 'unverified' }); expect(await count(org)).toBe(1);
    expect(JSON.stringify(f.diagnostics)).not.toContain(facts.legalName); expect(JSON.stringify(f.diagnostics)).not.toContain('Private synthetic');
  });
  it('withholds a real private GET after revocation and rejects stale-user/cross-origin PUT before SQL', async () => {
    const f = await httpFixture(), org = f.actor.organizationId; await putUsTaxProfile(f.store, f.actor, f.request());
    f.hooks.afterRead = () => f.deny(401);
    const refused = await f.handler.GET(f.read(), org); expect(refused.status).toBe(401); expect(await refused.json()).toEqual({ error: 'unauthorized' });
    delete f.hooks.afterRead; f.deny();
    const stale = await f.handler.PUT(f.put(f.request(1), { 'X-Zentra-Expected-User': randomUUID() }), org); expect(stale.status).toBe(401); expect(await stale.json()).toEqual({ error: 'session_changed' });
    const foreign = await f.handler.PUT(f.put(f.request(1), { Origin: 'https://attacker.test' }), org); expect(foreign.status).toBe(403); expect(await foreign.json()).toEqual({ error: 'forbidden' }); expect(await count(org)).toBe(1);
  });
  it('recovers a lost real SQL commit response through exact HTTP PUT without creating a second receipt', async () => {
    const f = await httpFixture(), org = f.actor.organizationId, input = f.request(); f.loseNext();
    const lost = await f.handler.PUT(f.put(input), org); expect(lost.status).toBe(503); expect(await lost.json()).toEqual({ error: 'service_unavailable' }); expect(await count(org)).toBe(1);
    const response = await f.handler.PUT(f.put(input), org); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ requestId: input.requestId, replayed: true, revision: 1 }); expect(await count(org)).toBe(1);
  });
  it('never copies declared private facts into actual persisted ERP state/deltas and does not unlock invoice issuance', async () => {
    const f = await httpFixture(), org = f.actor.organizationId;
    const privateFacts: UsTaxFacts = { ...facts, legalName: 'PRIVATE_DECLARATION_ONLY_NAME', taxOrigin: { ...facts.taxOrigin, line1: '987 PRIVATE_DECLARATION_ONLY_ORIGIN', city: 'PRIVATE_DECLARATION_ONLY_CITY', subdivision: 'CA', postalCode: '90001' }, timeZone: 'America/Los_Angeles' };
    expect((await f.handler.PUT(f.put(f.request(0, privateFacts)), org)).status).toBe(200);
    const dependencies: ErpServerDependencies = { ...f.dependencies, store: () => createSupabaseErpStore(erpClient), taxProvider: async () => null };
    const handler = createErpHandlers(dependencies), sync = createErpSyncHandlers({ ...dependencies, syncStore: () => createSupabaseErpSyncStore(erpClient) });
    const url = `https://zentra.test/api/international/workspaces/${org}/erp`, headers = { Origin: 'https://zentra.test', 'Content-Type': 'application/json', 'X-Zentra-Expected-User': f.actor.userId };
    const send = (command: ErpCommand, expectedRevision: number) => handler.POST(new Request(url, { method: 'POST', headers, body: JSON.stringify({ idempotencyKey: `private-isolation-${expectedRevision}`, expectedRevision, command }) }), org);
    expect((await send({ type: 'initialize', periods: [{ id: '2026', start: '2026-01-01', end: '2026-12-31', status: 'open' }] }, 0)).status).toBe(200);
    expect((await send({ type: 'save_customer', customer: { id: 'public-customer', organizationId: org, kind: 'business', name: 'Public Fictitious Customer', billingAddress: configuration(org).address, paymentTermsDays: 30 } }, 1)).status).toBe(200);
    expect((await send({ type: 'save_estimate', id: 'public-estimate', expectedEstimateRevision: 0, customerId: 'public-customer', date: '2026-10-08', expiresAt: '2026-11-08', paymentTermsDays: 30, lines: [{ id: 'public-line', description: 'Fictitious item', quantityUnits: '1', quantityScale: 0, unitPrice: { currency: 'USD', minorUnits: '1000' }, discountBasisPoints: 0, taxTreatment: 'taxable' }], notes: '' }, 2)).status).toBe(200);
    expect((await send({ type: 'accept_estimate', estimateId: 'public-estimate', expectedEstimateRevision: 1 }, 3)).status).toBe(200);
    const before = await (await handler.GET(new Request(url, { headers }), org)).json() as { status: 'ready'; state: ErpState }; expect(before.state.revision).toBe(4); expect(before.state.configuration.taxConfiguration).toEqual({ status: 'unconfigured' });
    const issue = await send({ type: 'issue_invoice', id: 'blocked-invoice', estimateId: 'public-estimate', expectedEstimateRevision: 2, date: '2026-10-08', accountingDate: '2026-10-08', dueDate: '2026-11-07', periodId: '2026' }, 4);
    expect(issue.status).toBe(409); expect(await issue.json()).toEqual({ error: 'tax_configuration_required' });
    const state = await handler.GET(new Request(url, { headers }), org), delta = await sync.changes(new Request(`${url}/changes?after=0&limit=100`, { headers }), org);
    expect(state.status).toBe(200); expect(delta.status).toBe(200);
    const stateBody = await state.json() as { status: 'ready'; state: ErpState }, deltaBody = await delta.json() as ErpDelta; expect(stateBody.state.revision).toBe(4); expect(stateBody.state.invoices).toEqual([]); expect(deltaBody.events).toHaveLength(4);
    const stored = await createSupabaseErpStore(erpClient).read(org), rawDelta = await erpClient.rpc('zentra_us_erp_delta', { p_organization: org, p_after_revision: 0, p_limit: 100 });
    for (const body of [stateBody, deltaBody, stored, rawDelta]) {
      const text = JSON.stringify(body); for (const marker of ['legalName', 'taxOrigin', 'verification', privateFacts.legalName, privateFacts.taxOrigin.line1, privateFacts.taxOrigin.city, privateFacts.timeZone]) expect(text).not.toContain(marker);
    }
    expect(await resolveUsTaxConfiguration(f.store, f.actor)).toEqual({ status: 'blocked', reason: 'provider_verification_required', organizationId: org, revision: 1 }); expect(await count(org)).toBe(1);
  });

  it.each(invalidFacts)('SQL rejects malformed or noncanonical facts %j without head/history writes', async input => {
    const f = await fixture(); await expect(rawPut(f.actor.organizationId, f.actor.userId, 0, randomUUID(), input)).rejects.toMatchObject({ code: 'PT004' });
    expect(await count(f.actor.organizationId)).toBe(0);
  });
  it.each(['verification', 'provider', 'stripeAccount', 'environment', 'registrations', 'exemption', 'authority', 'role', 'taxRate'])('SQL rejects a submitted %s authority field', async key => {
    const f = await fixture(); await expect(rawPut(f.actor.organizationId, f.actor.userId, 0, randomUUID(), { ...facts, [key]: 'forged' })).rejects.toMatchObject({ code: 'PT004' });
    expect(await count(f.actor.organizationId)).toBe(0);
  });
  it.each([['legalName', 256], ['line1', 200], ['line2', 200], ['city', 120]] as const)('aligns the %s UTF16 bound %s with JS, retaining Unicode without truncation', async (field, maximum) => {
    const text = '\ud83d\ude80'.repeat(maximum / 2);
    const input = field === 'legalName' ? factsWith(field, text) : addressWith(field, text);
    expect(validateUsTaxFacts(input)).toEqual(input);
    const f = await fixture(); expect(await putUsTaxProfile(f.store, f.actor, f.request(0, validateUsTaxFacts(input)))).toMatchObject({ facts: input });
    const excessive = field === 'legalName' ? factsWith(field, `${text}a`) : addressWith(field, `${text}a`);
    await expect(rawPut(f.actor.organizationId, f.actor.userId, 1, randomUUID(), excessive)).rejects.toMatchObject({ code: 'PT004' });
    expect(await count(f.actor.organizationId)).toBe(1);
  });
  it('matches ECMAScript canonical trim while retaining non-control Unicode inside names', async () => {
    for (const space of ['\u00a0', '\u1680', '\u2000', '\u2001', '\u2002', '\u2003', '\u2004', '\u2005', '\u2006', '\u2007', '\u2008', '\u2009', '\u200a', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff']) {
      const raw = { ...facts, legalName: `${space}Fictitious Name${space}` };
      expect((await asRole<{ valid: boolean }>('service_role', 'select public.zentra_us_tax_facts_valid($1::jsonb) as valid', [JSON.stringify(raw)]))[0].valid, JSON.stringify(space)).toBe(false);
      const f = await fixture(); expect((await putUsTaxProfile(f.store, f.actor, f.request(0, validateUsTaxFacts(raw)))).facts.legalName).toBe('Fictitious Name');
    }
    const f = await fixture(), unicode = { ...facts, legalName: 'Cafe\u0301\u0085 & Company' };
    expect((await putUsTaxProfile(f.store, f.actor, f.request(0, unicode))).facts.legalName).toBe(unicode.legalName);
  });
  it('rejects exactly ASCII control characters in every declaration text field', async () => {
    for (const path of [['legalName'], ['taxOrigin', 'line1'], ['taxOrigin', 'line2'], ['taxOrigin', 'city']] as const) for (const code of [...Array.from({ length: 31 }, (_, index) => index + 1), 127]) {
      const rows = await asRole<{ valid: boolean }>('service_role', "select public.zentra_us_tax_facts_valid(jsonb_set($1::jsonb,$2::text[],to_jsonb('Bad'||chr($3::integer)||'Name'))) as valid", [JSON.stringify({ ...facts, taxOrigin: { ...facts.taxOrigin, line2: 'Optional line' } }), [...path], code]);
      expect(rows[0].valid, `${path.join('.')} ${code}`).toBe(false);
    }
    await expect(asRole('service_role', 'select public.zentra_us_tax_facts_valid($1::jsonb)', ['{"schemaVersion":1,"legalName":"bad\\u0000name","taxOrigin":{},"timeZone":"America/New_York"}'])).rejects.toMatchObject({ code: '22P05' });
  });
  it('accepts exactly the current 50 states plus DC, registered US time zones and ZIP forms', async () => {
    expect(countrySubdivisions.US).toHaveLength(51); expect(countryConfiguration('US').timeZones).toHaveLength(29);
    for (const subdivision of countrySubdivisions.US) expect((await asRole<{ valid: boolean }>('service_role', 'select public.zentra_us_tax_facts_valid($1::jsonb) as valid', [JSON.stringify(addressWith('subdivision', subdivision))]))[0].valid, subdivision).toBe(true);
    for (const timeZone of countryConfiguration('US').timeZones) expect((await asRole<{ valid: boolean }>('service_role', 'select public.zentra_us_tax_facts_valid($1::jsonb) as valid', [JSON.stringify(factsWith('timeZone', timeZone))]))[0].valid, timeZone).toBe(true);
    const f = await fixture(); expect((await putUsTaxProfile(f.store, f.actor, f.request(0, validateUsTaxFacts(addressWith('postalCode', '10001-1234'))))).facts.taxOrigin.postalCode).toBe('10001-1234');
  });
  it.each(['org-null', 'org-malformed', 'actor-null', 'actor-blank', 'actor-control', 'actor-UTF16', 'revision-null', 'revision-negative', 'revision-exhausted', 'request-null', 'request-nil'] as const)('refuses invalid RPC argument %s', async kind => {
    const f = await fixture(), org = kind === 'org-null' ? null : kind === 'org-malformed' ? '../foreign' : f.actor.organizationId;
    const actor = kind === 'actor-null' ? null : kind === 'actor-blank' ? '\u00a0' : kind === 'actor-control' ? 'bad\nactor' : kind === 'actor-UTF16' ? '\ud83d\ude80'.repeat(129) : f.actor.userId;
    const revision = kind === 'revision-null' ? null : kind === 'revision-negative' ? -1 : kind === 'revision-exhausted' ? Number.MAX_SAFE_INTEGER - 1 : 0;
    const key = kind === 'request-null' ? null : kind === 'request-nil' ? '00000000-0000-0000-0000-000000000000' : randomUUID();
    await expect(rawPut(org, actor, revision, key, facts)).rejects.toMatchObject({ code: 'PT004' });
    expect(await count(f.actor.organizationId)).toBe(0);
  });
  it.each(['missing', 'CH'] as const)('refuses reads/writes for %s workspace without creating facts', async kind => {
    const org = kind === 'CH' ? chOrg : randomUUID();
    await expect(asRole('service_role', 'select public.zentra_read_us_tax_profile($1)', [org])).rejects.toMatchObject({ code: 'PT003' });
    await expect(rawPut(org, randomUUID(), 0, randomUUID(), facts)).rejects.toMatchObject({ code: 'PT003' });
    expect(await count(org)).toBe(0);
  });

  it.each(['anon', 'authenticated'] as const)('denies %s direct table access and both private RPCs', async role => {
    const f = await fixture(); await putUsTaxProfile(f.store, f.actor, f.request());
    for (const table of ['zentra_us_tax_profiles', 'zentra_us_tax_profile_changes']) await expect(asRole(role, `select * from public.${table}`)).rejects.toMatchObject({ code: '42501' });
    await expect(asRole(role, 'select public.zentra_read_us_tax_profile($1)', [f.actor.organizationId])).rejects.toMatchObject({ code: '42501' });
    await expect(asRole(role, 'select public.zentra_put_us_tax_profile($1,$2,1,$3::uuid,$4::jsonb)', [f.actor.organizationId, f.actor.userId, randomUUID(), JSON.stringify(facts)])).rejects.toMatchObject({ code: '42501' });
  });
  it('enables RLS, removes default broad grants and uses invoker functions with empty search_path', async () => {
    const tables = (await db.query<{ relname: string; relrowsecurity: boolean }>("select relname,relrowsecurity from pg_catalog.pg_class where relnamespace='public'::regnamespace and relname in ('zentra_us_tax_profiles','zentra_us_tax_profile_changes') order by relname")).rows;
    expect(tables).toHaveLength(2); expect(tables.every(row => row.relrowsecurity)).toBe(true);
    for (const role of ['anon', 'authenticated', 'service_role']) for (const table of ['zentra_us_tax_profiles', 'zentra_us_tax_profile_changes']) for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      const granted = (await db.query<{ granted: boolean }>('select has_table_privilege($1,$2,$3) as granted', [role, `public.${table}`, privilege])).rows[0].granted;
      expect(granted, `${role} ${table} ${privilege}`).toBe(role === 'service_role' && ['SELECT', 'INSERT', ...(table === 'zentra_us_tax_profiles' ? ['UPDATE'] : [])].includes(privilege));
    }
    const functions = (await db.query<{ proname: string; prosecdef: boolean; proconfig: string[]; anon: boolean; authenticated: boolean }>("select proname,prosecdef,proconfig,has_function_privilege('anon',p.oid,'EXECUTE') as anon,has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated from pg_catalog.pg_proc p where pronamespace='public'::regnamespace and (proname like 'zentra_%us_tax_%')")).rows;
    expect(functions).toHaveLength(7); expect(functions.every(row => !row.prosecdef && row.proconfig.some(value => value.startsWith('search_path=') && !value.includes('public')) && !row.anon && !row.authenticated)).toBe(true);
  });
  it.each(['head-rewrite', 'head-advance-without-receipt', 'head-move', 'head-delete', 'history-rewrite', 'history-delete', 'truncate'] as const)('blocks privileged %s and leaves head/history exact', async attempt => {
    const f = await fixture(), receipt = await putUsTaxProfile(f.store, f.actor, f.request());
    const statements = { 'head-rewrite': 'update public.zentra_us_tax_profiles set facts=jsonb_set(facts,\'{legalName}\',\'"Tampered"\') where organization_id=$1', 'head-advance-without-receipt': 'update public.zentra_us_tax_profiles set revision=revision+1 where organization_id=$1', 'head-move': 'update public.zentra_us_tax_profiles set organization_id=\'foreign\',revision=revision+1 where organization_id=$1', 'head-delete': 'delete from public.zentra_us_tax_profiles where organization_id=$1', 'history-rewrite': 'update public.zentra_us_tax_profile_changes set changed_by=\'tampered\' where organization_id=$1', 'history-delete': 'delete from public.zentra_us_tax_profile_changes where organization_id=$1', truncate: 'truncate public.zentra_us_tax_profiles,public.zentra_us_tax_profile_changes' };
    await expect(db.query(statements[attempt], attempt === 'truncate' ? [] : [f.actor.organizationId])).rejects.toMatchObject({ code: 'PT005' });
    expect(await getUsTaxProfile(f.store, f.actor)).toMatchObject({ revision: 1, facts, updatedAt: receipt.updatedAt, updatedBy: f.actor.userId }); expect(await count(f.actor.organizationId)).toBe(1);
  });
  it.each([false, true])('rolls back an orphan receipt at deferred completion, existingHead=%s', async existingHead => {
    const f = await fixture(); if (existingHead) await putUsTaxProfile(f.store, f.actor, f.request());
    const revision = existingHead ? 1 : 0;
    await expect(db.transaction(async tx => { await tx.exec('set local role service_role'); await tx.query('insert into public.zentra_us_tax_profile_changes(organization_id,request_id,previous_revision,revision,previous_facts,facts,changed_by,changed_at) values($1,$2::uuid,$3,$4,$5::jsonb,$6::jsonb,$7,clock_timestamp())', [f.actor.organizationId, randomUUID(), revision, revision + 1, existingHead ? JSON.stringify(facts) : null, JSON.stringify(facts), f.actor.userId]); })).rejects.toMatchObject({ code: 'PT005' });
    expect(await count(f.actor.organizationId)).toBe(revision);
    expect(await getUsTaxProfile(f.store, f.actor)).toMatchObject({ revision });
  });
  it('rejects a receipt with a different predecessor and a head with a different audit actor', async () => {
    const f = await fixture(); await putUsTaxProfile(f.store, f.actor, f.request());
    await expect(db.query('insert into public.zentra_us_tax_profile_changes(organization_id,request_id,previous_revision,revision,previous_facts,facts,changed_by,changed_at) values($1,$2::uuid,1,2,$3::jsonb,$4::jsonb,$5,clock_timestamp())', [f.actor.organizationId, randomUUID(), JSON.stringify({ ...facts, legalName: 'Wrong predecessor' }), JSON.stringify(facts), f.actor.userId])).rejects.toMatchObject({ code: 'PT005' });
    await expect(db.transaction(async tx => { await tx.query('insert into public.zentra_us_tax_profile_changes(organization_id,request_id,previous_revision,revision,previous_facts,facts,changed_by,changed_at) values($1,$2::uuid,1,2,$3::jsonb,$3::jsonb,$4,clock_timestamp())', [f.actor.organizationId, randomUUID(), JSON.stringify(facts), f.actor.userId]); await tx.query('update public.zentra_us_tax_profiles set revision=2,updated_by=\'other-actor\',updated_at=(select changed_at from public.zentra_us_tax_profile_changes where organization_id=$1 and revision=2) where organization_id=$1', [f.actor.organizationId]); })).rejects.toMatchObject({ code: 'PT005' });
    expect(await count(f.actor.organizationId)).toBe(1);
  });
  it('supports a complete multi-revision chain in one commit and marks both constraints deferred', async () => {
    const f = await fixture();
    await db.transaction(async tx => { await tx.exec('set local role service_role'); for (let revision = 0; revision < 3; revision++) await tx.query('select public.zentra_put_us_tax_profile($1,$2,$3,$4::uuid,$5::jsonb)', [f.actor.organizationId, f.actor.userId, revision, randomUUID(), JSON.stringify({ ...facts, legalName: `Fictitious Name ${revision}` })]); });
    expect(await count(f.actor.organizationId)).toBe(3); expect(await getUsTaxProfile(f.store, f.actor)).toMatchObject({ revision: 3, facts: { ...facts, legalName: 'Fictitious Name 2' }, verification: 'unverified' });
    const constraints = (await db.query<{ conname: string; condeferrable: boolean; condeferred: boolean }>("select conname,condeferrable,condeferred from pg_catalog.pg_constraint where conname in ('zentra_us_tax_profile_receipt_fk','zentra_us_tax_complete_receipt')")).rows;
    expect(constraints).toHaveLength(2); expect(constraints.every(row => row.condeferrable && row.condeferred)).toBe(true);
  });
  it.each(['0001-01-01T00:00:00Z', '9999-12-31T23:59:59.999999Z'])('retains the exact valid RFC3339 timestamp boundary %s through SQL, read and replay', async timestamp => {
    const f = await fixture(), input = f.request();
    await db.transaction(async tx => {
      await tx.exec('set local role service_role');
      await tx.query('insert into public.zentra_us_tax_profile_changes(organization_id,request_id,previous_revision,revision,previous_facts,facts,changed_by,changed_at) values($1,$2::uuid,0,1,null,$3::jsonb,$4,$5::timestamptz)', [f.actor.organizationId, input.requestId, JSON.stringify(facts), f.actor.userId, timestamp]);
      await tx.query('insert into public.zentra_us_tax_profiles(organization_id,revision,facts,updated_by,updated_at) values($1,1,$2::jsonb,$3,$4::timestamptz)', [f.actor.organizationId, JSON.stringify(facts), f.actor.userId, timestamp]);
    });
    const state = await getUsTaxProfile(f.store, f.actor); expect(state.status).toBe('declared');
    if (state.status !== 'declared') throw new Error('Expected locally declared facts');
    expect(state.updatedAt).toBe(timestamp.replace(/(?<!\.[0-9]{6})Z$/, '.000000Z')); expect((await putUsTaxProfile(f.store, f.actor, input)).updatedAt).toBe(state.updatedAt); expect(await count(f.actor.organizationId)).toBe(1);
  });
  it('projects identical UTC microseconds in reads and exact replays across different PostgreSQL session zones', async () => {
    const f = await fixture(), input = f.request(), first = await putUsTaxProfile(f.store, f.actor, input);
    expect(first.updatedAt).toMatch(/T[0-9:]{8}\.[0-9]{6}Z$/);
    for (const zone of ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
      await db.transaction(async tx => {
        await tx.exec('set local role service_role'); await tx.query("select set_config('TimeZone',$1,true)", [zone]);
        const read = (await tx.query<{ result: { updatedAt: string } }>('select public.zentra_read_us_tax_profile($1) as result', [f.actor.organizationId])).rows[0].result;
        const replay = (await tx.query<{ result: UsTaxProfileReceipt }>('select public.zentra_put_us_tax_profile($1,$2,0,$3::uuid,$4::jsonb) as result', [f.actor.organizationId, f.actor.userId, input.requestId, JSON.stringify(facts)])).rows[0].result;
        expect(read.updatedAt).toBe(first.updatedAt); expect(replay).toEqual({ ...first, replayed: true });
      });
    }
    expect(await count(f.actor.organizationId)).toBe(1);
  });
  it.each(['0001-01-01 00:00:00+00 BC', '10000-01-01T00:00:00Z', '-infinity', 'infinity'])('rejects timestamp %s at both SQL column constraints without leaving a receipt', async timestamp => {
    for (const column of ['changed_at', 'updated_at'] as const) {
      const f = await fixture();
      await expect(db.transaction(async tx => {
        if (column === 'updated_at') {
          // Isolate the column CHECK in this local transaction only; rollback
          // restores its guard. Production callers cannot disable this trigger.
          await tx.exec('alter table public.zentra_us_tax_profiles disable trigger zentra_us_tax_head_guard');
          await tx.query('insert into public.zentra_us_tax_profiles(organization_id,revision,facts,updated_by,updated_at) values($1,1,$2::jsonb,$3,$4::timestamptz)', [f.actor.organizationId, JSON.stringify(facts), f.actor.userId, timestamp]);
        } else await tx.query('insert into public.zentra_us_tax_profile_changes(organization_id,request_id,previous_revision,revision,previous_facts,facts,changed_by,changed_at) values($1,$2::uuid,0,1,null,$3::jsonb,$4,$5::timestamptz)', [f.actor.organizationId, randomUUID(), JSON.stringify(facts), f.actor.userId, timestamp]);
      })).rejects.toMatchObject({ code: '23514' });
      expect(await count(f.actor.organizationId)).toBe(0); expect(await getUsTaxProfile(f.store, f.actor)).toMatchObject({ status: 'unconfigured' });
      const guard = (await db.query<{ tgenabled: string }>("select tgenabled from pg_catalog.pg_trigger where tgname='zentra_us_tax_head_guard'")).rows[0]; expect(guard.tgenabled).toBe('O');
    }
  });
});
