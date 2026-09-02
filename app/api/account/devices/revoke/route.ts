import { getZentraUser } from '@/app/zentra-auth';
import {
  accountJsonError,
  accountNoStoreHeaders,
  requireBrowserMembership,
} from '@/lib/account';
import {
  AccountPublicError,
  requireAccountSameOrigin,
  roleCanManageMembers,
} from '@/lib/account-security';
import { readJsonObjectWithinLimit } from '@/lib/request-body';
import { database } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    requireAccountSameOrigin(request);
    const user = await getZentraUser({ refreshSession: true });
    if (!user) throw new AccountPublicError('Connexion requise.', 401);
    const body = await readJsonObjectWithinLimit(request, 8_192);
    const organizationId =
      typeof body.organizationId === 'string' ? body.organizationId.trim() : '';
    const sessionId =
      typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    const actor = await requireBrowserMembership(user.userId, organizationId);
    const db = database();
    const target = await db
      .prepare(
        `SELECT session.user_id,session.installation_id,organization.subscription_id
           FROM device_sessions session
           JOIN organizations organization
             ON organization.organization_id=session.organization_id
          WHERE session.session_id=? AND session.organization_id=?
            AND session.revoked_at IS NULL LIMIT 1`,
      )
      .bind(sessionId, organizationId)
      .first<{
        user_id: string;
        installation_id: string;
        subscription_id: string;
      }>();
    if (!target) {
      throw new AccountPublicError('Cet appareil est introuvable.', 404);
    }
    if (target.user_id !== user.userId && !roleCanManageMembers(actor.role)) {
      throw new AccountPublicError(
        'Vous ne pouvez révoquer que vos propres appareils.',
        403,
      );
    }
    const now = Math.floor(Date.now() / 1_000);
    const [sessions] = await db.batch([
      db
        .prepare(
          `UPDATE device_sessions SET revoked_at=?
            WHERE organization_id=? AND installation_id=? AND revoked_at IS NULL`,
        )
        .bind(now, organizationId, target.installation_id),
      db
        .prepare(
          `UPDATE license_activations SET revoked_at=?
            WHERE subscription_id=? AND installation_id=? AND revoked_at IS NULL`,
        )
        .bind(now, target.subscription_id, target.installation_id),
    ]);
    return Response.json(
      {
        revoked: (sessions.meta.changes ?? 0) > 0,
        sessionId,
        installationId: target.installation_id,
      },
      { headers: accountNoStoreHeaders() },
    );
  } catch (error) {
    return accountJsonError(error);
  }
}
