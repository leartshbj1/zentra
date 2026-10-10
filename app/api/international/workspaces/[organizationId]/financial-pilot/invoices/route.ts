import { usFinancialPilotHandlers } from '@/lib/international/us-financial-pilot-bindings';
export async function GET(request:Request,context:{params:Promise<{organizationId:string}>}):Promise<Response>{return usFinancialPilotHandlers.INVOICES(request,(await context.params).organizationId);}
