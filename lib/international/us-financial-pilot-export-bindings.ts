import { getUsExportFonts } from './export-fonts';
import { usFinancialPilotDependencies } from './us-financial-pilot-bindings';
import { createUsFinancialPilotExportHandlers, type UsFinancialPilotExportDependencies } from './us-financial-pilot-export-server';

/** Same read-only Auth/D1 and private opt-in/grant admission as the pilot.
 * No new grant, flag, seller reader, native dispatcher or tax provider. */
export const usFinancialPilotExportDependencies:UsFinancialPilotExportDependencies={
  enabled:usFinancialPilotDependencies.enabled,
  authority:usFinancialPilotDependencies.authority,
  configuration:usFinancialPilotDependencies.configuration,
  scope:usFinancialPilotDependencies.scope,
  store:usFinancialPilotDependencies.store,
  rateLimit:usFinancialPilotDependencies.rateLimit,
  fonts:getUsExportFonts,
  diagnostic(event){console.warn('zentra.international.financial-pilot-export',event);},
};
export const usFinancialPilotExportHandlers=createUsFinancialPilotExportHandlers(usFinancialPilotExportDependencies);
