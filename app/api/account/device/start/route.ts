import {
  accountJsonError,
  accountNoStoreHeaders,
  enforceAccountRateLimit,
} from '@/lib/account';
import {
  AccountPublicError,
  hashOpaqueToken,
  isInstallationId,
  newDeviceCode,
  newUserCode,
} from '@/lib/account-security';
import { readJsonObjectWithinLimit } from '@/lib/request-body';
import { database } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

const AUTHORIZATION_LIFETIME_SECONDS = 10 * 60;

export async function POST(request: Request) {
  try {
    const body = await readJsonObjectWithinLimit(request, 8_192);
    const installationId =
      typeof body.installationId === 'string' ? body.installationId.trim() : '';
    if (!isInstallationId(installationId)) {
      throw new AccountPublicError(
        'L’identifiant de cette installation est invalide.',
      );
    }
    await enforceAccountRateLimit(request, 'device-start-ip', 'all', 60);
    await enforceAccountRateLimit(request, 'device-start', installationId, 12);

    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + AUTHORIZATION_LIFETIME_SECONDS;
    const db = database();
    await db
      .prepare('DELETE FROM device_authorizations WHERE expires_at<?')
      .bind(now - 86_400)
      .run();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const deviceCode = newDeviceCode();
      const deviceCodeHash = await hashOpaqueToken('device-code', deviceCode);
      const userCode = newUserCode();
      try {
        await db
          .prepare(
            `INSERT INTO device_authorizations(
               device_code_hash,user_code,installation_id,status,created_at,expires_at
             ) VALUES(?,?,?,'pending',?,?)`,
          )
          .bind(deviceCodeHash, userCode, installationId, now, expiresAt)
          .run();
        const verification = new URL('/appareil', request.url);
        verification.searchParams.set('code', userCode);
        return Response.json(
          {
            deviceCode,
            userCode,
            verificationUri: verification.toString(),
            expiresIn: AUTHORIZATION_LIFETIME_SECONDS,
            interval: 3,
          },
          { status: 201, headers: accountNoStoreHeaders() },
        );
      } catch (error) {
        if (attempt === 4) throw error;
      }
    }
    throw new Error('unreachable');
  } catch (error) {
    return accountJsonError(error);
  }
}
