import {
  accountJsonError,
  accountNoStoreHeaders,
  requireDeviceSession,
} from '@/lib/account';
import { database } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const session = await requireDeviceSession(request);
    const member = await database().prepare('SELECT email FROM organization_members WHERE organization_id=? AND user_id=? AND revoked_at IS NULL').bind(session.organizationId,session.userId).first<{email:string}>();
    return Response.json(
      {
        organization: {
          id: session.organizationId,
          name: session.organizationName,
          role: session.role,
        },
        userId: session.userId,
        email: member?.email ?? '',
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
