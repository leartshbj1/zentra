import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import { createSupabaseErpStore } from './runtime-store';
import { canonicalErpJson, executeErp } from './runtime';
import { createSupabaseUsBankStore } from './us-bank-store';
import { applyUsBankCommand, validateUsBankRequest } from './us-bank-reconciliation';
import { createUsBankHandlers } from './us-bank-server';
import { snapshotPrivateJson } from './private-json';
import type { FinancialAuthority } from './accounting/ledger';
import type { CompanyConfiguration } from './types';
import type { UsBankCommit, UsBankCommand, UsBankRequest, UsBankReceipt } from './us-bank-contract';
import type { ErpCommand } from './runtime-types';

const directory = process.env.PGLITE_MODULE_DIR;
const enabled = Boolean(directory && isAbsolute(directory));
type Sql = { exec(sql: string): Promise<unknown>; query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> };
type Db = Sql & { close(): Promise<void>; transaction<T>(task: (tx: Sql) => Promise<T>): Promise<T> };
let db: Db;
const migration = '20261008184605_international_us_bank_reconciliation';
const chOrg = randomUUID(), chUser = randomUUID();
let chBefore: unknown;
const snapshotCH = async () => (await db.query('select to_jsonb(w) workspace,to_jsonb(c) country from public.zentra_workspaces w join public.zentra_workspace_country_configs c using(organization_id) where w.organization_id=$1', [chOrg])).rows;
const rpcQueries: Record<string, [string, string[]]> = {
  zentra_read_us_erp_v4: ['select public.zentra_read_us_erp_v4($1) result', ['p_organization']],
  zentra_us_erp_receipt_v4: ['select public.zentra_us_erp_receipt_v4($1,$2) result', ['p_organization', 'p_idempotency_key']],
  zentra_commit_us_erp: ['select public.zentra_commit_us_erp($1,$2,$3,$4,$5,$6,$7) result', ['p_organization', 'p_expected_revision', 'p_header', 'p_changes', 'p_ledger_audit', 'p_receipt', 'p_actor']],
  zentra_list_us_bank_reconciliations: ['select public.zentra_list_us_bank_reconciliations($1,$2,$3) result', ['p_organization', 'p_actor', 'p_supported_schema_version']],
  zentra_read_us_bank_reconciliation: ['select public.zentra_read_us_bank_reconciliation($1,$2,$3,$4) result', ['p_organization', 'p_actor', 'p_supported_schema_version', 'p_id']],
  zentra_us_bank_receipt: ['select public.zentra_us_bank_receipt($1,$2,$3,$4) result', ['p_organization', 'p_actor', 'p_supported_schema_version', 'p_idempotency_key']],
  zentra_commit_us_bank_reconciliation: ['select public.zentra_commit_us_bank_reconciliation($1,$2,$3,$4,$5,$6,$7) result', ['p_organization', 'p_actor', 'p_supported_schema_version', 'p_expected_erp_revision', 'p_expected_reconciliation_revision', 'p_record', 'p_receipt']],
};
async function sql<T = Record<string, unknown>>(query: string, values: unknown[] = [], role = 'service_role') {
  return db.transaction(async tx => { await tx.exec(`set local role ${role}`); return (await tx.query<T>(query, values)).rows; });
}
const client = { async rpc<T>(name: string, input: Record<string, unknown>): Promise<T> {
  const spec = rpcQueries[name]; if (!spec) throw new Error('Missing real SQL adapter');
  try { return (await sql<{ result: T }>(spec[0], spec[1].map(key => input[key])))[0].result; }
  catch (error) { if (process.env.ZENTRA_LOCAL_SQL_DEBUG === '1') console.error('TEST SQL', error instanceof Error ? error.message : 'error', (error as { code?: string }).code, (error as { where?: string }).where); throw new SupabaseServerError(503, (error as { code?: string }).code ?? '', 'test-rpc'); }
} } as Pick<SupabaseServerClient, 'rpc'>;
async function fixture(basis: 'cash' | 'accrual' = 'accrual') {
  const org = randomUUID(), userId = randomUUID();
  const actor: FinancialAuthority = { organizationId: org, userId, role: 'owner', managementEntitled: true, timestamp: '2026-10-08T12:00:00.000Z' };
  const config: CompanyConfiguration = { schemaVersion: 1, organizationId: org, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York', address: { country: 'US', line1: '1 Fictitious Avenue', city: 'New York', subdivision: 'NY', postalCode: '10001' }, accountingBasis: basis, invoiceNumberPrefix: 'TEST', taxConfiguration: { status: 'unconfigured' } };
  await sql('select public.zentra_admit_new_us_workspace_v1($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::jsonb,$6)', [org, randomUUID(), userId, randomUUID(), JSON.stringify(config), createHash('sha256').update(org).digest('hex')]);
  const erp = createSupabaseErpStore(client, { supportedSchemaVersion: 4 }), store = createSupabaseUsBankStore(client, { supportedSchemaVersion: 4 });
  let sequence = 0;
  const erpSend = async (command: ErpCommand) => executeErp({ store: erp, configuration: config, actor, revalidate: async () => actor, taxProvider: async () => null }, { idempotencyKey: `erp-${++sequence}`, expectedRevision: (await erp.read(org))?.revision ?? 0, command });
  await erpSend({ type: 'initialize', periods: [{ id: 'year', start: '2026-01-01', end: '2026-12-31', status: 'open' }] });
  await erpSend({ type: 'post_manual_journal', id: 'funds', transactionDate: '2026-10-01', accountingDate: '2026-10-01', periodId: 'year', description: 'Fictitious capital contribution', sourceReference: 'TEST-only', cashFlowCategory: 'financing', lines: [{ accountId: 'cash', debitMinor: '10000', creditMinor: '0' }, { accountId: 'equity', debitMinor: '0', creditMinor: '10000' }] });
  const statementId = randomUUID();
  const statement = { id: statementId, organizationId: org, externalConnectionId: `manual:${randomUUID()}`, currency: 'USD' as const, cashAccountId: 'cash', start: '2026-10-01', end: '2026-10-31', opening: { currency: 'USD' as const, minorUnits: '0' }, closing: { currency: 'USD' as const, minorUnits: '10000' }, lines: [{ id: `${statementId}:1`, date: '2026-10-01', amount: { currency: 'USD' as const, minorUnits: '10000' }, reference: 'Fictitious capital' }] };
  const make = async (command: UsBankCommand, key = randomUUID(), id = statementId): Promise<UsBankCommit> => {
    const book = (await erp.read(org))!, record = await store.read(actor, id);
    const request = validateUsBankRequest({ schemaVersion: 1, idempotencyKey: key, reconciliationId: id, expectedErpRevision: book.revision, expectedReconciliationRevision: record?.reconciliation.revision ?? null, command }, org);
    const next = applyUsBankCommand(record, request, book.ledger, actor, await store.list(actor));
    const receipt: UsBankReceipt = { schemaVersion: 1, organizationId: org, idempotencyKey: key, commandHash: createHash('sha256').update(canonicalErpJson([org, userId, request])).digest('hex'), actorId: userId, reconciliationId: id, action: command.type, revision: next.reconciliation.revision, erpRevision: book.revision };
    return { actor, expectedErpRevision: book.revision, expectedReconciliationRevision: request.expectedReconciliationRevision, record: next, receipt };
  };
  const create = () => make({ type: 'create_statement', statement });
  const match = () => make({ type: 'approve_match', id: randomUUID(), statementLineIds: [statement.lines[0].id], ledgerEntryIds: ['funds'] });
  const raw = (commit: UsBankCommit, cap: number | null = 4) => sql(rpcQueries.zentra_commit_us_bank_reconciliation[0], [org, commit.actor, cap, commit.expectedErpRevision, commit.expectedReconciliationRevision, commit.record, commit.receipt]);
  return { org, actor, config, erp, store, erpSend, statement, make, create, match, raw };
}

describe.skipIf(!enabled)('US bank PostgreSQL, exact guarded statements alongside the unchanged book', () => {
  beforeAll(async () => {
    const require = createRequire(import.meta.url), { PGlite } = require(join(directory!, 'dist/index.cjs')) as { PGlite: new () => Db }; db = new PGlite();
    await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);grant usage on schema public to service_role;');
    for (const name of ['202609140100_company_profiles', '202609140200_company_collaboration', '202609200300_company_content', '20261007194528_international_workspace_country_config']) await db.exec(await readFile(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), 'utf8'));
    await db.query('insert into public.zentra_workspaces(organization_id,updated_by)values($1,$2)', [chOrg, chUser]);
    await db.query('select public.zentra_put_workspace_country_config($1,$2,0,$3::uuid,$4::jsonb)', [chOrg, chUser, randomUUID(), JSON.stringify({ schemaVersion: 1, organizationId: chOrg, country: 'CH', currency: 'CHF', language: 'fr', timeZone: 'Europe/Zurich', address: { country: 'CH', line1: '1 Rue Fictive', city: 'Genève', subdivision: 'GE', postalCode: '1201' }, accountingBasis: 'accrual', invoiceNumberPrefix: 'CH', taxConfiguration: { status: 'unconfigured' } })]);
    chBefore = await snapshotCH();
    for (const name of ['20261007222349_international_us_erp_persistence', '20261007224820_international_us_erp_delta_stream', '20261007225725_international_us_erp_seller_snapshot', '20261008001726_new_us_workspace_admission', '20261008013200_international_tax_proof_allowlist', '20261008034422_international_us_seller_profile', '20261008044402_international_us_tax_profile', '20261008060826_international_us_tax_operations', '20261008081825_international_us_purchasing_v2', '20261008105120_international_us_projects_v3', '20261008161118_international_us_journal_periods_v4', '20261008172520_international_us_tax_invoice_capability_v2', migration]) await db.exec(await readFile(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), 'utf8'));
  }, 30_000);
  afterAll(async () => { await db?.close(); });
  it.each(['cash', 'accrual'] as const)('creates, approves and completes a %s reconciliation without changing ERP money/history', async basis => {
    const f = await fixture(basis), before = await f.erp.read(f.org);
    const creation = await f.create(); expect(await f.store.commit(creation)).toEqual(creation.receipt);
    const match = await f.match(); await f.store.commit(match);
    const completion = await f.make({ type: 'complete' }); await f.store.commit(completion);
    expect((await f.store.read(f.actor, f.statement.id))?.reconciliation.completedLedgerRevision).toBe(before!.ledger.revision);
    expect(await f.erp.read(f.org)).toEqual(before);
    expect(await sql('select action from public.zentra_us_bank_audit where organization_id=$1 order by revision', [f.org])).toEqual([{ action: 'create_statement' }, { action: 'approve_match' }, { action: 'complete' }]);
    expect(await f.store.commit(completion)).toEqual(completion.receipt);
  });
  it('replays the original receipt after ERP changes, but a new stale commit is fenced', async () => {
    const f = await fixture(), created = await f.create(); await f.store.commit(created); const stale = await f.match();
    await f.erpSend({ type: 'open_period', id: 'next', start: '2027-01-01', end: '2027-12-31' });
    expect(await f.store.commit(created)).toEqual(created.receipt);
    await expect(f.store.commit(stale)).rejects.toMatchObject({ code: 'bank_erp_revision_conflict', status: 409 });
    expect((await f.store.read(f.actor, f.statement.id))?.reconciliation.matches).toHaveLength(0);
  });
  it('fences reconciliation revision and preserves exact request identity', async () => {
    const f = await fixture(); await f.store.commit(await f.create()); const first = await f.match(), concurrent = await f.match(); await f.store.commit(first);
    await expect(f.store.commit(concurrent)).rejects.toMatchObject({ code: 'bank_revision_conflict' });
    await expect(f.raw({ ...first, receipt: { ...first.receipt, commandHash: 'f'.repeat(64) } })).rejects.toMatchObject({ code: 'PB002' });
  });
  it('does not replay an original receipt for another canonical creation command or reconciliation CAS', async () => {
    const f = await fixture(), creation = await f.create(); await f.store.commit(creation);
    const altered = { ...creation.record, reconciliation: { ...creation.record.reconciliation, statement: { ...f.statement, lines: f.statement.lines.map(line => ({ ...line, reference: 'Different canonical request' })) } } };
    await expect(f.raw({ ...creation, record: altered })).rejects.toMatchObject({ code: 'PB002' });
    await expect(f.raw({ ...creation, expectedReconciliationRevision: 0 })).rejects.toMatchObject({ code: 'PB005' });
    expect(await f.store.commit(creation)).toEqual(creation.receipt);
  });
  it('stores audited void, refuses identical reimport under new IDs and rejects any historical deletion', async () => {
    const f = await fixture(), original = await f.create(); await f.store.commit(original); await f.store.commit(await f.make({ type: 'void_statement', reason: 'Fictitious incorrect import' }));
    const id = randomUUID(), duplicate = { ...f.statement, id, externalConnectionId: `manual:${randomUUID()}`, lines: f.statement.lines.map(line => ({ ...line, id: `${id}:1` })) };
    const record = { ...original.record, reconciliation: { ...original.record.reconciliation, statement: duplicate } };
    const request: UsBankRequest = { schemaVersion: 1, idempotencyKey: randomUUID(), reconciliationId: id, expectedErpRevision: original.expectedErpRevision, expectedReconciliationRevision: null, command: { type: 'create_statement', statement: duplicate } };
    const receipt = { ...original.receipt, reconciliationId: id, idempotencyKey: request.idempotencyKey, commandHash: createHash('sha256').update(canonicalErpJson([f.org, f.actor.userId, request])).digest('hex') };
    await expect(f.raw({ ...original, expectedReconciliationRevision: null, record, receipt })).rejects.toMatchObject({ code: 'PB012' });
    for (const table of ['zentra_us_bank_reconciliations', 'zentra_us_bank_receipts', 'zentra_us_bank_audit', 'zentra_us_bank_entry_claims']) await expect(db.exec(`truncate public.${table} cascade`)).rejects.toMatchObject({ code: 'PB010' });
  });
  it.each([1, 2, 3, 0, 5, null])('refuses trusted capability%s before disclosing receipts', async cap => {
    const f = await fixture(), created = await f.create(); await f.store.commit(created);
    await expect(f.raw(created, cap)).rejects.toMatchObject({ code: 'PB008' });
    await expect(sql(rpcQueries.zentra_us_bank_receipt[0], [f.org, f.actor, cap, created.receipt.idempotencyKey])).rejects.toMatchObject({ code: 'PB008' });
  });
  it.each(['member', 'read_only', 'no_entitlement', 'other_tenant', 'other_actor'])('refuses changed financial authority%s on replay', async change => {
    const f = await fixture(), created = await f.create(); await f.store.commit(created); const actor = { ...f.actor };
    if (change === 'member' || change === 'read_only') actor.role = change;
    if (change === 'no_entitlement') actor.managementEntitled = false;
    if (change === 'other_tenant') actor.organizationId = randomUUID();
    if (change === 'other_actor') actor.userId = randomUUID();
    await expect(f.raw({ ...created, actor })).rejects.toMatchObject({ code: change === 'other_actor' ? 'PB005' : 'PB007' });
  });
  it.each(['anon', 'authenticated'])('keeps private tables/RPCs inaccessible to%s', async role => {
    const f = await fixture(); await expect(sql(rpcQueries.zentra_list_us_bank_reconciliations[0], [f.org, f.actor, 4], role)).rejects.toMatchObject({ code: '42501' });
    await expect(sql('select * from public.zentra_us_bank_reconciliations', [], role)).rejects.toMatchObject({ code: '42501' });
  });
  it('preserves CH and refuses its country before any bank row read', async () => {
    await expect(sql(rpcQueries.zentra_list_us_bank_reconciliations[0], [chOrg, { organizationId: chOrg, userId: chUser, role: 'owner', managementEntitled: true, timestamp: '2026-10-08T12:00:00.000Z' }, 4])).rejects.toMatchObject({ code: 'PB008' });
    expect(await snapshotCH()).toEqual(chBefore);
  });
  it.each([null, 'CHF', 1, { currency: 'USD' }])('rejects non-USD or null amount currency %j at the independent SQL boundary', async currency => {
    const f = await fixture(), original = await f.create(), record = structuredClone(original.record);
    const opening = record.reconciliation.statement.opening as unknown as { currency: unknown }; opening.currency = currency;
    await expect(f.raw({ ...original, record })).rejects.toMatchObject({ code: 'PB005' });
    expect(await f.store.list(f.actor)).toEqual([]);
  });
  it('rejects direct privileged immutable rewrites and orphan bank history at deferred commit', async () => {
    const f = await fixture(), creation = await f.create(); await f.store.commit(creation);
    const forged = { ...creation.record, createdBy: 'forged' };
    await expect(sql('update public.zentra_us_bank_reconciliations set payload=$3 where organization_id=$1 and id=$2', [f.org, f.statement.id, forged])).rejects.toMatchObject({ code: 'PB010' });
    const match = await f.match();
    await expect(sql('update public.zentra_us_bank_reconciliations set revision=1,payload=$3 where organization_id=$1 and id=$2', [f.org, f.statement.id, match.record])).rejects.toMatchObject({ code: 'PB010' });
    await expect(sql('insert into public.zentra_us_bank_entry_claims values($1,$2,$3,$4,$5)', [f.org, 'cash', 'funds', f.statement.id, randomUUID()])).rejects.toMatchObject({ code: 'PB010' });
    expect(await f.store.read(f.actor, f.statement.id)).toEqual(creation.record);
    expect(await sql('select revision from public.zentra_us_bank_receipts where organization_id=$1', [f.org])).toEqual([{ revision: 0 }]);
    expect(await sql('select * from public.zentra_us_bank_entry_claims where organization_id=$1', [f.org])).toEqual([]);
    await f.store.commit(match); await f.store.commit(await f.make({ type: 'complete' }));
    const complete = (await f.store.read(f.actor, f.statement.id))!;
    await expect(sql('update public.zentra_us_bank_reconciliations set revision=3,payload=$3 where organization_id=$1 and id=$2', [f.org, f.statement.id, { ...complete, reconciliation: { ...complete.reconciliation, revision: 3 } }])).rejects.toMatchObject({ code: 'PB010' });
  });
  it('canonicalizes selection sets before hashing, with twelve-line and Unicode IDs matching SQL UTF16 order', async () => {
    const f = await fixture(), imported = { ...f.statement, lines: Array.from({ length: 10 }, (_, n) => ({ id: `${f.statement.id}:${n + 1}`, date: '2026-10-01', amount: { currency: 'USD' as const, minorUnits: '800' }, reference: `Line ${n + 1}` })).concat([{ id: '😀', date: '2026-10-01', amount: { currency: 'USD', minorUnits: '1000' }, reference: 'Unicode a' }, { id: '\uE000', date: '2026-10-01', amount: { currency: 'USD', minorUnits: '1000' }, reference: 'Unicode b' }]) };
    await f.store.commit(await f.make({ type: 'create_statement', statement: imported }));
    const approval = await f.make({ type: 'approve_match', id: randomUUID(), statementLineIds: imported.lines.map(line => line.id).reverse(), ledgerEntryIds: ['funds'] });
    expect(approval.record.reconciliation.matches[0].statementLineIds).toEqual(imported.lines.map(line => line.id).sort());
    await f.store.commit(approval); await f.store.commit(await f.make({ type: 'complete' }));
    expect((await f.store.list(f.actor))[0].reconciliation.revision).toBe(2);
    expect(await sql<{ x: string[] }>('select array_agg(x order by public.zentra_us_bank_utf16_key(x)) x from unnest($1::text[])x', [['\uE000', '😀', 'a', '10', '2']])).toEqual([{ x: ['10', '2', 'a', '😀', '\uE000'] }]);
  });
  it('refuses overlap on another opaque connection and mismatched money without storing any partial history', async () => {
    const f = await fixture(), original = await f.create(); await f.store.commit(original);
    const duplicateId = randomUUID(), different = { ...f.statement, id: duplicateId, externalConnectionId: `manual:${randomUUID()}`, lines: [{ ...f.statement.lines[0], id: `${duplicateId}:1`, reference: 'Different content same period' }] };
    const request: UsBankRequest = { schemaVersion: 1, idempotencyKey: randomUUID(), reconciliationId: duplicateId, expectedErpRevision: original.expectedErpRevision, expectedReconciliationRevision: null, command: { type: 'create_statement', statement: different } };
    const receipt = { ...original.receipt, reconciliationId: duplicateId, idempotencyKey: request.idempotencyKey, commandHash: createHash('sha256').update(canonicalErpJson([f.org, f.actor.userId, request])).digest('hex') };
    await expect(f.raw({ ...original, record: { ...original.record, reconciliation: { ...original.record.reconciliation, statement: different } }, receipt })).rejects.toMatchObject({ code: 'PB003' });
    const approval = await f.match(), wrong = { ...approval.record, reconciliation: { ...approval.record.reconciliation, statement: { ...f.statement, opening: { currency: 'USD' as const, minorUnits: '1000' }, closing: { currency: 'USD' as const, minorUnits: '11000' } } } };
    await expect(f.raw({ ...approval, record: wrong })).rejects.toMatchObject({ code: 'PB005' });
    expect(await sql('select revision from public.zentra_us_bank_receipts where organization_id=$1', [f.org])).toEqual([{ revision: 0 }]);
  });
  it('connects actual HTTP/core/private PostgreSQL for two scoped collaborators and exact replay', async () => {
    const f = await fixture(), colleague = randomUUID();
    let activeActor = f.actor;
    const handlers = createUsBankHandlers({ enabled: () => true, authority: async () => ({ mode: 'browser', actor: activeActor }), configuration: async () => f.config, store: () => f.erp, freshSupportedSchemaVersion: () => 4, bankStore: () => f.store });
    const send = async (command: UsBankCommand, recordRevision: number | null, key = randomUUID()) => {
      const envelope = validateUsBankRequest({ schemaVersion: 1, idempotencyKey: key, reconciliationId: f.statement.id, expectedErpRevision: (await f.erp.read(f.org))!.revision, expectedReconciliationRevision: recordRevision, command }, f.org);
      const request = () => new Request(`https://zentra.test/api/international/workspaces/${f.org}/bank-reconciliations`, { method: 'POST', headers: { Origin: 'https://zentra.test', 'Content-Type': 'application/json', 'X-Zentra-Erp-Schema-Version': '4', 'X-Zentra-Expected-User': activeActor.userId }, body: canonicalErpJson(envelope) });
      return { response: await handlers.POST(request(), f.org), request };
    };
    const created = await send({ type: 'create_statement', statement: f.statement }, null); expect(created.response.status).toBe(200);
    activeActor = { ...f.actor, userId: colleague, role: 'accountant', timestamp: '2026-10-08T12:00:01.000Z' };
    const shared = await handlers.GET(new Request(`https://zentra.test/api/bank`, { headers: { 'X-Zentra-Erp-Schema-Version': '4', 'X-Zentra-Expected-User': colleague } }), f.org);
    expect(shared.status).toBe(200); const sharedBody = await shared.json() as { records: unknown[] }; expect(sharedBody.records).toHaveLength(1);
    const approved = await send({ type: 'approve_match', id: randomUUID(), statementLineIds: [f.statement.lines[0].id], ledgerEntryIds: ['funds'] }, 0); expect(approved.response.status).toBe(200);
    const replayBody = await (await handlers.POST(approved.request(), f.org)).json() as { replayed: boolean }; expect(replayBody.replayed).toBe(true);
    const completion = await send({ type: 'complete' }, 1); expect(completion.response.status).toBe(200);
    expect((await f.store.read(f.actor, f.statement.id))?.reconciliation.completedBy).toBe(colleague);
    expect((await f.erp.read(f.org))!.ledger.entries).toHaveLength(1);
  });
  it('requires RLS, invoker empty-search-path RPCs, immutable/deferred triggers and no client grants', async () => {
    const relations = await db.query<{ relname: string; relrowsecurity: boolean }>("select relname,relrowsecurity from pg_class where relname in ('zentra_us_bank_reconciliations','zentra_us_bank_receipts','zentra_us_bank_audit','zentra_us_bank_entry_claims') order by relname");
    expect(relations.rows).toHaveLength(4); expect(relations.rows.every(row => row.relrowsecurity)).toBe(true);
    const functions = await db.query<{ prosecdef: boolean; proconfig: string[] }>("select prosecdef,proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (p.proname like 'zentra_us_bank_%' or p.proname in ('zentra_list_us_bank_reconciliations','zentra_read_us_bank_reconciliation','zentra_commit_us_bank_reconciliation'))");
    expect(functions.rows.length).toBeGreaterThanOrEqual(10); expect(functions.rows.every(row => !row.prosecdef && row.proconfig.includes('search_path=""'))).toBe(true);
    expect((await db.query<{ count: number }>("select count(*)::int count from pg_trigger where tgname in ('zentra_us_bank_records_atomic','zentra_us_bank_receipts_atomic','zentra_us_bank_audit_atomic','zentra_us_bank_claims_atomic') and tgdeferrable and tginitdeferred")).rows[0].count).toBe(4);
  });
  it.each(['missing', 'wrong_amount'] as const)('rejects fully correlated privileged history with %s cash facts and rolls back every bank row', async variant => {
    const f = await fixture();
    const statement = variant === 'wrong_amount' ? { ...f.statement, closing: { currency: 'USD' as const, minorUnits: '5000' }, lines: f.statement.lines.map(line => ({ ...line, amount: { currency: 'USD' as const, minorUnits: '5000' } })) } : f.statement;
    const creation = await f.make({ type: 'create_statement', statement }); await f.store.commit(creation);
    const book = (await f.erp.read(f.org))!, key = randomUUID(), matchId = randomUUID(), entryId = variant === 'missing' ? 'nonexistent' : 'funds';
    const request = validateUsBankRequest({ schemaVersion: 1, idempotencyKey: key, reconciliationId: statement.id, expectedErpRevision: book.revision, expectedReconciliationRevision: 0, command: { type: 'approve_match', id: matchId, statementLineIds: [statement.lines[0].id], ledgerEntryIds: [entryId] } }, f.org);
    const record = { ...creation.record, reconciliation: { ...creation.record.reconciliation, revision: 1, matches: [{ id: matchId, idempotencyKey: key, statementLineIds: [statement.lines[0].id], ledgerEntryIds: [entryId], fingerprint: JSON.stringify([f.org, statement.id, 'USD', 'cash', [statement.lines[0].id], [entryId]]), approvedBy: f.actor.userId, approvedAt: f.actor.timestamp }] } };
    const receipt = { ...creation.receipt, idempotencyKey: key, action: 'approve_match', revision: 1, commandHash: createHash('sha256').update(canonicalErpJson([f.org, f.actor.userId, request])).digest('hex') };
    await expect(db.transaction(async tx => {
      await tx.exec('set local role service_role');
      await tx.query('update public.zentra_us_bank_reconciliations set revision=1,payload=$3 where organization_id=$1 and id=$2', [f.org, statement.id, record]);
      await tx.query('insert into public.zentra_us_bank_receipts values($1,$2,$3,$4,$5,1,$6)', [f.org, statement.id, key, receipt.commandHash, f.actor.userId, receipt]);
      await tx.query('insert into public.zentra_us_bank_audit values($1,$2,1,$3,$4,$5,$6)', [f.org, statement.id, f.actor.userId, f.actor.timestamp, 'approve_match', receipt]);
      await tx.query('insert into public.zentra_us_bank_entry_claims values($1,$2,$3,$4,$5)', [f.org, 'cash', entryId, statement.id, matchId]);
    })).rejects.toMatchObject({ code: 'PB010' });
    expect(await f.store.read(f.actor, statement.id)).toEqual(creation.record);
    expect(await sql('select revision from public.zentra_us_bank_audit where organization_id=$1', [f.org])).toEqual([{ revision: 0 }]);
    expect(await sql('select * from public.zentra_us_bank_entry_claims where organization_id=$1', [f.org])).toEqual([]);
  });
  it.each(['short', 'long_ascii', 'emoji'] as const)('refuses %s growth before the bounded shared read can become inaccessible, retaining every earlier import', async references => {
    const f = await fixture(); let rejected = false, count = 0;
    for (let n = 0; n < 10; n++) {
      const reference = references === 'short' ? 'A' : references === 'long_ascii' ? 'A'.repeat(256) : '🙂'.repeat(100);
      const id = randomUUID(), date = `${2027 + n}-01-01`, statement = { ...f.statement, id, start: date, end: date, closing: { currency: 'USD' as const, minorUnits: '1000' }, lines: Array.from({ length: 1000 }, (_, index) => ({ id: `${id}:${index + 1}`, date, amount: { currency: 'USD' as const, minorUnits: '1' }, reference })) };
      const input = await f.make({ type: 'create_statement', statement }, randomUUID(), id);
      try { await f.store.commit(input); count++; } catch (error) { expect(error).toMatchObject({ code: 'bank_limit_reached', status: 409 }); rejected = true; break; }
    }
    expect(rejected).toBe(true); expect(count).toBeGreaterThan(1);
    const read = await f.store.list(f.actor); expect(read).toHaveLength(count); expect(() => snapshotPrivateJson(read)).not.toThrow();
    const handlers = createUsBankHandlers({ enabled: () => true, authority: async () => ({ mode: 'browser', actor: f.actor }), configuration: async () => f.config, store: () => f.erp, freshSupportedSchemaVersion: () => 4, bankStore: () => f.store });
    const response = await handlers.GET(new Request('https://zentra.test/api/bank', { headers: { 'X-Zentra-Erp-Schema-Version': '4', 'X-Zentra-Expected-User': f.actor.userId } }), f.org);
    expect(response.status).toBe(200); const bytes = await response.arrayBuffer(); expect(bytes.byteLength).toBeLessThanOrEqual(2_621_440);
    expect(await sql('select count(*)::int count from public.zentra_us_bank_receipts where organization_id=$1', [f.org])).toEqual([{ count }]);
    expect(await sql('select count(*)::int count from public.zentra_us_bank_audit where organization_id=$1', [f.org])).toEqual([{ count }]);
    const before = (await f.erp.read(f.org))!; expect(before.revision).toBe(2); expect(before.ledger.entries).toHaveLength(1);
  }, 20_000);
  it('aligns aggregate SQL capacity with shared snapshot nodes, decoded text, depth and array bounds', async () => {
    const accepted = [[], { label: '🙂'.repeat(125_000) }, Array.from({ length: 49 }, (_, index) => Array.from({ length: index === 48 ? 998 : 999 }, () => 0))];
    for (const value of accepted) {
      expect((await sql<{ valid: boolean }>('select public.zentra_us_bank_snapshot_capacity($1::jsonb) valid', [value]))[0].valid).toBe(true);
      expect(() => snapshotPrivateJson(value)).not.toThrow();
    }
    let deep: unknown = null; for (let i = 0; i < 21; i++) deep = { child: deep };
    const rejected = [deep, Array.from({ length: 1001 }, () => 0), { label: 'A'.repeat(500_001) }, Array.from({ length: 50 }, () => Array.from({ length: 999 }, () => 0)), Array.from({ length: 9 }, () => 'A'.repeat(240_000))];
    for (const value of rejected) expect((await sql<{ valid: boolean }>('select public.zentra_us_bank_snapshot_capacity($1::jsonb) valid', [value]))[0].valid).toBe(false);
  });
});
