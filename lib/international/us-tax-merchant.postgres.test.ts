import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import type { FinancialAuthority } from './accounting/ledger';
import type { CompanyConfiguration } from './types';
import { createSupabaseUsTaxMerchantStore, type UsTaxMerchantActivation } from './us-tax-merchant-store';

// Synthetic local TEST observations only. No credential, SDK or provider call.
const directory = process.env.PGLITE_MODULE_DIR, enabled = Boolean(directory && isAbsolute(directory));
type Sql = { exec(sql: string): Promise<unknown>; query<T = Record<string, unknown>>(sql: string, parameters?: unknown[]): Promise<{ rows: T[] }> };
type Db = Sql & { transaction<T>(task: (sql: Sql) => Promise<T>): Promise<T>; close(): Promise<void> };
let db: Db;
const migration = '20261009222319_international_us_tax_test_merchant';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const names: Record<string, string[]> = {
  zentra_read_us_tax_merchant_context: ['p_organization', 'p_actor'],
  zentra_read_us_tax_merchant_receipt: ['p_organization', 'p_actor', 'p_request_id'],
  zentra_read_us_tax_merchant_credential: ['p_organization', 'p_actor', 'p_binding_revision'],
  zentra_activate_us_tax_test_merchant: ['p_organization', 'p_actor', 'p_request_id', 'p_context', 'p_credential', 'p_configuration_fingerprint', 'p_observation', 'p_valid_until'],
};
async function sql<T = Record<string, unknown>>(query: string, values: unknown[] = [], role = 'service_role') {
  return db.transaction(async tx => { await tx.exec(`set local role ${role}`); return (await tx.query<T>(query, values)).rows; });
}
const client = { async rpc<T>(name: string, parameters: Record<string, unknown>): Promise<T> {
  if (!Object.hasOwn(names, name)) throw Error('Unexpected TEST RPC');
  try { return (await sql<{ result: T }>(`select public.${name}(${names[name].map((_, i) => `$${i + 1}`).join(',')}) result`, names[name].map(key => parameters[key])))[0].result; }
  catch (e) { if (process.env.ZENTRA_LOCAL_SQL_DEBUG === '1') console.error('TEST SQL', (e as { code?: string }).code, (e as Error).message, (e as { where?: string }).where); throw new SupabaseServerError(503, (e as { code?: string }).code ?? 'TEST-rpc'); }
} } as Pick<SupabaseServerClient, 'rpc'>;
const store = createSupabaseUsTaxMerchantStore(client);
const rawActivation = (actor: FinancialAuthority, input: UsTaxMerchantActivation) => sql('select public.zentra_activate_us_tax_test_merchant($1,$2,$3,$4,$5,$6,$7,$8)', [actor.organizationId, actor, input.requestId, input.context, input.credential, input.configurationFingerprint, input.observation, input.validUntil]);
const snapshot = (org: string) => sql(`select
  (select to_jsonb(c) from public.zentra_workspace_country_configs c where organization_id=$1) country,
  (select jsonb_agg(to_jsonb(h) order by revision) from public.zentra_workspace_country_config_changes h where organization_id=$1) country_history,
  (select to_jsonb(s) from public.zentra_us_seller_profiles s where organization_id=$1) seller,
  (select to_jsonb(f) from public.zentra_us_tax_profiles f where organization_id=$1) facts,
  (select to_jsonb(b) from public.zentra_us_tax_provider_bindings b where organization_id=$1) binding,
  (select jsonb_agg(to_jsonb(h) order by revision) from public.zentra_us_tax_provider_binding_changes h where organization_id=$1) binding_history,
  (select jsonb_agg(to_jsonb(a) order by binding_revision) from public.zentra_us_tax_merchant_admissions a where organization_id=$1) admissions,
  (select to_jsonb(e) from public.zentra_us_erp_heads e where organization_id=$1) erp`, [org]);
