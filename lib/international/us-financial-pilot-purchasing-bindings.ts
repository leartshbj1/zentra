import { usFinancialPilotDependencies } from './us-financial-pilot-bindings';
import { createUsFinancialPilotPurchasingHandlers, type UsFinancialPilotPurchasingDependencies } from './us-financial-pilot-purchasing-server';

/** Existing read-only Auth/D1, living versioned opt-in/grant and closed TEST
 * rollout. This adds no authority, provider, capability or native dispatcher. */
export const usFinancialPilotPurchasingDependencies: UsFinancialPilotPurchasingDependencies = {
  enabled: usFinancialPilotDependencies.enabled,
  authority: usFinancialPilotDependencies.authority,
  configuration: usFinancialPilotDependencies.configuration,
  scope: usFinancialPilotDependencies.scope,
  store: usFinancialPilotDependencies.store,
  rateLimit: usFinancialPilotDependencies.rateLimit,
  diagnostic(event) { console.warn('zentra.international.financial-pilot-purchasing', event); },
};
export const usFinancialPilotPurchasingHandlers = createUsFinancialPilotPurchasingHandlers(usFinancialPilotPurchasingDependencies);
