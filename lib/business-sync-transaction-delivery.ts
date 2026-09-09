import type { DeviceSessionContext } from './account';
import { AccountPublicError, sha256Hex } from './account-security';
import {
  completedTransactionFingerprint,
  completedTransactionFingerprintGateSql,
} from './business-sync-transaction-fingerprint';
import {
  readBusinessTransactionChunk,
  readBusinessTransactionChunkBytes,
} from './business-sync-transaction-chunk';
import { sourceRowid } from './business-sync-order';
import { storedBlobPart } from './business-sync-blob-store';
import { fileArchive } from './runtime';

export const DELIVERY_VERSION = 1,
  DELIVERY_POSITIONS_BYTES = 512 * 1024,
  DELIVERY_MANIFEST_BYTES = 512 * 1024;
type Context = Awaited<ReturnType<typeof completedTransactionFingerprint>>;
type Part = {
  attempt: string;
  validator_sha256: string;
  algorithm_version: number;
  part_index: number;
  source_sha256: string;
  positions_sha256: string;
  positions_bytes: number;
  change_count: number;
  object_key: string;
};
function fail(
  message = 'La préparation de réception est absente, altérée ou remplacée.',
  status = 409,
): never {
  throw new AccountPublicError(message, status);
}
function key(ctx: Context, index: number, hash: string) {
  return `business-sync/${ctx.manifest.organization_id}/canonical/${ctx.manifest.generation}/${ctx.id}/${ctx.review.attempt}/positions/${index}-${hash}.json`;
}
async function current(ctx: Context) {
  return !!(await ctx.db
    .prepare(`SELECT 1 WHERE ${completedTransactionFingerprintGateSql}`)
    .bind(...ctx.fingerprintBindings)
    .first());
}
async function parts(ctx: Context) {
  const rows = (
    await ctx.db
      .prepare(
        'SELECT * FROM business_sync_transaction_delivery_parts WHERE transfer_id=? ORDER BY part_index LIMIT 1025',
      )
      .bind(ctx.id)
      .all<Part>()
  ).results;
  if (rows.length > ctx.manifest.chunks.length) fail();
  for (const [i, p] of rows.entries()) {
    const original = ctx.manifest.chunks[i];
    if (
      p.attempt !== ctx.review.attempt ||
      p.validator_sha256 !== ctx.validator ||
      p.algorithm_version !== DELIVERY_VERSION ||
      p.part_index !== i ||
      p.source_sha256 !== original.sha256 ||
      p.change_count !== original.change_count ||
      !/^[a-f0-9]{64}$/.test(p.positions_sha256) ||
      !Number.isSafeInteger(p.positions_bytes) ||
      p.positions_bytes < 1 ||
      p.positions_bytes > DELIVERY_POSITIONS_BYTES ||
      p.object_key !== key(ctx, i, p.positions_sha256)
    )
      fail();
  }
  return rows;
}
function descriptor(ctx: Context, rows: Part[]) {
  if (rows.length !== ctx.manifest.chunks.length)
    fail('La réception comporte encore des fragments à préparer.');
  const raw = JSON.stringify({
    format: 'zentra-canonical-transaction-bundle',
    version: DELIVERY_VERSION,
    schema_version: ctx.manifest.schema_version,
    contract_sha256: ctx.manifest.contract_sha256,
    organization_id: ctx.manifest.organization_id,
    origin_installation_id: ctx.manifest.installation_id,
    generation: ctx.manifest.generation,
    capture_generation: ctx.manifest.capture_generation,
    transaction_id: ctx.id,
    source_transfer_id: ctx.review.source_transfer_id,
    source_revision: ctx.review.source_revision,
    original_manifest_sha256: ctx.row.manifest_sha256,
    review_attempt: ctx.review.attempt,
    review_validator_sha256: ctx.review.validator_sha256,
    validation_sha256: ctx.validator,
    fingerprint_version: ctx.fingerprint.algorithm_version,
    fingerprint_contract_sha256: ctx.fingerprintContractHash,
    source_state_sha256: ctx.fingerprint.source_sha256,
    target_state_sha256: ctx.fingerprint.target_sha256,
    source_rows: ctx.fingerprint.source_rows,
    target_rows: ctx.fingerprint.rows,
    parts: rows.map((p, i) => ({
      source_sha256: p.source_sha256,
      source_bytes: ctx.manifest.chunks[i].size_bytes,
      positions_sha256: p.positions_sha256,
      positions_bytes: p.positions_bytes,
      change_count: p.change_count,
    })),
  });
  if (new TextEncoder().encode(raw).length > DELIVERY_MANIFEST_BYTES)
    fail('Le descriptif de réception dépasse la limite autorisée.', 503);
  return raw;
}
async function response(ctx: Context) {
  const rows = await parts(ctx),
    ready = rows.length === ctx.manifest.chunks.length;
  const raw = ready ? descriptor(ctx, rows) : null,
    active = await current(ctx);
  return {
    transaction_id: ctx.id,
    organization_id: ctx.manifest.organization_id,
    installation_id: ctx.manifest.installation_id,
    generation: ctx.manifest.generation,
    attempt: ctx.review.attempt,
    source_revision: ctx.review.source_revision,
    prepared_parts: rows.length,
    total_parts: ctx.manifest.chunks.length,
    state: !active ? 'stale' : ready ? 'prepared' : 'preparing',
    bundle_sha256: active && raw ? await sha256Hex(raw) : null,
    canonical_committed: false,
    replication_active: false,
  };
}
export async function businessTransactionDeliveryStatus(
  session: DeviceSessionContext,
  id: unknown,
) {
  return response(await completedTransactionFingerprint(session, id));
}
export async function prepareBusinessTransactionDelivery(
  session: DeviceSessionContext,
  id: unknown,
) {
  const ctx = await completedTransactionFingerprint(session, id),
    existing = await parts(ctx),
    index = existing.length;
  if (index === ctx.manifest.chunks.length) return response(ctx);
  const original = ctx.manifest.chunks[index],
    changes = await readBusinessTransactionChunk(ctx.id, ctx.manifest, index);
  const positions = (
    await ctx.db
      .prepare(
        'SELECT change_index,table_name,row_key_json,canonical_rowid FROM business_sync_transaction_canonical_order WHERE transfer_id=? AND attempt=? AND part_index=? ORDER BY change_index LIMIT 201',
      )
      .bind(ctx.id, ctx.review.attempt, index)
      .all<{
        change_index: number;
        table_name: string;
        row_key_json: string;
        canonical_rowid: string;
      }>()
  ).results;
  if (positions.length !== changes.length)
    fail('Des positions canoniques manquent dans cette réception.', 503);
  for (const [i, p] of positions.entries()) {
    if (
      p.change_index !== i ||
      p.table_name !== changes[i].table ||
      p.row_key_json !== changes[i].key_json
    )
      fail(
        'Une position canonique ne correspond plus au fragment original.',
        503,
      );
    sourceRowid(p.canonical_rowid, p.table_name, {});
  }
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      version: DELIVERY_VERSION,
      part_index: index,
      source_sha256: original.sha256,
      positions: positions.map((p) => ({
        table: p.table_name,
        key_json: p.row_key_json,
        canonical_rowid: p.canonical_rowid,
      })),
    }),
  );
  if (bytes.length > DELIVERY_POSITIONS_BYTES)
    fail('Les positions canoniques dépassent la limite de réception.', 503);
  const hash = await sha256Hex(bytes),
    objectKey = key(ctx, index, hash);
  if (!(await current(ctx))) return response(ctx);
  await fileArchive().put(objectKey, bytes, {
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { sha256: hash },
  });
  // R2 and D1 are separate stores. A lost write response is safe to retry; only
  // a verified immutable object can gain a guarded database receipt.
  const stored = await storedBlobPart(objectKey, bytes.length);
  if (stored.length !== bytes.length || (await sha256Hex(stored)) !== hash)
    fail(
      'Les positions conservées ne correspondent pas à leur empreinte.',
      503,
    );
  await ctx.db
    .prepare(`INSERT OR IGNORE INTO business_sync_transaction_delivery_parts
    (transfer_id,attempt,validator_sha256,algorithm_version,part_index,source_sha256,positions_sha256,positions_bytes,change_count,object_key)
    SELECT ?1,?6,?15,${DELIVERY_VERSION},?19,?20,?21,?22,?23,?24 WHERE ${completedTransactionFingerprintGateSql}
    AND (SELECT COUNT(*) FROM business_sync_transaction_delivery_parts WHERE transfer_id=?1)=?19`)
    .bind(
      ...ctx.fingerprintBindings,
      index,
      original.sha256,
      hash,
      bytes.length,
      changes.length,
      objectKey,
    )
    .run();
  return response(ctx);
}
export async function businessTransactionDeliveryResource(
  session: DeviceSessionContext,
  id: unknown,
  resource: unknown,
  rawIndex: unknown,
) {
  const ctx = await completedTransactionFingerprint(session, id),
    rows = await parts(ctx);
  const manifest = descriptor(ctx, rows);
  let bytes: Uint8Array;
  if (resource === 'bundle') bytes = new TextEncoder().encode(manifest);
  else if (resource === 'manifest')
    bytes = new TextEncoder().encode(ctx.row.manifest_json);
  else {
    if (
      !['changes', 'positions'].includes(String(resource)) ||
      typeof rawIndex !== 'string' ||
      !/^(0|[1-9][0-9]{0,3})$/.test(rawIndex)
    )
      fail('Le fragment demandé est invalide.', 400);
    const index = Number(rawIndex),
      part = rows[index];
    if (!part) fail('Le fragment demandé est absent.', 404);
    if (resource === 'changes')
      bytes = await readBusinessTransactionChunkBytes(
        ctx.id,
        ctx.manifest,
        index,
      );
    else {
      bytes = await storedBlobPart(part.object_key, part.positions_bytes);
      if (
        bytes.length !== part.positions_bytes ||
        (await sha256Hex(bytes)) !== part.positions_sha256
      )
        fail('Les positions conservées sont altérées.', 503);
    }
  }
  if (!(await current(ctx)))
    fail('La révision partagée a changé pendant la lecture.');
  return {
    bytes,
    sha256: await sha256Hex(bytes),
    bundle_sha256: await sha256Hex(manifest),
  };
}
