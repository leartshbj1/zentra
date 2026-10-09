import { usTaxInvoicePreparationHandlers } from '@/lib/international/runtime-bindings';

type Context = { params: Promise<{ organizationId: string }> };
export async function GET(request: Request, context: Context): Promise<Response> {
  return usTaxInvoicePreparationHandlers.CATALOGUE_GET(request, (await context.params).organizationId);
}
