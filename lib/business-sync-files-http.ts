import { enforceAccountRateLimit, requireDeviceSession } from './account';
import { AccountPublicError } from './account-security';

export async function businessFilesSession(request: Request) {
  const session = await requireDeviceSession(request);
  await enforceAccountRateLimit(
    request,
    'business-sync-files',
    `${session.organizationId}:${session.installationId}`,
    240,
  );
  return session;
}
export function businessFileIndex(value: string | null) {
  if (value === null || !/^(0|[1-9][0-9]*)$/.test(value))
    throw new AccountPublicError('Numéro de fragment invalide.');
  return Number(value);
}
