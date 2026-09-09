import type { DeviceSessionContext } from './account';
import { AccountPublicError, sha256Hex } from './account-security';
import { businessSyncTransferId } from './business-sync-bootstrap';
import {
  preparedBusinessTransactionDelivery,
  DELIVERY_VERSION,
  DELIVERY_MANIFEST_BYTES,
  DELIVERY_POSITIONS_BYTES,
} from './business-sync-transaction-delivery';
import { completedTransactionFingerprintGateSql } from './business-sync-transaction-fingerprint';
import { database } from './runtime';
import { transactionManifest } from './business-sync-transaction-format';
import { readBusinessTransactionChunkBytes } from './business-sync-transaction-chunk';
import { storedBlobPart } from './business-sync-blob-store';
import { transactionAuditAnchorSql } from './business-sync-transaction-review';

/** An immutable server record transported over authenticated HTTPS, not an Ed25519 token. */
export type CanonicalTransactionReceipt = {
  format: 'zentra-canonical-transaction-receipt';
  version: 1;
  transaction_id: string;
  organization_id: string;
  generation: string;
  origin_installation_id: string;
  capture_generation: string;
  source_transfer_id: string;
  source_revision: number;
  revision: number;
  manifest_sha256: string;
  bundle_sha256: string;
  fingerprint_version: number;
  fingerprint_contract_sha256: string;
  source_state_sha256: string;
  target_state_sha256: string;
  validation_sha256: string;
  committed_at: string;
};
function fail(
  message = 'La révision ou les preuves de cette opération ont changé.',
  status = 409,
): never {
  throw new AccountPublicError(message, status);
}
// The completed review pins the current head. Only this atomic commit can move
// a capture branch; no later or overlapping sequence may replace its anchor.
const branchEligible = `EXISTS(SELECT 1 FROM business_sync_audit_branches b
 WHERE b.organization_id=?2 AND b.generation=?4 AND b.installation_id=?3 AND b.capture_generation=?25
 AND b.revision<=?8 AND CAST(b.last_sequence AS INTEGER)<CAST(?30 AS INTEGER))
 OR NOT EXISTS(SELECT 1 FROM business_sync_audit_branches b WHERE b.organization_id=?2 AND b.generation=?4 AND b.installation_id=?3 AND b.capture_generation=?25)`;
const eligible = `NOT EXISTS(SELECT 1 FROM business_sync_transaction_conflicts WHERE transfer_id=?1 AND attempt=?6)
 AND (SELECT COUNT(*) FROM business_sync_transaction_delivery_parts WHERE transfer_id=?1)=json_array_length(?20,'$.parts')
 AND NOT EXISTS(SELECT 1 FROM json_each(?20,'$.parts') j LEFT JOIN business_sync_transaction_delivery_parts p
 ON p.transfer_id=?1 AND p.part_index=j.key WHERE p.transfer_id IS NULL OR p.attempt<>?6 OR p.validator_sha256<>?15 OR p.algorithm_version<>${DELIVERY_VERSION}
 OR p.source_sha256<>json_extract(j.value,'$.source_sha256') OR p.positions_sha256<>json_extract(j.value,'$.positions_sha256')
 OR p.positions_bytes<>json_extract(j.value,'$.positions_bytes') OR p.change_count<>json_extract(j.value,'$.change_count'))
 AND NOT EXISTS(SELECT 1 FROM business_sync_transfers t JOIN json_each(t.manifest_json,'$.files') f WHERE t.transfer_id=?1
 AND NOT EXISTS(SELECT 1 FROM business_sync_file_blobs b WHERE b.transfer_id=t.transfer_id AND b.sha256=json_extract(f.value,'$.sha256') AND b.size_bytes=json_extract(f.value,'$.size_bytes') AND b.verified_at IS NOT NULL))
 AND (${branchEligible})
 AND NOT EXISTS(SELECT 1 FROM business_sync_retirements x WHERE x.organization_id=?2 AND x.generation=?4 AND x.installation_id=?3 AND x.capture_generation=?25
 AND CAST(x.first_sequence AS INTEGER)<=CAST(?26 AS INTEGER) AND CAST(x.last_sequence AS INTEGER)>=CAST(?30 AS INTEGER))
 AND EXISTS(SELECT 1 FROM business_sync_transfers t JOIN business_sync_transfers u ON u.organization_id=t.organization_id AND u.generation=t.generation
 AND u.revision=json_extract(t.manifest_json,'$.base_revision') AND u.state='committed'
 WHERE t.transfer_id=?1 AND ${transactionAuditAnchorSql} IS ?27)`;
