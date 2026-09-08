import {
  accountJsonError,
  accountNoStoreHeaders,
  enforceAccountRateLimit,
  requireDeviceSession,
} from '@/lib/account';
import { AccountPublicError } from '@/lib/account-security';
import { readJsonObjectWithinLimit } from '@/lib/request-body';
import {
  beginBusinessTransactionReview,
  businessTransactionReviewStatus,
  reviewBusinessTransaction,
} from '@/lib/business-sync-transaction-review';
export const dynamic = 'force-dynamic';
async function context(request: Request) {
  const session = await requireDeviceSession(request);
  await enforceAccountRateLimit(
    request,
    'business-transaction-review',
    `${session.organizationId}:${session.installationId}`,
    240,
  );
  return {
    session,
    id: new URL(request.url).searchParams.get('transaction_id'),
  };
}
export async function GET(request: Request) {
  try {
    const { session, id } = await context(request);
    return Response.json(await businessTransactionReviewStatus(session, id), {
      headers: accountNoStoreHeaders(),
    });
  } catch (error) {
    return accountJsonError(error);
  }
}
export async function POST(request: Request) {
  try {
    const { session, id } = await context(request),
      body = await readJsonObjectWithinLimit(request, 4096);
    if (
      Object.keys(body).join(',') !== 'action' ||
      !['prepare', 'advance'].includes(body.action as string)
    )
      throw new AccountPublicError('La demande de contrôle est invalide.');
    return Response.json(
      await (body.action === 'prepare'
        ? beginBusinessTransactionReview(session, id)
        : reviewBusinessTransaction(session, id)),
      { headers: accountNoStoreHeaders() },
    );
  } catch (error) {
    return accountJsonError(error);
  }
}
