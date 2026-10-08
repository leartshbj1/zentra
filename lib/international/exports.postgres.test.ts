import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { extractText } from 'unpdf';
import { PDFDocument } from 'pdf-lib';
import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import { validateCompanyConfiguration } from './country-config';
import { executeErp, type ErpExecutionDependencies } from './runtime';
import { createSupabaseErpStore } from './runtime-store';
import { createUsExportHandlers } from './export-server';
import { getUsExportFonts } from './export-fonts';
import { getUsSellerProfile } from './seller-profile';
import { validatePublicSellerSnapshot, type Contact } from './invoicing';
import { executeUsTaxInvoiceTest } from './us-tax-invoice';
import { createSupabaseUsTaxOperationStore } from './us-tax-operation-store';
import { STRIPE_TAX_API_VERSION, type ResolvedStripeTaxRequest, type StripeTaxTestBinding } from './stripe-tax-resolved-request';
import type { StripeTaxCalculationObservation } from './stripe-tax-calculation';
import type { FinancialAuthority } from './accounting/ledger';
import type { ErpCommand, ErpRequest } from './runtime-types';
import type { ExportSnapshot } from './export-snapshot';
import { AccountPublicError, sha256Hex } from '../account-security';

// Actual read/store/RPC, renderer, embedded fonts and PDF decoding. One local
// serialized RAM PGlite connection over the complete relevant ERP migration
// chain. Auth/D1 and TEST provider observations are synthetic trusted ports;
// no hosted Auth, Stripe call, crash/restart durability or 2-connection proof.
const moduleDirectory = process.env.PGLITE_MODULE_DIR;
const enabled = Boolean(moduleDirectory && isAbsolute(moduleDirectory));
type Sql = { exec(sql: string): Promise<unknown>; query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> };
type Database = Sql & { transaction<T>(task: (sql: Sql) => Promise<T>): Promise<T>; close(): Promise<void> };
let db: Database;
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const serviceSql = <T = Record<string, unknown>>(query: string, values: unknown[] = []) => db.transaction(async tx => { await tx.exec('set local role service_role'); return (await tx.query<T>(query, values)).rows; });
const result = async <T = unknown>(query: string, values: unknown[]) => (await serviceSql<{ result: T }>(query, values))[0].result;
const rpcQueries: Record<string, { sql: string; keys: string[] }> = {
  zentra_read_us_erp: { sql: 'select public.zentra_read_us_erp($1) result', keys: ['p_organization'] },
  zentra_read_us_erp_v2: { sql: 'select public.zentra_read_us_erp_v2($1) result', keys: ['p_organization'] },
  zentra_us_erp_receipt: { sql: 'select public.zentra_us_erp_receipt($1,$2) result', keys: ['p_organization', 'p_idempotency_key'] },
  zentra_us_erp_receipt_v2: { sql: 'select public.zentra_us_erp_receipt_v2($1,$2) result', keys: ['p_organization', 'p_idempotency_key'] },
  zentra_commit_us_erp: { sql: 'select public.zentra_commit_us_erp($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb) result', keys: ['p_organization', 'p_expected_revision', 'p_header', 'p_changes', 'p_ledger_audit', 'p_receipt', 'p_actor'] },
  zentra_read_us_seller_profile: { sql: 'select public.zentra_read_us_seller_profile($1) result', keys: ['p_organization'] },
  zentra_read_us_tax_operation: { sql: 'select public.zentra_read_us_tax_operation($1,$2,$3,$4::jsonb) result', keys: ['p_organization','p_erp_idempotency_key','p_command_hash','p_actor'] },
  zentra_reserve_us_tax_operation: { sql: 'select public.zentra_reserve_us_tax_operation($1,$2::jsonb,$3::uuid,$4,$5,$6,$7,$8) result', keys: ['p_organization','p_actor','p_operation_id','p_resolved_body','p_resolved_sha256','p_params_body','p_params_sha256','p_provider_idempotency_key'] },
  zentra_record_us_tax_calculation: { sql: 'select public.zentra_record_us_tax_calculation($1,$2::uuid,$3::jsonb,$4,$5,$6::jsonb) result', keys: ['p_organization','p_operation_id','p_actor','p_proof_body','p_proof_sha256','p_assessment'] },
  zentra_commit_us_tax_invoice_test: { sql: 'select public.zentra_commit_us_tax_invoice_test($1,$2::uuid,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb) result', keys: ['p_organization','p_operation_id','p_expected_revision','p_header','p_changes','p_ledger_audit','p_receipt','p_actor'] },
};
function localClient() {
  const calls: string[] = [];
  const rpc: SupabaseServerClient['rpc'] = async <T>(name: string, params: Record<string, unknown>): Promise<T> => {
    calls.push(name); const query = rpcQueries[name]; if (!query) throw new Error('Unexpected local RPC');
    try { return await result<T>(query.sql, query.keys.map(key => typeof params[key] === 'object' ? JSON.stringify(params[key]) : params[key])); }
    catch (error) { throw new SupabaseServerError(400, error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'local_sql_failure'); }
  };
  return { client: { rpc }, calls };
}
async function fixture(basis: 'cash' | 'accrual', capability: 1 | 2) {
  const org = randomUUID(), user = randomUUID(), now = new Date().toISOString();
  const actor: FinancialAuthority = { organizationId: org, userId: user, role: 'owner', managementEntitled: true, timestamp: now };
  const configuration = validateCompanyConfiguration({ schemaVersion: 1, organizationId: org, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York', address: { country: 'US', line1: '1 Local Fixture Street', city: 'New York', subdivision: 'NY', postalCode: '10001' }, accountingBasis: basis, invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'unconfigured' } });
  await result('select public.zentra_admit_new_us_workspace_v1($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::jsonb,$6) result', [org, randomUUID(), user, randomUUID(), JSON.stringify(configuration), digest(org)]);
  const ports = localClient(), store = createSupabaseErpStore(ports.client, { supportedSchemaVersion: capability });
  const dependencies = { store, configuration, actor, revalidate: vi.fn(async () => actor) as ErpExecutionDependencies['revalidate'], taxProvider: vi.fn(async () => null) };
  const vendor: Contact = { id: 'vendor', organizationId: org, kind: 'business', name: 'Swiss vendor fixture', billingAddress: { country: 'CH', line1: '1 Rue du Test', postalCode: '1201', city: 'Genève', subdivision: 'GE' }, paymentTermsDays: 30 };
  const request = async (command: ErpCommand, key: string = randomUUID()): Promise<ErpRequest> => ({ idempotencyKey: key, expectedRevision: (await store.read(org))?.revision ?? 0, command });
  const send = async (command: ErpCommand, key?: string) => executeErp(dependencies, await request(command, key));
  await send({ type: 'initialize', periods: [{ id: 'current', start: '2026-01-01', end: '2026-12-31', status: 'open' }] });
  return { org, user, now, actor, configuration, vendor, store, dependencies, ...ports, request, send };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
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
async function issueTestInvoice(f:Fixture) {
  const now=new Date().toISOString(),day=now.slice(0,10),configuration=validateCompanyConfiguration({...f.configuration,taxConfiguration:{status:'configured'}});
  const actor:FinancialAuthority={...f.actor,timestamp:now};f.dependencies.actor=actor;f.dependencies.revalidate=async()=>actor;f.dependencies.configuration=configuration;
  await result('select public.zentra_put_workspace_country_config($1,$2,1,$3::uuid,$4::jsonb) result',[f.org,f.user,randomUUID(),JSON.stringify(configuration)]);
  await f.send({type:'refresh_configuration'});
  const seller={displayName:'Explicit TEST seller',contactEmail:'seller@example.invalid'},facts={schemaVersion:1 as const,legalName:'PRIVATE TEST LEGAL',taxOrigin:configuration.address as Extract<typeof configuration.address,{country:'US'}>,timeZone:'America/New_York'};
  const binding:StripeTaxTestBinding={organizationId:f.org,accountId:'acct_FictitiousPurchasing',mode:'test',apiVersion:STRIPE_TAX_API_VERSION,revision:1,settingsSha256:digest('TEST SETTINGS'),registrationsSha256:digest('TEST REGISTRATIONS'),observedAt:new Date(Date.parse(now)-1000).toISOString(),validUntil:new Date(Date.parse(now)+3600000).toISOString(),evidenceKind:'test_fixture',scope:'erp_invoice_tax'};
  await result('select public.zentra_put_us_seller_profile($1,$2,0,$3::uuid,$4::jsonb) result',[f.org,f.user,randomUUID(),JSON.stringify(seller)]);
  await result('select public.zentra_put_us_tax_profile($1,$2,0,$3::uuid,$4::jsonb) result',[f.org,f.user,randomUUID(),JSON.stringify(facts)]);
  await result('select public.zentra_put_us_tax_provider_binding($1,$2,0,$3::uuid,$4::jsonb) result',[f.org,f.user,randomUUID(),JSON.stringify(binding)]);
  await f.send({type:'save_customer',customer:{...f.vendor,id:'tax-customer',billingAddress:configuration.address}});
  await f.send({type:'save_estimate',id:'tax-estimate',expectedEstimateRevision:0,customerId:'tax-customer',date:day,expiresAt:'2026-12-31',paymentTermsDays:30,lines:[{id:'line',description:'Explicit TEST service',quantityUnits:'2',quantityScale:0,unitPrice:{currency:'USD',minorUnits:'1000'},discountBasisPoints:0,taxTreatment:'taxable'}],notes:'Synthetic TEST only'});
  await f.send({type:'accept_estimate',estimateId:'tax-estimate',expectedEstimateRevision:1});
  const calculate=vi.fn(async(resolved:ResolvedStripeTaxRequest)=>fixtureObservation(resolved,now)),verify=vi.fn(async()=>undefined);
  const request=await f.request({type:'issue_invoice',id:'tax-invoice',estimateId:'tax-estimate',expectedEstimateRevision:2,date:day,accountingDate:day,dueDate:day,periodId:'current'},'tax-invoice');
  const dependencies={erp:{store:f.store,configuration,actor,revalidate:async()=>actor},contexts:{read:async()=>({organizationId:f.org,actor,recordedAt:now,countryRevision:2,configuration,sellerRevision:1,seller,taxFactsRevision:1,taxFacts:facts,binding})},operations:createSupabaseUsTaxOperationStore(f.client),gateway:{verify,calculate},classifications:async()=>[{lineId:'line',taxCode:'txcd_99999999',kind:'service' as const,taxBehavior:'exclusive' as const,revision:1,evidenceReference:'Synthetic TEST classification'}],transactionLocation:async()=>({taxDateInstant:day+'T12:00:00Z',addressSource:'billing' as const}),operationId:()=>randomUUID(),now:()=>now,allowTestFixtures:true};
  const response=await executeUsTaxInvoiceTest(dependencies,request);return {response,dependencies,request,calculate};
}


let v1: Fixture, v2: Fixture, chOrg: string, chBefore: unknown;
const history = (org: string) => serviceSql('select (select row_to_json(h)::text from public.zentra_us_erp_heads h where organization_id=$1) head,(select jsonb_agg(row_to_json(r) order by kind,id)::text from public.zentra_us_erp_records r where organization_id=$1) records,(select jsonb_agg(row_to_json(r) order by revision)::text from public.zentra_us_erp_receipts r where organization_id=$1) receipts,(select jsonb_agg(event order by revision)::text from public.zentra_us_erp_events where organization_id=$1) events,(select jsonb_agg(row_to_json(a) order by revision)::text from public.zentra_us_erp_ledger_audit a where organization_id=$1) audit,(select jsonb_agg(row_to_json(o) order by operation_id)::text from public.zentra_us_tax_operations o where organization_id=$1) tax_operations,(select jsonb_agg(row_to_json(l) order by invoice_id)::text from public.zentra_us_tax_invoice_links l where organization_id=$1) tax_links', [org]);
function handlers(f: Fixture) {
  return createUsExportHandlers({ enabled: () => true, authority: async () => ({ mode: 'browser', actor: { ...f.dependencies.actor, timestamp: new Date(Date.now() + 86_400_000).toISOString() } }), configuration: async () => f.dependencies.configuration, store: () => f.store, seller: async actor => { const state = await getUsSellerProfile(f.client, actor); return state.status === 'configured' ? validatePublicSellerSnapshot({ organizationId: f.org, ...state.profile }, f.org) : null; }, rateLimit: async () => {}, fonts: getUsExportFonts });
}
const exportRequest = (f: Fixture, query: string, capability: 1 | 2 = f.store.supportedSchemaVersion ?? 1) => new Request(`https://zentra.test/exports?${query}`, { headers: { 'X-Zentra-Expected-User': f.user, 'X-Zentra-Erp-Schema-Version': String(capability) } });
describe.runIf(enabled)('durable US HTTP exports with local PostgreSQL and real PDF', () => {
  beforeAll(async () => {
    expect(JSON.parse(await readFile(join(moduleDirectory!, 'package.json'), 'utf8')).name).toBe('@electric-sql/pglite');
    const { PGlite } = createRequire(import.meta.url)(join(moduleDirectory!, 'dist/index.cjs')) as { PGlite: new () => Database }; db = new PGlite();
    await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);grant usage on schema public to service_role;');
    for (const name of ['202609140100_company_profiles', '202609140200_company_collaboration', '202609200300_company_content', '20261007194528_international_workspace_country_config', '20261007222349_international_us_erp_persistence', '20261007224820_international_us_erp_delta_stream', '20261007225725_international_us_erp_seller_snapshot', '20261008001726_new_us_workspace_admission', '20261008013200_international_tax_proof_allowlist', '20261008034422_international_us_seller_profile', '20261008044402_international_us_tax_profile', '20261008060826_international_us_tax_operations', '20261008081825_international_us_purchasing_v2']) await db.exec(await readFile(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), 'utf8'));
    v1 = await fixture('cash', 1); v2 = await fixture('accrual', 2);
    for (const f of [v1, v2]) {
      await issueTestInvoice(f);
      const day = f.dependencies.actor.timestamp.slice(0, 10);
      await f.send({ type: 'record_payment', id: 'customer-payment', invoiceId: 'tax-invoice', amountMinor: '1000', paymentDate: day, accountingDate: day, periodId: 'current', reference: 'Human recorded fixture payment' });
      await result('select public.zentra_put_us_seller_profile($1,$2,1,$3::uuid,$4::jsonb) result', [f.org, f.user, randomUUID(), JSON.stringify({ displayName: 'Later Seller Élodie', contactEmail: 'later@example.invalid' })]);
    }
    const day = v2.dependencies.actor.timestamp.slice(0, 10);
    await v2.send({ type: 'save_vendor', vendor: v2.vendor });
    await v2.send({ type: 'record_vendor_bill', id: 'bill', vendorId: 'vendor', reference: 'SUP-2026-1', date: day, accountingDate: day, dueDate: day, periodId: 'current', netMinor: '10000', purchaseTaxMinor: '825', expenseAccountId: 'purchases', sourceReference: 'Original supplier reference, not an uploaded PDF' });
    await v2.send({ type: 'record_vendor_payment', id: 'vendor-payment', billId: 'bill', amountMinor: '5000', paymentDate: day, accountingDate: day, periodId: 'current', reference: 'Human recorded fixture payment' });
    await v2.send({ type: 'save_vendor', vendor: { ...v2.vendor, name: 'Later vendor name' } });
    chOrg = randomUUID(); await db.query('insert into public.zentra_workspaces(organization_id,revision,updated_by,number_floors) values($1,7,$2,\'[7]\'::jsonb)', [chOrg, 'CH-OWNER-SENTINEL']);
    chBefore = (await db.query('select row_to_json(w)::text from public.zentra_workspaces w where organization_id=$1', [chOrg])).rows;
  }, 30_000);
  afterAll(async () => { await db?.close(); });
  it.each(['json', 'html', 'csv', 'pdf'] as const)('exports the durable accepted estimate %s using the current public seller without changing it', async format => {
    const before = await history(v1.org), response = await handlers(v1).documents(exportRequest(v1, `format=${format}&language=fr`), v1.org, 'estimate', 'tax-estimate');
    expect(response.status).toBe(200); const bytes = new Uint8Array(await response.arrayBuffer());
    const text = format === 'pdf' ? (await extractText(bytes, { mergePages: true })).text : new TextDecoder().decode(bytes);
    expect(text).toContain('Later Seller Élodie'); expect(text).not.toContain('PRIVATE TEST LEGAL');
    if (format === 'json') { const snapshot = JSON.parse(text) as ExportSnapshot; expect(snapshot.recordRevision).toBe(2); expect(snapshot.totals.find(t => t.label === 'total')?.minorUnits).toBe('2000'); expect(snapshot.totals.some(t => t.label === 'tax')).toBe(false); }
    expect(await history(v1.org)).toEqual(before);
  }, 20_000);
  it.each(['json', 'html', 'csv', 'pdf'] as const)('exports v1 historical invoice %s with archived seller, exact balance and no new determination', async format => {
    const before = await history(v1.org), calls = v1.calls.length;
    const response = await handlers(v1).documents(exportRequest(v1, `format=${format}&language=en`), v1.org, 'invoice', 'tax-invoice');
    expect(response.status).toBe(200); const bytes = new Uint8Array(await response.arrayBuffer());
    expect(response.headers.get('X-Zentra-Content-SHA256')).toBe(await sha256Hex(bytes)); expect(response.headers.get('X-Zentra-Organization-Id')).toBe(v1.org);
    let text: string;
    if (format === 'pdf') { const pdf = await PDFDocument.load(bytes); expect(pdf.getPageCount()).toBeGreaterThan(0); expect(pdf.getPages()[0].getSize()).toEqual({ width: 612, height: 792 }); text = (await extractText(bytes, { mergePages: true })).text; }
    else text = new TextDecoder().decode(bytes);
    expect(text).toContain('Explicit TEST seller'); expect(text).not.toContain('Later Seller'); expect(text).not.toMatch(/PRIVATE TEST LEGAL|acct_FictitiousPurchasing|registrationsSha256|taxcalc_FictitiousVertical|proofBody/);
    if (format === 'json') { const snapshot = JSON.parse(text) as ExportSnapshot; expect(snapshot.totals.find(t => t.label === 'balance')?.minorUnits).toBe('1160'); expect(snapshot.recordRevision).toBeNull(); }
    expect(v1.calls.slice(calls)).toEqual(['zentra_read_us_erp']); expect(await history(v1.org)).toEqual(before);
  }, 20_000);
  it.each(['json', 'html', 'csv', 'pdf'] as const)('exports v2 supplier bill %s as internal approval, preserving supplier and payment history', async format => {
    const before = await history(v2.org), response = await handlers(v2).documents(exportRequest(v2, `format=${format}&language=fr`), v2.org, 'vendor_bill', 'bill');
    expect(response.status).toBe(200); const bytes = new Uint8Array(await response.arrayBuffer());
    const text = format === 'pdf' ? (await extractText(bytes, { mergePages: true })).text : new TextDecoder().decode(bytes);
    expect(text).toContain('Swiss vendor fixture'); expect(text).not.toContain('Later vendor name'); expect(text).toContain('SUP-2026-1');
    if (format === 'json') { const snapshot = JSON.parse(text) as ExportSnapshot; expect(snapshot.totals.find(t => t.label === 'balance')?.minorUnits).toBe('5825'); expect(snapshot.totals.find(t => t.label === 'tax')?.minorUnits).toBe('825'); }
    expect(await history(v2.org)).toEqual(before);
  }, 20_000);
  it.each(['trial_balance', 'profit_loss', 'balance_sheet', 'cash_flow', 'general_ledger'] as const)('exports the real v2 %s ledger in all formats with no write or CH change', async kind => {
    const before = await history(v2.org), query = kind === 'trial_balance' || kind === 'balance_sheet' ? 'asOf=2026-12-31' : `start=2026-01-01&end=2026-12-31${kind === 'general_ledger' ? '&accountId=purchases' : ''}`;
    for (const format of ['json', 'html', 'csv', 'pdf']) {
      const response = await handlers(v2).reports(exportRequest(v2, `${query}&format=${format}&language=de`), v2.org, kind);
      expect(response.status).toBe(200); const bytes = new Uint8Array(await response.arrayBuffer());
      expect(response.headers.get('X-Zentra-Currency')).toBe('USD'); expect(response.headers.get('X-Zentra-Content-SHA256')).toBe(await sha256Hex(bytes));
      if (format === 'pdf') { const pdf = await PDFDocument.load(bytes); expect(pdf.getPageCount()).toBeGreaterThan(0); }
      if (format === 'json') { const snapshot = JSON.parse(new TextDecoder().decode(bytes)) as ExportSnapshot; expect(snapshot.selector).toMatchObject({ kind: 'report', reportType: kind }); if (kind === 'profit_loss') expect(snapshot.totals.find(t => t.label === 'expense')?.minorUnits).toBe('10825'); }
    }
    expect(await history(v2.org)).toEqual(before); expect((await db.query('select row_to_json(w)::text from public.zentra_workspaces w where organization_id=$1', [chOrg])).rows).toEqual(chBefore);
  }, 20_000);
  it('keeps v1 receipts/events byte-exact and refuses old-capability access to the v2 book', async () => {
    const before = await history(v2.org), calls = v2.calls.length;
    const capped = createUsExportHandlers({ enabled: () => true, authority: async () => ({ mode: 'browser', actor: v2.dependencies.actor }), configuration: async () => v2.dependencies.configuration, store: capability => createSupabaseErpStore(v2.client, { supportedSchemaVersion: capability ?? 1 }), seller: async () => null, rateLimit: async () => {}, fonts: getUsExportFonts });
    const response = await capped.documents(exportRequest(v2, 'format=json', 1), v2.org, 'invoice', 'tax-invoice'); expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: 'client_upgrade_required' }); expect(v2.calls.slice(calls)).toEqual(['zentra_read_us_erp']); expect(await history(v2.org)).toEqual(before);
  });
  it('withholds a real rendered PDF after authorization is revoked and still performs no mutation', async () => {
    const before = await history(v2.org); let revoked = false;
    const renderers = await import('./export-renderer');
    const boundary = createUsExportHandlers({ enabled: () => true, authority: async () => { if (revoked) throw new AccountPublicError('PRIVATE TOKEN', 403); return { mode: 'browser', actor: v2.dependencies.actor }; }, configuration: async () => v2.dependencies.configuration, store: () => v2.store, seller: async () => null, fonts: getUsExportFonts, rateLimit: async () => {}, render: async (snapshot, format, fonts) => { expect(format).toBe('pdf'); const bytes = await renderers.renderUsExportPdf(snapshot, fonts!); revoked = true; return bytes; } });
    const response = await boundary.documents(exportRequest(v2, 'format=pdf'), v2.org, 'invoice', 'tax-invoice'); expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: 'forbidden' }); expect(await history(v2.org)).toEqual(before);
  }, 20_000);
});
