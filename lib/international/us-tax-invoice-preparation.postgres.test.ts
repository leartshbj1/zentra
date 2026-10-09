import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import type { FinancialAuthority } from './accounting/ledger';
import { canonicalErpJson, executeErp } from './runtime';
import { createSupabaseErpStore } from './runtime-store';
import type { ErpCommand, ErpCommit } from './runtime-types';
import { prepareStripeTaxResolvedRequest, type ResolvedStripeTaxRequest } from './stripe-tax-resolved-request';
import { validateStripeTaxCalculation, type StripeTaxCalculationObservation } from './stripe-tax-calculation';
import { createUsTaxFinancialContextReader } from './us-tax-financial-context';
import { createSupabaseUsTaxMerchantStore } from './us-tax-merchant-store';
import { createSupabaseUsTaxInvoicePreparationStore } from './us-tax-invoice-preparation-store';
import { createSupabasePreparedUsTaxOperationStore } from './us-tax-prepared-operation-store';
import { executeUsTaxInvoiceTest } from './us-tax-invoice';
import type { CompanyConfiguration } from './types';

// Real local SQL/engine/stores, explicitly synthetic TEST observations only.
// No key, real catalogue, network, hosted Auth/D1 or provider call is used.
const directory = process.env.PGLITE_MODULE_DIR, enabled = Boolean(directory && isAbsolute(directory));
type Sql = { exec(sql: string): Promise<unknown>; query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> };
type Db = Sql & { transaction<T>(task: (sql: Sql) => Promise<T>): Promise<T>; close(): Promise<void> };
let db: Db;
const migration = '20261009224607_international_us_tax_invoice_preparation', digest = (value: string) => createHash('sha256').update(value).digest('hex');
const names: Record<string, string[]> = {
  zentra_read_us_erp_v4: ['p_organization'], zentra_us_erp_receipt_v4: ['p_organization', 'p_idempotency_key'],
  zentra_commit_us_erp: ['p_organization', 'p_expected_revision', 'p_header', 'p_changes', 'p_ledger_audit', 'p_receipt', 'p_actor'],
  zentra_read_us_seller_profile: ['p_organization'], zentra_read_us_tax_profile: ['p_organization'], zentra_read_us_tax_provider_binding: ['p_organization'],
  zentra_read_us_tax_merchant_context: ['p_organization', 'p_actor'], zentra_read_us_tax_merchant_credential: ['p_organization', 'p_actor', 'p_binding_revision'],
  zentra_activate_us_tax_test_merchant: ['p_organization', 'p_actor', 'p_request_id', 'p_context', 'p_credential', 'p_configuration_fingerprint', 'p_observation', 'p_valid_until'],
  zentra_read_us_tax_invoice_preparation: ['p_organization', 'p_actor', 'p_erp_idempotency_key', 'p_command_hash', 'p_supported_schema_version'],
  zentra_create_us_tax_invoice_preparation: ['p_organization', 'p_actor', 'p_preparation_body', 'p_preparation_sha256', 'p_supported_schema_version'],
  zentra_read_us_tax_operation: ['p_organization', 'p_erp_idempotency_key', 'p_command_hash', 'p_actor'],
  zentra_reserve_us_tax_operation: ['p_organization', 'p_actor', 'p_operation_id', 'p_resolved_body', 'p_resolved_sha256', 'p_params_body', 'p_params_sha256', 'p_provider_idempotency_key'],
  zentra_reserve_us_tax_prepared_operation: ['p_organization', 'p_actor', 'p_operation_id', 'p_resolved_body', 'p_resolved_sha256', 'p_params_body', 'p_params_sha256', 'p_provider_idempotency_key', 'p_supported_schema_version'],
  zentra_record_us_tax_calculation: ['p_organization', 'p_operation_id', 'p_actor', 'p_proof_body', 'p_proof_sha256', 'p_assessment'],
  zentra_record_us_tax_prepared_calculation: ['p_organization', 'p_operation_id', 'p_actor', 'p_proof_body', 'p_proof_sha256', 'p_assessment', 'p_supported_schema_version'],
  zentra_commit_us_tax_invoice_test_v2: ['p_organization', 'p_operation_id', 'p_expected_revision', 'p_header', 'p_changes', 'p_ledger_audit', 'p_receipt', 'p_actor', 'p_supported_schema_version'],
  zentra_commit_us_tax_prepared_invoice_test: ['p_organization', 'p_operation_id', 'p_expected_revision', 'p_header', 'p_changes', 'p_ledger_audit', 'p_receipt', 'p_actor', 'p_supported_schema_version'],
};
const sql = <T = Record<string, unknown>>(query: string, values: unknown[] = [], role = 'service_role') => db.transaction(async tx => { await tx.exec(`set local role ${role}`); return (await tx.query<T>(query, values)).rows; });
const client = {
  async rpc<T>(name: string, input: Record<string, unknown>): Promise<T> {
    if (!Object.hasOwn(names, name)) throw Error('Unexpected TEST RPC');
    try { return (await sql<{ result: T }>(`select public.${name}(${names[name].map((_, i) => `$${i + 1}`).join(',')}) result`, names[name].map(k => input[k])))[0].result; }
    catch (e) { if (process.env.ZENTRA_LOCAL_SQL_DEBUG === '1') console.error('TEST SQL', name, (e as { code?: string }).code, (e as Error).message, (e as { where?: string }).where); throw new SupabaseServerError(503, (e as { code?: string }).code ?? 'TEST-rpc'); }
  },
  async select<T>(table: string, query: Record<string, string>): Promise<T> {
    if (table !== 'zentra_workspace_country_configs' || !query.organization_id.startsWith('eq.')) throw Error('Unexpected TEST read');
    return await sql('select organization_id,schema_version,config,country,currency,revision,updated_by,to_char(updated_at at time zone \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') updated_at from public.zentra_workspace_country_configs where organization_id=$1', [query.organization_id.slice(3)]) as T;
  },
} as Pick<SupabaseServerClient, 'rpc' | 'select'>;
const snapshot = (org: string) => sql(`select (select to_jsonb(h) from public.zentra_us_erp_heads h where organization_id=$1) head,
  (select jsonb_agg(to_jsonb(r) order by kind,id) from public.zentra_us_erp_records r where organization_id=$1) records,
  (select jsonb_agg(to_jsonb(e) order by revision) from public.zentra_us_erp_events e where organization_id=$1) events,
  (select jsonb_agg(to_jsonb(p) order by erp_idempotency_key) from public.zentra_us_tax_invoice_preparations p where organization_id=$1) preparations,
  (select jsonb_agg(to_jsonb(o) order by operation_id) from public.zentra_us_tax_operations o where organization_id=$1) operations,
  (select jsonb_agg(to_jsonb(l) order by operation_id) from public.zentra_us_tax_prepared_operation_links l where organization_id=$1) links`, [org]);
