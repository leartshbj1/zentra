import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import { createSupabaseErpStore } from './runtime-store';
import { executeErp } from './runtime';
import { applyErpDelta, type ErpDelta } from './runtime-sync';
import { publicErpDelta, publicErpState } from './public-projection';
import type { CompanyConfiguration } from './types';
import type { TaxCalculationProvider } from './invoicing';
import type { ErpCommand, ErpCommit, ErpState } from './runtime-types';

// Explicit opt-in isolated WASM engine. No production URL, key or disk database.
const moduleDirectory = process.env.PGLITE_MODULE_DIR;
const enabled = !!moduleDirectory && isAbsolute(moduleDirectory);
type Sql = { exec(sql: string): Promise<unknown>; query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> };
type Database = Sql & { transaction<T>(task: (sql: Sql) => Promise<T>): Promise<T>; close(): Promise<void> };
const databases: Database[] = [];
afterEach(async () => { await Promise.all(databases.splice(0).map(db => db.close())); });
const stack = [
  '20261007194528_international_workspace_country_config.sql',
  '20261007222349_international_us_erp_persistence.sql',
  '20261007224820_international_us_erp_delta_stream.sql',
  '20261007225725_international_us_erp_seller_snapshot.sql',
];
const corrective = '20261008013200_international_tax_proof_allowlist.sql';
const org = 'fictitious-tax-proof-a';
const configuration = { schemaVersion: 1, organizationId: org, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York',
  address: { country: 'US', line1: '1 Example Street', postalCode: '10001', city: 'New York', subdivision: 'NY' },
  accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'configured' } } satisfies CompanyConfiguration;
const actor = { organizationId: org, userId: 'fictitious-owner', role: 'owner' as const, managementEntitled: true, timestamp: '2026-10-08T12:00:00.000Z' };
const seller = { organizationId: org, displayName: 'Fictitious Seller' };
const provider: TaxCalculationProvider = { id: 'fictitious-no-tax-advice', async calculate(request) {
  return { ...request, source: 'external-provider', providerReference: 'fictitious-proof', determinedAt: '2026-10-08T11:00:00.000Z', validUntil: '2026-10-08T13:00:00.000Z',
    lines: request.lines.map(line => ({ id: line.id, taxMinor: '825', jurisdiction: 'fictitious-only', evidenceReference: 'fictitious-only' })) };
} };
const rpcQueries: Record<string, { sql: string; keys: string[] }> = {
  zentra_read_us_erp: { sql: 'select public.zentra_read_us_erp($1) result', keys: ['p_organization'] },
  zentra_us_erp_receipt: { sql: 'select public.zentra_us_erp_receipt($1,$2) result', keys: ['p_organization', 'p_idempotency_key'] },
  zentra_commit_us_erp: { sql: 'select public.zentra_commit_us_erp($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb) result', keys: ['p_organization', 'p_expected_revision', 'p_header', 'p_changes', 'p_ledger_audit', 'p_receipt', 'p_actor'] },
  zentra_us_erp_delta: { sql: 'select public.zentra_us_erp_delta($1,$2,$3) result', keys: ['p_organization', 'p_after_revision', 'p_limit'] },
};
const migrationSql = (name: string) => readFile(new URL('../../supabase/migrations/' + name, import.meta.url), 'utf8');
const parameters = (input: ErpCommit) => ({ p_organization: input.organizationId, p_expected_revision: input.expectedRevision, p_header: input.header,
  p_changes: input.changes, p_ledger_audit: input.ledgerAudit, p_receipt: input.receipt, p_actor: input.actor });
