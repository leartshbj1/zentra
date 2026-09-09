import {
  accountJsonError,
  accountNoStoreHeaders,
  enforceAccountRateLimit,
  requireDeviceSession,
} from '@/lib/account';
import {
  commitBusinessTransaction,
  committedBusinessTransactionResource,
  committedBusinessTransactionsSince,
} from '@/lib/business-sync-transaction-commit';
export const dynamic = 'force-dynamic';
async function respond(request: Request, write: boolean) {
  try {
    const session = await requireDeviceSession(request);
    await enforceAccountRateLimit(
      request,
      'business-transaction-commit',
      `${session.organizationId}:${session.installationId}`,
      240,
    );
    const query = new URL(request.url).searchParams,
      id = query.get('transaction_id');
    if (write)
      return Response.json(
        {
          receipt: await commitBusinessTransaction(session, id),
          canonical_committed: true,
          replication_active: false,
        },
        { headers: accountNoStoreHeaders() },
      );
    if (!id)
      return Response.json(
        await committedBusinessTransactionsSince(
          session,
          query.get('generation'),
          query.get('after_revision'),
        ),
        { headers: accountNoStoreHeaders() },
      );
    const result = await committedBusinessTransactionResource(
      session,
      id,
      query.get('resource') ?? 'receipt',
      query.get('part'),
    );
    const headers = new Headers(accountNoStoreHeaders());
    headers.set('Content-Type', 'application/json');
    headers.set('X-Content-Sha256', result.sha256);
    headers.set('X-Zentra-Receipt-Sha256', result.receipt_sha256);
    headers.set('X-Zentra-Bundle-Sha256', result.bundle_sha256);
    return new Response(Uint8Array.from(result.bytes), { headers });
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
