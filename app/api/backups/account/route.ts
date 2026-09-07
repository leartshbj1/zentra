import { accountJsonError, accountNoStoreHeaders } from '@/lib/account';
import { recoverySession } from '@/lib/backup-recovery';
import { listBackups } from '@/lib/workspace-backup';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const membership = await recoverySession(request);
    return Response.json(await listBackups(membership.organizationId), {
      headers: accountNoStoreHeaders(),
    });
  } catch (error) {
    return accountJsonError(error);
  }
}
