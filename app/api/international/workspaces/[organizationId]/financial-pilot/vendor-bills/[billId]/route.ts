import { usFinancialPilotPurchasingHandlers } from '@/lib/international/us-financial-pilot-purchasing-bindings';
export async function GET(request: Request, context: { params: Promise<{ organizationId: string; billId: string }> }): Promise<Response> {
  const params = await context.params;
  return usFinancialPilotPurchasingHandlers.BILL(request, params.organizationId, params.billId);
}
