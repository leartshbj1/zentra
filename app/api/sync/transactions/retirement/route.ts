import {
  accountJsonError,
  accountNoStoreHeaders,
  enforceAccountRateLimit,
  requireDeviceSession,
} from '@/lib/account';
import {
  businessRetirement,
  retireBusinessTransactions,
} from '@/lib/business-sync-retirement';
import { readJsonObjectWithinLimit } from '@/lib/request-body';
export const dynamic = 'force-dynamic';
async function sessionFor(request: Request) {
  const session = await requireDeviceSession(request);
  await enforceAccountRateLimit(
    request,
    'business-sync-retirement',
    `${session.organizationId}:${session.installationId}`,
    60,
  );
  return session;
}
export async function POST(request: Request) {
  try {
    const session = await sessionFor(request);
    return Response.json(
      await retireBusinessTransactions(
        session,
        await readJsonObjectWithinLimit(request, 4096),
      ),
      { headers: accountNoStoreHeaders() },
    );
  } catch (error) {
    return accountJsonError(error);
  }
}
export async function GET(request: Request) {
  try {
    return Response.json(
      await businessRetirement(
        await sessionFor(request),
        new URL(request.url).searchParams.get('resolution_id'),
      ),
      { headers: accountNoStoreHeaders() },
    );
  } catch (error) {
    return accountJsonError(error);
  }
}
