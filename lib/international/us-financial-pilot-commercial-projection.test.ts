import { describe, expect, it, vi } from 'vitest';
import { canonicalErpJson } from './erp-contract';
import { projectUsFinancialBookV5, promoteUsFinancialBookV5 } from './us-financial-kernel';
import type { UsFinancialBookV5 } from './us-financial-kernel-types';
import { financialKernelFixture } from './us-financial-kernel-test-fixture';
import { createInMemoryUsFinancialKernelStoreV5, executeUsFinancialKernelV5, type UsFinancialRequestV5 } from './us-financial-kernel-runtime';
import { buildUsFinancialPilotCommercialRequest, validateUsFinancialPilotCommercialRequest, type UsFinancialPilotCommercialCommand } from './us-financial-pilot-commercial';
import { projectUsFinancialPilotCustomer, projectUsFinancialPilotEstimate, validateUsFinancialPilotCustomerDetail, validateUsFinancialPilotEstimateDetail } from './us-financial-pilot-commercial-projection';
import { financialPilotParty, projectUsFinancialPilotOverview } from './us-financial-pilot-projection';

/** Actual financial kernel/CAS in synthetic memory, not a hosted/PG assertion. */
async function fixture() {
  const data = await financialKernelFixture(), initial = await promoteUsFinancialBookV5(data.baseline, data.policy, data.actor), store = await createInMemoryUsFinancialKernelStoreV5(initial, data.policy, actor => actor);
  const tax = vi.fn(async (): Promise<never> => { throw Error('Commercial commands must not request tax'); });
  const deps = { ...data, store, resolveTax: tax, resolveIssuance: tax, revalidate: async () => ({ configuration: data.configuration, actor: data.actor, policy: data.policy }) };
  const read = async () => (await store.read(data.configuration.organizationId)) as UsFinancialBookV5;
  let sequence = 0;
  const send = async (command: UsFinancialPilotCommercialCommand) => {
    const before = await read(), request = validateUsFinancialPilotCommercialRequest({ consumer: 'financial-pilot', schemaVersion: 1,
      requestId: `a1000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`, expectedRevision: before.revision, command });
    return { request, receipt: await executeUsFinancialKernelV5(deps, buildUsFinancialPilotCommercialRequest(request, data.configuration.organizationId)) };
  };
  const quote = (overrides: Partial<Extract<UsFinancialPilotCommercialCommand, { type: 'save_estimate' }>> = {}): UsFinancialPilotCommercialCommand => ({ type: 'save_estimate', estimateId: null, expectedEstimateRevision: 0,
    customerId: 'customer-1', projectId: null, date: '2026-10-10', expiresAt: '2026-11-10', paymentTermsDays: 30,
    lines: [{ id: null, description: 'Synthetic services — Genève 🌍', quantityUnits: '333', quantityScale: 2, unitPriceMinor: '10001', discountBasisPoints: 1250, taxTreatment: 'taxable' }], notes: 'Synthetic notes\nUser content remains unchanged', ...overrides });
  return { ...data, initial, store, deps, read, send, quote, tax };
}

