import { SupabaseServerError } from '../supabase-server';
import type { FinancialAuthority } from './accounting/ledger';
import { sha256Hex } from './canonical-hash';
import { canonicalErpJson, ErpError } from './erp-contract';
import { validateErpReceipt } from './erp-receipt';
import { parseInstant } from './localization';
import { snapshotPrivateJson } from './private-json';
import type { ErpReceipt } from './runtime-types';
import { validateUsFinancialBookV5 } from './us-financial-kernel';
import type { UsFinancialBookV5, UsFinancialPolicyV5 } from './us-financial-kernel-types';

/** Private local TEST authority. Provisioning/revocation happens under the PG
 * grant lock. This is not a D1 membership, a public DTO or a production grant. */
export interface UsFinancialTestScopeV5 {
  readonly organizationId: string;
  readonly actor: FinancialAuthority;
  readonly policy: UsFinancialPolicyV5;
  readonly grantVersion: number;
}
export interface UsFinancialPromotionReceiptV5 {
  readonly schemaVersion: 1;
  readonly organizationId: string;
  readonly idempotencyKey: string;
  readonly commandHash: string;
  readonly revision: number;
  readonly baselineRevision: number;
  readonly baselineSha256: string;
  readonly actorId: string;
  readonly action: 'promote_financial_book';
}
export type UsFinancialTestReceiptV5 = Readonly<{
  origin: 'legacy_erp4'; actorId: string; receipt: ErpReceipt;
}> | Readonly<{
  origin: 'promotion'; actorId: string; receipt: UsFinancialPromotionReceiptV5;
}>;
export interface UsFinancialTestPromotionV5 {
  readonly book: UsFinancialBookV5;
  readonly receipt: UsFinancialPromotionReceiptV5;
  readonly replayed: boolean;
}
/** A deliberately separate capability: it can persist/read a promotion, but
 * cannot append financial events or satisfy UsFinancialKernelStoreV5. SQL
 * independently refuses append with PF010; no runtime flag can enable it. */
