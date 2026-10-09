import { usTaxMerchantHandlers } from '@/lib/international/runtime-bindings';
type Context = { params: Promise<{ organizationId: string }> };
export async function GET(request: Request, context: Context): Promise<Response> {
  return usTaxMerchantHandlers.GET(request, (await context.params).organizationId);
}
export async function POST(request: Request, context: Context): Promise<Response> {
  return usTaxMerchantHandlers.POST(request, (await context.params).organizationId);
}
