import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserUsFinancialPilotSession } from './browser-us-financial-pilot-session';
import type { UsFinancialPilotOverview } from './us-financial-pilot-contract';
import type { UsFinancialPilotCommercialCommand, UsFinancialPilotCommercialReceipt } from './us-financial-pilot-commercial';
import type { UsFinancialPilotEstimateDetail } from './us-financial-pilot-commercial-projection';

// Synthetic HTTP transport only. The independent PostgreSQL recipe exercises persistence.
const organizationId = '11111111-1111-4111-8111-111111111111';
const expectedUserId = '22222222-2222-4222-8222-222222222222';
const requestId = '33333333-3333-4333-8333-333333333333';
const head = (revision = 7) => ({ consumer: 'financial-pilot' as const, schemaVersion: 1 as const, organizationId, revision });
const address = { country: 'US' as const, line1: '1 Fictitious Street', city: 'New York', subdivision: 'NY', postalCode: '10001' };
const customer = { kind: 'business' as const, name: 'Synthetic Buyer', billingAddress: address, shippingAddress: null, email: null, phone: null, contactName: null, paymentTermsDays: 30 };
const create: UsFinancialPilotCommercialCommand = { type: 'create_customer', customer };
const save: UsFinancialPilotCommercialCommand = { type: 'save_estimate', estimateId: null, expectedEstimateRevision: 0, customerId: 'customer-a', projectId: null, date: '2026-10-10', expiresAt: '2026-11-10', paymentTermsDays: 30, lines: [{ id: null, description: 'Synthetic work', quantityUnits: '125', quantityScale: 2, unitPriceMinor: '1001', discountBasisPoints: 1000, taxTreatment: 'taxable' }], notes: 'Synthetic note\nSecond line' };
const accept: UsFinancialPilotCommercialCommand = { type: 'accept_estimate', estimateId: 'estimate-a', expectedEstimateRevision: 2 };
function overview(revision = 7): UsFinancialPilotOverview {
  const page = (kind: 'customers'|'vendors'|'estimates'|'journals'|'periods'|'invoices') => ({ ...head(revision), ledgerRevision: 5, kind, scope: null, total: 0, items: [], nextCursor: null });
  return { ...head(revision), ledgerRevision: 5, company: { country: 'US', currency: 'USD', accountingBasis: 'accrual', language: 'en', timeZone: 'America/New_York' }, summary: { invoiceCount: 0, totalMinor: '0', receivedMinor: '0', creditedMinor: '0', outstandingMinor: '0' }, invoices: page('invoices'), customers: page('customers'), vendors: page('vendors'), estimates: page('estimates'), journals: page('journals'), periods: page('periods') };
}
function receipt(command = create): UsFinancialPilotCommercialReceipt {
  return { ...head(8), action: command.type, entityId: command.type === 'create_customer' ? `pilot-customer:${requestId}` : command.type === 'save_estimate' ? command.estimateId ?? `pilot-estimate:${requestId}` : command.estimateId };
}
function estimate(): UsFinancialPilotEstimateDetail {
  return { ...head(), ledgerRevision: 5, estimate: { id: 'estimate-a', number: 'EST-2026-0001', revision: 2, customerId: 'customer-a', customerName: customer.name, date: '2026-10-10', expiresAt: '2026-11-10', status: 'draft', netMinor: '900' }, customer: { ...customer, id: 'customer-a' }, projectId: null, paymentTermsDays: 30, notes: 'Draft', subtotalMinor: '1000', discountMinor: '100', netMinor: '900', lines: [{ id: 'line-a', description: 'Synthetic work', quantityUnits: '1', quantityScale: 0, unitPriceMinor: '1000', discountBasisPoints: 1000, taxTreatment: 'taxable', netMinor: '900' }] };
}
function fixture() {
  const queue: Array<() => Response|Promise<Response>> = [];
  const fetcher = vi.fn(async (_url: RequestInfo|URL, _init?: RequestInit) => { const task = queue.shift(); if (!task) throw Error('Missing synthetic response'); return task(); });
  const newId = vi.fn(() => requestId);
  const session = createBrowserUsFinancialPilotSession({ organizationId, expectedUserId, fetch: fetcher, newId, environment: { isVisible: () => true, isOnline: () => true, subscribe: () => () => {} } });
  const enqueue = (value: unknown, status = 200) => queue.push(() => Response.json(value, { status }));
  return { session, newId, queue, fetcher, enqueue, load: async () => { enqueue(overview()); await session.load(); } };
}
async function flush() { for (let n = 0; n < 30; n++) await Promise.resolve(); }
afterEach(() => vi.useRealTimers());

