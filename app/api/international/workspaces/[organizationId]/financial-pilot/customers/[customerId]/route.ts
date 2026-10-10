import { usFinancialPilotCommercialHandlers } from '@/lib/international/us-financial-pilot-commercial-bindings';
export async function GET(request: Request, context: { params: Promise<{ organizationId: string; customerId: string }> }): Promise<Response> {
  const { organizationId, customerId } = await context.params;
  return usFinancialPilotCommercialHandlers.CUSTOMER(request, organizationId, customerId);
}
