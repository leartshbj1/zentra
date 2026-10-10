import { usFinancialPilotCommercialHandlers } from '@/lib/international/us-financial-pilot-commercial-bindings';
export async function GET(request: Request, context: { params: Promise<{ organizationId: string; estimateId: string }> }): Promise<Response> {
  const { organizationId, estimateId } = await context.params;
  return usFinancialPilotCommercialHandlers.ESTIMATE(request, organizationId, estimateId);
}
