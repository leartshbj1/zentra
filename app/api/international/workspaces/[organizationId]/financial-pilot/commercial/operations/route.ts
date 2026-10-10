import { usFinancialPilotCommercialHandlers } from '@/lib/international/us-financial-pilot-commercial-bindings';
export async function POST(request: Request, context: { params: Promise<{ organizationId: string }> }): Promise<Response> {
  return usFinancialPilotCommercialHandlers.POST(request, (await context.params).organizationId);
}
