import { usFinancialPilotDependencies } from './us-financial-pilot-bindings';
import { createUsFinancialPilotSellerHandlers, type UsFinancialPilotSellerServerDependencies } from './us-financial-pilot-seller-server';
import { createSupabaseUsFinancialPilotSellerStore } from './us-financial-pilot-seller-store';

/** Installation is retained during a write pause: readers and exact receipt
 * recovery must never silently return to the frozen legacy seller. */
export async function usFinancialPilotSellerInstalled(): Promise<boolean> {
  try {
    const { env } = await import('cloudflare:workers');
    return (env as unknown as Record<string, unknown>).ZENTRA_US_FINANCIAL_SELLER_TEST_INSTALLED === 'true';
  } catch { return false; }
}
export async function usFinancialPilotSellerEnabled(): Promise<boolean> {
  return await usFinancialPilotSellerInstalled() && await usFinancialPilotDependencies.enabled() && await usFinancialPilotSellerInstalled();
}
export async function usFinancialPilotSellerWriteEnabled(): Promise<boolean> {
  try {
    const { env } = await import('cloudflare:workers');
    if ((env as unknown as Record<string, unknown>).ZENTRA_US_FINANCIAL_SELLER_TEST_ENABLED !== 'true') return false;
    return await usFinancialPilotSellerEnabled() && (env as unknown as Record<string, unknown>).ZENTRA_US_FINANCIAL_SELLER_TEST_ENABLED === 'true';
  } catch { return false; }
}
export const usFinancialPilotSellerDependencies: UsFinancialPilotSellerServerDependencies = {
  enabled: usFinancialPilotSellerEnabled, writeEnabled: usFinancialPilotSellerWriteEnabled,
  authority: usFinancialPilotDependencies.authority, configuration: usFinancialPilotDependencies.configuration,
  scope: usFinancialPilotDependencies.scope,
  async store(scope, revalidate) {
    const { supabaseServerClient } = await import('../supabase-server-runtime');
    return createSupabaseUsFinancialPilotSellerStore(supabaseServerClient(), scope, revalidate);
  },
  rateLimit: usFinancialPilotDependencies.rateLimit,
  diagnostic(event) { console.warn('zentra.international.financial-pilot-seller', event); },
};
export const usFinancialPilotSellerHandlers = createUsFinancialPilotSellerHandlers(usFinancialPilotSellerDependencies);
