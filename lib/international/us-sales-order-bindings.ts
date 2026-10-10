import { erpServerDependencies, usPurchasingSchemaVersion } from './runtime-bindings';
import { createUsSalesOrderHandlers } from './us-sales-order-server';
import { createSupabaseUsSalesOrderStore } from './us-sales-order-store';

async function switches():Promise<{history:boolean;create:boolean}>{
  if(!await erpServerDependencies.enabled())return{history:false,create:false};
  try{const{env}=await import('cloudflare:workers');const flags=env as unknown as{INTERNATIONAL_US_SALES_ORDERS_ENABLED?:string;INTERNATIONAL_US_SALES_ORDERS_HISTORY_ENABLED?:string};return{history:flags.INTERNATIONAL_US_SALES_ORDERS_HISTORY_ENABLED==='true',create:flags.INTERNATIONAL_US_SALES_ORDERS_ENABLED==='true'};}catch{return{history:false,create:false};}
}
async function enabled(){const flags=await switches();return flags.history||flags.create;}
async function newOrdersEnabled(){return(await switches()).create;}
/** History must remain enabled when new orders are paused: source protection
 * continues in PostgreSQL until explicit cancellation or an actual invoice. */
export async function usSalesOrderReadiness(){
  const flags=await switches();if(!(flags.history||flags.create)||await usPurchasingSchemaVersion(4)!==4)return{available:false,newOrdersEnabled:false};
  const current=await switches();return{available:current.history||current.create,newOrdersEnabled:current.create};
}
export const usSalesOrderHandlers=createUsSalesOrderHandlers({
  enabled,newOrdersEnabled,
  authority:(request,organizationId)=>erpServerDependencies.authority(request,organizationId),
  configuration:actor=>erpServerDependencies.configuration(actor),
  store:capability=>erpServerDependencies.store(capability),
  freshSupportedSchemaVersion:capability=>usPurchasingSchemaVersion(capability),
  async salesOrderStore(capability){return createSupabaseUsSalesOrderStore((await import('../supabase-server-runtime')).supabaseServerClient(),{supportedSchemaVersion:await usPurchasingSchemaVersion(capability)});},
  fonts:async()=>(await import('./export-fonts')).getUsExportFonts(),
  async rateLimit(request,actor,operation){await(await import('../account')).enforceAccountRateLimit(request,`international-us-sales-orders-${operation}`,`${actor.organizationId}:${actor.userId}`,operation==='read'?3600:120);},
  diagnostic(event){console.warn('zentra.international.us-sales-orders',event);},
});
