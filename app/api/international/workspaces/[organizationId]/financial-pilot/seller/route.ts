import { usFinancialPilotSellerHandlers } from '@/lib/international/us-financial-pilot-seller-bindings';
export async function GET(request: Request, context: { params: Promise<{ organizationId: string }> }): Promise<Response> {
  const params = await context.params;
  return usFinancialPilotSellerHandlers.GET(request, params.organizationId);
}
export async function POST(request: Request, context: { params: Promise<{ organizationId: string }> }): Promise<Response> {
  const params = await context.params;
  return usFinancialPilotSellerHandlers.POST(request, params.organizationId);
}
