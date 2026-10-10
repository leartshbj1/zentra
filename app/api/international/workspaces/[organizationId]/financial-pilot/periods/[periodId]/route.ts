import { usFinancialPilotAccountingHandlers } from '@/lib/international/us-financial-pilot-accounting-bindings';
export async function GET(request: Request, context: { params: Promise<{ organizationId: string; periodId: string }> }): Promise<Response> {
  const params = await context.params;
  return usFinancialPilotAccountingHandlers.PERIOD(request, params.organizationId, params.periodId);
}