function observation(resolved: ResolvedStripeTaxRequest): StripeTaxCalculationObservation {
  const now = new Date().toISOString(), amount = resolved.params.line_items[0].amount, tax = 160;
  return { accountId: resolved.binding.accountId, mode: 'test', apiVersion: resolved.binding.apiVersion, evidenceKind: 'provider_observation', observedAt: now,
    calculation: { id: 'taxcalc_FictitiousPrepared', object: 'tax.calculation', amount_total: amount + tax, currency: 'usd', customer: null,
      customer_details: { address: { ...resolved.params.customer_details.address, line2: null }, address_source: resolved.params.customer_details.address_source, ip_address: null, tax_ids: [], taxability_override: 'none' },
      expires_at: Math.floor(Date.parse(now) / 1000) + 1800, tax_date: resolved.params.tax_date, livemode: false, shipping_cost: null, ship_from_details: null, tax_amount_exclusive: tax, tax_amount_inclusive: 0,
      line_items: { object: 'list', has_more: false, url: '/v1/tax/calculations/taxcalc_FictitiousPrepared/line_items', data: [{ id: 'tax_li_FictitiousPrepared', object: 'tax.calculation_line_item', amount, amount_tax: tax, quantity: resolved.params.line_items[0].quantity, reference: 'line', tax_code: resolved.params.line_items[0].tax_code, tax_behavior: 'exclusive', livemode: false, product: null,
        tax_breakdown: [{ amount: tax, taxable_amount: amount, taxability_reason: 'standard_rated', sourcing: 'destination', jurisdiction: { country: 'US', state: 'NY', level: 'state', display_name: 'Fictitious TEST state' }, tax_rate_details: { tax_type: 'sales_tax', display_name: 'Fictitious TEST tax', percentage_decimal: '8.0' } }] }] },
      tax_breakdown: [{ amount: tax, taxable_amount: amount, taxability_reason: 'standard_rated', inclusive: false, tax_rate_details: { country: 'US', state: 'NY', tax_type: 'sales_tax', percentage_decimal: '8.0', rate_type: 'percentage', flat_amount: null } }],
    },
  };
}
async function fixture(options: { prepare?: boolean; role?: 'owner' | 'admin' | 'accountant'; ttl?: number; alternativePeriod?: boolean } = {}) {
  const org = randomUUID(), userId = randomUUID(), owner: FinancialAuthority = { organizationId: org, userId, role: 'owner', managementEntitled: true, timestamp: new Date().toISOString() };
  const now = () => new Date().toISOString(), actor: FinancialAuthority = { ...owner, role: options.role ?? 'owner', userId: options.role && options.role !== 'owner' ? randomUUID() : userId };
  const revalidate = async () => ({ ...actor, timestamp: now() });
  const config: CompanyConfiguration = { schemaVersion: 1, organizationId: org, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York', address: { country: 'US', line1: '1 Fictitious Public Street', city: 'New York', subdivision: 'NY', postalCode: '10001' }, accountingBasis: 'accrual', invoiceNumberPrefix: 'TEST', taxConfiguration: { status: 'unconfigured' } };
  await sql('select public.zentra_admit_new_us_workspace_v1($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::jsonb,$6)', [org, randomUUID(), userId, randomUUID(), config, digest(org)]);
  const seller = { displayName: 'Fictitious TEST Seller' }, facts = { schemaVersion: 1, legalName: 'PRIVATE_FICTITIOUS_TEST_NAME', timeZone: config.timeZone, taxOrigin: { ...config.address, line1: '9 Fictitious Private Origin' } };
  await sql('select public.zentra_put_us_seller_profile($1,$2,0,$3::uuid,$4::jsonb)', [org, userId, randomUUID(), seller]);
  await sql('select public.zentra_put_us_tax_profile($1,$2,0,$3::uuid,$4::jsonb)', [org, userId, randomUUID(), facts]);
  const merchants = createSupabaseUsTaxMerchantStore(client), captured = await merchants.readContext(owner), observedAt = new Date(Date.now() - 10).toISOString();
  const merchant = { credential: { reference: 'TEST-credential', revision: 1, accountId: 'acct_FictitiousPrepared' }, configurationFingerprint: digest('TEST-descriptor') };
  const admitted = await merchants.activate(owner, { requestId: randomUUID(), context: captured, ...merchant, observation: { organizationId: org, accountId: merchant.credential.accountId, mode: 'test', apiVersion: '2026-08-26.dahlia', settingsSha256: digest('TEST-settings'), registrationsSha256: digest('TEST-registrations'), observedAt, taxOrigin: facts.taxOrigin }, validUntil: new Date(Date.parse(observedAt) + (options.ttl ?? 119_000)).toISOString() });
  const configuration = { ...config, taxConfiguration: { status: 'configured' as const } }, erp = createSupabaseErpStore(client, { supportedSchemaVersion: 4 });
  const bootstrap = { store: erp, configuration, actor: owner, revalidate: async () => ({ ...owner, timestamp: now() }), taxProvider: async () => null };
  let sequence = 0;
  const send = async (command: ErpCommand) => executeErp(bootstrap, { idempotencyKey: 'bootstrap-' + ++sequence, expectedRevision: (await erp.read(org))?.revision ?? 0, command });
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()), year = day.slice(0, 4);
  const nextYear = (Number(year) + 1).toString();
  await send({ type: 'initialize', periods: [{ id: 'year', start: year + '-01-01', end: year + '-12-31', status: 'open' }, ...(options.alternativePeriod ? [{ id: 'next-year', start: nextYear + '-01-01', end: nextYear + '-12-31', status: 'open' as const }] : [])] });
  await send({ type: 'save_customer', customer: { id: 'customer', organizationId: org, name: 'Fictitious TEST Customer', kind: 'business', billingAddress: config.address, paymentTermsDays: 30 } });
  await send({ type: 'save_estimate', id: 'estimate', expectedEstimateRevision: 0, customerId: 'customer', date: day, expiresAt: year + '-12-31', paymentTermsDays: 30, lines: [{ id: 'line', description: 'Fictitious TEST classified service', quantityUnits: '2', quantityScale: 0, unitPrice: { currency: 'USD', minorUnits: '1000' }, discountBasisPoints: 0, taxTreatment: 'taxable' }], notes: 'Synthetic local TEST only' });
  await send({ type: 'accept_estimate', estimateId: 'estimate', expectedEstimateRevision: 1 });
  const request = { idempotencyKey: 'TEST-invoice', expectedRevision: 4, command: { type: 'issue_invoice' as const, id: 'invoice', estimateId: 'estimate', expectedEstimateRevision: 2, date: day, accountingDate: day, dueDate: day, periodId: 'year' } };
  const contexts = createUsTaxFinancialContextReader(client, { revalidate, now }), context = await contexts.read(await revalidate()), estimate = (await erp.read(org))!.estimates[0];
  const create = { request, context, merchant, estimate, classifications: [{ lineId: 'line', taxCode: 'txcd_99999999', kind: 'service' as const, taxBehavior: 'exclusive' as const }], taxDateInstant: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(), addressSource: 'billing' as const };
  const preparations = createSupabaseUsTaxInvoicePreparationStore(client, { supportedSchemaVersion: 4 }), prepared = options.prepare === false ? null : await preparations.create(actor, create), operations = createSupabasePreparedUsTaxOperationStore(client, { supportedSchemaVersion: 4 });
  const calculate = vi.fn(async (resolved: ResolvedStripeTaxRequest) => observation(resolved));
  const dependencies = { erp: { store: erp, configuration, actor, revalidate }, contexts, operations, gateway: { verify: vi.fn(async () => undefined), calculate }, classifications: async () => prepared!.classifications, transactionLocation: async () => ({ taxDateInstant: prepared!.taxDateInstant, addressSource: prepared!.addressSource }), operationId: () => randomUUID(), now };
  const resolved = async (extra: Partial<ResolvedStripeTaxRequest> = {}) => prepareStripeTaxResolvedRequest({ organizationId: org, operationId: randomUUID(), invoiceId: request.command.id, actorUserId: actor.userId, erpIdempotencyKey: request.idempotencyKey, commandHash: prepared?.commandHash ?? digest(canonicalErpJson([org, actor.userId, request])), expectedErpRevision: 4, countryRevision: context.countryRevision, sellerRevision: context.sellerRevision, taxFactsRevision: context.taxFactsRevision, configuration, estimate, taxFacts: context.taxFacts, binding: context.binding, classifications: prepared?.classifications ?? [{ ...create.classifications[0], revision: 1, evidenceReference: 'unprepared TEST' }], invoiceDate: day, taxDateInstant: create.taxDateInstant, taxDatePolicy: 'caller_supplied_invoice_instant', addressSource: create.addressSource, now: now(), ...extra });
  async function mutate(kind: string) {
    if (kind === 'country') await sql('select public.zentra_put_workspace_country_config($1,$2,2,$3::uuid,$4::jsonb)', [org, userId, randomUUID(), { ...configuration, language: 'fr' }]);
    if (kind === 'seller') await sql('select public.zentra_put_us_seller_profile($1,$2,1,$3::uuid,$4::jsonb)', [org, userId, randomUUID(), { displayName: 'Changed TEST Seller' }]);
    if (kind === 'facts') await sql('select public.zentra_put_us_tax_profile($1,$2,1,$3::uuid,$4::jsonb)', [org, userId, randomUUID(), { ...facts, legalName: 'CHANGED_FICTITIOUS_NAME' }]);
    if (kind === 'binding' || kind === 'credential') await sql('select public.zentra_put_us_tax_provider_binding($1,$2,1,$3::uuid,$4::jsonb)', [org, userId, randomUUID(), { ...admitted.binding, revision: 2 }]);
    if (kind === 'erp') await send({ type: 'save_customer', customer: { id: 'other', organizationId: org, name: 'Other TEST customer', kind: 'business', billingAddress: config.address, paymentTermsDays: 30 } });
    if (kind === 'estimate') {
      await send({ type: 'save_estimate', id: estimate.id, expectedEstimateRevision: estimate.revision, customerId: estimate.customer.id, date: estimate.date, expiresAt: estimate.expiresAt, paymentTermsDays: estimate.paymentTermsDays, lines: estimate.lines, notes: 'Changed TEST estimate after review' });
      await send({ type: 'accept_estimate', estimateId: estimate.id, expectedEstimateRevision: estimate.revision + 1 });
    }
  }
  return { org, actor, owner, request, create, prepared, preparations, operations, dependencies, resolved, mutate, send, erp, calculate, now, context };
}
const reserveParameters = (actor: FinancialAuthority, r: ResolvedStripeTaxRequest) => ({ p_organization: actor.organizationId, p_actor: actor, p_operation_id: r.operationId, p_resolved_body: r.resolvedBody, p_resolved_sha256: r.resolvedSha256, p_params_body: r.paramsBody, p_params_sha256: r.paramsSha256, p_provider_idempotency_key: r.idempotencyKey });
const commitParameters = (op: string, c: ErpCommit) => ({ p_organization: c.organizationId, p_operation_id: op, p_expected_revision: c.expectedRevision, p_header: c.header, p_changes: c.changes, p_ledger_audit: c.ledgerAudit, p_receipt: c.receipt, p_actor: c.actor, p_supported_schema_version: 4 });
const chOrg = randomUUID(), chUser = randomUUID(); let chBefore: unknown;
describe.skipIf(!enabled)('immutable US TEST invoice preparations through real PostgreSQL', () => {
  beforeAll(async () => {
    const { PGlite } = createRequire(import.meta.url)(join(directory!, 'dist/index.cjs')) as { PGlite: new () => Db }; db = new PGlite();
    await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);grant usage on schema public to service_role;');
    for (const name of ['202609140100_company_profiles', '202609140200_company_collaboration', '202609200300_company_content', '20261007194528_international_workspace_country_config', '20261007222349_international_us_erp_persistence', '20261007224820_international_us_erp_delta_stream', '20261007225725_international_us_erp_seller_snapshot', '20261008001726_new_us_workspace_admission', '20261008013200_international_tax_proof_allowlist', '20261008034422_international_us_seller_profile', '20261008044402_international_us_tax_profile', '20261008060826_international_us_tax_operations', '20261008081825_international_us_purchasing_v2', '20261008105120_international_us_projects_v3', '20261008161118_international_us_journal_periods_v4', '20261008172520_international_us_tax_invoice_capability_v2', '20261009222319_international_us_tax_test_merchant', migration]) {
      try { await db.exec(await readFile(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), 'utf8')); }
      catch (e) { const error = e as { position?: string; internalPosition?: string; internalQuery?: string; where?: string }; console.error('TEST migration', name, error.position, error.internalPosition, error.internalQuery?.slice(-600), error.where); throw e; }
    }
    await db.query('insert into public.zentra_workspaces(organization_id,updated_by) values($1,$2)', [chOrg, chUser]);
    await db.query('select public.zentra_put_workspace_country_config($1,$2,0,$3::uuid,$4::jsonb)', [chOrg, chUser, randomUUID(), { schemaVersion: 1, organizationId: chOrg, country: 'CH', currency: 'CHF', language: 'fr', timeZone: 'Europe/Zurich', address: { country: 'CH', line1: '1 Rue Fictive', city: 'Genève', subdivision: 'GE', postalCode: '1201' }, accountingBasis: 'accrual', invoiceNumberPrefix: 'CH', taxConfiguration: { status: 'unconfigured' } }]);
    chBefore = (await db.query('select to_jsonb(w) workspace,to_jsonb(c) country from public.zentra_workspaces w join public.zentra_workspace_country_configs c using(organization_id) where organization_id=$1', [chOrg])).rows;
  }, 60_000);
  afterAll(async () => { await db?.close(); });
  it.each(['owner', 'admin', 'accountant'] as const)('issues prepared %s invoice once with exact SQL link, private proof and balanced journal', async role => {
    const f = await fixture({ role }), response = await executeUsTaxInvoiceTest(f.dependencies, f.request);
    expect(response).toMatchObject({ replayed: false, receipt: { action: 'issue_invoice', revision: 5 } });
    const state = (await f.erp.read(f.org))!; expect(state.invoices).toHaveLength(1); expect(state.invoices[0].total.minorUnits).toBe('2160'); expect(state.ledger.entries).toHaveLength(1);
    const before = await snapshot(f.org); expect((await executeUsTaxInvoiceTest(f.dependencies, f.request)).replayed).toBe(true); expect(await snapshot(f.org)).toEqual(before); expect(f.calculate).toHaveBeenCalledTimes(1);
  });
  it('replays immutable preparation exactly and rejects changed choice, actor, hash or command under its key', async () => {
    const f = await fixture(), before = await snapshot(f.org);
    expect(await f.preparations.read(f.actor, f.request)).toEqual(f.prepared); expect(await f.preparations.create(f.actor, f.create)).toEqual(f.prepared);
    await expect(f.preparations.create(f.actor, { ...f.create, taxDateInstant: new Date(Date.parse(f.create.taxDateInstant) + 1000).toISOString() })).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(f.preparations.read({ ...f.actor, userId: randomUUID() }, f.request)).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(f.preparations.read(f.actor, { ...f.request, command: { ...f.request.command, id: 'other' } })).rejects.toMatchObject({ code: 'idempotency_conflict' });
    const { preparedAt: _time, preparationSha256: _sha, ...body } = f.prepared!;
    for (const changed of [{ ...body, commandHash: digest('forged') }, { ...body, estimateSha256: digest('forged') }]) await expect(client.rpc('zentra_create_us_tax_invoice_preparation', { p_organization: f.org, p_actor: f.actor, p_preparation_body: canonicalErpJson(changed), p_preparation_sha256: digest(canonicalErpJson(changed)), p_supported_schema_version: 4 })).rejects.toMatchObject({ code: 'PF004' });
    expect(await snapshot(f.org)).toEqual(before);
  });
  it('rejects every stale durable context or book at preparation creation without writes', async () => {
    for (const kind of ['country', 'seller', 'facts', 'binding', 'credential', 'erp', 'estimate']) {
      const f = await fixture({ prepare: false }); await f.mutate(kind); const before = await snapshot(f.org);
      await expect(f.preparations.create(f.actor, f.create)).rejects.toMatchObject({ code: 'tax_preparation_changed' }); expect(await snapshot(f.org)).toEqual(before);
    }
  });
  it('fences every stale durable context/book at reserve and rejects a second operation id under the same key', async () => {
    for (const kind of ['country', 'seller', 'facts', 'binding', 'credential', 'erp', 'estimate']) {
      const f = await fixture(), r = await f.resolved(); await f.mutate(kind); const before = await snapshot(f.org);
      await expect(f.operations.reserve(f.actor, r)).rejects.toMatchObject({ status: 409 }); expect(await snapshot(f.org)).toEqual(before);
    }
    const f = await fixture(), r = await f.resolved(); await f.operations.reserve(f.actor, r); const before = await snapshot(f.org);
    await expect(f.operations.reserve(f.actor, await f.resolved())).rejects.toMatchObject({ code: 'tax_operation_conflict' }); expect(await snapshot(f.org)).toEqual(before);
  });
  it('rejects unlinked observed operations through legacy reserve and forged linked inputs at transaction completion', async () => {
    const f = await fixture(), r = await f.resolved(), before = await snapshot(f.org);
    await expect(client.rpc('zentra_reserve_us_tax_operation', reserveParameters(f.actor, r))).rejects.toMatchObject({ code: 'PF003' }); expect(await snapshot(f.org)).toEqual(before);
    const forged = await f.resolved({ classifications: [{ ...f.prepared!.classifications[0], taxCode: 'txcd_10000000' }] });
    await expect(db.transaction(async tx => {
      await tx.exec('set local role service_role');
      await tx.query('select public.zentra_reserve_us_tax_operation($1,$2,$3,$4,$5,$6,$7,$8)', Object.values(reserveParameters(f.actor, forged)));
      await tx.query('insert into public.zentra_us_tax_prepared_operation_links values($1,$2,$3,$4)', [f.org, forged.operationId, f.request.idempotencyKey, f.prepared!.preparationSha256]);
    })).rejects.toMatchObject({ code: 'PF001' }); expect(await snapshot(f.org)).toEqual(before);
  });
  it('fences changes during proof recording, including attempts through the legacy record RPC', async () => {
    for (const kind of ['country', 'seller', 'facts', 'binding', 'erp', 'estimate']) {
      const f = await fixture(), r = await f.resolved(), proof = await validateStripeTaxCalculation(r, observation(r), f.now()); await f.operations.reserve(f.actor, r); await f.mutate(kind); const before = await snapshot(f.org);
      await expect(f.operations.record(f.actor, r, proof)).rejects.toMatchObject({ code: 'tax_preparation_changed' });
      await expect(client.rpc('zentra_record_us_tax_calculation', { p_organization: f.org, p_operation_id: r.operationId, p_actor: f.actor, p_proof_body: proof.proofBody, p_proof_sha256: proof.proofSha256, p_assessment: proof.assessment })).rejects.toMatchObject({ code: 'PF001' });
      expect(await snapshot(f.org)).toEqual(before);
    }
  });
  it('fences a late commit change through protected and legacy SQL without invoice effects', async () => {
    for (const kind of ['country', 'seller', 'facts', 'binding', 'erp', 'estimate']) {
      const f = await fixture(); let candidate: ErpCommit | undefined, operationId = '';
      await expect(executeUsTaxInvoiceTest({ ...f.dependencies, operations: { ...f.operations, async commit(id, input) { candidate = input; operationId = id; throw Error('TEST stop before commit'); } } }, f.request)).rejects.toMatchObject({ status: 503 });
      expect(candidate).toBeDefined(); await f.mutate(kind); const before = await snapshot(f.org);
      await expect(f.operations.commit(operationId, candidate!)).rejects.toMatchObject({ code: 'tax_preparation_changed' });
      await expect(client.rpc('zentra_commit_us_tax_invoice_test_v2', commitParameters(operationId, candidate!))).rejects.toMatchObject({ code: 'PX001' }); expect(await snapshot(f.org)).toEqual(before);
    }
  });
  it.each(['dueDate', 'accountingDate', 'periodId'] as const)('rejects a coherent but unreviewed %s through prepared and legacy commits', async field => {
    const f = await fixture({ alternativePeriod: true }); let candidate: ErpCommit | undefined, operationId = '';
    await expect(executeUsTaxInvoiceTest({ ...f.dependencies, operations: { ...f.operations, async commit(id, input) { candidate = input; operationId = id; throw Error('TEST stop before commit'); } } }, f.request)).rejects.toMatchObject({ status: 503 });
    expect(candidate).toBeDefined(); const forged = structuredClone(candidate!);
    const plusDay = new Date(Date.parse(f.request.command.date + 'T12:00:00Z') + 86_400_000).toISOString().slice(0, 10);
    const nextYear = (Number(f.request.command.date.slice(0, 4)) + 1).toString() + '-01-01';
    const accountingDate = field === 'periodId' ? nextYear : plusDay.slice(0, 4) === f.request.command.date.slice(0, 4) ? plusDay : new Date(Date.parse(f.request.command.date + 'T12:00:00Z') - 86_400_000).toISOString().slice(0, 10);
    for (const change of forged.changes) {
      const payload = change.payload as unknown as Record<string, unknown>;
      if (change.kind === 'invoice') { if (field === 'dueDate') payload.dueDate = plusDay; else payload.accountingDate = accountingDate; }
      if (change.kind === 'journal' && field !== 'dueDate') {
        payload.accountingDate = accountingDate; if (field === 'periodId') payload.periodId = 'next-year';
        const source = payload.source as Record<string, unknown>, lines = payload.lines as Record<string, unknown>[];
        payload.fingerprint = canonicalErpJson([f.org, 'USD', payload.basis, payload.transactionDate, payload.accountingDate, payload.paymentDate, payload.periodId, payload.description, source.type, source.id, payload.cashFlowCategory, payload.reversesEntryId, lines.map(line => [line.accountId, line.debitMinor, line.creditMinor, line.description])]);
      }
    }
    const before = await snapshot(f.org);
    await expect(f.operations.commit(operationId, forged)).rejects.toMatchObject({ code: 'tax_preparation_changed' }); expect(await snapshot(f.org)).toEqual(before);
    await expect(client.rpc('zentra_commit_us_tax_invoice_test_v2', commitParameters(operationId, forged))).rejects.toMatchObject({ code: 'PF001' }); expect(await snapshot(f.org)).toEqual(before);
    // Refusal leaves the original exact request usable, with no new calculation.
    expect(await f.operations.commit(operationId, candidate!)).toEqual(candidate!.receipt); expect(f.calculate).toHaveBeenCalledTimes(1);
    const committed = await snapshot(f.org); expect(await f.operations.commit(operationId, candidate!)).toEqual(candidate!.receipt); expect(await snapshot(f.org)).toEqual(committed);
  });
  it('preserves preparation and committed historical replay after binding renewal without another provider call', async () => {
    const f = await fixture(); await executeUsTaxInvoiceTest(f.dependencies, f.request); await f.mutate('binding'); const before = await snapshot(f.org);
    expect(await f.preparations.read(f.actor, f.request)).toEqual(f.prepared); expect(await f.preparations.create(f.actor, f.create)).toEqual(f.prepared);
    expect((await executeUsTaxInvoiceTest({ ...f.dependencies, contexts: { read: async () => { throw Error('must not read current binding'); } } }, f.request)).replayed).toBe(true);
    expect(f.calculate).toHaveBeenCalledTimes(1); expect(await snapshot(f.org)).toEqual(before);
  });
  it('replays exact preparation and committed invoice after its originally captured binding really expires', async () => {
    const f = await fixture({ ttl: 1500 }); await executeUsTaxInvoiceTest(f.dependencies, f.request);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(f.context.binding.validUntil) - Date.now() + 20)));
    expect(Date.parse(f.context.binding.validUntil)).toBeLessThan(Date.now()); const before = await snapshot(f.org);
    expect(await f.preparations.read(f.actor, f.request)).toEqual(f.prepared); expect(await f.preparations.create(f.actor, f.create)).toEqual(f.prepared);
    expect((await executeUsTaxInvoiceTest({ ...f.dependencies, contexts: { read: async () => { throw Error('expired binding must not be read on replay'); } } }, f.request)).replayed).toBe(true);
    expect(f.calculate).toHaveBeenCalledTimes(1); expect(await snapshot(f.org)).toEqual(before);
  });
  it('enforces financial authority, tenant isolation, capability, RLS and immutable private tables', async () => {
    const f = await fixture();
    for (const actor of [{ ...f.actor, role: 'member' }, { ...f.actor, managementEntitled: false }]) await expect(f.preparations.read(actor as FinancialAuthority, f.request)).rejects.toMatchObject({ status: actor.managementEntitled ? 403 : 402 });
    const other = await fixture({ prepare: false }); expect(await other.preparations.read(other.actor, f.request)).toBeNull();
    await expect(createSupabaseUsTaxInvoicePreparationStore(client, { supportedSchemaVersion: 1 }).read(f.actor, f.request)).rejects.toMatchObject({ code: 'client_upgrade_required' });
    for (const role of ['anon', 'authenticated']) {
      for (const table of ['zentra_us_tax_invoice_preparations', 'zentra_us_tax_prepared_operation_links']) await expect(sql(`select * from public.${table}`, [], role)).rejects.toMatchObject({ code: '42501' });
      await expect(sql('select public.zentra_read_us_tax_invoice_preparation($1,$2,$3,$4,4)', [f.org, f.actor, f.request.idempotencyKey, f.prepared!.commandHash], role)).rejects.toMatchObject({ code: '42501' });
    }
    for (const command of ['update public.zentra_us_tax_invoice_preparations set actor_id=actor_id', 'delete from public.zentra_us_tax_invoice_preparations', 'truncate public.zentra_us_tax_prepared_operation_links,public.zentra_us_tax_invoice_preparations']) await expect(db.exec(command)).rejects.toMatchObject({ code: 'PF007' });
    const functions = (await db.query<{ prosecdef: boolean; proconfig: string[] }>('select prosecdef,proconfig from pg_proc where pronamespace=\'public\'::regnamespace and proname=any($1::text[])', [['zentra_read_us_tax_invoice_preparation', 'zentra_create_us_tax_invoice_preparation', 'zentra_reserve_us_tax_prepared_operation', 'zentra_record_us_tax_prepared_calculation', 'zentra_commit_us_tax_prepared_invoice_test']])).rows;
    expect(functions).toHaveLength(5); for (const row of functions) { expect(row.prosecdef).toBe(false); expect(row.proconfig).toContain('search_path=""'); }
  });
  it('keeps CH state byte-equivalent after all US preparation/issuance cases', async () => {
    expect((await db.query('select to_jsonb(w) workspace,to_jsonb(c) country from public.zentra_workspaces w join public.zentra_workspace_country_configs c using(organization_id) where organization_id=$1', [chOrg])).rows).toEqual(chBefore);
  });
});
