import { usSellerProfileHandlers } from '@/lib/international/runtime-bindings';
type Context = { params: Promise<{ organizationId: string }> };
export async function GET(request: Request, context: Context): Promise<Response> {
  return usSellerProfileHandlers.GET(request, (await context.params).organizationId);
}
export async function PUT(request: Request, context: Context): Promise<Response> {
  return usSellerProfileHandlers.PUT(request, (await context.params).organizationId);
}
