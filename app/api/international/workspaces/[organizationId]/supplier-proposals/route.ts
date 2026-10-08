import { usSupplierHandlers } from '@/lib/international/us-supplier-bindings';
type Context = { params: Promise<{ organizationId: string }> };
export async function GET(request: Request, context: Context): Promise<Response> { return usSupplierHandlers.GET(request, (await context.params).organizationId); }
export async function POST(request: Request, context: Context): Promise<Response> { return usSupplierHandlers.POST(request, (await context.params).organizationId); }
