import { accountJsonError, accountNoStoreHeaders } from '@/lib/account';
import { recoverySession } from '@/lib/backup-recovery';
import { listBackups } from '@/lib/workspace-backup';
import { requireLegacyCountryTransport } from '@/lib/international/legacy-country-guard';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const membership = await recoverySession(request);
    await requireLegacyCountryTransport(membership.organizationId);
    return Response.json(await listBackups(membership.organizationId), {
      headers: accountNoStoreHeaders(),
    });
  } catch (error) {
    return accountJsonError(error);
  }
}
