import { erpServerDependencies, usPurchasingSchemaVersion } from './runtime-bindings';
import { createUsBankHandlers } from './us-bank-server';
import { createSupabaseUsBankStore } from './us-bank-store';

/** Separate, default-closed bank review. No bank credentials, transfers, tax
 * determination, Swiss snapshot changes or accounting writes are installed. */
async function bankEnabled(): Promise<boolean> {
  if (!await erpServerDependencies.enabled()) return false;
  try {
    const { env } = await import('cloudflare:workers');
    return (env as unknown as { INTERNATIONAL_US_BANK_RECONCILIATION_ENABLED?: string }).INTERNATIONAL_US_BANK_RECONCILIATION_ENABLED === 'true';
  } catch { return false; }
}
/** Informational only; every private operation repeats fresh admission. */
export async function usBankReadiness(): Promise<boolean> {
  return await bankEnabled() && await usPurchasingSchemaVersion(4) === 4 && await bankEnabled();
}
export const usBankHandlers = createUsBankHandlers({
  enabled: bankEnabled,
  authority: (request, organizationId) => erpServerDependencies.authority(request, organizationId),
  configuration: actor => erpServerDependencies.configuration(actor),
  store: capability => erpServerDependencies.store(capability),
  freshSupportedSchemaVersion: capability => usPurchasingSchemaVersion(capability),
  async bankStore(capability) {
    const supportedSchemaVersion = await usPurchasingSchemaVersion(capability);
    return createSupabaseUsBankStore((await import('../supabase-server-runtime')).supabaseServerClient(), { supportedSchemaVersion });
  },
  async rateLimit(request, actor, operation) {
    await (await import('../account')).enforceAccountRateLimit(request, `international-us-bank-${operation}`, `${actor.organizationId}:${actor.userId}`, operation === 'read' ? 600 : 120);
  },
  diagnostic(event) { console.warn('zentra.international.us-bank', event); },
});
