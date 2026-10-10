import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import type { FinancialAuthority } from './accounting/ledger';
import { executeErp } from './runtime';
import { createSupabaseErpStore } from './runtime-store';
import type { CompanyConfiguration } from './types';
import { createSupabaseUsSupplierDocumentStore } from './us-supplier-document-store';
import type { UsSupplierDocumentDescriptor } from './us-supplier-document-contract';
import { findUsSupplierDocumentByHash } from './us-supplier-document-lookup';
import { createSupabaseUsSupplierStore } from './us-supplier-store';
import { validateUsSupplierProposal } from './us-supplier-proposal';
import { validateUsSupplierExtraction } from './us-supplier-extraction';

// Disposable local PostgreSQL/WASM and fictitious CH/US data only. The lookup
// proves neither fresh hosted Auth/D1 admission nor real R2/provider bytes.
// PGlite serializes transactions; hosted concurrent locking remains untested.
const directory = process.env.PGLITE_MODULE_DIR, enabled = Boolean(directory && isAbsolute(directory));
const migration = '20261010024618_international_us_supplier_original_hash_lookup.sql';
const countryMigration = '20261007194528_international_workspace_country_config.sql';
const lookup = 'zentra_find_us_supplier_document_by_sha256';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
type Sql = { exec(sql: string): Promise<unknown>; query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> };
type Db = Sql & { close(): Promise<void>; transaction<T>(task: (tx: Sql) => Promise<T>): Promise<T> };
let db: Db, previousFunctions: unknown, previousRelations: unknown, chBefore: unknown;
const chOrg = randomUUID(), chUser = randomUUID();
const names: Record<string, readonly string[]> = {
  zentra_read_us_erp_v4: ['p_organization'], zentra_us_erp_receipt_v4: ['p_organization', 'p_idempotency_key'],
  zentra_commit_us_erp: ['p_organization', 'p_expected_revision', 'p_header', 'p_changes', 'p_ledger_audit', 'p_receipt', 'p_actor'],
  zentra_find_us_supplier_document_by_sha256: ['p_organization', 'p_actor', 'p_supported_schema_version', 'p_content_sha256'],
  zentra_reserve_us_supplier_document: ['p_organization', 'p_actor', 'p_supported_schema_version', 'p_descriptor'],
  zentra_complete_us_supplier_document: ['p_organization', 'p_actor', 'p_supported_schema_version', 'p_id', 'p_content_sha256', 'p_size_bytes'],
  zentra_link_us_supplier_document: ['p_organization', 'p_actor', 'p_supported_schema_version', 'p_id', 'p_proposal'],
  zentra_create_us_supplier_proposal: ['p_organization', 'p_actor', 'p_supported_schema_version', 'p_proposal'],
};
async function sql<T = Record<string, unknown>>(query: string, values: unknown[] = [], role = 'service_role') {
  return db.transaction(async tx => { await tx.exec(`set local role ${role}`); return (await tx.query<T>(query, values)).rows; });
}
async function raw(name: string, parameters: Record<string, unknown>, role = 'service_role') {
  if (!Object.hasOwn(names, name)) throw new Error('Unknown TEST RPC');
  const fields = names[name];
  return (await sql<{ result: unknown }>(`select public.${name}(${fields.map((_, index) => `$${index + 1}`).join(',')}) result`, fields.map(field => parameters[field]), role))[0].result;
}
const client = { async rpc<T>(name: string, parameters: Record<string, unknown>): Promise<T> {
  try { return await raw(name, parameters) as T; }
  catch (error) { throw new SupabaseServerError(503, (error as { code?: string }).code ?? '', 'fictitious-test-rpc'); }
} } as Pick<SupabaseServerClient, 'rpc'>;
async function functionsBeforeLookup() {
  return (await db.query("select p.oid::regprocedure::text signature,pg_get_functiondef(p.oid) definition,p.proacl::text acl,p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind in('f','p') and p.proname like 'zentra_%' and p.proname<>$1 order by 1", [lookup])).rows;
}
async function relations() {
  return (await db.query("select c.relname,c.relrowsecurity,c.relforcerowsecurity,c.relacl::text acl from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname like 'zentra_%' and c.relkind in('r','p') order by c.relname")).rows;
}
async function snapshotCH() {
  return (await db.query('select to_jsonb(w) workspace,to_jsonb(c) country from public.zentra_workspaces w join public.zentra_workspace_country_configs c using(organization_id) where w.organization_id=$1', [chOrg])).rows;
}
async function fixture(initialized = true) {
  const org = randomUUID(), userId = randomUUID(), now = new Date();
  const actor: FinancialAuthority = { organizationId: org, userId, role: 'owner', managementEntitled: true, timestamp: now.toISOString() };
  const configuration: CompanyConfiguration = { schemaVersion: 1, organizationId: org, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York', address: { country: 'US', line1: '1 Fictitious Avenue', city: 'New York', subdivision: 'NY', postalCode: '10001' }, accountingBasis: 'accrual', invoiceNumberPrefix: 'TEST', taxConfiguration: { status: 'unconfigured' } };
  await sql('select public.zentra_admit_new_us_workspace_v1($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::jsonb,$6)', [org, randomUUID(), userId, randomUUID(), JSON.stringify(configuration), digest(org)]);
  const erp = createSupabaseErpStore(client, { supportedSchemaVersion: 4 });
  if (initialized) await executeErp({ store: erp, configuration, actor, revalidate: async () => actor, taxProvider: async () => null }, { idempotencyKey: 'TEST-initialize', expectedRevision: 0, command: { type: 'initialize', periods: [{ id: 'year', start: '2026-01-01', end: '2026-12-31', status: 'open' }] } });
  const documents = createSupabaseUsSupplierDocumentStore(client, { supportedSchemaVersion: 4 });
  const descriptor: UsSupplierDocumentDescriptor = { schemaVersion: 1, organizationId: org, id: randomUUID(), contentSha256: digest('Fictitious PDF bytes'), sizeBytes: 500, mediaType: 'application/pdf', fileName: 'first.pdf', documentText: 'Fictitious private supplier invoice\nUSD 100.00', textSha256: digest('Fictitious private supplier invoice\nUSD 100.00'), createdBy: userId, createdAt: actor.timestamp };
  const base = { p_organization: org, p_actor: actor, p_supported_schema_version: 4, p_content_sha256: descriptor.contentSha256 };
  return { org, actor, descriptor, documents, base, find: () => findUsSupplierDocumentByHash(client, actor, descriptor.contentSha256) };
}

describe.skipIf(!enabled)('US supplier original digest lookup, actual local PostgreSQL chain', () => {
  beforeAll(async () => {
    const { PGlite } = createRequire(import.meta.url)(join(directory!, 'dist/index.cjs')) as { PGlite: new () => Db }; db = new PGlite();
    await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);grant usage on schema public to service_role;');
    for (const name of ['202609140100_company_profiles.sql', '202609140200_company_collaboration.sql', '202609200300_company_content.sql', countryMigration]) await db.exec(await readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8'));
    await sql('insert into public.zentra_workspaces(organization_id,updated_by)values($1,$2)', [chOrg, chUser]);
    await sql('select public.zentra_put_workspace_country_config($1,$2,0,$3::uuid,$4::jsonb)', [chOrg, chUser, randomUUID(), JSON.stringify({ schemaVersion: 1, organizationId: chOrg, country: 'CH', currency: 'CHF', language: 'fr', timeZone: 'Europe/Zurich', address: { country: 'CH', line1: '1 Rue Fictive', city: 'Genève', subdivision: 'GE', postalCode: '1201' }, accountingBasis: 'accrual', invoiceNumberPrefix: 'CH', taxConfiguration: { status: 'unconfigured' } })]);
    chBefore = await snapshotCH();
    const chain = (await readdir(new URL('../../supabase/migrations/', import.meta.url))).filter(name => name > countryMigration && name <= migration && name.endsWith('.sql')).sort();
    expect(chain).toHaveLength(20); expect(chain.at(-1)).toBe(migration);
    for (const name of chain.slice(0, -1)) await db.exec(await readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8'));
    previousFunctions = await functionsBeforeLookup(); previousRelations = await relations();
    await db.exec(await readFile(new URL(`../../supabase/migrations/${migration}`, import.meta.url), 'utf8'));
  }, 30_000);
  afterAll(async () => { await db?.close(); });

  it('finds an uncompleted reservation without pretending its bytes are stored', async () => {
    const f = await fixture(); expect(await f.find()).toBeNull();
    const first = await f.documents.reserve(f.actor, f.descriptor);
    expect(first.stored).toBe(false); expect(await f.find()).toEqual(first);
    expect(await raw(lookup, { ...f.base, p_content_sha256: digest('absent') })).toBeNull();
  });
  it('reuses the full existing completion/link projection without copying original text', async () => {
    const f = await fixture(); await f.documents.reserve(f.actor, f.descriptor);
    const stored = await f.documents.complete(f.actor, f.descriptor.id, f.descriptor.contentSha256, f.descriptor.sizeBytes);
    expect(await f.find()).toEqual(stored);
    const proposal = validateUsSupplierProposal({ schemaVersion: 1, organizationId: f.org, id: randomUUID(), revision: 0, state: 'review', createdBy: f.actor.userId, createdAt: f.actor.timestamp,
      source: { kind: 'document_import', sha256: f.descriptor.textSha256, documentText: f.descriptor.documentText, fileName: 'fictitious.txt', mediaType: 'text/plain', workspaceId: null, connectionId: null, messageId: null, receivedAt: f.actor.timestamp },
      extraction: validateUsSupplierExtraction({ schemaVersion: 1, kind: 'unknown', confidence: 0, fields: {}, evidence: {}, fieldConfidence: {}, issues: [] }) }, f.org);
    const saved = await createSupabaseUsSupplierStore(client, { supportedSchemaVersion: 4 }).create(f.actor, proposal);
    const linked = await f.documents.link(f.actor, stored.id, saved);
    expect(await f.find()).toEqual(linked);
    expect(await sql('select (select count(*) from public.zentra_us_supplier_documents where organization_id=$1)::int documents,(select count(*) from public.zentra_us_supplier_document_receipts where organization_id=$1)::int receipts,(select count(*) from public.zentra_us_supplier_document_links where organization_id=$1)::int links', [f.org])).toEqual([{ documents: 1, receipts: 1, links: 1 }]);
  });
  it('scopes the same binary SHA to the organization and preserves the canonical first descriptor', async () => {
    const a = await fixture(), b = await fixture();
    const first = await a.documents.reserve(a.actor, a.descriptor);
    expect(await b.find()).toBeNull();
    const colleague = { ...a.actor, userId: randomUUID(), role: 'accountant' as const };
    await a.documents.reserve(colleague, { ...a.descriptor, id: randomUUID(), fileName: 'renamed.pdf', createdBy: colleague.userId, documentText: null, textSha256: null });
    expect(await findUsSupplierDocumentByHash(client, colleague, a.descriptor.contentSha256)).toEqual(first);
    const second = await b.documents.reserve(b.actor, b.descriptor);
    expect(await b.find()).toEqual(second); expect(second.id).not.toBe(first.id);
  });
  it.each([null, '', 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), ' ' + 'a'.repeat(64)])('rejects a malformed SQL digest %s', async hash => {
    const f = await fixture(); await expect(raw(lookup, { ...f.base, p_content_sha256: hash })).rejects.toMatchObject({ code: 'PD001' });
  });
  it('requires the same financial authority as existing original reads', async () => {
    const f = await fixture(); await f.documents.reserve(f.actor, f.descriptor);
    for (const p_actor of [{ ...f.actor, organizationId: randomUUID() }, { ...f.actor, role: 'member' }, { ...f.actor, role: 'read_only' }, { ...f.actor, managementEntitled: false }, { ...f.actor, timestamp: 'invalid' }]) {
      await expect(raw(lookup, { ...f.base, p_actor })).rejects.toMatchObject({ code: 'PS005' });
    }
    // Scope is checked even when the lookup would otherwise be missing/invalid.
    await expect(raw(lookup, { ...f.base, p_actor: { ...f.actor, role: 'read_only' }, p_content_sha256: null })).rejects.toMatchObject({ code: 'PS005' });
  });
  it('refuses old/null capabilities, uninitialized US accounting and CH workspaces', async () => {
    const f = await fixture();
    for (const cap of [null, 1, 2, 3, 99]) await expect(raw(lookup, { ...f.base, p_supported_schema_version: cap })).rejects.toMatchObject({ code: 'PS006' });
    const uninitialized = await fixture(false); await expect(raw(lookup, uninitialized.base)).rejects.toMatchObject({ code: 'PS006' });
    await expect(raw(lookup, { ...f.base, p_organization: chOrg, p_actor: { ...f.actor, organizationId: chOrg } })).rejects.toMatchObject({ code: 'PS006' });
  });
  it('keeps the new RPC service-only INVOKER with an empty search_path', async () => {
    const rows = (await db.query<{ prosecdef: boolean; proconfig: string[]; anon: boolean; authenticated: boolean; service: boolean }>("select p.prosecdef,p.proconfig,has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,has_function_privilege('service_role',p.oid,'EXECUTE') service from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1", [lookup])).rows;
    expect(rows).toEqual([{ prosecdef: false, proconfig: ['search_path=""'], anon: false, authenticated: false, service: true }]);
    const f = await fixture();
    for (const role of ['anon', 'authenticated']) await expect(raw(lookup, f.base, role)).rejects.toMatchObject({ code: '42501' });
  });
  it('leaves prior function definitions/grants, table RLS/grants and CH data unchanged', async () => {
    expect(await functionsBeforeLookup()).toEqual(previousFunctions);
    expect(await relations()).toEqual(previousRelations);
    expect(await snapshotCH()).toEqual(chBefore);
    expect(await sql('select count(*)::int count from public.zentra_us_supplier_documents where organization_id=$1', [chOrg])).toEqual([{ count: 0 }]);
  });
});
