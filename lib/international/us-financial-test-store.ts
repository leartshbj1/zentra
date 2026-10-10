import { SupabaseServerError } from '../supabase-server';
import type { FinancialAuthority } from './accounting/ledger';
import { sha256Hex } from './canonical-hash';
import { canonicalErpJson, ErpError } from './erp-contract';
import { validateErpReceipt } from './erp-receipt';
import { parseInstant } from './localization';
import { snapshotPrivateJson } from './private-json';
import { validateUsFinancialBookV5 } from './us-financial-kernel';
import { isUsFinancialCommercialCommandV5, validateUsFinancialReceiptV5, validateUsFinancialRequestV5, type UsFinancialCommitV5, type UsFinancialKernelStoreV5, type UsFinancialReceiptV5 } from './us-financial-kernel-runtime';
import type { UsFinancialBookV5 } from './us-financial-kernel-types';
import { captureUsFinancialTestScopeV5, type UsFinancialTestScopeV5 } from './us-financial-test-foundation';

type Profile = 'settlement' | 'commercial';
const same = (a: unknown, b: unknown) => canonicalErpJson(a) === canonicalErpJson(b);
const fail = (code = 'invalid_financial_private_data', status = 503): never => { throw new ErpError(code, status); };
function capture(value: unknown): unknown { try { return snapshotPrivateJson(value); } catch { return fail(); } }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) return fail();
  return value as Record<string, unknown>;
}
function key(value: unknown, maximum = 232): string {
  if (typeof value !== 'string' || value.length > maximum || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) return fail('invalid_financial_request', 422);
  return value;
}
function hash(value: unknown): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) return fail(); return value; }
function actor(value: unknown, bound: UsFinancialTestScopeV5): FinancialAuthority {
  const a = exact(value, ['organizationId', 'userId', 'role', 'managementEntitled', 'timestamp']);
  if (a.organizationId !== bound.organizationId) return fail('tenant_mismatch', 403);
  if (a.userId !== bound.actor.userId || a.role !== bound.actor.role || a.managementEntitled !== true) return fail('financial_authority_changed', 403);
  if (typeof a.timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(a.timestamp)) return fail();
  try { parseInstant(a.timestamp); } catch { return fail(); }
  return a as unknown as FinancialAuthority;
}
const codes: Readonly<Record<string, readonly [string, number]>> = {
  PF001: ['revision_conflict', 409], PF002: ['idempotency_conflict', 409], PF003: ['financial_immutable', 409],
  PF004: ['invalid_financial_private_data', 503], PF005: ['financial_test_grant_required', 403], PF006: ['financial_test_grant_changed', 409],
  PF007: ['financial_configuration_changed', 409], PF008: ['financial_upgrade_required', 409], PF009: ['financial_capability_unavailable', 503],
  PF010: ['financial_append_unavailable', 409], PF011: ['financial_policy_unavailable', 409], PF012: ['financial_book_too_large', 413],
  PF013: ['settlement_amount_conflict', 409], PF014: ['financial_tax_plan_required', 409], PF015: ['accounting_period_not_open', 409], PF016: ['financial_clock_reversed', 409],
  PO008: ['sales_order_source_locked', 409],
};
function error(value: unknown): ErpError {
  if (value instanceof ErpError) return value;
  const known = value instanceof SupabaseServerError ? codes[value.code] : undefined;
  return new ErpError(known?.[0] ?? 'financial_service_unavailable', known?.[1] ?? 503);
}
function financialReceipt(value: unknown, profile: Profile): UsFinancialReceiptV5 {
  let receipt: UsFinancialReceiptV5;
  try { receipt = validateUsFinancialReceiptV5(value); } catch { return fail(); }
  if (receipt.action !== 'customer_credit' && receipt.action !== 'customer_payment' && !(profile === 'commercial' && receipt.action === 'erp_command')) return fail('financial_append_unavailable', 409);
  key(receipt.idempotencyKey, 200); hash(receipt.commandHash);
  if (receipt.revision >= Number.MAX_SAFE_INTEGER) return fail();
  return receipt;
}
async function eventReceipt(book: UsFinancialBookV5, revision: number): Promise<UsFinancialReceiptV5> {
  const event = book.events.find(e => e.revision === revision);
  if (!event) return fail();
  const { idempotencyKey, ...fields } = event.operation;
  const command = fields.type === 'erp_command' ? { type: 'erp_command', request: fields.command } : fields.type === 'customer_credit' ? (() => { const { taxProof: _proof, ...publicFields } = fields; return { ...publicFields, id: event.id }; })() : { ...fields, id: event.id };
  const request = validateUsFinancialRequestV5({ idempotencyKey, expectedRevision: event.revision - 1, command }, book.baseline.configuration.organizationId);
  return Object.freeze({ idempotencyKey, commandHash: await sha256Hex(canonicalErpJson([event.actor.organizationId, event.actor.userId, request])), revision, entityId: event.id, action: event.operation.type, actorId: event.actor.userId });
}

