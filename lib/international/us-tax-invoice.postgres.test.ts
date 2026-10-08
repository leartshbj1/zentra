import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { AccountPublicError } from '../account-security';
import { SupabaseServerClient } from '../supabase-server';
import type { FinancialAuthority } from './accounting/ledger';
import { validateCompanyConfiguration } from './country-config';
import { buildTaxRequest } from './invoicing';
import { publicErpDelta, publicErpState } from './public-projection';
import { executeErp } from './runtime';
import { createSupabaseErpStore } from './runtime-store';
import { createSupabaseErpSyncStore } from './runtime-sync-store';
import { STRIPE_TAX_API_VERSION, validateResolvedStripeTaxRequest, type ResolvedStripeTaxRequest, type StripeTaxTestBinding } from './stripe-tax-resolved-request';
import type { StripeTaxCalculationObservation } from './stripe-tax-calculation';
import type { ErpCommand } from './runtime-types';
import { createUsTaxFinancialContextReader } from './us-tax-financial-context';
import { executeUsTaxInvoiceTest, type UsTaxInvoiceTestDependencies } from './us-tax-invoice';
import { createSupabaseUsTaxOperationStore } from './us-tax-operation-store';
import type { UsTaxFacts } from './us-tax-profile';

// Explicit local opt-in: the real issuer, engine, readers and RPC ports use the
// real migration chain in one serialized RAM PGlite PostgreSQL connection.
// The HTTP/PostgREST transport, Auth/D1 and TEST gateway are synthetic fixtures.
// No actual Stripe, network, credentials, hosted SQL, restart/crash, concurrent
// connections, production authority or general tax-compliance evidence.
const moduleDirectory = process.env.PGLITE_MODULE_DIR;
const enabled = Boolean(moduleDirectory && isAbsolute(moduleDirectory));
type Sql = { exec(sql: string): Promise<unknown>; query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> };
type Database = Sql & { transaction<T>(task: (sql: Sql) => Promise<T>): Promise<T>; close(): Promise<void> };
let db: Database;
const digest = (body: string) => createHash('sha256').update(body, 'utf8').digest('hex');
const serviceSql = <T = Record<string, unknown>>(query: string, values: unknown[] = []) => db.transaction(async tx => {
  await tx.exec('set local role service_role'); return (await tx.query<T>(query, values)).rows;
});
const result = async <T = unknown>(query: string, values: unknown[]) => (await serviceSql<{ result: T }>(query, values))[0].result;
const rpcQueries: Record<string, { sql: string; keys: string[] }> = {
  zentra_read_us_erp: { sql: 'select public.zentra_read_us_erp($1) result', keys: ['p_organization'] },
  zentra_us_erp_receipt: { sql: 'select public.zentra_us_erp_receipt($1,$2) result', keys: ['p_organization', 'p_idempotency_key'] },
  zentra_commit_us_erp: { sql: 'select public.zentra_commit_us_erp($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb) result', keys: ['p_organization', 'p_expected_revision', 'p_header', 'p_changes', 'p_ledger_audit', 'p_receipt', 'p_actor'] },
  zentra_us_erp_delta: { sql: 'select public.zentra_us_erp_delta($1,$2,$3) result', keys: ['p_organization', 'p_after_revision', 'p_limit'] },
  zentra_read_us_seller_profile: { sql: 'select public.zentra_read_us_seller_profile($1) result', keys: ['p_organization'] },
  zentra_read_us_tax_profile: { sql: 'select public.zentra_read_us_tax_profile($1) result', keys: ['p_organization'] },
  zentra_read_us_tax_provider_binding: { sql: 'select public.zentra_read_us_tax_provider_binding($1) result', keys: ['p_organization'] },
  zentra_read_us_tax_operation: { sql: 'select public.zentra_read_us_tax_operation($1,$2,$3,$4::jsonb) result', keys: ['p_organization', 'p_erp_idempotency_key', 'p_command_hash', 'p_actor'] },
  zentra_reserve_us_tax_operation: { sql: 'select public.zentra_reserve_us_tax_operation($1,$2::jsonb,$3::uuid,$4,$5,$6,$7,$8) result', keys: ['p_organization', 'p_actor', 'p_operation_id', 'p_resolved_body', 'p_resolved_sha256', 'p_params_body', 'p_params_sha256', 'p_provider_idempotency_key'] },
  zentra_record_us_tax_calculation: { sql: 'select public.zentra_record_us_tax_calculation($1,$2::uuid,$3::jsonb,$4,$5,$6::jsonb) result', keys: ['p_organization', 'p_operation_id', 'p_actor', 'p_proof_body', 'p_proof_sha256', 'p_assessment'] },
  zentra_commit_us_tax_invoice_test: { sql: 'select public.zentra_commit_us_tax_invoice_test($1,$2::uuid,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb) result', keys: ['p_organization', 'p_operation_id', 'p_expected_revision', 'p_header', 'p_changes', 'p_ledger_audit', 'p_receipt', 'p_actor'] },
};
type RpcCall = { name: string; parameters: Record<string, unknown>; returned?: unknown };
type Hooks = {
  before?: (name: string) => Promise<void>;
  after?: (name: string) => Promise<void>;
  loseAfter?: string;
  failBefore?: string;
  rollbackCommit?: boolean;
};
function localClient(hooks: Hooks, calls: RpcCall[]) {
  // Fictitious key format exercises the real private client headers, not Auth.
  const secretKey = 'sb_secret_FICTITIOUS_LOCAL_ONLY_0000000000';
  return new SupabaseServerClient({ url: 'https://fictitious-postgrest.example.invalid', secretKey }, async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input), headers = new Headers(init?.headers);
    expect(url.origin).toBe('https://fictitious-postgrest.example.invalid');
    expect(headers.get('Authorization')).toBe('Bearer ' + secretKey); expect(headers.get('apikey')).toBe(secretKey);
    if (url.pathname === '/rest/v1/zentra_workspace_country_configs') {
      expect(init?.method).toBe('GET'); expect(url.searchParams.get('limit')).toBe('2');
      expect(url.searchParams.get('select')).toBe('organization_id,schema_version,config,country,currency,revision,updated_by,updated_at');
      const filter = url.searchParams.get('organization_id'); if (!filter?.startsWith('eq.')) throw new Error('Unscoped synthetic read');
      const rows = await serviceSql('select organization_id,schema_version,config,country,currency,revision,updated_by,to_char(updated_at at time zone \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') updated_at from public.zentra_workspace_country_configs where organization_id=$1 limit 2', [filter.slice(3)]);
      return Response.json(rows);
    }
    const name = url.pathname.replace('/rest/v1/rpc/', ''), query = rpcQueries[name];
    if (!query || init?.method !== 'POST') throw new Error('Unexpected synthetic private HTTP request');
    if (typeof init.body !== 'string') throw new Error('Expected JSON body in synthetic private HTTP request');
    const parameters = JSON.parse(init.body) as Record<string, unknown>;
    const call: RpcCall = { name, parameters }; calls.push(call);
    try {
      await hooks.before?.(name);
      if (hooks.failBefore === name) { hooks.failBefore = undefined; return Response.json({ code: 'synthetic_precommit_failure' }, { status: 503 }); }
      const returned = await db.transaction(async tx => {
        await tx.exec('set local role service_role');
        const rows = await tx.query<{ result: unknown }>(query.sql, query.keys.map(key => typeof parameters[key] === 'object' ? JSON.stringify(parameters[key]) : parameters[key]));
        if (name === 'zentra_commit_us_tax_invoice_test' && hooks.rollbackCommit) { hooks.rollbackCommit = false; throw new Error('synthetic_outer_transaction_rollback'); }
        return rows.rows[0].result;
      });
      call.returned = returned;
      await hooks.after?.(name);
      if (hooks.loseAfter === name) { hooks.loseAfter = undefined; return Response.json({ code: 'synthetic_response_lost_after_commit' }, { status: 503 }); }
      return Response.json(returned);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'synthetic_sql_failure';
      return Response.json({ code }, { status: 400 });
    }
  });
}
function fixtureObservation(resolved: ResolvedStripeTaxRequest, now: string): StripeTaxCalculationObservation {
  const amount = resolved.params.line_items[0].amount, tax = 160;
  const state = { country: 'US', state: 'NY', level: 'state', display_name: 'Fictitious state jurisdiction' };
  return {
    accountId: resolved.binding.accountId, mode: 'test', apiVersion: STRIPE_TAX_API_VERSION, evidenceKind: 'test_fixture', observedAt: now,
    calculation: {
      id: 'taxcalc_FictitiousVertical', object: 'tax.calculation', amount_total: amount + tax, currency: 'usd', customer: null,
      customer_details: { address: { ...resolved.params.customer_details.address, line2: null }, address_source: resolved.params.customer_details.address_source, ip_address: null, tax_ids: [], taxability_override: 'none' },
      expires_at: Math.floor(Date.parse(now) / 1000) + 1800, tax_date: resolved.params.tax_date, livemode: false, shipping_cost: null, ship_from_details: null, tax_amount_exclusive: tax, tax_amount_inclusive: 0,
      line_items: { object: 'list', has_more: false, url: '/v1/tax/calculations/taxcalc_FictitiousVertical/line_items', data: [{ id: 'tax_li_FictitiousVertical', object: 'tax.calculation_line_item', amount, amount_tax: tax, quantity: resolved.params.line_items[0].quantity, reference: 'line', tax_code: 'txcd_99999999', tax_behavior: 'exclusive', livemode: false, product: null,
        tax_breakdown: [
          { amount: tax, taxable_amount: amount, taxability_reason: 'standard_rated', sourcing: 'destination', jurisdiction: state, tax_rate_details: { tax_type: 'sales_tax', display_name: 'Fictitious sales tax', percentage_decimal: '8.0' } },
          { amount: 0, taxable_amount: 0, taxability_reason: 'not_subject_to_tax', sourcing: 'destination', jurisdiction: { ...state, level: 'county', display_name: 'Fictitious county jurisdiction' }, tax_rate_details: null },
        ] } ] },
      tax_breakdown: [{ amount: tax, taxable_amount: amount, taxability_reason: 'standard_rated', inclusive: false, tax_rate_details: { country: 'US', state: 'NY', tax_type: 'sales_tax', percentage_decimal: '8.0', rate_type: 'percentage', flat_amount: null } }],
    },
  };
}
async function fixture(role: 'owner' | 'admin' | 'accountant' = 'owner') {
  const org = randomUUID(), owner = randomUUID(), hooks: Hooks = {}, calls: RpcCall[] = [];
  const now = () => new Date(Date.now() + clockOffset).toISOString();
  let clockOffset = 0, denied: 401 | 402 | 403 | undefined;
  const initialActor: FinancialAuthority = { organizationId: org, userId: role === 'owner' ? owner : randomUUID(), role, managementEntitled: true, timestamp: now() };
  const revalidate = vi.fn(async (): Promise<FinancialAuthority> => {
    if (denied === 401) throw new AccountPublicError('Synthetic local session revoked', 401);
    return { ...initialActor, role: denied === 403 ? 'member' : role, managementEntitled: denied !== 402, timestamp: now() };
  });
  const configuration = validateCompanyConfiguration({ schemaVersion: 1, organizationId: org, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York', address: { country: 'US', line1: '1 Fictitious Public Street', city: 'New York', subdivision: 'NY', postalCode: '10001' }, accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'configured' } });
  const seller = { displayName: 'Fictitious Public Seller', contactEmail: 'seller@example.invalid' };
  const facts: UsTaxFacts = { schemaVersion: 1, legalName: 'PRIVATE_FICTITIOUS_VERTICAL_LEGAL', taxOrigin: { country: 'US', line1: '987 PRIVATE_FICTITIOUS_VERTICAL_ORIGIN', city: 'New York', subdivision: 'NY', postalCode: '10001' }, timeZone: 'America/New_York' };
  await result('select public.zentra_admit_new_us_workspace_v1($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::jsonb,$6) result', [org, randomUUID(), owner, randomUUID(), JSON.stringify({ ...configuration, taxConfiguration: { status: 'unconfigured' } }), digest(org)]);
  // This explicit SQL-local TEST fixture setup is not a public/provider grant.
  await result('select public.zentra_put_workspace_country_config($1,$2,1,$3::uuid,$4::jsonb) result', [org, owner, randomUUID(), JSON.stringify(configuration)]);
  await result('select public.zentra_put_us_seller_profile($1,$2,0,$3::uuid,$4::jsonb) result', [org, owner, randomUUID(), JSON.stringify(seller)]);
  await result('select public.zentra_put_us_tax_profile($1,$2,0,$3::uuid,$4::jsonb) result', [org, owner, randomUUID(), JSON.stringify(facts)]);
  const binding: StripeTaxTestBinding = { organizationId: org, accountId: 'acct_FictitiousVerticalPrivate', mode: 'test', apiVersion: STRIPE_TAX_API_VERSION, revision: 1, settingsSha256: digest('PRIVATE_FICTITIOUS_SETTINGS'), registrationsSha256: digest('PRIVATE_FICTITIOUS_REGISTRATIONS'), observedAt: new Date(Date.now() - 1000).toISOString(), validUntil: new Date(Date.now() + 3600000).toISOString(), evidenceKind: 'test_fixture', scope: 'erp_invoice_tax' };
  await result('select public.zentra_put_us_tax_provider_binding($1,$2,0,$3::uuid,$4::jsonb) result', [org, owner, randomUUID(), JSON.stringify(binding)]);
  const client = localClient(hooks, calls), store = createSupabaseErpStore(client);
  // Prepare the book as its synthetic creation owner, then issue with the
  // independently injected financial user (different UID for admin/accountant).
  const bootstrap = { store, configuration, actor: { ...initialActor, userId: owner, role: 'owner' as const }, revalidate: async () => ({ ...initialActor, userId: owner, role: 'owner' as const, timestamp: now() }), seller: async () => ({ organizationId: org, ...seller }), taxProvider: async () => null };
  let sequence = 0;
  const send = async (command: ErpCommand) => executeErp(bootstrap, { idempotencyKey: 'bootstrap-' + ++sequence, expectedRevision: (await store.read(org))?.revision ?? 0, command });
  const day = now().slice(0, 10), year = day.slice(0, 4);
  await send({ type: 'initialize', periods: [{ id: 'current', start: year + '-01-01', end: year + '-12-31', status: 'open' }] });
  await send({ type: 'save_customer', customer: { id: 'customer', organizationId: org, name: 'Fictitious Customer', kind: 'business', billingAddress: configuration.address, paymentTermsDays: 30 } });
  await send({ type: 'save_estimate', id: 'estimate', expectedEstimateRevision: 0, customerId: 'customer', date: day, expiresAt: year + '-12-31', paymentTermsDays: 30, lines: [{ id: 'line', description: 'Fictitious classified service', quantityUnits: '2', quantityScale: 0, unitPrice: { currency: 'USD', minorUnits: '1000' }, discountBasisPoints: 0, taxTreatment: 'taxable' }], notes: 'Synthetic TEST transaction only' });
  await send({ type: 'accept_estimate', estimateId: 'estimate', expectedEstimateRevision: 1 });
  calls.length = 0;
  const providerResults = new Map<string, StripeTaxCalculationObservation>();
  const requests: ResolvedStripeTaxRequest[] = [];
  const calculate = vi.fn(async (resolved: ResolvedStripeTaxRequest) => {
    requests.push(resolved);
    if (!providerResults.has(resolved.idempotencyKey)) providerResults.set(resolved.idempotencyKey, fixtureObservation(resolved, now()));
    return structuredClone(providerResults.get(resolved.idempotencyKey)!);
  });
  const verify = vi.fn(async () => undefined);
  const dependencies: UsTaxInvoiceTestDependencies = {
    erp: { store, configuration, actor: initialActor, revalidate },
    contexts: createUsTaxFinancialContextReader(client, { revalidate, now, allowTestFixtures: true }),
    operations: createSupabaseUsTaxOperationStore(client), gateway: { verify, calculate },
    classifications: async () => [{ lineId: 'line', taxCode: 'txcd_99999999', kind: 'service', taxBehavior: 'exclusive', revision: 1, evidenceReference: 'fictitious classification, not legal or provider verification' }],
    transactionLocation: async () => ({ taxDateInstant: day + 'T12:00:00Z', addressSource: 'billing' }), operationId: vi.fn(() => randomUUID()), now, allowTestFixtures: true,
  };
  const request = { idempotencyKey: 'vertical-test-invoice', expectedRevision: 4, command: { type: 'issue_invoice' as const, id: 'invoice', estimateId: 'estimate', expectedEstimateRevision: 2, date: day, accountingDate: day, dueDate: day, periodId: 'current' } };
  const counts = async () => (await serviceSql<{ invoices: number; journals: number; links: number; operations: number; events: number; receipts: number; counter: number }>(`select (select count(*)::int from public.zentra_us_erp_records where organization_id=$1 and kind='invoice') invoices,(select count(*)::int from public.zentra_us_erp_records where organization_id=$1 and kind='journal') journals,(select count(*)::int from public.zentra_us_tax_invoice_links where organization_id=$1) links,(select count(*)::int from public.zentra_us_tax_operations where organization_id=$1) operations,(select count(*)::int from public.zentra_us_erp_events where organization_id=$1) events,(select count(*)::int from public.zentra_us_erp_receipts where organization_id=$1) receipts,(select (header->'counters'->>'invoice')::int from public.zentra_us_erp_heads where organization_id=$1) counter`, [org]))[0];
  const operation = async () => (await serviceSql<{ status: string; operation_id: string; resolved_body: string; params_body: string; proof_body: string | null; proof_sha256: string | null }>('select status,operation_id,resolved_body,params_body,proof_body,proof_sha256 from public.zentra_us_tax_operations where organization_id=$1', [org]))[0];
  async function headABA(kind: 'country' | 'seller' | 'facts' | 'binding') {
    if (kind === 'country') for (const [revision, language] of [[2, 'fr'], [3, 'en']] as const) await result('select public.zentra_put_workspace_country_config($1,$2,$3,$4::uuid,$5::jsonb) result', [org, owner, revision, randomUUID(), JSON.stringify({ ...configuration, language })]);
    if (kind === 'seller') for (const [revision, displayName] of [[1, 'Changed fictitious seller'], [2, seller.displayName]] as const) await result('select public.zentra_put_us_seller_profile($1,$2,$3,$4::uuid,$5::jsonb) result', [org, owner, revision, randomUUID(), JSON.stringify({ ...seller, displayName })]);
    if (kind === 'facts') for (const [revision, legalName] of [[1, 'Changed fictitious private name'], [2, facts.legalName]] as const) await result('select public.zentra_put_us_tax_profile($1,$2,$3,$4::uuid,$5::jsonb) result', [org, owner, revision, randomUUID(), JSON.stringify({ ...facts, legalName })]);
    if (kind === 'binding') for (const revision of [1, 2]) await result('select public.zentra_put_us_tax_provider_binding($1,$2,$3,$4::uuid,$5::jsonb) result', [org, owner, revision, randomUUID(), JSON.stringify({ ...binding, revision: revision + 1, settingsSha256: revision === 1 ? digest('changed fixture') : binding.settingsSha256 })]);
  }
  return { org, owner, hooks, calls, client, store, dependencies, request, calculate, verify, providerResults, requests, counts, operation, headABA, send, deny: (status?: 401 | 402 | 403) => { denied = status; }, advanceClock: (milliseconds: number) => { clockOffset += milliseconds; } };
}

describe.runIf(enabled)('private TEST invoice issuer vertical path through real local PostgreSQL', () => {
  beforeAll(async () => {
    expect(JSON.parse(await readFile(join(moduleDirectory!, 'package.json'), 'utf8')).name).toBe('@electric-sql/pglite');
    const { PGlite } = createRequire(import.meta.url)(join(moduleDirectory!, 'dist/index.cjs')) as { PGlite: new () => Database }; db = new PGlite();
    await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);grant usage on schema public to service_role;');
    for (const name of ['202609140100_company_profiles', '202609140200_company_collaboration', '202609200300_company_content', '20261007194528_international_workspace_country_config', '20261007222349_international_us_erp_persistence', '20261007224820_international_us_erp_delta_stream', '20261007225725_international_us_erp_seller_snapshot', '20261008001726_new_us_workspace_admission', '20261008013200_international_tax_proof_allowlist', '20261008034422_international_us_seller_profile', '20261008044402_international_us_tax_profile', '20261008060826_international_us_tax_operations']) await db.exec(await readFile(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), 'utf8'));
  }, 20_000);
  afterAll(async () => { await db?.close(); });

  it.each(['owner', 'admin', 'accountant'] as const)('issues once with actual financial %s, one number/journal/receipt and linked private proof', async role => {
    const f = await fixture(role), response = await executeUsTaxInvoiceTest(f.dependencies, f.request);
    expect(response.replayed).toBe(false); expect(response.receipt).toMatchObject({ action: 'issue_invoice', entityId: 'invoice', revision: 5, idempotencyKey: f.request.idempotencyKey });
    expect(await f.counts()).toEqual({ invoices: 1, journals: 1, links: 1, operations: 1, events: 5, receipts: 5, counter: 1 });
    const state = (await f.store.read(f.org))!, op = await f.operation();
    expect(state.invoices[0]).toMatchObject({ number: 'INV-000001', subtotal: { minorUnits: '2000' }, tax: { minorUnits: '160' }, total: { minorUnits: '2160' } });
    expect(op.status).toBe('committed'); expect(op.proof_sha256).toBe(digest(op.proof_body!));
    const proof = JSON.parse(op.proof_body!); expect(proof).toMatchObject({ mode: 'test', evidenceKind: 'test_fixture', operationId: op.operation_id, netMinor: '2000', taxMinor: '160', totalMinor: '2160' });
    expect(proof.lines[0].breakdowns.map((b: { taxabilityReason: string }) => b.taxabilityReason)).toEqual(['standard_rated', 'not_subject_to_tax']);
    expect(f.calls.filter(c => c.name === 'zentra_commit_us_tax_invoice_test')).toHaveLength(1); expect(f.calls.some(c => c.name === 'zentra_commit_us_erp')).toBe(false);
    expect(f.calls.find(c => c.name === 'zentra_reserve_us_tax_operation')?.parameters.p_actor).toMatchObject({ role });
    if (role !== 'owner') expect(f.dependencies.erp.actor.userId).not.toBe(f.owner);
    expect(f.calculate).toHaveBeenCalledTimes(1); expect(await executeUsTaxInvoiceTest(f.dependencies, f.request)).toEqual({ receipt: response.receipt, replayed: true });
    expect(f.calculate).toHaveBeenCalledTimes(1); expect(await f.counts()).toMatchObject({ counter: 1, receipts: 5 });
  });
  it('keeps private facts/account/settings/proof out of real ERP state, delta, assessment and issuer receipt', async () => {
    const f = await fixture(), response = await executeUsTaxInvoiceTest(f.dependencies, f.request);
    const state = (await f.store.read(f.org))!, delta = (await createSupabaseErpSyncStore(f.client).changes(f.org, 0, 100))!;
    const publicText = JSON.stringify([publicErpState(state), publicErpDelta(delta), response]);
    for (const token of ['PRIVATE_FICTITIOUS_VERTICAL_LEGAL', 'PRIVATE_FICTITIOUS_VERTICAL_ORIGIN', 'acct_FictitiousVerticalPrivate', 'settingsSha256', 'registrationsSha256', 'proofBody', 'operationId', 'resolvedSha256']) expect(publicText).not.toContain(token);
    expect(Object.keys(state.invoices[0].taxAssessment)).toHaveLength(11); expect(Object.keys(state.invoices[0].taxAssessment.lines[0])).toHaveLength(4);
    expect(publicText).toContain('Fictitious Public Seller'); expect(publicText).toContain('taxcalc_FictitiousVertical:tax_li_FictitiousVertical');
  });
  it('retains reserved bytes/key after synthetic provider-response loss and retries the exact calculation once', async () => {
    const f = await fixture(), original = f.calculate.getMockImplementation()!;
    f.calculate.mockImplementationOnce(async resolved => { await original(resolved); throw new Error('Synthetic provider response lost after fixture calculation'); });
    await expect(executeUsTaxInvoiceTest(f.dependencies, f.request)).rejects.toMatchObject({ status: 503 });
    const reserved = await f.operation(); expect(reserved.status).toBe('reserved'); expect(await f.counts()).toMatchObject({ invoices: 0, counter: 0, operations: 1 });
    const saved = await f.dependencies.operations.read(f.dependencies.erp.actor, f.request.idempotencyKey, f.requests[0].commandHash);
    const resumed = await validateResolvedStripeTaxRequest(saved!.resolved, new Date().toISOString());
    const originalFingerprint = buildTaxRequest(f.requests[0].snapshots.configuration, f.requests[0].snapshots.estimate, f.requests[0].invoiceDate).fingerprint;
    const resumedFingerprint = buildTaxRequest(resumed.snapshots.configuration, resumed.snapshots.estimate, resumed.invoiceDate).fingerprint;
    expect(digest(resumedFingerprint)).toBe(digest(originalFingerprint));
    await executeUsTaxInvoiceTest(f.dependencies, f.request);
    expect(f.requests).toHaveLength(2); expect(f.requests[1]).toEqual(f.requests[0]); expect(f.providerResults.size).toBe(1);
    expect((await f.operation()).params_body).toBe(reserved.params_body); expect(await f.counts()).toMatchObject({ invoices: 1, journals: 1, links: 1, counter: 1 });
  });
  it.each(['record_response_lost', 'commit_failed_before', 'commit_outer_rollback'] as const)('resumes durable calculated proof after %s without another calculation', async kind => {
    const f = await fixture();
    if (kind === 'record_response_lost') f.hooks.loseAfter = 'zentra_record_us_tax_calculation';
    if (kind === 'commit_failed_before') f.hooks.failBefore = 'zentra_commit_us_tax_invoice_test';
    if (kind === 'commit_outer_rollback') f.hooks.rollbackCommit = true;
    await expect(executeUsTaxInvoiceTest(f.dependencies, f.request)).rejects.toMatchObject({ status: 503 });
    const op = await f.operation(); expect(op.status).toBe('calculated'); expect(await f.counts()).toEqual({ invoices: 0, journals: 0, links: 0, operations: 1, events: 4, receipts: 4, counter: 0 });
    await executeUsTaxInvoiceTest(f.dependencies, f.request);
    expect(f.calculate).toHaveBeenCalledTimes(1); expect((await f.operation()).proof_body).toBe(op.proof_body); expect(await f.counts()).toMatchObject({ invoices: 1, journals: 1, links: 1, counter: 1 });
  });
  it('replays a commit whose HTTP result was lost after newer heads and a later ERP payment', async () => {
    const f = await fixture(); f.hooks.loseAfter = 'zentra_commit_us_tax_invoice_test';
    await expect(executeUsTaxInvoiceTest(f.dependencies, f.request)).rejects.toMatchObject({ status: 503 });
    expect((await f.operation()).status).toBe('committed'); const receipt = await f.store.receipt(f.org, f.request.idempotencyKey);
    for (const kind of ['country', 'seller', 'facts', 'binding'] as const) await f.headABA(kind);
    await f.send({ type: 'record_payment', id: 'payment', invoiceId: 'invoice', amountMinor: '500', paymentDate: f.request.command.date, accountingDate: f.request.command.date, periodId: 'current', reference: 'Fictitious partial payment' });
    const before = await f.counts(), gatewayCalls = f.verify.mock.calls.length; f.advanceClock(2 * 3600000);
    expect(await executeUsTaxInvoiceTest(f.dependencies, f.request)).toEqual({ receipt, replayed: true });
    expect(await f.counts()).toEqual(before); expect(f.calculate).toHaveBeenCalledTimes(1); expect(f.verify).toHaveBeenCalledTimes(gatewayCalls);
  });
  it.each(['country', 'seller', 'facts', 'binding'] as const)('blocks numerical %s ABA during calculation even when head contents return to their old values', async kind => {
    const f = await fixture(), original = f.calculate.getMockImplementation()!;
    f.calculate.mockImplementationOnce(async resolved => { const observation = await original(resolved); await f.headABA(kind); return observation; });
    await expect(executeUsTaxInvoiceTest(f.dependencies, f.request)).rejects.toMatchObject({ status: 409 });
    expect((await f.operation()).status).toBe('reserved'); expect(await f.counts()).toMatchObject({ invoices: 0, journals: 0, links: 0, receipts: 4, counter: 0 });
    expect(f.calls.some(c => c.name === 'zentra_record_us_tax_calculation')).toBe(false);
  });
  it.each([401, 402, 403] as const)('withholds invoice after fresh admission %i is revoked during calculation', async status => {
    const f = await fixture(), original = f.calculate.getMockImplementation()!;
    f.calculate.mockImplementationOnce(async resolved => { const observation = await original(resolved); f.deny(status); return observation; });
    await expect(executeUsTaxInvoiceTest(f.dependencies, f.request)).rejects.toMatchObject({ status });
    expect(await f.counts()).toMatchObject({ invoices: 0, journals: 0, links: 0, receipts: 4, counter: 0 }); expect((await f.operation()).status).toBe('reserved');
  });
  it('retains the durable committed receipt but withholds it after a postcommit Auth refusal, then replays on restored admission', async () => {
    const f = await fixture(); f.hooks.after = async name => { if (name === 'zentra_commit_us_tax_invoice_test') f.deny(403); };
    await expect(executeUsTaxInvoiceTest(f.dependencies, f.request)).rejects.toMatchObject({ status: 403 });
    expect((await f.operation()).status).toBe('committed'); const before = await f.counts();
    f.deny(); f.hooks.after = undefined;
    expect((await executeUsTaxInvoiceTest(f.dependencies, f.request)).replayed).toBe(true); expect(await f.counts()).toEqual(before); expect(f.calculate).toHaveBeenCalledTimes(1);
  });
  it('refuses an expired stored proof after an injected trusted-clock advance without consuming the invoice number', async () => {
    const f = await fixture(); f.hooks.after = async name => { if (name === 'zentra_record_us_tax_calculation') f.advanceClock(31 * 60000); };
    await expect(executeUsTaxInvoiceTest(f.dependencies, f.request)).rejects.toMatchObject({ status: 409 });
    expect((await f.operation()).status).toBe('calculated'); expect(await f.counts()).toMatchObject({ invoices: 0, journals: 0, links: 0, counter: 0 });
  });
  it('requires explicit issuer fixture admission even though its injected private reader permits fixture data', async () => {
    const f = await fixture();
    await expect(executeUsTaxInvoiceTest({ ...f.dependencies, allowTestFixtures: false }, f.request)).rejects.toMatchObject({ status: 409 });
    expect(f.calculate).not.toHaveBeenCalled(); expect(await f.counts()).toMatchObject({ operations: 0, invoices: 0, counter: 0 });
  });
  it('rejects a stale ERP revision before any provider calculation or operation reservation', async () => {
    const f = await fixture(); await f.send({ type: 'save_customer', customer: { id: 'second-customer', organizationId: f.org, name: 'Fictitious second customer', kind: 'business', billingAddress: f.dependencies.erp.configuration.address, paymentTermsDays: 30 } });
    await expect(executeUsTaxInvoiceTest(f.dependencies, f.request)).rejects.toMatchObject({ code: 'revision_conflict', status: 409 });
    expect(f.calculate).not.toHaveBeenCalled(); expect(await f.counts()).toMatchObject({ operations: 0, invoices: 0, counter: 0 });
  });
});
