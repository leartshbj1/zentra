import { usFinancialPilotPurchasingHandlers } from '@/lib/international/us-financial-pilot-purchasing-bindings';
export async function POST(request: Request, context: { params: Promise<{ organizationId: string }> }): Promise<Response> {
  return usFinancialPilotPurchasingHandlers.POST(request, (await context.params).organizationId);
}
