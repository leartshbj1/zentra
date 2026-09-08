import {
  accountJsonError,
  accountNoStoreHeaders,
  enforceAccountRateLimit,
  requireDeviceSession,
} from '@/lib/account';
import { AccountPublicError } from '@/lib/account-security';
import {
  beginBusinessTransaction,
  businessTransactionStatus,
  uploadBusinessTransactionChunk,
} from '@/lib/business-sync-transactions';
import { TRANSACTION_MANIFEST_BYTES } from '@/lib/business-sync-transaction-format';
import { readJsonObjectWithinLimit } from '@/lib/request-body';
export const dynamic = 'force-dynamic';
async function sessionFor(request: Request) {
  const session = await requireDeviceSession(request);
  await enforceAccountRateLimit(
    request,
    'business-sync-transactions',
    `${session.organizationId}:${session.installationId}`,
    240,
  );
  return session;
}
export async function POST(request: Request) {
  try {
    const session = await sessionFor(request);
    const body = await readJsonObjectWithinLimit(
      request,
      TRANSACTION_MANIFEST_BYTES * 2 + 1024,
    );
    if (Object.keys(body).join(',') !== 'manifest_json')
      throw new AccountPublicError('La demande de transaction est invalide.');
    return Response.json(
      await beginBusinessTransaction(session, body.manifest_json),
      { headers: accountNoStoreHeaders() },
    );
  } catch (error) {
    return accountJsonError(error);
  }
}
export async function GET(request: Request) {
  try {
    const session = await sessionFor(request);
    return Response.json(
      await businessTransactionStatus(
        session,
        new URL(request.url).searchParams.get('transaction_id'),
      ),
      { headers: accountNoStoreHeaders() },
    );
  } catch (error) {
    return accountJsonError(error);
  }
}
export async function PUT(request: Request) {
  try {
    const session = await sessionFor(request),
      query = new URL(request.url).searchParams,
      index = query.get('chunk');
    if (index === null || !/^(0|[1-9][0-9]{0,3})$/.test(index))
      throw new AccountPublicError('Numéro de fragment invalide.');
    return Response.json(
      await uploadBusinessTransactionChunk(
        session,
        query.get('transaction_id'),
        Number(index),
        request,
      ),
      { headers: accountNoStoreHeaders() },
    );
  } catch (error) {
    return accountJsonError(error);
  }
}
