import { SupabaseServerError } from '../supabase-server';
import type { FinancialAuthority } from './accounting/ledger';
import { sha256Hex } from './canonical-hash';
import { canonicalErpJson, ErpError } from './erp-contract';
import type { Estimate } from './invoicing';
import { snapshotPrivateJson } from './private-json';
import type { ResolvedStripeTaxRequest } from './stripe-tax-resolved-request';
import type { ValidatedStripeTaxCalculation } from './stripe-tax-calculation';
import { validateUsFinancialRequestV5 } from './us-financial-kernel-runtime';
import { captureUsFinancialTestScopeV5, type UsFinancialTestScopeV5 } from './us-financial-test-foundation';
import { resolveUsFinancialInvoicePreparationV5, validateUsFinancialInvoiceContextV5, validateUsFinancialInvoiceOperationV5, validateUsFinancialInvoicePreparationV5, type UsFinancialInvoiceOperationV5, type UsFinancialInvoicePreflightInputV5, type UsFinancialInvoicePreflightV5, type UsFinancialInvoicePreparationV5, type UsFinancialInvoiceTestStoreV5 } from './us-financial-invoice-test';

const capability = 'postgres-test-invoicing-v5' as const;
const same = (a: unknown, b: unknown) => canonicalErpJson(a) === canonicalErpJson(b);
const fail = (code = 'invalid_financial_invoice_private_data', status = 503): never => { throw new ErpError(code, status); };
function capture<T>(value: T): T { try { return snapshotPrivateJson(value) as T; } catch { return fail(); } }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Reflect.ownKeys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) return fail();
  return value as Record<string, unknown>;
}
function hash(value: unknown): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) return fail(); return value; }
function mapped(caught: unknown): ErpError {
  if (caught instanceof ErpError) return caught;
  if (caught instanceof SupabaseServerError) {
    const codes: Record<string, readonly [string, number]> = {
      PF001: ['revision_conflict', 409], PF002: ['idempotency_conflict', 409], PF003: ['financial_history_immutable', 409],
      PF004: ['invalid_financial_invoice_private_data', 503], PF005: ['financial_test_grant_required', 403], PF006: ['financial_test_grant_changed', 409],
      PF007: ['financial_configuration_changed', 409], PF008: ['financial_upgrade_required', 409], PF009: ['financial_capability_unavailable', 503],
      PF010: ['financial_append_unavailable', 409], PF011: ['financial_policy_unavailable', 409], PF012: ['financial_book_too_large', 413],
      PF013: ['settlement_amount_conflict', 409], PF014: ['financial_invoice_evidence_required', 409], PF015: ['accounting_period_not_open', 409], PF016: ['financial_clock_reversed', 409],
      PO008: ['sales_order_source_locked', 409], PO011: ['sales_order_confirmation_required', 409],
    };
    if (codes[caught.code]) return new ErpError(...codes[caught.code]);
  }
  return new ErpError('service_unavailable', 503);
}
/** Captured private TEST scope, pre/post authority fences and own-data-only
 * responses. SQL separately proves DB-owner context provenance, source/CAS and
 * the final financial event link; this adapter cannot create merchant contexts. */
