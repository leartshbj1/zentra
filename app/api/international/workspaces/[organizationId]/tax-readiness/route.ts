import { usTaxReadinessHandlers } from '@/lib/international/runtime-bindings';
type Context = { params: Promise<{ organizationId: string }> };
export async function GET(request: Request, context: Context): Promise<Response> {
  return usTaxReadinessHandlers.GET(request, (await context.params).organizationId);
}
