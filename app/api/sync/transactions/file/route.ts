import {
  accountJsonError,
  accountNoStoreHeaders,
  enforceAccountRateLimit,
  requireDeviceSession,
} from '@/lib/account';
import { AccountPublicError } from '@/lib/account-security';
import {
  businessTransactionFileStatus,
  uploadBusinessTransactionFilePart,
  verifyBusinessTransactionFile,
} from '@/lib/business-sync-transaction-files';
export const dynamic = 'force-dynamic';
async function context(request: Request) {
  const session = await requireDeviceSession(request);
  await enforceAccountRateLimit(
    request,
    'business-sync-transaction-files',
    `${session.organizationId}:${session.installationId}`,
    240,
  );
  const q = new URL(request.url).searchParams;
  return {
    session,
    id: q.get('transaction_id'),
    sha: q.get('sha256'),
    part: q.get('part'),
  };
}
export async function GET(request: Request) {
  try {
    const { session, id, sha } = await context(request);
    return Response.json(
      await businessTransactionFileStatus(session, id, sha),
      { headers: accountNoStoreHeaders() },
    );
  } catch (error) {
    return accountJsonError(error);
  }
}
export async function PUT(request: Request) {
  try {
    const { session, id, sha, part } = await context(request);
    if (part === null || !/^(0|[1-9][0-9]{0,2})$/.test(part))
      throw new AccountPublicError('Numéro de fragment invalide.');
    return Response.json(
      await uploadBusinessTransactionFilePart(
        session,
        id,
        sha,
        Number(part),
        request,
      ),
      { headers: accountNoStoreHeaders() },
    );
  } catch (error) {
    return accountJsonError(error);
  }
}
export async function POST(request: Request) {
  try {
    const { session, id, sha } = await context(request);
    return Response.json(
      await verifyBusinessTransactionFile(session, id, sha),
      { headers: accountNoStoreHeaders() },
    );
  } catch (error) {
    return accountJsonError(error);
  }
}
