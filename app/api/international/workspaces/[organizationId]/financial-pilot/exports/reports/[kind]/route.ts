import { usFinancialPilotExportHandlers } from '@/lib/international/us-financial-pilot-export-bindings';
export async function GET(request:Request,context:{params:Promise<{organizationId:string;kind:string}>}):Promise<Response>{const p=await context.params;return usFinancialPilotExportHandlers.REPORT(request,p.organizationId,p.kind);}
