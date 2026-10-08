import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import { canonicalErpJson, executeErp } from './runtime';
import { createSupabaseErpStore } from './runtime-store';
import { buildTaxRequest, type TaxAssessment } from './invoicing';
import { prepareStripeTaxResolvedRequest, type StripeTaxTestBinding } from './stripe-tax-resolved-request';
import type { StripeTaxPrivateProof } from './stripe-tax-calculation';
import type { CompanyConfiguration } from './types';
import type { FinancialAuthority } from './accounting/ledger';
import type { ErpCommand, ErpCommit } from './runtime-types';
import type { UsTaxFacts } from './us-tax-profile';
import { validateCompanyConfiguration } from './country-config';
import { createSupabaseUsTaxOperationStore } from './us-tax-operation-store';
import { validateStoredStripeTaxCalculation } from './stripe-tax-calculation';

// SQL-local invariant tests only: one serialized RAM PGlite PostgreSQL instance.
// All provider bindings/proofs below are explicitly test_fixture, never real
// Stripe observations, hosted Auth/D1 admission or production tax authority.
const moduleDirectory = process.env.PGLITE_MODULE_DIR, enabled = Boolean(moduleDirectory && isAbsolute(moduleDirectory));
const migration = '20261008060826_international_us_tax_operations';
type Sql = { exec(sql: string): Promise<unknown>; query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> };
type Database = Sql & { transaction<T>(task: (sql: Sql) => Promise<T>): Promise<T>; close(): Promise<void> };
type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
let db: Database;
const chOrg=randomUUID(),chActor=randomUUID();let chBefore:unknown;
const snapshotCH=async()=> (await db.query('select to_jsonb(p) profile,(select to_jsonb(w) from public.zentra_workspaces w where w.organization_id=p.organization_id) workspace,(select to_jsonb(c) from public.zentra_workspace_country_configs c where c.organization_id=p.organization_id) country from public.zentra_company_profiles p where p.organization_id=$1',[chOrg])).rows;
const digest = (body: string) => createHash('sha256').update(body).digest('hex');
const sql = <T = Record<string, unknown>>(query: string, values: unknown[] = [], role = 'service_role') => db.transaction(async tx => { await tx.exec(`set local role ${role}`); return (await tx.query<T>(query, values)).rows; });
const result = async <T = unknown>(query: string, values: unknown[]) => (await sql<{ result: T }>(query, values))[0].result;
const rpcQueries: Record<string, { sql: string; keys: string[] }> = {
  zentra_read_us_erp: { sql: 'select public.zentra_read_us_erp($1) result', keys: ['p_organization'] },
  zentra_us_erp_receipt: { sql: 'select public.zentra_us_erp_receipt($1,$2) result', keys: ['p_organization', 'p_idempotency_key'] },
  zentra_commit_us_erp: { sql: 'select public.zentra_commit_us_erp($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb) result', keys: ['p_organization', 'p_expected_revision', 'p_header', 'p_changes', 'p_ledger_audit', 'p_receipt', 'p_actor'] },
  zentra_read_us_tax_operation: { sql: 'select public.zentra_read_us_tax_operation($1,$2,$3,$4::jsonb) result', keys: ['p_organization','p_erp_idempotency_key','p_command_hash','p_actor'] },
  zentra_reserve_us_tax_operation: { sql: 'select public.zentra_reserve_us_tax_operation($1,$2::jsonb,$3::uuid,$4,$5,$6,$7,$8) result', keys: ['p_organization','p_actor','p_operation_id','p_resolved_body','p_resolved_sha256','p_params_body','p_params_sha256','p_provider_idempotency_key'] },
  zentra_record_us_tax_calculation: { sql: 'select public.zentra_record_us_tax_calculation($1,$2::uuid,$3::jsonb,$4,$5,$6::jsonb) result', keys: ['p_organization','p_operation_id','p_actor','p_proof_body','p_proof_sha256','p_assessment'] },
  zentra_commit_us_tax_invoice_test: { sql: 'select public.zentra_commit_us_tax_invoice_test($1,$2::uuid,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb) result', keys: ['p_organization','p_operation_id','p_expected_revision','p_header','p_changes','p_ledger_audit','p_receipt','p_actor'] },
};
const client: Pick<SupabaseServerClient, 'rpc'> = { async rpc<T>(name: string, parameters: Record<string, unknown>): Promise<T> {
  const query = rpcQueries[name]; if (!query) throw new Error('Unexpected local ERP RPC');
  try { return await result<T>(query.sql, query.keys.map(key => typeof parameters[key] === 'object' ? JSON.stringify(parameters[key]) : parameters[key])); }
  catch (error) { throw new SupabaseServerError(400, (error as { code?: string }).code ?? 'fixture_sql'); }
} };
type PrivateOperation = { status: string; organizationId: string; operationId: string; actorUserId: string; erpIdempotencyKey: string; commandHash: string; reservedAt: string; retryUntil: string; resolvedBody: string; resolvedSha256: string; paramsBody: string; paramsSha256: string; providerKey: string; proofBody: string | null; proofSha256: string | null; assessment: TaxAssessment | null; receipt: ErpCommit['receipt'] | null };
const commitParameters = (commit: ErpCommit) => [commit.organizationId, commit.expectedRevision, JSON.stringify(commit.header), JSON.stringify(commit.changes), JSON.stringify(commit.ledgerAudit), JSON.stringify(commit.receipt), JSON.stringify(commit.actor)];
async function fixture(options:{lineCount?:number;description?:string;taxMinor?:string}={}) {
  const org = randomUUID(), owner = randomUUID(), now = new Date(), day = now.toISOString().slice(0, 10), year = now.getUTCFullYear();
  const actor: FinancialAuthority = { organizationId: org, userId: owner, role: 'owner', managementEntitled: true, timestamp: now.toISOString() };
  const config: CompanyConfiguration = validateCompanyConfiguration({ schemaVersion: 1, organizationId: org, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York', address: { country: 'US', line1: '1 Fictitious Public Street', city: 'New York', subdivision: 'NY', postalCode: '10001' }, accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'configured' } });
  const initial = { ...config, taxConfiguration: { status: 'unconfigured' } };
  await result('select public.zentra_admit_new_us_workspace_v1($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::jsonb,$6) result', [org, randomUUID(), owner, randomUUID(), JSON.stringify(initial), digest(org)]);
  // Explicit synthetic TEST configuration, never copied from private declarations.
  await result('select public.zentra_put_workspace_country_config($1,$2,1,$3::uuid,$4::jsonb) result', [org, owner, randomUUID(), JSON.stringify(config)]);
  const seller = { displayName: 'Fictitious Public Seller', contactEmail: 'fixture@example.test' };
  await result('select public.zentra_put_us_seller_profile($1,$2,0,$3::uuid,$4::jsonb) result', [org, owner, randomUUID(), JSON.stringify(seller)]);
  const facts: UsTaxFacts = { schemaVersion: 1, legalName: 'PRIVATE_FICTITIOUS_LEGAL_NAME', taxOrigin: { country: 'US', line1: '987 PRIVATE_FICTITIOUS_ORIGIN', city: 'New York', subdivision: 'NY', postalCode: '10001' }, timeZone: 'America/New_York' };
  await result('select public.zentra_put_us_tax_profile($1,$2,0,$3::uuid,$4::jsonb) result', [org, owner, randomUUID(), JSON.stringify(facts)]);
  const binding: StripeTaxTestBinding = { organizationId: org, accountId: 'acct_FictitiousTestAccount', mode: 'test', apiVersion: '2026-08-26.dahlia', revision: 1, settingsSha256: digest('fixture-settings'), registrationsSha256: digest('fixture-registrations'), observedAt: new Date(now.getTime() - 1000).toISOString(), validUntil: new Date(now.getTime() + 3600000).toISOString(), evidenceKind: 'test_fixture', scope: 'erp_invoice_tax' };
  await result('select public.zentra_put_us_tax_provider_binding($1,$2,0,$3::uuid,$4::jsonb) result', [org, owner, randomUUID(), JSON.stringify(binding)]);
  const store = createSupabaseErpStore(client), sellerSnapshot = { organizationId: org, ...seller };
  const dependencies = { store, configuration: config, actor, revalidate: async () => ({ ...actor, timestamp: new Date().toISOString() }), seller: async () => sellerSnapshot, taxProvider: async () => null };
  let sequence = 0;
  const send = async (command: ErpCommand) => executeErp(dependencies, { idempotencyKey: `fixture-${++sequence}`, expectedRevision: (await store.read(org))?.revision ?? 0, command });
  await send({ type: 'initialize', periods: [{ id: 'current', start: `${year}-01-01`, end: `${year}-12-31`, status: 'open' }] });
  await send({ type: 'save_customer', customer: { id: 'customer', organizationId: org, name: 'Fictitious Customer', kind: 'business', billingAddress: config.address, paymentTermsDays: 30 } });
  const salesLines=Array.from({length:options.lineCount??1},(_,index)=>({id:index===0?'line':`line${index}`,description:options.description??'Fictitious classified service',quantityUnits:'2',quantityScale:0,unitPrice:{currency:'USD' as const,minorUnits:'5000'},discountBasisPoints:0,taxTreatment:'taxable' as const}));
  await send({ type: 'save_estimate', id: 'estimate', expectedEstimateRevision: 0, customerId: 'customer', date: day, expiresAt: `${year}-12-31`, paymentTermsDays: 30, lines:salesLines, notes: 'SQL fixture only, not a real transaction' });
  await send({ type: 'accept_estimate', estimateId: 'estimate', expectedEstimateRevision: 1 });
  const state = (await store.read(org))!, operationId = randomUUID(), key = 'fixture-invoice';
  const command: ErpCommand = { type: 'issue_invoice', id: 'invoice', estimateId: 'estimate', expectedEstimateRevision: 2, date: day, accountingDate: day, dueDate: day, periodId: 'current' };
  let commit: ErpCommit | undefined;
  const source = buildTaxRequest(config, state.estimates[0], day);
  const calculatedAt = new Date().toISOString(), expiresAt = new Date(now.getTime() + 1800000).toISOString();
  const calculationId = 'taxcalc_FictitiousFixture', providerLineId = 'tax_li_FictitiousFixture';
  const lineTax=options.taxMinor??'825',netMinor=(BigInt(10000)*BigInt(salesLines.length)).toString(),taxMinor=(BigInt(lineTax)*BigInt(salesLines.length)).toString(),totalMinor=(BigInt(netMinor)+BigInt(taxMinor)).toString();
  const assessment: TaxAssessment = { organizationId: org, country: 'US', currency: 'USD', documentId: source.documentId, documentRevision: source.documentRevision, fingerprint: source.fingerprint, source: 'external-provider', providerReference: calculationId, determinedAt: calculatedAt, validUntil: expiresAt, lines:source.lines.map((line,index)=>({id:line.id,taxMinor:lineTax,jurisdiction:'US-NY',evidenceReference:`${calculationId}:${providerLineId}${index===0?'':index}`})) };
  // The established engine produces the exact invoice/number/journal candidate.
  // Capturing before SQL grants nothing; the new SQL transaction must admit it.
  await expect(executeErp({ ...dependencies, actor: { ...actor, timestamp: new Date().toISOString() }, taxProvider: async () => ({ id: 'explicit-test-fixture', calculate: async () => assessment }), store: { ...store, commit: async value => { commit = value; throw new Error('capture_only'); } } }, { idempotencyKey: key, expectedRevision: 4, command })).rejects.toThrow('capture_only');
  if (!commit) throw new Error('Expected engine commit candidate');
  const resolved = await prepareStripeTaxResolvedRequest({ organizationId: org, operationId, invoiceId: 'invoice', actorUserId: owner, erpIdempotencyKey: key, commandHash: commit.receipt.commandHash, expectedErpRevision: 4, countryRevision: 2, sellerRevision: 1, taxFactsRevision: 1, configuration: config, estimate: state.estimates[0], taxFacts: facts, binding, classifications: salesLines.map(line=>({lineId:line.id,taxCode:'txcd_10000000',kind:'service' as const,taxBehavior:'exclusive' as const,revision:1,evidenceReference:'fixture classification only, no provider verification'})), invoiceDate: day, taxDateInstant: `${day}T12:00:00Z`, taxDatePolicy: 'caller_supplied_invoice_instant', now: new Date().toISOString(), addressSource: 'billing' });
  const proof: StripeTaxPrivateProof = { schemaVersion: 1, organizationId: org, operationId, provider: 'stripe_tax', accountId: binding.accountId, mode: 'test', apiVersion: binding.apiVersion, bindingRevision: 1, resolvedSha256: resolved.resolvedSha256, paramsSha256: resolved.paramsSha256, settingsSha256: binding.settingsSha256, registrationsSha256: binding.registrationsSha256, evidenceKind: 'test_fixture', calculationId, calculatedAt, expiresAt, taxDate: resolved.params.tax_date, currency: 'USD', netMinor,taxMinor,totalMinor, lines:salesLines.map((line,index)=>({lineId:line.id,providerLineId:providerLineId+(index===0?'':index),netMinor:'10000',quantity:'2',taxCode:'txcd_10000000',taxMinor:lineTax,breakdowns:[{amountMinor:lineTax,taxableMinor:'10000',taxabilityReason:'standard_rated' as const,sourcing:'destination' as const,jurisdiction:{country:'US' as const,state:'NY',level:'state',displayName:'Fictitious jurisdiction'}},{amountMinor:'0',taxableMinor:'0',taxabilityReason:'not_subject_to_tax' as const,sourcing:'destination' as const,jurisdiction:{country:'US' as const,state:'NY',level:'county',displayName:'Fictitious county'}}]})) };
  const reserve = (override: Partial<typeof resolved> = {}, admitted: FinancialAuthority = actor) => { const r = { ...resolved, ...override }; return result<PrivateOperation>('select public.zentra_reserve_us_tax_operation($1,$2::jsonb,$3::uuid,$4,$5,$6,$7,$8) result', [org, JSON.stringify(admitted), operationId, r.resolvedBody, r.resolvedSha256, r.paramsBody, r.paramsSha256, r.idempotencyKey]); };
  const reservePayload=(payload:Record<string,unknown>)=>{
    const paramsBody=canonicalErpJson(payload.params);payload.paramsSha256=digest(paramsBody);const resolvedBody=canonicalErpJson(payload),resolvedSha256=digest(resolvedBody);
    const idempotencyKey='ztax_test_'+digest(canonicalErpJson(['zentra:us:stripe-tax:calculation:v1',org,operationId,(payload.binding as StripeTaxTestBinding).accountId,'test',resolvedSha256]));
    return reserve({paramsBody,paramsSha256:payload.paramsSha256 as string,resolvedBody,resolvedSha256,idempotencyKey});
  };
  const record = (p: unknown = proof, a: unknown = assessment, body = canonicalErpJson(p), sha = digest(body)) => result<PrivateOperation>('select public.zentra_record_us_tax_calculation($1,$2::uuid,$3::jsonb,$4,$5,$6::jsonb) result', [org, operationId, JSON.stringify(actor), body, sha, JSON.stringify(a)]);
  const write = (candidate = commit!) => result<ErpCommit['receipt']>('select public.zentra_commit_us_tax_invoice_test($1,$2::uuid,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb) result', [org, operationId, ...commitParameters(candidate).slice(1)]);
  const read = (admitted = actor, commandHash = resolved.commandHash) => result<PrivateOperation>('select public.zentra_read_us_tax_operation($1,$2,$3,$4::jsonb) result', [org, key, commandHash, JSON.stringify(admitted)]);
  const counts = async () => (await sql<{ invoices: number; journals: number; links: number; operations: number; events: number; receipts: number; counter: number }>(`select (select count(*)::int from public.zentra_us_erp_records where organization_id=$1 and kind='invoice') invoices,(select count(*)::int from public.zentra_us_erp_records where organization_id=$1 and kind='journal') journals,(select count(*)::int from public.zentra_us_tax_invoice_links where organization_id=$1) links,(select count(*)::int from public.zentra_us_tax_operations where organization_id=$1) operations,(select count(*)::int from public.zentra_us_erp_events where organization_id=$1) events,(select count(*)::int from public.zentra_us_erp_receipts where organization_id=$1) receipts,(select (header->'counters'->>'invoice')::int from public.zentra_us_erp_heads where organization_id=$1) counter`, [org]))[0];
  return { org, owner, actor, config, binding, facts, resolved, proof, assessment, commit, reserve,reservePayload, record, write, read, counts, store, send, seller };
}

describe.runIf(enabled)('durable TEST tax operations and atomic invoice proof on real local PostgreSQL', () => {
  beforeAll(async () => {
    expect(JSON.parse(await readFile(join(moduleDirectory!, 'package.json'), 'utf8')).name).toBe('@electric-sql/pglite');
    const { PGlite } = createRequire(import.meta.url)(join(moduleDirectory!, 'dist/index.cjs')) as { PGlite: new () => Database }; db = new PGlite();
    await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);grant usage on schema public to service_role;');
    for (const name of ['202609140100_company_profiles','202609140200_company_collaboration','202609200300_company_content','20261007194528_international_workspace_country_config'])await db.exec(await readFile(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), 'utf8'));
    await db.query('insert into public.zentra_workspaces(organization_id,updated_by) values($1,$2)',[chOrg,chActor]);
    await db.query('insert into public.zentra_company_profiles(organization_id,profile,updated_by) values($1,$2::jsonb,$3)',[chOrg,JSON.stringify({company_name:'Unchanged fictitious CH company',private_identifier:'fixture-only'}),chActor]);
    await db.query('select public.zentra_put_workspace_country_config($1,$2,0,$3::uuid,$4::jsonb)',[chOrg,chActor,randomUUID(),JSON.stringify({schemaVersion:1,organizationId:chOrg,country:'CH',currency:'CHF',language:'fr',timeZone:'Europe/Zurich',address:{country:'CH',line1:'1 Rue Fictive',city:'Genève',subdivision:'GE',postalCode:'1201'},accountingBasis:'accrual',invoiceNumberPrefix:'CH',taxConfiguration:{status:'unconfigured'}})]);chBefore=await snapshotCH();
    for (const name of ['20261007222349_international_us_erp_persistence','20261007224820_international_us_erp_delta_stream','20261007225725_international_us_erp_seller_snapshot','20261008001726_new_us_workspace_admission','20261008013200_international_tax_proof_allowlist','20261008034422_international_us_seller_profile','20261008044402_international_us_tax_profile',migration]) await db.exec(await readFile(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), 'utf8'));
  }, 20_000);
  afterAll(async () => { await db?.close(); });
  it('reserves exact immutable bytes and opaque provider key without issuing anything', async () => {
    const f = await fixture(); const first = await f.reserve(); expect(first).toEqual(await f.reserve());
    expect(first).toEqual({ status: 'reserved', organizationId: f.org, operationId: f.resolved.operationId, actorUserId: f.owner, erpIdempotencyKey: f.resolved.erpIdempotencyKey, commandHash: f.resolved.commandHash, reservedAt: first.reservedAt, retryUntil: first.retryUntil, resolvedBody: f.resolved.resolvedBody, resolvedSha256: f.resolved.resolvedSha256, paramsBody: f.resolved.paramsBody, paramsSha256: f.resolved.paramsSha256, providerKey: f.resolved.idempotencyKey, proofBody: null, proofSha256: null, assessment: null, receipt: null });
    expect(new Date(first.retryUntil).getTime()-new Date(first.reservedAt).getTime()).toBe(23*3600000);
    expect(await f.counts()).toEqual({ invoices: 0, journals: 0, links: 0, operations: 1, events: 4, receipts: 4, counter: 0 }); expect(await f.read()).toEqual(first);
  });
  it('atomically persists the real engine invoice, number, journal, receipt, delta and private proof link', async () => {
    const f = await fixture(); await f.reserve(); const recorded = await f.record(); expect(recorded.proofBody).toBe(canonicalErpJson(f.proof)); expect(recorded.proofSha256).toBe(digest(recorded.proofBody!));
    expect(await f.write()).toEqual(f.commit.receipt); expect(await f.counts()).toEqual({ invoices: 1, journals: 1, links: 1, operations: 1, events: 5, receipts: 5, counter: 1 });
    const state = (await f.store.read(f.org))!; expect(state.invoices[0].number).toBe('INV-000001'); expect(state.invoices[0].tax.minorUnits).toBe('825'); expect(state.ledger.entries[0].lines).toEqual([{ accountId: 'receivables', debitMinor: '10825', creditMinor: '0' },{ accountId: 'sales', debitMinor: '0', creditMinor: '10000' },{ accountId: 'tax-payable', debitMinor: '0', creditMinor: '825' }]);
    expect((await f.read()).status).toBe('committed'); expect((await f.read()).receipt).toEqual(f.commit.receipt);
  });
  it('preserves mixed known breakdown reasons and exact public evidence', async () => {
    const f = await fixture(); await f.reserve(); await f.record(); await f.write(); expect(JSON.parse((await f.read()).proofBody!)).toEqual(f.proof);
    expect(f.proof.lines[0].breakdowns.map(b => b.taxabilityReason)).toEqual(['standard_rated','not_subject_to_tax']);
    expect((await f.store.read(f.org))!.invoices[0].taxAssessment.lines[0].evidenceReference).toBe(`${f.proof.calculationId}:${f.proof.lines[0].providerLineId}`);
  });
  it('replays one exact committed receipt after newer facts/seller/binding writes and a lost response', async () => {
    const f = await fixture(); await f.reserve(); await f.record(); await expect((async()=>{await f.write();throw new Error('simulated_response_loss_after_commit');})()).rejects.toThrow('simulated_response_loss_after_commit'); const before = await f.counts();
    await result('select public.zentra_put_us_tax_profile($1,$2,1,$3::uuid,$4::jsonb) result', [f.org,f.owner,randomUUID(),JSON.stringify({...f.facts,legalName:'New private fixture name'})]);
    await result('select public.zentra_put_us_seller_profile($1,$2,1,$3::uuid,$4::jsonb) result', [f.org,f.owner,randomUUID(),JSON.stringify({...f.seller,displayName:'New public fixture seller'})]);
    await result('select public.zentra_put_us_tax_provider_binding($1,$2,1,$3::uuid,$4::jsonb) result',[f.org,f.owner,randomUUID(),JSON.stringify({...f.binding,revision:2})]);
    expect(await f.write()).toEqual(f.commit.receipt); expect(await f.reserve()).toEqual(await f.read()); expect(await f.counts()).toEqual(before);
  });
  it('rejects the old RPC alone even with a valid-looking public assessment, rolling back all effects', async () => {
    const f = await fixture(); await f.reserve(); await f.record(); const before = await f.counts();
    await expect(result(rpcQueries.zentra_commit_us_erp.sql,commitParameters(f.commit))).rejects.toMatchObject({code:'PX005'}); expect(await f.counts()).toEqual(before);
  });
  it('rejects direct invoice CRUD and deferred orphan links without a completed invoice', async () => {
    const f = await fixture(); await f.reserve(); await f.record(); const invoice = f.commit.changes.find(change=>change.kind==='invoice')!;
    await expect(sql('insert into public.zentra_us_erp_records values($1,\'invoice\',$2,$3::jsonb,5)',[f.org,invoice.id,JSON.stringify(invoice.payload)])).rejects.toMatchObject({code:'PX005'});
    await expect(sql('insert into public.zentra_us_tax_invoice_links(organization_id,invoice_id,operation_id,erp_idempotency_key,command_hash,erp_revision) values($1,$2,$3::uuid,$4,$5,5)',[f.org,f.resolved.invoiceId,f.resolved.operationId,f.resolved.erpIdempotencyKey,f.resolved.commandHash])).rejects.toThrow();
    expect(await f.counts()).toMatchObject({invoices:0,journals:0,links:0,counter:0});
  });
  it('rolls the complete wrapper back if the outer transaction fails', async () => {
    const f = await fixture(); await f.reserve(); await f.record(); const before = await f.counts();
    await expect(db.transaction(async tx=>{await tx.exec('set local role service_role');await tx.query('select public.zentra_commit_us_tax_invoice_test($1,$2::uuid,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb)',[f.org,f.resolved.operationId,...commitParameters(f.commit).slice(1)]);throw new Error('fixture_outer_rollback');})).rejects.toThrow('fixture_outer_rollback'); expect(await f.counts()).toEqual(before);expect((await f.read()).status).toBe('calculated');
  });
  it.each(['country','seller','facts','binding'] as const)('refuses %s ABA revisions before any invoice/number/journal',async kind=>{
    const f=await fixture();await f.reserve();await f.record();
    for(let turn=0;turn<2;turn++){
      const original=kind==='country'?f.config:kind==='seller'?f.seller:kind==='facts'?f.facts:f.binding;
      const changed=kind==='country'?{...f.config,language:'fr'}:kind==='seller'?{...f.seller,displayName:'Changed seller'}:kind==='facts'?{...f.facts,legalName:'Changed facts'}:{...f.binding,settingsSha256:digest('changed settings')};
      const payload=turn===0?changed:original;
      const functionName=kind==='country'?'zentra_put_workspace_country_config':kind==='seller'?'zentra_put_us_seller_profile':kind==='facts'?'zentra_put_us_tax_profile':'zentra_put_us_tax_provider_binding';
      const revision=(kind==='country'?2:1)+turn;
      await result(`select public.${functionName}($1,$2,$3,$4::uuid,$5::jsonb) result`,[f.org,f.owner,revision,randomUUID(),JSON.stringify(kind==='binding'?{...payload,revision:revision+1}:payload)]);
    }
    await expect(f.write()).rejects.toMatchObject({code:'PX001'});expect(await f.counts()).toMatchObject({invoices:0,journals:0,links:0,counter:0});
  });
  it.each(['actor','key','hash','params','resolvedBody','providerKey'] as const)('rejects reused operation with changed %s',async field=>{
    const f=await fixture();await f.reserve();
    const overrides=field==='key'?{resolvedBody:f.resolved.resolvedBody.replace('fixture-invoice','changed-key')}:field==='hash'?{resolvedSha256:'f'.repeat(64)}:field==='params'?{paramsBody:f.resolved.paramsBody+' '}:field==='resolvedBody'?{resolvedBody:f.resolved.resolvedBody+' '}:field==='providerKey'?{idempotencyKey:'ztax_test_'+'f'.repeat(64)}:{};
    await expect(f.reserve(overrides,field==='actor'?{...f.actor,userId:randomUUID()}:f.actor)).rejects.toMatchObject({code:'PX002'});
  });
  it.each(['mode','evidenceKind','paramsSha256','taxMinor','taxabilityReason','taxableMinor','sourcing','quantity','breakdownSum','privateExtra'] as const)('rejects malformed or unsupported proof %s without issuing',async field=>{
    const f=await fixture();await f.reserve();const p=structuredClone(f.proof) as unknown as Record<string,unknown>;const line=(p.lines as Record<string,unknown>[])[0],b=(line.breakdowns as Record<string,unknown>[])[0];
    if(field==='mode')p.mode='live';else if(field==='evidenceKind')p.evidenceKind='provider_observation';else if(field==='paramsSha256')p.paramsSha256='f'.repeat(64);else if(field==='taxMinor')p.taxMinor=null;else if(field==='quantity')line.quantity='1';else if(field==='taxabilityReason')b.taxabilityReason='not_collecting';else if(field==='taxableMinor')b.taxableMinor='10001';else if(field==='sourcing')b.sourcing='unknown';else if(field==='breakdownSum')b.amountMinor='826';else p.raw='must_not_be_admitted';
    await expect(f.record(p)).rejects.toMatchObject({code:'PX004'});expect((await f.read()).status).toBe('reserved');expect(await f.counts()).toMatchObject({invoices:0,journals:0,links:0,counter:0});
  });
  it.each(['member','read_only'] as const)('refuses a %s instead of inventing owner authority',async role=>{const f=await fixture();await expect(f.reserve({}, {...f.actor,role})).rejects.toMatchObject({code:'PX007'});expect(await f.counts()).toMatchObject({operations:0});});
  it('requires exact proof bytes/hash on retries and rejects direct reset/delete/truncate',async()=>{
    const f=await fixture();await f.reserve();await f.record();expect(await f.record()).toEqual(await f.read());
    await expect(f.record(f.proof,f.assessment,canonicalErpJson(f.proof)+' ')).rejects.toMatchObject({code:'PX002'});
    await expect(f.record(f.proof,f.assessment,canonicalErpJson(f.proof),'f'.repeat(64))).rejects.toMatchObject({code:'PX004'});
    await expect(sql("update public.zentra_us_tax_operations set status='reserved' where organization_id=$1",[f.org])).rejects.toMatchObject({code:'PX005'});
    await expect(db.query('delete from public.zentra_us_tax_operations where organization_id=$1',[f.org])).rejects.toMatchObject({code:'PX005'});
    await expect(db.exec('truncate public.zentra_us_tax_operations cascade')).rejects.toMatchObject({code:'PX005'});
  });
  it('keeps all private facts/binding/proof detail outside real public state and delta',async()=>{
    const f=await fixture();await f.reserve();await f.record();await f.write();
    for(const body of [await result('select public.zentra_read_us_erp($1) result',[f.org]),await result('select public.zentra_us_erp_delta($1,0,100) result',[f.org])]){
      const serialized=JSON.stringify(body);for(const marker of [f.facts.legalName,f.facts.taxOrigin.line1,f.binding.accountId,'settingsSha256','registrationsSha256','evidenceKind','taxOrigin','breakdowns','proofBody'])expect(serialized).not.toContain(marker);
    }
  });
  it('preserves ordinary ERP payment operations on an immutable issued invoice',async()=>{
    const f=await fixture();await f.reserve();await f.record();await f.write();await f.send({type:'record_payment',id:'payment',invoiceId:'invoice',amountMinor:'500',paymentDate:f.resolved.invoiceDate,accountingDate:f.resolved.invoiceDate,periodId:'current',reference:'fixture partial payment'});
    expect((await f.store.read(f.org))!.invoices[0].payments).toHaveLength(1);expect((await f.counts()).journals).toBe(2);expect(await f.write()).toEqual(f.commit.receipt);
  });
  it.each(['anon','authenticated'])('denies private table and RPC access to %s',async role=>{
    const f=await fixture();await f.reserve();
    await expect(sql('select * from public.zentra_us_tax_operations',[],role)).rejects.toMatchObject({code:'42501'});
    await expect(sql('select public.zentra_read_us_tax_provider_binding($1)',[f.org],role)).rejects.toMatchObject({code:'42501'});
  });
  it('round-trips the real private TypeScript RPC port and normalized stored calculation before atomic commit',async()=>{
    const f=await fixture(),port=createSupabaseUsTaxOperationStore(client);
    const reserved=await port.reserve(f.actor,f.resolved);expect(reserved.status).toBe('reserved');expect(reserved.resolved).toEqual(f.resolved);
    const normalized=await validateStoredStripeTaxCalculation(f.resolved,{proofBody:canonicalErpJson(f.proof),proofSha256:digest(canonicalErpJson(f.proof)),assessment:f.assessment},new Date().toISOString());
    expect((await port.record(f.actor,f.resolved,normalized)).calculation?.proofBody).toBe(normalized.proofBody);
    expect(await port.commit(f.resolved.operationId,f.commit)).toEqual(f.commit.receipt);expect((await port.read(f.actor,f.resolved.erpIdempotencyKey,f.resolved.commandHash))?.receipt).toEqual(f.commit.receipt);
    expect(await f.counts()).toMatchObject({invoices:1,journals:1,links:1,counter:1});
  });
  it('preserves private microseconds but requires the exact millisecond floor projection publicly',async()=>{
    const f=await fixture();await f.reserve();const p={...f.proof,calculatedAt:f.proof.calculatedAt.replace('Z','456Z'),expiresAt:f.proof.expiresAt.replace('Z','789Z')};
    await f.record(p);expect(JSON.parse((await f.read()).proofBody!).calculatedAt).toBe(p.calculatedAt);
    await expect(f.record(p,{...f.assessment,determinedAt:p.calculatedAt})).rejects.toMatchObject({code:'PX002'});
  });
  it.each(['determinedAt','validUntil'] as const)('rejects a non-floor public %s against microsecond proof',async field=>{
    const f=await fixture();await f.reserve();const p={...f.proof,calculatedAt:f.proof.calculatedAt.replace('Z','123Z'),expiresAt:f.proof.expiresAt.replace('Z','987Z')};
    const a={...f.assessment,[field]:new Date(new Date(f.assessment[field]).getTime()+1).toISOString()};await expect(f.record(p,a)).rejects.toMatchObject({code:'PX004'});
  });
  it('uses a shorter binding expiry for the public proof and refuses a later public expiry',async()=>{
    const f=await fixture();await f.reserve();const p={...f.proof,expiresAt:new Date(new Date(f.binding.validUntil).getTime()+3600000).toISOString()};
    await expect(f.record(p)).rejects.toMatchObject({code:'PX004'});await f.record(p,{...f.assessment,validUntil:f.binding.validUntil});expect((await f.read()).assessment?.validUntil).toBe(f.binding.validUntil);
  });
  it('never renews reservedAt/retryUntil on reserve replay and refuses mutation of its retry window',async()=>{
    const f=await fixture(),first=await f.reserve();expect(await f.reserve()).toEqual(first);
    await expect(sql("update public.zentra_us_tax_operations set retry_until=retry_until+interval '1 second' where organization_id=$1",[f.org])).rejects.toMatchObject({code:'PX005'});
    await expect(sql("update public.zentra_us_tax_operations set created_at=created_at-interval '1 hour',retry_until=retry_until-interval '1 hour' where organization_id=$1",[f.org])).rejects.toMatchObject({code:'PX005'});
  });
  it('refuses recording after the durable retry deadline (database-owner test aging only)',async()=>{
    const f=await fixture();await f.reserve();
    // Only the database owner can age this fixture; service_role cannot edit the
    // immutable clocks. DDL and rows roll back together after the expected error.
    await expect(db.transaction(async tx=>{
      await tx.exec('alter table public.zentra_us_tax_operations disable trigger zentra_us_tax_operation_guard');
      await tx.query("with t as materialized(select clock_timestamp() n) update public.zentra_us_tax_operations set created_at=t.n-interval '24 hours',retry_until=t.n-interval '1 hour' from t where organization_id=$1",[f.org]);
      await tx.exec('set constraints all immediate');
      await tx.exec('alter table public.zentra_us_tax_operations enable trigger zentra_us_tax_operation_guard');await tx.exec('set local role service_role');
      await tx.query('select public.zentra_record_us_tax_calculation($1,$2::uuid,$3::jsonb,$4,$5,$6::jsonb)',[f.org,f.resolved.operationId,JSON.stringify(f.actor),canonicalErpJson(f.proof),digest(canonicalErpJson(f.proof)),JSON.stringify(f.assessment)]);
    })).rejects.toMatchObject({code:'PX006'});
    expect((await f.read()).status).toBe('reserved');expect(await f.counts()).toMatchObject({invoices:0,counter:0});
  });
  it('rejects an expired binding before reserve and leaves ERP counters untouched',async()=>{
    const f=await fixture();await result('select public.zentra_put_us_tax_provider_binding($1,$2,1,$3::uuid,$4::jsonb) result',[f.org,f.owner,randomUUID(),JSON.stringify({...f.binding,revision:2,observedAt:new Date(Date.now()-3600000).toISOString(),validUntil:new Date(Date.now()-1000).toISOString()})]);
    await expect(f.reserve()).rejects.toMatchObject({code:'PX001'});expect(await f.counts()).toMatchObject({operations:0,invoices:0,counter:0});
  });
  it.each(['userId','role','timestamp'] as const)('refuses a non-string trusted actor %s rather than JSON coercion',async field=>{
    const f=await fixture();await expect(f.reserve({}, {...f.actor,[field]:7} as unknown as FinancialAuthority)).rejects.toMatchObject({code:'PX007'});
  });
  it('requires active entitlement and rejects a cross-tenant financial actor',async()=>{
    const f=await fixture();for(const actor of [{...f.actor,managementEntitled:false},{...f.actor,organizationId:randomUUID()}])await expect(f.reserve({},actor)).rejects.toMatchObject({code:'PX007'});
    expect(await f.counts()).toMatchObject({operations:0});
  });
  it('preserves the legacy CH rows and refuses installing a TEST binding on CH',async()=>{
    const f=await fixture();await f.reserve();await f.record();await f.write();
    await expect(result('select public.zentra_put_us_tax_provider_binding($1,$2,0,$3::uuid,$4::jsonb) result',[chOrg,chActor,randomUUID(),JSON.stringify({...f.binding,organizationId:chOrg})])).rejects.toMatchObject({code:'PX003'});
    expect(await snapshotCH()).toEqual(chBefore);expect(await sql('select * from public.zentra_us_tax_operations where organization_id=$1',[chOrg])).toEqual([]);
  });
  it.each(['expectedErpRevision','countryRevision','sellerRevision','taxFactsRevision','sourceEstimateRevision'] as const)('rejects unsafe %s before reserving a provider operation',async field=>{
    const f=await fixture(),payload=JSON.parse(f.resolved.resolvedBody);payload[field]=Number.MAX_SAFE_INTEGER;
    await expect(f.reservePayload(payload)).rejects.toMatchObject({code:'PX004'});expect(await f.counts()).toMatchObject({operations:0,counter:0});
  });
  it.each(['zeroAmount','fractionalAmount','fractionalQuantity','fractionalTaxDate','classificationNull','classificationExtra','code','expand'] as const)('rejects unsupported resolved parameters %s even with recomputed exact hashes/key',async field=>{
    const f=await fixture(),payload=JSON.parse(f.resolved.resolvedBody),line=payload.params.line_items[0];
    if(field==='zeroAmount')line.amount=0;else if(field==='fractionalAmount')line.amount=10000.5;else if(field==='fractionalQuantity')line.quantity=2.5;else if(field==='fractionalTaxDate')payload.taxDateInstant=payload.taxDateInstant.replace('Z','.001Z');else if(field==='classificationNull')payload.classifications[0].evidenceReference=null;else if(field==='classificationExtra')payload.classifications[0].granted=true;else if(field==='code')line.tax_code='generic';else payload.params.expand=['line_items'];
    await expect(f.reservePayload(payload)).rejects.toMatchObject({code:'PX004'});expect(await f.counts()).toMatchObject({operations:0,invoices:0,counter:0});
  });
  it.each(['privateJurisdiction','privateFingerprint','publicExtra','providerLineId','unknownLevel','missingState','duplicateJurisdiction','oldCalculation'] as const)('rejects malformed public/private projection %s',async field=>{
    const f=await fixture();await f.reserve();const p=structuredClone(f.proof) as Mutable<StripeTaxPrivateProof>,a=structuredClone(f.assessment) as Mutable<TaxAssessment>;
    if(field==='privateJurisdiction')a.lines=[{...a.lines[0],jurisdiction:f.facts.legalName}];else if(field==='privateFingerprint')a.fingerprint=JSON.stringify([f.facts.taxOrigin]);else if(field==='publicExtra')Object.assign(a,{privateOrigin:f.facts.taxOrigin});else if(field==='providerLineId')p.lines=[{...p.lines[0],providerLineId:'not_a_provider_line'}];else if(field==='unknownLevel')p.lines=[{...p.lines[0],breakdowns:[{...p.lines[0].breakdowns[0],jurisdiction:{...p.lines[0].breakdowns[0].jurisdiction,level:'unknown'}},p.lines[0].breakdowns[1]]}];else if(field==='missingState')p.lines=[{...p.lines[0],breakdowns:[{...p.lines[0].breakdowns[0],jurisdiction:{country:'US',level:'state',displayName:'Missing state'}},p.lines[0].breakdowns[1]]}];else if(field==='duplicateJurisdiction')p.lines=[{...p.lines[0],breakdowns:[p.lines[0].breakdowns[0],{...p.lines[0].breakdowns[1],jurisdiction:p.lines[0].breakdowns[0].jurisdiction}]}];else p.calculatedAt=new Date(new Date(f.binding.observedAt).getTime()-1).toISOString();
    await expect(f.record(p,a)).rejects.toMatchObject({code:'PX004'});expect((await f.read()).status).toBe('reserved');expect(await f.counts()).toMatchObject({invoices:0,counter:0});
  });
  it('rejects expired calculation evidence before recording it',async()=>{
    const f=await fixture();await f.reserve();const calculatedAt=new Date(Date.now()-500).toISOString(),expiresAt=new Date(Date.now()-1).toISOString();
    await expect(f.record({...f.proof,calculatedAt,expiresAt},{...f.assessment,determinedAt:calculatedAt,validUntil:expiresAt})).rejects.toMatchObject({code:'PX006'});expect((await f.read()).status).toBe('reserved');
  });
  it('refuses a calculation expiring after record and before commit without consuming an invoice number',async()=>{
    const f=await fixture();await f.reserve();const expiresAt=new Date(Date.now()+500).toISOString();await f.record({...f.proof,expiresAt},{...f.assessment,validUntil:expiresAt});
    await new Promise(resolve=>setTimeout(resolve,550));await expect(f.write()).rejects.toMatchObject({code:'PX006'});expect(await f.counts()).toMatchObject({invoices:0,journals:0,links:0,counter:0});
  });
  it.each(['estimate','erp'] as const)('rejects a newer %s revision before the provider-backed invoice transaction',async scope=>{
    const f=await fixture();await f.reserve();await f.record();
    if(scope==='erp')await f.send({type:'save_customer',customer:{id:'another-customer',organizationId:f.org,name:'Another fictitious customer',kind:'business',billingAddress:f.config.address,paymentTermsDays:30}});
    else await f.send({type:'accept_estimate',estimateId:'estimate',expectedEstimateRevision:2});
    await expect(f.write()).rejects.toMatchObject({code:'PX001'});expect(await f.counts()).toMatchObject({invoices:0,journals:0,links:0,counter:0});
  });
  it.each(['journal','audit','counter','actor','assessment'] as const)('rolls back a tampered real engine commit %s completely',async field=>{
    const f=await fixture();await f.reserve();await f.record();const commit=structuredClone(f.commit) as Mutable<ErpCommit>;
    if(field==='journal')commit.changes=commit.changes.filter(c=>c.kind!=='journal');else if(field==='audit')commit.ledgerAudit=[];else if(field==='counter')commit.header={...commit.header,counters:{...commit.header.counters,invoice:2}};else if(field==='actor')commit.actor={...commit.actor,userId:randomUUID()};else commit.changes=commit.changes.map(c=>c.kind==='invoice'?{...c,payload:{...(c.payload as Record<string,unknown>),taxAssessment:{...f.assessment,lines:[{...f.assessment.lines[0],taxMinor:'0'}]}}}:c);
    await expect(f.write(commit)).rejects.toThrow();expect(await f.counts()).toMatchObject({invoices:0,journals:0,links:0,events:4,receipts:4,counter:0});expect((await f.read()).status).toBe('calculated');
  });
  it('refuses a direct orphan issue receipt at deferred transaction completion',async()=>{
    const f=await fixture();await f.reserve();await f.record();
    await expect(sql('insert into public.zentra_us_erp_receipts(organization_id,idempotency_key,command_hash,revision,actor_id,receipt) values($1,$2,$3,5,$4,$5::jsonb)',[f.org,f.resolved.erpIdempotencyKey,f.resolved.commandHash,f.owner,JSON.stringify(f.commit.receipt)])).rejects.toThrow();expect(await f.counts()).toMatchObject({invoices:0,receipts:4,counter:0});
  });
  it('enforces RLS, invoker empty-search-path RPCs and append-only table privileges',async()=>{
    const tables=['zentra_us_tax_provider_bindings','zentra_us_tax_provider_binding_changes','zentra_us_tax_operations','zentra_us_tax_invoice_links'];
    const rows=await db.query<{name:string;rls:boolean;anon:boolean;authenticated:boolean;server:boolean;deleting:boolean}>('select relname name,relrowsecurity rls,has_table_privilege(\'anon\',c.oid,\'SELECT\') anon,has_table_privilege(\'authenticated\',c.oid,\'SELECT\') authenticated,has_table_privilege(\'service_role\',c.oid,\'SELECT\') server,has_table_privilege(\'service_role\',c.oid,\'DELETE\') deleting from pg_class c where relname=any($1::text[])',[tables]);
    expect(rows.rows).toHaveLength(4);for(const row of rows.rows)expect(row).toMatchObject({rls:true,anon:false,authenticated:false,server:true,deleting:false});
    const funcs=await db.query<{name:string;definer:boolean;config:string[];anon:boolean;authenticated:boolean;server:boolean}>('select proname name,prosecdef definer,proconfig config,has_function_privilege(\'anon\',p.oid,\'EXECUTE\') anon,has_function_privilege(\'authenticated\',p.oid,\'EXECUTE\') authenticated,has_function_privilege(\'service_role\',p.oid,\'EXECUTE\') server from pg_proc p where proname=any($1::text[])',[['zentra_read_us_tax_provider_binding','zentra_put_us_tax_provider_binding','zentra_reserve_us_tax_operation','zentra_read_us_tax_operation','zentra_record_us_tax_calculation','zentra_commit_us_tax_invoice_test']]);
    expect(funcs.rows).toHaveLength(6);for(const row of funcs.rows){expect(row).toMatchObject({definer:false,anon:false,authenticated:false,server:true});expect(row.config).toEqual(['search_path=""']);}
    for(const table of ['zentra_us_tax_provider_binding_changes','zentra_us_tax_invoice_links'])expect((await db.query<{allowed:boolean}>('select has_table_privilege(\'service_role\',$1,\'UPDATE\') allowed',[`public.${table}`])).rows[0].allowed).toBe(false);
  });
  it('reserves a real Unicode estimate beyond one MiB UTF8 within the shared UTF16 bound',async()=>{
    const f=await fixture({lineCount:100,description:'漢'.repeat(4000)});expect(f.resolved.resolvedBody.length).toBeLessThan(524288);expect(Buffer.byteLength(f.resolved.resolvedBody,'utf8')).toBeGreaterThan(1048576);
    expect((await f.reserve()).resolvedBody).toBe(f.resolved.resolvedBody);expect((await f.read()).resolvedSha256).toBe(digest(f.resolved.resolvedBody));expect(await f.counts()).toMatchObject({invoices:0,counter:0});
  });
  it.each([{text:'漢'.repeat(524288),valid:true},{text:'漢'.repeat(524289),valid:false},{text:'😀'.repeat(262144),valid:true},{text:'😀'.repeat(262144)+'a',valid:false}])('matches UTF16 body boundary ($valid) for actual PostgreSQL Unicode input',async sample=>{
    expect(await result('select public.zentra_us_tax_body_valid($1) result',[sample.text])).toBe(sample.valid);
  });
  it('pins Unicode range semantics to C regardless of the caller collation',async()=>{
    const definition=await result<string>("select pg_catalog.pg_get_functiondef('public.zentra_us_tax_body_valid(text)'::regprocedure) result",[]);
    expect(definition).toContain('p COLLATE pg_catalog."C"');
    expect(await result('select public.zentra_us_tax_body_valid($1 COLLATE pg_catalog."POSIX") result',['😀'.repeat(262144)])).toBe(true);
    expect(await result('select public.zentra_us_tax_body_valid($1 COLLATE pg_catalog."POSIX") result',['😀'.repeat(262144)+'a'])).toBe(false);
  });
  it.each(['standard_rated','zero_rated','product_exempt','not_subject_to_tax'] as const)('admits explicit zero proof reason %s only with matching zero amounts',async reason=>{
    const f=await fixture({taxMinor:'0'});await f.reserve();const p=structuredClone(f.proof) as Mutable<StripeTaxPrivateProof>;p.lines[0].breakdowns[0].taxabilityReason=reason;await f.record(p);await f.write();expect((await f.store.read(f.org))!.invoices[0].tax.minorUnits).toBe('0');expect(await f.counts()).toMatchObject({invoices:1,journals:1,counter:1});
  });
});
