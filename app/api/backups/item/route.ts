import {
  accountJsonError,
  backupJson,
  backupQuery,
  backupSession,
} from '@/lib/workspace-backup-http';
import {
  completeBackup,
  deleteBackup,
  getBackup,
} from '@/lib/workspace-backup';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const s = await backupSession(request);
    return backupJson(
      await getBackup(s.organizationId, backupQuery(request).id),
    );
  } catch (error) {
    return accountJsonError(error);
  }
}
export async function POST(request: Request) {
  try {
    const s = await backupSession(request, true);
    return backupJson(
      await completeBackup(s.organizationId, backupQuery(request).id),
    );
  } catch (error) {
    return accountJsonError(error);
  }
}
export async function DELETE(request: Request) {
  try {
    const s = await backupSession(request, true);
    return backupJson(
      await deleteBackup(s.organizationId, backupQuery(request).id),
    );
  } catch (error) {
    return accountJsonError(error);
  }
}
