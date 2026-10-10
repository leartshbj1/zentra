import { usFinancialPilotDependencies } from './us-financial-pilot-bindings';
import { createUsFinancialPilotInvoiceHandlers, type UsFinancialPilotInvoiceDependencies } from './us-financial-pilot-invoice-server';
import { createSupabaseUsFinancialPilotInvoiceStore } from './us-financial-pilot-invoice-store';
import { resolveUsTaxTestMerchant } from './us-tax-merchant-resolver';

/** Lazy dedicated TEST merchant only. Exact historical receipts remain readable
 * when this private merchant capability is closed or its observation expires. */
export async function usFinancialPilotInvoiceMerchant(organizationId: string) {
  if (!await usFinancialPilotDependencies.enabled()) return null;
  try {
    const { env } = await import('cloudflare:workers');
    const flags = env as unknown as { INTERNATIONAL_US_TAX_TEST_MERCHANT_ENABLED?: string; INTERNATIONAL_US_TAX_TEST_INVOICE_ENABLED?: string;
      INTERNATIONAL_US_TAX_TEST_MERCHANTS_JSON?: string; INTERNATIONAL_US_TAX_TEST_CREDENTIALS_JSON?: string; STRIPE_SECRET_KEY?: string };
    if (flags.INTERNATIONAL_US_TAX_TEST_MERCHANT_ENABLED !== 'true' || flags.INTERNATIONAL_US_TAX_TEST_INVOICE_ENABLED !== 'true') return null;
    return resolveUsTaxTestMerchant({ organizationId, configurationJson: flags.INTERNATIONAL_US_TAX_TEST_MERCHANTS_JSON ?? '',
      credentialsJson: flags.INTERNATIONAL_US_TAX_TEST_CREDENTIALS_JSON ?? '', forbiddenSaasKeys: [flags.STRIPE_SECRET_KEY ?? '', process.env.STRIPE_SECRET_KEY ?? ''], now: () => new Date().toISOString() });
  } catch { return null; }
}
export const usFinancialPilotInvoiceDependencies: UsFinancialPilotInvoiceDependencies = {
  enabled: usFinancialPilotDependencies.enabled, authority: usFinancialPilotDependencies.authority,
  configuration: usFinancialPilotDependencies.configuration, scope: usFinancialPilotDependencies.scope, store: usFinancialPilotDependencies.store,
  async invoiceStore(scope, revalidate) { return createSupabaseUsFinancialPilotInvoiceStore((await import('../supabase-server-runtime')).supabaseServerClient(), scope, revalidate); },
  merchant: usFinancialPilotInvoiceMerchant, operationId: () => crypto.randomUUID(), now: () => new Date().toISOString(),
  async rateLimit(request, actor, operation) { await (await import('../account')).enforceAccountRateLimit(request, `international-financial-pilot-invoice-${operation}`, `${actor.organizationId}:${actor.userId}`, operation === 'read' ? 120 : 24); },
  diagnostic(event) { console.warn('zentra.international.financial-pilot-invoice', event); },
};
export const usFinancialPilotInvoiceHandlers = createUsFinancialPilotInvoiceHandlers(usFinancialPilotInvoiceDependencies);
