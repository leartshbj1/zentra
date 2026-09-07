import { accountJsonError } from '@/lib/account';
import { recoverySession, recoveryDownload } from '@/lib/backup-recovery';
import { backupId } from '@/lib/workspace-backup';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const membership = await recoverySession(request);
    const id = backupId(new URL(request.url).searchParams.get('id'));
    return await recoveryDownload(membership.organizationId, id);
  } catch (error) {
    return accountJsonError(error);
  }
}
