import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { extractText } from 'unpdf';
import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import { canonicalErpJson } from './erp-contract';
import { US_DEVICE_PROTOCOL } from './us-device-protocol';
import { seedUsDeviceFixture, sqliteUsDeviceDatabase } from './us-device-test-fixture';
import { createSupabaseErpStore } from './runtime-store';
import { executeErp } from './runtime';
import { vendorBillBalance } from './purchasing';
import { trialBalance, profitAndLoss } from './accounting/reports';
import { validateUsExportSnapshot, type ExportSelector } from './export-snapshot';
import { createUsExportHandlers, type ExportServerDependencies } from './export-server';
import { getUsExportFonts } from './export-fonts';
import { renderUsExportCsv, renderUsExportHtml, renderUsExportPdf } from './export-renderer';
import type { FinancialAuthority } from './accounting/ledger';
import type { ErpCommand, ErpRequest } from './runtime-types';
import type { ErpSchemaVersion } from './erp-schema-capability';
import type { Contact } from './invoicing';

const ports = vi.hoisted(() => ({
  env: {} as Record<string, string>, database: null as unknown as D1Database,
  client: null as unknown as SupabaseServerClient, user: vi.fn(), chDevice: vi.fn(), rate: vi.fn(),
}));
vi.mock('cloudflare:workers', () => ({ env: ports.env }));
vi.mock('../runtime', () => ({ database: () => ports.database }));
vi.mock('../supabase-server-runtime', () => ({ supabaseServerClient: () => ports.client }));
vi.mock('../../app/zentra-auth', () => ({ getZentraUser: ports.user }));
vi.mock('../account', () => ({ requireDeviceSession: ports.chDevice, enforceAccountRateLimit: ports.rate }));
import { usDeviceHandlers, requireUsDeviceSession } from './us-device-bindings';
import { erpHandlers, erpServerDependencies, usPurchasingSchemaVersion } from './runtime-bindings';
import { usExportHandlers } from './export-bindings';
import { GET as sellerGET } from '../../app/api/international/workspaces/[organizationId]/seller/route';
import { GET as taxGET } from '../../app/api/international/workspaces/[organizationId]/tax-profile/route';

// Local real HTTP factories/bindings/executor, full D1 SQLite 0000..0088 and
// PostgreSQL RPCs with service_role. Browser identity, Price/payment observation
// and creation's PG receipt in the D1 fixture are explicitly synthetic TEST
// ports. One serialized RAM PGlite connection; no hosted/native executable,
// Stripe, two-connection concurrency or crash/restart durability proof.
const moduleDirectory = process.env.PGLITE_MODULE_DIR;
const enabled = Boolean(moduleDirectory && isAbsolute(moduleDirectory));
type Sql = { exec(sql: string): Promise<unknown>; query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> };
type Database = Sql & { transaction<T>(task: (sql: Sql) => Promise<T>): Promise<T>; close(): Promise<void> };
let pg!: Database;
const sqlite: ReturnType<typeof sqliteUsDeviceDatabase>[] = [];
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
async function sql<T = Record<string, unknown>>(query: string, values: unknown[] = []): Promise<T[]> {
  return pg.transaction(async tx => { await tx.exec('set local role service_role'); return (await tx.query<T>(query, values)).rows; });
}
async function result<T = unknown>(query: string, values: unknown[]): Promise<T> { return (await sql<{ result: T }>(query, values))[0].result; }
const rpc: Record<string, { query: string; keys: string[] }> = {
  zentra_read_us_erp: { query: 'select public.zentra_read_us_erp($1) result', keys: ['p_organization'] },
  zentra_read_us_erp_v2: { query: 'select public.zentra_read_us_erp_v2($1) result', keys: ['p_organization'] },
  zentra_read_us_erp_v3: { query: 'select public.zentra_read_us_erp_v3($1) result', keys: ['p_organization'] },
  zentra_us_erp_receipt: { query: 'select public.zentra_us_erp_receipt($1,$2) result', keys: ['p_organization', 'p_idempotency_key'] },
  zentra_us_erp_receipt_v2: { query: 'select public.zentra_us_erp_receipt_v2($1,$2) result', keys: ['p_organization', 'p_idempotency_key'] },
  zentra_us_erp_receipt_v3: { query: 'select public.zentra_us_erp_receipt_v3($1,$2) result', keys: ['p_organization', 'p_idempotency_key'] },
  zentra_commit_us_erp: { query: 'select public.zentra_commit_us_erp($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb) result', keys: ['p_organization', 'p_expected_revision', 'p_header', 'p_changes', 'p_ledger_audit', 'p_receipt', 'p_actor'] },
  zentra_read_us_seller_profile: { query: 'select public.zentra_read_us_seller_profile($1) result', keys: ['p_organization'] },
  zentra_read_us_tax_profile: { query: 'select public.zentra_read_us_tax_profile($1) result', keys: ['p_organization'] },
};

