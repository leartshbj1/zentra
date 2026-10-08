import {
  accountJsonError,
  accountNoStoreHeaders,
  enforceAccountRateLimit,
  requireDeviceSession,
} from '@/lib/account';
import { publishBootstrap } from '@/lib/business-sync-publication';
import { readJsonObjectWithinLimit } from '@/lib/request-body';
import { requireLegacyCountryTransport } from '@/lib/international/legacy-country-guard';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try {
    const session = await requireDeviceSession(request);
    await requireLegacyCountryTransport(session.organizationId);
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