const ours = `SELECT 1 FROM business_sync_transaction_commits c JOIN business_sync_transfers t ON t.transfer_id=c.transfer_id
 JOIN business_sync_spaces s ON s.organization_id=c.organization_id AND s.generation=c.generation
 WHERE c.transfer_id=?1 AND c.organization_id=?2 AND c.generation=?4 AND c.source_revision=?8 AND c.revision=?23 AND c.receipt_sha256=?22
 AND t.organization_id=c.organization_id AND t.installation_id=?3 AND t.kind='transaction' AND t.state='received' AND t.revision IS NULL
 AND t.generation=c.generation AND t.manifest_sha256=?5 AND s.state='ready' AND s.head_revision=?8`;

type Stored = {
  transfer_id: string;
  organization_id: string;
  generation: string;
  source_transfer_id: string;
  source_revision: number;
  revision: number;
  bundle_json: string;
  bundle_sha256: string;
  receipt_json: string;
  receipt_sha256: string;
  committed_at: string;
  installation_id: string;
  manifest_sha256: string;
  transfer_committed_at: string;
  manifest_json: string;
};
function storedObject(raw: string) {
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw Error('object');
    return value;
  } catch {
    fail('Le descriptif enregistré est illisible.', 503);
  }
}
/** Readers pin this committed receipt, even after another revision becomes head. */
export async function committedBusinessTransaction(
  session: DeviceSessionContext,
  rawId: unknown,
) {
  const id = businessSyncTransferId(rawId);
  const row = await database()
    .prepare(`SELECT c.*,t.installation_id,t.manifest_sha256,t.manifest_json,t.committed_at transfer_committed_at
    FROM business_sync_transaction_commits c JOIN business_sync_transfers t ON t.transfer_id=c.transfer_id
    JOIN business_sync_spaces s ON s.organization_id=c.organization_id AND s.generation=c.generation
    WHERE c.transfer_id=? AND c.organization_id=? AND t.organization_id=c.organization_id AND t.generation=c.generation
    AND t.kind='transaction' AND t.state='committed' AND t.revision=c.revision AND s.state='ready' AND s.head_revision>=c.revision`)
    .bind(id, session.organizationId)
    .first<Stored>();
  if (!row) return null;
  if (
    new TextEncoder().encode(row.receipt_json).length > 16 * 1024 ||
    new TextEncoder().encode(row.bundle_json).length >
      DELIVERY_MANIFEST_BYTES ||
    (await sha256Hex(row.receipt_json)) !== row.receipt_sha256 ||
    (await sha256Hex(row.bundle_json)) !== row.bundle_sha256 ||
    (await sha256Hex(row.manifest_json)) !== row.manifest_sha256
  )
    fail('Le reçu conservé ne correspond plus à ses empreintes.', 503);
  const receipt: CanonicalTransactionReceipt = storedObject(row.receipt_json);
  const bundle = storedObject(row.bundle_json);
  const manifest = await transactionManifest(row.manifest_json).catch(() =>
    fail('Le manifeste enregistré est illisible.', 503),
  );
  if (
    !receipt ||
    Object.keys(receipt).length !== 18 ||
    receipt.format !== 'zentra-canonical-transaction-receipt' ||
    receipt.version !== 1 ||
    receipt.fingerprint_version !== 2 ||
    ![
      receipt.manifest_sha256,
      receipt.bundle_sha256,
      receipt.fingerprint_contract_sha256,
      receipt.source_state_sha256,
      receipt.target_state_sha256,
      receipt.validation_sha256,
    ].every((h) => typeof h === 'string' && /^[a-f0-9]{64}$/.test(h)) ||
    receipt.transaction_id !== id ||
    receipt.organization_id !== session.organizationId ||
    receipt.generation !== row.generation ||
    receipt.origin_installation_id !== row.installation_id ||
    receipt.source_transfer_id !== row.source_transfer_id ||
    receipt.source_revision !== row.source_revision ||
    receipt.revision !== row.revision ||
    !Number.isSafeInteger(row.revision) ||
    row.source_revision < 1 ||
    row.revision !== row.source_revision + 1 ||
    receipt.manifest_sha256 !== row.manifest_sha256 ||
    receipt.bundle_sha256 !== row.bundle_sha256 ||
    receipt.committed_at !== row.committed_at ||
    !Number.isFinite(Date.parse(row.committed_at)) ||
    new Date(row.committed_at).toISOString() !== row.committed_at ||
    row.transfer_committed_at !== row.committed_at ||
    manifest.transaction_id !== id ||
    manifest.organization_id !== receipt.organization_id ||
    manifest.generation !== receipt.generation ||
    manifest.installation_id !== receipt.origin_installation_id ||
    manifest.capture_generation !== receipt.capture_generation ||
    !bundle ||
    bundle.format !== 'zentra-canonical-transaction-bundle' ||
    bundle.version !== DELIVERY_VERSION ||
    bundle.schema_version !== manifest.schema_version ||
    bundle.contract_sha256 !== manifest.contract_sha256 ||
    typeof bundle.review_attempt !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      bundle.review_attempt,
    ) ||
    typeof bundle.review_validator_sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(bundle.review_validator_sha256) ||
    !Array.isArray(bundle.parts) ||
    bundle.parts.length !== manifest.chunks.length ||
    !bundle.parts.every((p: Record<string, unknown> | null, i: number) => {
      const source = manifest.chunks[i];
      return (
        p &&
        p.source_sha256 === source.sha256 &&
        p.source_bytes === source.size_bytes &&
        p.change_count === source.change_count &&
        typeof p.positions_bytes === 'number' &&
        Number.isSafeInteger(p.positions_bytes) &&
        p.positions_bytes > 0 &&
        p.positions_bytes <= DELIVERY_POSITIONS_BYTES &&
        typeof p.positions_sha256 === 'string' &&
        /^[a-f0-9]{64}$/.test(p.positions_sha256)
      );
    }) ||
    bundle.transaction_id !== id ||
    bundle.organization_id !== receipt.organization_id ||
    bundle.generation !== receipt.generation ||
    bundle.origin_installation_id !== receipt.origin_installation_id ||
    bundle.capture_generation !== receipt.capture_generation ||
    bundle.original_manifest_sha256 !== receipt.manifest_sha256 ||
    bundle.source_transfer_id !== receipt.source_transfer_id ||
    bundle.source_revision !== receipt.source_revision ||
    bundle.fingerprint_version !== receipt.fingerprint_version ||
    bundle.fingerprint_contract_sha256 !==
      receipt.fingerprint_contract_sha256 ||
    bundle.source_state_sha256 !== receipt.source_state_sha256 ||
    bundle.target_state_sha256 !== receipt.target_state_sha256 ||
    bundle.validation_sha256 !== receipt.validation_sha256
  )
    fail('Le reçu de la révision partagée est incohérent.', 503);
  return {
    receipt,
    receipt_sha256: row.receipt_sha256,
    bundle_json: row.bundle_json,
    receipt_json: row.receipt_json,
    manifest_json: row.manifest_json,
    manifest,
  };
}

