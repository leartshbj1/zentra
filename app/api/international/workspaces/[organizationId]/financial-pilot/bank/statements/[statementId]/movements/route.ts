import { usFinancialPilotBankHandlers } from '@/lib/international/us-financial-pilot-bank-bindings';
export async function GET(request: Request, context: { params: Promise<{ organizationId: string; statementId: string }> }): Promise<Response> {
  const params = await context.params;
  return usFinancialPilotBankHandlers.MOVEMENTS(request, params.organizationId, params.statementId);
}
