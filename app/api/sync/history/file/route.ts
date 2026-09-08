import {
  accountJsonError,
  accountNoStoreHeaders,
  enforceAccountRateLimit,
  requireDeviceSession,
} from '@/lib/account';
import { AccountPublicError } from '@/lib/account-security';
import { historyFilePart } from '@/lib/business-sync-history';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const session = await requireDeviceSession(request);
    await enforceAccountRateLimit(
      request,
      'business-sync-history-files',
      `${session.organizationId}:${session.installationId}`,
      1800,
    );
    const q = new URL(request.url).searchParams;
    if (!q.get('transfer_id'))
      throw new AccountPublicError('Choisissez la révision du document.');
    const result = await historyFilePart(
      session,
      q.get('transfer_id'),
      q.get('sha256'),
      q.get('part'),
    );
    const headers = new Headers(accountNoStoreHeaders());
    headers.set('content-type', 'application/octet-stream');
    headers.set('x-content-sha256', result.sha256);
    headers.set('x-content-type-options', 'nosniff');
    return new Response(result.bytes, { headers });
  } catch (error) {
    return accountJsonError(error);
  }
}
