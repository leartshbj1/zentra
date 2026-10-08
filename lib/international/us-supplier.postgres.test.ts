import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import { createSupabaseErpStore } from './runtime-store';
import { canonicalErpJson, executeErp } from './runtime';
import { createSupabaseErpSyncStore } from './runtime-sync-store';
import { applyErpDelta } from './runtime-sync';
import { createSupabaseUsSupplierStore } from './us-supplier-store';
import { supplierErpRequest, validateUsSupplierProposal } from './us-supplier-proposal';
import { validateUsSupplierExtraction } from './us-supplier-extraction';
import type { FinancialAuthority } from './accounting/ledger';
import type { CompanyConfiguration } from './types';
import type { ErpCommand, ErpCommit, ErpStore } from './runtime-types';
import type { UsSupplierApprovalRequest, UsSupplierProposal } from './us-supplier-contract';

const directory = process.env.PGLITE_MODULE_DIR, enabled = Boolean(directory && isAbsolute(directory));
type Sql = { exec(sql: string): Promise<unknown>; query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> };
type Db = Sql & { close(): Promise<void>; transaction<T>(task: (tx: Sql) => Promise<T>): Promise<T> };
let db: Db;
const migration = '20261008194930_international_us_supplier_proposals';
const chOrg = randomUUID(), chUser = randomUUID(); let chBefore: unknown;
const snapshotCH = async () => (await db.query('select to_jsonb(w) workspace,to_jsonb(c) country from public.zentra_workspaces w join public.zentra_workspace_country_configs c using(organization_id) where w.organization_id=$1', [chOrg])).rows;
const rpcQueries: Record<string, [string, string[]]> = {
  zentra_read_us_erp_v4: ['select public.zentra_read_us_erp_v4($1) result', ['p_organization']],
  zentra_us_erp_receipt_v4: ['select public.zentra_us_erp_receipt_v4($1,$2) result', ['p_organization', 'p_idempotency_key']],
  zentra_us_erp_delta_v4: ['select public.zentra_us_erp_delta_v4($1,$2,$3) result', ['p_organization', 'p_after_revision', 'p_limit']],
  zentra_commit_us_erp: ['select public.zentra_commit_us_erp($1,$2,$3,$4,$5,$6,$7) result', ['p_organization', 'p_expected_revision', 'p_header', 'p_changes', 'p_ledger_audit', 'p_receipt', 'p_actor']],
  zentra_list_us_supplier_proposals: ['select public.zentra_list_us_supplier_proposals($1,$2,$3) result', ['p_organization', 'p_actor', 'p_supported_schema_version']],
  zentra_read_us_supplier_proposal: ['select public.zentra_read_us_supplier_proposal($1,$2,$3,$4) result', ['p_organization', 'p_actor', 'p_supported_schema_version', 'p_id']],
  zentra_find_us_supplier_source: ['select public.zentra_find_us_supplier_source($1,$2,$3,$4) result', ['p_organization', 'p_actor', 'p_supported_schema_version', 'p_sha256']],
  zentra_create_us_supplier_proposal: ['select public.zentra_create_us_supplier_proposal($1,$2,$3,$4) result', ['p_organization', 'p_actor', 'p_supported_schema_version', 'p_proposal']],
  zentra_approve_us_supplier_proposal: ['select public.zentra_approve_us_supplier_proposal($1,$2,$3,$4,$5,$6) result', ['p_organization', 'p_actor', 'p_supported_schema_version', 'p_request', 'p_request_hash', 'p_erp']],
};
async function sql<T = Record<string, unknown>>(query: string, values: unknown[] = [], role = 'service_role') {
  return db.transaction(async tx => { await tx.exec(`set local role ${role}`); return (await tx.query<T>(query, values)).rows; });
}
const client = { async rpc<T>(name: string, input: Record<string, unknown>): Promise<T> {
  const spec = rpcQueries[name]; if (!spec) throw new Error(`Missing TEST SQL adapter ${name}`);
  try { return (await sql<{ result: T }>(spec[0], spec[1].map(key => input[key])))[0].result; }
  catch (error) { if (process.env.ZENTRA_LOCAL_SQL_DEBUG === '1') console.error('TEST SQL', (error as Error).message, (error as { code?: string }).code, (error as { where?: string }).where); throw new SupabaseServerError(503, (error as { code?: string }).code ?? '', 'test-rpc'); }
} } as Pick<SupabaseServerClient, 'rpc'>;
const hash = (value: unknown) => createHash('sha256').update(canonicalErpJson(value)).digest('hex');
type Mutable<T> = T extends readonly (infer Item)[] ? Mutable<Item>[] : T extends object ? { -readonly [Field in keyof T]: Mutable<T[Field]> } : T;
function mutable<T>(value: T): Mutable<T> { return structuredClone(value) as Mutable<T>; }
function extractedCurrencyProposal(p: UsSupplierProposal, currency: 'USD' | 'EUR', printedTaxMinor = '825'): UsSupplierProposal {
  const fields = { supplierName: 'Fictitious US vendor', reference: `TEST-${p.id}`, invoiceDate: '2026-10-01', dueDate: '2026-10-31', currency, netMinor: '10000', printedTaxMinor, totalMinor: (BigInt('10000') + BigInt(printedTaxMinor)).toString() };
  const documentText = `Fictitious supplier invoice\n${Object.values(fields).join('\n')}`;
  return validateUsSupplierProposal({ ...p, source: { ...p.source, documentText, sha256: createHash('sha256').update(documentText).digest('hex') },
    extraction: validateUsSupplierExtraction({ schemaVersion: 1, kind: 'vendor_invoice', confidence: 1, fields, evidence: fields,
      fieldConfidence: Object.fromEntries(Object.keys(fields).map(key => [key, 1])), issues: [] }) }, p.organizationId);
}
async function fixture(basis: 'cash' | 'accrual' = 'accrual') {
  const org = randomUUID(), userId = randomUUID();
  const actor: FinancialAuthority = { organizationId: org, userId, role: 'owner', managementEntitled: true, timestamp: '2026-10-08T12:00:00.000Z' };
  const config: CompanyConfiguration = { schemaVersion: 1, organizationId: org, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York', address: { country: 'US', line1: '1 Fictitious Avenue', city: 'New York', subdivision: 'NY', postalCode: '10001' }, accountingBasis: basis, invoiceNumberPrefix: 'TEST', taxConfiguration: { status: 'unconfigured' } };
  await sql('select public.zentra_admit_new_us_workspace_v1($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::jsonb,$6)', [org, randomUUID(), userId, randomUUID(), JSON.stringify(config), createHash('sha256').update(org).digest('hex')]);
  const erp = createSupabaseErpStore(client, { supportedSchemaVersion: 4 }), store = createSupabaseUsSupplierStore(client, { supportedSchemaVersion: 4 });
  let sequence = 0;
  const erpSend = async (command: ErpCommand) => executeErp({ store: erp, configuration: config, actor, revalidate: async () => actor, taxProvider: async () => null }, { idempotencyKey: `erp-${++sequence}`, expectedRevision: (await erp.read(org))?.revision ?? 0, command });
  await erpSend({ type: 'initialize', periods: [{ id: 'year', start: '2026-01-01', end: '2026-12-31', status: 'open' }] });
  await erpSend({ type: 'save_vendor', vendor: { id: 'vendor', organizationId: org, kind: 'business', name: 'Fictitious US vendor', billingAddress: config.address, paymentTermsDays: 30 } });
  const proposal = (suffix = ''): UsSupplierProposal => {
    const documentText = `Fictitious supplier invoice ${suffix}\nUSD subtotal 100.00\nPrinted tax 8.25\nTotal 108.25`;
    return validateUsSupplierProposal({ schemaVersion: 1, organizationId: org, id: randomUUID(), revision: 0, state: 'review', createdBy: userId, createdAt: actor.timestamp,
      source: { kind: 'document_import', sha256: createHash('sha256').update(documentText).digest('hex'), fileName: `test-${suffix}.txt`, mediaType: 'text/plain', workspaceId: null, connectionId: null, messageId: null, receivedAt: actor.timestamp, documentText },
      extraction: validateUsSupplierExtraction({ schemaVersion: 1, kind: 'unknown', confidence: 0, fields: {}, evidence: {}, fieldConfidence: {}, issues: [] }) }, org);
  };
  const prepare = async (p: UsSupplierProposal, key = randomUUID(), review: Partial<UsSupplierApprovalRequest['review']> = {}) => {
    const book = (await erp.read(org))!;
    const request: UsSupplierApprovalRequest = { schemaVersion: 1, idempotencyKey: key, proposalId: p.id, expectedProposalRevision: 0, expectedErpRevision: book.revision, confirmed: true, taxReviewed: true,
      review: { vendorId: 'vendor', reference: `TEST-${p.id}`, date: '2026-10-01', accountingDate: '2026-10-02', dueDate: '2026-10-31', periodId: 'year', netMinor: '10000', printedTaxMinor: '825', ...review } };
    let commit: ErpCommit | undefined;
    const capture: ErpStore = { ...erp, commit: async input => { commit = input; return input.receipt; } };
    await executeErp({ store: capture, configuration: config, actor, revalidate: async () => actor, taxProvider: async () => null }, supplierErpRequest(p, request));
    if (!commit) throw new Error('Real ERP command did not prepare a TEST commit');
    return { actor, request, requestHash: hash([org, userId, request]), erp: commit };
  };
  const raw = (input: Awaited<ReturnType<typeof prepare>>, cap: number | null = 4) => sql(rpcQueries.zentra_approve_us_supplier_proposal[0], [org, input.actor, cap, input.request, input.requestHash, input.erp]);
  const counts = () => sql('select (select count(*)from public.zentra_us_supplier_audit where organization_id=$1)::int audits,(select count(*)from public.zentra_us_erp_records where organization_id=$1 and kind=\'vendor_bill\')::int bills,(select count(*)from public.zentra_us_erp_records where organization_id=$1 and kind=\'journal\')::int journals,(select count(*)from public.zentra_us_erp_events where organization_id=$1)::int events', [org]);
  return { org, actor, config, erp, store, erpSend, proposal, prepare, raw, counts };
}

/** Actual disposable PostgreSQL/WASM, full additive chain, real ERP engine and
 * guarded service RPC. Fictitious sources/actors only; no hosted Auth/D1, mail,
 * JEV API, tax provider, production migration or fund transfer is established. */
describe.skipIf(!enabled)('US supplier PostgreSQL proposal and human approval transaction', () => {
  beforeAll(async () => {
    const require = createRequire(import.meta.url), { PGlite } = require(join(directory!, 'dist/index.cjs')) as { PGlite: new () => Db }; db = new PGlite();
    await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);grant usage on schema public to service_role;');
    for (const name of ['202609140100_company_profiles', '202609140200_company_collaboration', '202609200300_company_content', '20261007194528_international_workspace_country_config']) await db.exec(await readFile(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), 'utf8'));
    await db.query('insert into public.zentra_workspaces(organization_id,updated_by)values($1,$2)', [chOrg, chUser]);
    await db.query('select public.zentra_put_workspace_country_config($1,$2,0,$3::uuid,$4::jsonb)', [chOrg, chUser, randomUUID(), JSON.stringify({ schemaVersion: 1, organizationId: chOrg, country: 'CH', currency: 'CHF', language: 'fr', timeZone: 'Europe/Zurich', address: { country: 'CH', line1: '1 Rue Fictive', city: 'Genève', subdivision: 'GE', postalCode: '1201' }, accountingBasis: 'accrual', invoiceNumberPrefix: 'CH', taxConfiguration: { status: 'unconfigured' } })]); chBefore = await snapshotCH();
    for (const name of ['20261007222349_international_us_erp_persistence', '20261007224820_international_us_erp_delta_stream', '20261007225725_international_us_erp_seller_snapshot', '20261008001726_new_us_workspace_admission', '20261008013200_international_tax_proof_allowlist', '20261008034422_international_us_seller_profile', '20261008044402_international_us_tax_profile', '20261008060826_international_us_tax_operations', '20261008081825_international_us_purchasing_v2', '20261008105120_international_us_projects_v3', '20261008161118_international_us_journal_periods_v4', '20261008172520_international_us_tax_invoice_capability_v2', '20261008184605_international_us_bank_reconciliation', migration]) await db.exec(await readFile(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), 'utf8'));
  }, 30_000);
  afterAll(async () => { await db?.close(); });
  it.each(['cash', 'accrual'] as const)('records reviewed printed purchase tax as cost in %s, preserving exact delta/history', async basis => {
    const f = await fixture(basis), p = f.proposal(); const before = (await f.erp.read(f.org))!;
    expect(await f.store.create(f.actor, p)).toEqual(p); expect(await f.erp.read(f.org)).toEqual(before);
    const approved = await f.prepare(p), result = await f.store.approve(approved), after = (await f.erp.read(f.org))!;
    expect(result.erpReceipt).toEqual(approved.erp.receipt); expect(after.vendorBills?.[0]).toMatchObject({ approvalSource: 'manual_entry', validatedBy: f.actor.userId, net: { minorUnits: '10000' }, tax: { minorUnits: '825' }, total: { minorUnits: '10825' }, sourceReference: `mail:${p.id}:${p.source.sha256}` });
    expect(after.ledger.entries).toHaveLength(basis === 'cash' ? 0 : 1);
    if (basis === 'accrual') expect(after.ledger.entries[0].lines).toEqual([{ accountId: 'purchases', debitMinor: '10825', creditMinor: '0' }, { accountId: 'payables', debitMinor: '0', creditMinor: '10825' }]);
    const delta = await createSupabaseErpSyncStore(client, { supportedSchemaVersion: 4 }).changes(f.org, before.revision, 50); expect(applyErpDelta(before, delta, f.org, 4)).toEqual(after);
    expect(await f.store.findSource(f.actor, p.source.sha256)).toEqual(await f.store.read(f.actor, p.id));
    expect(await f.store.list(f.actor)).toHaveLength(1); expect(await f.counts()).toEqual([{ audits: 2, bills: 1, journals: basis === 'cash' ? 0 : 1, events: 3 }]);
  });
  it('deduplicates a source before mutation, including after recording under a new proposal ID', async () => {
    const f = await fixture(), p = f.proposal(); await f.store.create(f.actor, p);
    expect(await f.store.create(f.actor, { ...p, id: randomUUID() })).toEqual(p); await f.store.approve(await f.prepare(p));
    expect((await f.store.create(f.actor, { ...p, id: randomUUID() })).state).toBe('recorded'); expect(await f.counts()).toEqual([{ audits: 2, bills: 1, journals: 1, events: 3 }]);
    await expect(sql(rpcQueries.zentra_create_us_supplier_proposal[0], [f.org, f.actor, 4, { ...p, source: { ...p.source, mediaType: 'application/pdf' } }])).rejects.toMatchObject({ code: 'PS002' });
  });
  it('keeps known EUR in review and rejects the raw approval RPC without implicit USD conversion', async () => {
    const f = await fixture(), p = extractedCurrencyProposal(f.proposal('non-usd'), 'EUR');
    expect(p.extraction.issues).toContain('unsupported_currency'); expect(await f.store.create(f.actor, p)).toEqual(p);
    // Adversarial TEST envelope: only its temporary extraction is unknown so the
    // real ERP engine can prepare it. The persisted source remains known EUR.
    const input = await f.prepare({ ...p, extraction: f.proposal().extraction }), before = await f.erp.read(f.org), counts = await f.counts();
    await expect(f.raw(input)).rejects.toMatchObject({ code: 'PS004' });
    expect(await f.erp.read(f.org)).toEqual(before); expect(await f.counts()).toEqual(counts); expect(await f.store.read(f.actor, p.id)).toEqual(p);
  });
  it('rejects known EUR even through a privileged ERP/sidecar/audit bypass transaction', async () => {
    const f = await fixture(), p = extractedCurrencyProposal(f.proposal('non-usd-bypass'), 'EUR'); await f.store.create(f.actor, p);
    // This intentionally bypasses the guarded supplier RPC. The immutable
    // history constraint must still reject a new known-non-USD recording.
    const input = await f.prepare({ ...p, extraction: f.proposal().extraction }), before = await f.erp.read(f.org), counts = await f.counts();
    const recording = { idempotencyKey: input.request.idempotencyKey, requestHash: input.requestHash, by: f.actor.userId, at: f.actor.timestamp, review: input.request.review, erpReceipt: input.erp.receipt };
    const candidate = { ...p, revision: 1, state: 'recorded', recording };
    await expect(db.transaction(async tx => {
      await tx.exec('set local role service_role');
      await tx.query(rpcQueries.zentra_commit_us_erp[0], [f.org, input.erp.expectedRevision, input.erp.header, input.erp.changes, input.erp.ledgerAudit, input.erp.receipt, input.erp.actor]);
      await tx.query('update public.zentra_us_supplier_proposals set revision=1,payload=$3 where organization_id=$1 and id=$2', [f.org, p.id, candidate]);
      await tx.query('insert into public.zentra_us_supplier_audit values($1,$2,1,\'recorded\',$3,$4,$5,$6,$7,$8)', [f.org, p.id, f.actor.userId, f.actor.timestamp, candidate, input.request, input.requestHash, input.erp]);
    })).rejects.toMatchObject({ code: 'PS008' });
    expect(await f.erp.read(f.org)).toEqual(before); expect(await f.counts()).toEqual(counts); expect(await f.store.read(f.actor, p.id)).toEqual(p);
  });
  it('records known USD with printed zero tax without changing its exact reviewed amounts', async () => {
    const f = await fixture(), p = extractedCurrencyProposal(f.proposal('known-usd-zero-tax'), 'USD', '0'); await f.store.create(f.actor, p);
    const input = await f.prepare(p, randomUUID(), { printedTaxMinor: '0' }); await f.store.approve(input); const book = (await f.erp.read(f.org))!;
    expect(book.vendorBills?.[0]).toMatchObject({ currency: 'USD', net: { currency: 'USD', minorUnits: '10000' }, tax: { currency: 'USD', minorUnits: '0' }, total: { currency: 'USD', minorUnits: '10000' } });
    expect(book.ledger.entries[0].lines).toEqual([{ accountId: 'purchases', debitMinor: '10000', creditMinor: '0' }, { accountId: 'payables', debitMinor: '0', creditMinor: '10000' }]);
    expect((await f.store.read(f.actor, p.id))?.extraction.fields.currency).toBe('USD'); expect(await f.counts()).toEqual([{ audits: 2, bills: 1, journals: 1, events: 3 }]);
  });
  it('deduplicates competing imports with different admitted creators/times/file names, preserving original provenance', async () => {
    const f = await fixture(), first = f.proposal(), secondActor: FinancialAuthority = { ...f.actor, userId: randomUUID(), role: 'accountant', timestamp: '2026-10-08T13:00:00Z' };
    const second = { ...first, id: randomUUID(), createdBy: secondActor.userId, createdAt: secondActor.timestamp, source: { ...first.source, fileName: 'renamed-by-second-person.txt', receivedAt: secondActor.timestamp } };
    const results = await Promise.all([f.store.create(f.actor, first), f.store.create(secondActor, second)]);
    expect(results[0]).toEqual(first); expect(results[1]).toEqual(first); expect(await f.store.list(secondActor)).toEqual([first]); expect(await f.counts()).toEqual([{ audits: 1, bills: 0, journals: 0, events: 2 }]);
    expect((await f.store.read(secondActor, first.id))?.source.fileName).toBe(first.source.fileName);
  });
  it('preserves exact lost-response replay after later ERP changes and a fresh authority timestamp', async () => {
    const f = await fixture(), p = f.proposal(); await f.store.create(f.actor, p); const input = await f.prepare(p), result = await f.store.approve(input);
    await f.erpSend({ type: 'open_period', id: 'next', start: '2027-01-01', end: '2027-12-31' }); const before = await f.counts();
    expect(await f.store.approve({ ...input, actor: { ...input.actor, timestamp: '2026-10-08T13:00:00Z' } })).toEqual(result); expect(await f.counts()).toEqual(before);
    await expect(f.raw({ ...input, requestHash: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'PS002' });
    await expect(f.raw({ ...input, erp: { ...input.erp, header: { ...input.erp.header, counters: { ...input.erp.header.counters, invoice: 99 } } } })).rejects.toMatchObject({ code: 'PS002' });
  });
  it('serializes two reviewers and refuses a second key after the first approval', async () => {
    const f = await fixture(), p = f.proposal(); await f.store.create(f.actor, p); const first = await f.prepare(p), second = await f.prepare(p);
    const results = await Promise.allSettled([f.store.approve(first), f.store.approve(second)]); expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'supplier_revision_conflict' } }); expect(await f.counts()).toEqual([{ audits: 2, bills: 1, journals: 1, events: 3 }]);
  });
  it('fences a new approval against unrelated ERP changes without consuming proposal', async () => {
    const f = await fixture(), p = f.proposal(); await f.store.create(f.actor, p); const input = await f.prepare(p);
    await f.erpSend({ type: 'open_period', id: 'next', start: '2027-01-01', end: '2027-12-31' });
    await expect(f.store.approve(input)).rejects.toMatchObject({ code: 'supplier_erp_revision_conflict' }); expect((await f.store.read(f.actor, p.id))?.state).toBe('review');
  });
  it.each([0, 1, 2, 3, 5, null])('denies cap%s before reads and historical replay', async cap => {
    const f = await fixture(), p = f.proposal(); await f.store.create(f.actor, p); const input = await f.prepare(p); await f.store.approve(input);
    await expect(f.raw(input, cap)).rejects.toMatchObject({ code: 'PS006' }); await expect(sql(rpcQueries.zentra_list_us_supplier_proposals[0], [f.org, f.actor, cap])).rejects.toMatchObject({ code: 'PS006' });
  });
  it.each(['member', 'read_only', 'no_entitlement', 'other_org'] as const)('checks fresh authority%s even on replay', async change => {
    const f = await fixture(), p = f.proposal(); await f.store.create(f.actor, p); const input = await f.prepare(p); await f.store.approve(input);
    const actor = { ...f.actor, ...(change === 'no_entitlement' ? { managementEntitled: false } : change === 'other_org' ? { organizationId: randomUUID() } : { role: change }) };
    await expect(f.raw({ ...input, actor })).rejects.toMatchObject({ code: 'PS005' });
  });
  it.each(['confirmed', 'taxReviewed'] as const)('requires explicit human%s before any financial mutation', async field => {
    const f = await fixture(), p = f.proposal(); await f.store.create(f.actor, p); const input = await f.prepare(p), request = { ...input.request, [field]: false };
    await expect(f.raw({ ...input, request: request as unknown as UsSupplierApprovalRequest, requestHash: hash([f.org, f.actor.userId, request]) })).rejects.toMatchObject({ code: 'PS004' }); expect(await f.counts()).toEqual([{ audits: 1, bills: 0, journals: 0, events: 2 }]);
  });
  it.each(['review_amount', 'source_reference', 'approval_source', 'actor_timestamp', 'fingerprint', 'pretty_fingerprint'] as const)('rolls back forged%s without partial ERP or sidecar', async forgery => {
    const f = await fixture(), p = f.proposal(); await f.store.create(f.actor, p); const input = await f.prepare(p); const erp = mutable(input.erp);
    const bill = erp.changes.find(change => change.kind === 'vendor_bill')!.payload as Record<string, unknown>;
    if (forgery === 'review_amount') bill.net = { currency: 'USD', minorUnits: '20000' };
    if (forgery === 'source_reference') bill.sourceReference = 'mail:forged';
    if (forgery === 'approval_source') bill.approvalSource = 'provider_verified';
    if (forgery === 'actor_timestamp') erp.actor = { ...erp.actor, timestamp: '2026-10-08T13:00:00Z' };
    if (forgery === 'fingerprint') (erp.changes.find(change => change.kind === 'journal')!.payload as Record<string, unknown>).fingerprint = '[]';
    if (forgery === 'pretty_fingerprint') { const journal = erp.changes.find(change => change.kind === 'journal')!.payload as Record<string, unknown>; journal.fingerprint = JSON.stringify(JSON.parse(journal.fingerprint as string), null, 1); }
    const before = await f.erp.read(f.org); await expect(f.raw({ ...input, erp })).rejects.toBeInstanceOf(Error); expect(await f.erp.read(f.org)).toEqual(before); expect((await f.store.read(f.actor, p.id))?.state).toBe('review');
  });
  it('rejects new ERP mail bill created outside its atomic approval sidecar', async () => {
    const f = await fixture(), p = f.proposal(); await f.store.create(f.actor, p); const input = await f.prepare(p); const before = await f.erp.read(f.org);
    await expect(sql(rpcQueries.zentra_commit_us_erp[0], [f.org, input.erp.expectedRevision, input.erp.header, input.erp.changes, input.erp.ledgerAudit, input.erp.receipt, input.erp.actor])).rejects.toMatchObject({ code: 'PS008' }); expect(await f.erp.read(f.org)).toEqual(before);
  });
  it('rejects direct source/history edits and orphan reviewed insertions even by service_role', async () => {
    const f = await fixture(), p = f.proposal(); await f.store.create(f.actor, p);
    await expect(sql('update public.zentra_us_supplier_proposals set payload=$3 where organization_id=$1 and id=$2', [f.org, p.id, { ...p, createdBy: 'forged' }])).rejects.toMatchObject({ code: 'PS008' });
    const forged = f.proposal('orphan'); await expect(sql('insert into public.zentra_us_supplier_proposals values($1,$2,$3,0,$4)', [f.org, forged.id, forged.source.sha256, forged])).rejects.toMatchObject({ code: 'PS008' });
    await expect(sql('update public.zentra_us_supplier_audit set actor_id=$2 where organization_id=$1', [f.org, 'forged'])).rejects.toBeInstanceOf(Error);
    for (const table of ['zentra_us_supplier_proposals', 'zentra_us_supplier_audit']) await expect(db.exec(`truncate public.${table} cascade`)).rejects.toMatchObject({ code: 'PS008' });
    expect(await f.store.read(f.actor, p.id)).toEqual(p);
  });
  it.each(['sha', 'source_bytes', 'source_whitespace', 'mail_ids', 'extraction_unknown', 'extraction_confidence', 'extraction_issues', 'currency'])('rejects malformed%s at the independent SQL boundary', async issue => {
    const f = await fixture(), p = mutable(f.proposal());
    if (issue === 'sha') p.source.sha256 = 'f'.repeat(64);
    if (issue === 'source_bytes') { p.source.documentText = 'é'.repeat(8193); p.source.sha256 = createHash('sha256').update(p.source.documentText).digest('hex'); }
    if (issue === 'source_whitespace') { p.source.documentText = '\n\t\u00a0'; p.source.sha256 = createHash('sha256').update(p.source.documentText).digest('hex'); }
    if (issue === 'mail_ids') p.source.kind = 'support_mail';
    if (issue === 'extraction_unknown') (p.extraction as unknown as Record<string, unknown>).providerGrant = true;
    if (issue === 'extraction_confidence') p.extraction.confidence = 1;
    if (issue === 'extraction_issues') p.extraction.issues = [];
    if (issue === 'currency') p.extraction.fields.currency = 'USD'; // missing evidence/derived issues are intentionally not canonical
    await expect(sql(rpcQueries.zentra_create_us_supplier_proposal[0], [f.org, f.actor, 4, p])).rejects.toMatchObject({ code: 'PS004' }); expect(await f.store.list(f.actor)).toEqual([]);
  });
  it('retains full source mail provenance without making delegated creator the human approver', async () => {
    const f = await fixture(), p = f.proposal(), mail: UsSupplierProposal = { ...p, source: { ...p.source, kind: 'support_mail', workspaceId: randomUUID(), connectionId: randomUUID(), messageId: 'fictitious-message-id' } };
    await f.store.create(f.actor, mail); const accountant: FinancialAuthority = { ...f.actor, userId: randomUUID(), role: 'accountant' };
    const input = await f.prepare(mail), request = input.request; let erp: ErpCommit | undefined;
    await executeErp({ store: { ...f.erp, commit: async commit => { erp = commit; return commit.receipt; } }, configuration: f.config, actor: accountant, revalidate: async () => accountant, taxProvider: async () => null }, supplierErpRequest(mail, request));
    const result = await f.store.approve({ actor: accountant, request, requestHash: hash([f.org, accountant.userId, request]), erp: erp! }); expect(result.by).toBe(accountant.userId); expect((await f.store.read(accountant, p.id))?.createdBy).toBe(f.actor.userId);
  });
  it('supports 36-digit exact purchase amounts without Number conversion or a tax provider', async () => {
    const f = await fixture(), p = f.proposal(); await f.store.create(f.actor, p); const amount = '123456789012345678901234567890123456';
    const input = await f.prepare(p, randomUUID(), { netMinor: amount, printedTaxMinor: '0' }); await f.store.approve(input); expect((await f.erp.read(f.org))?.vendorBills?.[0].total.minorUnits).toBe(amount);
  });
  it('never reveals a proposal/source to another current US workspace', async () => {
    const f = await fixture(), foreign = await fixture(), p = f.proposal(); await f.store.create(f.actor, p);
    expect(await foreign.store.read(foreign.actor, p.id)).toBeNull(); expect(await foreign.store.findSource(foreign.actor, p.source.sha256)).toBeNull(); expect(await foreign.store.list(foreign.actor)).toEqual([]);
  });
  it('requires an existing reviewed vendor and open accounting period without consuming the proposal', async () => {
    const f = await fixture(), p = f.proposal(); await f.store.create(f.actor, p);
    await expect(f.prepare(p, randomUUID(), { vendorId: 'missing-vendor' })).rejects.toMatchObject({ code: 'vendor_required' });
    await f.erpSend({ type: 'close_period', periodId: 'year' });
    await expect(f.prepare(p)).rejects.toMatchObject({ code: 'accounting_period_not_open' }); expect((await f.store.read(f.actor, p.id))?.state).toBe('review');
  });
  it('enforces50 proposals before mutation and retains a readable aggregate', async () => {
    const f = await fixture(); for (let n = 0; n < 50; n++) await f.store.create(f.actor, f.proposal(String(n)));
    const before = await f.store.list(f.actor); expect(before).toHaveLength(50);
    await expect(f.store.create(f.actor, f.proposal('overflow'))).rejects.toMatchObject({ code: 'supplier_limit_reached' }); expect(await f.store.list(f.actor)).toEqual(before);
  }, 15_000);
  it('rejects the aggregate UTF8/character budget before mutation below50 proposals', async () => {
    const f = await fixture(); let count = 0, stopped = false;
    for (let n = 0; n < 50; n++) {
      const p = f.proposal(`unicode-${n}`), fields = { supplierName: 'Fictitious vendor', reference: 'TEST', invoiceDate: '2026-10-01', dueDate: '2026-10-31', currency: 'USD', netMinor: '10000', printedTaxMinor: '825', totalMinor: '10825' };
      const text = 'é'.repeat(8000) + String(n), source = { ...p.source, documentText: text, sha256: createHash('sha256').update(text).digest('hex') };
      const proof = 'é'.repeat(2000), extraction = validateUsSupplierExtraction({ schemaVersion: 1, kind: 'vendor_invoice', confidence: 1, fields,
        evidence: Object.fromEntries(Object.keys(fields).map(key => [key, proof])), fieldConfidence: Object.fromEntries(Object.keys(fields).map(key => [key, 1])), issues: [] });
      try { await f.store.create(f.actor, { ...p, source, extraction }); count++; }
      catch (error) { expect(error).toMatchObject({ code: 'supplier_limit_reached', status: 409 }); stopped = true; break; }
    }
    expect(stopped).toBe(true); expect(count).toBeLessThan(50); const list = await f.store.list(f.actor); expect(list).toHaveLength(count); expect(new TextEncoder().encode(JSON.stringify(list)).byteLength).toBeLessThan(2_000_000);
  }, 20_000);
  it.each(['anon', 'authenticated'])('denies source tables and five service RPCs to%s', async role => {
    const f = await fixture(), p = f.proposal();
    for (const [, spec] of Object.entries(rpcQueries).filter(([name]) => name.includes('supplier'))) {
      const args: Record<string, unknown> = { p_organization: f.org, p_actor: f.actor, p_supported_schema_version: 4, p_id: p.id, p_sha256: p.source.sha256, p_proposal: p, p_request: {}, p_request_hash: 'a'.repeat(64), p_erp: {} };
      await expect(sql(spec[0], spec[1].map(key => args[key]), role)).rejects.toMatchObject({ code: '42501' });
    }
    await expect(sql('select * from public.zentra_us_supplier_proposals', [], role)).rejects.toMatchObject({ code: '42501' });
    await expect(sql('select * from public.zentra_us_supplier_audit', [], role)).rejects.toMatchObject({ code: '42501' });
  });
  it('keeps every function invoker/empty-search-path and both tables RLS enabled', async () => {
    const funcs = await db.query<{ prosecdef: boolean; proconfig: string[] }>("select prosecdef,proconfig from pg_proc where proname like 'zentra%us_supplier%'"); expect(funcs.rows.length).toBeGreaterThan(10);
    for (const f of funcs.rows) { expect(f.prosecdef).toBe(false); expect(f.proconfig).toContain('search_path=""'); }
    expect((await db.query<{ relrowsecurity: boolean }>("select relrowsecurity from pg_class where relname in('zentra_us_supplier_proposals','zentra_us_supplier_audit')")).rows.every(row => row.relrowsecurity)).toBe(true);
  });
  it('preserves CH and refuses its space before any US source disclosure', async () => {
    await expect(sql(rpcQueries.zentra_list_us_supplier_proposals[0], [chOrg, { organizationId: chOrg, userId: chUser, role: 'owner', managementEntitled: true, timestamp: '2026-10-08T12:00:00Z' }, 4])).rejects.toMatchObject({ code: 'PS006' }); expect(await snapshotCH()).toEqual(chBefore);
  });
});
