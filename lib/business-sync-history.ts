import type { DeviceSessionContext } from './account';
import { AccountPublicError, sha256Hex } from './account-security';
import {
  businessCatalogueKey,
  businessFileHash,
  BUSINESS_FILE_PART_BYTES,
} from './business-sync-files';
import { publishedHistory } from './business-sync-publication';
import { database, fileArchive } from './runtime';
function fail(message: string, status = 409): never {
  throw new AccountPublicError(message, status);
}
async function required(session: DeviceSessionContext, id: unknown) {
  const history = await publishedHistory(session, id);
  if (!history) fail('L’historique partagé n’est pas encore disponible.', 404);
  return history;
}
function index(value: unknown, max: number) {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]{0,3})$/.test(value) ||
    Number(value) > max
  )
    fail('Numéro de fragment invalide.', 400);
  return Number(value);
}
async function verifiedBytes(
  key: string,
  size: number,
  sha: string,
  max: number,
) {
  if (!Number.isSafeInteger(size) || size <= 0 || size > max)
    fail('Les métadonnées du fragment sont incohérentes.', 503);
  const blob = await fileArchive().get(key);
  if (!blob || blob.size !== size)
    fail('Le fragment est temporairement indisponible ou altéré.', 503);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length !== size || (await sha256Hex(bytes)) !== sha)
    fail('Le fragment ne correspond plus à son empreinte.', 503);
  return { bytes, sha256: sha };
}
export async function historyHead(session: DeviceSessionContext) {
  const h = await publishedHistory(session);
  return h
    ? {
        state: 'published',
        head_revision: h.head_revision,
        receipt: h.receipt,
        manifest_json: h.manifest_json,
        files_manifest_json: h.files_manifest_json,
      }
    : { state: 'uninitialized', head_revision: 0 };
}
// Original bytes let a receiving device check the exact manifest hashes.
export async function historyChunk(
  session: DeviceSessionContext,
  id: unknown,
  rawIndex: unknown,
) {
  const h = await required(session, id),
    part = index(rawIndex, 1023);
  const row = await database()
    .prepare(
      'SELECT sha256,size_bytes,object_key FROM business_sync_transfer_chunks WHERE transfer_id=? AND chunk_index=?',
    )
    .bind(h.receipt.transfer_id, part)
    .first<{ sha256: string; size_bytes: number; object_key: string }>();
  if (!row)
    fail('Ce fragment de données ne figure pas dans l’historique.', 404);
  const expected = JSON.parse(h.manifest_json).chunks[part];
  const key = `business-sync/${session.organizationId}/${h.receipt.transfer_id}/${part}-${row.sha256}.json`;
  if (
    !expected ||
    row.sha256 !== expected.sha256 ||
    row.size_bytes !== expected.size_bytes ||
    row.object_key !== key
  )
    fail('Le fragment de données ne correspond pas au manifeste publié.', 503);
  return verifiedBytes(key, row.size_bytes, row.sha256, 4 * 1024 * 1024);
}
export async function historyFilePage(
  session: DeviceSessionContext,
  id: unknown,
  rawIndex: unknown,
) {
  const h = await required(session, id),
    part = index(rawIndex, 249);
  const row = await database()
    .prepare(
      'SELECT sha256,size_bytes FROM business_sync_file_pages WHERE transfer_id=? AND page_index=?',
    )
    .bind(h.receipt.transfer_id, part)
    .first<{ sha256: string; size_bytes: number }>();
  if (!row)
    fail('Cette page de documents ne figure pas dans l’historique.', 404);
  const expected = JSON.parse(h.files_manifest_json).pages[part];
  if (
    !expected ||
    row.sha256 !== expected.sha256 ||
    row.size_bytes !== expected.size_bytes
  )
    fail('Le catalogue ne correspond pas au manifeste publié.', 503);
  return verifiedBytes(
    businessCatalogueKey(
      session.organizationId,
      h.receipt.transfer_id,
      row.sha256,
      part,
    ),
    row.size_bytes,
    row.sha256,
    512 * 1024,
  );
}
export async function historyFilePart(
  session: DeviceSessionContext,
  id: unknown,
  rawSha: unknown,
  rawPart: unknown,
) {
  const h = await required(session, id),
    sha = businessFileHash(rawSha),
    part = index(rawPart, 127);
  const stored = await database()
    .prepare(`SELECT p.sha256,p.size_bytes,p.object_key,b.size_bytes total_bytes
    FROM business_sync_file_parts p JOIN business_sync_file_blobs b ON b.transfer_id=p.transfer_id AND b.sha256=p.file_sha256
    WHERE p.transfer_id=? AND p.file_sha256=? AND p.part_index=? AND b.verified_at IS NOT NULL
    AND EXISTS(SELECT 1 FROM business_sync_file_entries e WHERE e.transfer_id=p.transfer_id AND e.sha256=b.sha256 AND e.size_bytes=b.size_bytes)`)
    .bind(h.receipt.transfer_id, sha, part)
    .first<{
      sha256: string;
      size_bytes: number;
      object_key: string;
      total_bytes: number;
    }>();
  if (!stored)
    fail('Ce fragment ne fait pas partie de l’historique publié.', 404);
  const expectedKey = `business-sync/${session.organizationId}/${h.receipt.transfer_id}/files/${sha}/${part}`;
  const expectedSize = Math.min(
    BUSINESS_FILE_PART_BYTES,
    stored.total_bytes - part * BUSINESS_FILE_PART_BYTES,
  );
  if (stored.object_key !== expectedKey || stored.size_bytes !== expectedSize)
    fail('Les métadonnées de ce document sont incohérentes.', 503);
  return verifiedBytes(
    expectedKey,
    stored.size_bytes,
    stored.sha256,
    BUSINESS_FILE_PART_BYTES,
  );
}