describe('financial-pilot actual V5 commercial detail and editing', () => {
  it('creates, reads, edits and accepts a quote on the same book without changing the actual ledger', async () => {
    const t = await fixture(), ledgerBefore = canonicalErpJson((await projectUsFinancialBookV5(t.initial)).ledger);
    const createdCustomer = await t.send({ type: 'create_customer', customer: { kind: 'business', name: 'Synthetic new client', billingAddress: t.configuration.address,
      shippingAddress: null, email: 'client@example.test', phone: '+1 555 0100', contactName: 'Synthetic contact', paymentTermsDays: 15 } });
    const created = await t.send(t.quote({ customerId: createdCustomer.receipt.entityId })), book = await t.read();
    const detail = await projectUsFinancialPilotEstimate(book, { revision: book.revision, estimateId: created.receipt.entityId });
    expect(detail.estimate).toMatchObject({ number: 'EST-000002', revision: 1, status: 'draft', customerName: 'Synthetic new client', netMinor: '29140' });
    expect(detail).toMatchObject({ subtotalMinor: '33303', discountMinor: '4163', netMinor: '29140', projectId: null });
    const stableLine = detail.lines[0].id;
    const { netMinor: _net, ...originalLine } = detail.lines[0];
    const edited = await t.send(t.quote({ estimateId: detail.estimate.id, expectedEstimateRevision: detail.estimate.revision, customerId: detail.customer.id,
      lines: [{ ...originalLine, id: stableLine, description: 'Edited synthetic service', unitPriceMinor: '9007199254740993' }], notes: 'Edited\nSecond line' }));
    const editedBook = await t.read(), editedDetail = await projectUsFinancialPilotEstimate(editedBook, { revision: editedBook.revision, estimateId: detail.estimate.id });
    expect(editedDetail.estimate.number).toBe(detail.estimate.number); expect(editedDetail.lines[0].id).toBe(stableLine); expect(editedDetail.lines[0].unitPriceMinor).toBe('9007199254740993');
    expect(editedDetail.estimate.revision).toBe(2); expect(edited.receipt.entityId).toBe(created.receipt.entityId);
    await t.send({ type: 'accept_estimate', estimateId: detail.estimate.id, expectedEstimateRevision: editedDetail.estimate.revision });
    const final = await t.read(), accepted = await projectUsFinancialPilotEstimate(final, { revision: final.revision, estimateId: detail.estimate.id });
    expect(accepted.estimate).toMatchObject({ status: 'accepted', revision: 3 }); expect(canonicalErpJson((await projectUsFinancialBookV5(final)).ledger)).toBe(ledgerBefore);
    expect(final.events.every(event => event.operation.type === 'erp_command' && 'effects' in event && event.effects.postings.length === 0 && event.effects.audit.length === 0)).toBe(true);
    expect(t.tax).not.toHaveBeenCalled(); expect(Object.isFrozen(accepted.lines[0])).toBe(true);
  });
  it('reads the quote customer snapshot even after the live customer is renamed and exposes no private state', async () => {
    const t = await fixture(), created = await t.send(t.quote()), originalName = t.baseline.customers[0].name;
    await executeUsFinancialKernelV5(t.deps, { idempotencyKey: 'synthetic-private-customer-edit', expectedRevision: (await t.read()).revision,
      command: { type: 'erp_command', request: { type: 'save_customer', customer: { ...t.baseline.customers[0], name: 'Synthetic live renamed customer' } } } });
    const book = await t.read(), before = canonicalErpJson(book), detail = await projectUsFinancialPilotEstimate(book, { revision: book.revision, estimateId: created.receipt.entityId });
    expect(detail.customer.name).toBe(originalName); expect(detail.estimate.customerName).toBe(originalName);
    for (const privateField of ['idempotencyKey', 'baseline', 'policy', 'approval', 'taxAssessment', 'providerReference', 'ein', 'effects', 'commit']) expect(Object.hasOwn(detail, privateField)).toBe(false);
    expect(JSON.stringify(detail)).not.toContain('synthetic-private-customer-edit'); expect(canonicalErpJson(book)).toBe(before);
  });
  it('preserves historical100+ line details completely while refusing their public save rather than truncating', async () => {
    const t = await fixture(), lines = Array.from({ length: 101 }, (_, index) => ({ ...t.baseline.estimates[0].lines[0], id: `synthetic-existing-line-${index}` }));
    const request: UsFinancialRequestV5 = { idempotencyKey: 'synthetic-private-long-history', expectedRevision: t.initial.revision, command: { type: 'erp_command', request: {
      type: 'save_estimate', id: 'historical-long-quote', expectedEstimateRevision: 0, customerId: 'customer-1', date: '2026-10-10', expiresAt: '2026-11-10', paymentTermsDays: 30, lines, notes: 'Synthetic historical quote over public editor limit' } } };
    await executeUsFinancialKernelV5(t.deps, request); const book = await t.read(), detail = await projectUsFinancialPilotEstimate(book, { revision: book.revision, estimateId: 'historical-long-quote' });
    expect(detail.lines).toHaveLength(101); expect(detail.netMinor).toBe('3030000'); expect(detail.lines.at(-1)?.id).toBe('synthetic-existing-line-100');
    expect(() => validateUsFinancialPilotCommercialRequest({ consumer: 'financial-pilot', schemaVersion: 1, requestId: 'a1000000-0000-4000-8000-000000000099', expectedRevision: book.revision,
      command: { ...t.quote(), estimateId: detail.estimate.id, expectedEstimateRevision: detail.estimate.revision, lines: detail.lines.map(({ netMinor: _net, ...line }) => line) } })).toThrow(expect.objectContaining({ status: 422 }));
  }, 20_000);
  it('rejects stale, missing, corrupt and malformed sources without substituting a newer quote', async () => {
    const t = await fixture(), created = await t.send(t.quote()), book = await t.read(), query = { revision: book.revision, estimateId: created.receipt.entityId };
    await expect(projectUsFinancialPilotEstimate(book, { ...query, revision: book.revision - 1 })).rejects.toMatchObject({ code: 'financial_snapshot_changed', status: 409 });
    await expect(projectUsFinancialPilotEstimate(book, { ...query, estimateId: 'missing' })).rejects.toMatchObject({ code: 'financial_pilot_record_not_found', status: 404 });
    await expect(projectUsFinancialPilotEstimate(book, { ...query, private: true } as never)).rejects.toMatchObject({ status: 422 });
    await expect(projectUsFinancialPilotEstimate({ ...book, revision: book.revision + 1 }, query)).rejects.toMatchObject({ status: 503 });
    const edit = t.quote({ estimateId: created.receipt.entityId, expectedEstimateRevision: 99 });
    await expect(t.send(edit)).rejects.toMatchObject({ code: 'estimate_revision_conflict', status: 409 }); expect((await t.read()).revision).toBe(book.revision);
  });
  it('captures both source and query before replay awaits and detaches its returned customer and lines', async () => {
    const t = await fixture(), created = await t.send(t.quote()), raw = structuredClone(await t.read()), query = { revision: raw.revision, estimateId: created.receipt.entityId };
    const pending = projectUsFinancialPilotEstimate(raw, query); query.estimateId = 'changed'; (raw as { revision: number }).revision++;
    const detail = await pending; expect(detail.estimate.id).toBe(created.receipt.entityId); expect(Object.isFrozen(detail.customer.billingAddress)).toBe(true);
    expect(() => validateUsFinancialPilotEstimateDetail(detail, detail.organizationId, detail.revision - 1)).toThrow(expect.objectContaining({ code: 'financial_snapshot_changed', status: 409 }));
  });
  it('closes response fields, identities, arithmetic, dates and line treatment without evaluating getters', async () => {
    const t = await fixture(), created = await t.send(t.quote()), book = await t.read(), detail = await projectUsFinancialPilotEstimate(book, { revision: book.revision, estimateId: created.receipt.entityId });
    for (const patch of [
      { providerReference: 'secret' }, { ledgerRevision: book.revision + 1 }, { customer: { ...detail.customer, name: 'other' } },
      { subtotalMinor: '1' }, { discountMinor: '1' }, { netMinor: '1' }, { estimate: { ...detail.estimate, netMinor: '1' } },
      { estimate: { ...detail.estimate, expiresAt: '2026-02-30' } }, { lines: [{ ...detail.lines[0], netMinor: '1' }] },
      { lines: [{ ...detail.lines[0], taxTreatment: 'invented' }] }, { lines: [detail.lines[0], detail.lines[0]] },
    ]) expect(() => validateUsFinancialPilotEstimateDetail({ ...detail, ...patch }, book.baseline.configuration.organizationId, book.revision, created.receipt.entityId)).toThrow(expect.objectContaining({ status: 503 }));
    const getter = vi.fn(() => 'private'); expect(() => validateUsFinancialPilotEstimateDetail(Object.defineProperty({ ...detail }, 'private', { enumerable: true, get: getter }))).toThrow(); expect(getter).not.toHaveBeenCalled();
    expect(() => validateUsFinancialPilotEstimateDetail(detail, 'other-workspace')).toThrow(expect.objectContaining({ status: 503 }));
    expect(() => validateUsFinancialPilotEstimateDetail(detail, detail.organizationId, detail.revision, 'other-quote')).toThrow(expect.objectContaining({ status: 503 }));
  });
});

