import { usFinancialPilotDependencies } from './us-financial-pilot-bindings';
import { createUsFinancialPilotBankHandlers, type UsFinancialPilotBankDependencies } from './us-financial-pilot-bank-server';
import { createSupabaseUsFinancialPilotBankStore } from './us-financial-pilot-bank-store';

/** Server installation marker, additional to every existing financial TEST
 * gate. No request or browser preference can install or enable this port. */
export async function usFinancialPilotBankEnabled(): Promise<boolean> {
  try {
    const { env } = await import('cloudflare:workers');
    if ((env as unknown as Record<string, unknown>).ZENTRA_US_FINANCIAL_BANK_TEST_INSTALLED !== 'true') return false;
    if (!await usFinancialPilotDependencies.enabled()) return false;
    return (env as unknown as Record<string, unknown>).ZENTRA_US_FINANCIAL_BANK_TEST_INSTALLED === 'true';
  } catch { return false; }
}

/** The bank register is a private sidecar to the existing financial book.
 * Authentication, effective membership, opt-in and grants stay unchanged. */
export const usFinancialPilotBankDependencies: UsFinancialPilotBankDependencies = {
  enabled: usFinancialPilotBankEnabled,
  authority: usFinancialPilotDependencies.authority,
  configuration: usFinancialPilotDependencies.configuration,
  scope: usFinancialPilotDependencies.scope,
  async store(scope, revalidate) {
    const { supabaseServerClient } = await import('../supabase-server-runtime');
    return createSupabaseUsFinancialPilotBankStore(supabaseServerClient(), scope, revalidate);
  },
  rateLimit: usFinancialPilotDependencies.rateLimit,
  diagnostic(event) { console.warn('zentra.international.financial-pilot-bank', event); },
};
export const usFinancialPilotBankHandlers = createUsFinancialPilotBankHandlers(usFinancialPilotBankDependencies);
