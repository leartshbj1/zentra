import { usTaxInvoicePreparationHandlers } from '@/lib/international/runtime-bindings';

type Context = { params: Promise<{ organizationId: string }> };
export async function POST(request: Request, context: Context): Promise<Response> {
  return usTaxInvoicePreparationHandlers.POST(request, (await context.params).organizationId);
}