describe('current customer detail from actual V5 replay', () => {
  it('updates the live card without changing documents or ledger; a quote only adopts it after explicit save', async () => {
    const t = await fixture(), createdQuote = await t.send(t.quote()), before = await t.read(), view = await projectUsFinancialBookV5(before);
    const oldQuote = await projectUsFinancialPilotEstimate(before, { revision: before.revision, estimateId: createdQuote.receipt.entityId });
    const original = await projectUsFinancialPilotCustomer(before, { revision: before.revision, customerId: 'customer-1' });
    const { id: _id, ...oldFields } = original.customer, corrected = { ...oldFields, name: 'Corrected · fictitious 🌍', email: 'corrected@example.test', phone: '+1 555 0102', contactName: 'Corrected contact', paymentTermsDays: 15 };
    await t.send({ type: 'update_customer', customerId: original.customer.id, customer: corrected });
    const after = await t.read(), updated = await projectUsFinancialPilotCustomer(after, { revision: after.revision, customerId: original.customer.id }), next = await projectUsFinancialBookV5(after);
    expect(updated).toMatchObject({ revision: before.revision + 1, ledgerRevision: view.ledger.revision, customer: { id: original.customer.id, ...corrected } });
    expect(next.customers).toHaveLength(view.customers.length); expect(next.ledger).toEqual(view.ledger); expect(next.invoices).toEqual(view.invoices); expect(next.estimates).toEqual(view.estimates);
    expect(next.counters).toEqual(view.counters);
    expect((await projectUsFinancialPilotEstimate(after, { revision: after.revision, estimateId: oldQuote.estimate.id })).customer).toEqual(oldQuote.customer);
    const freshQuote = await t.send(t.quote()), freshBook = await t.read();
    expect((await projectUsFinancialPilotEstimate(freshBook, { revision: freshBook.revision, estimateId: freshQuote.receipt.entityId })).customer).toEqual(updated.customer);
    await t.send(t.quote({ estimateId: oldQuote.estimate.id, expectedEstimateRevision: oldQuote.estimate.revision, lines: oldQuote.lines.map(({ netMinor: _net, ...line }) => line) }));
    const resaved = await t.read(); expect((await projectUsFinancialPilotEstimate(resaved, { revision: resaved.revision, estimateId: oldQuote.estimate.id })).customer).toEqual(updated.customer);
    expect((await projectUsFinancialBookV5(resaved)).invoices).toEqual(view.invoices); expect(t.tax).not.toHaveBeenCalled();
  });
  it('permits an exact native no-op at F+1 while keeping all ledger/source facts and customer count stable', async () => {
    const t = await fixture(), before = await t.read(), view = await projectUsFinancialBookV5(before), original = financialPilotParty(view.customers[0]), { id, ...customer } = original;
    const sent = await t.send({ type: 'update_customer', customerId: id, customer }), after = await t.read(), next = await projectUsFinancialBookV5(after);
    expect(sent.receipt.revision).toBe(before.revision + 1); expect(next.customers).toEqual(view.customers); expect(next.ledger).toEqual(view.ledger); expect(next.invoices).toEqual(view.invoices); expect(next.estimates).toEqual(view.estimates);
    expect(after.events).toHaveLength(1); expect(after.events[0]).toMatchObject({ operation: { type: 'erp_command', command: { type: 'save_customer', customer: { id } } }, commit: { changes: [] }, effects: { postings: [], audit: [] } });
  });
  it('finds an existing card outside the first25-row overview without exposing a private identity', async () => {
    const data = await financialKernelFixture(), baseline = { ...data.baseline, customers: Array.from({ length: 30 }, (_, index) => ({ ...data.baseline.customers[0], id: `existing-card-${index}`, name: `${String(index).padStart(2, '0')} Existing customer` })) };
    const book = await promoteUsFinancialBookV5(baseline, data.policy, data.actor), overview = await projectUsFinancialPilotOverview(book), customerId = 'existing-card-29';
    expect(overview.customers.items).toHaveLength(25); expect(overview.customers.items.some(row => 'id' in row && row.id === customerId)).toBe(false);
    const detail = await projectUsFinancialPilotCustomer(book, { revision: book.revision, customerId }); expect(detail.customer.id).toBe(customerId);
    expect(Object.keys(detail).sort()).toEqual(['consumer', 'customer', 'ledgerRevision', 'organizationId', 'revision', 'schemaVersion']);
    for (const privateField of ['organizationId', 'idempotencyKey', 'actor', 'proof', 'policy', 'events']) expect(Object.hasOwn(detail.customer, privateField)).toBe(false);
  });
  it('captures query and book before async replay and returns detached frozen values', async () => {
    const t = await fixture(), raw = structuredClone(await t.read()), query = { revision: raw.revision, customerId: 'customer-1' }, pending = projectUsFinancialPilotCustomer(raw, query);
    query.customerId = 'mutated'; (raw as { revision: number }).revision++;
    const detail = await pending; expect(detail.customer.id).toBe('customer-1'); expect(Object.isFrozen(detail)).toBe(true); expect(Object.isFrozen(detail.customer.billingAddress)).toBe(true);
  });
  it('rejects stale/unknown/foreign/corrupt sources and closed-query violations', async () => {
    const t = await fixture(), book = await t.read(), query = { revision: book.revision, customerId: 'customer-1' };
    await expect(projectUsFinancialPilotCustomer(book, { ...query, revision: book.revision - 1 })).rejects.toMatchObject({ code: 'financial_snapshot_changed', status: 409 });
    await expect(projectUsFinancialPilotCustomer(book, { ...query, customerId: 'foreign-card' })).rejects.toMatchObject({ code: 'customer_not_found', status: 404 });
    await expect(projectUsFinancialPilotCustomer({ ...book, revision: book.revision + 1 }, query)).rejects.toMatchObject({ status: 503 });
    for (const patch of [{ cursor: 'private' }, { bankRevision: 0 }, { customerId: ' customer-1' }, { customerId: 'x'.repeat(161) }, { revision: 0 }]) await expect(projectUsFinancialPilotCustomer(book, { ...query, ...patch } as never)).rejects.toMatchObject({ status: 422 });
    const getter = vi.fn(() => 'private'); await expect(projectUsFinancialPilotCustomer(book, Object.defineProperty({ ...query }, 'customerId', { enumerable: true, get: getter }))).rejects.toMatchObject({ status: 422 }); expect(getter).not.toHaveBeenCalled();
  });
  it('correlates tenant/F/L/customer identity and refuses DTO extras, getters, symbols and prototypes', async () => {
    const t = await fixture(), book = await t.read(), detail = await projectUsFinancialPilotCustomer(book, { revision: book.revision, customerId: 'customer-1' });
    expect(validateUsFinancialPilotCustomerDetail(detail, detail.organizationId, detail.revision, detail.customer.id)).toEqual(detail);
    for (const patch of [{ ledgerRevision: -1 }, { ledgerRevision: detail.revision + 1 }, { actor: {} }, { customer: { ...detail.customer, id: 'other' } }, { customer: { ...detail.customer, organizationId: 'foreign' } }, { customer: { ...detail.customer, email: undefined } }, { customer: { ...detail.customer, id: ' customer-1' } }]) expect(() => validateUsFinancialPilotCustomerDetail({ ...detail, ...patch }, detail.organizationId, detail.revision, detail.customer.id)).toThrow(expect.objectContaining({ status: 503 }));
    expect(() => validateUsFinancialPilotCustomerDetail(detail, 'foreign')).toThrow(expect.objectContaining({ status: 503 }));
    expect(() => validateUsFinancialPilotCustomerDetail(detail, detail.organizationId, detail.revision - 1)).toThrow(expect.objectContaining({ code: 'financial_snapshot_changed', status: 409 }));
    const getter = vi.fn(() => 'private'); expect(() => validateUsFinancialPilotCustomerDetail(Object.defineProperty({ ...detail }, 'customer', { enumerable: true, get: getter }))).toThrow(); expect(getter).not.toHaveBeenCalled();
    expect(() => validateUsFinancialPilotCustomerDetail({ ...detail, [Symbol('private')]: true })).toThrow(); expect(() => validateUsFinancialPilotCustomerDetail(Object.assign(Object.create({ private: true }) as object, detail))).toThrow();
  });
});
