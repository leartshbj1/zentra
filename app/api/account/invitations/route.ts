import { getZentraUser } from '@/app/zentra-auth';
import {
  accountJsonError,
  accountNoStoreHeaders,
  enforceAccountRateLimit,
  normalizedEmail,
  requireBrowserMembership,
} from '@/lib/account';
import {
  AccountPublicError,
  hashOpaqueToken,
  isAccountRole,
  newInvitationToken,
  requireAccountSameOrigin,
  roleCanManageMembers,
} from '@/lib/account-security';
import { readJsonObjectWithinLimit } from '@/lib/request-body';
import { database } from '@/lib/runtime';
import { requireInvitationCapacity } from '@/lib/team-seats';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    requireAccountSameOrigin(request);
    const user = await getZentraUser({ refreshSession: true });
    if (!user) throw new AccountPublicError('Connexion requise.', 401);
    const body = await readJsonObjectWithinLimit(request, 8_192);
    const organizationId =
      typeof body.organizationId === 'string' ? body.organizationId.trim() : '';
    const role = body.role;
    if (!isAccountRole(role) || role === 'owner') {
      throw new AccountPublicError('Le rôle choisi est invalide.');
    }
    const membership = await requireBrowserMembership(
      user.userId,
      organizationId,
    );
    if (!roleCanManageMembers(membership.role)) {
      throw new AccountPublicError(
        'Votre rôle ne permet pas d’inviter des collaborateurs.',
        403,
      );
    }
    await enforceAccountRateLimit(
      request,
      'member-invite',
      `${user.userId}:${organizationId}`,
      30,
    );
    const invitedEmail =
      typeof body.email === 'string' && body.email.trim()
        ? normalizedEmail(body.email)
        : null;
    if (!invitedEmail)
      throw new AccountPublicError(
        'Indiquez l’adresse e-mail de la personne à inviter.',
      );
    await requireInvitationCapacity(organizationId);
    const db = database();
    const token = newInvitationToken();
    const tokenHash = await hashOpaqueToken('invitation', token);
    const now = Math.floor(Date.now() / 1000);
    const duplicate = await db
      .prepare(`SELECT 1 FROM organization_members WHERE organization_id=? AND email=? AND revoked_at IS NULL
      UNION ALL SELECT 1 FROM organization_invitations WHERE organization_id=? AND invited_email=? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>=? LIMIT 1`)
      .bind(organizationId, invitedEmail, organizationId, invitedEmail, now)
      .first();
    if (duplicate)
      throw new AccountPublicError(
        'Cette personne dispose déjà d’un accès ou d’une invitation en attente.',
        409,
      );
    const expiresAt = now + 7 * 24 * 60 * 60;
    const invitationId = `inv_${crypto.randomUUID()}`;
    await db
      .prepare(
        `INSERT INTO organization_invitations(
           invitation_id,organization_id,token_hash,invited_email,role,
           created_by_user_id,created_at,expires_at
         ) VALUES(?,?,?,?,?,?,?,?)`,
      )
      .bind(
        invitationId,
        organizationId,
        tokenHash,
        invitedEmail,
        role,
        user.userId,
        now,
        expiresAt,
      )
      .run();
    const invitationUrl = new URL('/invitation', request.url);
    invitationUrl.searchParams.set('token', token);
    return Response.json(
      {
        invitation: {
          id: invitationId,
          url: invitationUrl.toString(),
          expiresAt: new Date(expiresAt * 1000).toISOString(),
          email: invitedEmail,
          role,
        },
      },
      { status: 201, headers: accountNoStoreHeaders() },
    );
  } catch (error) {
    return accountJsonError(error);
  }
}
