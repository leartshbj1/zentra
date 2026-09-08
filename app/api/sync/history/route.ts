import {
  accountJsonError,
  accountNoStoreHeaders,
  enforceAccountRateLimit,
  requireDeviceSession,
} from '@/lib/account';
import { AccountPublicError } from '@/lib/account-security';
import {
  historyHead,
  historyChunk,
  historyFilePage,
} from '@/lib/business-sync-history';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const session = await requireDeviceSession(request);
    await enforceAccountRateLimit(
      request,
      'business-sync-history',
      `${session.organizationId}:${session.installationId}`,
      1800,
    );
    const q = new URL(request.url).searchParams,
      kind = q.get('kind') ?? 'head';
    if (kind !== 'head' && !q.get('transfer_id'))
      throw new AccountPublicError(
        'Choisissez la révision d’historique à lire.',
      );
    if (kind === 'head')
      return Response.json(await historyHead(session), {
        headers: accountNoStoreHeaders(),
      });
    const result =
      kind === 'rows'
        ? await historyChunk(session, q.get('transfer_id'), q.get('index'))
        : kind === 'files'
          ? await historyFilePage(session, q.get('transfer_id'), q.get('index'))
          : null;
    if (!result) throw new AccountPublicError('Lecture d’historique inconnue.');
    const headers = new Headers(accountNoStoreHeaders());
    headers.set('content-type', 'application/json');
    headers.set('x-content-sha256', result.sha256);
    headers.set('x-content-type-options', 'nosniff');
    return new Response(result.bytes, { headers });
  } catch (error) {
    return accountJsonError(error);
  }
}
