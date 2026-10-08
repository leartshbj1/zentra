import { describe, expect, it, vi } from 'vitest';
import { AccountPublicError } from '../account-security';
import { LedgerError, type FinancialAuthority } from './accounting/ledger';
import { ErpError, canonicalErpJson } from './erp-contract';
import { executeErp } from './runtime';
import type { ErpCommand, ErpCommit, ErpReceipt, ErpRequest, ErpState, ErpStore } from './runtime-types';
import type { CompanyConfiguration } from './types';
import { STRIPE_TAX_API_VERSION, prepareStripeTaxResolvedRequest, StripeTaxResolvedRequestError, type ResolvedStripeTaxRequest, type StripeTaxResolvedRequestInput } from './stripe-tax-resolved-request';
import { StripeTaxCalculationError, type StripeTaxCalculationObservation } from './stripe-tax-calculation';
import type { UsTaxFinancialContext } from './us-tax-financial-context';
import type { StoredUsTaxOperation, UsTaxOperationStore } from './us-tax-operation-store';
import { executeUsTaxInvoiceTest, type UsTaxInvoiceTestDependencies } from './us-tax-invoice';

// Deterministic injected clock and explicit fixtures only. These tests exercise
// the real ERP/mapper/normalizer, not Auth, PostgreSQL atomicity or Stripe.
const start = Date.parse('2026-10-08T12:00:00.000Z'), secret = 'PRIVATE_FICTITIOUS_ISSUER_DETAIL';
const organizationId = 'fictitious-invoice-test', operationId = 'a4000000-0000-4000-8000-000000000001';
type Phase = 'receipt' | 'erpRead' | 'context' | 'classification' | 'location' | 'operationRead' | 'reserve' | 'verify' | 'calculate' | 'record' | 'commitBefore' | 'commitAfter';
type Hook = (value?: unknown) => void | Promise<void>;
function equal(a: unknown, b: unknown) { return canonicalErpJson(a) === canonicalErpJson(b); }
function observation(resolved: ResolvedStripeTaxRequest, now: string): StripeTaxCalculationObservation {
  const line = resolved.params.line_items[0], tax = 160;
  return {
    accountId: resolved.binding.accountId, mode: 'test', apiVersion: STRIPE_TAX_API_VERSION, evidenceKind: 'test_fixture', observedAt: now,
    calculation: {
      id: 'taxcalc_FictitiousIssuer', object: 'tax.calculation', amount_total: line.amount + tax, currency: 'usd', customer: null,
      customer_details: { address: { ...resolved.params.customer_details.address, line2: null }, address_source: resolved.params.customer_details.address_source, ip_address: null, tax_ids: [], taxability_override: 'none' },
      expires_at: Math.floor(Date.parse(now) / 1000) + 3600, tax_date: resolved.params.tax_date, livemode: false, shipping_cost: null, ship_from_details: null, tax_amount_exclusive: tax, tax_amount_inclusive: 0,
      line_items: { object: 'list', has_more: false, url: '/v1/tax/calculations/taxcalc_FictitiousIssuer/line_items', data: [{ id: 'tax_li_FictitiousIssuer', object: 'tax.calculation_line_item', amount: line.amount, amount_tax: tax, quantity: line.quantity, reference: line.reference, tax_code: line.tax_code, tax_behavior: 'exclusive', livemode: false, product: null, tax_breakdown: [{ amount: tax, taxable_amount: line.amount, taxability_reason: 'standard_rated', sourcing: 'destination', jurisdiction: { country: 'US', state: 'NY', level: 'state', display_name: 'Fictitious jurisdiction' }, tax_rate_details: { tax_type: 'sales_tax', display_name: 'Fictitious tax', percentage_decimal: '8.0' } }] }] },
      tax_breakdown: [{ amount: tax, taxable_amount: line.amount, taxability_reason: 'standard_rated', inclusive: false, tax_rate_details: { country: 'US', state: 'NY', tax_type: 'sales_tax', percentage_decimal: '8.0', rate_type: 'percentage', flat_amount: null } }],
    },
  };
}

