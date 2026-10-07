import { erpHandlers } from '@/lib/international/runtime-bindings';
type Context={params:Promise<{organizationId:string}>};
export async function GET(request:Request,context:Context):Promise<Response>{return erpHandlers.GET(request,(await context.params).organizationId);}
export async function POST(request:Request,context:Context):Promise<Response>{return erpHandlers.POST(request,(await context.params).organizationId);}
