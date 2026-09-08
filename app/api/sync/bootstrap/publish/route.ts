import {
  accountJsonError,
  accountNoStoreHeaders,
  enforceAccountRateLimit,
  requireDeviceSession,
} from '@/lib/account';
import { publishBootstrap } from '@/lib/business-sync-publication';
import { readJsonObjectWithinLimit } from '@/lib/request-body';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try {
    const session = await requireDeviceSession(request);
    await enforceAccountRateLimit(
      request,
      'business-sync-publication',
      `${session.organizationId}:${session.installationId}`,
      60,
    );
    const input = await readJsonObjectWithinLimit(request, 1024);
    return Response.json(await publishBootstrap(session, input.transfer_id), {
      headers: accountNoStoreHeaders(),
    });
  } catch (error) {
    return accountJsonError(error);
  }
}
