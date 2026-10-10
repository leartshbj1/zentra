import { describe, expect, it, vi } from 'vitest';
import { SupabaseServerError } from '../supabase-server';

import { sha256Hex } from './canonical-hash';
import { canonicalErpJson, ErpError } from './erp-contract';
import { STRIPE_TAX_API_VERSION, type ResolvedStripeTaxRequest } from './stripe-tax-resolved-request';
import type { StripeTaxCalculationObservation } from './stripe-tax-calculation';
import { projectUsFinancialBookV5, promoteUsFinancialBookV5 } from './us-financial-kernel';
import { financialKernelFixture } from './us-financial-kernel-test-fixture';
import { executeUsFinancialKernelV5, type UsFinancialReceiptV5, type UsFinancialRequestV5 } from './us-financial-kernel-runtime';
import type { UsFinancialBookV5, UsFinancialErpCommandV5, UsFinancialTaxProofV5 } from './us-financial-kernel-types';

import type { UsFinancialTestScopeV5 } from './us-financial-test-foundation';
import { createSupabaseUsFinancialInvoicingTestStoreV5 } from './us-financial-test-invoicing';
import { createUsFinancialInvoiceTestResolverV5, usFinancialInvoiceBaseContextV5, usFinancialInvoiceSellerProfileV5, type UsFinancialInvoiceContextV5, type UsFinancialInvoiceOperationV5, type UsFinancialInvoicePreparationV5 } from './us-financial-invoice-test';
import { createSupabaseUsFinancialInvoiceTestStoreV5 } from './us-financial-invoice-test-store';
import { createUsFinancialPilotInvoiceHandlers, type UsFinancialPilotInvoiceDependencies } from './us-financial-pilot-invoice-server';
import { validateUsFinancialPilotInvoicePreview, type UsFinancialPilotInvoiceRequest, type UsFinancialPilotInvoicePreview } from './us-financial-pilot-invoice';
import { AccountPublicError } from '../account-security';
import { createBrowserUsFinancialPilotSession } from './browser-us-financial-pilot-session';
import { projectUsFinancialPilotOverview } from './us-financial-pilot-projection';

// Actual ERP/kernel, canonical tax/proof validators and both private adapters.
// The RPC transport, DB-owner admission and gateway observations are synthetic:
// this file does not prove PostgreSQL locks/atomicity or a real merchant account.
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const digest = (value: unknown) => sha256Hex(canonicalErpJson(value));
const operationId = 'a5000000-0000-4000-8000-000000000001';
const readRpc = 'zentra_read_us_financial_invoicing_test_v5', receiptRpc = 'zentra_us_financial_invoicing_test_receipt_v5', appendRpc = 'zentra_append_us_financial_invoicing_test_v5';
const operationRpc = 'zentra_read_us_financial_invoice_test_operation_v5', preflightRpc = 'zentra_preflight_us_financial_invoice_test_v5', reserveRpc = 'zentra_reserve_us_financial_invoice_test_v5', recordRpc = 'zentra_record_us_financial_invoice_test_calculation_v5';
function observation(r: ResolvedStripeTaxRequest, now: string): StripeTaxCalculationObservation {
  const line = r.params.line_items[0], tax = 2475;
  return { accountId: r.binding.accountId, mode: 'test', apiVersion: STRIPE_TAX_API_VERSION, evidenceKind: 'test_fixture', observedAt: now,
    calculation: { id: 'taxcalc_SyntheticV5', object: 'tax.calculation', amount_total: line.amount + tax, currency: 'usd', customer: null,
      customer_details: { address: { ...r.params.customer_details.address, line2: null }, address_source: r.params.customer_details.address_source, ip_address: null, tax_ids: [], taxability_override: 'none' },
      expires_at: Math.floor(Date.parse(now) / 1000) + 3600, tax_date: r.params.tax_date, livemode: false, shipping_cost: null, ship_from_details: null, tax_amount_exclusive: tax, tax_amount_inclusive: 0,
      line_items: { object: 'list', has_more: false, url: '/v1/tax/calculations/taxcalc_SyntheticV5/line_items', data: [{ id: 'tax_li_SyntheticV5', object: 'tax.calculation_line_item', amount: line.amount, amount_tax: tax, quantity: line.quantity, reference: line.reference, tax_code: line.tax_code, tax_behavior: 'exclusive', livemode: false, product: null,
        tax_breakdown: [{ amount: tax, taxable_amount: line.amount, taxability_reason: 'standard_rated', sourcing: 'destination', jurisdiction: { country: 'US', state: 'NY', level: 'state', display_name: 'Synthetic jurisdiction' }, tax_rate_details: { tax_type: 'sales_tax', display_name: 'Synthetic tax', percentage_decimal: '8.25' } }] }] },
      tax_breakdown: [{ amount: tax, taxable_amount: line.amount, taxability_reason: 'standard_rated', inclusive: false, tax_rate_details: { country: 'US', state: 'NY', tax_type: 'sales_tax', percentage_decimal: '8.25', rate_type: 'percentage', flat_amount: null } }],
    } };
}