describe('shared commercial/payment browser session', () => {
  it.each([create, save, accept])('sends and validates $type under its own endpoint and same admission', async command => {
    const t = fixture(); await t.load(); t.enqueue(receipt(command)); t.enqueue(overview(8));
    expect(await t.session.commercial(command)).toEqual(receipt(command)); await flush();
    const write = t.fetcher.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(write?.[0]).toBe(`/api/international/workspaces/${organizationId}/financial-pilot/commercial/operations`);
    expect(write?.[1]).toMatchObject({ credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error' });
    expect(new Headers(write?.[1]?.headers).get('X-Zentra-Expected-User')).toBe(expectedUserId);
    expect(JSON.parse(write?.[1]?.body as string)).toEqual({ consumer: 'financial-pilot', schemaVersion: 1, requestId, expectedRevision: 7, command });
    expect(t.session.getState()).toMatchObject({ pendingKind: null, pending: false });
    expect(t.session.getState().snapshot?.revision).toBe(8); t.session.dispose();
  });
  it('captures a mutable draft before awaiting and retries exactly after a lost reply', async () => {
    const t = fixture(); await t.load(); const draft = structuredClone(save);
    t.queue.push(() => { throw Error('Private transport detail'); });
    await expect(t.session.commercial(draft)).rejects.toMatchObject({ code: 'response_unavailable', outcome: 'uncertain' });
    if (draft.type === 'save_estimate') (draft as { notes: string }).notes = 'Changed after sending';
    expect(t.session.getState()).toMatchObject({ pending: true, pendingKind: 'commercial', writing: false });
    t.enqueue(receipt(save)); t.enqueue(overview(8)); expect(await t.session.retry()).toEqual(receipt(save));
    const writes = t.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(writes[1][1]?.body).toBe(writes[0][1]?.body); expect(t.newId).toHaveBeenCalledOnce();
    expect(writes[0][1]?.body).not.toContain('Changed after sending'); await flush(); t.session.dispose();
  });
  it('serializes payments and commercial operations through one uncertain-write lock', async () => {
    const t = fixture(); await t.load(); t.enqueue({ error: 'service_unavailable' }, 503);
    await expect(t.session.commercial(create)).rejects.toMatchObject({ outcome: 'uncertain' });
    await expect(t.session.commercial(save)).rejects.toMatchObject({ code: 'pending_operation' });
    await expect(t.session.recordPayment({ type: 'customer_payment', invoiceId: 'invoice-a', amountMinor: '100', paymentDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reference: 'Synthetic bank' })).rejects.toMatchObject({ code: 'pending_operation' });
    t.enqueue(head(8)); await t.session.refresh(); expect(t.session.getState().snapshot?.revision).toBe(7);
    expect(t.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1); t.session.dispose();
  });
  it('also prevents a commercial write while a payment is pending', async () => {
    const t = fixture(); await t.load(); t.enqueue({ error: 'service_unavailable' }, 503);
    await expect(t.session.recordPayment({ type: 'customer_payment', invoiceId: 'invoice-a', amountMinor: '100', paymentDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reference: 'Synthetic bank' })).rejects.toMatchObject({ outcome: 'uncertain' });
    await expect(t.session.commercial(save)).rejects.toMatchObject({ code: 'pending_operation' }); expect(t.session.getState().pendingKind).toBe('payment'); t.session.dispose();
  });
  it.each(['entityId','action','revision','organizationId','replayed','privateProof'])('does not trust a malformed commercial receipt: %s', async field => {
    const t = fixture(); await t.load(); const bad: Record<string, unknown> = { ...receipt(create) }; bad[field] = field === 'revision' ? 9 : 'foreign-or-private'; t.enqueue(bad);
    await expect(t.session.commercial(create)).rejects.toMatchObject({ code: 'invalid_response', outcome: 'uncertain' });
    expect(t.session.getState().pendingKind).toBe('commercial'); expect(JSON.stringify(t.session.getState())).not.toContain('foreign-or-private'); t.session.dispose();
  });
  it.each([401,402,403])('clears data and never publishes a late receipt after HTTP %s denial', async status => {
    const t = fixture(); await t.load(); let finish!: (response: Response) => void;
    t.queue.push(() => new Promise(resolve => { finish = resolve; })); const write = t.session.commercial(create).catch(error => error);
    t.enqueue({ error: 'forbidden' }, status); await expect(t.session.refresh()).rejects.toMatchObject({ outcome: 'unauthorized' });
    finish(Response.json(receipt(create))); expect(await write).toMatchObject({ outcome: 'unauthorized' });
    expect(t.session.getState()).toMatchObject({ status: 'denied', snapshot: null, pending: false, pendingKind: null }); t.session.dispose();
  });
  it.each([['financial_revision_conflict',409],['estimate_revision_conflict',409],['sales_order_source_locked',409],['issued_estimate_locked',409],['estimate_not_found',404],['invalid_financial_pilot_request',422],['customer_already_exists',409],['invalid_request',400],['invalid_request',413],['invalid_request',415]] as const)('requires explicit draft review after definitive %s/%s', async (code,status) => {
    const t = fixture(); await t.load(); t.enqueue({ error: code },status); t.enqueue(overview(8));
    await expect(t.session.commercial(accept)).rejects.toMatchObject({ code, status, outcome: 'rejected' });
    await flush(); expect(t.session.hasPending()).toBe(false); expect(t.session.getState().pendingKind).toBeNull(); await expect(t.session.retry()).rejects.toMatchObject({ code: 'no_pending_operation' }); expect(t.newId).toHaveBeenCalledOnce(); t.session.dispose();
  });
  it.each([['financial_configuration_changed',409],['financial_authority_changed',409],['service_unavailable',503]])('keeps exact recovery for potentially postcommit %s', async (code,status) => {
    const t = fixture(); await t.load(); t.enqueue({ error: code },status); await expect(t.session.commercial(create)).rejects.toMatchObject({ code, outcome: 'uncertain' }); expect(t.session.hasPending()).toBe(true); t.session.dispose();
  });
  it('requires initial data and a matching reviewed global revision before starting', async () => {
    const t = fixture(); await expect(t.session.commercial(create)).rejects.toMatchObject({ code: 'read_required' }); await t.load(); await expect(t.session.commercial(create,6)).rejects.toMatchObject({ code: 'financial_snapshot_changed' }); expect(t.newId).not.toHaveBeenCalled(); t.session.dispose();
  });
  it('refuses a private command or accessor before fetching', async () => {
    const t = fixture(); await t.load(); expect(() => t.session.commercial({ ...create, policy: 'private' } as typeof create)).toThrow('invalid_financial_pilot_request');
    let read = false; const dangerous = { type: 'create_customer', get customer() { read = true; return customer; } };
    expect(() => t.session.commercial(dangerous as typeof create)).toThrow('invalid_financial_pilot_request'); expect(read).toBe(false); expect(t.fetcher).toHaveBeenCalledOnce(); t.session.dispose();
  });
  it('reads a strict editable quote bound to tenant, ID and current revision', async () => {
    const t = fixture(); await t.load(); t.enqueue(estimate()); const value = await t.session.readEstimate('estimate-a'); expect(value).toEqual(estimate()); expect(Object.isFrozen(value.lines)).toBe(true);
    expect(t.fetcher.mock.calls.at(-1)?.[0]).toContain('/estimates/estimate-a?revision=7'); t.enqueue({ ...estimate(), notes: 'Read only', privateProof: 'secret' }); await expect(t.session.readEstimate('estimate-a')).rejects.toMatchObject({ code: 'invalid_response' }); t.session.dispose();
  });
  it.each(['foreign-id','foreign-organization','foreign-revision'])('rejects a quote detail for %s', async kind => {
    const t = fixture(); await t.load(); const bad = structuredClone(estimate());
    if (kind === 'foreign-id') (bad.estimate as { id: string }).id = 'other'; else if (kind === 'foreign-organization') (bad as { organizationId: string }).organizationId = expectedUserId; else (bad as { revision: number }).revision = 8;
    t.enqueue(bad); await expect(t.session.readEstimate('estimate-a')).rejects.toMatchObject({ code: 'invalid_response' }); t.session.dispose();
  });
  it('discards an old quote detail after a concurrent refreshed head', async () => {
    const t = fixture(); await t.load(); let finish!: (response: Response) => void;
    t.queue.push(() => new Promise(resolve => { finish = resolve; })); const reading = t.session.readEstimate('estimate-a').catch(error => error);
    t.enqueue(head(8)); t.enqueue(overview(8)); await t.session.refresh(); finish(Response.json(estimate())); expect(await reading).toMatchObject({ code: 'stale_read' }); t.session.dispose();
  });
  it('discards a detail begun before a commercial write and waits for a fresh snapshot', async () => {
    const t = fixture(); await t.load(); let finish!: (response: Response) => void;
    t.queue.push(() => new Promise(resolve => { finish = resolve; })); const reading = t.session.readEstimate('estimate-a').catch(error => error);
    t.enqueue(receipt(create)); t.enqueue(overview(8)); await t.session.commercial(create); finish(Response.json(estimate())); expect(await reading).toMatchObject({ code: 'stale_read' }); await flush(); t.session.dispose();
  });
  it('clears pending commercial work on stop and cannot retry it from a replacement session', async () => {
    const t = fixture(); await t.load(); t.queue.push(() => { throw Error('network'); }); await expect(t.session.commercial(create)).rejects.toMatchObject({ outcome: 'uncertain' }); t.session.stop(); expect(t.session.getState()).toMatchObject({ snapshot: null, pendingKind: null, pending: false }); await expect(t.session.retry()).rejects.toMatchObject({ outcome: 'unauthorized' }); const replacement = fixture(); await replacement.load(); await expect(replacement.session.retry()).rejects.toMatchObject({ code: 'no_pending_operation' }); replacement.session.dispose();
  });
});
