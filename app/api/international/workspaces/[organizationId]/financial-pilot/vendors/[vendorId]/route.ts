import { usFinancialPilotPurchasingHandlers } from '@/lib/international/us-financial-pilot-purchasing-bindings';
export async function GET(request: Request, context: { params: Promise<{ organizationId: string; vendorId: string }> }): Promise<Response> {
  const params = await context.params;
  return usFinancialPilotPurchasingHandlers.VENDOR(request, params.organizationId, params.vendorId);
}
