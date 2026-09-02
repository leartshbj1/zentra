import {
  accountJsonError,
  accountNoStoreHeaders,
  requireDeviceSession,
} from '@/lib/account';
import { database } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

export async function DELETE(request: Request) {
  try {
    const session = await requireDeviceSession(request);
    const now = Math.floor(Date.now() / 1_000);
    const db = database();
    const [result] = await db.batch([
      db
        .prepare(
          `UPDATE device_sessions SET revoked_at=?
            WHERE session_id=? AND revoked_at IS NULL`,
        )
        .bind(now, session.sessionId),
      db
        .prepare(
          `UPDATE license_activations SET revoked_at=?
            WHERE subscription_id=? AND installation_id=? AND revoked_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM device_sessions active_session
                 WHERE active_session.organization_id=?
                   AND active_session.installation_id=?
                   AND active_session.revoked_at IS NULL
                   AND active_session.expires_at>=?
              )`,
        )
        .bind(
          now,
          session.subscriptionId,
          session.installationId,
          session.organizationId,
          session.installationId,
          now,
        ),
    ]);
    return Response.json(
      { revoked: (result.meta.changes ?? 0) === 1 },
      { headers: accountNoStoreHeaders() },
    );
  } catch (error) {
    return accountJsonError(error);
  }
}
