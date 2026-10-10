import { usFinancialPilotExportHandlers } from '@/lib/international/us-financial-pilot-export-bindings';
export async function GET(request:Request,context:{params:Promise<{organizationId:string;invoiceId:string}>}):Promise<Response>{const p=await context.params;return usFinancialPilotExportHandlers.INVOICE(request,p.organizationId,p.invoiceId);}