async function fixture(role: 'admin' | 'accountant' = 'accountant') {
  let time = start, flags = true, admissionError: Error | null = null, state: ErpState | null = null, saved: StoredUsTaxOperation | null = null;
  const now = () => new Date(time).toISOString();
  const revision = () => state?.revision ?? 0;
  const initialActor: FinancialAuthority = { organizationId, userId: 'fictitious-financial-user', role, managementEntitled: true, timestamp: now() };
  let currentActor = { ...initialActor };
  let config: CompanyConfiguration = { schemaVersion: 1, organizationId, country: 'US', currency: 'USD', language: 'en', timeZone: 'America/New_York', address: { country: 'US', line1: '123 Public Fictitious Street', city: 'New York', subdivision: 'NY', postalCode: '10001' }, accountingBasis: 'accrual', invoiceNumberPrefix: 'INV', taxConfiguration: { status: 'configured' } };
  const context: UsTaxFinancialContext = { organizationId, actor: initialActor, recordedAt: now(), countryRevision: 1, configuration: structuredClone(config), sellerRevision: 1, seller: { displayName: 'Fictitious public seller', contactEmail: 'seller@example.test' }, taxFactsRevision: 1, taxFacts: { schemaVersion: 1, legalName: 'PRIVATE Fictitious Legal Entity', taxOrigin: { country: 'US', line1: 'PRIVATE Fictitious Tax Origin', city: 'New York', subdivision: 'NY', postalCode: '10001' }, timeZone: 'America/New_York' }, binding: { organizationId, accountId: 'acct_FictitiousIssuer', mode: 'test', apiVersion: STRIPE_TAX_API_VERSION, revision: 1, settingsSha256: 'b'.repeat(64), registrationsSha256: 'c'.repeat(64), observedAt: new Date(start - 60000).toISOString(), validUntil: new Date(start + 48 * 3600000).toISOString(), evidenceKind: 'test_fixture', scope: 'erp_invoice_tax' } };
  const hooks: Partial<Record<Phase, Hook>> = {}, receipts = new Map<string, ErpReceipt>();
  async function fire(phase: Phase, value?: unknown) { await hooks[phase]?.(value); }
  function once(phase: Phase, hook: Hook) { hooks[phase] = async value => { delete hooks[phase]; await hook(value); }; }
  const coreCommit = vi.fn(async (input: ErpCommit) => {
    const existing = receipts.get(input.receipt.idempotencyKey);
    if (existing) { if (!equal(existing, input.receipt)) throw new ErpError('idempotency_conflict', 409); return structuredClone(existing); }
    if ((state?.revision ?? 0) !== input.expectedRevision) throw new ErpError('revision_conflict', 409);
    const rows = <T extends { id: string }>(kind: ErpCommit['changes'][number]['kind'], old: readonly T[]) => {
      const values = new Map(old.map(row => [row.id, row]));
      for (const change of input.changes.filter(change => change.kind === kind)) values.set(change.id, structuredClone(change.payload) as T);
      return [...values.values()];
    };
    state = { ...structuredClone(input.header), customers: rows('customer', state?.customers ?? []), estimates: rows('estimate', state?.estimates ?? []), invoices: rows('invoice', state?.invoices ?? []), ledger: { ...structuredClone(input.header.ledger), entries: rows('journal', state?.ledger.entries ?? []), audit: [...(state?.ledger.audit ?? []), ...structuredClone(input.ledgerAudit)] } };
    receipts.set(input.receipt.idempotencyKey, structuredClone(input.receipt)); return structuredClone(input.receipt);
  });
  const store = {
    read: vi.fn(async org => { if (org !== organizationId) throw new ErpError('tenant_mismatch', 403); const value = structuredClone(state); await fire('erpRead', value); return value; }),
    receipt: vi.fn(async (org, key) => { if (org !== organizationId) throw new ErpError('tenant_mismatch', 403); const value = structuredClone(receipts.get(key) ?? null); await fire('receipt', value); return value; }),
    commit: coreCommit,
  } satisfies ErpStore;
  const owner: FinancialAuthority = { ...initialActor, userId: 'fictitious-creation-owner', role: 'owner' };
  for (const command of [
    { type: 'initialize', periods: [{ id: '2026', start: '2026-01-01', end: '2026-12-31', status: 'open' }] },
    { type: 'save_customer', customer: { id: 'customer', organizationId, kind: 'business', name: 'Fictitious Customer', billingAddress: config.address, paymentTermsDays: 30 } },
    { type: 'save_estimate', id: 'estimate', expectedEstimateRevision: 0, customerId: 'customer', date: '2026-10-08', expiresAt: '2026-11-08', paymentTermsDays: 30, lines: [{ id: 'line', description: 'Fictitious service', quantityUnits: '2', quantityScale: 0, unitPrice: { currency: 'USD', minorUnits: '1000' }, discountBasisPoints: 0, taxTreatment: 'taxable' }], notes: 'Fictitious only' },
    { type: 'accept_estimate', estimateId: 'estimate', expectedEstimateRevision: 1 },
  ] satisfies ErpCommand[]) await executeErp({ store, configuration: config, actor: owner, revalidate: async () => owner, taxProvider: async () => null }, { idempotencyKey: `bootstrap-${revision()}`, expectedRevision: revision(), command });
  coreCommit.mockClear();
  const request: ErpRequest = { idempotencyKey: 'original-issue', expectedRevision: 4, command: { type: 'issue_invoice', id: 'invoice', estimateId: 'estimate', expectedEstimateRevision: 2, date: '2026-10-08', accountingDate: '2026-10-08', dueDate: '2026-11-08', periodId: '2026' } };
  const operations = {
    read: vi.fn(async (admitted, key, commandHash) => { if (admitted.organizationId !== organizationId || key !== request.idempotencyKey || (saved && saved.commandHash !== commandHash)) throw new ErpError('tax_operation_conflict', 409); const value = structuredClone(saved); await fire('operationRead', value); return value; }),
    reserve: vi.fn(async (admitted, resolved) => {
      if (admitted.userId !== initialActor.userId || resolved.actorUserId !== admitted.userId) throw new ErpError('tax_operation_conflict', 409);
      if (saved && !equal(saved.resolved, resolved)) throw new ErpError('tax_operation_conflict', 409);
      if (!saved) saved = { status: 'reserved', organizationId, operationId: resolved.operationId, actorUserId: admitted.userId, erpIdempotencyKey: resolved.erpIdempotencyKey, commandHash: resolved.commandHash, reservedAt: now(), retryUntil: new Date(time + 23 * 3600000).toISOString(), resolved: JSON.parse(canonicalErpJson(resolved)), calculation: null, receipt: null };
      const value = structuredClone(saved); await fire('reserve', value); return value;
    }),
    record: vi.fn(async (_admitted, resolved, calculated) => {
      if (!saved || !equal(saved.resolved, resolved)) throw new ErpError('tax_operation_conflict', 409);
      saved = { ...saved, status: 'calculated', calculation: { proofBody: calculated.proofBody, proofSha256: calculated.proofSha256, assessment: JSON.parse(canonicalErpJson(calculated.assessment)) } };
      const value = structuredClone(saved); await fire('record', value); return value;
    }),
    commit: vi.fn(async (id, input) => {
      await fire('commitBefore', input);
      if (!saved || saved.operationId !== id) throw new ErpError('tax_operation_conflict', 409);
      if (saved.status === 'committed') return structuredClone(saved.receipt!);
      if (saved.status !== 'calculated') throw new ErpError('invalid_tax_operation', 422);
      const r = saved.resolved as ResolvedStripeTaxRequest;
      if (r.countryRevision !== context.countryRevision || r.sellerRevision !== context.sellerRevision || r.taxFactsRevision !== context.taxFactsRevision || !equal(r.binding, context.binding)) throw new ErpError('tax_configuration_changed', 409);
      const result = await coreCommit(input); saved = { ...saved, status: 'committed', receipt: result };
      await fire('commitAfter', result); return result;
    }),
  } satisfies UsTaxOperationStore;
  const cache = new Map<string, StripeTaxCalculationObservation>();
  const dependencies = {
    erp: { store, configuration: config, actor: initialActor, revalidate: vi.fn(async () => { if (admissionError) throw admissionError; if (!flags) throw new ErpError('feature_unavailable', 404); return { ...currentActor, timestamp: now() }; }) },
    contexts: { read: vi.fn(async admitted => { const value = structuredClone({ ...context, actor: admitted, recordedAt: now() }); await fire('context', value); return value; }) },
    operations,
    gateway: {
      verify: vi.fn(async value => { expect(value.binding.evidenceKind).toBe('test_fixture'); await fire('verify', value); }),
      calculate: vi.fn(async resolved => { if (!cache.has(resolved.idempotencyKey)) cache.set(resolved.idempotencyKey, observation(resolved, now())); const value = structuredClone({ ...cache.get(resolved.idempotencyKey)!, observedAt: now() }); await fire('calculate', value); return value; }),
    },
    classifications: vi.fn(async () => { const value = [{ lineId: 'line', taxCode: 'txcd_99999999', kind: 'service' as const, taxBehavior: 'exclusive' as const, revision: 1, evidenceReference: 'fictitious-explicit-classification-not-provider-verified' }]; await fire('classification', value); return value; }),
    transactionLocation: vi.fn(async (_context, command) => { const value = { taxDateInstant: `${command.date}T12:00:00.000Z`, addressSource: 'billing' as const }; await fire('location', value); return value; }),
    operationId: vi.fn(() => operationId), now, allowTestFixtures: true,
  } satisfies UsTaxInvoiceTestDependencies;
  function change(kind: 'user' | 'scope' | 'role' | 'financial role' | 'entitlement' | 'flags' | 'revoked') {
    if (kind === 'user') currentActor = { ...currentActor, userId: 'other-user' };
    if (kind === 'scope') currentActor = { ...currentActor, organizationId: 'other-workspace' };
    if (kind === 'role') currentActor = { ...currentActor, role: 'read_only' };
    if (kind === 'financial role') currentActor = { ...currentActor, role: 'owner' };
    if (kind === 'entitlement') currentActor = { ...currentActor, managementEntitled: false };
    if (kind === 'flags') flags = false;
    if (kind === 'revoked') admissionError = new AccountPublicError(secret, 401);
  }
  return {
    dependencies, store, operations, context, request, coreCommit, hooks, once, change,
    issue: (input: unknown = request, overrides: Partial<UsTaxInvoiceTestDependencies> = {}) => executeUsTaxInvoiceTest({ ...dependencies, erp: { ...dependencies.erp, configuration: config }, ...overrides }, input),
    state: () => structuredClone(state!), saved: () => structuredClone(saved),
    replaceSaved: (value: StoredUsTaxOperation | null) => { saved = structuredClone(value); },
    setConfig: (value: CompanyConfiguration) => { config = structuredClone(value); },
    advance: (milliseconds: number) => { time += milliseconds; },
    restore: () => { currentActor = { ...initialActor }; flags = true; admissionError = null; },
    editState: (edit: (value: ErpState) => ErpState) => { state = edit(state!); },
  };
}
async function failure(promise: Promise<unknown>, code: string, status: number) {
  try { await promise; throw new Error('Expected issuer rejection'); }
  catch (error) { expect(error).toMatchObject({ code, status, message: code }); expect(String(error)).not.toContain(secret); expect(JSON.stringify(error)).not.toContain(secret); }
}
function noInvoice(t: Awaited<ReturnType<typeof fixture>>) { expect(t.state().invoices).toEqual([]); expect(t.state().counters.invoice).toBe(0); expect(t.state().ledger.entries).toEqual([]); expect(t.state().revision).toBe(4); expect(t.coreCommit).not.toHaveBeenCalled(); }
async function reResolve(r: ResolvedStripeTaxRequest, overrides: Partial<StripeTaxResolvedRequestInput>, now: string) {
  return prepareStripeTaxResolvedRequest({ organizationId: r.organizationId, operationId: r.operationId, invoiceId: r.invoiceId, actorUserId: r.actorUserId, erpIdempotencyKey: r.erpIdempotencyKey, commandHash: r.commandHash, expectedErpRevision: r.expectedErpRevision, countryRevision: r.countryRevision, sellerRevision: r.sellerRevision, taxFactsRevision: r.taxFactsRevision, configuration: r.snapshots.configuration, estimate: r.snapshots.estimate, taxFacts: r.snapshots.taxFacts, binding: r.binding, classifications: r.classifications, invoiceDate: r.invoiceDate, taxDateInstant: r.taxDateInstant, taxDatePolicy: r.taxDatePolicy, now, addressSource: r.params.customer_details.address_source, ...overrides });
}

