import type { DeviceSessionContext } from './account';
import { AccountPublicError, sha256Hex } from './account-security';
import { businessSyncContractHash } from './business-sync-bootstrap';
import {
  validatedTransactionContext,
  validatedTransactionGateSql,
} from './business-sync-transaction-validation';
import {
  STATE_FINGERPRINT_VERSION,
  STATE_FINGERPRINT_SEED,
  STATE_FINGERPRINT_ROW,
  initialStateHash,
} from './business-sync-state-hash';
import {
  fingerprintStatePage,
  validStateCursor,
  STATE_MAX_BYTES,
  STATE_MAX_ROWS,
  type StateCursor,
} from './business-sync-state-fingerprint';

type Context = Awaited<ReturnType<typeof validatedTransactionContext>>;
type Progress = StateCursor & {
  transfer_id: string;
  attempt: string;
  validator_sha256: string;
  algorithm_version: number;
  fingerprint_contract_sha256: string;
  phase: 'source' | 'target' | 'complete';
  source_sha256: string | null;
  source_rows: number | null;
  source_bytes: number | null;
  target_sha256: string | null;
};
let fingerprintContract: Promise<string> | undefined;
export function stateFingerprintContractHash() {
  return (fingerprintContract ??= businessSyncContractHash().then((contract) =>
    sha256Hex(
      JSON.stringify([
        'zentra-state-fingerprint',
        STATE_FINGERPRINT_VERSION,
        STATE_FINGERPRINT_SEED,
        STATE_FINGERPRINT_ROW,
        'sqlite-json-object-policy-column-order;sqlite-binary-table-key-order;u64be-utf8-frames;signed64-decimal-rowid',
        contract,
      ]),
    ),
  ));
}
function fail(
  message = 'La vérification du dossier a changé. Relancez sa préparation.',
  status = 409,
): never {
  throw new AccountPublicError(message, status);
}
async function progress(ctx: Context, contractHash: string) {
  const row = await ctx.db
    .prepare(
      'SELECT * FROM business_sync_transaction_fingerprints WHERE transfer_id=?',
    )
    .bind(ctx.id)
    .first<Progress>();
  if (!row) return null;
  if (
    row.attempt !== ctx.review.attempt ||
    row.validator_sha256 !== ctx.validator ||
    row.algorithm_version !== STATE_FINGERPRINT_VERSION ||
    row.fingerprint_contract_sha256 !== contractHash
  )
    fail();
  validStateCursor(row);
  const hash = (s: string | null) =>
    typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
  if (
    !['source', 'target', 'complete'].includes(row.phase) ||
    (row.rows === 0 && row.sha256 !== (await initialStateHash())) ||
    (row.phase === 'source'
      ? row.source_sha256 !== null ||
        row.source_rows !== null ||
        row.source_bytes !== null
      : !hash(row.source_sha256) ||
        row.source_rows !== ctx.review.copied_rows ||
        !Number.isSafeInteger(row.source_bytes) ||
        row.source_bytes! < 0 ||
        row.source_bytes! > STATE_MAX_BYTES) ||
    (row.phase === 'complete'
      ? row.target_sha256 !== row.sha256 || row.rows !== ctx.expectedTargetRows
      : row.target_sha256 !== null) ||
    row.rows >
      (row.phase === 'source' ? ctx.review.copied_rows : ctx.expectedTargetRows)
  )
    fail('Le point de reprise de la vérification est incohérent.', 503);
  return row;
}
async function response(ctx: Context, contractHash: string) {
  const row = await progress(ctx, contractHash);
  const current = await ctx.db
    .prepare(`SELECT 1 WHERE ${validatedTransactionGateSql}`)
    .bind(...ctx.validationBindings)
    .first();
  return {
    transaction_id: ctx.id,
    organization_id: ctx.manifest.organization_id,
    installation_id: ctx.manifest.installation_id,
    generation: ctx.manifest.generation,
    manifest_sha256: ctx.row.manifest_sha256,
    attempt: ctx.review.attempt,
    validation_sha256: ctx.validator,
    fingerprint_contract_sha256: contractHash,
    fingerprint_version: STATE_FINGERPRINT_VERSION,
    source_transfer_id: ctx.review.source_transfer_id,
    source_revision: ctx.review.source_revision,
    phase: current ? (row?.phase ?? 'pending') : 'stale',
    checked_rows: row?.rows ?? 0,
    checked_bytes: row?.bytes ?? 0,
    source_state_sha256: current ? (row?.source_sha256 ?? null) : null,
    target_state_sha256:
      current && row?.phase === 'complete' ? row.target_sha256 : null,
    source_rows: row?.source_rows ?? null,
    target_rows: row?.phase === 'complete' ? row.rows : null,
    fingerprint_complete: !!current && row?.phase === 'complete',
    business_validated: false,
    canonical_committed: false,
    replication_active: false,
  };
}
export async function businessTransactionFingerprintStatus(
  session: DeviceSessionContext,
  id: unknown,
) {
  return response(
    await validatedTransactionContext(session, id),
    await stateFingerprintContractHash(),
  );
}
export async function fingerprintBusinessTransaction(
  session: DeviceSessionContext,
  id: unknown,
) {
  const ctx = await validatedTransactionContext(session, id);
  const contractHash = await stateFingerprintContractHash(),
    seed = await initialStateHash();
  if (
    ctx.review.copied_rows > STATE_MAX_ROWS ||
    ctx.expectedTargetRows > STATE_MAX_ROWS
  )
    fail('Le dossier dépasse les limites de réception.', 503);
  await ctx.db
    .prepare(`INSERT OR IGNORE INTO business_sync_transaction_fingerprints
    (transfer_id,attempt,validator_sha256,algorithm_version,fingerprint_contract_sha256,phase,sha256,updated_at)
    SELECT ?1,?6,?15,${STATE_FINGERPRINT_VERSION},?16,'source',?17,?18 WHERE ${validatedTransactionGateSql}`)
    .bind(
      ...ctx.validationBindings,
      contractHash,
      seed,
      new Date().toISOString(),
    )
    .run();
  const old = await progress(ctx, contractHash);
  if (!old) fail();
  if (old.phase === 'complete') return response(ctx, contractHash);
  const page = await fingerprintStatePage(
    ctx.db,
    old.phase === 'source' ? ctx.review.source_transfer_id : ctx.id,
    session.organizationId,
    old,
  );
  let next: StateCursor = page.cursor,
    phase: Progress['phase'] = old.phase,
    sourceHash = old.source_sha256,
    sourceRows = old.source_rows,
    sourceBytes = old.source_bytes,
    targetHash: string | null = null;
  if (page.complete) {
    if (
      next.rows !==
      (old.phase === 'source' ? ctx.review.copied_rows : ctx.expectedTargetRows)
    )
      fail(
        'Le contenu du dossier ne correspond plus au décompte contrôlé.',
        503,
      );
    if (old.phase === 'source') {
      sourceHash = next.sha256;
      sourceRows = next.rows;
      sourceBytes = next.bytes;
      phase = 'target';
      next = { last_table: '', last_key: '', rows: 0, bytes: 0, sha256: seed };
    } else {
      phase = 'complete';
      targetHash = next.sha256;
    }
  }
  // A replayed request or a changed head/attempt cannot skip or hash a page twice.
  await ctx.db
    .prepare(`UPDATE business_sync_transaction_fingerprints SET last_table=?24,last_key=?25,rows=?26,bytes=?27,sha256=?28,
    phase=?29,source_sha256=?30,source_rows=?31,source_bytes=?32,target_sha256=?33,updated_at=?34
    WHERE transfer_id=?1 AND attempt=?6 AND validator_sha256=?15 AND fingerprint_contract_sha256=?16 AND algorithm_version=${STATE_FINGERPRINT_VERSION}
    AND phase=?17 AND last_table=?18 AND last_key=?19 AND rows=?20 AND bytes=?21 AND sha256=?22 AND source_sha256 IS ?23
    AND ${validatedTransactionGateSql}`)
    .bind(
      ...ctx.validationBindings,
      contractHash,
      old.phase,
      old.last_table,
      old.last_key,
      old.rows,
      old.bytes,
      old.sha256,
      old.source_sha256,
      next.last_table,
      next.last_key,
      next.rows,
      next.bytes,
      next.sha256,
      phase,
      sourceHash,
      sourceRows,
      sourceBytes,
      targetHash,
      new Date().toISOString(),
    )
    .run();
  return response(ctx, contractHash);
}
