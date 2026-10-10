import { describe, expect, it, vi } from 'vitest';
import { balanceSheet, cashFlow, profitAndLoss, trialBalance } from './accounting/reports';
import { canonicalErpJson, ErpError } from './erp-contract';
import { buildTaxRequest, taxAssessmentProof } from './invoicing';
import type { ErpCommand } from './runtime-types';
import { financialKernelFixture } from './us-financial-kernel-test-fixture';
import { promoteUsFinancialBookV5, projectUsFinancialBookV5 } from './us-financial-kernel';
import { createInMemoryUsFinancialKernelStoreV5, executeUsFinancialKernelV5, validateUsFinancialRequestV5, type UsFinancialRequestV5, type UsFinancialRuntimeDependenciesV5 } from './us-financial-kernel-runtime';
import type { UsFinancialBookV5, UsFinancialErpCommandV5, UsFinancialTaxProofV5 } from './us-financial-kernel-types';

async function fixture() {
  const data = await financialKernelFixture();
  const initial = await promoteUsFinancialBookV5(data.baseline, data.policy, data.actor);
  const store = await createInMemoryUsFinancialKernelStoreV5(initial, data.policy, actor => actor);
  const resolveTax = vi.fn<UsFinancialRuntimeDependenciesV5['resolveTax']>(async ({ candidate, idempotencyKey }): Promise<UsFinancialTaxProofV5> => ({
    schemaVersion: 1, environment: 'test', kind: 'test_adjustment_authorization',
    invoiceFingerprint: candidate.invoiceFingerprint, allocationSha256: candidate.allocationSha256,
    reference: 'synthetic-only', verifiedBy: 'synthetic-test-adapter', verifiedAt: data.actor.timestamp,
    providerAccountReference: 'synthetic-test-account', originalTaxTransactionReference: `testtxn_${candidate.source.invoiceId.replaceAll('-', '')}`,
    adjustmentPlanReference: `synthetic-${idempotencyKey}`, authorizedTaxMinor: candidate.allocation.taxMinor,
  }));
  const resolveIssuance = vi.fn<NonNullable<UsFinancialRuntimeDependenciesV5['resolveIssuance']>>(async ({ book, command }) => {
    const view = await projectUsFinancialBookV5(book), estimate = view.estimates.find(row => row.id === command.estimateId)!;
    const request = buildTaxRequest(data.configuration, estimate, command.date);
    return {
      kind: 'invoice_issuance',
      sellerSnapshot: data.baseline.invoices[0].sellerSnapshot!,
      taxAssessment: taxAssessmentProof({ ...request, source: 'external-provider', providerReference: 'synthetic-calculation-only', determinedAt: '2026-10-10T11:00:00Z', validUntil: '2026-10-10T13:00:00Z', lines: request.lines.map(line => ({ id: line.id, taxMinor: '0', jurisdiction: 'synthetic-no-rate-claim', evidenceReference: `synthetic-${line.id}` })) }),
    };
  });
  const deps: UsFinancialRuntimeDependenciesV5 = { ...data, store, resolveTax, resolveIssuance, revalidate: async () => ({ configuration: data.configuration, actor: data.actor, policy: data.policy }) };
  const read = async () => await store.read(data.configuration.organizationId) as UsFinancialBookV5;
  const view = async () => projectUsFinancialBookV5(await read());
  const send = async (key: string, command: UsFinancialErpCommandV5, overrides: Partial<UsFinancialRuntimeDependenciesV5> = {}) => executeUsFinancialKernelV5({ ...deps, ...overrides }, { idempotencyKey: key, expectedRevision: (await read()).revision, command: { type: 'erp_command', request: command } });
  const credit = async (key = 'credit-original', invoiceId = 'invoice-1') => executeUsFinancialKernelV5(deps, { idempotencyKey: key, expectedRevision: (await read()).revision, command: { type: 'customer_credit', id: key, invoiceId, transactionDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reason: 'Synthetic correction', selections: [{ lineId: 'line-1', quantityUnits: '1' }] } });
  const estimate: UsFinancialErpCommandV5 = { type: 'save_estimate', id: 'estimate-2', expectedEstimateRevision: 0, customerId: 'customer-1', date: '2026-10-10', expiresAt: '2026-11-10', paymentTermsDays: 30, lines: data.baseline.estimates[0].lines, notes: 'Synthetic additional sale' };
  const issue: UsFinancialErpCommandV5 = { type: 'issue_invoice', id: 'invoice-2', estimateId: 'estimate-2', expectedEstimateRevision: 2, date: '2026-10-10', accountingDate: '2026-10-10', dueDate: '2026-11-09', periodId: '2026' };
  const prepareSale = async () => { await send('estimate-2', estimate); await send('accept-2', { type: 'accept_estimate', estimateId: 'estimate-2', expectedEstimateRevision: 1 }); };
  return { ...data, initial, store, deps, read, view, send, credit, estimate, issue, prepareSale, resolveTax, resolveIssuance };
}