export interface UsFinancialTestFoundationV5 {
  readonly capability: 'postgres-test-foundation-v5';
  read(this: void): Promise<UsFinancialBookV5 | null>;
  receipt(this: void, key: string): Promise<UsFinancialTestReceiptV5 | null>;
  promote(this: void, input: Readonly<{ book: UsFinancialBookV5; idempotencyKey: string }>): Promise<UsFinancialTestPromotionV5>;
}
const capability = 'postgres-test-foundation-v5' as const;
const same = (a: unknown, b: unknown) => canonicalErpJson(a) === canonicalErpJson(b);
const fail = (code = 'invalid_financial_private_data', status = 503): never => { throw new ErpError(code, status); };
function capture(value: unknown): unknown {
  try { return snapshotPrivateJson(value); } catch { return fail(); }
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) return fail();
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > maximum || Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return fail();
  return value;
}
function instant(value: unknown): void {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return fail();
  try { parseInstant(value); } catch { return fail(); }
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) return fail();
  return value;
}
function key(value: unknown, maximum = 232): string {
  if (typeof value !== 'string' || value.length > maximum || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) return fail('invalid_financial_request', 422);
  return value;
}
function scope(value: unknown): UsFinancialTestScopeV5 {
  const s = exact(capture(value), ['organizationId', 'actor', 'policy', 'grantVersion']);
  const organizationId = text(s.organizationId, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(organizationId)) return fail();
  const a = exact(s.actor, ['organizationId', 'userId', 'role', 'managementEntitled', 'timestamp']);
  if (a.organizationId !== organizationId) return fail('tenant_mismatch', 403);
  if (a.managementEntitled !== true) return fail('management_entitlement_required', 402);
  if (typeof a.role !== 'string' || !['owner', 'admin', 'accountant'].includes(a.role)) return fail('financial_permission_required', 403);
  text(a.userId, 256); instant(a.timestamp);
  if (!Number.isSafeInteger(s.grantVersion) || (s.grantVersion as number) < 1 || (s.grantVersion as number) >= Number.MAX_SAFE_INTEGER) return fail('financial_test_grant_required', 403);
  const p = exact(s.policy, ['version', 'environment', 'approval']);
  if (p.version !== 'us-accrual-receivable-credit-v1' || p.environment !== 'test') return fail('financial_policy_unavailable', 409);
  const approval = exact(p.approval, ['reference', 'reviewedBy', 'reviewedAt']);
  text(approval.reference, 500); text(approval.reviewedBy, 256); instant(approval.reviewedAt);
  return s as unknown as UsFinancialTestScopeV5;
}
function promotionReceipt(value: unknown, organizationId: string, requestedKey: string): UsFinancialPromotionReceiptV5 {
  const r = exact(value, ['schemaVersion', 'organizationId', 'idempotencyKey', 'commandHash', 'revision', 'baselineRevision', 'baselineSha256', 'actorId', 'action']);
  if (r.schemaVersion !== 1 || r.organizationId !== organizationId || r.idempotencyKey !== requestedKey || r.action !== 'promote_financial_book'
    || !Number.isSafeInteger(r.baselineRevision) || (r.baselineRevision as number) < 1 || (r.baselineRevision as number) >= Number.MAX_SAFE_INTEGER - 1
    || r.revision !== (r.baselineRevision as number) + 1) return fail();
  key(r.idempotencyKey, 200); hash(r.commandHash); hash(r.baselineSha256); text(r.actorId, 256);
  return r as unknown as UsFinancialPromotionReceiptV5;
}
const databaseErrors: Readonly<Record<string, readonly [string, number]>> = {
  PF001: ['revision_conflict', 409], PF002: ['idempotency_conflict', 409], PF003: ['financial_immutable', 409],
  PF004: ['invalid_financial_private_data', 503], PF005: ['financial_test_grant_required', 403], PF006: ['financial_test_grant_changed', 409],
  PF007: ['financial_configuration_changed', 409], PF008: ['financial_upgrade_required', 409], PF009: ['financial_capability_unavailable', 503],
  PF010: ['financial_append_unavailable', 409], PF011: ['financial_policy_unavailable', 409], PF012: ['financial_book_too_large', 413],
};
function databaseError(error: unknown): ErpError {
  if (error instanceof ErpError) return error;
  const known = error instanceof SupabaseServerError ? databaseErrors[error.code] : undefined;
  return new ErpError(known?.[0] ?? 'financial_service_unavailable', known?.[1] ?? 503);
}
/** Server-only adapter for locally provisioned TEST grants. The callback must
 * re-read trusted authority, not echo browser input. PG independently locks its
 * own grant. Nothing here makes a cross-database D1 revocation atomic. No retry
 * is performed automatically, including on a timeout after promotion. The
 * initial actor remains immutable provenance for an exact promotion retry;
 * its timestamp is not a freshness attestation. Revalidation and the living
 * versioned PG grant provide admission, not that historical timestamp. */