describe('private TEST issuer through the real ERP engine', () => {
  it.each(['admin','accountant'] as const)('issues with the actual %s and unchanged configured company', async role => {
    const t = await fixture(role), result = await t.issue(), state = t.state();
    expect(result.replayed).toBe(false); expect(result.receipt).toMatchObject({ idempotencyKey: t.request.idempotencyKey, revision: 5, entityId: 'invoice', action: 'issue_invoice' });
    expect(state.invoices).toHaveLength(1); expect(state.counters.invoice).toBe(1); expect(state.invoices[0]).toMatchObject({ number: 'INV-000001', issuedBy: 'fictitious-financial-user', tax: { currency: 'USD', minorUnits: '160' }, total: { currency: 'USD', minorUnits: '2160' }, sellerSnapshot: { displayName: 'Fictitious public seller' } });
    expect(state.ledger.entries).toHaveLength(1); expect(state.invoices[0].companyConfiguration).toEqual(t.context.configuration);
    expect(t.dependencies.gateway.calculate).toHaveBeenCalledTimes(1); expect(t.operations.commit).toHaveBeenCalledTimes(1); expect(t.coreCommit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(t.operations.reserve).mock.calls[0][0]).toMatchObject({ role, userId: 'fictitious-financial-user' });
    expect(Object.keys(result)).toEqual(['receipt','replayed']); expect(Object.keys(result.receipt)).toEqual(['idempotencyKey','commandHash','revision','entityId','action']);
    const publicResult = JSON.stringify(result); for (const marker of ['PRIVATE', 'acct_', 'binding', 'taxOrigin', 'proofBody', 'settingsSha256']) expect(publicResult).not.toContain(marker);
  });
  it('replays an ERP receipt with unconfigured current settings and unavailable private dependencies', async () => {
    const t = await fixture(), first = await t.issue();
    t.setConfig({ ...t.context.configuration, taxConfiguration: { status: 'unconfigured' } });
    vi.mocked(t.dependencies.contexts.read).mockRejectedValue(new Error(secret)); vi.mocked(t.operations.read).mockRejectedValue(new Error(secret));
    const contextCalls = vi.mocked(t.dependencies.contexts.read).mock.calls.length, opCalls = vi.mocked(t.operations.read).mock.calls.length;
    t.advance(72 * 3600000);
    expect(await t.issue()).toEqual({ receipt: first.receipt, replayed: true });
    expect(t.dependencies.contexts.read).toHaveBeenCalledTimes(contextCalls); expect(t.operations.read).toHaveBeenCalledTimes(opCalls); expect(t.dependencies.gateway.calculate).toHaveBeenCalledTimes(1); expect(t.state().counters.invoice).toBe(1);
  });
  it('handles a committed-operation race after a missing ERP receipt without revalidating historical proof', async () => {
    const t = await fixture(), beforeConcurrentCommit = t.state(), first = await t.issue();
    // The first receipt/state reads began before the concurrent commit, while
    // the subsequent private operation read observes its durable completion.
    t.store.receipt.mockResolvedValueOnce(null); t.store.read.mockResolvedValueOnce(beforeConcurrentCommit); t.advance(72 * 3600000);
    const calls = vi.mocked(t.dependencies.contexts.read).mock.calls.length;
    expect(await t.issue()).toEqual({ receipt: first.receipt, replayed: true });
    expect(t.dependencies.contexts.read).toHaveBeenCalledTimes(calls); expect(t.dependencies.gateway.calculate).toHaveBeenCalledTimes(1); expect(t.operations.commit).toHaveBeenCalledTimes(1); expect(t.state().counters.invoice).toBe(1);
  });
  it('retains reserved UUID, body, parameters, date and key after a lost gateway result', async () => {
    const t = await fixture(); t.once('calculate', () => { throw new Error(secret); });
    await failure(t.issue(), 'service_unavailable', 503); noInvoice(t);
    const saved = t.saved()!; expect(saved.status).toBe('reserved'); t.advance(5 * 60000);
    expect((await t.issue()).replayed).toBe(false); expect(t.saved()!.operationId).toBe(saved.operationId);
    const calls = vi.mocked(t.dependencies.gateway.calculate).mock.calls.map(([r]) => r);
    expect(calls).toHaveLength(2); expect(calls[1]).toEqual(calls[0]); expect(calls[1].resolvedBody).toBe((saved.resolved as ResolvedStripeTaxRequest).resolvedBody); expect(calls[1].idempotencyKey).toBe(calls[0].idempotencyKey);
    expect(t.dependencies.operationId).toHaveBeenCalledTimes(1); expect(t.dependencies.transactionLocation).toHaveBeenCalledTimes(1); expect(t.operations.reserve).toHaveBeenCalledTimes(1); expect(t.state().counters.invoice).toBe(1);
  });
  it.each(['record','commitBefore'] as const)('recovers calculated state after %s response failure without another calculation', async phase => {
    const t = await fixture(); t.once(phase, () => { throw new Error(secret); });
    await failure(t.issue(), 'service_unavailable', 503); noInvoice(t); expect(t.saved()!.status).toBe('calculated');
    t.advance(5 * 60000); expect((await t.issue()).replayed).toBe(false);
    expect(t.dependencies.gateway.calculate).toHaveBeenCalledTimes(1); expect(t.dependencies.operationId).toHaveBeenCalledTimes(1); expect(t.dependencies.transactionLocation).toHaveBeenCalledTimes(1); expect(t.coreCommit).toHaveBeenCalledTimes(1); expect(t.state().counters.invoice).toBe(1);
  });
  it('recovers a lost committed response by ERP receipt without another operation commit', async () => {
    const t = await fixture(); t.once('commitAfter', () => { throw new Error(secret); });
    await failure(t.issue(), 'service_unavailable', 503); expect(t.saved()!.status).toBe('committed'); expect(t.state().counters.invoice).toBe(1);
    expect((await t.issue()).replayed).toBe(true); expect(t.operations.commit).toHaveBeenCalledTimes(1); expect(t.coreCommit).toHaveBeenCalledTimes(1); expect(t.dependencies.gateway.calculate).toHaveBeenCalledTimes(1);
  });
  it('requires explicit fixture admission before reserving or calling a gateway', async () => {
    const t = await fixture(); await failure(t.issue(t.request, { allowTestFixtures: undefined }), 'tax_binding_unavailable', 409);
    noInvoice(t); expect(t.operations.reserve).not.toHaveBeenCalled(); expect(t.dependencies.gateway.verify).not.toHaveBeenCalled(); expect(t.dependencies.gateway.calculate).not.toHaveBeenCalled();
  });
  it('requires the actual stored tax configuration before loading private facts', async () => {
    const t = await fixture(), configuration = { ...t.context.configuration, taxConfiguration: { status: 'unconfigured' as const } };
    t.setConfig(configuration); t.editState(state => ({ ...state, configuration }));
    await failure(t.issue(), 'tax_configuration_required', 409); noInvoice(t); expect(t.dependencies.contexts.read).not.toHaveBeenCalled(); expect(t.operations.reserve).not.toHaveBeenCalled(); expect(t.dependencies.gateway.calculate).not.toHaveBeenCalled();
  });
  it.each(['draft','declined'] as const)('rejects %s estimates before context, reservation or paid calculation', async status => {
    const t = await fixture(); t.editState(value => ({ ...value, estimates: value.estimates.map(e => ({ ...e, status })) }));
    await failure(t.issue(), 'estimate_acceptance_required', 409); noInvoice(t); expect(t.dependencies.contexts.read).not.toHaveBeenCalled(); expect(t.operations.reserve).not.toHaveBeenCalled(); expect(t.dependencies.gateway.calculate).not.toHaveBeenCalled();
  });
  it('rejects a due date before invoice date before reservation or calculation', async () => {
    const t = await fixture(), input = { ...t.request, command: { ...t.request.command, dueDate: '2026-10-07' } };
    await failure(t.issue(input), 'invalid_date', 422); noInvoice(t); expect(t.operations.reserve).not.toHaveBeenCalled(); expect(t.dependencies.gateway.calculate).not.toHaveBeenCalled(); expect(t.dependencies.contexts.read).not.toHaveBeenCalled();
  });
  it('rejects expired reserved retry without changing its key or resolving its location again', async () => {
    const t = await fixture(); t.once('calculate', () => { throw new Error(secret); }); await failure(t.issue(), 'service_unavailable', 503);
    const saved = t.saved()!; t.advance(23 * 3600000);
    await failure(t.issue(), 'tax_operation_expired', 409); noInvoice(t); expect(t.saved()).toEqual(saved); expect(t.dependencies.gateway.calculate).toHaveBeenCalledTimes(1); expect(t.dependencies.operationId).toHaveBeenCalledTimes(1); expect(t.dependencies.transactionLocation).toHaveBeenCalledTimes(1);
  });
  it('rejects expired stored calculation without recalculating or consuming an invoice number', async () => {
    const t = await fixture(); t.once('commitBefore', () => { throw new Error(secret); }); await failure(t.issue(), 'service_unavailable', 503);
    t.advance(2 * 3600000); await failure(t.issue(), 'tax_calculation_expired', 409); noInvoice(t); expect(t.dependencies.gateway.calculate).toHaveBeenCalledTimes(1);
  });
  it('rejects a binding that expires while the gateway is awaited', async () => {
    const t = await fixture(); (t.context as { binding: UsTaxFinancialContext['binding'] }).binding = { ...t.context.binding, validUntil: new Date(start + 5 * 60000).toISOString() };
    t.once('calculate', () => t.advance(6 * 60000));
    await failure(t.issue(), 'binding_unavailable', 409); noInvoice(t); expect(t.operations.record).not.toHaveBeenCalled();
  });
});

