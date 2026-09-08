import { type DeviceSessionContext } from '@/lib/account';
import { AccountPublicError, sha256Hex } from '@/lib/account-security';
import { readBytesBodyWithinLimit } from '@/lib/request-body';
import { database, fileArchive } from '@/lib/runtime';

// Each transfer fits comfortably inside a Worker and a mobile device's memory.
export const BACKUP_CHUNK_BYTES = 8 * 1024 * 1024;
export const MAX_BACKUP_CHUNKS = 64;
export const MAX_BACKUPS = 50;
export const MAX_BACKUP_STORAGE_BYTES = 10 * 1024 * 1024 * 1024;
export type BackupManifest = {
  format: 'zentra-cloud-backup';
  version: 1;
  app_version: string;
  sha256: string;
  size_bytes: number;
  chunks: { sha256: string; size_bytes: number }[];
};
type BackupRow = {
  backup_id: string;
  organization_id: string;
  installation_id: string;
  created_by: string;
  manifest_json: string;
  size_bytes: number;
  state: 'uploading' | 'complete' | 'deleting' | 'deleted';
  created_at: string;
  completed_at: string | null;
};
export function backupId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  )
    throw new AccountPublicError('Référence de sauvegarde invalide.');
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))
    throw new AccountPublicError('Empreinte de sauvegarde invalide.');
  return value;
}
export function backupManifest(value: unknown): BackupManifest {
  const input = value as Partial<BackupManifest> | null;
  if (
    !input ||
    input.format !== 'zentra-cloud-backup' ||
    input.version !== 1 ||
    typeof input.app_version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(input.app_version) ||
    input.app_version.length > 60 ||
    !Array.isArray(input.chunks) ||
    !input.chunks.length ||
    input.chunks.length > MAX_BACKUP_CHUNKS
  )
    throw new AccountPublicError('Format de sauvegarde non pris en charge.');
  const chunks = input.chunks.map((part, index) => {
    if (
      !part ||
      !Number.isSafeInteger(part.size_bytes) ||
      part.size_bytes <= 0 ||
      part.size_bytes > BACKUP_CHUNK_BYTES ||
      (index < input.chunks!.length - 1 &&
        part.size_bytes !== BACKUP_CHUNK_BYTES)
    )
      throw new AccountPublicError(
        'Taille de fragment de sauvegarde invalide.',
      );
    return { sha256: hash(part.sha256), size_bytes: part.size_bytes };
  });
  const size = chunks.reduce((sum, part) => sum + part.size_bytes, 0);
  if (input.size_bytes !== size)
    throw new AccountPublicError('La taille de la sauvegarde est incohérente.');
  return {
    format: 'zentra-cloud-backup',
    version: 1,
    app_version: input.app_version,
    sha256: hash(input.sha256),
    size_bytes: size,
    chunks,
  };
}
export function requireBackupRole(session: DeviceSessionContext) {
  // A full backup contains payroll and the entire ledger, including deleted records.
  if (session.role !== 'owner' && session.role !== 'admin')
    throw new AccountPublicError(
      'Les sauvegardes complètes sont réservées au titulaire et aux administrateurs.',
      403,
    );
}
async function stored(org: string, id: string): Promise<BackupRow | null> {
  return database()
    .prepare(
      'SELECT * FROM workspace_backups WHERE organization_id=? AND backup_id=?',
    )
    .bind(org, id)
    .first<BackupRow>();
}
async function required(org: string, id: string) {
  const row = await stored(org, id);
  if (!row) throw new AccountPublicError('Sauvegarde introuvable.', 404);
  if (row.state === 'deleted' || row.state === 'deleting')
    throw new AccountPublicError('Cette sauvegarde a été supprimée.', 410);
  return row;
}
function publicBackup(row: BackupRow) {
  const manifest = backupManifest(JSON.parse(row.manifest_json));
  return {
    backup_id: row.backup_id,
    installation_id: row.installation_id,
    app_version: manifest.app_version,
    size_bytes: row.size_bytes,
    sha256: manifest.sha256,
    state: row.state,
    created_at: row.created_at,
    completed_at: row.completed_at,
  };
}