export function createSupabaseUsFinancialTestFoundationV5(
  client: { rpc(functionName: string, parameters: Readonly<Record<string, unknown>>): Promise<unknown> },
  initialScope: UsFinancialTestScopeV5,
  revalidate: (this: void) => Promise<UsFinancialTestScopeV5>,
): UsFinancialTestFoundationV5 {
  const bound = scope(initialScope);
  if (typeof revalidate !== 'function') return fail('financial_test_grant_required', 403);
  async function fresh(): Promise<void> {
    let current: UsFinancialTestScopeV5;
    try { current = scope(await revalidate()); } catch (error) { throw databaseError(error); }
    if (current.organizationId !== bound.organizationId || current.actor.userId !== bound.actor.userId || current.actor.role !== bound.actor.role) return fail('financial_authority_changed', 403);
    if (current.grantVersion !== bound.grantVersion) return fail('financial_test_grant_changed', 409);
    if (!same(current.policy, bound.policy)) return fail('financial_policy_unavailable', 409);
  }
  async function book(value: unknown): Promise<UsFinancialBookV5> {
    try {
      const result = await validateUsFinancialBookV5(value, bound.organizationId, bound.policy);
      // A future append capability must independently prove reconstruction.
      if (result.events.length !== 0) return fail();
      return result;
    } catch { return fail(); }
  }
  async function call<T>(name: string, extra: Readonly<Record<string, unknown>>, parse: (value: unknown) => Promise<T> | T): Promise<T> {
    await fresh();
    let outcome: { value: T } | { error: unknown };
    try {
      const value = capture(await client.rpc(name, {
        p_organization: bound.organizationId, p_actor: bound.actor, p_grant_version: bound.grantVersion, p_capability: capability, ...extra,
      }));
      outcome = { value: await parse(value) };
    } catch (error) { outcome = { error }; }
    // Revocation takes precedence even if the RPC failed or its result is bad.
    await fresh();
    if ('error' in outcome) throw databaseError(outcome.error);
    return outcome.value;
  }
  return Object.freeze({
    capability,
    read: () => call('zentra_read_us_financial_test_v5', {}, value => value === null ? null : book(value)),
    receipt: async (requestedKey: string) => {
      const requested = key(requestedKey);
      const retained = await call<UsFinancialTestReceiptV5 | null>('zentra_us_financial_test_receipt_v5', { p_idempotency_key: requested }, value => {
        if (value === null) return null;
        const envelope = exact(value, ['origin', 'actorId', 'receipt']);
        const actorId = text(envelope.actorId, 256);
        if (envelope.origin === 'legacy_erp4') {
          let receipt: ErpReceipt;
          try { receipt = validateErpReceipt(envelope.receipt, bound.organizationId); } catch { return fail(); }
          if (receipt.idempotencyKey !== requested) return fail();
          return Object.freeze({ origin: 'legacy_erp4' as const, actorId, receipt });
        }
        if (envelope.origin !== 'promotion') return fail();
        const receipt = promotionReceipt(envelope.receipt, bound.organizationId, requested);
        if (receipt.actorId !== actorId) return fail();
        return Object.freeze({ origin: 'promotion' as const, actorId, receipt });
      });
      if (retained === null) return null;
      // The foundation is immutable after promotion. Corroborate this private
      // index against its actual book rather than trusting receipt shape alone.
      const current = await call('zentra_read_us_financial_test_v5', {}, value => value === null ? null : book(value));
      if (current === null) return fail();
      let corroborationError: unknown, corroborationFailed = false;
      try {
        if (retained.origin === 'legacy_erp4') {
          if (retained.receipt.revision > current.baseline.revision) return fail();
        } else {
          const r = retained.receipt;
          const commandHash = await sha256Hex(canonicalErpJson([bound.organizationId, current.promotion.actor.userId, {
            type: 'promote_financial_book', idempotencyKey: requested, baselineRevision: current.baseline.revision,
            baselineSha256: current.promotion.baselineSha256, policy: current.policy,
          }]));
          if (r.revision !== current.revision || r.baselineRevision !== current.baseline.revision
            || r.baselineSha256 !== current.promotion.baselineSha256 || r.actorId !== current.promotion.actor.userId || r.commandHash !== commandHash) return fail();
        }
      } catch (error) { corroborationFailed = true; corroborationError = error; }
      await fresh();
      if (corroborationFailed) throw databaseError(corroborationError);
      return retained;
    },
    promote: async (input: Readonly<{ book: UsFinancialBookV5; idempotencyKey: string }>) => {
      // Detach before validation/hash/revalidation can yield to another task.
      const captured = exact(capture(input), ['book', 'idempotencyKey']);
      const requested = key(captured.idempotencyKey, 200);
      if (bound.actor.role !== 'owner') return fail('owner_required', 403);
      const proposed = await book(captured.book);
      if (!same(proposed.promotion.actor, bound.actor)) return fail('financial_authority_changed', 403);
      const commandHash = await sha256Hex(canonicalErpJson([bound.organizationId, bound.actor.userId, {
        type: 'promote_financial_book', idempotencyKey: requested, baselineRevision: proposed.baseline.revision,
        baselineSha256: proposed.promotion.baselineSha256, policy: proposed.policy,
      }]));
      return call('zentra_promote_us_financial_test_v5', { p_book: proposed, p_idempotency_key: requested, p_command_hash: commandHash }, async value => {
        const result = exact(value, ['book', 'receipt', 'replayed']);
        if (typeof result.replayed !== 'boolean') return fail();
        const retained = await book(result.book), receipt = promotionReceipt(result.receipt, bound.organizationId, requested);
        if (!same(retained, proposed) || receipt.actorId !== bound.actor.userId || receipt.commandHash !== commandHash
          || receipt.revision !== retained.revision || receipt.baselineRevision !== retained.baseline.revision || receipt.baselineSha256 !== retained.promotion.baselineSha256) return fail();
        return Object.freeze({ book: retained, receipt, replayed: result.replayed });
      });
    },
  });
}
