import { getZentraUser, zentraSignInPath } from '@/app/zentra-auth';
import {
  BackupRecoveryView,
  type RecoveryBackup,
} from '@/components/backup-recovery-view';
import { membershipsForUser } from '@/lib/account';
import { listBackups } from '@/lib/workspace-backup';

export const dynamic = 'force-dynamic';

export default async function BackupRecoveryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parameters = await searchParams;
  const rawId = parameters.organizationId;
  const requestedId = (Array.isArray(rawId) ? rawId[0] : rawId) ?? '';
  const returnTo = `/compte/sauvegardes?${new URLSearchParams({ organizationId: requestedId })}`;
  const user = await getZentraUser();
  if (!user)
    return (
      <BackupRecoveryView
        organizations={[]}
        backups={[]}
        signInPath={zentraSignInPath(returnTo)}
      />
    );
  const organizations = (await membershipsForUser(user.userId)).filter((item) =>
    ['owner', 'admin'].includes(item.role),
  );
  const organization = requestedId
    ? organizations.find((item) => item.organizationId === requestedId)
    : organizations[0];
  if (!organization)
    return <BackupRecoveryView organizations={organizations} backups={[]} />;
  let backups: RecoveryBackup[] = [];
  let error: string | undefined;
  try {
    backups = (await listBackups(organization.organizationId)).backups;
  } catch {
    error =
      'Le coffre est momentanément inaccessible. Réessayez dans quelques instants ; aucune copie n’a été supprimée.';
  }
  return (
    <BackupRecoveryView
      organizations={organizations}
      organizationId={organization.organizationId}
      backups={backups}
      error={error}
    />
  );
}
