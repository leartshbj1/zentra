import { usFinancialPilotHandlers } from '@/lib/international/us-financial-pilot-bindings';
export async function GET(request:Request,context:{params:Promise<{organizationId:string;kind:string}>}):Promise<Response>{const p=await context.params;return usFinancialPilotHandlers.LIST(request,p.organizationId,p.kind);}