describe('financial V5 ordinary ERP runtime — one shared financial authority', () => {
  it('mixes credits, new sales, purchases and actual payments without splitting journals or balances', async () => {
    const t = await fixture(), baseline = canonicalErpJson(t.baseline);
    await t.credit();
    const creditPosting = (await t.view()).ledger.entries.at(-1)!;
    await t.prepareSale(); await t.send('issue-2', t.issue);
    await t.credit('credit-new', 'invoice-2');
    await executeUsFinancialKernelV5(t.deps, { idempotencyKey: 'receipt-new', expectedRevision: (await t.read()).revision, command: { type: 'customer_payment', id: 'receipt-new', invoiceId: 'invoice-2', amountMinor: '10000', paymentDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reference: 'Synthetic bank receipt' } });
    await t.send('vendor', { type: 'save_vendor', vendor: { ...t.baseline.customers[0], id: 'vendor-1', name: 'Synthetic vendor' } });
    await t.send('bill', { type: 'record_vendor_bill', id: 'bill-1', vendorId: 'vendor-1', reference: 'SYNTHETIC-BILL', date: '2026-10-10', accountingDate: '2026-10-10', dueDate: '2026-11-09', periodId: '2026', netMinor: '5000', purchaseTaxMinor: '0', expenseAccountId: 'purchases', sourceReference: 'synthetic-document' });
    await t.send('vendor-payment', { type: 'record_vendor_payment', id: 'vendor-payment-1', billId: 'bill-1', amountMinor: '2000', paymentDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reference: 'Synthetic vendor payment' });
    const view = await t.view(), range = { start: '2026-01-01', end: '2026-12-31' };
    expect(view.invoices).toHaveLength(2); expect(view.estimates).toHaveLength(2); expect(view.vendors).toHaveLength(1); expect(view.vendorBills).toHaveLength(1); expect(view.vendorPayments).toHaveLength(1);
    expect(view.ledger.entries.find(row => row.id === creditPosting.id)).toEqual(creditPosting);
    expect(view.settlements).toEqual(expect.arrayContaining([
      expect.objectContaining({ invoiceId: 'invoice-1', receivedMinor: '0', creditedMinor: '10825', outstandingMinor: '21650' }),
      expect.objectContaining({ invoiceId: 'invoice-2', receivedMinor: '10000', creditedMinor: '10000', outstandingMinor: '10000' }),
    ]));
    expect(trialBalance(view.ledger, range.end).balanced).toBe(true);
    expect(balanceSheet(view.ledger, range.end)).toMatchObject({ balanced: true, assetsMinor: '39650', liabilitiesMinor: '4650', unclosedEarningsMinor: '35000' });
    expect(profitAndLoss(view.ledger, range)).toMatchObject({ incomeMinor: '40000', expenseMinor: '5000', profitMinor: '35000' });
    expect(cashFlow(view.ledger, range)).toMatchObject({ operatingMinor: '8000', closingMinor: '8000' });
    expect(canonicalErpJson(t.baseline)).toBe(baseline); expect(t.resolveIssuance).toHaveBeenCalledTimes(1);
    expect(view.revision).toBe(t.initial.revision + 9);
  });
  it('uses the same period closures for subsequent credits and invoices', async () => {
    const t = await fixture(); await t.credit(); await t.prepareSale();
    await t.send('close', { type: 'close_period', periodId: '2026' });
    const before = canonicalErpJson(await t.read());
    await expect(t.credit('late-credit')).rejects.toBeInstanceOf(Error);
    await expect(t.send('closed-issue', t.issue)).rejects.toBeInstanceOf(Error);
    expect(canonicalErpJson(await t.read())).toBe(before);
    await t.send('open', { type: 'open_period', id: '2027', start: '2027-01-01', end: '2027-12-31' });
    expect((await t.view()).ledger.periods.map(row => [row.id, row.status])).toEqual([['2026', 'closed'], ['2027', 'open']]);
  });
  it('permits commercial members to save customers and estimates, retaining their real actor', async () => {
    const t = await fixture(), actor = { ...t.actor, userId: 'synthetic-member', role: 'member' as const };
    const deps = { actor, revalidate: async () => ({ configuration: t.configuration, actor, policy: t.policy }) };
    await t.send('member-customer', { type: 'save_customer', customer: { ...t.baseline.customers[0], id: 'customer-member', name: 'Synthetic member customer' } }, deps);
    await t.send('member-estimate', t.estimate, deps);
    await t.send('member-accept', { type: 'accept_estimate', estimateId: 'estimate-2', expectedEstimateRevision: 1 }, deps);
    expect((await t.read()).events.map(row => row.actor.role)).toEqual(['member', 'member', 'member']);
    expect((await t.view()).ledger.entries).toEqual(t.baseline.ledger.entries);
    const read = vi.fn(t.store.read);
    await expect(t.send('member-issue', t.issue, { ...deps, store: { ...t.store, read } })).rejects.toMatchObject({ code: 'financial_permission_required' });
    expect(read).not.toHaveBeenCalled(); expect(t.resolveIssuance).not.toHaveBeenCalled();
  });
  it('replays restored generic receipts without consulting the issuance resolver again', async () => {
    const t = await fixture(); await t.credit(); await t.prepareSale();
    const request: UsFinancialRequestV5 = { idempotencyKey: 'issue-2', expectedRevision: (await t.read()).revision, command: { type: 'erp_command', request: t.issue } };
    const receipt = await executeUsFinancialKernelV5(t.deps, request); await t.credit('after-issue');
    const restored = await createInMemoryUsFinancialKernelStoreV5(await t.read(), t.policy, actor => actor);
    expect(await executeUsFinancialKernelV5({ ...t.deps, store: restored }, request)).toEqual(receipt);
    expect(t.resolveIssuance).toHaveBeenCalledTimes(1); expect(receipt.action).toBe('erp_command');
    expect(JSON.stringify(receipt)).not.toContain('taxAssessment');
  });
  it('denies a grant revoked by the issuance resolver without recording the invoice', async () => {
    const t = await fixture(); await t.prepareSale(); let revoked = false;
    const before = canonicalErpJson(await t.read());
    const resolveIssuance: NonNullable<UsFinancialRuntimeDependenciesV5['resolveIssuance']> = async input => { const facts = await t.resolveIssuance(input); revoked = true; return facts; };
    await expect(t.send('issue-revoked', t.issue, { resolveIssuance, revalidate: async () => ({ configuration: t.configuration, actor: { ...t.actor, managementEntitled: !revoked }, policy: t.policy }) })).rejects.toMatchObject({ code: 'management_entitlement_required' });
    expect(canonicalErpJson(await t.read())).toBe(before);
  });
  it('refuses changed sources during issuance and preserves the concurrent credit', async () => {
    const t = await fixture(); await t.prepareSale();
    const resolveIssuance: NonNullable<UsFinancialRuntimeDependenciesV5['resolveIssuance']> = async input => { const facts = await t.resolveIssuance(input); await t.credit(); return facts; };
    await expect(t.send('issue-conflict', t.issue, { resolveIssuance })).rejects.toMatchObject({ code: 'financial_source_changed' });
    expect((await t.view()).invoices).toHaveLength(1); expect((await t.view()).credits).toHaveLength(1);
  });
  it('requires a trusted issuance adapter only for new invoices', async () => {
    const t = await fixture(); await t.prepareSale();
    await expect(t.send('no-issuer', t.issue, { resolveIssuance: undefined })).rejects.toMatchObject({ code: 'financial_issuance_unavailable' });
    expect((await t.view()).invoices).toHaveLength(1);
  });
  it('sanitizes private issuance failures', async () => {
    const t = await fixture(); await t.prepareSale();
    await expect(t.send('issuer-error', t.issue, { resolveIssuance: async () => { throw new Error('PRIVATE-secret-and-provider-message'); } })).rejects.toMatchObject({ code: 'financial_service_unavailable', message: 'financial_service_unavailable' });
    expect((await t.view()).invoices).toHaveLength(1);
  });
  it('keeps idempotency global across generic operations and credits', async () => {
    const t = await fixture(); await t.send('shared-key', t.estimate);
    await expect(t.credit('shared-key')).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect((await t.read()).events).toHaveLength(1);
  });
  it('does not advance a member operation when permission is revoked at final CAS', async () => {
    const t = await fixture(), actor = { ...t.actor, role: 'member' as const }; let calls = 0;
    const store = await createInMemoryUsFinancialKernelStoreV5(t.initial, t.policy, current => ++calls === 1 ? current : { ...current, role: 'read_only' });
    await expect(t.send('member-revoked', t.estimate, { store, actor, revalidate: async () => ({ configuration: t.configuration, actor, policy: t.policy }) })).rejects.toMatchObject({ code: 'financial_permission_required' });
    expect((await store.read(t.configuration.organizationId) as UsFinancialBookV5).events).toHaveLength(0);
  });
  it('CAS prevents a generic write and credit from overwriting each other', async () => {
    const t = await fixture(), revision = t.initial.revision;
    const results = await Promise.allSettled([
      executeUsFinancialKernelV5(t.deps, { idempotencyKey: 'new-estimate', expectedRevision: revision, command: { type: 'erp_command', request: t.estimate } }),
      t.credit(),
    ]);
    expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(row => row.status === 'rejected')).toHaveLength(1);
    expect((await t.read()).events).toHaveLength(1); expect(trialBalance((await t.view()).ledger, '2026-12-31').balanced).toBe(true);
  });
  it('retains a committed generic operation when its response is lost', async () => {
    const t = await fixture(); await t.prepareSale();
    const request: UsFinancialRequestV5 = { idempotencyKey: 'lost-issue', expectedRevision: (await t.read()).revision, command: { type: 'erp_command', request: t.issue } };
    const commit = async (input: Parameters<typeof t.store.commit>[0]) => { await t.store.commit(input); throw new ErpError('response_lost', 503); };
    await expect(executeUsFinancialKernelV5({ ...t.deps, store: { ...t.store, commit } }, request)).rejects.toMatchObject({ code: 'response_lost' });
    const result = await executeUsFinancialKernelV5(t.deps, request);
    expect(result.entityId).toBe('invoice-2'); expect((await t.view()).invoices).toHaveLength(2); expect(t.resolveIssuance).toHaveBeenCalledTimes(1);
  });
  it('refuses replay of a financial generic receipt after the actor becomes a member', async () => {
    const t = await fixture(); await t.prepareSale();
    const request: UsFinancialRequestV5 = { idempotencyKey: 'original-issue', expectedRevision: (await t.read()).revision, command: { type: 'erp_command', request: t.issue } };
    await executeUsFinancialKernelV5(t.deps, request);
    const actor = { ...t.actor, role: 'member' as const }, read = vi.fn(t.store.read), receipt = vi.fn(t.store.receipt);
    await expect(executeUsFinancialKernelV5({ ...t.deps, actor, revalidate: async () => ({ configuration: t.configuration, actor, policy: t.policy }), store: { ...t.store, read, receipt } }, request)).rejects.toMatchObject({ code: 'financial_permission_required' });
    expect(read).not.toHaveBeenCalled(); expect(receipt).not.toHaveBeenCalled();
  });
  it('rejects malformed direct commits with a stable private-data error', async () => {
    const t = await fixture();
    await expect(t.store.commit({ organizationId: t.configuration.organizationId, expectedRevision: t.initial.revision, previousFingerprint: '0'.repeat(64), book: null as unknown as UsFinancialBookV5, receipt: {} as never, actor: t.actor })).rejects.toMatchObject({ status: 503 });
    expect((await t.read()).events).toHaveLength(0);
  });
  it('captures issuance facts before postflight authority can modify their private object', async () => {
    const t = await fixture(); await t.prepareSale(); let returned = false;
    const facts = structuredClone(await t.resolveIssuance({ organizationId: t.configuration.organizationId, actor: t.actor, idempotencyKey: 'captured', commandHash: '0'.repeat(64), book: await t.read(), command: t.issue as Extract<UsFinancialErpCommandV5, {type:'issue_invoice'}> }));
    const resolveIssuance = async () => { returned = true; return facts; };
    const revalidate = async () => { if (returned) (facts.sellerSnapshot as {displayName:string}).displayName = 'Changed after adapter return'; return { configuration: t.configuration, actor: t.actor, policy: t.policy }; };
    await t.send('captured-issue', t.issue, { resolveIssuance, revalidate });
    expect((await t.view()).invoices[1].sellerSnapshot.displayName).toBe(t.baseline.invoices[0].sellerSnapshot.displayName);
  });
  it.each([null, {}, {lines:null}, {lines:{}}, {lines:[null]}])('rejects malformed trusted tax facts %j without changing the book', async taxAssessment => {
    const t = await fixture(); await t.prepareSale(); const before = canonicalErpJson(await t.read());
    const resolveIssuance = async () => ({ kind: 'invoice_issuance', sellerSnapshot: t.baseline.invoices[0].sellerSnapshot, taxAssessment }) as never;
    await expect(t.send('malformed-issue', t.issue, { resolveIssuance })).rejects.toBeInstanceOf(Error);
    expect(canonicalErpJson(await t.read())).toBe(before);
  });
  it('rejects an expired assessment at the real execution time', async () => {
    const t = await fixture(); await t.prepareSale();
    const resolveIssuance: NonNullable<UsFinancialRuntimeDependenciesV5['resolveIssuance']> = async input => { const facts = await t.resolveIssuance(input); return { ...facts, taxAssessment: { ...facts.taxAssessment, validUntil: '2026-10-10T11:59:59Z' } }; };
    await expect(t.send('expired-issue', t.issue, { resolveIssuance })).rejects.toBeInstanceOf(Error); expect((await t.view()).invoices).toHaveLength(1);
  });
  it('rejects a seller snapshot for another workspace', async () => {
    const t = await fixture(); await t.prepareSale();
    const resolveIssuance: NonNullable<UsFinancialRuntimeDependenciesV5['resolveIssuance']> = async input => { const facts = await t.resolveIssuance(input); return { ...facts, sellerSnapshot: { ...facts.sellerSnapshot, organizationId: 'foreign-company' } }; };
    await expect(t.send('foreign-seller', t.issue, { resolveIssuance })).rejects.toBeInstanceOf(Error); expect((await t.view()).invoices).toHaveLength(1);
  });
  it('derives direct commit replay permission from the retained financial event', async () => {
    const t = await fixture(); await t.prepareSale(); let captured!: Parameters<typeof t.store.commit>[0];
    const commit = async (input: Parameters<typeof t.store.commit>[0]) => { captured = input; return t.store.commit(input); };
    await t.send('canonical-issue', t.issue, { store: { ...t.store, commit } });
    const altered = structuredClone(captured.book), event = altered.events.at(-1)!;
    (event as {operation:unknown}).operation = { type: 'erp_command', idempotencyKey: captured.receipt.idempotencyKey, command: { type: 'save_customer', customer: t.baseline.customers[0] }, facts: { kind: 'none' } };
    await expect(t.store.commit({ ...captured, book: altered, actor: { ...captured.actor, role: 'member' } })).rejects.toMatchObject({ code: 'financial_permission_required' });
    expect((await t.view()).invoices).toHaveLength(2); expect((await t.read()).events).toHaveLength(3);
  });
  it('rejects an altered direct replay proposal even with the original financial actor', async () => {
    const t = await fixture(); let captured!: Parameters<typeof t.store.commit>[0];
    const commit = async (input: Parameters<typeof t.store.commit>[0]) => { captured = input; return t.store.commit(input); };
    await t.send('canonical-estimate', t.estimate, { store: { ...t.store, commit } });
    const changed = structuredClone(captured.book); (changed.policy.approval as {reference:string}).reference = 'Changed private policy';
    await expect(t.store.commit({ ...captured, book: changed })).rejects.toMatchObject({ code: 'invalid_financial_commit', status: 503 });
    expect(await t.store.commit(captured)).toEqual(captured.receipt);
    await t.credit(); expect(await t.store.commit(captured)).toEqual(captured.receipt);
    expect((await t.read()).events).toHaveLength(2);
  });
  it('revalidates the original financial permission on direct commit replay', async () => {
    const t = await fixture(); let revoked = false, captured!: Parameters<typeof t.store.commit>[0];
    const store = await createInMemoryUsFinancialKernelStoreV5(t.initial, t.policy, actor => revoked ? { ...actor, role: 'member' } : actor);
    const commit = async (input: Parameters<typeof store.commit>[0]) => { captured = input; return store.commit(input); };
    await t.send('saved-vendor', { type: 'save_vendor', vendor: { ...t.baseline.customers[0], id: 'vendor-1' } }, { store: { ...store, commit } });
    revoked = true;
    await expect(store.commit(captured)).rejects.toMatchObject({ code: 'financial_permission_required' });
    expect((await store.read(t.configuration.organizationId) as UsFinancialBookV5).events).toHaveLength(1);
  });
  it.each(['policy', 'promotion', 'baseline'])('normalizes a corrupted private read %s to 503', async field => {
    const t = await fixture(), corrupt = { ...t.initial, [field]: null };
    await expect(t.send('corrupt-read', t.estimate, { store: { ...t.store, read: async () => corrupt } })).rejects.toMatchObject({ code: 'invalid_financial_book', status: 503 });
    expect((await t.read()).events).toHaveLength(0);
  });
});

