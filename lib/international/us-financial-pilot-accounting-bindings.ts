import { usFinancialPilotDependencies } from './us-financial-pilot-bindings';
import { createUsFinancialPilotAccountingHandlers, type UsFinancialPilotAccountingDependencies } from './us-financial-pilot-accounting-server';

/** Existing read-only Auth/D1, living versioned opt-in/grant and closed TEST
 * rollout. This adds no authority, provider, capability or native dispatcher. */
export const usFinancialPilotAccountingDependencies: UsFinancialPilotAccountingDependencies = {
  enabled: usFinancialPilotDependencies.enabled,
  authority: usFinancialPilotDependencies.authority,
  configuration: usFinancialPilotDependencies.configuration,
  scope: usFinancialPilotDependencies.scope,
  store: usFinancialPilotDependencies.store,
  rateLimit: usFinancialPilotDependencies.rateLimit,
  diagnostic(event) { console.warn('zentra.international.financial-pilot-accounting', event); },
};
export const usFinancialPilotAccountingHandlers = createUsFinancialPilotAccountingHandlers(usFinancialPilotAccountingDependencies);