async function resumableBackup(row: BackupRow) {
  const manifest = backupManifest(JSON.parse(row.manifest_json));
  const receipts = await database()
    .prepare(
      'SELECT chunk_index,sha256,size_bytes FROM workspace_backup_chunks WHERE backup_id=? ORDER BY chunk_index LIMIT ?',
    )
    .bind(row.backup_id, MAX_BACKUP_CHUNKS + 1)
    .all<{ chunk_index: number; sha256: string; size_bytes: number }>();
  if (
    receipts.results.length > manifest.chunks.length ||
    receipts.results.some((receipt) => {
      const expected = manifest.chunks[receipt.chunk_index];
      return (
        !Number.isSafeInteger(receipt.chunk_index) ||
        !expected ||
        receipt.sha256 !== expected.sha256 ||
        receipt.size_bytes !== expected.size_bytes
      );
    })
  )
    throw new AccountPublicError(
      'Les confirmations de sauvegarde sont incohérentes. Réessayez plus tard.',
      503,
    );
  // Receipts are written only after R2 has accepted the immutable bytes.
  return { ...publicBackup(row), received_chunks: receipts.results };
}
export async function listBackups(org: string) {
  const rows = await database()
    .prepare(
      "SELECT * FROM workspace_backups WHERE organization_id=? AND state<>'deleted' ORDER BY created_at DESC,backup_id DESC LIMIT 50",
    )
    .bind(org)
    .all<BackupRow>();
  return {
    backups: rows.results.map(publicBackup),
    max_backups: MAX_BACKUPS,
    max_storage_bytes: MAX_BACKUP_STORAGE_BYTES,
  };
}
export async function beginBackup(
  session: DeviceSessionContext,
  id: string,
  manifest: BackupManifest,
) {
  const json = JSON.stringify(manifest);
  const prior = await stored(session.organizationId, id);
  if (prior) {
    if (prior.state === 'deleted' || prior.state === 'deleting')
      throw new AccountPublicError('Cette sauvegarde a été supprimée.', 410);
    if (
      prior.manifest_json !== json ||
      prior.installation_id !== session.installationId
    )
      throw new AccountPublicError(
        'Cette référence est déjà utilisée pour une autre sauvegarde.',
        409,
      );
    return resumableBackup(prior);
  }
  // Quota reservation and insertion are one SQL statement: concurrent devices cannot overbook.
  await database()
    .prepare(`INSERT OR IGNORE INTO workspace_backups(backup_id,organization_id,installation_id,created_by,manifest_json,size_bytes,state,created_at)
    SELECT ?,?,?,?,?,?,'uploading',? WHERE
    (SELECT COUNT(*) FROM workspace_backups WHERE organization_id=? AND state<>'deleted') < ? AND
    (SELECT COALESCE(SUM(size_bytes),0) FROM workspace_backups WHERE organization_id=? AND state<>'deleted') + ? <= ?`)
    .bind(
      id,
      session.organizationId,
      session.installationId,
      session.userId,
      json,
      manifest.size_bytes,
      new Date().toISOString(),
      session.organizationId,
      MAX_BACKUPS,
      session.organizationId,
      manifest.size_bytes,
      MAX_BACKUP_STORAGE_BYTES,
    )
    .run();
  const result = await stored(session.organizationId, id);
  if (!result)
    throw new AccountPublicError(
      'Le coffre de sauvegardes est plein. Supprimez une ancienne sauvegarde après avoir vérifié une copie récente.',
      409,
    );
  if (
    result.state === 'deleted' ||
    result.state === 'deleting' ||
    result.manifest_json !== json ||
    result.installation_id !== session.installationId
  )
    throw new AccountPublicError(
      'Cette référence est déjà utilisée pour une autre sauvegarde.',
      409,
    );
  return resumableBackup(result);
}
function chunk(row: BackupRow, index: number) {
  const manifest = backupManifest(JSON.parse(row.manifest_json));
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= manifest.chunks.length
  )
    throw new AccountPublicError('Fragment de sauvegarde invalide.');
  return {
    part: manifest.chunks[index],
    key: `workspace-backups/${row.organization_id}/${row.backup_id}/${index}`,
  };
}
export async function uploadBackupChunk(
  request: Request,
  org: string,
  id: string,
  index: number,
) {
  const row = await required(org, id);
  const { part, key } = chunk(row, index);
  const bytes = await readBytesBodyWithinLimit(request, part.size_bytes);
  if (
    bytes.length !== part.size_bytes ||
    (await sha256Hex(bytes)) !== part.sha256
  )
    throw new AccountPublicError('Le fragment reçu est incomplet ou altéré.');
  if (row.state === 'complete') return { stored: true };
  await fileArchive().put(key, bytes, {
    httpMetadata: {
      contentType: 'application/octet-stream',
      cacheControl: 'private, no-store',
    },
    customMetadata: { sha256: part.sha256 },
  });
  // Advertise a part only after its bytes are durable. It is immutable because the manifest is.
  await database()
    .prepare(`INSERT OR IGNORE INTO workspace_backup_chunks(backup_id,chunk_index,sha256,size_bytes)
    SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM workspace_backups WHERE organization_id=? AND backup_id=? AND state='uploading')`)
    .bind(id, index, part.sha256, bytes.length, org, id)
    .run();
  const current = await stored(org, id);
  if (!current || current.state === 'deleted' || current.state === 'deleting') {
    try {
      await fileArchive().delete(key);
    } catch (error) {
      // Retain a visible cleanup obligation if a late upload outlives deletion.
      await database()
        .prepare(
          "UPDATE workspace_backups SET state='deleting' WHERE organization_id=? AND backup_id=?",
        )
        .bind(org, id)
        .run();
      throw error;
    }
    throw new AccountPublicError('Cette sauvegarde a été supprimée.', 410);
  }
  return { stored: true };
}
export async function completeBackup(org: string, id: string) {
  const row = await required(org, id);
  const manifest = backupManifest(JSON.parse(row.manifest_json));
  await database()
    .prepare(`UPDATE workspace_backups SET state='complete',completed_at=?
    WHERE organization_id=? AND backup_id=? AND state='uploading'
      AND (SELECT COUNT(*) FROM workspace_backup_chunks WHERE backup_id=?)=?
      AND (SELECT SUM(size_bytes) FROM workspace_backup_chunks WHERE backup_id=?)=?`)
    .bind(
      new Date().toISOString(),
      org,
      id,
      id,
      manifest.chunks.length,
      id,
      manifest.size_bytes,
    )
    .run();
  const saved = await required(org, id);
  if (saved.state !== 'complete')
    throw new AccountPublicError(
      'La sauvegarde attend encore des fragments. L’envoi peut être repris.',
      409,
    );
  return publicBackup(saved);
}
export async function getBackup(org: string, id: string) {
  const row = await required(org, id);
  if (row.state !== 'complete')
    throw new AccountPublicError(
      'Cette sauvegarde est encore en cours d’envoi.',
      409,
    );
  return {
    ...publicBackup(row),
    manifest: backupManifest(JSON.parse(row.manifest_json)),
  };
}
export async function downloadBackupChunk(
  org: string,
  id: string,
  index: number,
) {
  const row = await required(org, id);
  if (row.state !== 'complete')
    throw new AccountPublicError(
      'Cette sauvegarde est encore en cours d’envoi.',
      409,
    );
  const { part, key } = chunk(row, index);
  const object = await fileArchive().get(key);
  if (!object)
    throw new AccountPublicError(
      'Un fragment est momentanément indisponible. Réessayez plus tard.',
      503,
    );
  return { part, object };
}
export async function deleteBackup(org: string, id: string) {
  const row = await stored(org, id);
  if (!row) throw new AccountPublicError('Sauvegarde introuvable.', 404);
  // Keep the tombstone to reject a late upload or a lost-acknowledgement replay.
  await database()
    .prepare(
      "UPDATE workspace_backups SET state='deleting' WHERE organization_id=? AND backup_id=? AND state<>'deleted'",
    )
    .bind(org, id)
    .run();
  const manifest = backupManifest(JSON.parse(row.manifest_json));
  await fileArchive().delete(
    manifest.chunks.map((_, index) => chunk(row, index).key),
  );
  await database()
    .prepare(
      "UPDATE workspace_backups SET state='deleted' WHERE organization_id=? AND backup_id=? AND state='deleting'",
    )
    .bind(org, id)
    .run();
  return { deleted: true };
}
