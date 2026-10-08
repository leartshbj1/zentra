import { erpServerDependencies, usPurchasingSchemaVersion } from './runtime-bindings';
import { createUsSupplierHandlers } from './us-supplier-server';
import { createSupabaseUsSupplierStore } from './us-supplier-store';
import { requireUsWorkspaceAccess } from './saas-authority-d1';
import { UsAuthorityError } from './saas-authority';
import { ErpError } from './erp-contract';
import { prepareUsSupplierAnalysis } from './us-supplier-analysis-bindings';

async function enabled(): Promise<boolean> {
  if (!await erpServerDependencies.enabled()) return false;
  try {
    const { env } = await import('cloudflare:workers');
    return (env as unknown as { INTERNATIONAL_US_SUPPLIER_MAIL_ENABLED?: string }).INTERNATIONAL_US_SUPPLIER_MAIL_ENABLED === 'true';
  } catch { return false; }
}
/** Availability is informative. Fresh Auth, role, country and both module rights
 * are required for EVERY actual private operation. Never a browser grant. */
export async function usSupplierReadiness(): Promise<boolean> {
  return await enabled() && await usPurchasingSchemaVersion(4) === 4 && await enabled();
}
export const usSupplierHandlers = createUsSupplierHandlers({
  enabled,
  authority: (request, organizationId) => erpServerDependencies.authority(request, organizationId),
  configuration: actor => erpServerDependencies.configuration(actor),
  store: capability => erpServerDependencies.store(capability),
  freshSupportedSchemaVersion: usPurchasingSchemaVersion,
  async supplierStore(capability) {
    return createSupabaseUsSupplierStore((await import('../supabase-server-runtime')).supabaseServerClient(), { supportedSchemaVersion: await usPurchasingSchemaVersion(capability) });
  },
  async automationAccess(actor) {
    try {
      const access = await requireUsWorkspaceAccess(actor.organizationId, actor.userId, 'automation');
      if (access.organizationId !== actor.organizationId || access.userId !== actor.userId || access.role !== actor.role) throw new ErpError('supplier_permission_required', 403);
    } catch (error) {
      if (error instanceof UsAuthorityError) throw new ErpError(error.code === 'subscription_required' ? 'automation_entitlement_required' : error.status === 403 ? 'supplier_permission_required' : 'service_unavailable', error.status === 422 ? 503 : error.status);
      throw error;
    }
  },
  // The bound provider remains dormant without explicit US budget, company
  // consent and private first-dispatch reservation. Legacy CH grants cannot
  // authorize it; results are proposals, never financial approval.
  prepareAnalysis: prepareUsSupplierAnalysis,
  newId: () => crypto.randomUUID(),
  async rateLimit(request, actor, operation) {
    await (await import('../account')).enforceAccountRateLimit(request, `international-us-supplier-${operation}`, `${actor.organizationId}:${actor.userId}`, operation === 'read' ? 600 : 60);
  },
  diagnostic(event) { console.warn('zentra.international.us-supplier', event); },
});