async function fixture(withCorrective = true) {
  const packageJson = JSON.parse(await readFile(join(moduleDirectory!, 'package.json'), 'utf8'));
  expect(packageJson.name).toBe('@electric-sql/pglite');
  const { PGlite } = createRequire(import.meta.url)(join(moduleDirectory!, 'dist/index.cjs')) as { PGlite: new () => Database };
  const db = new PGlite(); databases.push(db);
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table public.zentra_workspaces(organization_id text primary key, revision bigint not null default 0, snapshot_id uuid, number_floors jsonb not null default '[]', updated_by text not null default 'fixture');
    grant usage on schema public to service_role; grant select,update on public.zentra_workspaces to service_role;
    insert into public.zentra_workspaces(organization_id,revision) values('${org}',7),('fictitious-tax-proof-b',2);`);
  await db.exec(await migrationSql(stack[0]));
  for (const [index, company] of [configuration, { ...configuration, organizationId: 'fictitious-tax-proof-b' }].entries()) {
    await db.query('select public.zentra_put_workspace_country_config($1,$2,0,$3::uuid,$4::jsonb)', [company.organizationId, actor.userId,
      `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, JSON.stringify(company)]);
  }
  for (const name of stack.slice(1)) await db.exec(await migrationSql(name));
  if (withCorrective) await db.exec(await migrationSql(corrective));
  const client: Pick<SupabaseServerClient, 'rpc'> = { async rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const query = rpcQueries[name]; if (!query) throw new Error('Unexpected local RPC');
    try { return await db.transaction(async tx => {
      await tx.exec('set local role service_role');
      const values = query.keys.map(key => typeof args[key] === 'object' ? JSON.stringify(args[key]) : args[key]);
      return (await tx.query<{ result: T }>(query.sql, values)).rows[0].result;
    }); } catch (error) { throw new SupabaseServerError(400, (error as { code?: string }).code ?? 'unknown_sql'); }
  } };
  const store = createSupabaseErpStore(client);
  const dependencies = { store, configuration, actor, revalidate: async () => actor, taxProvider: async () => provider, seller: async () => seller };
  let key = 0;
  const send = async (command: ErpCommand) => executeErp(dependencies, { idempotencyKey: `proof-${++key}`, expectedRevision: (await store.read(org))?.revision ?? 0, command });
  await send({ type: 'initialize', periods: [{ id: '2026', start: '2026-01-01', end: '2026-12-31', status: 'open' }] });
  await send({ type: 'save_customer', customer: { id: 'c1', organizationId: org, kind: 'business', name: 'Fictitious Customer', billingAddress: configuration.address, paymentTermsDays: 30 } });
  await send({ type: 'save_estimate', id: 'q1', expectedEstimateRevision: 0, customerId: 'c1', date: '2026-10-08', expiresAt: '2026-11-07', paymentTermsDays: 30,
    lines: [{ id: 'l1', description: 'Fictitious service', quantityUnits: '1', quantityScale: 0, unitPrice: { currency: 'USD', minorUnits: '10000' }, discountBasisPoints: 0, taxTreatment: 'taxable' }], notes: '' });
  await send({ type: 'accept_estimate', estimateId: 'q1', expectedEstimateRevision: 1 });
  const issue: ErpCommand = { type: 'issue_invoice', id: 'i1', estimateId: 'q1', expectedEstimateRevision: 2, date: '2026-10-08', accountingDate: '2026-10-08', dueDate: '2026-11-07', periodId: '2026' };
  let captured: ErpCommit | undefined;
  await expect(executeErp({ ...dependencies, store: { ...store, commit: async input => { captured = input; throw new Error('fictitious_capture'); } } },
    { idempotencyKey: 'proof-issue', expectedRevision: 4, command: issue })).rejects.toThrow('fictitious_capture');
  if (!captured) throw new Error('Missing synthetic issue');
  const rawState = () => client.rpc<ErpState>('zentra_read_us_erp', { p_organization: org });
  const delta = () => client.rpc<ErpDelta>('zentra_us_erp_delta', { p_organization: org, p_after_revision: 0, p_limit: 100 });
  return { db, client, store, send, issue: structuredClone(captured), rawState, delta };
}
function invoiceChange(input: ErpCommit) {
  const invoice = input.changes.find(change => change.kind === 'invoice')?.payload;
  if (!invoice) throw new Error('Missing captured invoice');
  return invoice as unknown as { taxAssessment: Record<string, unknown> & { lines: Record<string, unknown>[] } };
}