describe('generic financial request admission', () => {
  it.each(['initialize', 'upgrade_accounting', 'refresh_configuration', 'record_payment'])('never admits legacy %s into a promoted book', type => {
    expect(() => validateUsFinancialRequestV5({ idempotencyKey: 'forbidden', expectedRevision: 6, command: { type: 'erp_command', request: { type } } }, 'synthetic-financial-kernel-workspace')).toThrow(ErpError);
  });
  it.each(['facts', 'taxAssessment', 'sellerSnapshot', 'actor', 'policy', 'commit'])('refuses caller-injected %s in the wrapper', async field => {
    const t = await fixture();
    expect(() => validateUsFinancialRequestV5({ idempotencyKey: 'forged', expectedRevision: t.initial.revision, command: { type: 'erp_command', request: t.estimate, [field]: {} } }, t.configuration.organizationId)).toThrow(ErpError);
  });
  it('requires explicit tenant scope for validating generic ERP data', async () => {
    const t = await fixture(); expect(() => validateUsFinancialRequestV5({ idempotencyKey: 'unscoped', expectedRevision: t.initial.revision, command: { type: 'erp_command', request: t.estimate } })).toThrow(ErpError);
  });
  it('rejects contacts for another tenant', async () => {
    const t = await fixture();
    await expect(t.send('foreign-customer', { type: 'save_customer', customer: { ...t.baseline.customers[0], organizationId: 'foreign-workspace' } })).rejects.toBeInstanceOf(Error);
    expect((await t.read()).events).toHaveLength(0);
  });
  it('never accepts unknown command fields removed by normalization', async () => {
    const t = await fixture(); const command = { ...t.estimate, ignoredAuthority: true } as ErpCommand;
    await expect(t.send('forged', command as UsFinancialErpCommandV5)).rejects.toBeInstanceOf(Error); expect((await t.read()).events).toHaveLength(0);
  });
});
