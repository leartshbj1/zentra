import { usFinancialPilotHandlers } from '@/lib/international/us-financial-pilot-bindings';
export async function GET(request:Request,context:{params:Promise<{organizationId:string;invoiceId:string}>}):Promise<Response>{const p=await context.params;return usFinancialPilotHandlers.INVOICE(request,p.organizationId,p.invoiceId);}