describe.skipIf(!enabled)('additive public tax proof constraint on the complete US SQL stack', () => {
  it('accepts clean engine proof, keeps idempotent receipts and reconstructs an exact public cache', async () => {
    const f = await fixture();
    const receipt = await f.client.rpc('zentra_commit_us_erp', parameters(f.issue));
    expect(await f.client.rpc('zentra_commit_us_erp', parameters(f.issue))).toEqual(receipt);
    const state = (await f.store.read(org))!;
    expect(state.invoices[0].taxAssessment.lines[0].taxMinor).toBe('825');
    expect(applyErpDelta(null, publicErpDelta(await f.delta()), org)).toEqual(publicErpState(state));
    expect(await f.store.read('fictitious-tax-proof-b')).toBeNull();
  });
  it.each(['provider', 'providerDebug', 'credential', 'linePrivate'])('rejects %s fields atomically before a new invoice, receipt or event can be published', async field => {
    const f = await fixture(), before = await f.rawState(), beforeDelta = await f.delta();
    const input = structuredClone(f.issue), proof = invoiceChange(input).taxAssessment;
    if (field === 'linePrivate') proof.lines[0].internalData = { ein: '12-3456789', credential: 'SYNTHETIC_PRIVATE_MARKER' };
    else proof[field] = { ein: '12-3456789', credential: 'SYNTHETIC_PRIVATE_MARKER' };
    await expect(f.client.rpc('zentra_commit_us_erp', parameters(input))).rejects.toMatchObject({ code: '23514' });
    expect(await f.rawState()).toEqual(before); expect(await f.delta()).toEqual(beforeDelta);
    expect(await f.client.rpc('zentra_us_erp_receipt', { p_organization: org, p_idempotency_key: input.receipt.idempotencyKey })).toBeNull();
  });
  it('has exact required proof and line keys and rejects null, malformed, foreign and Swiss proof shapes', async () => {
    const f = await fixture(), proof = invoiceChange(f.issue).taxAssessment;
    const check = async (value: unknown) => (await f.db.query<{ valid: boolean }>('select public.zentra_us_erp_tax_proof_valid($1::jsonb,$2) valid', [JSON.stringify(value), org])).rows[0].valid;
    expect(await check(proof)).toBe(true);
    for (const field of Object.keys(proof)) { const missing = structuredClone(proof); delete missing[field]; expect(await check(missing)).toBe(false); }
    for (const field of Object.keys(proof.lines[0])) { const missing = structuredClone(proof); delete missing.lines[0][field]; expect(await check(missing)).toBe(false); }
    for (const malformed of [null, [], { ...proof, documentRevision: '2' }, { ...proof, documentRevision: 1.5 }, { ...proof, organizationId: 'fictitious-tax-proof-b' },
      { ...proof, country: 'CH', currency: 'CHF', source: 'swiss-vat' }, { ...proof, lines: {} }, { ...proof, lines: [] }, { ...proof, lines: [null] },
      { ...proof, lines: [{ ...proof.lines[0], taxMinor: 825 }] }, { ...proof, lines: [{ ...proof.lines[0], taxMinor: '8.25' }] }]) expect(await check(malformed)).toBe(false);
  });
  it('keeps the helper invoker, immutable, with empty search path, service-only EXECUTE and existing RLS', async () => {
    const f = await fixture();
    const helper = (await f.db.query<{ prosecdef: boolean; provolatile: string; proconfig: string[] }>("select prosecdef,provolatile,proconfig from pg_proc where oid='public.zentra_us_erp_tax_proof_valid(jsonb,text)'::regprocedure")).rows[0];
    expect(helper).toEqual({ prosecdef: false, provolatile: 'i', proconfig: ['search_path=""'] });
    for (const role of ['anon', 'authenticated']) {
      expect((await f.db.query<{ allowed: boolean }>("select has_function_privilege($1,'public.zentra_us_erp_tax_proof_valid(jsonb,text)','EXECUTE') allowed", [role])).rows[0].allowed).toBe(false);
      await f.db.exec(`set role ${role}`);
      await expect(f.db.query('select public.zentra_us_erp_tax_proof_valid($1::jsonb,$2)', [JSON.stringify(invoiceChange(f.issue).taxAssessment), org])).rejects.toMatchObject({ code: '42501' });
      await f.db.exec('reset role');
    }
    expect((await f.db.query<{ allowed: boolean }>("select has_function_privilege('service_role','public.zentra_us_erp_tax_proof_valid(jsonb,text)','EXECUTE') allowed")).rows[0].allowed).toBe(true);
    expect((await f.db.query<{ protected: boolean }>("select relrowsecurity protected from pg_class where oid='public.zentra_us_erp_records'::regclass")).rows[0].protected).toBe(true);
  });
  it('preserves old raw records, receipts and events physically without pretending they are safe to read or update', async () => {
    const f = await fixture(false), legacy = structuredClone(f.issue);
    invoiceChange(legacy).taxAssessment.providerDebug = { ein: '12-3456789', credential: 'SYNTHETIC_PRIVATE_MARKER' };
    await f.client.rpc('zentra_commit_us_erp', parameters(legacy));
    const beforeState = await f.rawState(), beforeDelta = await f.delta();
    const beforeReceipt = await f.client.rpc('zentra_us_erp_receipt', { p_organization: org, p_idempotency_key: legacy.receipt.idempotencyKey });
    const rawText = (await f.db.query<{ payload: string }>("select payload::text payload from public.zentra_us_erp_records where organization_id=$1 and kind='invoice'", [org])).rows[0].payload;
    await f.db.exec(await migrationSql(corrective));
    expect(await f.rawState()).toEqual(beforeState); expect(await f.delta()).toEqual(beforeDelta);
    expect(await f.client.rpc('zentra_us_erp_receipt', { p_organization: org, p_idempotency_key: legacy.receipt.idempotencyKey })).toEqual(beforeReceipt);
    expect((await f.db.query<{ payload: string }>("select payload::text payload from public.zentra_us_erp_records where organization_id=$1 and kind='invoice'", [org])).rows[0].payload).toBe(rawText);
    expect((await f.db.query<{ convalidated: boolean }>("select convalidated from pg_constraint where conname='zentra_us_erp_invoice_tax_proof_allowlist'")).rows[0].convalidated).toBe(false);
    expect((await f.db.query<{ valid: boolean }>("select public.zentra_us_erp_tax_proof_valid(payload->'taxAssessment',organization_id) valid from public.zentra_us_erp_records where organization_id=$1 and kind='invoice'", [org])).rows[0].valid).toBe(false);
    await expect(f.store.read(org)).rejects.toMatchObject({ code: 'invalid_stored_state', status: 503 });
    expect(JSON.stringify(publicErpState(beforeState))).not.toContain('SYNTHETIC_PRIVATE_MARKER');
    expect(JSON.stringify(publicErpDelta(beforeDelta))).not.toContain('SYNTHETIC_PRIVATE_MARKER');
    const paid = structuredClone(beforeState.invoices[0]);
    (paid.payments as unknown as Record<string, unknown>[]).push({ id: 'p1', idempotencyKey: 'old-proof-payment', organizationId: org, invoiceId: paid.id,
      amount: { currency: 'USD', minorUnits: '1' }, paymentDate: '2026-10-08', accountingDate: '2026-10-08', reference: 'fictitious', recordedBy: actor.userId });
    await expect(f.db.query("update public.zentra_us_erp_records set payload=$1::jsonb,state_revision=6 where organization_id=$2 and kind='invoice'", [JSON.stringify(paid), org])).rejects.toMatchObject({ code: '23514' });
    expect(await f.rawState()).toEqual(beforeState);
  });
  it('does not validate or rewrite historical rows while applying the corrective SQL', async () => {
    const sql = await migrationSql(corrective);
    expect(sql).toMatch(/check\(kind<>'invoice'[\s\S]*not valid;/);
    expect(sql.toLowerCase()).not.toMatch(/\b(update|delete|truncate)\s+(public\.)?zentra_us_erp/);
    expect(sql.toLowerCase()).not.toContain('validate constraint');
    expect(createHash('sha256').update(sql).digest('hex')).toHaveLength(64);
  });
});
