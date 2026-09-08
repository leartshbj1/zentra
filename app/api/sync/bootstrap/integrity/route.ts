import {
  accountJsonError,
  accountNoStoreHeaders,
  enforceAccountRateLimit,
  requireDeviceSession,
} from '@/lib/account';
import {
  bootstrapIntegrityStatus,
  validateBootstrapIntegrity,
} from '@/lib/business-sync-integrity';
import { readJsonObjectWithinLimit } from '@/lib/request-body';

export const dynamic = 'force-dynamic';
async function sessionFor(request: Request) {
  const session = await requireDeviceSession(request);
  await enforceAccountRateLimit(
    request,
    'business-sync-integrity',
    `${session.organizationId}:${session.installationId}`,
    120,
  );
  return session;
}
export async function GET(request: Request) {
  try {
    return Response.json(
      await bootstrapIntegrityStatus(
        await sessionFor(request),
        new URL(request.url).searchParams.get('transfer_id'),
      ),
      { headers: accountNoStoreHeaders() },
    );
  } catch (error) {
    return accountJsonError(error);
  }
}
export async function POST(request: Request) {
  try {
    const session = await sessionFor(request);
    const input = await readJsonObjectWithinLimit(request, 1024);
    return Response.json(
      await validateBootstrapIntegrity(session, input.transfer_id),
      { headers: accountNoStoreHeaders() },
    );
  } catch (error) {
    return accountJsonError(error);
  }
}
