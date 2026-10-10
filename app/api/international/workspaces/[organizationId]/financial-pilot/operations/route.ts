import { usFinancialPilotHandlers } from '@/lib/international/us-financial-pilot-bindings';
export async function POST(request:Request,context:{params:Promise<{organizationId:string}>}):Promise<Response>{return usFinancialPilotHandlers.POST(request,(await context.params).organizationId);}
