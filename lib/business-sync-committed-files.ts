import type { DeviceSessionContext } from './account';
import { AccountPublicError, sha256Hex } from './account-security';
import { businessFileHash } from './business-sync-files';
import { committedBusinessTransaction } from './business-sync-transaction-commit';
import {
  storedBlobPart,
  SYNC_BLOB_PART_BYTES,
  type StoredBlobPart,
} from './business-sync-blob-store';
import { database } from './runtime';

function fail(message: string, status = 503): never {
  throw new AccountPublicError(message, status);
}
/** Only files bound to this immutable committed manifest are downloadable. */
export async function committedBusinessTransactionFile(
  session: DeviceSessionContext,
  id: unknown,
  rawSha: unknown,
  rawPart: unknown,
) {
  const sha = businessFileHash(rawSha);
  const saved = await committedBusinessTransaction(session, id);
  if (!saved) fail('Cette révision enregistrée est introuvable.', 404);
  const file = saved.manifest.files.find((f) => f.sha256 === sha);
  if (!file) fail('Ce document ne figure pas dans cette révision.', 404);
  const db = database();
  const verified = await db
    .prepare(
      'SELECT size_bytes,verified_at FROM business_sync_file_blobs WHERE transfer_id=? AND sha256=?',
    )
    .bind(saved.receipt.transaction_id, sha)
    .first<{ size_bytes: number; verified_at: string | null }>();
  if (!verified?.verified_at || verified.size_bytes !== file.size_bytes)
    fail('La preuve du document enregistré est incohérente.');
  const parts = (
    await db
      .prepare(
        'SELECT part_index,sha256,size_bytes,object_key FROM business_sync_file_parts WHERE transfer_id=? AND file_sha256=? ORDER BY part_index LIMIT 129',
      )
      .bind(saved.receipt.transaction_id, sha)
      .all<StoredBlobPart>()
  ).results;
  if (parts.length !== Math.ceil(file.size_bytes / SYNC_BLOB_PART_BYTES))
    fail('Le document enregistré est incomplet.');
  for (const [i, p] of parts.entries()) {
    const key = `business-sync/${saved.receipt.organization_id}/transactions/${saved.receipt.capture_generation}/${saved.receipt.transaction_id}/files/${sha}/${i}`;
    if (
      p.part_index !== i ||
      p.size_bytes !==
        Math.min(
          SYNC_BLOB_PART_BYTES,
          file.size_bytes - i * SYNC_BLOB_PART_BYTES,
        ) ||
      typeof p.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(p.sha256) ||
      p.object_key !== key
    )
      fail('Un fragment enregistré ne correspond pas à ce document.');
  }
  let bytes: Uint8Array, contentType: string;
  if (rawPart === null) {
    bytes = new TextEncoder().encode(
      JSON.stringify({
        format: 'zentra-canonical-file',
        version: 1,
        transaction_id: saved.receipt.transaction_id,
        organization_id: saved.receipt.organization_id,
        generation: saved.receipt.generation,
        sha256: sha,
        size_bytes: file.size_bytes,
        part_bytes: SYNC_BLOB_PART_BYTES,
        parts: parts.map(({ part_index, sha256, size_bytes }) => ({
          part_index,
          sha256,
          size_bytes,
        })),
      }),
    );
    contentType = 'application/json';
  } else {
    if (typeof rawPart !== 'string' || !/^(0|[1-9][0-9]{0,2})$/.test(rawPart))
      fail('Le fragment demandé est invalide.', 400);
    const part = parts[Number(rawPart)];
    if (!part) fail('Ce fragment ne figure pas dans le document.', 404);
    bytes = await storedBlobPart(part.object_key, part.size_bytes);
    if (
      bytes.length !== part.size_bytes ||
      (await sha256Hex(bytes)) !== part.sha256
    )
      fail('Le fragment du document est altéré.');
    contentType = 'application/octet-stream';
  }
  const current = await db
    .prepare(`SELECT 1 FROM business_sync_transaction_commits c JOIN business_sync_spaces s ON s.organization_id=c.organization_id AND s.generation=c.generation
    WHERE c.transfer_id=? AND c.organization_id=? AND c.receipt_sha256=? AND s.state='ready' AND s.head_revision>=c.revision`)
    .bind(
      saved.receipt.transaction_id,
      session.organizationId,
      saved.receipt_sha256,
    )
    .first();
  if (!current) fail('La génération du dossier a changé.', 409);
  return {
    bytes,
    contentType,
    sha256: await sha256Hex(bytes),
    receipt_sha256: saved.receipt_sha256,
    bundle_sha256: saved.receipt.bundle_sha256,
  };
}