export async function committedBusinessTransactionResource(
  session: DeviceSessionContext,
  id: unknown,
  resource: unknown,
  rawIndex: unknown,
) {
  const saved = await committedBusinessTransaction(session, id);
  if (!saved) fail('Cette révision enregistrée est introuvable.', 404);
  let bytes: Uint8Array;
  if (resource === 'receipt')
    bytes = new TextEncoder().encode(saved.receipt_json);
  else if (resource === 'bundle')
    bytes = new TextEncoder().encode(saved.bundle_json);
  else if (resource === 'manifest')
    bytes = new TextEncoder().encode(saved.manifest_json);
  else {
    if (
      !['changes', 'positions'].includes(String(resource)) ||
      typeof rawIndex !== 'string' ||
      !/^(0|[1-9][0-9]{0,3})$/.test(rawIndex)
    )
      fail('Le fragment demandé est invalide.', 400);
    const index = Number(rawIndex),
      bundle = JSON.parse(saved.bundle_json),
      part = bundle.parts[index];
    if (!part) fail('Le fragment demandé est absent.', 404);
    if (resource === 'changes')
      bytes = await readBusinessTransactionChunkBytes(
        saved.receipt.transaction_id,
        saved.manifest,
        index,
      );
    else {
      if (
        !Number.isSafeInteger(part.positions_bytes) ||
        part.positions_bytes < 1 ||
        part.positions_bytes > 512 * 1024 ||
        !/^[a-f0-9]{64}$/.test(part.positions_sha256)
      )
        fail('La référence du fragment est altérée.', 503);
      const key = `business-sync/${saved.receipt.organization_id}/canonical/${saved.receipt.generation}/${saved.receipt.transaction_id}/${bundle.review_attempt}/positions/${index}-${part.positions_sha256}.json`;
      bytes = await storedBlobPart(key, part.positions_bytes);
      if (
        bytes.length !== part.positions_bytes ||
        (await sha256Hex(bytes)) !== part.positions_sha256
      )
        fail('Le fragment enregistré est altéré.', 503);
    }
  }
  const current = await database()
    .prepare(`SELECT 1 FROM business_sync_transaction_commits c JOIN business_sync_spaces s ON s.organization_id=c.organization_id AND s.generation=c.generation
    WHERE c.transfer_id=? AND c.organization_id=? AND c.receipt_sha256=? AND s.state='ready' AND s.head_revision>=c.revision`)
    .bind(
      saved.receipt.transaction_id,
      session.organizationId,
      saved.receipt_sha256,
    )
    .first();
  if (!current) fail();
  return {
    bytes,
    sha256: await sha256Hex(bytes),
    receipt_sha256: saved.receipt_sha256,
    bundle_sha256: saved.receipt.bundle_sha256,
  };
}

