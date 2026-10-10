import { usFinancialPilotExportHandlers } from '@/lib/international/us-financial-pilot-export-bindings';
export async function GET(request:Request,context:{params:Promise<{organizationId:string;estimateId:string}>}):Promise<Response>{const p=await context.params;return usFinancialPilotExportHandlers.ESTIMATE(request,p.organizationId,p.estimateId);}
