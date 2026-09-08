import {
  accountJsonError,
  accountNoStoreHeaders,
  enforceAccountRateLimit,
  requireDeviceSession,
} from '@/lib/account';
import {
  businessTransactionValidationStatus,
  validateBusinessTransaction,
} from '@/lib/business-sync-transaction-validation';
export const dynamic = 'force-dynamic';
async function respond(request: Request, advance: boolean) {
  try {
    const session = await requireDeviceSession(request);
    await enforceAccountRateLimit(
      request,
      'business-transaction-validation',
      `${session.organizationId}:${session.installationId}`,
      240,
    );
    const id = new URL(request.url).searchParams.get('transaction_id');
    return Response.json(
      await (advance
        ? validateBusinessTransaction(session, id)
        : businessTransactionValidationStatus(session, id)),
      { headers: accountNoStoreHeaders() },
    );
  } catch (error) {
    return accountJsonError(error);
  }
}
export async function GET(request: Request) {
  return respond(request, false);
}
export async function POST(request: Request) {
  return respond(request, true);
}