export async function committedBusinessTransactionsSince(
  session: DeviceSessionContext,
  rawGeneration: unknown,
  rawAfter: unknown,
) {
  const generation = businessSyncTransferId(rawGeneration);
  if (
    typeof rawAfter !== 'string' ||
    !/^[1-9][0-9]{0,15}$/.test(rawAfter) ||
    !Number.isSafeInteger(Number(rawAfter))
  )
    fail('La révision de départ est invalide.', 400);
  const after = Number(rawAfter),
    db = database();
  const space = await db
    .prepare(
      "SELECT head_revision FROM business_sync_spaces WHERE organization_id=? AND generation=? AND state='ready'",
    )
    .bind(session.organizationId, generation)
    .first<{ head_revision: number }>();
  if (!space) fail('Cet historique partagé est indisponible.', 404);
  if (after > space.head_revision)
    fail('La révision locale dépasse cet historique.');
  const rows = (
    await db
      .prepare(`SELECT c.transfer_id transaction_id,c.source_revision,c.revision,c.bundle_sha256,c.receipt_sha256,t.installation_id origin_installation_id
    FROM business_sync_transaction_commits c JOIN business_sync_transfers t ON t.transfer_id=c.transfer_id
    WHERE c.organization_id=? AND c.generation=? AND c.revision>? AND c.revision<=?
    AND t.organization_id=c.organization_id AND t.generation=c.generation AND t.state='committed' AND t.revision=c.revision ORDER BY c.revision LIMIT 20`)
      .bind(session.organizationId, generation, after, space.head_revision)
      .all<{
        transaction_id: string;
        source_revision: number;
        revision: number;
        bundle_sha256: string;
        receipt_sha256: string;
        origin_installation_id: string;
      }>()
  ).results;
  if (
    rows.length !== Math.min(20, space.head_revision - after) ||
    rows.some(
      (r, i) =>
        r.revision !== after + i + 1 || r.source_revision !== r.revision - 1,
    )
  )
    fail('L’historique comporte une révision manquante.', 503);
  return {
    organization_id: session.organizationId,
    generation,
    head_revision: space.head_revision,
    commits: rows,
    next_revision: rows.at(-1)?.revision ?? after,
    has_more: after + rows.length < space.head_revision,
  };
}

