import { SupabaseServerError, type SupabaseServerClient } from '../supabase-server';
import type { FinancialAuthority } from './accounting/ledger';
import { canonicalErpJson, ErpError } from './erp-contract';
import { parseInstant } from './localization';
import { snapshotPrivateJson } from './private-json';
import type { UsFinancialKernelStoreV5 } from './us-financial-kernel-runtime';
import { captureUsFinancialTestScopeV5, type UsFinancialTestScopeV5 } from './us-financial-test-foundation';
import { createSupabaseUsFinancialInvoicingTestStoreV5 } from './us-financial-test-invoicing';
import type { UsFinancialPilotHead } from './us-financial-pilot-contract';

/** Private server authority, never a browser DTO. Auth/D1 admission must come
 * from the caller's trusted callback; PG independently checks its live rows. */
export interface UsFinancialPilotScope {
  readonly scope: UsFinancialTestScopeV5;
  readonly optInVersion: number;
}
export interface UsFinancialPilotStore extends UsFinancialKernelStoreV5 {
  head(this: void): Promise<UsFinancialPilotHead>;
}
type Client = { rpc(functionName: string, parameters: Readonly<Record<string, unknown>>): Promise<unknown> };
const capability = 'postgres-test-financial-pilot-dto1';
const same = (a: unknown, b: unknown) => canonicalErpJson(a) === canonicalErpJson(b);
const fail = (code = 'invalid_financial_private_data', status = 503): never => { throw new ErpError(code, status); };
const errors: Readonly<Record<string, readonly [string, number]>> = {
  PF001: ['revision_conflict', 409], PF002: ['idempotency_conflict', 409], PF003: ['financial_immutable', 409],
  PF004: ['invalid_financial_private_data', 503], PF005: ['financial_test_grant_required', 403], PF006: ['financial_test_grant_changed', 409],
  PF007: ['financial_configuration_changed', 409], PF008: ['financial_upgrade_required', 409], PF009: ['financial_capability_unavailable', 503],
  PF010: ['financial_append_unavailable', 409], PF011: ['financial_policy_unavailable', 409], PF012: ['financial_book_too_large', 413],
  PF013: ['settlement_amount_conflict', 409], PF014: ['financial_tax_plan_required', 409], PF015: ['accounting_period_not_open', 409], PF016: ['financial_clock_reversed', 409],
  PO008: ['sales_order_source_locked', 409], PO011: ['sales_order_confirmation_required', 409],
};
function safeError(error: unknown): Error {
  if (error instanceof ErpError) return error;
  if (error instanceof SupabaseServerError) {
    const mapped = errors[error.code];
    return new ErpError(mapped?.[0] ?? 'financial_service_unavailable', mapped?.[1] ?? 503);
  }
  return new ErpError('financial_service_unavailable', 503);
}
function capture(value: unknown): unknown { try { return snapshotPrivateJson(value); } catch { return fail(); } }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) return fail();
  return value as Record<string, unknown>;
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) >= Number.MAX_SAFE_INTEGER) return fail();
  return value as number;
}
function organization(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) return fail();
  return value;
}
function actor(value: unknown): FinancialAuthority {
  const a = exact(capture(value), ['organizationId', 'userId', 'role', 'managementEntitled', 'timestamp']);
  organization(a.organizationId);
  if (typeof a.userId !== 'string' || !a.userId || a.userId.length > 256 || a.userId !== a.userId.trim() || Array.from(a.userId).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return fail();
  if (a.managementEntitled !== true) return fail('management_entitlement_required', 402);
  if (!['owner', 'admin', 'accountant'].includes(a.role as string)) return fail('financial_permission_required', 403);
  if (typeof a.timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(a.timestamp)) return fail();
  try { parseInstant(a.timestamp); } catch { return fail(); }
  return a as unknown as FinancialAuthority;
}
export function captureUsFinancialPilotScope(value: unknown): UsFinancialPilotScope {
  const result = exact(capture(value), ['scope', 'optInVersion']);
  const scope = captureUsFinancialTestScopeV5(result.scope), optInVersion = revision(result.optInVersion);
  return Object.freeze({ scope, optInVersion });
}
function sameScope(bound: UsFinancialPilotScope, current: UsFinancialPilotScope): void {
  const a = bound.scope, b = current.scope;
  if (a.organizationId !== b.organizationId || a.actor.userId !== b.actor.userId || a.actor.role !== b.actor.role) return fail('financial_authority_changed', 403);
  if (a.grantVersion !== b.grantVersion || bound.optInVersion !== current.optInVersion) return fail('financial_test_grant_changed', 409);
  if (!same(a.policy, b.policy)) return fail('financial_policy_unavailable', 409);
}

/** Initial capture takes no expected versions. A later call pins both versions
 * and the private policy/identity. Its caller must bracket it with current
 * Auth/D1 checks; this RPC does not authenticate a web session itself. */
export async function readUsFinancialPilotScope(client: Client, suppliedActor: FinancialAuthority, expected?: UsFinancialPilotScope): Promise<UsFinancialPilotScope> {
  const a = actor(suppliedActor), bound = expected === undefined ? undefined : captureUsFinancialPilotScope(expected);
  if (bound && (a.organizationId !== bound.scope.organizationId || a.userId !== bound.scope.actor.userId || a.role !== bound.scope.actor.role)) return fail('financial_authority_changed', 403);
  let value: unknown;
  try {
    value = await client.rpc('zentra_us_financial_pilot_test_scope_v1', { p_organization: a.organizationId, p_actor: a, p_capability: capability,
      p_expected_grant_version: bound?.scope.grantVersion ?? null, p_expected_opt_in_version: bound?.optInVersion ?? null });
  } catch (error) { throw safeError(error); }
  const result = captureUsFinancialPilotScope(value);
  if (!same(result.scope.actor, a) || result.scope.organizationId !== a.organizationId) return fail();
  if (bound) sameScope(bound, result);
  return result;
}

/** Private marker probe only, after Auth/D1 admission. Any malformed response
 * or outage fails closed. Promoted-but-closed must never fall back to ERP4. */
export async function readUsFinancialPilotPromotionStatus(client: Pick<SupabaseServerClient, 'select'>, organizationId: string): Promise<boolean> {
  const org = organization(organizationId);
  let value: unknown;
  try { value = await client.select('zentra_us_financial_test_heads', { select: 'organization_id', organization_id: `eq.${org}`, limit: 1 }); }
  catch (error) { throw safeError(error); }
  const rows = capture(value);
  if (!Array.isArray(rows) || rows.length > 1) return fail();
  if (rows.length === 0) return false;
  if (exact(rows[0], ['organization_id']).organization_id !== org) return fail();
  return true;
}

/** A bounded head and the existing independently validated book engine, behind
 * atomic PG pilot wrappers. The engine's capability deliberately stays
 * invoicing TEST; neither this private factory nor DTO1 publishes ERP5. */
export function createSupabaseUsFinancialPilotStore(client: Client, initialScope: UsFinancialPilotScope, revalidate: (this: void) => Promise<UsFinancialPilotScope>): UsFinancialPilotStore {
  const bound = captureUsFinancialPilotScope(initialScope), rpc = client.rpc.bind(client);
  if (typeof revalidate !== 'function') return fail('financial_test_grant_required', 403);
  let observedAt = Date.parse(bound.scope.actor.timestamp);
  async function fresh(): Promise<UsFinancialPilotScope> {
    const current = captureUsFinancialPilotScope(await revalidate());
    sameScope(bound, current);
    if (Date.parse(current.scope.actor.timestamp) < observedAt) return fail('financial_clock_reversed', 409);
    observedAt = Date.parse(current.scope.actor.timestamp);
    return current;
  }
  const routes: Readonly<Record<string, string>> = {
    zentra_read_us_financial_invoicing_test_v5: 'zentra_read_us_financial_pilot_test_v1',
    zentra_us_financial_invoicing_test_receipt_v5: 'zentra_us_financial_pilot_test_receipt_v1',
    zentra_append_us_financial_invoicing_test_v5: 'zentra_append_us_financial_pilot_test_v1',
  };
  const engine = createSupabaseUsFinancialInvoicingTestStoreV5({ async rpc(name, args) {
    const route = routes[name];
    if (!route || args.p_organization !== bound.scope.organizationId || args.p_grant_version !== bound.scope.grantVersion || args.p_capability !== 'postgres-test-invoicing-v5') return fail();
    return rpc(route, { ...args, p_opt_in_version: bound.optInVersion, p_capability: capability });
  } }, bound.scope, async () => (await fresh()).scope);
  return Object.freeze({ ...engine, async head() {
    const current = await fresh();
    let outcome: { value: UsFinancialPilotHead } | { error: unknown };
    try {
      const value = exact(capture(await rpc('zentra_us_financial_pilot_test_head_v1', { p_organization: bound.scope.organizationId, p_actor: current.scope.actor,
        p_grant_version: bound.scope.grantVersion, p_opt_in_version: bound.optInVersion, p_capability: capability })), ['consumer', 'schemaVersion', 'organizationId', 'revision']);
      if (value.consumer !== 'financial-pilot' || value.schemaVersion !== 1 || value.organizationId !== bound.scope.organizationId) return fail();
      revision(value.revision);
      outcome = { value: value as unknown as UsFinancialPilotHead };
    } catch (error) { outcome = { error }; }
    await fresh();
    if ('error' in outcome) throw safeError(outcome.error);
    return outcome.value;
  } });
}
