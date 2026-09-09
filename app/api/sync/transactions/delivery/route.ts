import {
  accountJsonError,
  accountNoStoreHeaders,
  enforceAccountRateLimit,
  requireDeviceSession,
} from '@/lib/account';
import {
  businessTransactionDeliveryResource,
  businessTransactionDeliveryStatus,
  prepareBusinessTransactionDelivery,
} from '@/lib/business-sync-transaction-delivery';
export const dynamic = 'force-dynamic';
async function respond(request: Request, advance: boolean) {
  try {
    const session = await requireDeviceSession(request);
    await enforceAccountRateLimit(
      request,
      'business-transaction-delivery',
      `${session.organizationId}:${session.installationId}`,
      240,
    );
    const query = new URL(request.url).searchParams,
      id = query.get('transaction_id'),
      resource = query.get('resource');
    if (!advance && resource) {
      const result = await businessTransactionDeliveryResource(
        session,
        id,
        resource,
        query.get('part'),
      );
      const headers = new Headers(accountNoStoreHeaders());
      headers.set('Content-Type', 'application/json');
      headers.set('X-Content-Sha256', result.sha256);
      headers.set('X-Zentra-Bundle-Sha256', result.bundle_sha256);
      return new Response(Uint8Array.from(result.bytes), { headers });
    }
    return Response.json(
      await (advance
        ? prepareBusinessTransactionDelivery(session, id)
        : businessTransactionDeliveryStatus(session, id)),
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
