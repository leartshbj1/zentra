import {
  accountNoStoreHeaders,
  enforceAccountRateLimit,
  requireDeviceSession,
} from '@/lib/account';
import { requireBackupRole, backupId } from '@/lib/workspace-backup';
export { accountJsonError, accountNoStoreHeaders } from '@/lib/account';
export async function backupSession(request: Request, write = false) {
  const session = await requireDeviceSession(request);
  requireBackupRole(session);
  await enforceAccountRateLimit(
    request,
    write ? 'backup-write' : 'backup-read',
    session.organizationId,
    2000,
  );
  return session;
}
export function backupQuery(request: Request) {
  const query = new URL(request.url).searchParams;
  const rawIndex = query.get('index');
  return {
    id: backupId(query.get('id')),
    index:
      rawIndex !== null && /^(0|[1-9]\d*)$/.test(rawIndex)
        ? Number(rawIndex)
        : -1,
  };
}
export function backupJson(value: unknown) {
  return Response.json(value, { headers: accountNoStoreHeaders() });
}
