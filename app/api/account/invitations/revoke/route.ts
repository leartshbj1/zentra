import { getChatGPTUser } from '@/app/chatgpt-auth';
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
    const user = await getChatGPTUser();
    if (!user) throw new AccountPublicError('Connexion requise.', 401);
    const body = await readJsonObjectWithinLimit(request, 8_192);
    const organizationId =
      typeof body.organizationId === 'string' ? body.organizationId.trim() : '';
    const invitationId =
      typeof body.invitationId === 'string' ? body.invitationId.trim() : '';
    if (!/^inv_[0-9a-f-]{36}$/i.test(invitationId)) {
      throw new AccountPublicError('Cette invitation est invalide.');
    }
    const actor = await requireBrowserMembership(user.userId, organizationId);
    if (!roleCanManageMembers(actor.role)) {
      throw new AccountPublicError(
        'Votre rôle ne permet pas de révoquer une invitation.',
        403,
      );
    }
    const result = await database()
      .prepare(
        `UPDATE organization_invitations SET revoked_at=?
          WHERE invitation_id=? AND organization_id=?
            AND accepted_at IS NULL AND revoked_at IS NULL`,
      )
      .bind(Math.floor(Date.now() / 1_000), invitationId, organizationId)
      .run();
    if ((result.meta.changes ?? 0) !== 1) {
      throw new AccountPublicError(
        'Cette invitation est introuvable ou déjà utilisée.',
        404,
      );
    }
    return Response.json(
      { revoked: true, invitationId },
      { headers: accountNoStoreHeaders() },
    );
  } catch (error) {
    return accountJsonError(error);
  }
}