/** Internal commit primitive. Client activation still requires the complete receive/install/ack journey. */
export async function commitBusinessTransaction(
  session: DeviceSessionContext,
  rawId: unknown,
) {
  if (!['owner', 'admin', 'member', 'accountant'].includes(session.role))
    fail('Ce compte ne peut pas enregistrer de modifications métier.', 403);
  const id = businessSyncTransferId(rawId);
  const owned = (
    saved: NonNullable<
      Awaited<ReturnType<typeof committedBusinessTransaction>>
    >,
  ) => {
    if (saved.receipt.origin_installation_id !== session.installationId)
      fail('Cette opération appartient à un autre appareil.', 403);
    return saved.receipt;
  };
  try {
    const existing = await committedBusinessTransaction(session, id);
    if (existing) return owned(existing);
    const { ctx, bundle, bundleSha256 } =
      await preparedBusinessTransactionDelivery(session, id);
    const revision = ctx.review.source_revision + 1;
    if (!Number.isSafeInteger(revision))
      fail('La limite des révisions partagées est atteinte.');
    const now = new Date().toISOString();
    const receipt: CanonicalTransactionReceipt = {
      format: 'zentra-canonical-transaction-receipt',
      version: 1,
      transaction_id: id,
      organization_id: session.organizationId,
      generation: ctx.manifest.generation,
      origin_installation_id: session.installationId,
      capture_generation: ctx.manifest.capture_generation,
      source_transfer_id: ctx.review.source_transfer_id,
      source_revision: ctx.review.source_revision,
      revision,
      manifest_sha256: ctx.row.manifest_sha256,
      bundle_sha256: bundleSha256,
      fingerprint_version: ctx.fingerprint.algorithm_version,
      fingerprint_contract_sha256: ctx.fingerprintContractHash,
      source_state_sha256: ctx.fingerprint.source_sha256!,
      target_state_sha256: ctx.fingerprint.target_sha256!,
      validation_sha256: ctx.validator,
      committed_at: now,
    };
    const raw = JSON.stringify(receipt),
      receiptHash = await sha256Hex(raw);
    const args = [
      ...ctx.fingerprintBindings,
      bundleSha256,
      bundle,
      raw,
      receiptHash,
      revision,
      now,
      ctx.manifest.capture_generation,
      ctx.manifest.last_sequence,
      ctx.review.base_audit_hash,
      ctx.review.last_audit_hash,
      ctx.review.audit_entries,
      ctx.manifest.first_sequence,
    ];
    await ctx.db.batch([
      ctx.db
        .prepare(`INSERT OR IGNORE INTO business_sync_transaction_commits
      (transfer_id,organization_id,generation,source_transfer_id,source_revision,revision,bundle_sha256,bundle_json,receipt_json,receipt_sha256,committed_at)
      WITH verified AS MATERIALIZED(SELECT 1 WHERE ${completedTransactionFingerprintGateSql})
      SELECT ?1,?2,?4,?31,?8,?23,?19,?20,?21,?22,?24 FROM verified WHERE ${eligible}`)
        .bind(...args, ctx.review.source_transfer_id),
      ctx.db
        .prepare(`INSERT INTO business_sync_audit_branches(organization_id,generation,installation_id,capture_generation,last_hash,last_sequence,revision)
      SELECT ?2,?4,?3,?25,?28,?26,?23 WHERE EXISTS(${ours})
      ON CONFLICT(organization_id,generation,installation_id,capture_generation) DO UPDATE SET last_hash=excluded.last_hash,last_sequence=excluded.last_sequence,revision=excluded.revision`)
        .bind(...args.slice(0, 28)),
      ctx.db
        .prepare(`UPDATE business_sync_transfers SET state='committed',revision=?23,committed_at=?24 WHERE transfer_id=?1 AND EXISTS(${ours})
      AND EXISTS(SELECT 1 FROM business_sync_audit_branches b WHERE b.organization_id=?2 AND b.generation=?4 AND b.installation_id=?3 AND b.capture_generation=?25 AND b.revision=?23 AND b.last_sequence=?26 AND b.last_hash IS ?28)`)
        .bind(...args.slice(0, 28)),
      ctx.db
        .prepare(`UPDATE business_sync_spaces SET head_revision=?23 WHERE organization_id=?2 AND generation=?4 AND state='ready' AND head_revision=?8
      AND EXISTS(SELECT 1 FROM business_sync_transaction_commits c JOIN business_sync_transfers t ON t.transfer_id=c.transfer_id
      WHERE c.transfer_id=?1 AND c.organization_id=?2 AND c.generation=?4 AND c.receipt_sha256=?22 AND c.revision=?23
      AND t.state='committed' AND t.revision=c.revision AND t.committed_at=c.committed_at)`)
        .bind(...args.slice(0, 23)),
    ]);
    const saved = await committedBusinessTransaction(session, id);
    if (!saved) fail();
    return owned(saved);
  } catch (error) {
    // A concurrent identical call, or a lost batch response, returns the exact
    // durable receipt. Never create a second revision to repair an observation.
    const saved = await committedBusinessTransaction(session, id);
    if (saved) return owned(saved);
    throw error;
  }
}
