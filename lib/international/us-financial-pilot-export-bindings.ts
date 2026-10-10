import { getUsExportFonts } from './export-fonts';
import { ErpError } from './erp-contract';
import { validateUsSellerProfileState } from './seller-profile';
import { usFinancialPilotDependencies } from './us-financial-pilot-bindings';
import { createUsFinancialPilotExportHandlers, type UsFinancialPilotExportDependencies } from './us-financial-pilot-export-server';
import { readUsFinancialPilotQuoteIdentity, readUsFinancialPilotQuoteSeller, UsFinancialPilotQuoteIdentityError } from './us-financial-pilot-quote-identity';
import { getWorkspaceCountry } from './workspace-service';
import { usFinancialPilotSellerEnabled, usFinancialPilotSellerInstalled } from './us-financial-pilot-seller-bindings';
import { createSupabaseUsFinancialPilotSellerStore } from './us-financial-pilot-seller-store';
import { captureUsFinancialPilotScope } from './us-financial-pilot-store';

/** Same read-only Auth/D1 and private opt-in/grant admission as the pilot.
 * Current C/S are read only for quote exports. Seller installation selects
 * its compatible point reader; no grant, native dispatcher or tax provider
 * is provisioned, and pausing new seller writes retains that reader. */
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
    return readUsFinancialPilotQuoteIdentity({country:async current=>getWorkspaceCountry(await client(),current),seller:async current=>{
      if(!await usFinancialPilotSellerInstalled())return readUsFinancialPilotQuoteSeller(await client(),current);
      // Once installed, a paused/failed V5 reader is closed. It never silently
      // substitutes the original frozen profile after a presentation change.
      if(!await usFinancialPilotSellerEnabled())throw new ErpError('feature_unavailable',404);
      const initial=captureUsFinancialPilotScope(await usFinancialPilotDependencies.scope(current));
      const fresh=async()=>{
        const admitted=await revalidate();
        if(!await usFinancialPilotSellerEnabled())throw new ErpError('feature_unavailable',404);
        const scope=captureUsFinancialPilotScope(await usFinancialPilotDependencies.scope(admitted,initial));
        await revalidate();return scope;
      };
      try{
        const read=await createSupabaseUsFinancialPilotSellerStore(await client(),initial,fresh).read(),presentation=read.presentation;
        return validateUsSellerProfileState({status:'configured',organizationId:current.organizationId,revision:presentation.sellerRevision,profile:presentation.profile,updatedBy:presentation.updatedBy,updatedAt:presentation.updatedAt},current.organizationId);
      }catch(error){
        if(error instanceof ErpError&&error.code==='financial_pilot_seller_required'&&error.status===409)throw new UsFinancialPilotQuoteIdentityError('financial_pilot_seller_required',409);
        throw error;
      }
    }},actor,revalidate);
  },
  diagnostic(event){console.warn('zentra.international.financial-pilot-export',event);},
};
export const usFinancialPilotExportHandlers=createUsFinancialPilotExportHandlers(usFinancialPilotExportDependencies);
