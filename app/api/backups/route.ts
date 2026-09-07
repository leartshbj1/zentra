import {
  accountJsonError,
  backupJson,
  backupSession,
} from '@/lib/workspace-backup-http';
import {
  backupId,
  backupManifest,
  beginBackup,
  listBackups,
} from '@/lib/workspace-backup';
import { readJsonObjectWithinLimit } from '@/lib/request-body';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const session = await backupSession(request);
    return backupJson(await listBackups(session.organizationId));
  } catch (error) {
    return accountJsonError(error);
  }
}
export async function POST(request: Request) {
  try {
    const session = await backupSession(request, true);
    const body = await readJsonObjectWithinLimit(request, 16 * 1024);
    return backupJson(
      await beginBackup(
        session,
        backupId(body.backup_id),
        backupManifest(body.manifest),
      ),
    );
  } catch (error) {
    return accountJsonError(error);
  }
}
