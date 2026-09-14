import { database } from './runtime';
import { AccountPublicError, roleCanManageMembers } from './account-security';
import type { DeviceSessionContext } from './account';
import { backupId, getBackup } from './workspace-backup';

/** Only this explicitly published copy is shared. The private backup history stays private. */
export async function companyCopy(organizationId: string) {
  return database().prepare(`SELECT c.backup_id AS backupId, c.published_at AS publishedAt,
    b.size_bytes AS sizeBytes FROM company_copies c JOIN workspace_backups b
    ON b.backup_id=c.backup_id AND b.organization_id=c.organization_id
    WHERE c.organization_id=? AND b.state='complete'`).bind(organizationId)
    .first<{backupId:string;publishedAt:string;sizeBytes:number}>();
}

export async function publishCompanyCopy(actor: DeviceSessionContext, value: unknown, confirmed: unknown) {
  if (!roleCanManageMembers(actor.role)) throw new AccountPublicError('Seuls le titulaire et les administrateurs peuvent partager l’entreprise complète.',403);
  if (confirmed !== true) throw new AccountPublicError('Confirmez le partage de la base complète, y compris la comptabilité et les salaires.');
  const id = backupId(value);
  await getBackup(actor.organizationId,id);
  // The INSERT SELECT checks completeness again atomically if the archive is being deleted.
  const saved = await database().prepare(`INSERT INTO company_copies(organization_id,backup_id,published_by,published_at)
    SELECT organization_id,backup_id,?,? FROM workspace_backups WHERE organization_id=? AND backup_id=? AND state='complete'
    ON CONFLICT(organization_id) DO UPDATE SET backup_id=excluded.backup_id,published_by=excluded.published_by,published_at=excluded.published_at`)
    .bind(actor.userId,new Date().toISOString(),actor.organizationId,id).run();
  if (saved.meta.changes !== 1) throw new AccountPublicError('La copie n’est plus disponible. Recommencez le partage.',409);
  return companyCopy(actor.organizationId);
}

export async function requireCompanyCopy(organizationId: string, requestedId?: string) {
  const copy = await companyCopy(organizationId);
  if (!copy) throw new AccountPublicError('Le titulaire doit partager une copie complète depuis Paramètres → Compte et équipe. Réessayez ensuite.',409);
  if (requestedId && requestedId !== copy.backupId) throw new AccountPublicError('La copie partagée a changé. Relancez le téléchargement pour recevoir la dernière version.',409);
  return copy;
}
