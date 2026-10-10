import { canonicalErpJson, ErpError } from './erp-contract';
import { SupabaseServerError } from '../supabase-server';
import type { FinancialAuthority } from './accounting/ledger';
import { createSupabaseUsFinancialInvoiceTestStoreV5 } from './us-financial-invoice-test-store';
import { validateUsFinancialInvoiceContextV5, type UsFinancialInvoiceContextV5, type UsFinancialInvoiceTestStoreV5 } from './us-financial-invoice-test';
import { captureUsFinancialPilotScope, type UsFinancialPilotScope } from './us-financial-pilot-store';

export interface UsFinancialPilotInvoiceStore extends UsFinancialInvoiceTestStoreV5 {
  context(actor: FinancialAuthority): Promise<UsFinancialInvoiceContextV5>;
}

/** The existing durable fiscal operation, admitted under the same locked pilot
 * opt-in as its eventual financial append. No second preparation store. */
export function createSupabaseUsFinancialPilotInvoiceStore(
  client: Readonly<{ rpc(name: string, args: Readonly<Record<string, unknown>>): Promise<unknown> }>,
  initialScope: UsFinancialPilotScope,
  revalidate: () => Promise<UsFinancialPilotScope>,
  options: Readonly<{ allowTestFixtures?: boolean; sellerInstalled?: boolean }> = {},
): UsFinancialPilotInvoiceStore {
  const bound = captureUsFinancialPilotScope(initialScope), rpc = client.rpc.bind(client), allowFixtures = options.allowTestFixtures === true;
  const suffix = options.sellerInstalled === true ? 'seller_v1' : 'v1';
  const routes: Readonly<Record<string, string>> = Object.freeze({
    zentra_read_us_financial_invoice_test_operation_v5: `zentra_read_us_financial_pilot_invoice_test_operation_${suffix}`,
    zentra_preflight_us_financial_invoice_test_v5: `zentra_preflight_us_financial_pilot_invoice_test_${suffix}`,
    zentra_reserve_us_financial_invoice_test_v5: `zentra_reserve_us_financial_pilot_invoice_test_${suffix}`,
    zentra_record_us_financial_invoice_test_calculation_v5: `zentra_record_us_financial_pilot_invoice_test_calculation_${suffix}`,
  });
  if (typeof revalidate !== 'function') throw new ErpError('financial_test_grant_required', 403);
  let lastObservedAt = Date.parse(bound.scope.actor.timestamp);
  async function fresh(minimum = bound.scope.actor) {
    const current = captureUsFinancialPilotScope(await revalidate());
    if (current.scope.organizationId !== bound.scope.organizationId || current.scope.actor.userId !== bound.scope.actor.userId || current.scope.actor.role !== bound.scope.actor.role) throw new ErpError('financial_authority_changed', 403);
    if (current.optInVersion !== bound.optInVersion || current.scope.grantVersion !== bound.scope.grantVersion) throw new ErpError('financial_test_grant_changed', 409);
    if (canonicalErpJson(current.scope.policy) !== canonicalErpJson(bound.scope.policy)) throw new ErpError('financial_policy_unavailable', 409);
    const stamp = Date.parse(current.scope.actor.timestamp);
    if (stamp < lastObservedAt || stamp < Date.parse(minimum.timestamp)) throw new ErpError('financial_clock_reversed', 409);
    lastObservedAt = stamp;
    return current.scope;
  }
  const engine = createSupabaseUsFinancialInvoiceTestStoreV5({ async rpc(name, args) {
    const route = routes[name];
    if (!route || args.p_organization !== bound.scope.organizationId || args.p_grant_version !== bound.scope.grantVersion || args.p_capability !== 'postgres-test-invoicing-v5') throw new ErpError('invalid_financial_invoice_private_data', 503);
    return rpc(route, { ...args, p_opt_in_version: bound.optInVersion, p_capability: 'postgres-test-financial-pilot-dto1' });
  } }, bound.scope, fresh, options);
  return Object.freeze({ ...engine, async context(actor: FinancialAuthority) {
    const supplied = captureUsFinancialPilotScope({ ...bound, scope: { ...bound.scope, actor } }).scope.actor;
    if (supplied.organizationId !== bound.scope.organizationId || supplied.userId !== bound.scope.actor.userId || supplied.role !== bound.scope.actor.role) throw new ErpError('financial_authority_changed', 403);
    await fresh(supplied);
    let result: UsFinancialInvoiceContextV5 | undefined, failure: unknown, failed = false;
    try {
      result = await validateUsFinancialInvoiceContextV5(await rpc(`zentra_us_financial_pilot_invoice_test_context_${suffix}`, {
        p_organization: bound.scope.organizationId, p_actor: supplied, p_grant_version: bound.scope.grantVersion,
        p_opt_in_version: bound.optInVersion, p_capability: 'postgres-test-financial-pilot-dto1',
      }), bound.scope.organizationId, allowFixtures);
    } catch (error) { failure = error; failed = true; }
    await fresh(supplied);
    if (failed) {
      if (failure instanceof ErpError) throw failure;
      if (failure instanceof SupabaseServerError) {
        const errors: Record<string, readonly [string, number]> = { PF005: ['financial_test_grant_required', 403], PF006: ['financial_test_grant_changed', 409], PF007: ['financial_configuration_changed', 409], PF014: ['binding_unavailable', 409] };
        const known = errors[failure.code]; if (known) throw new ErpError(...known);
      }
      throw new ErpError('financial_service_unavailable', 503);
    }
    return result!;
  } });
}
