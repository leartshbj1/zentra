import { RequestBodyError } from '@/lib/request-body';
import { database } from '@/lib/runtime';
import {
  AccountPublicError,
  bearerSessionToken,
  hashOpaqueToken,
  isAccountRole,
  type AccountRole,
  sha256Hex,
} from '@/lib/account-security';

export type OrganizationMembership = {
  organizationId: string;
  organizationName: string;
  subscriptionId: string;
  role: AccountRole;
};

export type DeviceSessionContext = OrganizationMembership & {
  sessionId: string;
  userId: string;
  installationId: string;
  entitlementValidUntil: number;
};

export function accountNoStoreHeaders(): HeadersInit {
  return {
    'Cache-Control': 'no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
}

export function accountJsonError(reason: unknown): Response {
  const publicReason =
    reason instanceof AccountPublicError || reason instanceof RequestBodyError;
  return Response.json(
    {
      error: publicReason
        ? reason.message
        : 'Le service de compte Zentra est momentanément indisponible.',
    },
    {
      status: publicReason ? reason.status : 500,
      headers: accountNoStoreHeaders(),
    },
  );
}

export function normalizedEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (
    email.length < 3 ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw new AccountPublicError('L’adresse e-mail est invalide.');
  }
  return email;
}

export async function membershipsForUser(
  userId: string,
): Promise<OrganizationMembership[]> {
  const result = await database()
    .prepare(
      `SELECT member.organization_id,organization.name AS organization_name,
              organization.subscription_id,member.role
         FROM organization_members member
         JOIN organizations organization
           ON organization.organization_id=member.organization_id
        WHERE member.user_id=? AND member.revoked_at IS NULL
        ORDER BY member.joined_at,member.organization_id`,
    )
    .bind(userId)
    .all<{
      organization_id: string;
      organization_name: string;
      subscription_id: string;
      role: string;
    }>();
  return result.results.flatMap((row) => {
    if (!isAccountRole(row.role)) return [];
    return [
      {
        organizationId: row.organization_id,
        organizationName: row.organization_name,
        subscriptionId: row.subscription_id,
        role: row.role,
      },
    ];
  });
}

export async function requireBrowserMembership(
  userId: string,
  organizationId: string,
  allowedRoles?: readonly AccountRole[],
): Promise<OrganizationMembership> {
  const memberships = await membershipsForUser(userId);
  const membership = memberships.find(
    (candidate) => candidate.organizationId === organizationId,
  );
  if (!membership) {
    throw new AccountPublicError(
      'Vous n’avez pas accès à cette entreprise.',
      403,
    );
  }
  if (allowedRoles && !allowedRoles.includes(membership.role)) {
    throw new AccountPublicError(
      'Votre rôle ne permet pas cette opération.',
      403,
    );
  }
  return membership;
}

export async function requireDeviceSession(
  request: Request,
  allowedRoles?: readonly AccountRole[],
): Promise<DeviceSessionContext> {
  const token = bearerSessionToken(request);
  const tokenHash = await hashOpaqueToken('device-session', token);
  const now = Math.floor(Date.now() / 1000);
  const row = await database()
    .prepare(
      `SELECT session.session_id,session.organization_id,session.user_id,
              session.installation_id,organization.name AS organization_name,
              organization.subscription_id,
              member.role,subscription.entitlement_valid_until
         FROM device_sessions session
         JOIN organizations organization
           ON organization.organization_id=session.organization_id
         JOIN subscriptions subscription
           ON subscription.subscription_id=organization.subscription_id
         JOIN license_activations activation
           ON activation.subscription_id=organization.subscription_id
          AND activation.installation_id=session.installation_id
          AND activation.revoked_at IS NULL
         JOIN organization_members member
           ON member.organization_id=session.organization_id
          AND member.user_id=session.user_id
        WHERE session.token_hash=?
          AND session.revoked_at IS NULL
          AND session.expires_at>=?
          AND member.revoked_at IS NULL
        LIMIT 1`,
    )
    .bind(tokenHash, now)
    .first<{
      session_id: string;
      organization_id: string;
      user_id: string;
      installation_id: string;
      organization_name: string;
      subscription_id: string;
      role: string;
      entitlement_valid_until: number;
    }>();
  if (!row || !isAccountRole(row.role)) {
    throw new AccountPublicError(
      'La session de cet appareil a expiré ou a été révoquée.',
      401,
    );
  }
  if (row.entitlement_valid_until < now) {
    throw new AccountPublicError(
      'L’abonnement de cette entreprise n’est plus actif.',
      402,
    );
  }
  if (allowedRoles && !allowedRoles.includes(row.role)) {
    throw new AccountPublicError(
      'Votre rôle ne permet pas cette opération.',
      403,
    );
  }
  await database()
    .prepare(
      'UPDATE device_sessions SET last_seen_at=? WHERE session_id=? AND last_seen_at<?',
    )
    .bind(now, row.session_id, now - 300)
    .run();
  return {
    sessionId: row.session_id,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    subscriptionId: row.subscription_id,
    role: row.role,
    userId: row.user_id,
    installationId: row.installation_id,
    entitlementValidUntil: row.entitlement_valid_until,
  };
}

export async function enforceAccountRateLimit(
  request: Request,
  scope: string,
  subject: string,
  maximum: number,
): Promise<void> {
  const address = request.headers.get('CF-Connecting-IP')?.trim() || 'unknown';
  const now = Math.floor(Date.now() / 1000);
  const windowStartedAt = Math.floor(now / 3_600) * 3_600;
  const rateKey = await sha256Hex(
    `zentra-account-rate-v1:${scope}:${windowStartedAt}:${address}:${subject}`,
  );
  const db = database();
  await db
    .prepare('DELETE FROM checkout_rate_limits WHERE expires_at<?')
    .bind(now)
    .run();
  await db
    .prepare(
      `INSERT INTO checkout_rate_limits(rate_key,count,window_started_at,expires_at)
       VALUES(?,1,?,?)
       ON CONFLICT(rate_key) DO UPDATE SET count=checkout_rate_limits.count+1`,
    )
    .bind(rateKey, windowStartedAt, windowStartedAt + 7_200)
    .run();
  const row = await db
    .prepare('SELECT count FROM checkout_rate_limits WHERE rate_key=?')
    .bind(rateKey)
    .first<{ count: number }>();
  if ((row?.count ?? 0) > maximum) {
    throw new AccountPublicError(
      'Trop de tentatives. Réessayez dans une heure.',
      429,
    );
  }
}
