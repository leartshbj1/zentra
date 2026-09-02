import { getChatGPTUser } from '@/app/chatgpt-auth';
import {
  accountJsonError,
  accountNoStoreHeaders,
  enforceAccountRateLimit,
  membershipsForUser,
} from '@/lib/account';
import {
  AccountPublicError,
  normalizeUserCode,
  requireAccountSameOrigin,
} from '@/lib/account-security';
import { readJsonObjectWithinLimit } from '@/lib/request-body';
import { database } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    requireAccountSameOrigin(request);
    const user = await getChatGPTUser();
    if (!user) {
      throw new AccountPublicError(
        'Connectez-vous avant d’autoriser cet appareil.',
        401,
      );
    }
    const body = await readJsonObjectWithinLimit(request, 8_192);
    const userCode = normalizeUserCode(
      typeof body.userCode === 'string' ? body.userCode : '',
    );
    await enforceAccountRateLimit(request, 'device-approve', user.userId, 60);
    const requestedOrganizationId =
      typeof body.organizationId === 'string' ? body.organizationId.trim() : '';
    const memberships = await membershipsForUser(user.userId);
    const membership = requestedOrganizationId
      ? memberships.find(
          (candidate) => candidate.organizationId === requestedOrganizationId,
        )
      : memberships.length === 1
        ? memberships[0]
        : undefined;
    if (!membership) {
      throw new AccountPublicError(
        memberships.length
          ? 'Choisissez l’entreprise à ouvrir sur cet appareil.'
          : 'Aucune entreprise Zentra n’est encore liée à ce compte.',
        403,
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const entitlement = await database()
      .prepare(
        `SELECT subscription.entitlement_valid_until
           FROM organizations organization
           JOIN subscriptions subscription
             ON subscription.subscription_id=organization.subscription_id
          WHERE organization.organization_id=? LIMIT 1`,
      )
      .bind(membership.organizationId)
      .first<{ entitlement_valid_until: number }>();
    if (!entitlement || entitlement.entitlement_valid_until < now) {
      throw new AccountPublicError(
        'L’abonnement de cette entreprise doit être régularisé avant d’ajouter un appareil.',
        402,
      );
    }
    const result = await database()
      .prepare(
        `UPDATE device_authorizations
            SET status='approved',organization_id=?,approved_by_user_id=?,approved_at=?
          WHERE user_code=? AND status='pending' AND expires_at>=?`,
      )
      .bind(membership.organizationId, user.userId, now, userCode, now)
      .run();
    if ((result.meta.changes ?? 0) !== 1) {
      throw new AccountPublicError(
        'Ce code appareil est introuvable, expiré ou déjà utilisé.',
        409,
      );
    }
    return Response.json(
      {
        approved: true,
        organization: {
          id: membership.organizationId,
          name: membership.organizationName,
        },
      },
      { headers: accountNoStoreHeaders() },
    );
  } catch (error) {
    return accountJsonError(error);
  }
}