describe('adversarial issuer admission and awaited private state', () => {
  const failures = { user: ['session_changed', 401], scope: ['session_changed', 401], role: ['financial_permission_required', 403], 'financial role': ['forbidden', 403], entitlement: ['management_entitlement_required', 402], flags: ['feature_unavailable', 404], revoked: ['unauthorized', 401] } as const;
  it.each(Object.keys(failures) as (keyof typeof failures)[])('withholds all invoice effects when injected %s admission changes during any precommit await', async kind => {
    for (const phase of ['receipt','erpRead','operationRead','context','classification','location','reserve','verify','calculate','record'] as const) {
      const t = await fixture(); t.once(phase, () => t.change(kind)); const [code, status] = failures[kind];
      await failure(t.issue(), code, status); noInvoice(t);
    }
  });
  it.each(['countryRevision','sellerRevision','taxFactsRevision','binding'] as const)('rejects %s ABA after gateway response before record/commit', async key => {
    const t = await fixture(); t.once('calculate', () => {
      if (key === 'binding') (t.context as { binding: UsTaxFinancialContext['binding'] }).binding = { ...t.context.binding, revision: t.context.binding.revision + 2 };
      else (t.context as unknown as Record<string, unknown>)[key] = t.context[key] + 2;
    });
    await failure(t.issue(), 'tax_configuration_changed', 409); noInvoice(t); expect(t.operations.record).not.toHaveBeenCalled();
  });
  it('withholds a durable postcommit receipt after admission revocation and replays on restored admission', async () => {
    const t = await fixture(); t.once('commitAfter', () => t.change('revoked'));
    await failure(t.issue(), 'unauthorized', 401); expect(t.state().counters.invoice).toBe(1); expect(t.saved()!.status).toBe('committed');
    t.restore(); expect((await t.issue()).replayed).toBe(true); expect(t.coreCommit).toHaveBeenCalledTimes(1); expect(t.dependencies.gateway.calculate).toHaveBeenCalledTimes(1);
  });
  it.each(['PRIVATE_FICTITIOUS_ISSUER_DETAIL','constructor','toString'])('sanitizes unknown LedgerError %s without private disclosure', async message => {
    const t = await fixture(); t.once('calculate', () => { throw new LedgerError(message); });
    await failure(t.issue(), 'service_unavailable', 503); noInvoice(t);
  });
  it.each([['INVALID_DATE','invalid_date',422], ['TENANT_MISMATCH','tenant_mismatch',403], ['ESTIMATE_ACCEPTANCE_REQUIRED','estimate_acceptance_required',409]] as const)('preserves known public LedgerError %s', async (message, code, status) => {
    const t = await fixture(); t.once('calculate', () => { throw new LedgerError(message); });
    await failure(t.issue(), code, status); noInvoice(t);
  });
  it.each([['TAX_ASSESSMENT_EXPIRED','tax_assessment_expired',409], ['STALE_TAX_ASSESSMENT','stale_tax_assessment',409], ['INVOICE_PERMISSION_REQUIRED','invoice_permission_required',403]] as const)('preserves LedgerError %s through nested conversion and admission refusals', async (message, code, status) => {
    for (const phase of ['calculate','revalidate'] as const) {
      const t = await fixture(), error = new LedgerError(message);
      t.once('calculate', () => { if (phase === 'revalidate') t.dependencies.erp.revalidate.mockRejectedValue(error); else throw error; });
      await failure(t.issue(), code, status); noInvoice(t); expect(t.operations.record).not.toHaveBeenCalled();
    }
  });
  const malformedStripeStatuses = [
    { error: new StripeTaxCalculationError('invalid_tax_calculation', 200), code: 'invalid_tax_calculation', status: 409 },
    { error: new StripeTaxCalculationError('tax_calculation_expired', 503), code: 'tax_calculation_expired', status: 409 },
    { error: new StripeTaxCalculationError('tax_binding_changed', NaN), code: 'tax_binding_changed', status: 409 },
    { error: new StripeTaxCalculationError('unsupported_tax_calculation', 401), code: 'unsupported_tax_calculation', status: 409 },
    { error: new StripeTaxResolvedRequestError('unsupported_tax_request', 409), code: 'unsupported_tax_request', status: 422 },
    { error: new StripeTaxResolvedRequestError('tenant_mismatch', 200), code: 'tenant_mismatch', status: 403 },
    { error: new StripeTaxResolvedRequestError('binding_unavailable', 422), code: 'binding_unavailable', status: 409 },
    { error: new StripeTaxResolvedRequestError('invalid_tax_date', Infinity), code: 'invalid_tax_date', status: 422 },
    { error: new StripeTaxResolvedRequestError('invalid_request', -1), code: 'invalid_request', status: 422 },
  ];
  it.each(malformedStripeStatuses)('normalizes Stripe $code to fixed status $status from provider and revalidation errors', async ({ error, code, status }) => {
    for (const phase of ['calculate','revalidate'] as const) {
      const t = await fixture();
      t.once('calculate', () => { if (phase === 'revalidate') t.dependencies.erp.revalidate.mockRejectedValue(error); else throw error; });
      await failure(t.issue(), code, status); noInvoice(t); expect(t.operations.record).not.toHaveBeenCalled();
    }
  });
  it.each(['calculation','resolved'] as const)('sanitizes unknown runtime codes on the %s Stripe subclass, including revalidation', async kind => {
    for (const code of [secret, 'constructor', 'toString']) for (const status of [503, 403]) for (const phase of ['calculate','revalidate'] as const) {
      const t = await fixture(), error = kind === 'calculation'
        ? new StripeTaxCalculationError(code as ConstructorParameters<typeof StripeTaxCalculationError>[0], status)
        : new StripeTaxResolvedRequestError(code as ConstructorParameters<typeof StripeTaxResolvedRequestError>[0], status);
      t.once('calculate', () => { if (phase === 'revalidate') t.dependencies.erp.revalidate.mockRejectedValue(error); else throw error; });
      await failure(t.issue(), 'service_unavailable', 503); noInvoice(t); expect(t.operations.record).not.toHaveBeenCalled();
    }
  });
  it.each([400,404,422,500,503])('sanitizes an unexpected AccountPublicError status %s', async status => {
    const t = await fixture(); t.once('calculate', () => { throw new AccountPublicError(secret, status); });
    await failure(t.issue(), 'service_unavailable', 503); noInvoice(t);
  });
  it.each([[503,'service_unavailable',503], [403,'forbidden',403], [401,'unauthorized',401], [402,'management_entitlement_required',402]] as const)('sanitizes a foreign private ErpError at status %s', async (givenStatus, code, expectedStatus) => {
    const t = await fixture(); t.once('calculate', () => { throw new ErpError(secret, givenStatus); });
    await failure(t.issue(), code, expectedStatus); noInvoice(t);
  });
  it('normalizes a known forbidden code to its public status instead of a port status', async () => {
    const t = await fixture(); t.once('calculate', () => { throw new ErpError('forbidden', 200); });
    await failure(t.issue(), 'forbidden', 403); noInvoice(t);
  });
  it('rejects a reversed trusted clock after a private await', async () => {
    const t = await fixture(); t.once('calculate', () => t.advance(-1));
    await failure(t.issue(), 'server_clock_unavailable', 503); noInvoice(t); expect(t.operations.record).not.toHaveBeenCalled();
  });
});

