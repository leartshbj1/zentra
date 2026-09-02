import { getZentraUser } from '@/app/zentra-auth';
import {
  accountJsonError,
  accountNoStoreHeaders,
  requireBrowserMembership,
} from '@/lib/account';
import {
  AccountPublicError,
  isAccountRole,
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
    const membershipId =
      typeof body.membershipId === 'string' ? body.membershipId.trim() : '';
    const actor = await requireBrowserMembership(user.userId, organizationId);
    if (!roleCanManageMembers(actor.role)) {
      throw new AccountPublicError(
        'Votre rôle ne permet pas de retirer un membre.',
        403,
      );
    }
    const db = database();
    const target = await db
      .prepare(
        `SELECT user_id,role FROM organization_members
          WHERE membership_id=? AND organization_id=? AND revoked_at IS NULL LIMIT 1`,
      )
      .bind(membershipId, organizationId)
      .first<{ user_id: string; role: string }>();
    if (!target || !isAccountRole(target.role)) {
      throw new AccountPublicError('Ce membre est introuvable.', 404);
    }
    if (target.user_id === user.userId) {
      throw new AccountPublicError(
        'Vous ne pouvez pas retirer votre propre accès depuis cette page.',
        409,
      );
    }
    if (target.role === 'owner') {
      throw new AccountPublicError(
        'Le propriétaire ne peut pas être retiré sans transfert préalable.',
        409,
      );
    }
    if (actor.role !== 'owner' && target.role === 'admin') {
      throw new AccountPublicError(
        'Seul le propriétaire peut retirer un administrateur.',
        403,
      );
    }
    const now = Math.floor(Date.now() / 1_000);
    await db.batch([
      db
        .prepare(
          `UPDATE organization_members SET revoked_at=?
            WHERE membership_id=? AND organization_id=? AND revoked_at IS NULL`,
        )
        .bind(now, membershipId, organizationId),
      db
        .prepare(
          `UPDATE device_sessions SET revoked_at=?
            WHERE organization_id=? AND user_id=? AND revoked_at IS NULL`,
        )
        .bind(now, organizationId, target.user_id),
      db
        .prepare(
          `UPDATE license_activations SET revoked_at=?
            WHERE subscription_id=(
              SELECT subscription_id FROM organizations
               WHERE organization_id=? LIMIT 1
            )
              AND revoked_at IS NULL
              AND installation_id IN (
                SELECT installation_id FROM device_sessions
                 WHERE organization_id=? AND user_id=?
              )
              AND NOT EXISTS (
                SELECT 1 FROM device_sessions active_session
                 WHERE active_session.organization_id=?
                   AND active_session.installation_id=license_activations.installation_id
                   AND active_session.revoked_at IS NULL
                   AND active_session.expires_at>=?
              )`,
        )
        .bind(
          now,
          organizationId,
          organizationId,
          target.user_id,
          organizationId,
          now,
        ),
    ]);
    return Response.json(
      { revoked: true, membershipId },
      { headers: accountNoStoreHeaders() },
    );
  } catch (error) {
    return accountJsonError(error);
  }
}
