import { usFinancialPilotPurchasingHandlers } from '@/lib/international/us-financial-pilot-purchasing-bindings';
export async function GET(request: Request, context: { params: Promise<{ organizationId: string }> }): Promise<Response> {
  return usFinancialPilotPurchasingHandlers.BILLS(request, (await context.params).organizationId);
}
