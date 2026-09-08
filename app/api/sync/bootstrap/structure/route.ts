import {
  accountJsonError,
  accountNoStoreHeaders,
  enforceAccountRateLimit,
  requireDeviceSession,
} from '@/lib/account';
import {
  structuralValidationStatus,
  validateBootstrapStructure,
} from '@/lib/business-sync-validation';
import { readJsonObjectWithinLimit } from '@/lib/request-body';

export const dynamic = 'force-dynamic';
async function sessionFor(request: Request) {
  const session = await requireDeviceSession(request);
  await enforceAccountRateLimit(
    request,
    'business-sync-structure',
    `${session.organizationId}:${session.installationId}`,
    120,
  );
  return session;
}
export async function GET(request: Request) {
  try {
    const session = await sessionFor(request);
    return Response.json(
      await structuralValidationStatus(
        session,
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
      await validateBootstrapStructure(session, input.transfer_id),
      { headers: accountNoStoreHeaders() },
    );
  } catch (error) {
    return accountJsonError(error);
  }
}