async function fixture(declarations = true) {
  const org = randomUUID(), userId = randomUUID(), actor: FinancialAuthority = { organizationId: org, userId, role: 'owner', managementEntitled: true, timestamp: new Date().toISOString() };
  const configuration: CompanyConfiguration = { schemaVersion: 1, organizationId: org, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York', address: { country: 'US', line1: '1 Fictitious Public Street', city: 'New York', subdivision: 'NY', postalCode: '10001' }, accountingBasis: 'accrual', invoiceNumberPrefix: 'TEST', taxConfiguration: { status: 'unconfigured' } };
  await sql('select public.zentra_admit_new_us_workspace_v1($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::jsonb,$6)', [org, randomUUID(), userId, randomUUID(), configuration, digest(org)]);
  const seller = { displayName: 'Fictitious TEST Seller', contactEmail: 'fixture@example.test' };
  const facts = { schemaVersion: 1, legalName: 'PRIVATE_FICTITIOUS_LEGAL_NAME', taxOrigin: { country: 'US', line1: '99 Fictitious Private Origin', city: 'New York', subdivision: 'NY', postalCode: '10001' }, timeZone: 'America/New_York' };
  if (declarations) {
    await sql('select public.zentra_put_us_seller_profile($1,$2,0,$3::uuid,$4::jsonb)', [org, userId, randomUUID(), seller]);
    await sql('select public.zentra_put_us_tax_profile($1,$2,0,$3::uuid,$4::jsonb)', [org, userId, randomUUID(), facts]);
  }
  async function input(): Promise<UsTaxMerchantActivation> {
    const context = await store.readContext(actor), observedAt = new Date(Date.now() - 10).toISOString();
    return { requestId: randomUUID(), context, credential: { reference: 'TEST-credential-reference', revision: 1, accountId: 'acct_FictitiousTEST' }, configurationFingerprint: digest('TEST-configuration'), observation: { organizationId: org, accountId: 'acct_FictitiousTEST', mode: 'test', apiVersion: '2026-08-26.dahlia', settingsSha256: digest('TEST-settings'), registrationsSha256: digest('TEST-registrations'), observedAt, taxOrigin: context.taxFacts.taxOrigin }, validUntil: new Date(Date.parse(observedAt) + 119_000).toISOString() };
  }
  return { org, actor, configuration, seller, facts, input };
}
const protectedFunctions = ['zentra_guard_us_tax_binding_history', 'zentra_guard_us_tax_binding_head', 'zentra_guard_us_tax_operation', 'zentra_assert_us_tax_operation_snapshot', 'zentra_reserve_us_tax_operation', 'zentra_record_us_tax_calculation', 'zentra_commit_us_tax_invoice_test'];
let baselineFunctions: unknown, chBefore: unknown;
const chOrg = randomUUID(), chUser = randomUUID();
const functionDefinitions = async () => (await db.query('select proname,pg_get_functiondef(oid) definition from pg_proc where pronamespace=\'public\'::regnamespace and proname=any($1::text[]) order by proname', [protectedFunctions])).rows;
describe.skipIf(!enabled)('private US TEST merchant activation PostgreSQL', () => {
  beforeAll(async () => {
    const { PGlite } = createRequire(import.meta.url)(join(directory!, 'dist/index.cjs')) as { PGlite: new () => Db }; db = new PGlite();
    await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);grant usage on schema public to service_role;');
    for (const name of ['202609140100_company_profiles', '202609140200_company_collaboration', '202609200300_company_content', '20261007194528_international_workspace_country_config', '20261007222349_international_us_erp_persistence', '20261007224820_international_us_erp_delta_stream', '20261007225725_international_us_erp_seller_snapshot', '20261008001726_new_us_workspace_admission', '20261008013200_international_tax_proof_allowlist', '20261008034422_international_us_seller_profile', '20261008044402_international_us_tax_profile', '20261008060826_international_us_tax_operations']) await db.exec(await readFile(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), 'utf8'));
    await db.query('insert into public.zentra_workspaces(organization_id,updated_by) values($1,$2)', [chOrg, chUser]);
    await db.query('select public.zentra_put_workspace_country_config($1,$2,0,$3::uuid,$4::jsonb)', [chOrg, chUser, randomUUID(), { schemaVersion: 1, organizationId: chOrg, country: 'CH', currency: 'CHF', language: 'fr', timeZone: 'Europe/Zurich', address: { country: 'CH', line1: '1 Rue Fictive', city: 'Genève', subdivision: 'GE', postalCode: '1201' }, accountingBasis: 'accrual', invoiceNumberPrefix: 'CH', taxConfiguration: { status: 'unconfigured' } }]);
    for (const name of ['20261008081825_international_us_purchasing_v2', '20261008105120_international_us_projects_v3', '20261008161118_international_us_journal_periods_v4', '20261008172520_international_us_tax_invoice_capability_v2']) await db.exec(await readFile(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), 'utf8'));
    baselineFunctions = await functionDefinitions();
    chBefore = (await db.query('select to_jsonb(w) workspace,to_jsonb(c) country from public.zentra_workspaces w join public.zentra_workspace_country_configs c using(organization_id) where organization_id=$1', [chOrg])).rows;
    await db.exec(await readFile(new URL(`../../supabase/migrations/${migration}.sql`, import.meta.url), 'utf8'));
    await db.exec(await readFile(new URL('../../supabase/migrations/20261009224607_international_us_tax_invoice_preparation.sql', import.meta.url), 'utf8'));
  }, 60_000);
  afterAll(async () => { await db?.close(); });
  it('bootstraps without a binding, atomically records provider evidence and country audit, never ERP', async () => {
    const f = await fixture(), input = await f.input();
    expect(input.context.bindingRevision).toBe(0);
    expect(await store.readReceipt(f.actor, input.requestId)).toBeNull();
    const receipt = await store.activate(f.actor, input), context = await store.readContext(f.actor);
    expect(receipt).toMatchObject({ schemaVersion: 1, countryRevision: 2, configurationChanged: true, configurationFingerprint: input.configurationFingerprint, binding: { revision: 1, evidenceKind: 'provider_observation', mode: 'test' } });
    expect(context).toMatchObject({ countryRevision: 2, sellerRevision: 1, taxFactsRevision: 1, bindingRevision: 1, configuration: { taxConfiguration: { status: 'configured' } }, seller: f.seller, taxFacts: f.facts });
    expect(await store.readReceipt(f.actor, input.requestId)).toEqual(receipt);
    const rows = await snapshot(f.org);
    expect(rows[0].erp).toBeNull(); expect(rows[0].country_history).toHaveLength(2); expect(rows[0].binding_history).toHaveLength(1); expect(rows[0].admissions).toHaveLength(1);
  });
  it('renews binding only and admits genuine financial roles to current credential provenance', async () => {
    const f = await fixture(); await store.activate(f.actor, await f.input());
    const input = await f.input(), receipt = await store.activate(f.actor, input);
    expect(receipt).toMatchObject({ countryRevision: 2, configurationChanged: false, binding: { revision: 2 } });
    expect((await snapshot(f.org))[0].country_history).toHaveLength(2);
    for (const role of ['owner', 'admin', 'accountant'] as const) expect(await store.readCredential({ ...f.actor, role }, 2)).toEqual({ credential: input.credential, configurationFingerprint: input.configurationFingerprint });
    expect(await store.readCredential(f.actor, 1)).toBeNull();
    await expect(store.readCredential({ ...f.actor, role: 'member' }, 2)).rejects.toMatchObject({ code: 'financial_permission_required' });
    await expect(store.readCredential({ ...f.actor, managementEntitled: false }, 2)).rejects.toMatchObject({ status: 402 });
  });
  it('fences each actual country, seller, facts and binding change without partial activation', async () => {
    for (const kind of ['country', 'seller', 'facts', 'binding']) {
      const f = await fixture(), input = await f.input();
      if (kind === 'country') await sql('select public.zentra_put_workspace_country_config($1,$2,1,$3::uuid,$4::jsonb)', [f.org, f.actor.userId, randomUUID(), { ...f.configuration, invoiceNumberPrefix: 'CHANGED' }]);
      if (kind === 'seller') await sql('select public.zentra_put_us_seller_profile($1,$2,1,$3::uuid,$4::jsonb)', [f.org, f.actor.userId, randomUUID(), { ...f.seller, displayName: 'Changed TEST Seller' }]);
      if (kind === 'facts') await sql('select public.zentra_put_us_tax_profile($1,$2,1,$3::uuid,$4::jsonb)', [f.org, f.actor.userId, randomUUID(), { ...f.facts, legalName: 'CHANGED_PRIVATE_FICTITIOUS_NAME' }]);
      if (kind === 'binding') await sql('select public.zentra_put_us_tax_provider_binding($1,$2,0,$3::uuid,$4::jsonb)', [f.org, f.actor.userId, randomUUID(), { ...input.observation, taxOrigin: undefined, revision: 1, validUntil: input.validUntil, evidenceKind: 'test_fixture', scope: 'erp_invoice_tax' }]);
      const before = await snapshot(f.org);
      await expect(store.activate(f.actor, input)).rejects.toMatchObject({ code: 'tax_configuration_changed', status: 409 });
      expect(await snapshot(f.org)).toEqual(before);
    }
  });
  it('compares complete snapshots even when submitted revisions match', async () => {
    const f = await fixture(), input = await f.input(), before = await snapshot(f.org);
    for (const context of [{ ...input.context, configuration: { ...input.context.configuration, invoiceNumberPrefix: 'FORGED' } }, { ...input.context, seller: { displayName: 'FORGED' } }, { ...input.context, taxFacts: { ...input.context.taxFacts, legalName: 'FORGED' } }]) {
      await expect(rawActivation(f.actor, { ...input, context })).rejects.toMatchObject({ code: 'PM001' });
      expect(await snapshot(f.org)).toEqual(before);
    }
  });
  it('replays exact historical payload without overwriting heads and conflicts on changed provenance or actor', async () => {
    const f = await fixture(), input = await f.input(), first = await store.activate(f.actor, input);
    await store.activate(f.actor, await f.input()); const before = await snapshot(f.org);
    expect(await store.activate(f.actor, input)).toEqual(first); expect(await store.readReceipt(f.actor, input.requestId)).toEqual(first);
    expect(await snapshot(f.org)).toEqual(before);
    for (const changed of [{ ...input, configurationFingerprint: digest('rotated TEST descriptor') }, { ...input, credential: { ...input.credential, revision: 2 } }, { ...input, validUntil: new Date(Date.parse(input.validUntil) - 1).toISOString() }]) await expect(store.activate(f.actor, changed)).rejects.toMatchObject({ code: 'tax_merchant_request_conflict' });
    await expect(store.readReceipt({ ...f.actor, userId: randomUUID() }, input.requestId)).rejects.toMatchObject({ code: 'tax_merchant_request_conflict' });
    expect(await snapshot(f.org)).toEqual(before);
  });
  it('rejects malformed/fixture/live/cross-account/origin/API observations through SQL itself', async () => {
    const f = await fixture(), input = await f.input(), before = await snapshot(f.org);
    for (const observation of [{ ...input.observation, evidenceKind: 'test_fixture' }, { ...input.observation, mode: 'live' }, { ...input.observation, organizationId: randomUUID() }, { ...input.observation, accountId: 'acct_Other' }, { ...input.observation, apiVersion: '2020-01-01' }, { ...input.observation, taxOrigin: f.configuration.address }, { ...input.observation, settingsSha256: 'bad' }]) await expect(rawActivation(f.actor, { ...input, observation } as UsTaxMerchantActivation)).rejects.toMatchObject({ code: 'PM004' });
    await expect(rawActivation(f.actor, { ...input, configurationFingerprint: 'bad' })).rejects.toMatchObject({ code: 'PM004' });
    expect(await snapshot(f.org)).toEqual(before);
  });
  it('enforces server freshness, future time and expiry bounds on every new activation', async () => {
    const f = await fixture(), input = await f.input(), before = await snapshot(f.org);
    for (const seconds of [-121, 60]) {
      const observedAt = new Date(Date.now() + seconds * 1000).toISOString();
      await expect(rawActivation(f.actor, { ...input, observation: { ...input.observation, observedAt }, validUntil: new Date(Date.parse(observedAt) + 120_000).toISOString() })).rejects.toMatchObject({ code: 'PM006' });
    }
    await expect(rawActivation(f.actor, { ...input, validUntil: new Date(Date.parse(input.observation.observedAt) + 121_000).toISOString() })).rejects.toMatchObject({ code: 'PM004' });
    const observedAt = new Date(Date.now() - 60_000).toISOString();
    await expect(rawActivation(f.actor, { ...input, observation: { ...input.observation, observedAt }, validUntil: new Date(Date.now() - 1000).toISOString() })).rejects.toMatchObject({ code: 'PM006' });
    expect(await snapshot(f.org)).toEqual(before);
  });
  it('rejects non-owner, missing entitlement/declarations, wrong organization and CH admission', async () => {
    const f = await fixture(), input = await f.input();
    for (const actor of [{ ...f.actor, role: 'admin' }, { ...f.actor, managementEntitled: false }, { ...f.actor, organizationId: randomUUID() }]) await expect(rawActivation(actor as FinancialAuthority, input)).rejects.toMatchObject({ code: actor.organizationId !== f.org ? 'PM004' : 'PM005' });
    await expect(store.readContext({ ...f.actor, organizationId: chOrg })).rejects.toMatchObject({ code: 'country_configuration_required' });
    const missing = await fixture(false);
    await expect(store.readContext(missing.actor)).rejects.toMatchObject({ code: 'seller_configuration_required' });
    await sql('select public.zentra_put_us_seller_profile($1,$2,0,$3::uuid,$4::jsonb)', [missing.org, missing.actor.userId, randomUUID(), missing.seller]);
    await expect(store.readContext(missing.actor)).rejects.toMatchObject({ code: 'tax_details_required' });
  });
  it('requires exact current admitted binding for credential lookup; legacy and other tenants return null', async () => {
    const f = await fixture(), input = await f.input();
    const { taxOrigin: _origin, ...observed } = input.observation;
    const legacy = { ...observed, revision: 1, validUntil: input.validUntil, evidenceKind: 'provider_observation', scope: 'erp_invoice_tax' };
    await sql('select public.zentra_put_us_tax_provider_binding($1,$2,0,$3::uuid,$4::jsonb)', [f.org, f.actor.userId, randomUUID(), legacy]);
    expect(await store.readCredential(f.actor, 1)).toBeNull();
    const receipt = await store.activate(f.actor, await f.input());
    expect(await store.readCredential(f.actor, receipt.binding.revision)).not.toBeNull();
    const other = await fixture(); expect(await store.readCredential(other.actor, receipt.binding.revision)).toBeNull();
    const changed = { ...receipt.binding, revision: receipt.binding.revision + 1, evidenceKind: 'test_fixture' };
    await sql('select public.zentra_put_us_tax_provider_binding($1,$2,$3,$4::uuid,$5::jsonb)', [f.org, f.actor.userId, receipt.binding.revision, randomUUID(), changed]);
    expect(await store.readCredential(f.actor, changed.revision)).toBeNull();
  });
  it('withdraws credential provenance after any country, seller or tax-facts change', async () => {
    for (const kind of ['country', 'seller', 'facts']) {
      const f = await fixture(), receipt = await store.activate(f.actor, await f.input());
      expect(await store.readCredential(f.actor, receipt.binding.revision)).not.toBeNull();
      if (kind === 'country') await sql('select public.zentra_put_workspace_country_config($1,$2,2,$3::uuid,$4::jsonb)', [f.org, f.actor.userId, randomUUID(), { ...f.configuration, taxConfiguration: { status: 'configured' }, invoiceNumberPrefix: 'CHANGED' }]);
      if (kind === 'seller') await sql('select public.zentra_put_us_seller_profile($1,$2,1,$3::uuid,$4::jsonb)', [f.org, f.actor.userId, randomUUID(), { ...f.seller, displayName: 'Changed TEST Seller' }]);
      if (kind === 'facts') await sql('select public.zentra_put_us_tax_profile($1,$2,1,$3::uuid,$4::jsonb)', [f.org, f.actor.userId, randomUUID(), { ...f.facts, legalName: 'CHANGED_FICTITIOUS_TEST_NAME' }]);
      expect(await store.readCredential(f.actor, receipt.binding.revision)).toBeNull();
    }
  });
  it('restricts tables and RPCs to service INVOKER execution and preserves immutable receipts', async () => {
    const f = await fixture(), input = await f.input(); await store.activate(f.actor, input);
    for (const role of ['anon', 'authenticated']) {
      await expect(sql('select * from public.zentra_us_tax_merchant_admissions', [], role)).rejects.toMatchObject({ code: '42501' });
      for (const name of Object.keys(names)) {
        const permissions = await db.query<{ permitted: boolean }>('select has_function_privilege($1,p.oid,\'execute\') permitted from pg_proc p where proname=$2 and pronamespace=\'public\'::regnamespace', [role, name]);
        expect(permissions.rows).toEqual([{ permitted: false }]);
      }
    }
    const funcs = await db.query<{ prosecdef: boolean; proconfig: string[] }>('select prosecdef,proconfig from pg_proc where proname=any($1::text[]) and pronamespace=\'public\'::regnamespace', [Object.keys(names)]);
    expect(funcs.rows).toHaveLength(4); for (const row of funcs.rows) { expect(row.prosecdef).toBe(false); expect(row.proconfig).toContain('search_path=""'); }
    expect((await db.query<{ relrowsecurity: boolean }>('select relrowsecurity from pg_class where oid=\'public.zentra_us_tax_merchant_admissions\'::regclass')).rows[0].relrowsecurity).toBe(true);
    for (const query of ['update public.zentra_us_tax_merchant_admissions set actor_id=actor_id', 'delete from public.zentra_us_tax_merchant_admissions', 'truncate public.zentra_us_tax_merchant_admissions']) await expect(db.exec(query)).rejects.toMatchObject({ code: 'PM009' });
  });
  it('leaves established binding/operation/proof functions and CH state unchanged', async () => {
    expect(await functionDefinitions()).toEqual(baselineFunctions);
    expect((await db.query('select to_jsonb(w) workspace,to_jsonb(c) country from public.zentra_workspaces w join public.zentra_workspace_country_configs c using(organization_id) where organization_id=$1', [chOrg])).rows).toEqual(chBefore);
  });
});
