import {
  accountJsonError,
  accountNoStoreHeaders,
  requireDeviceSession,
} from '@/lib/account';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const session = await requireDeviceSession(request);
    return Response.json(
      {
        organization: {
          id: session.organizationId,
          name: session.organizationName,
          role: session.role,
        },
        userId: session.userId,
        installationId: session.installationId,
        entitlementValidUntil: new Date(
          session.entitlementValidUntil * 1000,
        ).toISOString(),
      },
      { headers: accountNoStoreHeaders() },
    );
  } catch (error) {
    return accountJsonError(error);
  }
}
