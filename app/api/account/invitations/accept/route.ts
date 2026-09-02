import { getChatGPTUser } from '@/app/chatgpt-auth';
import {
  accountJsonError,
  accountNoStoreHeaders,
  normalizedEmail,
} from '@/lib/account';
import {
  AccountPublicError,
  hashOpaqueToken,
  isAccountRole,
  isInvitationToken,
  requireAccountSameOrigin,
} from '@/lib/account-security';
import { readJsonObjectWithinLimit } from '@/lib/request-body';
import { database } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    requireAccountSameOrigin(request);
    const user = await getChatGPTUser();
    if (!user) throw new AccountPublicError('Connexion requise.', 401);
    const body = await readJsonObjectWithinLimit(request, 8_192);
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!isInvitationToken(token)) {
      throw new AccountPublicError('Le lien d’invitation est invalide.');
    }
    const tokenHash = await hashOpaqueToken('invitation', token);
    const now = Math.floor(Date.now() / 1000);
    const db = database();
    const invitation = await db
      .prepare(
        `SELECT invitation.invitation_id,invitation.organization_id,
                invitation.invited_email,invitation.role,organization.name
           FROM organization_invitations invitation
           JOIN organizations organization
             ON organization.organization_id=invitation.organization_id
          WHERE invitation.token_hash=? AND invitation.accepted_at IS NULL
            AND invitation.revoked_at IS NULL AND invitation.expires_at>=?
          LIMIT 1`,
      )
      .bind(tokenHash, now)
      .first<{
        invitation_id: string;
        organization_id: string;
        invited_email: string | null;
        role: string;
        name: string;
      }>();
    if (
      !invitation ||
      !isAccountRole(invitation.role) ||
      invitation.role === 'owner'
    ) {
      throw new AccountPublicError(
        'Cette invitation a expiré, a été révoquée ou a déjà été utilisée.',
        410,
      );
    }
    const email = normalizedEmail(user.email);
    if (invitation.invited_email && invitation.invited_email !== email) {
      throw new AccountPublicError(
        `Cette invitation est réservée à ${invitation.invited_email}.`,
        403,
      );
    }
    const existing = await db
      .prepare(
        `SELECT membership_id,revoked_at FROM organization_members
          WHERE organization_id=? AND user_id=? LIMIT 1`,
      )
      .bind(invitation.organization_id, user.userId)
      .first<{ membership_id: string; revoked_at: number | null }>();
    if (existing?.revoked_at === null) {
      throw new AccountPublicError(
        'Votre compte appartient déjà à cette entreprise.',
        409,
      );
    }
    const membershipId =
      existing?.membership_id ?? `mem_${crypto.randomUUID()}`;
    const [claim, membershipWrite] = await db.batch([
      db
        .prepare(
          `UPDATE organization_invitations
              SET accepted_by_user_id=?,accepted_at=?
            WHERE invitation_id=? AND accepted_at IS NULL
              AND revoked_at IS NULL AND expires_at>=?`,
        )
        .bind(user.userId, now, invitation.invitation_id, now),
      existing
        ? db
            .prepare(
              `UPDATE organization_members
                  SET email=?,display_name=?,role=?,joined_at=?,revoked_at=NULL
                WHERE membership_id=?
                  AND EXISTS(
                    SELECT 1 FROM organization_invitations invitation
                    WHERE invitation.invitation_id=?
                      AND invitation.accepted_by_user_id=?
                      AND invitation.accepted_at=?
                  )`,
            )
            .bind(
              email,
              user.displayName.slice(0, 160),
              invitation.role,
              now,
              membershipId,
              invitation.invitation_id,
              user.userId,
              now,
            )
        : db
            .prepare(
              `INSERT INTO organization_members(
                 membership_id,organization_id,user_id,email,display_name,role,joined_at
               )
               SELECT ?,?,?,?,?,?,?
                WHERE EXISTS(
                  SELECT 1 FROM organization_invitations invitation
                  WHERE invitation.invitation_id=?
                    AND invitation.accepted_by_user_id=?
                    AND invitation.accepted_at=?
                )`,
            )
            .bind(
              membershipId,
              invitation.organization_id,
              user.userId,
              email,
              user.displayName.slice(0, 160),
              invitation.role,
              now,
              invitation.invitation_id,
              user.userId,
              now,
            ),
    ]);
    if (
      (claim.meta.changes ?? 0) !== 1 ||
      (membershipWrite.meta.changes ?? 0) !== 1
    ) {
      throw new AccountPublicError(
        'Cette invitation vient d’être utilisée sur un autre compte.',
        409,
      );
    }
    return Response.json(
      {
        accepted: true,
        organization: {
          id: invitation.organization_id,
          name: invitation.name,
          role: invitation.role,
        },
      },
      { headers: accountNoStoreHeaders() },
    );
  } catch (error) {
    return accountJsonError(error);
  }
}
