import { getUsExportFonts } from './export-fonts';
import { usFinancialPilotDependencies } from './us-financial-pilot-bindings';
import { createUsFinancialPilotExportHandlers, type UsFinancialPilotExportDependencies } from './us-financial-pilot-export-server';
import { readUsFinancialPilotQuoteIdentity, readUsFinancialPilotQuoteSeller } from './us-financial-pilot-quote-identity';
import { getWorkspaceCountry } from './workspace-service';

/** Same read-only Auth/D1 and private opt-in/grant admission as the pilot.
 * Current C/S are read only for quote exports. No new grant, flag, native
 * dispatcher, tax merchant or tax provider is consulted. */
export const usFinancialPilotExportDependencies:UsFinancialPilotExportDependencies={
  enabled:usFinancialPilotDependencies.enabled,
  authority:usFinancialPilotDependencies.authority,
  configuration:usFinancialPilotDependencies.configuration,
  scope:usFinancialPilotDependencies.scope,
  store:usFinancialPilotDependencies.store,
  rateLimit:usFinancialPilotDependencies.rateLimit,
  fonts:getUsExportFonts,
  quoteIdentity(actor,revalidate){
    const client=async()=>(await import('../supabase-server-runtime')).supabaseServerClient();
    return readUsFinancialPilotQuoteIdentity({country:async current=>getWorkspaceCountry(await client(),current),seller:async current=>readUsFinancialPilotQuoteSeller(await client(),current)},actor,revalidate);
  },
  diagnostic(event){console.warn('zentra.international.financial-pilot-export',event);},
};
export const usFinancialPilotExportHandlers=createUsFinancialPilotExportHandlers(usFinancialPilotExportDependencies);
