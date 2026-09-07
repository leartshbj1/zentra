import {
  accountJsonError,
  accountNoStoreHeaders,
  enforceAccountRateLimit,
  requireDeviceSession,
} from '@/lib/account';
import {
  AccountPublicError,
  roleCanWriteInvoices,
} from '@/lib/account-security';
import {
  numberReservationRequest,
  reserveDocumentNumbers,
} from '@/lib/document-number-reservations';
import { readJsonObjectWithinLimit } from '@/lib/request-body';

export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try {
    const session = await requireDeviceSession(request);
    if (!roleCanWriteInvoices(session.role))
      throw new AccountPublicError(
        'Votre accès est limité à la consultation.',
        403,
      );
    await enforceAccountRateLimit(
      request,
      'document-number-reservations',
      `${session.organizationId}:${session.installationId}`,
      240,
    );
    const input = numberReservationRequest(
      await readJsonObjectWithinLimit(request, 8192),
    );
    return Response.json(await reserveDocumentNumbers(session, input), {
      headers: accountNoStoreHeaders(),
    });
  } catch (error) {
    return accountJsonError(error);
  }
}
