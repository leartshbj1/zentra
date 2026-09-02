import {
  accountJsonError,
  accountNoStoreHeaders,
  enforceAccountRateLimit,
} from '@/lib/account';
import {
  AccountPublicError,
  hashOpaqueToken,
  isAccountRole,
  isDeviceCode,
  newDeviceSessionToken,
} from '@/lib/account-security';
import { issueLicense } from '@/lib/license-token';
import { readJsonObjectWithinLimit } from '@/lib/request-body';
import { database } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

const DEVICE_SESSION_LIFETIME_SECONDS = 30 * 24 * 60 * 60;

export async function POST(request: Request) {
  let claimedHash = '';
  try {
    const body = await readJsonObjectWithinLimit(request, 8_192);
    const deviceCode =
      typeof body.deviceCode === 'string' ? body.deviceCode.trim() : '';
    if (!isDeviceCode(deviceCode)) {
      throw new AccountPublicError(
        'Le code secret de l’appareil est invalide.',
      );
    }
    claimedHash = await hashOpaqueToken('device-code', deviceCode);
    await enforceAccountRateLimit(request, 'device-poll', claimedHash, 240);
    const db = database();
    const now = Math.floor(Date.now() / 1000);
    const authorization = await db
      .prepare(
        `SELECT installation_id,status,organization_id,approved_by_user_id,expires_at
           FROM device_authorizations WHERE device_code_hash=? LIMIT 1`,
      )
      .bind(claimedHash)
      .first<{
        installation_id: string;
        status: string;
        organization_id: string | null;
        approved_by_user_id: string | null;
        expires_at: number;
      }>();
    if (!authorization || authorization.expires_at < now) {
      throw new AccountPublicError(
        'Cette demande de connexion a expiré. Relancez la connexion depuis Zentra.',
        410,
      );
    }
    if (authorization.status === 'pending') {
      return Response.json(
        { status: 'authorization_pending' },
        { status: 202, headers: accountNoStoreHeaders() },
      );
    }
    if (authorization.status !== 'approved') {
      throw new AccountPublicError(
        'Cette demande de connexion a déjà été utilisée.',
        410,
      );
    }
    if (!authorization.organization_id || !authorization.approved_by_user_id) {
      throw new AccountPublicError('Autorisation appareil incomplète.', 409);
    }

    const claim = await db
      .prepare(
        `UPDATE device_authorizations SET status='exchanging'
          WHERE device_code_hash=? AND status='approved'`,
      )
      .bind(claimedHash)
      .run();
    if ((claim.meta.changes ?? 0) !== 1) {
      throw new AccountPublicError(
        'La connexion est déjà en cours sur cet appareil.',
        409,
      );
    }

    try {
      const account = await db
        .prepare(
          `SELECT organization.name,organization.subscription_id,
                  subscription.customer_name,subscription.entitlement_valid_until,
                  member.role
             FROM organizations organization
             JOIN subscriptions subscription
               ON subscription.subscription_id=organization.subscription_id
             JOIN organization_members member
               ON member.organization_id=organization.organization_id
              AND member.user_id=? AND member.revoked_at IS NULL
            WHERE organization.organization_id=? LIMIT 1`,
        )
        .bind(authorization.approved_by_user_id, authorization.organization_id)
        .first<{
          name: string;
          subscription_id: string;
          customer_name: string | null;
          entitlement_valid_until: number;
          role: string;
        }>();
      if (
        !account ||
        !isAccountRole(account.role) ||
        account.entitlement_valid_until < now
      ) {
        throw new AccountPublicError(
          'Le compte ou son abonnement n’est plus actif.',
          402,
        );
      }
      const sessionToken = newDeviceSessionToken();
      const tokenHash = await hashOpaqueToken('device-session', sessionToken);
      const sessionId = `dss_${crypto.randomUUID()}`;
      const expiresAt = now + DEVICE_SESSION_LIFETIME_SECONDS;
      const license = await issueLicense({
        subscriptionId: account.subscription_id,
        installationId: authorization.installation_id,
        customerName: account.customer_name ?? account.name,
        periodEnd: account.entitlement_valid_until,
        channel: 'account',
        accessRole: account.role,
        accountUserId: authorization.approved_by_user_id,
        accountSessionId: sessionId,
      });
      await db.batch([
        db
          .prepare(
            `UPDATE device_sessions SET revoked_at=?
              WHERE organization_id=? AND installation_id=?
                AND revoked_at IS NULL`,
          )
          .bind(
            now,
            authorization.organization_id,
            authorization.installation_id,
          ),
        db
          .prepare(
            `INSERT INTO device_sessions(
               session_id,token_hash,organization_id,user_id,installation_id,
               created_at,last_seen_at,expires_at
             ) VALUES(?,?,?,?,?,?,?,?)`,
          )
          .bind(
            sessionId,
            tokenHash,
            authorization.organization_id,
            authorization.approved_by_user_id,
            authorization.installation_id,
            now,
            now,
            expiresAt,
          ),
        db
          .prepare(
            `UPDATE device_authorizations SET status='consumed',consumed_at=?
              WHERE device_code_hash=? AND status='exchanging'`,
          )
          .bind(now, claimedHash),
      ]);
      return Response.json(
        {
          status: 'approved',
          sessionToken,
          sessionExpiresAt: new Date(expiresAt * 1000).toISOString(),
          organization: {
            id: authorization.organization_id,
            name: account.name,
            role: account.role,
          },
          license,
        },
        { headers: accountNoStoreHeaders() },
      );
    } catch (error) {
      await db
        .prepare(
          `UPDATE device_authorizations SET status='approved'
            WHERE device_code_hash=? AND status='exchanging'`,
        )
        .bind(claimedHash)
        .run();
      throw error;
    }
  } catch (error) {
    return accountJsonError(error);
  }
}
