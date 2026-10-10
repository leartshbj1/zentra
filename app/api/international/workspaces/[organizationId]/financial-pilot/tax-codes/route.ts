import { usFinancialPilotInvoiceHandlers } from '@/lib/international/us-financial-pilot-invoice-bindings';

export async function GET(request: Request, context: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await context.params;
  return usFinancialPilotInvoiceHandlers.CATALOGUE(request, organizationId);
}