export function createSupabaseUsFinancialInvoiceTestStoreV5(
  client: Readonly<{ rpc(name: string, args: Readonly<Record<string, unknown>>): Promise<unknown> }>,
  scope: UsFinancialTestScopeV5,
  revalidate: () => Promise<UsFinancialTestScopeV5>,
  options: Readonly<{ allowTestFixtures?: boolean }> = {},
): UsFinancialInvoiceTestStoreV5 {
  const bound = captureUsFinancialTestScopeV5(scope), rpc = client.rpc.bind(client), allowFixtures = options.allowTestFixtures === true;
  if (typeof revalidate !== 'function') return fail('financial_test_grant_required', 403);
  let lastObservedAt = Date.parse(bound.actor.timestamp);
  function actor(input: FinancialAuthority): FinancialAuthority {
    const captured = captureUsFinancialTestScopeV5({ ...bound, actor: input }).actor;
    if (captured.userId !== bound.actor.userId || captured.role !== bound.actor.role) return fail('financial_authority_changed', 403);
    return captured;
  }
  async function fresh(minimum: FinancialAuthority): Promise<void> {
    let current: UsFinancialTestScopeV5;
    try { current = captureUsFinancialTestScopeV5(await revalidate()); } catch (caught) { throw mapped(caught); }
    if (current.organizationId !== bound.organizationId || current.actor.userId !== bound.actor.userId || current.actor.role !== bound.actor.role) return fail('financial_authority_changed', 403);
    if (current.grantVersion !== bound.grantVersion) return fail('financial_test_grant_changed', 409);
    if (!same(current.policy, bound.policy)) return fail('financial_policy_unavailable', 409);
    const stamp = Date.parse(current.actor.timestamp);
    if (stamp < lastObservedAt || stamp < Date.parse(minimum.timestamp)) return fail('financial_clock_reversed', 409);
    lastObservedAt = stamp;
  }
  async function guarded<T>(a: FinancialAuthority, task: () => Promise<T>): Promise<T> {
    await fresh(a); let result: T | undefined, caught: unknown, failed = false;
    try { const value = await task(); result = value === undefined ? value : capture(value); } catch (error) { caught = error; failed = true; }
    await fresh(a); if (failed) throw mapped(caught); return result as T;
  }
  async function call<T>(name: string, a: FinancialAuthority, input: Readonly<Record<string, unknown>>, validate: (value: unknown) => Promise<T>): Promise<T> {
    // Capture the entire request before the first revalidation await.
    const args = capture({ p_organization: bound.organizationId, p_actor: a, p_grant_version: bound.grantVersion, p_capability: capability, ...input });
    return guarded(a, async () => validate(capture(await rpc(name, args))));
  }
  async function request(a: FinancialAuthority, input: Pick<UsFinancialInvoicePreflightInputV5, 'request' | 'financialCommandHash' | 'erpCommandHash'>): Promise<void> {
    const r = validateUsFinancialRequestV5(input.request, bound.organizationId);
    if (r.command.type !== 'erp_command' || r.command.request.type !== 'issue_invoice' || r.command.request.dueDate < r.command.request.date || !same(r, input.request)) return fail('invalid_financial_request', 422);
    const erp = { idempotencyKey: r.idempotencyKey, expectedRevision: r.expectedRevision, command: r.command.request };
    if (hash(input.financialCommandHash) !== await sha256Hex(canonicalErpJson([bound.organizationId, a.userId, r])) || hash(input.erpCommandHash) !== await sha256Hex(canonicalErpJson([bound.organizationId, a.userId, erp]))) return fail('idempotency_conflict', 409);
  }
  async function operation(value: unknown, a: FinancialAuthority, input: Pick<UsFinancialInvoicePreflightInputV5, 'request' | 'financialCommandHash' | 'erpCommandHash'>): Promise<UsFinancialInvoiceOperationV5> {
    const result = await validateUsFinancialInvoiceOperationV5(value, bound.organizationId, allowFixtures), p = result.preparation;
    if (p.actorId !== a.userId || !same(p.request, input.request) || p.financialCommandHash !== input.financialCommandHash || p.erpCommandHash !== input.erpCommandHash) return fail();
    return result;
  }
  return Object.freeze({
    async read(inputActor: FinancialAuthority, original: Pick<UsFinancialInvoicePreflightInputV5, 'request' | 'financialCommandHash' | 'erpCommandHash'>) {
      const a = actor(inputActor), input = capture(original); exact(input, ['request', 'financialCommandHash', 'erpCommandHash']);
      await guarded(a, () => request(a, input));
      return call('zentra_read_us_financial_invoice_test_operation_v5', a, { p_idempotency_key: input.request.idempotencyKey, p_financial_command_hash: input.financialCommandHash, p_erp_command_hash: input.erpCommandHash }, async value => value === null ? null : operation(value, a, input));
    },
    async preflight(inputActor: FinancialAuthority, original: UsFinancialInvoicePreflightInputV5) {
      const a = actor(inputActor), input = capture(original); exact(input, ['request', 'financialCommandHash', 'erpCommandHash', 'previousBookFingerprint']); hash(input.previousBookFingerprint);
      await guarded(a, () => request(a, input));
      return call('zentra_preflight_us_financial_invoice_test_v5', a, { p_request: input.request, p_financial_command_hash: input.financialCommandHash, p_erp_command_hash: input.erpCommandHash, p_previous_fingerprint: input.previousBookFingerprint }, async value => {
        const result = exact(value, ['context', 'estimate', 'bookRevision', 'bookFingerprint']);
        const context = await validateUsFinancialInvoiceContextV5(result.context, bound.organizationId, allowFixtures), estimate = result.estimate as Estimate, c = input.request.command;
        if (c.type !== 'erp_command' || c.request.type !== 'issue_invoice' || !estimate || estimate.id !== c.request.estimateId || estimate.organizationId !== bound.organizationId || estimate.revision !== c.request.expectedEstimateRevision || estimate.status !== 'accepted' || result.bookRevision !== input.request.expectedRevision || result.bookFingerprint !== input.previousBookFingerprint) return fail();
        return { context, estimate, bookRevision: result.bookRevision, bookFingerprint: result.bookFingerprint } as UsFinancialInvoicePreflightV5;
      });
    },
    async reserve(inputActor: FinancialAuthority, original: UsFinancialInvoicePreparationV5, originalResolved: ResolvedStripeTaxRequest) {
      const a = actor(inputActor), raw = capture(original), resolved = capture(originalResolved);
      const p = await guarded(a, () => validateUsFinancialInvoicePreparationV5(raw, bound.organizationId, allowFixtures));
      if (p.actorId !== a.userId) return fail('financial_authority_changed', 403);
      const expected = await guarded(a, () => resolveUsFinancialInvoicePreparationV5(p, resolved.operationId, p.preparedAt));
      if (!same(expected, resolved)) return fail();
      return call('zentra_reserve_us_financial_invoice_test_v5', a, { p_preparation: p, p_resolved_body: resolved.resolvedBody, p_resolved_sha256: resolved.resolvedSha256, p_params_body: resolved.paramsBody, p_params_sha256: resolved.paramsSha256, p_provider_idempotency_key: resolved.idempotencyKey }, async value => {
        const result = await operation(value, a, p);
        if (!same(result.preparation, p) || result.operationId !== resolved.operationId || result.resolvedBody !== resolved.resolvedBody) return fail();
        return result;
      });
    },
    async record(inputActor: FinancialAuthority, original: UsFinancialInvoiceOperationV5, originalCalculated: ValidatedStripeTaxCalculation) {
      const a = actor(inputActor), raw = capture(original), calculated = capture(originalCalculated);
      const saved = await guarded(a, () => validateUsFinancialInvoiceOperationV5(raw, bound.organizationId, allowFixtures));
      if (saved.preparation.actorId !== a.userId || saved.status === 'committed') return fail('financial_authority_changed', 403);
      const candidate = await guarded(a, () => validateUsFinancialInvoiceOperationV5({ ...saved, status: 'calculated', proofBody: calculated.proofBody, proofSha256: calculated.proofSha256, assessment: calculated.assessment, receipt: null }, bound.organizationId, allowFixtures));
      return call('zentra_record_us_financial_invoice_test_calculation_v5', a, { p_operation_id: saved.operationId, p_proof_body: candidate.proofBody, p_proof_sha256: candidate.proofSha256, p_assessment: candidate.assessment }, async value => {
        const result = await operation(value, a, saved.preparation);
        if (result.operationId !== saved.operationId || !same(result.preparation, saved.preparation) || result.proofBody !== candidate.proofBody || result.proofSha256 !== candidate.proofSha256 || !same(result.assessment, candidate.assessment) || result.status !== 'calculated') return fail();
        return result;
      });
    },
  });
}