/** Shared server-only local TEST mechanics. Profiles are selected only by the
 * two named factory entry points below. Promotion is a separate action.
 * PostgreSQL independently admits each closed set under a living grant;
 * this is not public ERP5 or production D1/Auth/Stripe authority.
 * No automatic retry, provider action or client-supplied tax authorization.
 * The callback must read trusted authority; a pre/post check is not a
 * distributed D1/PostgreSQL transaction. */
function createPrivateTestStore(
  client: { rpc(functionName: string, parameters: Readonly<Record<string, unknown>>): Promise<unknown> },
  initialScope: UsFinancialTestScopeV5,
  revalidate: (this: void) => Promise<UsFinancialTestScopeV5>,
  profile: Profile,
): UsFinancialKernelStoreV5 {
  const capability = profile === 'commercial' ? 'postgres-test-commercial-v5' : 'postgres-test-settlement-v5';
  const readRpc = `zentra_read_us_financial_${profile}_test_v5`, receiptRpc = `zentra_us_financial_${profile}_test_receipt_v5`, appendRpc = `zentra_append_us_financial_${profile}_test_v5`;
  const bound = captureUsFinancialTestScopeV5(initialScope);
  if (typeof revalidate !== 'function') return fail('financial_test_grant_required', 403);
  let lastObservedAt = Date.parse(bound.actor.timestamp);
  async function fresh(minimumActor = bound.actor): Promise<void> {
    let current: UsFinancialTestScopeV5;
    try {
      current = captureUsFinancialTestScopeV5(await revalidate());
    } catch (caught) { throw error(caught); }
    if (current.organizationId !== bound.organizationId || current.actor.userId !== bound.actor.userId || current.actor.role !== bound.actor.role) return fail('financial_authority_changed', 403);
    if (current.grantVersion !== bound.grantVersion) return fail('financial_test_grant_changed', 409);
    if (!same(current.policy, bound.policy)) return fail('financial_policy_unavailable', 409);
    const observedAt = Date.parse(current.actor.timestamp);
    if (observedAt < lastObservedAt || observedAt < Date.parse(minimumActor.timestamp)) return fail('financial_clock_reversed', 409);
    lastObservedAt = observedAt;
  }
  function tenant(organizationId: string): void { if (organizationId !== bound.organizationId) return fail('tenant_mismatch', 403); }
  async function book(value: unknown): Promise<UsFinancialBookV5> {
    let result: UsFinancialBookV5;
    try { result = await validateUsFinancialBookV5(value, bound.organizationId, bound.policy); } catch { return fail(); }
    if (result.events.some(e => e.operation.type === 'erp_command' && (profile === 'settlement' || !isUsFinancialCommercialCommandV5(e.operation.command)))) return fail('financial_append_unavailable', 409);
    return result;
  }
  async function call<T>(name: string, extra: Readonly<Record<string, unknown>>, parse: (value: unknown) => Promise<T> | T, executionActor = bound.actor): Promise<T> {
    await fresh(executionActor);
    let outcome: { value: T } | { error: unknown };
    try {
      const value = capture(await client.rpc(name, { p_organization: bound.organizationId, p_actor: executionActor, p_grant_version: bound.grantVersion, p_capability: capability, ...extra }));
      outcome = { value: await parse(value) };
    } catch (caught) { outcome = { error: caught }; }
    await fresh(executionActor);
    if ('error' in outcome) throw error(outcome.error);
    return outcome.value;
  }
  async function read(): Promise<UsFinancialBookV5 | null> {
    return call(readRpc, {}, value => value === null ? null : book(value));
  }
  async function computed<T>(task: () => Promise<T>, executionActor: FinancialAuthority): Promise<T> {
    await fresh(executionActor);
    let outcome: { value: T } | { error: unknown };
    try { outcome = { value: await task() }; } catch (caught) { outcome = { error: caught }; }
    await fresh(executionActor);
    if ('error' in outcome) throw error(outcome.error);
    return outcome.value;
  }
  return Object.freeze({
    capability,
    read: (organizationId: string) => { tenant(organizationId); return read(); },
    receipt: async (organizationId: string, requestedKey: string) => {
      tenant(organizationId); const requested = key(requestedKey);
      const receipt = await call<UsFinancialReceiptV5 | null>(receiptRpc, { p_idempotency_key: requested }, value => {
        if (value === null) return null;
        const envelope = exact(value, ['origin', 'actorId', 'receipt']);
        if (typeof envelope.actorId !== 'string' || !envelope.actorId || envelope.actorId.length > 256) return fail();
        if (envelope.origin === 'legacy_erp4') {
          try { if (validateErpReceipt(envelope.receipt, bound.organizationId).idempotencyKey !== requested) return fail(); } catch { return fail(); }
          return fail('idempotency_conflict', 409);
        }
        if (envelope.origin === 'promotion') {
          const r = exact(envelope.receipt, ['schemaVersion', 'organizationId', 'idempotencyKey', 'commandHash', 'revision', 'baselineRevision', 'baselineSha256', 'actorId', 'action']);
          if (r.schemaVersion !== 1 || r.organizationId !== bound.organizationId || r.idempotencyKey !== requested || r.actorId !== envelope.actorId || r.action !== 'promote_financial_book') return fail();
          hash(r.commandHash); hash(r.baselineSha256);
          if (!Number.isSafeInteger(r.baselineRevision) || (r.baselineRevision as number) < 1 || r.revision !== (r.baselineRevision as number) + 1) return fail();
          return fail('idempotency_conflict', 409);
        }
        if (envelope.origin !== 'financial_v5') return fail();
        const r = financialReceipt(envelope.receipt, profile);
        if (r.idempotencyKey !== requested || r.actorId !== envelope.actorId) return fail();
        return r;
      });
      if (receipt === null) return null;
      const current = await read();
      let outcome: { value: UsFinancialReceiptV5 } | { error: unknown };
      try {
        if (!current || !same(await eventReceipt(current, receipt.revision), receipt)) return fail();
        outcome = { value: receipt };
      } catch (caught) { outcome = { error: caught }; }
      await fresh();
      if ('error' in outcome) throw error(outcome.error);
      return outcome.value;
    },
    commit: async (input: UsFinancialCommitV5) => {
      const candidate = exact(capture(input), ['organizationId', 'expectedRevision', 'previousFingerprint', 'book', 'receipt', 'actor']);
      tenant(candidate.organizationId as string);
      const executionActor = actor(candidate.actor, bound), fingerprint = hash(candidate.previousFingerprint);
      if (!Number.isSafeInteger(candidate.expectedRevision) || (candidate.expectedRevision as number) < 1 || (candidate.expectedRevision as number) >= Number.MAX_SAFE_INTEGER - 1) return fail('invalid_financial_request', 422);
      const { proposed, receipt } = await computed(async () => {
        const proposed = await book(candidate.book), receipt = financialReceipt(candidate.receipt, profile);
        const event = proposed.events.at(-1);
        if (!event || proposed.revision !== (candidate.expectedRevision as number) + 1 || event.revision !== proposed.revision || !same(event.actor, executionActor)) return fail();
        const previous = { ...proposed, revision: candidate.expectedRevision, events: proposed.events.slice(0, -1) };
        if (await sha256Hex(canonicalErpJson(previous)) !== fingerprint || !same(await eventReceipt(proposed, proposed.revision), receipt)) return fail();
        return { proposed, receipt };
      }, executionActor);
      return call(appendRpc, { p_expected_revision: candidate.expectedRevision, p_previous_fingerprint: fingerprint, p_book: proposed, p_receipt: receipt }, value => {
        const retained = financialReceipt(value, profile); if (!same(retained, receipt)) return fail(); return retained;
      }, executionActor);
    },
  });
}

type PrivateClient = Parameters<typeof createPrivateTestStore>[0];
type ScopeReader = Parameters<typeof createPrivateTestStore>[2];
/** Credits and payments only; never admits an ERP command or mixed tail. */
export function createSupabaseUsFinancialSettlementTestStoreV5(client: PrivateClient, scope: UsFinancialTestScopeV5, revalidate: ScopeReader): UsFinancialKernelStoreV5 {
  return createPrivateTestStore(client, scope, revalidate, 'settlement');
}
/** Commercial continuity plus credits/payments, not the full memory ERP set. */
export function createSupabaseUsFinancialCommercialTestStoreV5(client: PrivateClient, scope: UsFinancialTestScopeV5, revalidate: ScopeReader): UsFinancialKernelStoreV5 {
  return createPrivateTestStore(client, scope, revalidate, 'commercial');
}
