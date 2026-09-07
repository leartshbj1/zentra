import {
  accountJsonError,
  accountNoStoreHeaders,
  backupJson,
  backupQuery,
  backupSession,
} from '@/lib/workspace-backup-http';
import { downloadBackupChunk, uploadBackupChunk } from '@/lib/workspace-backup';
export const dynamic = 'force-dynamic';
export async function PUT(request: Request) {
  try {
    const s = await backupSession(request, true);
    const q = backupQuery(request);
    return backupJson(
      await uploadBackupChunk(request, s.organizationId, q.id, q.index),
    );
  } catch (error) {
    return accountJsonError(error);
  }
}
export async function GET(request: Request) {
  try {
    const s = await backupSession(request);
    const q = backupQuery(request);
    const { part, object } = await downloadBackupChunk(
      s.organizationId,
      q.id,
      q.index,
    );
    const headers = new Headers(accountNoStoreHeaders());
    headers.set('Content-Type', 'application/octet-stream');
    headers.set('Content-Length', String(part.size_bytes));
    headers.set(
      'Content-Disposition',
      'attachment; filename="sauvegarde.part"',
    );
    headers.set('X-Zentra-Sha256', part.sha256);
    return new Response(object.body, { headers });
  } catch (error) {
    return accountJsonError(error);
  }
}
