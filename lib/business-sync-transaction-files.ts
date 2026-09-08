import type { DeviceSessionContext } from './account';
import { AccountPublicError, sha256Hex } from './account-security';
import { businessFileHash } from './business-sync-files';
import {
  storedBlobPart,
  verifyStoredBlob,
  SYNC_BLOB_PART_BYTES,
  type StoredBlobPart,
} from './business-sync-blob-store';
import { requireBusinessTransaction } from './business-sync-transactions';
import { database, fileArchive } from './runtime';
import { readBytesBodyWithinLimit } from './request-body';

const active = `EXISTS(SELECT 1 FROM business_sync_transfers t JOIN business_sync_spaces s ON s.organization_id=t.organization_id AND s.generation=t.generation
 WHERE t.transfer_id=? AND t.organization_id=? AND t.installation_id=? AND t.generation=? AND t.manifest_sha256=? AND t.kind='transaction' AND t.state='received' AND s.state='ready' AND s.head_revision>=t.base_revision)`;
function fail(message: string, status = 409): never {
  throw new AccountPublicError(message, status);
}
async function required(
  session: DeviceSessionContext,
  id: unknown,
  rawSha: unknown,
) {
  const ctx = await requireBusinessTransaction(session, id),
    sha = businessFileHash(rawSha);
  if (ctx.row.state !== 'received')
    fail('La transaction complète doit être reçue avant ses documents.');
  const expected = ctx.manifest.files.find((f) => f.sha256 === sha);
  if (!expected) fail('Ce document ne figure pas dans cette transaction.', 404);
  const blob = await database()
    .prepare(
      'SELECT size_bytes,verified_at FROM business_sync_file_blobs WHERE transfer_id=? AND sha256=?',
    )
    .bind(ctx.id, sha)
    .first<{ size_bytes: number; verified_at: string | null }>();
  if (blob && blob.size_bytes !== expected.size_bytes)
    fail('La copie conservée du document est incohérente.', 503);
  return {
    ...ctx,
    sha,
    size: expected.size_bytes,
    verified: blob?.verified_at != null,
  };
}
type Context = Awaited<ReturnType<typeof required>>;
function key(ctx: Context, index: number) {
  return `business-sync/${ctx.manifest.organization_id}/transactions/${ctx.manifest.capture_generation}/${ctx.id}/files/${ctx.sha}/${index}`;
}
async function parts(ctx: Context) {
  return (
    await database()
      .prepare(
        'SELECT part_index,sha256,size_bytes,object_key FROM business_sync_file_parts WHERE transfer_id=? AND file_sha256=? ORDER BY part_index',
      )
      .bind(ctx.id, ctx.sha)
      .all<StoredBlobPart>()
  ).results;
}
export async function businessTransactionFileStatus(
  session: DeviceSessionContext,
  id: unknown,
  sha: unknown,
) {
  const ctx = await required(session, id, sha),
    received = await parts(ctx);
  for (const part of received) {
    if (
      !Number.isSafeInteger(part.part_index) ||
      part.part_index < 0 ||
      part.part_index >= Math.ceil(ctx.size / SYNC_BLOB_PART_BYTES) ||
      part.size_bytes !==
        Math.min(
          SYNC_BLOB_PART_BYTES,
          ctx.size - part.part_index * SYNC_BLOB_PART_BYTES,
        ) ||
      part.object_key !== key(ctx, part.part_index)
    )
      fail('Le reçu du document conservé est incohérent.', 503);
    businessFileHash(part.sha256);
  }
  if (
    ctx.verified &&
    received.length !== Math.ceil(ctx.size / SYNC_BLOB_PART_BYTES)
  )
    fail('La vérification conservée du document est incohérente.', 503);
  return {
    transaction_id: ctx.id,
    organization_id: session.organizationId,
    installation_id: session.installationId,
    generation: ctx.manifest.generation,
    capture_generation: ctx.manifest.capture_generation,
    manifest_sha256: ctx.row.manifest_sha256,
    sha256: ctx.sha,
    size_bytes: ctx.size,
    verified: ctx.verified,
    uploaded_parts: received.map(({ part_index, sha256, size_bytes }) => ({
      part_index,
      sha256,
      size_bytes,
    })),
    canonical_committed: false,
    replication_active: false,
  };
}
function registerBlob(ctx: Context) {
  return database()
    .prepare(
      `INSERT OR IGNORE INTO business_sync_file_blobs(transfer_id,sha256,size_bytes,verified_at) SELECT ?,?,?,NULL WHERE ${active}`,
    )
    .bind(ctx.id, ctx.sha, ctx.size, ...ctx.binding);
}
export async function uploadBusinessTransactionFilePart(
  session: DeviceSessionContext,
  id: unknown,
  sha: unknown,
  index: number,
  request: Request,
) {
  const ctx = await required(session, id, sha);
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= Math.ceil(ctx.size / SYNC_BLOB_PART_BYTES)
  )
    fail('Ce fragment ne figure pas dans le document.', 400);
  const size = Math.min(
      SYNC_BLOB_PART_BYTES,
      ctx.size - index * SYNC_BLOB_PART_BYTES,
    ),
    hash = businessFileHash(request.headers.get('x-content-sha256'));
  const bytes = await readBytesBodyWithinLimit(request, size);
  if (bytes.length !== size || (await sha256Hex(bytes)) !== hash)
    fail('Le fragment reçu est altéré.');
  const objectKey = key(ctx, index);
  const receipt = () =>
    database()
      .prepare(
        'SELECT part_index,sha256,size_bytes,object_key FROM business_sync_file_parts WHERE transfer_id=? AND file_sha256=? AND part_index=?',
      )
      .bind(ctx.id, ctx.sha, index)
      .first<StoredBlobPart>();
  const matches = (part: StoredBlobPart) =>
    part.sha256 === hash &&
    part.size_bytes === size &&
    part.object_key === objectKey;
  const old = await receipt();
  if (old && !matches(old))
    fail('Ce fragment a déjà été reçu avec un autre contenu.');
  if (!old && ctx.verified) fail('Ce document a déjà été vérifié.');
  if (!old) {
    const created = await fileArchive().put(objectKey, bytes, {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: 'application/octet-stream' },
    });
    if (!created) {
      const retained = await storedBlobPart(objectKey, size);
      if (retained.length !== size || (await sha256Hex(retained)) !== hash)
        fail('Un autre contenu occupe déjà ce fragment.');
    }
    await database().batch([
      registerBlob(ctx),
      database()
        .prepare(`INSERT OR IGNORE INTO business_sync_file_parts(transfer_id,file_sha256,part_index,sha256,size_bytes,object_key)
      SELECT ?,?,?,?,?,? WHERE ${active} AND EXISTS(SELECT 1 FROM business_sync_file_blobs WHERE transfer_id=? AND sha256=? AND size_bytes=? AND verified_at IS NULL)`)
        .bind(
          ctx.id,
          ctx.sha,
          index,
          hash,
          size,
          objectKey,
          ...ctx.binding,
          ctx.id,
          ctx.sha,
          ctx.size,
        ),
    ]);
    const saved = await receipt();
    if (!saved || !matches(saved))
      fail(
        'Le document a changé pendant l’envoi. Reprenez depuis la transaction d’origine.',
      );
  } else {
    const retained = await storedBlobPart(objectKey, size);
    if (retained.length !== size || (await sha256Hex(retained)) !== hash)
      fail('Le fragment conservé est altéré.');
  }
  return businessTransactionFileStatus(session, ctx.id, ctx.sha);
}
export async function verifyBusinessTransactionFile(
  session: DeviceSessionContext,
  id: unknown,
  sha: unknown,
) {
  const ctx = await required(session, id, sha);
  // Recheck the original bytes even on a repeated verification request.
  await verifyStoredBlob(await parts(ctx), ctx.size, ctx.sha, (index) =>
    key(ctx, index),
  );
  await database().batch([
    registerBlob(ctx),
    database()
      .prepare(
        `UPDATE business_sync_file_blobs SET verified_at=? WHERE transfer_id=? AND sha256=? AND size_bytes=? AND verified_at IS NULL AND ${active}`,
      )
      .bind(
        new Date().toISOString(),
        ctx.id,
        ctx.sha,
        ctx.size,
        ...ctx.binding,
      ),
  ]);
  const result = await businessTransactionFileStatus(session, ctx.id, ctx.sha);
  if (!result.verified) fail('La vérification du document doit être reprise.');
  return result;
}
