import { usFinancialPilotDependencies } from './us-financial-pilot-bindings';
import { createUsFinancialPilotCommercialHandlers, type UsFinancialPilotCommercialDependencies } from './us-financial-pilot-commercial-server';

/** Existing read-only Auth/D1, living versioned opt-in/grant and closed TEST
 * rollout. This adds no authority, provider, capability or native dispatcher. */
export const usFinancialPilotCommercialDependencies: UsFinancialPilotCommercialDependencies = {
  enabled: usFinancialPilotDependencies.enabled,
  authority: usFinancialPilotDependencies.authority,
  configuration: usFinancialPilotDependencies.configuration,
  scope: usFinancialPilotDependencies.scope,
  store: usFinancialPilotDependencies.store,
  rateLimit: usFinancialPilotDependencies.rateLimit,
  diagnostic(event) { console.warn('zentra.international.financial-pilot-commercial', event); },
};
export const usFinancialPilotCommercialHandlers = createUsFinancialPilotCommercialHandlers(usFinancialPilotCommercialDependencies);
