import { usFinancialPilotBankDependencies } from '@/lib/international/us-financial-pilot-bank-bindings';
import { createUsFinancialPilotBankExportHandler } from '@/lib/international/us-financial-pilot-bank-export';
const exportStatement = createUsFinancialPilotBankExportHandler(usFinancialPilotBankDependencies);
export async function GET(request: Request, context: { params: Promise<{ organizationId: string; statementId: string }> }): Promise<Response> {
  const params = await context.params;
  return exportStatement(request, params.organizationId, params.statementId);
}
