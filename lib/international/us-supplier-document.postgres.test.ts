import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import type { FinancialAuthority } from './accounting/ledger';
import { createSupabaseErpStore } from './runtime-store';
import { canonicalErpJson, executeErp } from './runtime';
import type { ErpCommand, ErpCommit, ErpStore } from './runtime-types';
import type { CompanyConfiguration } from './types';
import type { UsSupplierApprovalRequest, UsSupplierProposal } from './us-supplier-contract';
import { createSupabaseUsSupplierStore } from './us-supplier-store';
import { supplierErpRequest, validateUsSupplierProposal } from './us-supplier-proposal';
import { validateUsSupplierExtraction } from './us-supplier-extraction';
import { createSupabaseUsAutomationStore } from './us-automation-store';
import type { UsAutomationGrant } from './us-automation-contract';
import { createSupabaseUsSupplierDocumentStore } from './us-supplier-document-store';
import type { UsSupplierDocumentDescriptor } from './us-supplier-document-contract';

// Real, disposable PostgreSQL/WASM, existing conforming legacy baseline and all
// twenty ordered international migrations. No hosted Auth/D1/R2 or provider.
// SQL receipts attest only this test's trusted fake archive boundary. PGlite
// serializes transactions; these tests do not prove hosted concurrent locking.
const directory = process.env.PGLITE_MODULE_DIR, enabled = Boolean(directory && isAbsolute(directory));
type Sql = { exec(sql: string): Promise<unknown>; query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> };
type Db = Sql & { close(): Promise<void>; transaction<T>(task: (tx: Sql) => Promise<T>): Promise<T> };
let db: Db;
const migration = '20261010005300_international_us_supplier_originals.sql';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const names: Record<string, string[]> = {
  zentra_read_us_erp_v4: ['p_organization'], zentra_us_erp_receipt_v4: ['p_organization', 'p_idempotency_key'],
  zentra_commit_us_erp: ['p_organization', 'p_expected_revision', 'p_header', 'p_changes', 'p_ledger_audit', 'p_receipt', 'p_actor'],
  zentra_list_us_supplier_documents: ['p_organization', 'p_actor', 'p_supported_schema_version'],
  zentra_read_us_supplier_document: ['p_organization', 'p_actor', 'p_supported_schema_version', 'p_id'],
  zentra_reserve_us_supplier_document: ['p_organization', 'p_actor', 'p_supported_schema_version', 'p_descriptor'],
  zentra_complete_us_supplier_document: ['p_organization', 'p_actor', 'p_supported_schema_version', 'p_id', 'p_content_sha256', 'p_size_bytes'],
  zentra_link_us_supplier_document: ['p_organization', 'p_actor', 'p_supported_schema_version', 'p_id', 'p_proposal'],
  zentra_create_us_supplier_proposal: ['p_organization', 'p_actor', 'p_supported_schema_version', 'p_proposal'],
  zentra_read_us_supplier_proposal: ['p_organization', 'p_actor', 'p_supported_schema_version', 'p_id'],
  zentra_approve_us_supplier_proposal: ['p_organization', 'p_actor', 'p_supported_schema_version', 'p_request', 'p_request_hash', 'p_erp'],
  zentra_read_us_automation_settings: ['p_organization', 'p_actor', 'p_supported_schema_version'],
  zentra_save_us_automation_settings: ['p_organization', 'p_actor', 'p_supported_schema_version', 'p_request'],
  zentra_claim_us_automation_analysis: ['p_organization', 'p_actor', 'p_supported_schema_version', 'p_grant', 'p_source', 'p_recipe_version', 'p_request_id', 'p_lease_token'],
  zentra_dispatch_us_automation_analysis: ['p_organization', 'p_actor', 'p_supported_schema_version', 'p_grant', 'p_job_id', 'p_lease_token'],
  zentra_complete_us_automation_analysis: ['p_organization', 'p_actor', 'p_supported_schema_version', 'p_grant', 'p_job_id', 'p_dispatch_id', 'p_result_body', 'p_result_sha256'],
};
async function sql<T = Record<string, unknown>>(query: string, values: unknown[] = [], role = 'service_role') {
  return db.transaction(async tx => { await tx.exec(`set local role ${role}`); return (await tx.query<T>(query, values)).rows; });
}
function statement(name: string) { return `select public.${name}(${names[name].map((_, index) => `$${index + 1}`).join(',')}) result`; }
async function raw(name: string, input: Record<string, unknown>) { return (await sql<{ result: unknown }>(statement(name), names[name].map(key => input[key])))[0].result; }
const client = { async rpc<T>(name: string, input: Record<string, unknown>): Promise<T> {
  if (!Object.hasOwn(names, name)) throw new Error(`Missing TEST adapter ${name}`);
  try { return await raw(name, input) as T; } catch (error) {
    if (process.env.ZENTRA_LOCAL_SQL_DEBUG === '1') console.error('TEST SQL', (error as Error).message, (error as { code?: string }).code, (error as { where?: string }).where);
    throw new SupabaseServerError(503, (error as { code?: string }).code ?? '', 'test-rpc');
  }
} } as Pick<SupabaseServerClient, 'rpc'>;
const unknownExtraction = () => validateUsSupplierExtraction({ schemaVersion: 1, kind: 'unknown', confidence: 0, fields: {}, evidence: {}, fieldConfidence: {}, issues: [] });
const chOrg = randomUUID(), chUser = randomUUID(); let chBefore: unknown;
const snapshotCH = async () => (await db.query('select to_jsonb(w) workspace,to_jsonb(c) country from public.zentra_workspaces w join public.zentra_workspace_country_configs c using(organization_id) where w.organization_id=$1', [chOrg])).rows;
async function fixture() {
  const org = randomUUID(), userId = randomUUID(), now = new Date();
  const actor: FinancialAuthority = { organizationId: org, userId, role: 'owner', managementEntitled: true, timestamp: now.toISOString() };
  const configuration: CompanyConfiguration = { schemaVersion: 1, organizationId: org, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York', address: { country: 'US', line1: '1 Fictitious Avenue', city: 'New York', subdivision: 'NY', postalCode: '10001' }, accountingBasis: 'accrual', invoiceNumberPrefix: 'TEST', taxConfiguration: { status: 'unconfigured' } };
  await sql('select public.zentra_admit_new_us_workspace_v1($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::jsonb,$6)', [org, randomUUID(), userId, randomUUID(), JSON.stringify(configuration), digest(org)]);
  const erp = createSupabaseErpStore(client, { supportedSchemaVersion: 4 }), documents = createSupabaseUsSupplierDocumentStore(client, { supportedSchemaVersion: 4 });
  const suppliers = createSupabaseUsSupplierStore(client, { supportedSchemaVersion: 4 }), automation = createSupabaseUsAutomationStore(client, { supportedSchemaVersion: 4 });
  let sequence = 0;
  const send = async (command: ErpCommand) => executeErp({ store: erp, configuration, actor, revalidate: async () => actor, taxProvider: async () => null }, { idempotencyKey: `TEST-${++sequence}`, expectedRevision: (await erp.read(org))?.revision ?? 0, command });
  await send({ type: 'initialize', periods: [{ id: 'year', start: '2026-01-01', end: '2026-12-31', status: 'open' }] });
  await send({ type: 'save_vendor', vendor: { id: 'vendor', organizationId: org, kind: 'business', name: 'Fictitious supplier', billingAddress: configuration.address, paymentTermsDays: 30 } });
  const descriptor = (suffix = '', patch: Partial<UsSupplierDocumentDescriptor> = {}): UsSupplierDocumentDescriptor => {
    const documentText = `Fictitious supplier invoice ${suffix}\nUSD subtotal 100.00\nPrinted tax 8.25\nTotal 108.25`;
    return { schemaVersion: 1, organizationId: org, id: randomUUID(), contentSha256: digest(`Fictitious PDF bytes ${suffix}`), sizeBytes: 500, mediaType: 'application/pdf', fileName: 'Fictitious.pdf', documentText, textSha256: digest(documentText), createdBy: userId, createdAt: actor.timestamp, ...patch };
  };
  const proposal = (d: UsSupplierDocumentDescriptor): UsSupplierProposal => validateUsSupplierProposal({ schemaVersion: 1, organizationId: org, id: randomUUID(), revision: 0, state: 'review', createdBy: userId, createdAt: actor.timestamp,
    source: { kind: 'document_import', sha256: d.textSha256, documentText: d.documentText, fileName: 'Fictitious.txt', mediaType: 'text/plain', workspaceId: null, connectionId: null, messageId: null, receivedAt: actor.timestamp }, extraction: unknownExtraction() }, org);
  const stored = async (d: UsSupplierDocumentDescriptor) => { await documents.reserve(actor, d); return documents.complete(actor, d.id, d.contentSha256, d.sizeBytes); };
  const approval = async (p: UsSupplierProposal) => {
    const request: UsSupplierApprovalRequest = { schemaVersion: 1, idempotencyKey: randomUUID(), proposalId: p.id, expectedProposalRevision: 0, expectedErpRevision: (await erp.read(org))!.revision, confirmed: true, taxReviewed: true,
      review: { vendorId: 'vendor', reference: `TEST-${p.id}`, date: '2026-10-01', accountingDate: '2026-10-02', dueDate: '2026-10-31', periodId: 'year', netMinor: '10000', printedTaxMinor: '825' } };
    let commit: ErpCommit | undefined;
    const capture: ErpStore = { ...erp, commit: async input => { commit = input; return input.receipt; } };
    await executeErp({ store: capture, configuration, actor, revalidate: async () => actor, taxProvider: async () => null }, supplierErpRequest(p, request));
    if (!commit) throw new Error('Missing TEST financial commit');
    return { actor, request, requestHash: digest(canonicalErpJson([org, userId, request])), erp: commit };
  };
  const base = { p_organization: org, p_actor: actor, p_supported_schema_version: 4 };
  return { org, actor, now, configuration, erp, documents, suppliers, automation, descriptor, proposal, stored, approval, base };
}

describe.skipIf(!enabled)('US supplier original private PostgreSQL history', () => {
  beforeAll(async () => {
    const { PGlite } = createRequire(import.meta.url)(join(directory!, 'dist/index.cjs')) as { PGlite: new () => Db }; db = new PGlite();
    await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);grant usage on schema public to service_role;');
    for (const name of ['202609140100_company_profiles.sql', '202609140200_company_collaboration.sql', '202609200300_company_content.sql', '20261007194528_international_workspace_country_config.sql']) await db.exec(await readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8'));
    await sql('insert into public.zentra_workspaces(organization_id,updated_by)values($1,$2)', [chOrg, chUser]);
    await sql('select public.zentra_put_workspace_country_config($1,$2,0,$3::uuid,$4::jsonb)', [chOrg, chUser, randomUUID(), JSON.stringify({ schemaVersion: 1, organizationId: chOrg, country: 'CH', currency: 'CHF', language: 'fr', timeZone: 'Europe/Zurich', address: { country: 'CH', line1: '1 Rue Fictive', city: 'Genève', subdivision: 'GE', postalCode: '1201' }, accountingBasis: 'accrual', invoiceNumberPrefix: 'CH', taxConfiguration: { status: 'unconfigured' } })]);
    chBefore = await snapshotCH();
    const chain = (await readdir(new URL('../../supabase/migrations/', import.meta.url))).filter(name => name > '20261007194528_international_workspace_country_config.sql' && name <= migration && name.endsWith('.sql')).sort();
    expect(chain).toHaveLength(19); // previous nineteen international files + this one, country already loaded
    for (const name of chain) await db.exec(await readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8'));
  }, 30_000);
  afterAll(async () => { await db?.close(); });

  it('retains immutable readable/unreadable descriptors and private receipt projections for all admitted media', async () => {
    const f = await fixture();
    for (const mediaType of ['application/pdf', 'image/png', 'image/jpeg', 'text/plain'] as const) {
      const d = f.descriptor(mediaType, { mediaType, ...(mediaType === 'image/jpeg' ? { documentText: null, textSha256: null } : {}) });
      expect(await f.documents.reserve(f.actor, d)).toEqual({ ...d, stored: false, proposalId: null });
      expect(await f.documents.complete(f.actor, d.id, d.contentSha256, d.sizeBytes)).toEqual({ ...d, stored: true, proposalId: null });
    }
    expect(await f.documents.list(f.actor)).toHaveLength(4); expect((await f.documents.list(f.actor)).some(d => d.documentText === null)).toBe(true);
    expect(await f.documents.read(f.actor, randomUUID())).toBeNull();
  });
  it('keeps first author/date/text and filename on exact retries and canonical raw-byte duplicate imports', async () => {
    const f = await fixture(), d = f.descriptor(), first = await f.stored(d), later = { ...f.actor, timestamp: new Date(f.now.getTime() + 2000).toISOString() };
    expect(await f.documents.reserve(later, { ...d, createdAt: later.timestamp })).toEqual(first);
    const colleague = { ...later, userId: randomUUID(), role: 'accountant' as const };
    expect(await f.documents.reserve(colleague, { ...d, id: randomUUID(), createdBy: colleague.userId, createdAt: colleague.timestamp, fileName: 'renamed.pdf', documentText: null, textSha256: null })).toEqual(first);
    expect(await f.documents.complete(colleague, d.id, d.contentSha256, d.sizeBytes)).toEqual(first);
    expect(await sql('select count(*)::int count from public.zentra_us_supplier_document_receipts where organization_id=$1', [f.org])).toEqual([{ count: 1 }]);
  });
  it('refuses changed ID retries, forged text digest and inconsistent raw digest descriptors directly in SQL', async () => {
    const f = await fixture(), d = f.descriptor(); await f.documents.reserve(f.actor, d);
    for (const patch of [{ fileName: 'changed.pdf' }, { contentSha256: digest('different bytes') }, { documentText: null, textSha256: null }, { createdBy: randomUUID() }]) await expect(raw('zentra_reserve_us_supplier_document', { ...f.base, p_descriptor: { ...d, ...patch } })).rejects.toBeInstanceOf(Error);
    for (const patch of [{ textSha256: 'f'.repeat(64) }, { documentText: null }, { documentText: 'x'.repeat(16385), textSha256: digest('x'.repeat(16385)) }, { extra: 'PRIVATE' }]) await expect(raw('zentra_reserve_us_supplier_document', { ...f.base, p_descriptor: { ...d, id: randomUUID(), ...patch } })).rejects.toMatchObject({ code: 'PD001' });
    await expect(f.documents.reserve(f.actor, { ...d, id: randomUUID(), sizeBytes: 501 })).rejects.toMatchObject({ code: 'supplier_document_conflict' });
    expect(await f.documents.list(f.actor)).toHaveLength(1);
  });
  it('requires exact complete bytes identity and preserves append-only metadata/receipts even under privileged SQL', async () => {
    const f = await fixture(), d = f.descriptor(); await f.documents.reserve(f.actor, d);
    await expect(f.documents.complete(f.actor, randomUUID(), d.contentSha256, d.sizeBytes)).rejects.toMatchObject({ code: 'supplier_document_not_found' });
    await expect(f.documents.complete(f.actor, d.id, digest('wrong'), d.sizeBytes)).rejects.toMatchObject({ code: 'supplier_document_conflict' });
    await expect(f.documents.complete(f.actor, d.id, d.contentSha256, 501)).rejects.toMatchObject({ code: 'supplier_document_conflict' });
    expect((await f.documents.read(f.actor, d.id))?.stored).toBe(false); await f.stored(d);
    await expect(db.query('update public.zentra_us_supplier_documents set payload=payload where organization_id=$1', [f.org])).rejects.toMatchObject({ code: 'PD002' });
    await expect(db.query('delete from public.zentra_us_supplier_document_receipts where organization_id=$1', [f.org])).rejects.toMatchObject({ code: 'PD002' });
    await expect(db.exec('truncate public.zentra_us_supplier_document_links')).rejects.toMatchObject({ code: 'PD002' });
    expect((await f.documents.read(f.actor, d.id))?.stored).toBe(true);
  });
  it('executes real durable analysis → original link → one financial journal and exact historical replay', async () => {
    const f = await fixture(), d = f.descriptor(); await f.stored(d);
    const grant: UsAutomationGrant = { schemaVersion: 1, organizationId: f.org, environment: 'TEST', bucket: 'supplier_invoice_extract', periodId: `${f.now.getUTCFullYear()}-${String(f.now.getUTCMonth() + 1).padStart(2, '0')}`, periodStart: Date.UTC(f.now.getUTCFullYear(), f.now.getUTCMonth(), 1) / 1000, periodEnd: Date.UTC(f.now.getUTCFullYear(), f.now.getUTCMonth() + 1, 1) / 1000,
      limit: 2, subscriptionId: 'TEST-sub', authorityReference: 'TEST-authority', catalogVersion: 'TEST-catalog', priceId: 'price_TEST', budgetPolicyVersion: 'budget1', processingPolicyVersion: 'processing1', checkedAt: Math.floor(f.now.getTime() / 1000) };
    await f.automation.saveSettings(f.actor, { schemaVersion: 1, requestId: randomUUID(), expectedRevision: 0, action: 'activate', processingPolicyVersion: grant.processingPolicyVersion, consent: true });
    const candidate = f.proposal(d), claim = await f.automation.claim({ actor: f.actor, grant, source: candidate.source, recipeVersion: 'TEST-original-text1', requestId: randomUUID(), leaseToken: randomUUID() });
    const dispatched = await f.automation.dispatch({ actor: f.actor, grant, jobId: claim.job.id, leaseToken: claim.job.leaseToken! });
    const resultBody = canonicalErpJson(unknownExtraction()), completion = { actor: f.actor, grant, jobId: dispatched.job.id, dispatchId: dispatched.job.dispatchId!, resultBody, resultSha256: digest(resultBody) };
    const prepared = await f.automation.complete(completion), linked = await f.documents.link(f.actor, d.id, prepared.proposal);
    expect(linked.proposalId).toBe(prepared.proposal.id); expect(await f.automation.complete(completion)).toEqual(prepared);
    const approval = await f.approval(prepared.proposal), recording = await f.suppliers.approve(approval);
    expect(await f.suppliers.approve(approval)).toEqual(recording);
    const recorded = (await f.suppliers.read(f.actor, prepared.proposal.id))!;
    expect(recorded.state).toBe('recorded'); expect(await f.documents.link(f.actor, d.id, recorded)).toEqual(linked); expect(await f.documents.link(f.actor, d.id, prepared.proposal)).toEqual(linked);
    expect(await sql('select (select count(*) from public.zentra_us_erp_records where organization_id=$1 and kind=\'vendor_bill\')::int bills,(select count(*) from public.zentra_us_erp_records where organization_id=$1 and kind=\'journal\')::int journals,(select count(*) from public.zentra_us_supplier_document_links where organization_id=$1)::int links,(select count(*) from public.zentra_us_analysis_jobs where organization_id=$1)::int analyses', [f.org])).toEqual([{ bills: 1, journals: 1, links: 1, analyses: 1 }]);
  });
  it('refuses a first link after financial recording instead of fabricating retroactive original proof', async () => {
    const f = await fixture(), d = f.descriptor(); await f.stored(d); const p = await f.suppliers.create(f.actor, f.proposal(d));
    await f.suppliers.approve(await f.approval(p));
    await expect(f.documents.link(f.actor, d.id, p)).rejects.toMatchObject({ code: 'supplier_document_conflict' });
    await expect(f.documents.link(f.actor, d.id, (await f.suppliers.read(f.actor, p.id))!)).rejects.toMatchObject({ code: 'supplier_document_conflict' });
    expect((await f.documents.read(f.actor, d.id))?.proposalId).toBeNull();
  });
  it('requires stored bytes, readable exact text and the current immutable proposal snapshot before linkage', async () => {
    const f = await fixture(), d = f.descriptor(), p = await f.suppliers.create(f.actor, f.proposal(d)); await f.documents.reserve(f.actor, d);
    await expect(f.documents.link(f.actor, d.id, p)).rejects.toMatchObject({ code: 'supplier_document_conflict' }); await f.stored(d);
    await expect(f.documents.link(f.actor, d.id, { ...p, source: { ...p.source, fileName: 'forged.txt' } })).rejects.toMatchObject({ code: 'supplier_document_conflict' });
    const other = f.descriptor('different'); await f.stored(other); await expect(f.documents.link(f.actor, other.id, p)).rejects.toMatchObject({ code: 'supplier_document_conflict' });
    const unreadable = f.descriptor('unreadable', { documentText: null, textSha256: null }); await f.stored(unreadable); await expect(f.documents.link(f.actor, unreadable.id, p)).rejects.toMatchObject({ code: 'supplier_document_conflict' });
    expect((await f.documents.read(f.actor, d.id))?.proposalId).toBeNull();
  });
  it('does not adopt two distinct originals with identical extracted text as the same proposal', async () => {
    const f = await fixture(), a = f.descriptor(), b = { ...a, id: randomUUID(), contentSha256: digest('another original same extracted text') }; await f.stored(a); await f.stored(b);
    const p = await f.suppliers.create(f.actor, f.proposal(a));
    const outcomes = await Promise.allSettled([f.documents.link(f.actor, a.id, p), f.documents.link(f.actor, b.id, p)]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1); expect(outcomes.filter(result => result.status === 'rejected')).toMatchObject([{ reason: { code: 'supplier_document_conflict' } }]);
    expect((await f.documents.list(f.actor)).filter(d => d.proposalId === p.id)).toHaveLength(1);
  });
  it('rejects cross-org scope, nonfinancial actors and old/null capabilities and preserves CH data', async () => {
    const f = await fixture(), other = await fixture(), d = f.descriptor(); await f.stored(d);
    expect(await other.documents.read(other.actor, d.id)).toBeNull();
    await expect(other.documents.complete(other.actor, d.id, d.contentSha256, d.sizeBytes)).rejects.toMatchObject({ code: 'supplier_document_not_found' });
    for (const p_actor of [{ ...f.actor, organizationId: other.org }, { ...f.actor, role: 'member' }, { ...f.actor, role: 'read_only' }, { ...f.actor, managementEntitled: false }]) await expect(raw('zentra_list_us_supplier_documents', { ...f.base, p_actor })).rejects.toMatchObject({ code: 'PS005' });
    for (const cap of [1, 2, 3, null]) await expect(raw('zentra_list_us_supplier_documents', { ...f.base, p_supported_schema_version: cap })).rejects.toMatchObject({ code: 'PS006' });
    await expect(raw('zentra_list_us_supplier_documents', { ...f.base, p_organization: chOrg, p_actor: { ...f.actor, organizationId: chOrg } })).rejects.toMatchObject({ code: 'PS006' });
    await expect(other.documents.link(other.actor, d.id, f.proposal(d))).rejects.toMatchObject({ status: 422 }); expect(await snapshotCH()).toEqual(chBefore);
  });
  it('enforces 50-document and 100MiB organization limits atomically while exact replay remains available', async () => {
    const count = await fixture(), first = count.descriptor('0'); await count.documents.reserve(count.actor, first);
    for (let n = 1; n < 50; n++) await count.documents.reserve(count.actor, count.descriptor(String(n)));
    await expect(count.documents.reserve(count.actor, count.descriptor('51'))).rejects.toMatchObject({ code: 'supplier_document_limit_reached' });
    expect((await count.documents.reserve(count.actor, { ...first, id: randomUUID() })).id).toBe(first.id);
    const bytes = await fixture(); for (let n = 0; n < 16; n++) await bytes.documents.reserve(bytes.actor, bytes.descriptor(String(n), { sizeBytes: 6 * 1024 * 1024 }));
    await expect(bytes.documents.reserve(bytes.actor, bytes.descriptor('overflow', { sizeBytes: 6 * 1024 * 1024 }))).rejects.toMatchObject({ code: 'supplier_document_limit_reached' });
    await bytes.documents.reserve(bytes.actor, bytes.descriptor('remaining', { sizeBytes: 4 * 1024 * 1024 }));
    await expect(bytes.documents.reserve(bytes.actor, bytes.descriptor('one-byte', { sizeBytes: 1 }))).rejects.toMatchObject({ code: 'supplier_document_limit_reached' });
    expect(await bytes.documents.list(bytes.actor)).toHaveLength(17);
  }, 20_000);
  it('keeps all relations RLS service-only and every RPC INVOKER with empty search_path', async () => {
    const tables = ['zentra_us_supplier_documents', 'zentra_us_supplier_document_receipts', 'zentra_us_supplier_document_links'];
    const rows = await db.query<{ relname: string; relrowsecurity: boolean; anon: boolean; authenticated: boolean; service: boolean; update: boolean }>('select c.relname,c.relrowsecurity,has_table_privilege(\'anon\',c.oid,\'SELECT\') anon,has_table_privilege(\'authenticated\',c.oid,\'INSERT\') authenticated,has_table_privilege(\'service_role\',c.oid,\'SELECT,INSERT\') service,has_table_privilege(\'service_role\',c.oid,\'UPDATE,DELETE,TRUNCATE\') update from pg_class c where c.relname=any($1::text[])', [tables]);
    expect(rows.rows).toHaveLength(3); for (const row of rows.rows) expect(row).toMatchObject({ relrowsecurity: true, anon: false, authenticated: false, service: true, update: false });
    const functions = await db.query<{ prosecdef: boolean; proconfig: string[]; anon: boolean; authenticated: boolean; service: boolean }>("select p.prosecdef,p.proconfig,has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,has_function_privilege('service_role',p.oid,'EXECUTE') service from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (p.proname like 'zentra_us_supplier_document_%' or p.proname=any($1::text[]))", [Object.keys(names).filter(name => /_us_supplier_document/.test(name))]);
    expect(functions.rows).toHaveLength(10); for (const row of functions.rows) expect(row).toMatchObject({ prosecdef: false, proconfig: ['search_path=""'], anon: false, authenticated: false, service: true });
    const f = await fixture(); for (const role of ['anon', 'authenticated']) {
      await expect(sql(statement('zentra_list_us_supplier_documents'), [f.org, f.actor, 4], role)).rejects.toMatchObject({ code: '42501' });
      for (const table of tables) await expect(sql(`select * from public.${table}`, [], role)).rejects.toMatchObject({ code: '42501' });
    }
    expect(await snapshotCH()).toEqual(chBefore);
  });
});
