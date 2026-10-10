import { erpServerDependencies, usPurchasingSchemaVersion } from './runtime-bindings';
import { createUsSupplierDocumentHandlers } from './us-supplier-document-server';
import { createSupabaseUsSupplierDocumentStore } from './us-supplier-document-store';
import { requireUsWorkspaceAccess } from './saas-authority-d1';
import { UsAuthorityError } from './saas-authority';
import { ErpError } from './erp-contract';
import { prepareUsSupplierAnalysis } from './us-supplier-analysis-bindings';

async function enabled(): Promise<boolean> {
  if (!await erpServerDependencies.enabled()) return false;
  try {
    const { env } = await import('cloudflare:workers');
    return (env as unknown as { INTERNATIONAL_US_SUPPLIER_DOCUMENTS_ENABLED?: string }).INTERNATIONAL_US_SUPPLIER_DOCUMENTS_ENABLED === 'true';
  } catch { return false; }
}
/** Availability is never an authority. Import/read requires fresh US Gestion;
 * analysis separately demands US Automation and its consent/budget policy. */
export async function usSupplierDocumentsReadiness(): Promise<boolean> {
  return await enabled() && await usPurchasingSchemaVersion(4) === 4 && await enabled();
}
export const usSupplierDocumentHandlers = createUsSupplierDocumentHandlers({
  enabled,
  authority: (request, organizationId) => erpServerDependencies.authority(request, organizationId),
  configuration: actor => erpServerDependencies.configuration(actor),
  store: capability => erpServerDependencies.store(capability),
  freshSupportedSchemaVersion: usPurchasingSchemaVersion,
  async documentStore(capability) {
    return createSupabaseUsSupplierDocumentStore((await import('../supabase-server-runtime')).supabaseServerClient(), { supportedSchemaVersion: await usPurchasingSchemaVersion(capability) });
  },
  async archive() { return (await import('../runtime')).fileArchive(); },
  async automationAccess(actor) {
    try {
      const access = await requireUsWorkspaceAccess(actor.organizationId, actor.userId, 'automation');
      if (access.organizationId !== actor.organizationId || access.userId !== actor.userId || access.role !== actor.role) throw new ErpError('supplier_permission_required', 403);
    } catch (error) {
      if (error instanceof UsAuthorityError) throw new ErpError(error.code === 'subscription_required' ? 'automation_entitlement_required' : error.status === 403 ? 'supplier_permission_required' : 'service_unavailable', error.status === 422 ? 503 : error.status);
      throw error;
    }
  },
  prepareAnalysis: prepareUsSupplierAnalysis,
  async rateLimit(request, actor, operation) {
    await (await import('../account')).enforceAccountRateLimit(request, `international-us-supplier-documents-${operation}`, `${actor.organizationId}:${actor.userId}`, operation === 'read' ? 600 : 60);
  },
  diagnostic(event) { console.warn('zentra.international.us-supplier-documents', event); },
});
