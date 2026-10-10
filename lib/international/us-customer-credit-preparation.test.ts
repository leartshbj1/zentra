import { describe, expect, it, vi } from 'vitest';
import type { FinancialAuthority } from './accounting/ledger';
import { canonicalErpJson, ErpError } from './erp-contract';
import type { ErpSchemaVersion } from './erp-schema-capability';
import { invoiceBalance, type TaxCalculationProvider, type TaxRequest } from './invoicing';
import { money } from './money';
import { executeErp } from './runtime';
import { applyErpDelta } from './runtime-sync';
import type { ErpCommand, ErpCommit, ErpReceipt, ErpState, ErpStore } from './runtime-types';
import { validateStoredErp } from './runtime-validation';
import type { CompanyConfiguration } from './types';
import { prepareUsCustomerCredit, validateUsCustomerCreditPreparationRequest, type UsCustomerCreditPreparationDependencies, type UsCustomerCreditPreparationRequest } from './us-customer-credit-preparation';

const org = 'fictitious-us-credit-workspace';
const timestamp = '2026-10-10T12:00:00.000Z';
/** Uses real ERP commands, delta validation and source/ledger replay. Only
 * persistence/Auth/tax calculation are fictitious; no network is involved. */
async function fixture(basis: 'cash' | 'accrual' = 'accrual', paid = '0', tax = '2475', discountBasisPoints = 0) {
  const configuration: CompanyConfiguration = { schemaVersion: 1, organizationId: org, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York', address: { country: 'US', line1: '1 Fictitious Street', city: 'Brooklyn', postalCode: '11201', subdivision: 'NY' }, accountingBasis: basis, invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'configured' } };
  const actor: FinancialAuthority = { organizationId: org, userId: 'fictitious-owner', role: 'owner', managementEntitled: true, timestamp };
  let state: ErpState | null = null, sequence = 0;
  const receipts = new Map<string, ErpReceipt>();
  const commits: ErpCommit[] = [];
  const store: ErpStore = {
    supportedSchemaVersion: 4,
    read: vi.fn(async () => state),
    receipt: vi.fn(async (_org, key) => receipts.get(key) ?? null),
    commit: vi.fn(async input => {
      state = applyErpDelta(state, { schemaVersion: 4, organizationId: org, fromRevision: input.expectedRevision, toRevision: input.header.revision, headRevision: input.header.revision, hasMore: false, resetRequired: false, events: [{ schemaVersion: 4, organizationId: org, revision: input.header.revision, header: input.header, changes: input.changes, ledgerAudit: input.ledgerAudit, receipt: input.receipt, actorId: input.actor.userId, occurredAt: input.actor.timestamp }] }, org, 4);
      commits.push(input); receipts.set(input.receipt.idempotencyKey, input.receipt);
      return input.receipt;
    }),
  };
  const calculate = vi.fn(async (request: TaxRequest) => ({ ...request, source: 'external-provider' as const, providerReference: 'fictitious-calculation-not-a-tax-transaction', determinedAt: '2026-10-10T11:00:00Z', validUntil: '2026-10-10T13:00:00Z', lines: request.lines.map(line => ({ id: line.id, taxMinor: line.taxTreatment === 'taxable' ? tax : '0', jurisdiction: 'fictitious-jurisdiction', evidenceReference: `taxcalc_fictitious_not_real:taxli_fictitious_${line.id}` })) }));
  const provider: TaxCalculationProvider = { id: 'fictitious-not-a-tax-provider', calculate };
  const send = (command: ErpCommand) => executeErp({ store, configuration, actor, revalidate: async () => actor, taxProvider: async () => provider, seller: async () => ({ organizationId: org, displayName: 'Fictitious Seller', contactEmail: 'seller@example.test' }) }, { idempotencyKey: `credit-fixture-${++sequence}`, expectedRevision: state?.revision ?? 0, command });
  await send({ type: 'initialize', periods: [{ id: '2026', start: '2026-01-01', end: '2026-12-31', status: 'open' }] });
  await send({ type: 'save_customer', customer: { id: 'customer-1', organizationId: org, kind: 'business', name: 'Fictitious Customer', billingAddress: configuration.address, paymentTermsDays: 30 } });
  await send({ type: 'save_estimate', id: 'estimate-1', expectedEstimateRevision: 0, customerId: 'customer-1', date: '2026-10-09', expiresAt: '2026-11-09', paymentTermsDays: 30, lines: [{ id: 'line-1', description: 'Fictitious service', quantityUnits: '3', quantityScale: 0, unitPrice: money('USD', '10000'), discountBasisPoints, taxTreatment: 'taxable' }], notes: 'Synthetic fixture only' });
  await send({ type: 'accept_estimate', estimateId: 'estimate-1', expectedEstimateRevision: 1 });
  await send({ type: 'issue_invoice', id: 'invoice-1', estimateId: 'estimate-1', expectedEstimateRevision: 2, date: '2026-10-09', accountingDate: '2026-10-09', dueDate: '2026-11-08', periodId: '2026' });
  const pay = async (amount = paid) => { await send({ type: 'record_payment', id: `payment-${sequence}`, invoiceId: 'invoice-1', amountMinor: amount, paymentDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reference: 'fictitious-bank-reference' }); };
  if (paid !== '0') await pay();
  const dependencies: UsCustomerCreditPreparationDependencies = { configuration, actor, store, revalidate: vi.fn(async () => ({ configuration, actor, supportedSchemaVersion: 4 as const })) };
  const request: UsCustomerCreditPreparationRequest = { expectedErpRevision: state!.revision, invoiceId: 'invoice-1', transactionDate: '2026-10-10', accountingDate: '2026-10-10', periodId: '2026', reason: 'Fictitious service returned', selections: [{ lineId: 'line-1', quantityUnits: '1' }] };
  vi.mocked(store.read).mockClear(); vi.mocked(store.receipt).mockClear(); vi.mocked(store.commit).mockClear(); calculate.mockClear();
  return { configuration, actor, store, dependencies, request, pay, send, commits, calculate, state: () => state!, replace: (value: ErpState | null) => { state = value; } };
}

describe('US customer-credit preparation from real ERP sources', () => {
  it.each(['cash', 'accrual'] as const)('prepares partial/full × unpaid/partial/paid under %s without changing finance', async basis => {
    for (const paid of ['0', '10000', '32475']) for (const quantity of ['1', '3']) {
      const t = await fixture(basis, paid), before = canonicalErpJson(t.state()), commits = t.commits.length;
      const result = await prepareUsCustomerCredit(t.dependencies, { ...t.request, selections: [{ lineId: 'line-1', quantityUnits: quantity }] });
      const credit = BigInt(quantity === '1' ? '10825' : '32475'), outstanding = BigInt('32475') - BigInt(paid), reduction = credit < outstanding ? credit : outstanding;
      expect(result).toMatchObject({ status: 'preparation_only', canIssue: false, financialState: 'unchanged', taxStatus: 'historical_candidate_only', accountingBasis: basis, sourceErpRevision: t.state().revision, preparedBy: t.actor.userId, preparedAt: timestamp, preview: { receivedMinor: paid, outstandingBeforeMinor: outstanding.toString(), receivableReductionCandidateMinor: reduction.toString(), outstandingAfterCandidateMinor: (outstanding - reduction).toString(), unappliedCreditCandidateMinor: (credit - reduction).toString(), refundRecordedMinor: '0' } });
      expect(result.allocation).toMatchObject({ netMinor: quantity === '1' ? '10000' : '30000', taxMinor: quantity === '1' ? '825' : '2475', totalMinor: credit.toString() });
      expect(result.blockers).toContain('financial_contract_required'); expect(result.blockers).toContain('tax_adjustment_required');
      expect(result.blockers.includes('cash_recognition_policy_required')).toBe(basis === 'cash');
      expect(result.blockers.includes('customer_credit_policy_required')).toBe(credit > outstanding);
      expect(canonicalErpJson(t.state())).toBe(before); expect(t.commits.length).toBe(commits);
      expect(invoiceBalance(t.state().invoices[0]).minorUnits).toBe(outstanding.toString());
      expect(t.store.commit).not.toHaveBeenCalled(); expect(t.store.receipt).not.toHaveBeenCalled(); expect(t.calculate).not.toHaveBeenCalled();
      expect(t.store.read).toHaveBeenCalledTimes(2);
      validateStoredErp(t.state(), org);
    }
  });
  it('keeps zero-tax preparations blocked by the financial contract', async () => {
    const t = await fixture('accrual', '0', '0'), result = await prepareUsCustomerCredit(t.dependencies, t.request);
    expect(result.blockers).toEqual(['financial_contract_required']); expect(result.canIssue).toBe(false); expect(result.allocation.taxMinor).toBe('0');
  });
  it('derives the net after the original discount rather than a new price or current rate', async () => {
    const t = await fixture('accrual', '0', '2475', 1250), result = await prepareUsCustomerCredit(t.dependencies, t.request);
    expect(t.state().invoices[0].discount.minorUnits).toBe('3750');
    expect(result.source.lines[0].netMinor).toBe('26250'); expect(result.allocation).toMatchObject({ netMinor: '8750', taxMinor: '825', totalMinor: '9575' });
  });
  it('preserves fractional quantities, mixed tax treatments and original line order', async () => {
    const t = await fixture();
    await t.send({ type: 'save_estimate', id: 'estimate-2', expectedEstimateRevision: 0, customerId: 'customer-1', date: '2026-10-09', expiresAt: '2026-11-09', paymentTermsDays: 30, notes: '', lines: [
      { id: 'fractional', description: 'Fictitious taxable service', quantityUnits: '100', quantityScale: 2, unitPrice: money('USD', '10000'), discountBasisPoints: 0, taxTreatment: 'taxable' },
      { id: 'exempt', description: 'Fictitious exempt line', quantityUnits: '1', quantityScale: 0, unitPrice: money('USD', '20000'), discountBasisPoints: 0, taxTreatment: 'exempt' },
    ] });
    await t.send({ type: 'accept_estimate', estimateId: 'estimate-2', expectedEstimateRevision: 1 });
    await t.send({ type: 'issue_invoice', id: 'invoice-2', estimateId: 'estimate-2', expectedEstimateRevision: 2, date: '2026-10-09', accountingDate: '2026-10-09', dueDate: '2026-11-08', periodId: '2026' });
    const result = await prepareUsCustomerCredit(t.dependencies, { ...t.request, expectedErpRevision: t.state().revision, invoiceId: 'invoice-2', selections: [{ lineId: 'exempt', quantityUnits: '1' }, { lineId: 'fractional', quantityUnits: '50' }] });
    expect(result.allocation.lines).toEqual([{ lineId: 'fractional', quantityUnits: '50', netMinor: '5000', taxMinor: '1238', totalMinor: '6238' }, { lineId: 'exempt', quantityUnits: '1', netMinor: '20000', taxMinor: '0', totalMinor: '20000' }]);
    expect(result.allocation).toMatchObject({ netMinor: '25000', taxMinor: '1238', totalMinor: '26238' });
  });
  it('detaches and freezes requests, historical source and all result collections', async () => {
    const t = await fixture(), request = { ...structuredClone(t.request) }, result = await prepareUsCustomerCredit(t.dependencies, request);
    request.selections = [{ lineId: 'wrong', quantityUnits: '3' }];
    expect(result.request.selections[0].lineId).toBe('line-1');
    for (const value of [result, result.request, result.request.selections, result.request.selections[0], result.source, result.source.lines, result.source.lines[0], result.allocation, result.allocation.lines, result.preview, result.blockers]) expect(Object.isFrozen(value)).toBe(true);
  });
  it('binds payments and ERP revision separately from the immutable invoice fingerprint', async () => {
    const t = await fixture(), first = await prepareUsCustomerCredit(t.dependencies, t.request);
    await t.pay('10000');
    const second = await prepareUsCustomerCredit(t.dependencies, { ...t.request, expectedErpRevision: t.state().revision });
    expect(second.source.invoiceFingerprint).toBe(first.source.invoiceFingerprint); expect(second.paymentFingerprint).not.toBe(first.paymentFingerprint);
    expect(second.preparationFingerprint).not.toBe(first.preparationFingerprint); expect(second.preview.receivedMinor).toBe('10000');
    await expect(prepareUsCustomerCredit(t.dependencies, t.request)).rejects.toMatchObject({ code: 'revision_conflict', status: 409 });
  });
  it('does not expose the current EIN, raw tax calculation or mailbox/bank credentials', async () => {
    const t = await fixture(), config = { ...t.configuration, ein: '12-3456789' } as CompanyConfiguration;
    t.replace({ ...t.state(), configuration: config });
    const result = await prepareUsCustomerCredit({ ...t.dependencies, configuration: config, revalidate: async () => ({ configuration: config, actor: t.actor, supportedSchemaVersion: 4 }) }, t.request);
    const json = JSON.stringify(result); expect(json).not.toContain('12-3456789'); expect(json).not.toContain('fictitious-calculation-not-a-tax-transaction');
    expect(json).not.toContain('taxcalc_fictitious'); expect(json).not.toContain('taxli_fictitious');
    expect(result.source.lines[0].evidenceReference).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.source.invoiceFingerprint).toMatch(/^[a-f0-9]{64}$/); expect(result.preparationFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
  it('permits a correction in a later open period without reopening the old one', async () => {
    const t = await fixture(); await t.send({ type: 'close_period', periodId: '2026' });
    await t.send({ type: 'open_period', id: '2027', start: '2027-01-01', end: '2027-12-31' });
    const request = { ...t.request, expectedErpRevision: t.state().revision, transactionDate: '2027-01-02', accountingDate: '2027-01-03', periodId: '2027' };
    const result = await prepareUsCustomerCredit(t.dependencies, request);
    expect(result.request.transactionDate).toBe('2027-01-02'); expect(result.request.accountingDate).toBe('2027-01-03');
    expect(t.state().ledger.periods.find(p => p.id === '2026')?.status).toBe('closed'); expect(result.canIssue).toBe(false);
  });
  it.each(['owner', 'admin', 'accountant'] as const)('admits financial preparation for %s only within the same workspace', async role => {
    const t = await fixture(), actor = { ...t.actor, role };
    const result = await prepareUsCustomerCredit({ ...t.dependencies, actor, revalidate: async () => ({ configuration: t.configuration, actor, supportedSchemaVersion: 4 }) }, t.request);
    expect(result.preparedBy).toBe(actor.userId); expect(result.canIssue).toBe(false);
  });
  it.each(['member', 'read_only'] as const)('refuses %s before loading any financial data', async role => {
    const t = await fixture();
    await expect(prepareUsCustomerCredit({ ...t.dependencies, actor: { ...t.actor, role } }, t.request)).rejects.toMatchObject({ code: 'financial_permission_required', status: 403 });
    expect(t.store.read).not.toHaveBeenCalled();
  });
  it.each([1, 2, 3] as const)('does not upgrade or mutate an old capability%s', async supportedSchemaVersion => {
    const t = await fixture();
    await expect(prepareUsCustomerCredit({ ...t.dependencies, store: { ...t.store, supportedSchemaVersion } }, t.request)).rejects.toMatchObject({ code: 'credit_preparation_upgrade_required', status: 409 });
    expect(t.store.read).not.toHaveBeenCalled(); expect(t.store.commit).not.toHaveBeenCalled();
  });
  it('refuses a Swiss configuration without importing or modifying its book', async () => {
    const t = await fixture();
    const { ein: _ein, ...common } = t.configuration;
    const configuration: CompanyConfiguration = { ...common, country: 'CH', currency: 'CHF', timeZone: 'Europe/Zurich', address: { country: 'CH', line1: 'Fictitious address 1', city: 'Geneva', postalCode: '1203', subdivision: 'GE' } };
    await expect(prepareUsCustomerCredit({ ...t.dependencies, configuration }, t.request)).rejects.toMatchObject({ code: 'edition_unavailable', status: 409 }); expect(t.store.read).not.toHaveBeenCalled();
  });
  it('refuses missing entitlement and a configuration belonging to another company', async () => {
    const t = await fixture();
    await expect(prepareUsCustomerCredit({ ...t.dependencies, actor: { ...t.actor, managementEntitled: false } }, t.request)).rejects.toMatchObject({ code: 'management_entitlement_required', status: 402 });
    await expect(prepareUsCustomerCredit({ ...t.dependencies, configuration: { ...t.configuration, organizationId: 'other-company' } }, t.request)).rejects.toMatchObject({ code: 'tenant_mismatch', status: 403 }); expect(t.store.read).not.toHaveBeenCalled();
  });
  it.each([
    [{ invoiceId: 'missing' }, 'invoice_not_found', 404],
    [{ expectedErpRevision: 999 }, 'revision_conflict', 409],
    [{ transactionDate: '2026-10-08' }, 'credit_precedes_invoice', 422],
    [{ accountingDate: '2027-01-01' }, 'accounting_period_not_open', 409],
    [{ periodId: 'missing' }, 'accounting_period_not_open', 409],
    [{ selections: [{ lineId: 'missing', quantityUnits: '1' }] }, 'invalid_credit_selection', 422],
    [{ selections: [{ lineId: 'line-1', quantityUnits: '4' }] }, 'credit_quantity_exceeded', 409],
  ] as const)('refuses inconsistent source/date/quantity %o', async (changes, code, status) => {
    const t = await fixture(); await expect(prepareUsCustomerCredit(t.dependencies, { ...t.request, ...changes })).rejects.toMatchObject({ code, status }); expect(t.store.commit).not.toHaveBeenCalled();
  });
  it('refuses a closed accounting period', async () => {
    const t = await fixture(); await t.send({ type: 'close_period', periodId: '2026' });
    await expect(prepareUsCustomerCredit(t.dependencies, { ...t.request, expectedErpRevision: t.state().revision })).rejects.toMatchObject({ code: 'accounting_period_not_open', status: 409 });
  });
  it('refuses an uninitialized or fabricated source book', async () => {
    const t = await fixture(), before = t.state(); t.replace(null);
    await expect(prepareUsCustomerCredit(t.dependencies, t.request)).rejects.toMatchObject({ code: 'workspace_not_initialized', status: 409 });
    t.replace({ ...before, invoices: [{ ...before.invoices[0], total: money('USD', '1') }] });
    await expect(prepareUsCustomerCredit(t.dependencies, t.request)).rejects.toMatchObject({ code: 'invalid_stored_state', status: 503 });
  });
  it.each([1, 2, 3, 4, 5])('rejects a changed account at authority boundary%s', async boundary => {
    const t = await fixture(); let calls = 0;
    const revalidate = async () => ({ configuration: t.configuration, actor: ++calls >= boundary ? { ...t.actor, userId: 'different-account' } : t.actor, supportedSchemaVersion: 4 as const });
    await expect(prepareUsCustomerCredit({ ...t.dependencies, revalidate }, t.request)).rejects.toMatchObject({ code: 'session_changed', status: 401 }); expect(t.store.commit).not.toHaveBeenCalled();
  });
  it.each(['role', 'entitlement', 'tenant', 'configuration', 'capability', 'clock'] as const)('rejects authority or configuration changing after the read: %s', async change => {
    const t = await fixture(); let calls = 0;
    const revalidate = async () => {
      const changed = ++calls >= 2;
      return { configuration: changed && change === 'configuration' ? { ...t.configuration, language: 'fr' as const } : t.configuration,
        actor: changed ? { ...t.actor, ...(change === 'role' ? { role: 'accountant' as const } : {}), ...(change === 'entitlement' ? { managementEntitled: false } : {}), ...(change === 'tenant' ? { organizationId: 'other-company' } : {}), ...(change === 'clock' ? { timestamp: '2026-10-10T11:59:59.000Z' } : {}) } : t.actor,
        supportedSchemaVersion: (changed && change === 'capability' ? 3 : 4) as ErpSchemaVersion };
    };
    const codes = { role: 'financial_authority_changed', entitlement: 'management_entitlement_required', tenant: 'tenant_mismatch', configuration: 'configuration_changed', capability: 'credit_preparation_upgrade_required', clock: 'credit_clock_reversed' };
    await expect(prepareUsCustomerCredit({ ...t.dependencies, revalidate }, t.request)).rejects.toMatchObject({ code: codes[change] });
  });
  it('does not publish a stale preparation when a payment arrives during calculation', async () => {
    const t = await fixture(); let reads = 0;
    vi.mocked(t.store.read).mockImplementation(async () => { if (++reads === 2) await t.pay('10000'); return t.state(); });
    await expect(prepareUsCustomerCredit(t.dependencies, t.request)).rejects.toMatchObject({ code: 'revision_conflict', status: 409 });
    expect(t.state().invoices[0].payments).toHaveLength(1);
  });
  it('refuses valid but different book contents even if their revision was dishonestly retained', async () => {
    const t = await fixture(); let reads = 0;
    vi.mocked(t.store.read).mockImplementation(async () => { if (++reads === 2) { const before = t.state(); t.replace({ ...before, customers: [...before.customers, { ...before.customers[0], id: 'another-customer' }] }); } return t.state(); });
    await expect(prepareUsCustomerCredit(t.dependencies, t.request)).rejects.toMatchObject({ code: 'credit_source_changed', status: 409 });
  });
  it('rechecks authority even when a private read fails', async () => {
    const t = await fixture(); let calls = 0;
    vi.mocked(t.store.read).mockRejectedValueOnce(new ErpError('private-store-error', 503));
    const revalidate = async () => ({ configuration: t.configuration, actor: ++calls === 2 ? { ...t.actor, managementEntitled: false } : t.actor, supportedSchemaVersion: 4 as const });
    await expect(prepareUsCustomerCredit({ ...t.dependencies, revalidate }, t.request)).rejects.toMatchObject({ code: 'management_entitlement_required', status: 402 });
  });
  it('captures request/configuration/actor before a caller mutates them during Auth', async () => {
    const t = await fixture(), request = { ...structuredClone(t.request) }, initial = { ...structuredClone(t.actor) }, config = { ...structuredClone(t.configuration) }; let calls = 0;
    const revalidate = async () => {
      if (++calls === 1) { request.invoiceId = 'other-invoice'; initial.userId = 'other-account'; config.language = 'fr'; }
      return { configuration: t.configuration, actor: t.actor, supportedSchemaVersion: 4 as const };
    };
    const result = await prepareUsCustomerCredit({ ...t.dependencies, configuration: config, actor: initial, revalidate }, request);
    expect(result.request.invoiceId).toBe('invoice-1'); expect(result.preparedBy).toBe(t.actor.userId);
  });
  it('uses the refreshed authority clock if the captured actor predates issuance', async () => {
    const t = await fixture(), actor = { ...t.actor, timestamp: '2026-10-10T11:59:59.000Z' };
    const result = await prepareUsCustomerCredit({ ...t.dependencies, actor }, t.request);
    expect(result.preparedAt).toBe(timestamp); expect(result.canIssue).toBe(false);
  });
});

describe('strict customer-credit preparation requests', () => {
  const request = { expectedErpRevision: 5, invoiceId: 'invoice-1', transactionDate: '2026-10-10', accountingDate: '2026-10-11', periodId: '2026', reason: 'Returned service', selections: [{ lineId: 'line-1', quantityUnits: '1' }] };
  it.each(['role', 'canIssue', 'taxAdjustment', 'priorCredits', 'amountMinor', 'customerId', 'journal', 'currency', 'idempotencyKey'])('refuses injected %s', field => {
    expect(() => validateUsCustomerCreditPreparationRequest({ ...request, [field]: true })).toThrow(ErpError);
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER, '5', null])('refuses revision%o', expectedErpRevision => {
    expect(() => validateUsCustomerCreditPreparationRequest({ ...request, expectedErpRevision })).toThrow(ErpError);
  });
  it.each(['2026-02-30', '0000-01-01', '10/10/2026', '2026-10-10T00:00:00Z'])('refuses ambiguous/invalid date%s', transactionDate => {
    expect(() => validateUsCustomerCreditPreparationRequest({ ...request, transactionDate })).toThrow(ErpError);
  });
  it.each(['0', '-1', '+1', '01', '1.0', '1e1', '1'.repeat(37), 1, null])('refuses quantity%o', quantityUnits => {
    expect(() => validateUsCustomerCreditPreparationRequest({ ...request, selections: [{ lineId: 'line-1', quantityUnits }] })).toThrow(ErpError);
  });
  it('rejects duplicate selections, unknown line fields and excessive selection counts', () => {
    for (const selections of [[...request.selections, ...request.selections], [{ ...request.selections[0], unitPrice: '1' }], Array.from({ length: 1001 }, (_, i) => ({ lineId: `l-${i}`, quantityUnits: '1' }))]) expect(() => validateUsCustomerCreditPreparationRequest({ ...request, selections })).toThrow(ErpError);
  });
  it('rejects accessors and prototypes without executing caller getters', () => {
    const getter = vi.fn(() => 5), input = { ...request }; Object.defineProperty(input, 'expectedErpRevision', { enumerable: true, get: getter });
    expect(() => validateUsCustomerCreditPreparationRequest(input)).toThrow(ErpError); expect(getter).not.toHaveBeenCalled();
    expect(() => validateUsCustomerCreditPreparationRequest(Object.assign(Object.create({ injected: true }), request))).toThrow(ErpError);
  });
});
