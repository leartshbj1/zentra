import { usFinancialPilotBankHandlers } from '@/lib/international/us-financial-pilot-bank-bindings';
export async function GET(request: Request, context: { params: Promise<{ organizationId: string }> }): Promise<Response> {
  const params = await context.params;
  return usFinancialPilotBankHandlers.CONTEXT(request, params.organizationId);
}