describe('issuer scope and immutable private DTO boundaries', () => {
  it.each(['organizationId','actorUserId','erpIdempotencyKey','commandHash'] as const)('rejects returned operation %s scope mismatch before provider work', async key => {
    const t = await fixture(); t.once('calculate', () => { throw new Error(secret); }); await failure(t.issue(), 'service_unavailable', 503);
    const saved = t.saved()!, before = t.dependencies.gateway.calculate.mock.calls.length;
    t.operations.read.mockResolvedValueOnce({ ...saved, [key]: key === 'commandHash' ? 'f'.repeat(64) : 'other-scope' });
    await failure(t.issue(), 'invalid_stored_tax_operation', 503); noInvoice(t); expect(t.dependencies.gateway.calculate).toHaveBeenCalledTimes(before);
  });
  it.each([
    { actorUserId: 'different-actor' }, { erpIdempotencyKey: 'different-erp-key' }, { commandHash: 'f'.repeat(64) },
    { invoiceId: 'different-invoice' }, { expectedErpRevision: 5 }, { countryRevision: 2 }, { sellerRevision: 2 }, { taxFactsRevision: 2 },
  ])('rejects a structurally valid resolved envelope with another command/snapshot scope %j', async override => {
    const t = await fixture(); t.once('calculate', () => { throw new Error(secret); }); await failure(t.issue(), 'service_unavailable', 503);
    const saved = t.saved()!, resolved = await reResolve(saved.resolved as ResolvedStripeTaxRequest, override, t.dependencies.now());
    t.replaceSaved({ ...saved, resolved });
    await failure(t.issue(), 'tax_configuration_changed', 409); noInvoice(t); expect(t.dependencies.gateway.calculate).toHaveBeenCalledTimes(1); expect(t.dependencies.transactionLocation).toHaveBeenCalledTimes(1);
  });
  const alternateScopes: readonly { name: string; change: (r: ResolvedStripeTaxRequest) => Partial<StripeTaxResolvedRequestInput> }[] = [
    { name: 'organization', change: r => ({ organizationId: 'other-org', configuration: { ...r.snapshots.configuration, organizationId: 'other-org' }, estimate: { ...r.snapshots.estimate, organizationId: 'other-org', customer: { ...r.snapshots.estimate.customer, organizationId: 'other-org' } }, binding: { ...r.binding, organizationId: 'other-org' } }) },
    { name: 'estimate ID', change: r => ({ estimate: { ...r.snapshots.estimate, id: 'other-estimate' } }) },
    { name: 'estimate revision', change: r => ({ estimate: { ...r.snapshots.estimate, revision: 3 } }) },
    { name: 'invoice date', change: () => ({ invoiceDate: '2026-10-09', taxDateInstant: '2026-10-09T12:00:00.000Z' }) },
    { name: 'private facts content', change: r => ({ taxFacts: { ...r.snapshots.taxFacts, legalName: 'PRIVATE Different Legal Entity' } }) },
  ];
  it.each(alternateScopes)('rejects a valid alternate $name envelope without recalculating', async ({ change }) => {
    const t = await fixture(); t.once('calculate', () => { throw new Error(secret); }); await failure(t.issue(), 'service_unavailable', 503);
    const saved = t.saved()!, r = saved.resolved as ResolvedStripeTaxRequest, resolved = await reResolve(r, change(r), t.dependencies.now());
    t.replaceSaved({ ...saved, resolved });
    await failure(t.issue(), 'tax_configuration_changed', 409); noInvoice(t); expect(t.dependencies.gateway.calculate).toHaveBeenCalledTimes(1);
  });
  it.each(['idempotencyKey','paramsBody','paramsSha256','resolvedBody','resolvedSha256','params'] as const)('rejects corrupted retained %s without choosing another provider key', async key => {
    const t = await fixture(); t.once('calculate', () => { throw new Error(secret); }); await failure(t.issue(), 'service_unavailable', 503);
    const saved = t.saved()!, r = saved.resolved as ResolvedStripeTaxRequest;
    const corrupt = key === 'params' ? { ...r.params, tax_date: r.params.tax_date + 1 } : key.endsWith('Sha256') ? 'f'.repeat(64) : key === 'idempotencyKey' ? `ztax_test_${'f'.repeat(64)}` : '{}';
    t.replaceSaved({ ...saved, resolved: { ...r, [key]: corrupt } });
    await failure(t.issue(), 'invalid_request', 422); noInvoice(t); expect(t.dependencies.gateway.calculate).toHaveBeenCalledTimes(1); expect(t.dependencies.operationId).toHaveBeenCalledTimes(1);
  });
  it.each(['accountId','mode','apiVersion','evidenceKind'] as const)('rejects gateway observation %s binding mismatch without recording proof', async key => {
    const t = await fixture(); t.once('calculate', value => { (value as Record<string, unknown>)[key] = key === 'mode' ? 'live' : key === 'evidenceKind' ? 'provider_observation' : 'different-value'; });
    await failure(t.issue(), 'tax_binding_changed', 409); noInvoice(t); expect(t.operations.record).not.toHaveBeenCalled();
  });
  it.each(['context','classification','location','reserve','calculate','record'] as const)('rejects an accessor at %s without invoking it', async phase => {
    const t = await fixture(), getter = vi.fn(() => { throw new Error(secret); });
    t.once(phase, value => { const target = phase === 'classification' ? (value as unknown[])[0] : value; Object.defineProperty(target, 'privateAccessor', { enumerable: true, get: getter }); });
    await failure(t.issue(), 'service_unavailable', 503); noInvoice(t); expect(getter).not.toHaveBeenCalled();
  });
  it.each(['inherited','cycle','sparse','nonfinite','symbol','hidden'] as const)('rejects %s private JSON without a provider calculation', async kind => {
    const t = await fixture(); t.once('context', value => {
      const context = value as Record<string, unknown>;
      if (kind === 'inherited') Object.setPrototypeOf(context, { private: secret });
      if (kind === 'cycle') context.private = context;
      if (kind === 'sparse') { const sparse: unknown[] = []; sparse.length = 2; context.private = sparse; }
      if (kind === 'nonfinite') context.private = Infinity;
      if (kind === 'symbol') Object.defineProperty(context, Symbol('private'), { enumerable: true, value: secret });
      if (kind === 'hidden') Object.defineProperty(context, 'private', { enumerable: false, value: secret });
    });
    await failure(t.issue(), 'service_unavailable', 503); noInvoice(t); expect(t.dependencies.gateway.calculate).not.toHaveBeenCalled(); expect(t.operations.reserve).not.toHaveBeenCalled();
  });
  it.each(['organizationId','actor','configuration'] as const)('rejects an inconsistent financial context %s before reservation', async key => {
    const t = await fixture(); t.once('context', value => {
      const context = value as Record<string, unknown>;
      context[key] = key === 'organizationId' ? 'other-org' : key === 'actor' ? { ...t.context.actor, userId: 'other-user' } : { ...t.context.configuration, invoiceNumberPrefix: 'OTHER' };
    });
    await failure(t.issue(), 'tax_configuration_changed', 409); noInvoice(t); expect(t.operations.reserve).not.toHaveBeenCalled(); expect(t.dependencies.gateway.calculate).not.toHaveBeenCalled();
  });
  it('rejects changed classifications after calculation before recording', async () => {
    const t = await fixture(); t.once('calculate', () => { t.dependencies.classifications.mockResolvedValue([{ lineId: 'line', taxCode: 'txcd_99999999', kind: 'service', taxBehavior: 'exclusive', revision: 2, evidenceReference: 'different-classification' }]); });
    await failure(t.issue(), 'tax_classification_changed', 409); noInvoice(t); expect(t.operations.record).not.toHaveBeenCalled();
  });
  it('rejects an ERP revision changed during calculation before recording', async () => {
    const t = await fixture(); t.once('calculate', () => t.editState(state => ({ ...state, revision: 5 })));
    await failure(t.issue(), 'revision_conflict', 409); expect(t.state().invoices).toEqual([]); expect(t.coreCommit).not.toHaveBeenCalled(); expect(t.operations.record).not.toHaveBeenCalled();
  });
  it.each(['proofBody','proofSha256','assessment'] as const)('rejects changed recorded %s before issuing', async key => {
    const t = await fixture(); t.once('record', value => {
      const operation = value as { calculation: Record<string, unknown> };
      operation.calculation[key] = key === 'proofBody' ? '{}' : key === 'proofSha256' ? 'f'.repeat(64) : { private: secret };
    });
    await failure(t.issue(), 'invalid_tax_calculation', 409); noInvoice(t); expect(t.dependencies.gateway.calculate).toHaveBeenCalledTimes(1);
  });
  it.each(['extra','accessor','wrongCommandHash','wrongEntity','wrongRevision'] as const)('withholds a malformed committed receipt (%s) and recovers only the clean ERP receipt', async kind => {
    const t = await fixture(), getter = vi.fn(() => { throw new Error(secret); }), commit = t.operations.commit.getMockImplementation()!;
    t.operations.commit.mockImplementationOnce(async (id, input) => {
      const clean = await commit(id, input), result = { ...clean };
      if (kind === 'extra') Object.assign(result, { proofBody: secret });
      if (kind === 'accessor') Object.defineProperty(result, 'entityId', { enumerable: true, get: getter });
      if (kind === 'wrongCommandHash') result.commandHash = 'f'.repeat(64);
      if (kind === 'wrongEntity') result.entityId = 'other-invoice';
      if (kind === 'wrongRevision') result.revision++;
      return result;
    });
    await failure(t.issue(), kind === 'extra' || kind === 'accessor' ? 'invalid_stored_state' : 'invalid_stored_tax_operation', 503);
    expect(getter).not.toHaveBeenCalled(); expect(t.state().counters.invoice).toBe(1); expect(t.saved()!.status).toBe('committed');
    const result = await t.issue(); expect(result.replayed).toBe(true); expect(Object.keys(result.receipt)).toHaveLength(5); expect(JSON.stringify(result)).not.toContain(secret); expect(t.coreCommit).toHaveBeenCalledTimes(1);
  });
});
