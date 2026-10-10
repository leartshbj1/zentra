import { usFinancialPilotAccountingHandlers } from '@/lib/international/us-financial-pilot-accounting-bindings';
export async function POST(request: Request, context: { params: Promise<{ organizationId: string }> }): Promise<Response> {
  const params = await context.params;
  return usFinancialPilotAccountingHandlers.POST(request, params.organizationId);
}
