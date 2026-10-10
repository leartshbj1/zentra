import { describe, expect, it, vi } from 'vitest';
import { AccountPublicError } from '../account-security';
import type { FinancialAuthority } from './accounting/ledger';
import { canonicalErpJson, ErpError } from './erp-contract';
import type { ErpSchemaVersion } from './erp-schema-capability';
import { getUsExportFonts } from './export-fonts';
import type { CompanyConfiguration } from './types';
import { summarizeUsSalesOrder, validateUsSalesOrderRecord, type UsSalesOrderReceipt, type UsSalesOrderRecord, type UsSalesOrderRequest, type UsSalesOrderStore } from './us-sales-order-contract';
import { createUsSalesOrderHandlers, type UsSalesOrderServerDependencies } from './us-sales-order-server';
import { createBrowserUsSalesOrderSession } from './browser-us-sales-order-session';

const org = '3a000000-0000-4000-8000-000000000001', otherOrg = '3a000000-0000-4000-8000-000000000002';
const user = '3a000000-0000-4000-8000-000000000003', id = '3a000000-0000-4000-8000-000000000004';
const actor: FinancialAuthority = { organizationId: org, userId: user, role: 'owner', managementEntitled: true, timestamp: '2026-10-10T12:00:00.000Z' };
const configuration: CompanyConfiguration = { schemaVersion: 1, organizationId: org, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York', address: { country: 'US', line1: '1 Fictitious Street', city: 'New York', subdivision: 'NY', postalCode: '10001' }, accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'unconfigured' }, ein: '12-3456789' };
const { ein: _privateEin, ...publicConfiguration } = configuration;
const initial: UsSalesOrderRecord = validateUsSalesOrderRecord({ order: {
  schemaVersion: 1, organizationId: org, id, sequence: 1, number: 'SO-000001', revision: 1, state: 'draft', sourceErpRevision: 10,
  sourceEstimate: { id: 'estimate', organizationId: org, revision: 2, currency: 'USD', number: 'EST-000001', customer: { id: 'customer', organizationId: org, kind: 'business', name: 'Fictitious Harbor LLC', billingAddress: configuration.address, contactName: 'Alex Demo', email: 'demo@example.test', paymentTermsDays: 30 }, date: '2026-10-01', expiresAt: '2026-11-01', paymentTermsDays: 30, lines: [{ id: 'line', description: 'Fictitious consulting', quantityUnits: '125', quantityScale: 2, unitPrice: { currency: 'USD', minorUnits: '10000' }, discountBasisPoints: 500, taxTreatment: 'taxable' }], notes: 'Fictitious terms\nSecond line', status: 'accepted' },
  companyConfiguration: publicConfiguration, sellerSnapshot: { organizationId: org, displayName: 'Fictitious Seller LLC', contactEmail: 'seller@example.test' }, orderDate: '2026-10-10', customerReference: null, createdBy: user, createdAt: actor.timestamp, confirmation: null, cancellation: null,
}, invoice: null }, org);
const create: UsSalesOrderRequest = { schemaVersion: 1, idempotencyKey: 'fictitious-create', orderId: id, expectedErpRevision: 10, expectedHeadRevision: 0, expectedOrderRevision: null, command: { type: 'create_from_estimate', estimateId: 'estimate', expectedEstimateRevision: 2, orderDate: '2026-10-10', customerReference: null } };

/** Actual HTTP validation/export with local admission and a deliberately tiny
 * RAM receipt port. Independent PostgreSQL tests prove the SQL state machine,
 * source locking and durable atomicity; this fixture does not claim those. */
function fixture(mode: 'browser' | 'device' = 'browser') {
  let record: UsSalesOrderRecord | null = null, headRevision = 0, erpRevision = 10;
  const receipts = new Map<string, UsSalesOrderReceipt>();
  const store: UsSalesOrderStore = {
    head: vi.fn(async () => ({ schemaVersion: 1 as const, organizationId: org, headRevision, erpRevision })),
    source: vi.fn(async (_actor, estimateId) => ({ schemaVersion: 1 as const, organizationId: org, erpRevision, estimateId, estimateRevision: estimateId === 'estimate' ? 2 : null, activeOrderId: estimateId === 'estimate' && record?.order.state !== 'cancelled' ? record?.order.id ?? null : null, invoiceId: null, status: estimateId === 'estimate' ? 'accepted' as const : 'missing' as const })),
    list: vi.fn(async (_actor, beforeSequence = null) => ({ schemaVersion: 1 as const, organizationId: org, headRevision, erpRevision, total: record ? 1 : 0, orders: record && (beforeSequence === null || record.order.sequence < beforeSequence) ? [summarizeUsSalesOrder(record)] : [], nextBeforeSequence: null })),
    read: vi.fn(async (_actor, selected) => selected === id ? structuredClone(record) : null),
    receipt: vi.fn(async (_actor, key) => structuredClone(receipts.get(key) ?? null)),
    execute: vi.fn(async (admitted, input, hash) => {
      if (input.expectedErpRevision !== erpRevision) throw new ErpError('sales_order_erp_revision_conflict', 409);
      if (input.expectedHeadRevision !== headRevision || input.expectedOrderRevision !== (record?.order.revision ?? null)) throw new ErpError('sales_order_revision_conflict', 409);
      if (input.command.type === 'create_from_estimate') record = structuredClone(initial);
      else if (input.command.type === 'confirm') record = { order: { ...record!.order, revision: record!.order.revision + 1, state: 'confirmed', confirmation: { reference: input.command.reference, confirmedBy: admitted.userId, confirmedAt: admitted.timestamp } }, invoice: null };
      else record = { order: { ...record!.order, revision: record!.order.revision + 1, state: 'cancelled', cancellation: { reason: input.command.reason, cancelledBy: admitted.userId, cancelledAt: admitted.timestamp } }, invoice: null };
      headRevision++;
      const receipt: UsSalesOrderReceipt = { schemaVersion: 1, organizationId: org, idempotencyKey: input.idempotencyKey, commandHash: hash, actorId: admitted.userId, orderId: input.orderId, action: input.command.type, revision: (input.expectedOrderRevision ?? 0) + 1, headRevision, erpRevision, sequence: 1 };
      receipts.set(input.idempotencyKey, receipt); return { receipt: structuredClone(receipt), replayed: false };
    }),
  };
  const dependencies: UsSalesOrderServerDependencies = {
    enabled: vi.fn(() => true), newOrdersEnabled: vi.fn(() => true),
    authority: vi.fn(async () => ({ mode, actor: structuredClone(actor) })), configuration: vi.fn(async () => structuredClone(configuration)),
    store: vi.fn(() => { throw new Error('Full ERP read/commit is forbidden in the HTTP gateway'); }), freshSupportedSchemaVersion: vi.fn(() => 4 as ErpSchemaVersion),
    salesOrderStore: vi.fn(() => store), rateLimit: vi.fn(async () => undefined), diagnostic: vi.fn(), fonts: getUsExportFonts,
  };
  const handlers = createUsSalesOrderHandlers(dependencies), url = `https://zentra.test/api/international/workspaces/${org}/sales-orders`;
  const headers = (extra: Record<string, string> = {}) => ({ 'X-Zentra-Erp-Schema-Version': '4', 'X-Zentra-Expected-User': user, ...(mode === 'device' ? { Authorization: 'Bearer fictitious-device' } : {}), ...extra });
  const get = (query = '', extra: Record<string, string> = {}) => new Request(url + query, { headers: headers(extra) });
  const post = (input: unknown = create, extra: Record<string, string> = {}) => new Request(url, { method: 'POST', headers: headers({ Origin: 'https://zentra.test', 'Content-Type': 'application/json', ...extra }), body: JSON.stringify(input) });
  return { handlers, dependencies, store, receipts, get, post, record: () => record, head: () => headRevision,
    seed: () => { record = structuredClone(initial); headRevision = 1; }, replace: (value: UsSalesOrderRecord | null) => { record = value; }, advanceErp: () => { erpRevision++; } };
}
async function rejected(response: Response, code: string, status: number) {
  expect(response.status).toBe(status); expect(await response.json()).toEqual({ error: code });
  expect(response.headers.get('Cache-Control')).toContain('no-store'); expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff'); expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
}
const confirm: UsSalesOrderRequest = { ...create, idempotencyKey: 'fictitious-confirm', expectedHeadRevision: 1, expectedOrderRevision: 1, command: { type: 'confirm', reference: 'Fictitious internal approval' } };
const cancel: UsSalesOrderRequest = { ...confirm, idempotencyKey: 'fictitious-cancel', command: { type: 'cancel', reason: 'Fictitious revised scope' } };

describe('isolated US sales order HTTP', () => {
  it('reads a bounded page, compact head and scoped detail without the full financial book', async () => {
    const t = fixture(); expect(await (await t.handlers.GET(t.get(), org)).json()).toEqual({ schemaVersion: 1, organizationId: org, headRevision: 0, erpRevision: 10, total: 0, orders: [], nextBeforeSequence: null });
    t.seed(); expect(await (await t.handlers.GET(t.get('?head=1'), org)).json()).toEqual({ schemaVersion: 1, organizationId: org, headRevision: 1, erpRevision: 10 });
    expect(await (await t.handlers.DETAIL(t.get(), org, id)).json()).toEqual({ schemaVersion: 1, organizationId: org, record: initial });
    expect(await (await t.handlers.GET(t.get('?beforeSequence=1'), org)).json()).toMatchObject({ total: 1, orders: [] });
    expect(t.dependencies.store).not.toHaveBeenCalled(); expect(t.store.execute).not.toHaveBeenCalled();
  });
  it('reads the real scoped source lookup independently from the current order page', async () => {
    const t = fixture();
    expect(await (await t.handlers.GET(t.get('?estimateId=estimate'), org)).json()).toEqual({ schemaVersion: 1, organizationId: org, erpRevision: 10, estimateId: 'estimate', estimateRevision: 2, activeOrderId: null, invoiceId: null, status: 'accepted' });
    t.seed(); expect(await (await t.handlers.GET(t.get('?estimateId=estimate'), org)).json()).toMatchObject({ activeOrderId: id });
    expect(await (await t.handlers.GET(t.get('?estimateId=missing'), org)).json()).toMatchObject({ estimateRevision: null, status: 'missing' });
    expect(t.store.list).not.toHaveBeenCalled(); expect(t.dependencies.store).not.toHaveBeenCalled();
  });
  it('creates and internally confirms with exact reference-only envelopes and fresh timestamps', async () => {
    const t = fixture(); let n = 0;
    t.dependencies.authority = async () => ({ mode: 'browser', actor: { ...actor, timestamp: new Date(Date.parse(actor.timestamp) + n++ * 1000).toISOString() } });
    expect(await (await t.handlers.POST(t.post(), org)).json()).toMatchObject({ receipt: { action: 'create_from_estimate', revision: 1, headRevision: 1 }, replayed: false });
    expect(await (await t.handlers.POST(t.post(confirm), org)).json()).toMatchObject({ receipt: { action: 'confirm', revision: 2, headRevision: 2 }, replayed: false });
    const call = vi.mocked(t.store.execute).mock.calls[1]; expect(call[0].timestamp).not.toBe(actor.timestamp); expect(call[1]).toEqual(confirm);
    expect(t.record()?.order.confirmation?.confirmedAt).toBe(call[0].timestamp); expect(t.dependencies.store).not.toHaveBeenCalled();
  });
  it.each(['owner', 'admin', 'accountant', 'member'] as const)('allows current Gestion %s without Automation admission', async role => {
    const t = fixture(); t.dependencies.authority = async () => ({ mode: 'browser', actor: { ...actor, role } });
    expect((await t.handlers.POST(t.post(), org)).status).toBe(200); expect(t.store.execute).toHaveBeenCalledTimes(1);
  });
  it('keeps read-only history visible while denying mutations before receipts', async () => {
    const t = fixture(); t.seed(); t.dependencies.authority = async () => ({ mode: 'browser', actor: { ...actor, role: 'read_only' } });
    expect((await t.handlers.GET(t.get(), org)).status).toBe(200); expect((await t.handlers.DETAIL(t.get(), org, id)).status).toBe(200);
    expect((await t.handlers.EXPORT(t.get('?format=html&revision=1'), org, id)).status).toBe(200);
    await rejected(await t.handlers.POST(t.post(), org), 'sales_order_permission_required', 403); expect(t.store.receipt).not.toHaveBeenCalled();
  });
  it('recovers exact committed receipts after ERP advances and new-order gate closes', async () => {
    const t = fixture(); const first = await (await t.handlers.POST(t.post(), org)).json() as object; t.advanceErp(); t.dependencies.newOrdersEnabled = () => false;
    expect(await (await t.handlers.POST(t.post(), org)).json()).toEqual({ ...first, replayed: true }); expect(t.store.execute).toHaveBeenCalledTimes(1);
    await rejected(await t.handlers.POST(t.post({ ...create, command: { ...create.command, customerReference: 'changed' } }), org), 'sales_order_idempotency_conflict', 409);
  });
  it('preserves history and cancellation when creation/confirmation is paused', async () => {
    const t = fixture(); t.dependencies.newOrdersEnabled = () => false;
    await rejected(await t.handlers.POST(t.post(), org), 'sales_orders_paused', 409); expect(t.store.execute).not.toHaveBeenCalled();
    t.seed(); expect((await t.handlers.GET(t.get(), org)).status).toBe(200);
    await rejected(await t.handlers.POST(t.post(confirm), org), 'sales_orders_paused', 409);
    expect((await t.handlers.POST(t.post(cancel), org)).status).toBe(200); expect(t.record()?.order.state).toBe('cancelled');
  });
  it('withholds a committed response after a new-order pause then recovers the same receipt', async () => {
    const t = fixture(), execute = t.store.execute; let paused = false;
    t.dependencies.newOrdersEnabled = () => !paused; t.store.execute = async (...args) => { const result = await execute(...args); paused = true; return result; };
    await rejected(await t.handlers.POST(t.post(), org), 'service_unavailable', 503); expect(t.head()).toBe(1);
    expect(await (await t.handlers.POST(t.post(), org)).json()).toMatchObject({ replayed: true, receipt: { headRevision: 1 } }); expect(t.head()).toBe(1);
  });
  it.each([1, 2, 3])('denies protocol %s before private storage', async version => {
    const t = fixture(); await rejected(await t.handlers.GET(t.get('', { 'X-Zentra-Erp-Schema-Version': String(version) }), org), 'sales_order_upgrade_required', 409); expect(t.dependencies.salesOrderStore).not.toHaveBeenCalled();
  });
  it('closes both gates before Auth and denies stale server capability', async () => {
    const t = fixture(); t.dependencies.enabled = () => false;
    await rejected(await t.handlers.GET(t.get(), org), 'feature_unavailable', 404); expect(t.dependencies.authority).not.toHaveBeenCalled();
    t.dependencies.enabled = () => true; t.dependencies.freshSupportedSchemaVersion = () => 3;
    await rejected(await t.handlers.GET(t.get(), org), 'sales_order_upgrade_required', 409); expect(t.dependencies.salesOrderStore).not.toHaveBeenCalled();
  });
  it.each(['?limit=25', '?beforeSequence=1&beforeSequence=2', '?beforeSequence=0', '?beforeSequence=-1', '?beforeSequence=1.5', '?beforeSequence=9007199254740991', '?head=0', '?head=1&beforeSequence=2', '?head=1&head=1', '?estimateId=', '?estimateId=a&estimateId=b', '?estimateId=a&beforeSequence=2', '?estimateId=a&head=1', '?estimateId=%00'])('validates exact pagination query %s', async query => {
    const t = fixture(); await rejected(await t.handlers.GET(t.get(query), org), 'invalid_request', 422); expect(t.dependencies.salesOrderStore).not.toHaveBeenCalled();
  });
  it('requires same-origin browser writes but accepts independently admitted native Auth', async () => {
    const t = fixture(); await rejected(await t.handlers.POST(t.post(create, { Origin: 'https://evil.test' }), org), 'forbidden', 403); expect(t.store.execute).not.toHaveBeenCalled();
    const d = fixture('device'), request = d.post(); request.headers.delete('Origin'); expect((await d.handlers.POST(request, org)).status).toBe(200);
    const missing = d.get(); missing.headers.delete('Authorization'); await rejected(await d.handlers.GET(missing, org), 'unauthorized', 401);
    await rejected(await t.handlers.GET(t.get('', { Authorization: 'Bearer fictitious' }), org), 'unauthorized', 401);
  });
  it('binds company, identity and Gestion subscription before private data', async () => {
    const t = fixture(); await rejected(await t.handlers.GET(t.get('', { 'X-Zentra-Expected-User': 'someone-else' }), org), 'session_changed', 401);
    await rejected(await t.handlers.GET(t.get(), otherOrg), 'tenant_mismatch', 403);
    t.dependencies.authority = async () => ({ mode: 'browser', actor: { ...actor, managementEntitled: false } });
    await rejected(await t.handlers.GET(t.get(), org), 'management_entitlement_required', 402); expect(t.dependencies.salesOrderStore).not.toHaveBeenCalled();
  });
  it.each([{ sellerSnapshot: {} }, { amount: '1' }, { sourceEstimate: initial.order.sourceEstimate }, { actor }, { orderId: 'not-a-uuid' }, { command: { type: 'confirm', reference: '' } }])('rejects browser-supplied snapshots or malformed references %j', async patch => {
    const t = fixture(); await rejected(await t.handlers.POST(t.post({ ...create, ...patch }), org), 'invalid_sales_order_request', 422); expect(t.store.execute).not.toHaveBeenCalled();
  });
  it('bounds body bytes and validates method, path and detail queries', async () => {
    const t = fixture(); await rejected(await t.handlers.POST(t.post({ ...create, filler: 'é'.repeat(5000) }), org), 'invalid_request', 413);
    await rejected(await t.handlers.GET(t.post(), org), 'method_not_allowed', 405);
    await rejected(await t.handlers.GET(t.get(), 'invalid-company'), 'invalid_request', 422);
    await rejected(await t.handlers.DETAIL(t.get('?head=1&revision=1'), org, id), 'invalid_request', 422);
    await rejected(await t.handlers.DETAIL(t.get(), org, 'bad-id'), 'invalid_request', 422);
    await rejected(await t.handlers.DETAIL(t.get(), org, id), 'sales_order_not_found', 404);
  });
  it.each(['factory', 'list', 'head', 'source', 'detail', 'receipt', 'execute'] as const)('does not disclose late private %s results after Auth revocation', async step => {
    const t = fixture(); t.seed(); let revoked = false;
    t.dependencies.authority = async () => { if (revoked) throw new AccountPublicError('PRIVATE_FICTITIOUS_AUTH_DETAIL', 401); return { mode: 'browser', actor }; };
    if (step === 'factory') t.dependencies.salesOrderStore = async () => { revoked = true; return t.store; };
    if (step === 'list') { const read = t.store.list; t.store.list = async (...args) => { const value = await read(...args); revoked = true; return value; }; }
    if (step === 'head') { const read = t.store.head; t.store.head = async (...args) => { const value = await read(...args); revoked = true; return value; }; }
    if (step === 'source') { const read = t.store.source; t.store.source = async (...args) => { const value = await read(...args); revoked = true; return value; }; }
    if (step === 'detail') { const read = t.store.read; t.store.read = async (...args) => { const value = await read(...args); revoked = true; return value; }; }
    if (step === 'receipt') t.store.receipt = async () => { revoked = true; return null; };
    if (step === 'execute') { const execute = t.store.execute; t.store.execute = async (...args) => { const value = await execute(...args); revoked = true; return value; }; }
    const response = step === 'head' ? await t.handlers.GET(t.get('?head=1'), org) : step === 'source' ? await t.handlers.GET(t.get('?estimateId=estimate'), org) : step === 'detail' ? await t.handlers.DETAIL(t.get(), org, id) : ['receipt', 'execute'].includes(step) ? await t.handlers.POST(t.post(confirm), org) : await t.handlers.GET(t.get(), org);
    await rejected(response, 'unauthorized', 401); expect(JSON.stringify(vi.mocked(t.dependencies.diagnostic!).mock.calls)).not.toContain('PRIVATE_FICTITIOUS');
    if (step !== 'execute') expect(t.store.execute).not.toHaveBeenCalled();
  });
  it.each(['configuration', 'capability', 'base-gate', 'new-gate'] as const)('prioritizes live rights loss during a failed %s await', async fault => {
    const t = fixture(); let revoked = false, reads = 0;
    t.dependencies.authority = async () => { if (revoked) throw new AccountPublicError('PRIVATE_FICTITIOUS_AUTH', 403); return { mode: 'browser', actor }; };
    if (fault === 'configuration') t.dependencies.configuration = async () => { if (++reads > 1) { revoked = true; throw new Error('PRIVATE_CONFIG'); } return configuration; };
    if (fault === 'capability') t.dependencies.freshSupportedSchemaVersion = async () => { revoked = true; throw new Error('PRIVATE_CAP'); };
    if (fault === 'base-gate') t.dependencies.enabled = async () => { if (++reads > 1) { revoked = true; throw new Error('PRIVATE_FLAG'); } return true; };
    if (fault === 'new-gate') t.dependencies.newOrdersEnabled = async () => { revoked = true; throw new Error('PRIVATE_NEW_FLAG'); };
    await rejected(await t.handlers.POST(t.post(), org), 'forbidden', 403); expect(t.store.execute).not.toHaveBeenCalled();
  });
  it.each(['financial_permission_required', 'seat_limit_reached'])('keeps the existing native %s denial private and authoritative', async code => {
    const t = fixture('device'); let revoked = false;
    t.dependencies.authority = async () => { if (revoked) throw new ErpError(code, 403); return { mode: 'device', actor }; };
    t.store.list = async () => { revoked = true; throw new Error('PRIVATE_FICTITIOUS'); };
    await rejected(await t.handlers.GET(t.get(), org), 'forbidden', 403); expect(t.store.execute).not.toHaveBeenCalled();
  });
  it.each(['user', 'role', 'mode', 'entitlement', 'configuration', 'capability', 'flag'] as const)('rejects a changed %s after a private page read', async change => {
    const t = fixture(), list = t.store.list;
    t.store.list = async (...args) => { const result = await list(...args);
      if (change === 'user') t.dependencies.authority = async () => ({ mode: 'browser', actor: { ...actor, userId: 'different' } });
      if (change === 'role') t.dependencies.authority = async () => ({ mode: 'browser', actor: { ...actor, role: 'member' } });
      if (change === 'mode') t.dependencies.authority = async () => ({ mode: 'device', actor });
      if (change === 'entitlement') t.dependencies.authority = async () => ({ mode: 'browser', actor: { ...actor, managementEntitled: false } });
      if (change === 'configuration') t.dependencies.configuration = async () => ({ ...configuration, language: 'fr' });
      if (change === 'capability') t.dependencies.freshSupportedSchemaVersion = () => 3;
      if (change === 'flag') t.dependencies.enabled = () => false;
      return result; };
    const expected = { user: ['session_changed', 401], role: ['forbidden', 403], mode: ['unauthorized', 401], entitlement: ['management_entitlement_required', 402], configuration: ['configuration_changed', 409], capability: ['sales_order_upgrade_required', 409], flag: ['feature_unavailable', 404] } as const;
    await rejected(await t.handlers.GET(t.get(), org), expected[change][0], expected[change][1]);
  });
  it('validates private projections and public error codes without leaking EIN or source proof', async () => {
    const t = fixture(); t.seed(); const response = await t.handlers.DETAIL(t.get(), org, id), body = await response.text();
    expect(body).not.toContain('12-3456789'); expect(body).not.toContain('ein');
    t.store.read = async () => ({ ...initial, privateProof: 'PRIVATE_FICTITIOUS' }) as unknown as UsSalesOrderRecord;
    await rejected(await t.handlers.DETAIL(t.get(), org, id), 'invalid_sales_order_record', 503);
    t.store.list = async () => { throw new ErpError('PRIVATE_SQL_DETAIL', 409); };
    await rejected(await t.handlers.GET(t.get(), org), 'service_unavailable', 503); expect(JSON.stringify(vi.mocked(t.dependencies.diagnostic!).mock.calls)).not.toContain('PRIVATE_');
  });
  it('prioritizes current revocation even when private projection validation also fails', async () => {
    const t = fixture(); let revoked = false;
    t.dependencies.authority = async () => { if (revoked) throw new AccountPublicError('PRIVATE_FICTITIOUS', 401); return { mode: 'browser', actor }; };
    t.store.list = async () => { revoked = true; return { private: 'PRIVATE_FICTITIOUS' } as never; };
    await rejected(await t.handlers.GET(t.get(), org), 'unauthorized', 401); expect(t.store.execute).not.toHaveBeenCalled();
  });
  it('rechecks rights after awaiting the browser request body', async () => {
    const t = fixture(); let revoked = false, privateStarted = false;
    t.dependencies.authority = async () => { if (revoked) throw new AccountPublicError('PRIVATE_FICTITIOUS', 403); return { mode: 'browser', actor }; };
    t.dependencies.salesOrderStore = async () => { privateStarted = true; return t.store; };
    const body = new ReadableStream<Uint8Array>({ pull(controller) { expect(privateStarted).toBe(true); revoked = true; controller.enqueue(new TextEncoder().encode(JSON.stringify(create))); controller.close(); } }, { highWaterMark: 0 });
    const request = new Request(t.post().url, { method: 'POST', headers: t.post().headers, body, duplex: 'half' } as RequestInit);
    await rejected(await t.handlers.POST(request, org), 'forbidden', 403); expect(t.store.receipt).not.toHaveBeenCalled(); expect(t.store.execute).not.toHaveBeenCalled();
  });
  it('never calls getters on a malformed privileged exception or discloses its message', async () => {
    const t = fixture(); let getterCalls = 0;
    t.store.list = async () => { const error = new ErpError('PRIVATE_FICTITIOUS', 409); Object.defineProperty(error, 'code', { get() { getterCalls++; return 'PRIVATE_FICTITIOUS'; } }); throw error; };
    await rejected(await t.handlers.GET(t.get(), org), 'service_unavailable', 503); expect(getterCalls).toBe(0);
  });
  it('refuses a receipt claimed by another currently authorized collaborator', async () => {
    const t = fixture(); expect((await t.handlers.POST(t.post(), org)).status).toBe(200);
    t.dependencies.authority = async () => ({ mode: 'browser', actor: { ...actor, userId: 'another-collaborator', role: 'member' } });
    await rejected(await t.handlers.POST(t.post(create, { 'X-Zentra-Expected-User': 'another-collaborator' }), org), 'sales_order_idempotency_conflict', 409); expect(t.store.execute).toHaveBeenCalledTimes(1);
  });
  it('checks receipt fields against the exact action and actor after the durable port', async () => {
    const t = fixture(), execute = t.store.execute;
    t.store.execute = async (...args) => { const value = await execute(...args); return { ...value, receipt: { ...value.receipt, headRevision: 999 } }; };
    await rejected(await t.handlers.POST(t.post(), org), 'invalid_sales_order_record', 503); expect(t.head()).toBe(1);
    expect(await (await t.handlers.POST(t.post(), org)).json()).toMatchObject({ replayed: true }); expect(t.head()).toBe(1);
  });
  it.each(['configuration', 'capability', 'base-gate'] as const)('keeps a post-dispatch %s change uncertain and recovers without a second write', async fault => {
    const t = fixture(), execute = t.store.execute;
    t.store.execute = async (...args) => {
      const result = await execute(...args);
      if (fault === 'configuration') t.dependencies.configuration = async () => ({ ...configuration, language: 'fr' });
      if (fault === 'capability') t.dependencies.freshSupportedSchemaVersion = () => 3;
      if (fault === 'base-gate') t.dependencies.enabled = () => false;
      return result;
    };
    await rejected(await t.handlers.POST(t.post(), org), 'service_unavailable', 503); expect(t.head()).toBe(1);
    t.dependencies.configuration = async () => configuration; t.dependencies.freshSupportedSchemaVersion = () => 4; t.dependencies.enabled = () => true;
    expect(await (await t.handlers.POST(t.post(), org)).json()).toMatchObject({ replayed: true }); expect(t.head()).toBe(1);
  });
  it('preserves the exact browser envelope through a real HTTP postcommit pause and replay', async () => {
    const t = fixture(), execute = t.store.execute, bodies: string[] = []; let paused = false;
    t.dependencies.newOrdersEnabled = () => !paused;
    t.store.execute = async (...args) => { const result = await execute(...args); paused = true; return result; };
    const fetcher: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers); if (init?.method === 'POST') headers.set('Origin', 'https://zentra.test');
      const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const request = new Request(new URL(target, 'https://zentra.test'), { ...init, headers });
      if (request.method === 'POST') { bodies.push(await request.clone().text()); return t.handlers.POST(request, org); }
      return t.handlers.GET(request, org);
    };
    const session = createBrowserUsSalesOrderSession({ organizationId: org, expectedUserId: user, role: 'owner', fetch: fetcher, newId: () => '3a000000-0000-4000-8000-000000000005' });
    await session.load(); await expect(session.change(id, null, create.command)).rejects.toMatchObject({ code: 'service_unavailable', status: 503, outcome: 'uncertain' });
    expect(session.hasPending()).toBe(true); expect(t.head()).toBe(1);
    expect(await session.retry()).toMatchObject({ replayed: true, receipt: { headRevision: 1 } });
    expect(session.hasPending()).toBe(false); expect(bodies).toHaveLength(2); expect(bodies[0]).toBe(bodies[1]); expect(t.head()).toBe(1); session.dispose();
  });
});

