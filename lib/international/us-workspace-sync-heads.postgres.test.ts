import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import { AccountPublicError } from '../account-security';
import { createSupabaseErpStore } from './runtime-store';
import { canonicalErpJson, executeErp } from './runtime';
import { createSupabaseUsAutomationStore } from './us-automation-store';
import { createSupabaseUsSupplierStore } from './us-supplier-store';
import { createSupabaseUsBankStore } from './us-bank-store';
import { applyUsBankCommand, validateUsBankRequest } from './us-bank-reconciliation';
import { validateUsSupplierExtraction } from './us-supplier-extraction';
import { validateUsSupplierProposal } from './us-supplier-proposal';
import { createSupabaseUsWorkspaceSyncHeadsStore, type UsWorkspaceSyncSelection } from './us-workspace-sync-heads-store';
import { createUsWorkspaceSyncHeadsHandlers } from './us-workspace-sync-heads-server';
import type { FinancialAuthority } from './accounting/ledger';
import type { CompanyConfiguration } from './types';
import type { UsAutomationGrant } from './us-automation-contract';

const directory = process.env.PGLITE_MODULE_DIR, enabled = Boolean(directory && isAbsolute(directory));
type Sql = { exec(sql: string): Promise<unknown>; query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> };
type Db = Sql & { close(): Promise<void>; transaction<T>(task: (tx: Sql) => Promise<T>): Promise<T> }; let db: Db;
const migration = '20261009215104_international_us_workspace_sync_heads';
const names: Record<string, string[]> = {
  zentra_read_us_erp_v4: ['p_organization'], zentra_us_erp_receipt_v4: ['p_organization', 'p_idempotency_key'], zentra_commit_us_erp: ['p_organization', 'p_expected_revision', 'p_header', 'p_changes', 'p_ledger_audit', 'p_receipt', 'p_actor'],
  zentra_us_workspace_sync_heads: ['p_organization', 'p_actor', 'p_supported_schema_version', 'p_supplier', 'p_bank', 'p_analysis', 'p_analysis_configuration_hash', 'p_grant'],
  zentra_create_us_supplier_proposal: ['p_organization', 'p_actor', 'p_supported_schema_version', 'p_proposal'],
  zentra_read_us_automation_settings: ['p_organization', 'p_actor', 'p_supported_schema_version'], zentra_save_us_automation_settings: ['p_organization', 'p_actor', 'p_supported_schema_version', 'p_request'],
  zentra_claim_us_automation_analysis: ['p_organization', 'p_actor', 'p_supported_schema_version', 'p_grant', 'p_source', 'p_recipe_version', 'p_request_id', 'p_lease_token'],
  zentra_dispatch_us_automation_analysis: ['p_organization', 'p_actor', 'p_supported_schema_version', 'p_grant', 'p_job_id', 'p_lease_token'],
  zentra_complete_us_automation_analysis: ['p_organization', 'p_actor', 'p_supported_schema_version', 'p_grant', 'p_job_id', 'p_dispatch_id', 'p_result_body', 'p_result_sha256'],
  zentra_commit_us_bank_reconciliation: ['p_organization', 'p_actor', 'p_supported_schema_version', 'p_expected_erp_revision', 'p_expected_reconciliation_revision', 'p_record', 'p_receipt'],
};
const digest = (v: string) => createHash('sha256').update(v).digest('hex');
async function sql<T = Record<string, unknown>>(query: string, values: unknown[] = [], role: 'service_role' | 'anon' | 'authenticated' = 'service_role') { return db.transaction(async tx => { await tx.exec(`set local role ${role}`); return (await tx.query<T>(query, values)).rows; }); }
const client = { async rpc<T>(name: string, input: Record<string, unknown>): Promise<T> {
  if (!Object.hasOwn(names, name)) throw Error(`Unexpected TEST RPC ${name}`);
  try { return (await sql<{ result: T }>(`select public.${name}(${names[name].map((_, i) => `$${i + 1}`).join(',')}) result`, names[name].map(k => input[k])))[0].result; }
  catch (error) { if (process.env.ZENTRA_LOCAL_SQL_DEBUG === '1') console.error('TEST SQL', (error as Error).message, (error as { code?: string }).code, (error as { where?: string }).where); throw new SupabaseServerError(503, (error as { code?: string }).code ?? '', 'TEST-rpc'); }
} } as Pick<SupabaseServerClient, 'rpc'>;
const extraction = () => validateUsSupplierExtraction({ schemaVersion: 1, kind: 'unknown', confidence: 0, fields: {}, evidence: {}, fieldConfidence: {}, issues: [] });
const chOrg = randomUUID(), chUser = randomUUID(); let chBefore: unknown, seeded: Awaited<ReturnType<typeof fixture>>;
const snapshotCH = async () => (await db.query('select to_jsonb(w) workspace,to_jsonb(c) country from public.zentra_workspaces w join public.zentra_workspace_country_configs c using(organization_id) where w.organization_id=$1', [chOrg])).rows;
async function fixture(initialize = true) {
  const org = randomUUID(), userId = randomUUID(), now = new Date(), actor: FinancialAuthority = { organizationId: org, userId, role: 'owner', managementEntitled: true, timestamp: now.toISOString() };
  const config: CompanyConfiguration = { schemaVersion: 1, organizationId: org, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York', address: { country: 'US', line1: '1 Fictitious Avenue', city: 'New York', subdivision: 'NY', postalCode: '10001' }, accountingBasis: 'accrual', invoiceNumberPrefix: 'TEST', taxConfiguration: { status: 'unconfigured' } };
  await sql('select public.zentra_admit_new_us_workspace_v1($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::jsonb,$6)', [org, randomUUID(), userId, randomUUID(), JSON.stringify(config), digest(org)]);
  const erp = createSupabaseErpStore(client, { supportedSchemaVersion: 4 }), automation = createSupabaseUsAutomationStore(client, { supportedSchemaVersion: 4 }), suppliers = createSupabaseUsSupplierStore(client, { supportedSchemaVersion: 4 }), bank = createSupabaseUsBankStore(client, { supportedSchemaVersion: 4 });
  if (initialize) await executeErp({ store: erp, configuration: config, actor, revalidate: async () => actor, taxProvider: async () => null }, { idempotencyKey: 'TEST-init', expectedRevision: 0, command: { type: 'initialize', periods: [{ id: 'year', start: '2026-01-01', end: '2026-12-31', status: 'open' }] } });
  const grant: UsAutomationGrant = { schemaVersion: 1, organizationId: org, environment: 'TEST', bucket: 'supplier_invoice_extract', periodId: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`, periodStart: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000, periodEnd: Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) / 1000, limit: 3, subscriptionId: 'TEST-sub', authorityReference: 'TEST-authority', catalogVersion: 'TEST-catalog', priceId: 'price_TEST', budgetPolicyVersion: 'budget1', processingPolicyVersion: 'processing1', checkedAt: Math.floor(now.getTime() / 1000) };
  const selection: UsWorkspaceSyncSelection = { supplierProposals: true, bankReconciliations: true, supplierAnalysis: true, team: false, analysisConfigurationHash: digest('TEST-policy'), grant };
  const headsStore = createSupabaseUsWorkspaceSyncHeadsStore(client, { supportedSchemaVersion: 4 });
  const read = (over: Partial<UsWorkspaceSyncSelection> = {}, admitted = actor) => headsStore.read(admitted, { ...selection, ...over });
  const source = () => { const documentText = `Fictitious private invoice ${randomUUID()}`; return { kind: 'document_import' as const, sha256: digest(documentText), fileName: 'private.txt', mediaType: 'text/plain' as const, workspaceId: null, connectionId: null, messageId: null, receivedAt: actor.timestamp, documentText }; };
  const propose = () => suppliers.create(actor, validateUsSupplierProposal({ schemaVersion: 1, organizationId: org, id: randomUUID(), revision: 0, state: 'review', createdBy: userId, createdAt: actor.timestamp, source: source(), extraction: extraction() }, org));
  const activate = () => automation.saveSettings(actor, { schemaVersion: 1, requestId: randomUUID(), expectedRevision: 0, action: 'activate', processingPolicyVersion: grant.processingPolicyVersion, consent: true });
  const claim = () => automation.claim({ actor, grant, source: source(), recipeVersion: 'extract1', requestId: randomUUID(), leaseToken: randomUUID() });
  return { org, actor, config, erp, automation, suppliers, bank, grant, selection, read, source, propose, activate, claim };
}
describe.skipIf(!enabled)('US compact heads PostgreSQL, actual chain and service privileges', () => {
  beforeAll(async () => {
    const { PGlite } = createRequire(import.meta.url)(join(directory!, 'dist/index.cjs')) as { PGlite: new () => Db }; db = new PGlite();
    await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);grant usage on schema public to service_role;');
    for (const name of ['202609140100_company_profiles', '202609140200_company_collaboration', '202609200300_company_content', '20261007194528_international_workspace_country_config']) await db.exec(await readFile(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), 'utf8'));
    await db.query('insert into public.zentra_workspaces(organization_id,updated_by) values($1,$2)', [chOrg, chUser]);
    await db.query('select public.zentra_put_workspace_country_config($1,$2,0,$3::uuid,$4::jsonb)', [chOrg, chUser, randomUUID(), { schemaVersion: 1, organizationId: chOrg, country: 'CH', currency: 'CHF', language: 'fr', timeZone: 'Europe/Zurich', address: { country: 'CH', line1: '1 Rue Fictive', city: 'Genève', subdivision: 'GE', postalCode: '1201' }, accountingBasis: 'accrual', invoiceNumberPrefix: 'CH', taxConfiguration: { status: 'unconfigured' } }]); chBefore = await snapshotCH();
    for (const name of ['20261007222349_international_us_erp_persistence', '20261007224820_international_us_erp_delta_stream', '20261007225725_international_us_erp_seller_snapshot', '20261008001726_new_us_workspace_admission', '20261008013200_international_tax_proof_allowlist', '20261008034422_international_us_seller_profile', '20261008044402_international_us_tax_profile', '20261008060826_international_us_tax_operations', '20261008081825_international_us_purchasing_v2', '20261008105120_international_us_projects_v3', '20261008161118_international_us_journal_periods_v4', '20261008172520_international_us_tax_invoice_capability_v2', '20261008184605_international_us_bank_reconciliation', '20261008194930_international_us_supplier_proposals', '20261008210008_international_us_automation_analysis']) await db.exec(await readFile(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), 'utf8'));
    seeded = await fixture(); await seeded.propose(); await seeded.activate(); await seeded.claim();
    await db.exec(await readFile(new URL(`../../supabase/migrations/${migration}.sql`, import.meta.url), 'utf8'));
  }, 30000);
  afterAll(async () => { await db?.close(); });
  it('seeds existing private state without changing CH or historical source rows', async () => {
    const before = await seeded.read(); expect(before.erp?.revision).toBe(1); expect(before.channels.supplierProposals).toMatch(/^[a-f0-9]{64}$/); expect(await seeded.read()).toEqual(before);
    expect((await sql('select channel,scope from public.zentra_us_workspace_change_heads where organization_id=$1', [seeded.org])).length).toBe(3); expect(await snapshotCH()).toEqual(chBefore);
  });
  it('keeps stable tokens and advances supplier head without an ERP event or another workspace changing', async () => {
    const f = await fixture(), other = await fixture(), before = await f.read(), isolated = await other.read();
    await f.propose(); const after = await f.read(); expect(after.channels.supplierProposals).not.toBe(before.channels.supplierProposals); expect(after.erp).toEqual(before.erp); expect(after.channels.bankReconciliations).toBe(before.channels.bankReconciliations); expect(await other.read()).toEqual(isolated);
    expect(await f.read()).toEqual(after); expect(JSON.stringify(after)).not.toMatch(/private|invoice|example|authority|source|grant|price_TEST/);
  });
  it('tracks durable settings, held quota and dispatch independently without provider calls', async () => {
    const f = await fixture(), initial = await f.read(); await f.activate(); const active = await f.read(); expect(active.channels.supplierAnalysis).not.toBe(initial.channels.supplierAnalysis);
    const held = await f.claim(), reserved = await f.read(); expect(reserved.channels.supplierAnalysis).not.toBe(active.channels.supplierAnalysis);
    await f.automation.dispatch({ actor: f.actor, grant: f.grant, jobId: held.job.id, leaseToken: held.job.leaseToken! }); const sent = await f.read(); expect(sent.channels.supplierAnalysis).not.toBe(reserved.channels.supplierAnalysis); expect(sent.erp).toEqual(initial.erp);
    expect((await f.read({ grant: { ...f.grant, checkedAt: f.grant.checkedAt + 1 } })).channels.supplierAnalysis).toBe(sent.channels.supplierAnalysis);
    expect((await f.read({ analysisConfigurationHash: digest('TEST-new-policy') })).channels.supplierAnalysis).not.toBe(sent.channels.supplierAnalysis);
    expect((await f.read({ supplierAnalysis: false, grant: null, analysisConfigurationHash: null })).channels.supplierAnalysis).toBeNull();
  });
  it('advances a bank create at revision zero without changing the ERP head', async () => {
    const f = await fixture(), before = await f.read(), id = randomUUID(), book = (await f.erp.read(f.org))!;
    const statement = { id, organizationId: f.org, externalConnectionId: `manual:${id}`, currency: 'USD', cashAccountId: 'cash', start: '2026-10-01', end: '2026-10-31', opening: { currency: 'USD', minorUnits: '0' }, closing: { currency: 'USD', minorUnits: '10000' }, lines: [{ id: `${id}:1`, date: '2026-10-01', amount: { currency: 'USD', minorUnits: '10000' }, reference: 'Fictitious deposit' }] };
    const request = validateUsBankRequest({ schemaVersion: 1, idempotencyKey: randomUUID(), reconciliationId: id, expectedErpRevision: book.revision, expectedReconciliationRevision: null, command: { type: 'create_statement', statement } }, f.org);
    const record = applyUsBankCommand(null, request, book.ledger, f.actor, []);
    await f.bank.commit({ actor: f.actor, expectedErpRevision: book.revision, expectedReconciliationRevision: null, record, receipt: { schemaVersion: 1, organizationId: f.org, idempotencyKey: request.idempotencyKey, commandHash: digest(canonicalErpJson([f.org, f.actor.userId, request])), actorId: f.actor.userId, reconciliationId: id, action: 'create_statement', revision: 0, erpRevision: book.revision } });
    const after = await f.read(); expect(after.channels.bankReconciliations).not.toBe(before.channels.bankReconciliations); expect(after.erp).toEqual(before.erp);
  });
  it('isolates the analysis quota head by durable environment and month scope', async () => {
    const f = await fixture(); await f.activate(); const before = await f.read(), production = { ...f.grant, environment: 'PRODUCTION' as const };
    const otherBefore = await f.read({ grant: production });
    await f.automation.claim({ actor: f.actor, grant: production, source: f.source(), recipeVersion: 'extract1', requestId: randomUUID(), leaseToken: randomUUID() });
    expect(await f.read()).toEqual(before); expect((await f.read({ grant: production })).channels.supplierAnalysis).not.toBe(otherBefore.channels.supplierAnalysis);
  });
  it('uses existing seller/tax revisions and withholds both private heads from non-owners', async () => {
    const f = await fixture(), before = await f.read();
    await sql('select public.zentra_put_us_seller_profile($1,$2,0,$3::uuid,$4::jsonb)', [f.org, f.actor.userId, randomUUID(), { displayName: 'Fictitious seller', contactEmail: 'private@example.test', contactPhone: '+1 212 555 0100' }]);
    await sql('select public.zentra_put_us_tax_profile($1,$2,0,$3::uuid,$4::jsonb)', [f.org, f.actor.userId, randomUUID(), { schemaVersion: 1, legalName: 'Fictitious private legal name', taxOrigin: f.config.address, timeZone: f.config.timeZone }]);
    const after = await f.read(); expect(after.channels.sellerProfile).not.toBe(before.channels.sellerProfile); expect(after.channels.taxProfile).not.toBe(before.channels.taxProfile); expect(after.erp).toEqual(before.erp);
    for (const role of ['admin', 'accountant', 'member', 'read_only'] as const) expect((await f.read({}, { ...f.actor, role })).channels).toMatchObject({ sellerProfile: null, taxProfile: null });
  });
  it('returns null for missing books and disabled modules, and refuses older credential capability', async () => {
    const f = await fixture(false), empty = await f.read(); expect(empty.erp).toBeNull(); expect(empty.channels).toMatchObject({ supplierProposals: null, bankReconciliations: null, supplierAnalysis: null, team: null });
    const ready = await fixture(); expect((await ready.read({ supplierProposals: false, bankReconciliations: false, supplierAnalysis: false, grant: null, analysisConfigurationHash: null })).channels).toMatchObject({ supplierProposals: null, bankReconciliations: null, supplierAnalysis: null });
    await expect(createSupabaseUsWorkspaceSyncHeadsStore(client, { supportedSchemaVersion: 3 }).read(ready.actor, ready.selection)).rejects.toMatchObject({ code: 'client_upgrade_required' });
  });
  it('RLS remains enabled, functions invoker and private heads inaccessible to anon/authenticated', async () => {
    const flags = await db.query<{ relrowsecurity: boolean; prosecdef: boolean }>("select c.relrowsecurity,p.prosecdef from pg_class c join pg_namespace n on n.oid=c.relnamespace cross join pg_proc p where n.nspname='public' and c.relname='zentra_us_workspace_change_heads' and p.proname='zentra_us_workspace_sync_heads'"); expect(flags.rows).toEqual([{ relrowsecurity: true, prosecdef: false }]);
    for (const role of ['anon', 'authenticated'] as const) {
      await expect(sql('select * from public.zentra_us_workspace_change_heads', [], role)).rejects.toMatchObject({ code: '42501' });
      await expect(sql('select public.zentra_us_workspace_sync_heads($1,$2,4,true,true,true,$3,$4)', [seeded.org, seeded.actor, seeded.selection.analysisConfigurationHash, seeded.grant], role)).rejects.toMatchObject({ code: '42501' });
    }
    await expect(sql('select public.zentra_us_workspace_sync_heads($1,$2,4,true,true,true,$3,$4)', [seeded.org, { ...seeded.actor, organizationId: randomUUID() }, seeded.selection.analysisConfigurationHash, seeded.grant])).rejects.toMatchObject({ code: 'PW005' }); expect(await snapshotCH()).toEqual(chBefore);
  });
  it('fresh scope loss withholds a real PostgreSQL candidate', async () => {
    const f = await fixture(); let denied = false;
    const handlers = createUsWorkspaceSyncHeadsHandlers({ enabled: () => true, authority: async () => { if (denied) throw new AccountPublicError('TEST session revoked', 401); return { mode: 'browser', actor: f.actor }; }, configuration: async () => f.config, selection: async () => f.selection, freshSupportedSchemaVersion: () => 4, rateLimit: async () => {}, diagnostic: () => {}, teamHead: async () => 'a'.repeat(64), headsStore: () => ({ supportedSchemaVersion: 4, read: async () => { const head = await f.read(); denied = true; return head; } }) });
    const response = await handlers.GET(new Request('https://zentra.test/sync-heads', { headers: { 'X-Zentra-Erp-Schema-Version': '4' } }), f.org); expect(response.status).toBe(401); expect(await response.json()).not.toHaveProperty('channels');
  });
});