async function fixture(role: FinancialAuthority['role'] = 'owner', basis: 'cash' | 'accrual' = 'accrual', seller = true) {
  vi.clearAllMocks(); for (const key of Object.keys(ports.env)) delete ports.env[key];
  const d1 = sqliteUsDeviceDatabase(); sqlite.push(d1);
  // Node/SQLite Windows clocks can differ at second boundaries. This TEST SQL
  // clock uses the same wall clock as the production service; guards remain exact.
  d1.sql.function('unixepoch', () => Math.floor(Date.now() / 1000));
  ports.database = d1.database;
  const admission = await seedUsDeviceFixture(d1.database, role);
  const org = admission.intent.organizationId, owner = admission.owner;
  const configuration = { ...admission.intent.configuration, accountingBasis: basis };
  await result('select public.zentra_admit_new_us_workspace_v1($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::jsonb,$6) result', [org, admission.intent.creationId, owner, admission.intent.requestId, JSON.stringify(configuration), admission.intent.fingerprint]);
  Object.assign(ports.env, { INTERNATIONAL_CORE_ENABLED: 'true', INTERNATIONAL_US_ERP_ENABLED: 'true', INTERNATIONAL_US_NATIVE_ADMISSION_ENABLED: 'true', INTERNATIONAL_US_PURCHASING_V2_ENABLED: 'true', INTERNATIONAL_US_PROJECTS_V3_ENABLED: 'true', INTERNATIONAL_US_BILLING_ENVIRONMENT: 'TEST', INTERNATIONAL_US_SAAS_CATALOG_JSON: JSON.stringify(admission.policy.catalog) });
  ports.user.mockResolvedValue({ userId: admission.actor }); ports.rate.mockResolvedValue(undefined);
  const calls: string[] = [], hooks: { afterCommit?: () => Promise<void>; loseCommit?: boolean } = {};
  const clientRpc: SupabaseServerClient['rpc'] = async <T>(name: string, params: Record<string, unknown>): Promise<T> => {
    calls.push(name); const operation = rpc[name]; if (!operation) throw new Error('Unexpected TEST RPC');
    try {
      const value = await result<T>(operation.query, operation.keys.map(key => typeof params[key] === 'object' ? JSON.stringify(params[key]) : params[key]));
      if (name === 'zentra_commit_us_erp') {
        const callback = hooks.afterCommit; delete hooks.afterCommit; if (callback) await callback();
        if (hooks.loseCommit) { hooks.loseCommit = false; throw new Error('Lost committed TEST response'); }
      }
      return value;
    } catch (error) { throw new SupabaseServerError(400, error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'local_failure'); }
  };
  const select: SupabaseServerClient['select'] = async <T>(table: string, query: Parameters<SupabaseServerClient['select']>[1] = {}): Promise<T[]> => {
    if (query instanceof URLSearchParams || query.organization_id !== 'eq.' + org) throw new Error('Unexpected TEST tenant');
    if (table === 'zentra_workspaces') return sql<T>('select organization_id from public.zentra_workspaces where organization_id=$1', [org]);
    if (table === 'zentra_workspace_country_configs') return sql<T>('select organization_id,schema_version,config,country,currency,revision,updated_by,updated_at::text from public.zentra_workspace_country_configs where organization_id=$1', [org]);
    throw new Error('Unexpected TEST resource');
  };
  const client = { rpc: clientRpc, select }; ports.client = client as SupabaseServerClient;
  const store = createSupabaseErpStore(client, { supportedSchemaVersion: 3 });
  const actor = (): FinancialAuthority => ({ organizationId: org, userId: owner, role: 'owner', managementEntitled: true, timestamp: new Date().toISOString() });
  async function envelope(command: ErpCommand, key = randomUUID()): Promise<ErpRequest> { return { idempotencyKey: key, expectedRevision: (await store.read(org))?.revision ?? 0, command }; }
  async function seed(command: ErpCommand) { return executeErp({ store, configuration, actor: actor(), revalidate: async () => actor(), taxProvider: async () => null }, await envelope(command)); }
  await seed({ type: 'initialize', periods: [{ id: '2026', start: '2026-01-01', end: '2026-12-31', status: 'open' }] });
  if (seller) await result('select public.zentra_put_us_seller_profile($1,$2,0,$3::uuid,$4::jsonb) result', [org, owner, randomUUID(), JSON.stringify({ displayName: 'US TEST company', contactEmail: 'seller@example.invalid' })]);
  const challenge = await usDeviceHandlers.START(admission.request('start', { protocol: US_DEVICE_PROTOCOL, installationId: admission.installationId, sessionTokenHash: admission.sessionTokenHash, supportedSchemaVersion: 3 }));
  expect(challenge.status).toBe(201); const code = await challenge.json() as { userCode: string; deviceCode: string };
  expect((await usDeviceHandlers.APPROVE(admission.request('approve', { protocol: US_DEVICE_PROTOCOL, userCode: code.userCode, organizationId: org }))).status).toBe(200);
  expect((await usDeviceHandlers.EXCHANGE(admission.request('exchange', { protocol: US_DEVICE_PROTOCOL, deviceCode: code.deviceCode, installationId: admission.installationId, sessionToken: admission.sessionToken }))).status).toBe(200);
  ports.user.mockClear(); calls.splice(0);
  const request = (path: string, body?: unknown, capability: ErpSchemaVersion = 3, token = admission.sessionToken, tenant = org) => new Request(`https://zentraapp.ch/api/international/workspaces/${tenant}/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, 'X-Zentra-Erp-Schema-Version': String(capability), 'X-Zentra-Expected-User': admission.actor, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const post = (input: ErpRequest) => erpHandlers.POST(request('erp', input), org);
  const send = async (command: ErpCommand) => post(await envelope(command));
  const vendor: Contact = { id: 'vendor', organizationId: org, kind: 'business', name: '=Historical vendor Élodie', billingAddress: { country: 'CH', line1: '1 Rue TEST', city: 'Genève', postalCode: '1201', subdivision: 'GE' }, paymentTermsDays: 30 };
  const bill = (id = 'bill', reference = 'SUP-2026-1'): ErpCommand => ({ type: 'record_vendor_bill', id, vendorId: vendor.id, reference, date: '2026-10-08', accountingDate: '2026-10-08', dueDate: '2026-11-07', periodId: '2026', netMinor: '10000', purchaseTaxMinor: '825', expenseAccountId: 'purchases', sourceReference: 'Manual TEST source; no uploaded original' });
  const payment = (id = 'payment', amountMinor = '5000'): ErpCommand => ({ type: 'record_vendor_payment', id, billId: 'bill', amountMinor, paymentDate: '2026-10-09', accountingDate: '2026-10-09', periodId: '2026', reference: 'Human recorded TEST payment; no bank transfer' });
  async function purchasing() { await seed({ type: 'save_vendor', vendor }); await seed(bill()); }
  const history = async () => ({ head: await store.read(org), receipts: await sql('select receipt from public.zentra_us_erp_receipts where organization_id=$1 order by revision', [org]) });
  const deps: ExportServerDependencies = {
    enabled: () => erpServerDependencies.enabled(), authority: (request, organizationId) => erpServerDependencies.authority(request, organizationId),
    configuration: actor => erpServerDependencies.configuration(actor), store: capability => erpServerDependencies.store(capability),
    seller: async actor => erpServerDependencies.seller ? erpServerDependencies.seller(actor) : null,
    rateLimit: (request, actor, operation) => erpServerDependencies.rateLimit(request, actor, operation),
    freshSupportedSchemaVersion: capability => usPurchasingSchemaVersion(capability), fonts: getUsExportFonts,
  };
  return { ...d1, ...admission, org, owner, configuration, calls, hooks, store, client, request, envelope, post, send, seed, vendor, bill, payment, purchasing, history, deps };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function rejection(response: Response, status: number, code: string) { expect(response.status).toBe(status); expect(await response.json()).toEqual({ error: code }); }
async function exportProof(response: Response, f: Fixture, selector: ExportSelector, format: 'json' | 'pdf' | 'csv', language = 'en') {
  expect(response.status).toBe(200); const bytes = new Uint8Array(await response.arrayBuffer());
  expect(response.headers.get('X-Zentra-Content-SHA256')).toBe(sha(bytes));
  expect(response.headers.get('X-Zentra-Export-Selector-SHA256')).toBe(sha(canonicalErpJson(selector)));
  expect(response.headers.get('X-Zentra-Organization-Id')).toBe(f.org); expect(response.headers.get('X-Zentra-Currency')).toBe('USD');
  expect(response.headers.get('X-Zentra-Export-Language')).toBe(language); expect(response.headers.get('X-Zentra-Export-Format')).toBe(format);
  expect(response.headers.get('Content-Length')).toBe(String(bytes.length)); expect(response.headers.get('Content-Disposition')).toMatch(new RegExp(`^(?:inline|attachment); filename="[A-Za-z0-9._-]+\\.${format}"$`));
  expect(response.headers.get('Cache-Control')).toContain('no-store'); expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff'); expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  const state = await f.store.read(f.org); expect(response.headers.get('X-Zentra-Erp-Revision')).toBe(String(state!.revision)); expect(response.headers.get('X-Zentra-Ledger-Revision')).toBe(String(state!.ledger.revision));
  return bytes;
}

describe.skipIf(!enabled)('Native US purchases/exports: real US bearer D1, HTTP executor and PostgreSQL RPC TEST chain', () => {
  let chOrg: string, chBefore: unknown;
  beforeAll(async () => {
    const { PGlite } = createRequire(import.meta.url)(join(moduleDirectory!, 'dist/index.cjs')) as { PGlite: new () => Database }; pg = new PGlite();
    await pg.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);grant usage on schema public to service_role;');
    const migrations = ['202609140100_company_profiles', '202609140200_company_collaboration', '202609200300_company_content', '20261007194528_international_workspace_country_config', '20261007222349_international_us_erp_persistence', '20261007224820_international_us_erp_delta_stream', '20261007225725_international_us_erp_seller_snapshot', '20261008001726_new_us_workspace_admission', '20261008013200_international_tax_proof_allowlist', '20261008034422_international_us_seller_profile', '20261008044402_international_us_tax_profile', '20261008060826_international_us_tax_operations', '20261008081825_international_us_purchasing_v2', '20261008105120_international_us_projects_v3'];
    for (const name of migrations) await pg.exec(await readFile(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), 'utf8'));
    chOrg = randomUUID(); await pg.query("insert into public.zentra_workspaces(organization_id,revision,updated_by,number_floors) values($1,7,'CH-NATIVE-SENTINEL','[7]'::jsonb)", [chOrg]);
    chBefore = (await pg.query('select row_to_json(w)::text from public.zentra_workspaces w where organization_id=$1', [chOrg])).rows;
  }, 30_000);
  afterEach(() => { for (const db of sqlite.splice(0)) db.sql.close(); });
  afterAll(async () => { if (pg) { expect((await pg.query('select row_to_json(w)::text from public.zentra_workspaces w where organization_id=$1', [chOrg])).rows).toEqual(chBefore); await pg.close(); } });

  it.each(['owner', 'admin', 'accountant', 'member', 'read_only'] as const)('uses actual bearer authority for %s reads and financial writes without CH/cookie fallback', async role => {
    const f = await fixture(role), initial = await f.history();
    expect((await erpHandlers.GET(f.request('erp'), f.org)).status).toBe(200);
    expect((await sellerGET(f.request('seller'), { params: Promise.resolve({ organizationId: f.org }) })).status).toBe(200);
    expect((await taxGET(f.request('tax-profile'), { params: Promise.resolve({ organizationId: f.org }) })).status).toBe(role === 'owner' ? 200 : 403);
    for (const command of [{ type: 'save_vendor', vendor: f.vendor } as ErpCommand, f.bill(), f.payment()]) {
      const response = await f.send(command);
      if (['owner', 'admin', 'accountant'].includes(role)) expect(response.status).toBe(200);
      else { await rejection(response, 403, 'financial_permission_required'); expect(await f.history()).toEqual(initial); }
    }
    const selector: ExportSelector = { kind: 'report', reportType: 'trial_balance', asOf: '2026-12-31' };
    await exportProof(await usExportHandlers.reports(f.request('exports/reports/trial_balance?format=csv&language=en&asOf=2026-12-31'), f.org, 'trial_balance'), f, selector, 'csv');
    expect(ports.chDevice).not.toHaveBeenCalled(); expect(ports.user).not.toHaveBeenCalled();
    for (const table of ['organizations', 'subscriptions', 'device_sessions', 'license_activations']) expect(f.sql.prepare('select count(*) count from ' + table).get()!.count).toBe(0);
  });

  it.each(['cash', 'accrual'] as const)('records two %s bills and one partial payment, then exports durable snapshots and exact journals', async basis => {
    const f = await fixture('owner', basis);
    for (const command of [{ type: 'save_vendor', vendor: f.vendor } as ErpCommand, f.bill(), f.bill('other-bill', 'SUP-2026-2'), f.payment(), { type: 'save_vendor', vendor: { ...f.vendor, name: 'Later vendor' } } as ErpCommand]) expect((await f.send(command)).status).toBe(200);
    const before = await f.history(), state = before.head!;
    expect(state.schemaVersion).toBe(2); expect(state.vendorBills![0].vendorSnapshot.name).toBe(f.vendor.name);
    expect(vendorBillBalance(state.vendorBills!.find(b => b.id === 'bill')!, state.vendorPayments!.filter(p => p.billId === 'bill')).minorUnits).toBe('5825');
    expect(vendorBillBalance(state.vendorBills!.find(b => b.id === 'other-bill')!, state.vendorPayments!.filter(p => p.billId === 'other-bill')).minorUnits).toBe('10825');
    expect(profitAndLoss(state.ledger, { start: '2026-01-01', end: '2026-12-31' }).expenseMinor).toBe(basis === 'cash' ? '5000' : '21650');
    const balance = trialBalance(state.ledger, '2026-12-31'); expect(balance.totalDebitMinor).toBe(balance.totalCreditMinor);
    const selector: ExportSelector = { kind: 'document', documentType: 'vendor_bill', id: 'bill' };
    const jsonResponse = await usExportHandlers.documents(f.request('exports/documents/vendor_bill/bill?format=json&language=en'), f.org, 'vendor_bill', 'bill');
    const snapshot = validateUsExportSnapshot(JSON.parse(new TextDecoder().decode(await exportProof(jsonResponse, f, selector, 'json'))));
    expect(snapshot.recipient!.name).toBe(f.vendor.name); expect(snapshot.totals.find(t => t.label === 'balance')!.minorUnits).toBe('5825');
    const csv = new TextDecoder().decode(await exportProof(await usExportHandlers.documents(f.request('exports/documents/vendor_bill/bill?format=csv&language=fr'), f.org, 'vendor_bill', 'bill'), f, selector, 'csv', 'fr'));
    expect(csv).toContain("'=Historical vendor Élodie"); expect(csv).toContain('"108.25"'); expect(csv).toContain('"58.25"');
    expect(await f.history()).toEqual(before);
  });

  it('renders a real Letter PDF from the durable bill, with correlated proof headers and no storage mutation', async () => {
    const f = await fixture(); await f.purchasing(); const before = await f.history();
    const selector: ExportSelector = { kind: 'document', documentType: 'vendor_bill', id: 'bill' };
    const response = await usExportHandlers.documents(f.request('exports/documents/vendor_bill/bill?format=pdf&language=de'), f.org, 'vendor_bill', 'bill');
    expect(response.headers.get('Content-Type')).toBe('application/pdf'); expect(response.headers.get('X-Zentra-Record-Revision')).toBe('3');
    const bytes = await exportProof(response, f, selector, 'pdf', 'de'), pdf = await PDFDocument.load(bytes), text = await extractText(bytes, { mergePages: true });
    expect(response.headers.get('X-Zentra-Export-Selector-SHA256')).toBe(sha('{"documentType":"vendor_bill","id":"bill","kind":"document"}'));
    expect(pdf.getPages()[0].getSize()).toEqual({ width: 612, height: 792 }); expect(text.text).toContain('SUP-2026-1'); expect(text.text).toContain('Historical vendor');
    expect(text.text).not.toContain(f.sessionToken); expect(await f.history()).toEqual(before);
  });

  it('writes cross-client PDF/CSV vectors from real admitted schema3 handler responses without tax/provider grants', async () => {
    const f = await fixture();
    const customer = { ...f.vendor, id: 'customer', name: 'Customer TEST' };
    const commands: ErpCommand[] = [
      { type: 'save_vendor', vendor: f.vendor }, f.bill(), f.payment(), { type: 'save_customer', customer },
      { type: 'save_projects', projects: [{ id: 'project', expectedProjectRevision: 0, customerId: customer.id, name: 'Real TEST dossier', status: 'active', notes: 'Declared TEST only; no tax grant', startDate: '2026-10-08', targetDate: null, budgetMinor: '20000', vendorBillIds: ['bill'] }] },
      { type: 'save_estimate', id: 'estimate', expectedEstimateRevision: 0, customerId: customer.id, projectId: 'project', date: '2026-10-08', expiresAt: '2026-11-08', paymentTermsDays: 30, lines: [{ id: 'line', description: 'Explicit TEST service', quantityUnits: '1', quantityScale: 0, unitPrice: { currency: 'USD', minorUnits: '1000' }, discountBasisPoints: 0, taxTreatment: 'taxable' }], notes: 'Unissued estimate; provider remains absent' },
      { type: 'accept_estimate', estimateId: 'estimate', expectedEstimateRevision: 1 },
    ];
    for (const command of commands) expect((await f.send(command)).status).toBe(200);
    const before = await f.history(); expect(before.head!.schemaVersion).toBe(3); expect(before.head!.configuration.taxConfiguration.status).toBe('unconfigured');
    const selectors: { selector: ExportSelector; language: 'fr' | 'de' | 'it' | 'en' }[] = [
      { selector: { kind: 'document', documentType: 'vendor_bill', id: 'bill' }, language: 'fr' },
      { selector: { kind: 'document', documentType: 'estimate', id: 'estimate' }, language: 'en' },
      { selector: { kind: 'document', documentType: 'project', id: 'project' }, language: 'de' },
      { selector: { kind: 'report', reportType: 'trial_balance', asOf: '2026-12-31' }, language: 'it' },
    ];
    const vectors: unknown[] = [];
    for (const { selector, language } of selectors) for (const format of ['pdf', 'csv'] as const) {
      const suffix = selector.kind === 'document' ? `documents/${selector.documentType}/${selector.id}?format=${format}&language=${language}` : `reports/${selector.reportType}?format=${format}&language=${language}&asOf=${'asOf' in selector ? selector.asOf : ''}`;
      const request = f.request('exports/' + suffix);
      const response = selector.kind === 'document' ? await usExportHandlers.documents(request, f.org, selector.documentType, selector.id) : await usExportHandlers.reports(request, f.org, selector.reportType);
      const headers = Object.fromEntries(response.headers.entries());
      const bytes = await exportProof(response, f, selector, format, language);
      if (selector.kind === 'report') expect(headers['x-zentra-record-revision']).toBeUndefined();
      vectors.push({ name: (selector.kind === 'document' ? selector.documentType : selector.reportType) + '-' + format, selector, canonicalSelector: canonicalErpJson(selector), format, language, minimumRevision: before.head!.revision, exactRevision: before.head!.revision, response: { status: response.status, headers, bodyBase64: Buffer.from(bytes).toString('base64') } });
    }
    expect(await f.history()).toEqual(before); expect(ports.chDevice).not.toHaveBeenCalled();
    const artifact = { schemaVersion: 1, scope: 'Local actual US bearer D1 SQLite + serialized PostgreSQL PGlite RPC/HTTP/render/fonts TEST; synthetic Auth/payment observations; no native execution/hosted/tax-provider grant', organizationId: f.org, userId: f.actor, country: 'US', currency: 'USD', supportedSchemaVersion: 3, vectors };
    expect(JSON.stringify(artifact)).not.toContain(f.sessionToken);
    const folder = new URL('../../.qa/us-purchases-exports/', import.meta.url); await mkdir(folder, { recursive: true });
    await writeFile(new URL('us-export-vectors.json', folder), JSON.stringify(artifact, null, 2) + '\n', 'utf8');
  });

  it('rejects duplicate vendor references, overpayment and a closed period without extra receipts or journals', async () => {
    const f = await fixture(); await f.purchasing(); const before = await f.history();
    await rejection(await f.send(f.bill('duplicate')), 409, 'vendor_bill_already_recorded');
    await rejection(await f.send(f.payment('too-much', '10826')), 409, 'overpayment'); expect(await f.history()).toEqual(before);
    expect((await f.send({ type: 'close_period', periodId: '2026' })).status).toBe(200); const closed = await f.history();
    await rejection(await f.send(f.payment()), 409, 'accounting_period_not_open'); expect(await f.history()).toEqual(closed);
  });

  it.each(['lost_rpc_response', 'postcommit_configuration_change'] as const)('recovers %s using the identical payment body/key after a later vendor edit', async failure => {
    const f = await fixture(); await f.purchasing(); const request = await f.envelope(f.payment());
    if (failure === 'lost_rpc_response') f.hooks.loseCommit = true;
    else f.hooks.afterCommit = async () => { await result('select public.zentra_put_workspace_country_config($1,$2,1,$3::uuid,$4::jsonb) result', [f.org, f.owner, randomUUID(), JSON.stringify({ ...f.configuration, language: 'fr' })]); };
    const first = await f.post(request); expect(first.status).toBe(failure === 'lost_rpc_response' ? 503 : 409);
    if (failure === 'postcommit_configuration_change') { expect(await first.json()).toEqual({ error: 'configuration_changed' }); await result('select public.zentra_put_workspace_country_config($1,$2,2,$3::uuid,$4::jsonb) result', [f.org, f.owner, randomUUID(), JSON.stringify(f.configuration)]); }
    expect((await f.send({ type: 'save_vendor', vendor: { ...f.vendor, name: 'Later TEST edit' } })).status).toBe(200);
    const before = await f.history(), replay = await f.post(request); expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replayed: true, receipt: { idempotencyKey: request.idempotencyKey, revision: request.expectedRevision + 1, entityId: 'payment', action: 'record_vendor_payment' } });
    expect(await f.history()).toEqual(before); expect(before.head!.vendorPayments).toHaveLength(1);
    await rejection(await f.post({ ...request, command: f.payment('payment', '4000') }), 409, 'idempotency_conflict'); expect(await f.history()).toEqual(before);
  });

  it('distinguishes source-not-found from native authorization loss and never invokes CH or browser fallback', async () => {
    const f = await fixture(); await f.purchasing(); const before = await f.history();
    await rejection(await usExportHandlers.documents(f.request('exports/documents/vendor_bill/missing?format=pdf'), f.org, 'vendor_bill', 'missing'), 404, 'export_source_not_found');
    expect((await requireUsDeviceSession(f.request('erp'))).organizationId).toBe(f.org);
    const fonts = vi.fn(getUsExportFonts), render = vi.fn(() => 'PRIVATE never rendered'), handlers = createUsExportHandlers({ ...f.deps, fonts, render });
    for (const token of ['zds_' + f.sessionToken.slice(4), 'zus_' + 'A'.repeat(43)]) await rejection(await handlers.documents(f.request('exports/documents/vendor_bill/bill?format=pdf', undefined, 3, token), f.org, 'vendor_bill', 'bill'), 401, 'unauthorized');
    const wrong = randomUUID(); await rejection(await handlers.documents(f.request('exports/documents/vendor_bill/bill?format=pdf', undefined, 3, f.sessionToken, wrong), wrong, 'vendor_bill', 'bill'), 403, 'tenant_mismatch');
    expect(fonts).not.toHaveBeenCalled(); expect(render).not.toHaveBeenCalled(); expect(ports.user).not.toHaveBeenCalled(); expect(ports.chDevice).not.toHaveBeenCalled(); expect(await f.history()).toEqual(before);
  });

  it.each(['native_flag', 'purchasing_capability', 'credential_revocation'] as const)('withholds the completed export after late %s loss without mutating the book', async change => {
    const f = await fixture(); await f.purchasing(); const before = await f.history();
    const hash = async (bytes: string | Uint8Array) => { const digest = sha(bytes); if (change === 'native_flag') ports.env.INTERNATIONAL_US_NATIVE_ADMISSION_ENABLED = 'false'; else if (change === 'purchasing_capability') ports.env.INTERNATIONAL_US_PURCHASING_V2_ENABLED = 'false'; else expect((await usDeviceHandlers.REVOKE(f.request('erp', { protocol: US_DEVICE_PROTOCOL }))).status).toBe(200); return digest; };
    const render = vi.fn<NonNullable<ExportServerDependencies['render']>>((snapshot, format, fonts) => format === 'pdf' ? renderUsExportPdf(snapshot, fonts!) : format === 'csv' ? renderUsExportCsv(snapshot) : renderUsExportHtml(snapshot));
    const handlers = createUsExportHandlers({ ...f.deps, hash, render });
    await rejection(await handlers.documents(f.request('exports/documents/vendor_bill/bill?format=csv'), f.org, 'vendor_bill', 'bill'), change === 'native_flag' ? 404 : change === 'purchasing_capability' ? 409 : 401, change === 'native_flag' ? 'feature_unavailable' : change === 'purchasing_capability' ? 'client_upgrade_required' : 'unauthorized');
    expect(render).toHaveBeenCalledOnce(); expect(await f.history()).toEqual(before);
  });

  it('requires current seller configuration, rejects legacy capability reads, and keeps closed flags ahead of all ERP/export RPCs', async () => {
    const f = await fixture('owner', 'accrual', false); await f.purchasing();
    await rejection(await usExportHandlers.documents(f.request('exports/documents/vendor_bill/bill?format=csv'), f.org, 'vendor_bill', 'bill'), 409, 'seller_configuration_required');
    await rejection(await erpHandlers.GET(f.request('erp', undefined, 1), f.org), 409, 'client_upgrade_required');
    ports.env.INTERNATIONAL_CORE_ENABLED = 'false'; f.calls.splice(0);
    await rejection(await f.send(f.payment()), 404, 'feature_unavailable');
    f.calls.splice(0); await rejection(await usExportHandlers.documents(f.request('exports/documents/vendor_bill/bill?format=pdf'), f.org, 'vendor_bill', 'bill'), 404, 'feature_unavailable'); expect(f.calls).toEqual([]);
  });
});