describe('US sales order document gateway', () => {
  it.each(['fr', 'de', 'it', 'en'])('exports the public snapshot and actual standalone HTML in %s', async language => {
    const t = fixture(); t.seed();
    const response = await t.handlers.EXPORT(t.get(`?format=json&language=${language}&revision=1`), org, id), snapshot = await response.json();
    expect(response.status).toBe(200); expect(snapshot).toMatchObject({ documentType: 'sales_order', language, orderRevision: 1, sourceErpRevision: 10, sourceEstimateRevision: 2, taxStatus: 'pending', netMinor: '11875' });
    expect(JSON.stringify(snapshot)).not.toContain('12-3456789'); expect(JSON.stringify(snapshot)).not.toContain('ein');
    expect(response.headers.get('X-Zentra-Content-SHA256')).toMatch(/^[a-f0-9]{64}$/); expect(response.headers.get('X-Zentra-Source-Estimate-Revision')).toBe('2');
    const html = await t.handlers.EXPORT(t.get(`?format=html&language=${language}&revision=1`), org, id);
    expect(html.status).toBe(200); expect(html.headers.get('Content-Security-Policy')).toContain("script-src 'none'"); expect(await html.text()).toContain(`lang="${language}"`);
  });
  it('renders real PDF/CSV with an attachment filename and no financial mutation', async () => {
    const t = fixture(); t.seed();
    const pdf = await t.handlers.EXPORT(t.get('?format=pdf&revision=1'), org, id); expect(pdf.status).toBe(200); expect(pdf.headers.get('Content-Type')).toBe('application/pdf');
    expect(pdf.headers.get('Content-Disposition')).toContain('attachment; filename="sales-order-SO-000001-r1-en.pdf"'); expect(new TextDecoder().decode((await pdf.arrayBuffer()).slice(0, 5))).toBe('%PDF-');
    const csv = await t.handlers.EXPORT(t.get('?format=csv&revision=1'), org, id); expect(csv.status).toBe(200); expect(await csv.text()).toContain('118.75');
    expect(t.store.execute).not.toHaveBeenCalled(); expect(t.dependencies.store).not.toHaveBeenCalled();
  });
  it.each(['?format=xml', '?language=es', '?format=json&format=pdf', '?head=1', '?format=html&secret=x'])('rejects export query %s', async query => {
    const t = fixture(); await rejected(await t.handlers.EXPORT(t.get(query), org, id), 'invalid_request', 422); expect(t.store.read).not.toHaveBeenCalled();
  });
  it.each(['?format=pdf', '?revision=0', '?revision=-1', '?revision=1.5', '?revision=9007199254740991', '?revision=1&revision=2'])('requires one exact selected revision in export query %s', async query => {
    const t = fixture(); await rejected(await t.handlers.EXPORT(t.get(query), org, id), 'invalid_request', 422); expect(t.store.read).not.toHaveBeenCalled();
  });
  it('rejects a stale selected revision before fonts or rendering', async () => {
    const t = fixture(); t.seed(); t.dependencies.fonts = vi.fn(getUsExportFonts); t.dependencies.render = vi.fn(async () => '<!doctype html>old');
    await rejected(await t.handlers.EXPORT(t.get('?format=pdf&revision=2'), org, id), 'sales_order_revision_conflict', 409);
    expect(t.dependencies.fonts).not.toHaveBeenCalled(); expect(t.dependencies.render).not.toHaveBeenCalled();
  });
  it.each(['render', 'fonts', 'hash'] as const)('withholds document output after revocation during %s', async step => {
    const t = fixture(); t.seed(); let revoked = false;
    t.dependencies.authority = async () => { if (revoked) throw new AccountPublicError('PRIVATE_FICTITIOUS', 401); return { mode: 'browser', actor }; };
    if (step === 'render') t.dependencies.render = async () => { revoked = true; return '<!doctype html><html>PRIVATE_FICTITIOUS_DOCUMENT</html>'; };
    if (step === 'fonts') t.dependencies.fonts = async () => { const fonts = await getUsExportFonts(); revoked = true; return fonts; };
    if (step === 'hash') t.dependencies.hash = async () => { revoked = true; return 'a'.repeat(64); };
    await rejected(await t.handlers.EXPORT(t.get('?revision=1&format=' + (step === 'fonts' ? 'pdf' : 'html')), org, id), 'unauthorized', 401);
  });
  it('rejects a document when its state changed while rendering and preserves the actual record', async () => {
    const t = fixture(); t.seed(); t.dependencies.render = async () => { t.replace({ order: { ...initial.order, state: 'cancelled', revision: 2, cancellation: { reason: 'Changed while rendering', cancelledBy: user, cancelledAt: actor.timestamp } }, invoice: null }); return '<!doctype html><html>old</html>'; };
    await rejected(await t.handlers.EXPORT(t.get('?format=html&revision=1'), org, id), 'sales_order_revision_conflict', 409); expect(t.record()?.order.state).toBe('cancelled');
  });
  it.each(['malformed-pdf', 'large-html', 'bad-hash'] as const)('validates bounded privileged output %s', async kind => {
    const t = fixture(); t.seed();
    if (kind === 'bad-hash') t.dependencies.hash = async () => 'PRIVATE_PROVIDER_DETAIL';
    else t.dependencies.render = async () => kind === 'malformed-pdf' ? new TextEncoder().encode('PRIVATE_NOT_A_PDF') : 'x'.repeat(12 * 1024 * 1024 + 1);
    await rejected(await t.handlers.EXPORT(t.get('?revision=1&format=' + (kind === 'malformed-pdf' ? 'pdf' : 'html')), org, id), kind === 'large-html' ? 'export_too_large' : 'service_unavailable', kind === 'large-html' ? 413 : 503);
  });
  it('keeps existing history exports accessible when new commands are paused', async () => {
    const t = fixture(); t.seed(); t.dependencies.newOrdersEnabled = vi.fn(() => false);
    expect((await t.handlers.EXPORT(t.get('?format=json&revision=1'), org, id)).status).toBe(200); expect(t.dependencies.newOrdersEnabled).not.toHaveBeenCalled();
    expect(canonicalErpJson(t.record())).toBe(canonicalErpJson(initial));
  });
});
