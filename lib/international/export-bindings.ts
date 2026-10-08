import { erpServerDependencies, usPurchasingSchemaVersion } from './runtime-bindings';
import { createUsExportHandlers } from './export-server';
import type { ErpSchemaVersion } from './erp-schema-capability';

/** Read-only readiness. This neither admits a workspace nor grants a role;
 * each export independently rechecks the actual ERP authority and flags. */
export async function usExportReadiness(): Promise<Readonly<{ enabled: boolean; supportedSchemaVersion: ErpSchemaVersion }>> {
  if (!await erpServerDependencies.enabled()) return { enabled: false, supportedSchemaVersion: 1 };
  const supportedSchemaVersion = await usPurchasingSchemaVersion(3);
  return { enabled: await erpServerDependencies.enabled(), supportedSchemaVersion };
}
export const usExportHandlers = createUsExportHandlers({
  enabled: () => erpServerDependencies.enabled(),
  authority: (request, organizationId) => erpServerDependencies.authority(request, organizationId),
  configuration: actor => erpServerDependencies.configuration(actor),
  store: capability => erpServerDependencies.store(capability),
  freshSupportedSchemaVersion: capability => usPurchasingSchemaVersion(capability),
  seller: async actor => erpServerDependencies.seller ? erpServerDependencies.seller(actor) : null,
  rateLimit: (request, actor, operation) => erpServerDependencies.rateLimit(request, actor, operation),
  fonts: async () => (await import('./export-fonts')).getUsExportFonts(),
  diagnostic: event => { console.warn('zentra.international.export', event); },
});