async function httpFixture() {
  const t = await fixture(), org = t.actor.organizationId;
  const publicRequest: UsFinancialPilotInvoiceRequest = { consumer: 'financial-pilot', schemaVersion: 1, requestId: '53637900-6e5b-47a7-82e0-c655ffdef3aa', expectedRevision: t.state.book.revision,
    command: { type: 'issue_invoice', estimateId: 'estimate-2', expectedEstimateRevision: 2, date: '2026-10-10', accountingDate: '2026-10-10', dueDate: '2026-11-09', periodId: '2026' },
    choices: { classifications: [{ lineId: 'line-1', taxCode: 'txcd_99999999', confirmedService: true }], taxDateInstant: '2026-10-10T12:00:00.000Z', addressSource: 'billing' } };
  const scope = () => t.revalidate().then(current => ({ scope: current, optInVersion: 1 }));
  const context = vi.fn(async () => t.context()), verify = vi.fn(async () => {}), readTaxCode = vi.fn(async (id: string) => ({ id, name: 'Synthetic service', description: 'Synthetic test catalogue only' }));
  const port = { ...t.context().merchant, observe: async () => { throw Error('No observation provisioning in pilot'); }, gateway: { verify, calculate: t.gateway.calculate }, catalogue: { readTaxCode, listTaxCodes: vi.fn(async () => ({ taxCodes: [await readTaxCode('txcd_99999999')], hasMore: false, nextCursor: null })) } };
  const merchant = vi.fn(async () => port);
  const store = { ...t.store, head: async () => ({ consumer: 'financial-pilot' as const, schemaVersion: 1 as const, organizationId: org, revision: t.state.book.revision }) };
  const fiscal = { ...t.taxStore, context };
  const deps: UsFinancialPilotInvoiceDependencies = { enabled: vi.fn(() => true), authority: vi.fn(async () => ({ mode: 'browser' as const, actor: (await t.revalidate()).actor })),
    configuration: vi.fn(async () => t.configuration), scope: vi.fn(scope), store: vi.fn(() => store), invoiceStore: vi.fn(() => fiscal), merchant,
    operationId: () => operationId, now: t.now, allowTestFixtures: true, rateLimit: vi.fn(async () => {}), diagnostic: vi.fn() };
  const request = (path: string, value?: unknown, extra: Record<string, string> = {}) => new Request(`https://zentraapp.ch/api/international/workspaces/${org}/financial-pilot/${path}`, {
    method: value === undefined ? 'GET' : 'POST', headers: { 'X-Zentra-Financial-Pilot': '1', 'X-Zentra-Expected-User': t.actor.userId, 'Sec-Fetch-Site': 'same-origin', Origin: 'https://zentraapp.ch', ...(value === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  const handlers = () => createUsFinancialPilotInvoiceHandlers(deps);
  const prepare = () => handlers().PREPARE(request('invoices/prepare', publicRequest), org);
  const preview = async () => { const response = await prepare(); expect(response.status).toBe(200); return validateUsFinancialPilotInvoicePreview(await response.json(), org, publicRequest); };
  const issue = (review: UsFinancialPilotInvoicePreview, selected = publicRequest) => handlers().ISSUE(request('invoices/issue', { request: selected, reviewId: review.reviewId }), org);
  return { ...t, org, publicRequest, deps, store, fiscal, merchant, port, verify, readTaxCode, context, request, handlers, prepare, preview, issue };
}

describe('invoice pilot HTTP prepare/review/issue — real V5 engine, synthetic private RPC/gateway/Auth', () => {
  it('returns a presentation2 preview and prints that seller while fiscal verify retains the original S', async () => {
    const t = await httpFixture(), original = await t.context(), base = usFinancialInvoiceBaseContextV5(original), { contextSha256, ...fields } = base;
    const body = { ...fields, schemaVersion: 2 as const, presentation: { schemaVersion: 1 as const, baseContextRevision: base.revision, baseContextSha256: contextSha256,
      origin: 'financial-v5' as const, sellerRevision: 2, sellerChangeSha256: 'e'.repeat(64), profile: { displayName: 'Updated commercial seller · Zürich', contactEmail: 'commercial@example.test' } } };
    t.setContext({ ...body, contextSha256: await digest(body) });
    const preview = await t.preview(); expect(preview).toMatchObject({ schemaVersion: 2, sellerPresentation: { sellerRevision: 2, profile: body.presentation.profile }, totalMinor: '32475' });
    expect(t.verify).toHaveBeenCalledWith(expect.objectContaining({ sellerRevision: base.sellerRevision, seller: base.seller, binding: base.binding }));
    expect((await t.issue(preview)).status).toBe(200);
    expect((await projectUsFinancialBookV5(t.state.book)).invoices[1].sellerSnapshot).toEqual({ organizationId: t.org, ...body.presentation.profile });
    expect(t.gateway.calculate).toHaveBeenCalledOnce(); expect(JSON.stringify(preview)).not.toMatch(/contextSha256|sellerChangeSha256|baseContext|PRIVATE|acct_/);
  });
  it('keeps the durable calculated S/review after current S changes and replays the exact committed request', async () => {
    const t = await httpFixture(), original = await t.context(), preview = await t.preview(), prior = clone(t.state.operation!);
    const base = usFinancialInvoiceBaseContextV5(original), { contextSha256, ...fields } = base;
    const body = { ...fields, schemaVersion: 2 as const, presentation: { schemaVersion: 1 as const, baseContextRevision: base.revision, baseContextSha256: contextSha256,
      origin: 'financial-v5' as const, sellerRevision: 2, sellerChangeSha256: 'e'.repeat(64), profile: { displayName: 'New current seller' } } };
    t.setContext({ ...body, contextSha256: await digest(body) });
    const response = await t.issue(preview); expect(response.status).toBe(200); const receipt = await response.json();
    expect(t.state.operation!.preparation).toEqual(prior.preparation); expect(t.state.operation!.providerKey).toBe(prior.providerKey);
    expect((await projectUsFinancialBookV5(t.state.book)).invoices[1].sellerSnapshot).toEqual({ organizationId: t.org, ...base.seller });
    t.merchant.mockRejectedValue(Error('Synthetic later merchant closed'));
    const replay = await t.issue(preview); expect(replay.status).toBe(200); expect(await replay.json()).toEqual(receipt); expect(t.appends()).toBe(1); expect(t.gateway.calculate).toHaveBeenCalledOnce();
  });
  it('prepares durable calculation without numbering or appending, then issues once from the reviewed amount', async () => {
    const t = await httpFixture(), before = canonicalErpJson(t.state.book), preview = await t.preview();
    expect(preview).toMatchObject({ totalMinor: '32475', taxMinor: '2475', financialStatus: 'not_issued' });
    expect(canonicalErpJson(t.state.book)).toBe(before); expect(t.state.operation?.status).toBe('calculated'); expect(t.appends()).toBe(0);
    const prepared = await t.preview(); expect(prepared.reviewId).toBe(preview.reviewId); expect(t.gateway.calculate).toHaveBeenCalledOnce();
    const response = await t.issue(preview); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ action: 'issue_invoice', requestId: t.publicRequest.requestId, revision: preview.revision + 1 });
    const view = await projectUsFinancialBookV5(t.state.book); expect(view.invoices).toHaveLength(2); expect(view.invoices[1].number).toBe('SYNTHETIC-INV-000002'); expect(t.state.operation?.status).toBe('committed');
    expect(t.gateway.calculate).toHaveBeenCalledOnce(); expect(response.headers.get('Cache-Control')).toContain('no-store');
    const visible = JSON.stringify(preview); for (const hidden of ['contextSha256', 'providerKey', 'proofBody', 'PRIVATE', 'acct_', 'financialCommandHash', 'preparationSha256']) expect(visible).not.toContain(hidden);
  });
  it.each(['classifications', 'addressSource', 'taxDateInstant'] as const)('rejects changed %s for both calculated and completed historical operations', async field => {
    const t = await httpFixture(), preview = await t.preview();
    const choices = { ...t.publicRequest.choices, ...(field === 'classifications' ? { classifications: [{ lineId: 'line-1', taxCode: 'txcd_10000000', confirmedService: true as const }] } : field === 'addressSource' ? { addressSource: 'shipping' as const } : { taxDateInstant: '2026-10-10T12:00:01.000Z' }) };
    const changed = { ...t.publicRequest, choices };
    for (const committed of [false, true]) { if (committed) expect((await t.issue(preview)).status).toBe(200); const before = canonicalErpJson(t.state.book), r = await t.issue(preview, changed); expect(r.status).toBe(409); expect(await r.json()).toEqual({ error: 'tax_preparation_conflict' }); expect(canonicalErpJson(t.state.book)).toBe(before); }
  });
  it('rejects missing preparation or a different review before financial append', async () => {
    const t = await httpFixture(), absent = await t.handlers().ISSUE(t.request('invoices/issue', { request: t.publicRequest, reviewId: '0'.repeat(64) }), t.org);
    expect(absent.status).toBe(409); expect(await absent.json()).toEqual({ error: 'tax_preparation_required' });
    const preview = await t.preview(), changed = await t.issue({ ...preview, reviewId: '0'.repeat(64) }); expect(changed.status).toBe(409); expect(await changed.json()).toEqual({ error: 'tax_review_changed' }); expect(t.appends()).toBe(0);
  });
  it('replays a completed review after later payment and expired merchant without any current tax dependency', async () => {
    const t = await httpFixture(), preview = await t.preview(), original = await t.issue(preview); expect(original.status).toBe(200); const receipt = await original.json();
    await executeUsFinancialKernelV5(t.full, { idempotencyKey: 'later-payment', expectedRevision: t.state.book.revision, command: { type: 'customer_payment', id: 'later-payment', invoiceId: `pilot-invoice:${t.publicRequest.requestId}`, amountMinor: '100', paymentDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reference: 'Synthetic recorded receipt' } });
    t.advance(3600000); t.merchant.mockRejectedValue(Error('Expired private merchant')); t.merchant.mockClear(); t.verify.mockClear(); t.gateway.calculate.mockClear();
    const retry = await t.issue(preview); expect(retry.status).toBe(200); expect(await retry.json()).toEqual(receipt); expect(t.merchant).not.toHaveBeenCalled(); expect(t.verify).not.toHaveBeenCalled(); expect(t.gateway.calculate).not.toHaveBeenCalled();
  });
  it('recovers a lost financial commit response with the same review and no duplicate number', async () => {
    const t = await httpFixture(), preview = await t.preview(), commit = t.store.commit; let lost = true;
    t.store.commit = async input => { const receipt = await commit(input); if (lost) { lost = false; throw Error('Synthetic lost reply'); } return receipt; };
    expect((await t.issue(preview)).status).toBe(503); expect((await t.issue(preview)).status).toBe(200); expect((await projectUsFinancialBookV5(t.state.book)).invoices).toHaveLength(2); expect(t.gateway.calculate).toHaveBeenCalledOnce();
  });
  it('keeps the exact browser issue request after an actual commit followed by a late 409 and replays it once', async () => {
    const t = await httpFixture(), commit = t.store.commit, clock = vi.spyOn(Date, 'now').mockImplementation(() => Date.parse(t.now())), bodies: string[] = [];
    const fetcher: typeof globalThis.fetch = async (url, init) => {
      const address = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      const request = new Request(new URL(address, 'https://zentraapp.ch'), init); request.headers.set('Origin', 'https://zentraapp.ch'); request.headers.set('Sec-Fetch-Site', 'same-origin');
      if (request.url.includes('/snapshot')) return Response.json(await projectUsFinancialPilotOverview(t.state.book));
      if (new URL(request.url).pathname === `/api/international/workspaces/${t.org}/financial-pilot/tax-codes`) return t.handlers().CATALOGUE(request, t.org);
      if (request.url.endsWith('/invoices/prepare')) return t.handlers().PREPARE(request, t.org);
      if (request.url.endsWith('/invoices/issue')) { if (typeof init?.body !== 'string') throw Error('Expected captured JSON body'); bodies.push(init.body); return t.handlers().ISSUE(request, t.org); }
      throw Error('Unexpected synthetic browser request');
    };
    const session = createBrowserUsFinancialPilotSession({ organizationId: t.org, expectedUserId: t.actor.userId, fetch: fetcher, newId: () => t.publicRequest.requestId, environment: { isVisible: () => true, isOnline: () => true, subscribe: () => () => {} } });
    try {
      await session.load(); expect(await session.readTaxCodes({ code: 'txcd_99999999' })).toMatchObject({ taxCodes: [{ id: 'txcd_99999999' }] }); await session.prepareInvoice(t.publicRequest.command, t.publicRequest.choices);
      t.store.commit = async input => { const receipt = await commit(input); t.merchant.mockResolvedValue({ ...t.port, configurationFingerprint: 'e'.repeat(64) }); return receipt; };
      await expect(session.issueInvoice()).rejects.toMatchObject({ code: 'tax_binding_changed', status: 409, outcome: 'uncertain' });
      expect(t.state.operation?.status).toBe('committed'); expect(t.appends()).toBe(1); expect(session.getState()).toMatchObject({ pending: true, pendingKind: 'invoice_issue' });
      t.merchant.mockRejectedValue(Error('Synthetic closed merchant')); t.merchant.mockClear();
      await expect(session.retryInvoice()).resolves.toMatchObject({ action: 'issue_invoice', requestId: t.publicRequest.requestId });
      expect(bodies).toHaveLength(2); expect(bodies[1]).toBe(bodies[0]); expect(t.appends()).toBe(1); expect(t.gateway.calculate).toHaveBeenCalledOnce(); expect(t.merchant).not.toHaveBeenCalled(); expect(session.hasPending()).toBe(false);
    } finally { session.dispose(); clock.mockRestore(); }
  });
  it('reads catalogue only after V5 context admission and checks code/cursor grammar', async () => {
    const t = await httpFixture(); expect((await t.handlers().CATALOGUE(t.request('tax-codes?code=txcd_99999999'), t.org)).status).toBe(200); expect(t.context.mock.invocationCallOrder[0]).toBeLessThan(t.verify.mock.invocationCallOrder[0]);
    for (const q of ['code=wrong', 'cursor=wrong', 'code=txcd_99999999&code=txcd_99999999', 'code=txcd_99999999&cursor=txcd_99999999', 'secret=1']) expect((await t.handlers().CATALOGUE(t.request(`tax-codes?${q}`), t.org)).status).toBe(422);
    expect(t.gateway.calculate).not.toHaveBeenCalled(); expect(t.appends()).toBe(0);
  });
  it.each(['prepare', 'catalogue'] as const)('rejects accessor catalogue data without invoking getters during %s', async path => {
    const t = await httpFixture(), getter = vi.fn(() => 'txcd_99999999');
    t.readTaxCode.mockImplementation(async () => Object.defineProperty({ name: 'Synthetic service', description: 'Synthetic only' }, 'id', { enumerable: true, get: getter }) as { id: string; name: string; description: string });
    const response = path === 'prepare' ? await t.prepare() : await t.handlers().CATALOGUE(t.request('tax-codes?code=txcd_99999999'), t.org);
    expect(response.status).toBe(503); expect(getter).not.toHaveBeenCalled(); expect(t.gateway.calculate).not.toHaveBeenCalled(); expect(t.appends()).toBe(0);
  });
  it('captures provider data before post-provider authority awaits can mutate it', async () => {
    const t = await httpFixture(), code = { id: 'txcd_99999999', name: 'Synthetic captured name', description: 'Synthetic only' }; let delivered = false;
    t.readTaxCode.mockImplementation(async () => { delivered = true; return code; });
    const authority = t.deps.authority; t.deps.authority = async (...args) => { if (delivered) code.name = 'PRIVATE mutated during revalidation'; return authority(...args); };
    const response = await t.handlers().CATALOGUE(t.request('tax-codes?code=txcd_99999999'), t.org); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ taxCodes: [{ name: 'Synthetic captured name' }] });
  });
  it('rejects an accessor merchant identity without invoking its getter', async () => {
    const t = await httpFixture(), getter = vi.fn(() => t.port.credential);
    t.merchant.mockResolvedValue(Object.defineProperty({ ...t.port }, 'credential', { enumerable: true, get: getter }));
    expect((await t.prepare()).status).toBe(503); expect(getter).not.toHaveBeenCalled(); expect(t.appends()).toBe(0);
  });
  it('checks choices again when a competing pending operation appears during resolver read', async () => {
    const t = await httpFixture(); await t.preview(); const existing = clone(t.state.operation!), read = t.fiscal.read.bind(t.fiscal); let calls = 0;
    t.fiscal.read = async (...args) => { if (++calls === 1) return null; return read(...args); };
    const changed = { ...t.publicRequest, choices: { ...t.publicRequest.choices, taxDateInstant: '2026-10-10T12:00:01.000Z' } };
    const response = await t.handlers().PREPARE(t.request('invoices/prepare', changed), t.org); expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: 'tax_preparation_conflict' }); expect(t.state.operation).toEqual(existing); expect(t.appends()).toBe(0); expect(t.gateway.calculate).toHaveBeenCalledOnce();
  });
  it.each([401, 402, 403])('prioritizes live authority loss after a rejected context read (%s)', async status => {
    const t = await httpFixture(); let lost = false;
    t.fiscal.context.mockImplementation(async () => { lost = true; throw Error('PRIVATE rejected context'); });
    t.deps.authority = async () => { if (lost) throw new AccountPublicError('Synthetic access loss', status); return { mode: 'browser', actor: t.actor }; };
    const response = await t.handlers().CATALOGUE(t.request('tax-codes'), t.org); expect(response.status).toBe(status); expect(Object.keys(await response.json() as object)).toEqual(['error']); expect(t.merchant).not.toHaveBeenCalled();
  });
  it.each(['grant', 'optIn', 'policy', 'configuration'] as const)('rejects changed %s around fiscal work', async kind => {
    const t = await httpFixture(); let changed = false;
    const factory = t.deps.invoiceStore; t.deps.invoiceStore = (...args) => { changed = true; return factory(...args); };
    t.deps.scope = async () => ({ scope: { ...t.scope, actor: t.actor, grantVersion: changed && kind === 'grant' ? 2 : 1, policy: changed && kind === 'policy' ? { ...t.policy, approval: { ...t.policy.approval, reference: 'Synthetic changed policy' } } : t.policy }, optInVersion: changed && kind === 'optIn' ? 2 : 1 });
    t.deps.configuration = async () => changed && kind === 'configuration' ? { ...t.configuration, language: 'fr' } : t.configuration;
    const response = await t.prepare(); expect(response.status).toBe(409); expect(t.gateway.calculate).not.toHaveBeenCalled(); expect(t.appends()).toBe(0);
  });
  it('rechecks dedicated credential identity at financial commit after preparation', async () => {
    const t = await httpFixture(), preview = await t.preview(), read = t.store.read; let calls = 0;
    t.store.read = async org => { const book = await read(org); if (++calls === 2) t.merchant.mockResolvedValue({ ...t.port, configurationFingerprint: 'e'.repeat(64) }); return book; };
    const response = await t.issue(preview); expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: 'tax_binding_changed' }); expect(t.appends()).toBe(0);
  });
  it('closes device auth, public ERP headers, foreign origin and private input fields', async () => {
    const t = await httpFixture();
    for (const [value, extra, expected] of [[t.publicRequest, { Authorization: 'Bearer synthetic' }, 403], [t.publicRequest, { Origin: 'https://evil.test' }, 403], [{ ...t.publicRequest, policy: t.policy }, {}, 422]] as const) expect((await t.handlers().PREPARE(t.request('invoices/prepare', value, extra), t.org)).status).toBe(expected);
    expect(t.appends()).toBe(0); expect(t.gateway.calculate).not.toHaveBeenCalled();
  });
});
async function fixture(options: Readonly<{ allowFixtures?: boolean; role?: 'owner' | 'admin' | 'accountant' }> = {}) {
  const raw = await financialKernelFixture(), data = JSON.parse(JSON.stringify(raw).replaceAll(raw.actor.organizationId, '0a7ec0b8-a465-4df9-b756-e99aca4439ce')) as typeof raw, actor = { ...data.actor, role: options.role ?? data.actor.role };
  let time = Date.parse(actor.timestamp), revoked = false, grantVersion = 1;
  const now = () => new Date(time).toISOString();
  const scope: UsFinancialTestScopeV5 = { organizationId: actor.organizationId, actor, policy: data.policy, grantVersion };
  const state: { book: UsFinancialBookV5; operation: UsFinancialInvoiceOperationV5 | null; receipts: Map<string, unknown>; gate: Error | null } = { book: await promoteUsFinancialBookV5(data.baseline, data.policy, data.actor), operation: null, receipts: new Map(), gate: null };
  const hooks = new Map<string, () => unknown>(), transforms = new Map<string, (value: unknown) => unknown>();
  async function fire(phase: string) { const fn = hooks.get(phase); if (fn) { hooks.delete(phase); await fn(); } }
  const revalidate = vi.fn(async () => { if (revoked) throw new ErpError('session_changed', 401); return { ...scope, actor: { ...actor, timestamp: now() }, grantVersion }; });
  const c = { schemaVersion: 1 as const, organizationId: actor.organizationId, revision: 1, countryRevision: 1, configuration: data.configuration, sellerRevision: 1, seller: { displayName: 'Synthetic V5 seller', contactEmail: 'seller@example.test' }, taxFactsRevision: 1,
    taxFacts: { schemaVersion: 1 as const, legalName: 'PRIVATE SYNTHETIC LEGAL NAME', taxOrigin: data.configuration.address as Extract<typeof data.configuration.address, { country: 'US' }>, timeZone: data.configuration.timeZone },
    binding: { organizationId: actor.organizationId, accountId: 'acct_SyntheticV5', mode: 'test' as const, apiVersion: STRIPE_TAX_API_VERSION, revision: 1, settingsSha256: 'b'.repeat(64), registrationsSha256: 'c'.repeat(64), observedAt: new Date(time - 30_000).toISOString(), validUntil: new Date(time + 90_000).toISOString(), evidenceKind: 'test_fixture' as const, scope: 'erp_invoice_tax' as const },
    merchant: { credential: { reference: 'synthetic-test-key-reference', revision: 1, accountId: 'acct_SyntheticV5' }, configurationFingerprint: 'd'.repeat(64) }, admittedBy: 'synthetic-db-owner-only-not-service', admittedAt: now() };
  let context: UsFinancialInvoiceContextV5 = { ...c, contextSha256: await digest(c) };
  const rpc = vi.fn(async (name: string, args: Readonly<Record<string, unknown>>): Promise<unknown> => {
    await fire(name); let result: unknown;
    if (name === readRpc || name === 'zentra_read_us_financial_accounting_test_v5') result = state.book;
    else if (name === receiptRpc || name === 'zentra_us_financial_accounting_test_receipt_v5') result = state.receipts.get(args.p_idempotency_key as string) ?? null;
    else if (name === appendRpc) {
      if (args.p_expected_revision !== state.book.revision || args.p_previous_fingerprint !== await digest(state.book)) throw new SupabaseServerError(409, 'PF001', 'Synthetic CAS refusal');
      const next = args.p_book as UsFinancialBookV5, receipt = args.p_receipt as UsFinancialReceiptV5, event = next.events.at(-1)!;
      if (event.operation.type === 'erp_command' && event.operation.command.type === 'issue_invoice') {
        if (state.gate) throw state.gate;
        if (!state.operation || state.operation.status !== 'calculated' || state.operation.preparation.financialCommandHash !== receipt.commandHash || canonicalErpJson(event.operation.facts) !== canonicalErpJson({ kind: 'invoice_issuance', sellerSnapshot: { organizationId: actor.organizationId, ...usFinancialInvoiceSellerProfileV5(state.operation.preparation.context) }, taxAssessment: state.operation.assessment })) throw new SupabaseServerError(503, 'PX005', 'Synthetic absent evidence');
        state.operation = { ...state.operation, status: 'committed', receipt };
      }
      state.book = clone(next); state.receipts.set(receipt.idempotencyKey, { origin: 'financial_v5', actorId: receipt.actorId, receipt }); result = receipt;
    } else if (name === operationRpc) {
      if (state.operation && (state.operation.preparation.financialCommandHash !== args.p_financial_command_hash || state.operation.preparation.erpCommandHash !== args.p_erp_command_hash)) throw new SupabaseServerError(409, 'PF002', 'Synthetic key conflict');
      result = state.operation;
    } else if (name === preflightRpc) {
      if (state.gate) throw state.gate;
      const request = args.p_request as UsFinancialRequestV5, view = await projectUsFinancialBookV5(state.book);
      if (request.expectedRevision !== state.book.revision || args.p_previous_fingerprint !== await digest(state.book)) throw new SupabaseServerError(409, 'PF001', 'Synthetic source changed');
      if (request.command.type !== 'erp_command' || request.command.request.type !== 'issue_invoice') throw Error('Synthetic expected invoice request');
      const command = request.command.request;
      result = { context: state.operation?.preparation.context ?? context, estimate: view.estimates.find(e => e.id === command.estimateId), bookRevision: state.book.revision, bookFingerprint: await digest(state.book) };
    } else if (name === reserveRpc) {
      const p = args.p_preparation as UsFinancialInvoicePreparationV5;
      if (!state.operation) state.operation = { schemaVersion: 1, organizationId: actor.organizationId, operationId, status: 'reserved', preparation: p, resolvedBody: args.p_resolved_body as string, resolvedSha256: args.p_resolved_sha256 as string, paramsBody: args.p_params_body as string, paramsSha256: args.p_params_sha256 as string, providerKey: args.p_provider_idempotency_key as string, reservedAt: now(), retryUntil: new Date(time + 23 * 3_600_000).toISOString(), proofBody: null, proofSha256: null, assessment: null, receipt: null };
      result = state.operation;
    } else if (name === recordRpc) {
      if (!state.operation) throw Error('Synthetic missing reservation');
      state.operation = { ...state.operation, status: 'calculated', proofBody: args.p_proof_body as string, proofSha256: args.p_proof_sha256 as string, assessment: args.p_assessment as UsFinancialInvoiceOperationV5['assessment'] }; result = state.operation;
    } else throw Error(`Unexpected synthetic RPC ${name}`);
    await fire(`${name}:after`); const transform = transforms.get(name); return clone(transform ? transform(result) : result);
  });
  const store = createSupabaseUsFinancialInvoicingTestStoreV5({ rpc }, scope, revalidate);
  const resolveTax = vi.fn(async ({ candidate, idempotencyKey }: { candidate: { invoiceFingerprint: string; allocationSha256: string; allocation: { taxMinor: string } }; idempotencyKey: string }): Promise<UsFinancialTaxProofV5> => ({ schemaVersion: 1, environment: 'test', kind: 'test_adjustment_authorization', invoiceFingerprint: candidate.invoiceFingerprint, allocationSha256: candidate.allocationSha256, reference: 'SYNTHETIC LOCAL PLAN', verifiedBy: 'synthetic-reviewer', verifiedAt: now(), providerAccountReference: 'acct_SyntheticV5', originalTaxTransactionReference: `testtxn_${candidate.invoiceFingerprint}`, adjustmentPlanReference: `testplan_${idempotencyKey}`, authorizedTaxMinor: candidate.allocation.taxMinor }));
  const deps = { ...data, actor, store, resolveTax, revalidate: async () => ({ configuration: data.configuration, actor: (await revalidate()).actor, policy: data.policy }) };
  const send = (key: string, command: UsFinancialErpCommandV5) => executeUsFinancialKernelV5(deps, { idempotencyKey: key, expectedRevision: state.book.revision, command: { type: 'erp_command', request: command } });
  await send('new-quote', { type: 'save_estimate', id: 'estimate-2', expectedEstimateRevision: 0, customerId: 'customer-1', date: '2026-10-10', expiresAt: '2026-11-10', paymentTermsDays: 30, lines: data.baseline.estimates[0].lines, notes: 'Synthetic new invoice source' });
  await send('accept-new-quote', { type: 'accept_estimate', estimateId: 'estimate-2', expectedEstimateRevision: 1 });
  const taxStore = createSupabaseUsFinancialInvoiceTestStoreV5({ rpc }, scope, revalidate, { allowTestFixtures: options.allowFixtures ?? true });
  const choices = vi.fn(async () => ({ classifications: [{ lineId: 'line-1', taxCode: 'txcd_99999999', kind: 'service' as const, taxBehavior: 'exclusive' as const }], taxDateInstant: '2026-10-10T12:00:00.000Z', addressSource: 'billing' as const }));
  const gateway = { calculate: vi.fn(async (r: ResolvedStripeTaxRequest) => { await fire('calculate'); return observation(r, now()); }) };
  const resolverDependencies = { scope, revalidate, store: taxStore, choices, gateway, operationId: () => operationId, now, allowTestFixtures: options.allowFixtures ?? true };
  const resolver = createUsFinancialInvoiceTestResolverV5(resolverDependencies);
  const full = { ...deps, resolveIssuance: resolver };
  const command: Extract<UsFinancialErpCommandV5, { type: 'issue_invoice' }> = { type: 'issue_invoice', id: 'invoice-2', estimateId: 'estimate-2', expectedEstimateRevision: 2, date: '2026-10-10', accountingDate: '2026-10-10', dueDate: '2026-11-09', periodId: '2026' };
  const request: UsFinancialRequestV5 = { idempotencyKey: 'issue-new', expectedRevision: state.book.revision, command: { type: 'erp_command', request: command } };
  rpc.mockClear(); revalidate.mockClear();
  return { ...data, actor, scope, state, rpc, store, taxStore, choices, gateway, resolver, resolverDependencies, full, command, request, hooks, transforms, revalidate, send, now,
    issue: () => executeUsFinancialKernelV5(full, request), revoke: () => { revoked = true; }, changeGrant: () => { grantVersion += 1; }, advance: (ms: number) => { time += ms; },
    setContext: (value: UsFinancialInvoiceContextV5) => { context = value; }, context: () => clone(context),
    appends: () => rpc.mock.calls.filter(([name]) => name === appendRpc).length,
  };
}


