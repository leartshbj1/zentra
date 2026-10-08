import { usTaxProfileHandlers } from '@/lib/international/runtime-bindings';
type Context = { params: Promise<{ organizationId: string }> };
export async function GET(request: Request, context: Context): Promise<Response> {
  return usTaxProfileHandlers.GET(request, (await context.params).organizationId);
}
export async function PUT(request: Request, context: Context): Promise<Response> {
  return usTaxProfileHandlers.PUT(request, (await context.params).organizationId);
}
