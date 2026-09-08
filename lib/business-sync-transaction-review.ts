import type { DeviceSessionContext } from './account';
import { AccountPublicError, sha256Hex } from './account-security';
import { businessSyncContractHash } from './business-sync-bootstrap';
import { integrityValidatorHash } from './business-sync-integrity';
import { verifiedAuditNode } from './business-sync-audit';
import { publishedHistory } from './business-sync-publication';
import { requireBusinessTransaction } from './business-sync-transactions';
import { transactionChanges } from './business-sync-transaction-format';
import { storedBlobPart } from './business-sync-blob-store';
import contract from '../desktop/src-tauri/src/business_sync_tables.json';
import { database } from './runtime';
import { sharedRowid, sourceRowid } from './business-sync-order';

const PAGE_ROWS = 200,
  PAGE_BYTES = 4 * 1024 * 1024,
  APPLY_CHANGES = 32;
type Review = {
  transfer_id: string;
  attempt: string;
  generation: string;
  manifest_sha256: string;
  validator_sha256: string;
  source_transfer_id: string;
  source_revision: number;
  state: string;
  last_table: string;
  last_key: string;
  copied_rows: number;
  copied_bytes: number;
  next_chunk: number;
  applied_changes: number;
  base_audit_hash: string | null;
  last_audit_hash: string | null;
  audit_entries: number;
  failed_rule: string | null;
};
// Every candidate write and checkpoint uses the same attempt and source head.
// A concurrent pass, new canonical revision or replacement cannot advance it.
const gate = `EXISTS(SELECT 1 FROM business_sync_transaction_reviews r JOIN business_sync_transfers t ON t.transfer_id=r.transfer_id
 JOIN business_sync_spaces s ON s.organization_id=t.organization_id AND s.generation=t.generation
 JOIN business_sync_transfers u ON u.transfer_id=r.source_transfer_id AND u.organization_id=t.organization_id AND u.generation=t.generation
 WHERE t.transfer_id=?1 AND t.organization_id=?2 AND t.installation_id=?3 AND t.generation=?4 AND t.manifest_sha256=?5 AND t.kind='transaction' AND t.state='received'
 AND r.attempt=?6 AND r.validator_sha256=?7 AND r.source_revision=?8 AND r.state=?9 AND r.last_table=?10 AND r.last_key=?11 AND r.next_chunk=?12 AND r.applied_changes=?13 AND r.copied_rows=?14
 AND r.generation=t.generation AND r.manifest_sha256=t.manifest_sha256 AND s.state='ready' AND s.head_revision=r.source_revision
 AND u.state='committed' AND u.revision=r.source_revision AND (u.kind='transaction' OR (u.kind='bootstrap' AND u.transfer_id=s.bootstrap_transfer_id)))`;
const clear = `NOT EXISTS(SELECT 1 FROM business_sync_transaction_conflicts WHERE transfer_id=?1 AND attempt=?6)`;
const filesComplete = `NOT EXISTS(SELECT 1 FROM json_each(t.manifest_json,'$.files') f WHERE NOT EXISTS(SELECT 1 FROM business_sync_file_blobs b WHERE b.transfer_id=t.transfer_id AND b.sha256=json_extract(f.value,'$.sha256') AND b.size_bytes=json_extract(f.value,'$.size_bytes') AND b.verified_at IS NOT NULL))`;
let validator: Promise<string> | undefined;
export function transactionReviewValidatorHash() {
  return (validator ??= Promise.all([
    businessSyncContractHash(),
    integrityValidatorHash(),
  ]).then((h) =>
    sha256Hex(
      JSON.stringify([
        'zentra-transaction-candidate',
        1,
        PAGE_ROWS,
        PAGE_BYTES,
        APPLY_CHANGES,
        gate,
        filesComplete,
        h,
      ]),
    ),
  ));
}
function fail(message: string, status = 409): never {
  throw new AccountPublicError(message, status);
}
async function context(session: DeviceSessionContext, id: unknown) {
  const tx = await requireBusinessTransaction(session, id);
  const review = await database()
    .prepare(
      'SELECT * FROM business_sync_transaction_reviews WHERE transfer_id=?',
    )
    .bind(tx.id)
    .first<Review>();
  if (!review)
    fail('Le contrôle de cette transaction n’a pas été préparé.', 404);
  if (
    review.generation !== tx.row.generation ||
    review.manifest_sha256 !== tx.row.manifest_sha256 ||
    review.validator_sha256 !== (await transactionReviewValidatorHash())
  )
    fail(
      'Le contrôle nécessite une nouvelle préparation avec cette version du logiciel.',
    );
  if (
    !['copying', 'applying', 'projected', 'conflict', 'invalid'].includes(
      review.state,
    ) ||
    !Number.isSafeInteger(review.source_revision) ||
    review.source_revision < 1 ||
    !Number.isSafeInteger(review.next_chunk) ||
    review.next_chunk < 0 ||
    review.next_chunk > tx.manifest.chunks.length ||
    !Number.isSafeInteger(review.applied_changes) ||
    review.applied_changes < 0 ||
    review.applied_changes > tx.manifest.change_count
  )
    fail('Le reçu de contrôle est incohérent.', 503);
  const completedChanges = tx.manifest.chunks
    .slice(0, review.next_chunk)
    .reduce((total, part) => total + part.change_count, 0);
  const changeOffset = review.applied_changes - completedChanges;
  if (
    changeOffset < 0 ||
    (review.next_chunk === tx.manifest.chunks.length
      ? changeOffset !== 0 || review.state !== 'projected'
      : changeOffset >= tx.manifest.chunks[review.next_chunk].change_count) ||
    (review.state === 'projected' &&
      review.next_chunk !== tx.manifest.chunks.length) ||
    (review.state === 'copying' && review.applied_changes !== 0) ||
    !Number.isSafeInteger(review.copied_rows) ||
    review.copied_rows < 0 ||
    !Number.isSafeInteger(review.copied_bytes) ||
    review.copied_bytes < 0 ||
    !Number.isSafeInteger(review.audit_entries) ||
    review.audit_entries < 0 ||
    review.audit_entries > review.applied_changes
  )
    fail('Le reçu de contrôle est incohérent.', 503);
  return {
    ...tx,
    review,
    changeOffset,
    values: [
      ...tx.binding,
      review.attempt,
      review.validator_sha256,
      review.source_revision,
      review.state,
      review.last_table,
      review.last_key,
      review.next_chunk,
      review.applied_changes,
      review.copied_rows,
    ],
  };
}
type Context = Awaited<ReturnType<typeof context>>;
async function response(ctx: Context) {
  const head = await database()
    .prepare(
      'SELECT head_revision FROM business_sync_spaces WHERE organization_id=? AND generation=?',
    )
    .bind(ctx.manifest.organization_id, ctx.manifest.generation)
    .first<{ head_revision: number }>();
  const conflicts = (
    await database()
      .prepare(
        'SELECT table_name,row_key_json,part_index,change_index,expected_sha256,current_sha256,incoming_sha256,reason FROM business_sync_transaction_conflicts WHERE transfer_id=? AND attempt=? ORDER BY part_index,change_index LIMIT 20',
      )
      .bind(ctx.id, ctx.review.attempt)
      .all()
  ).results;
  return {
    transaction_id: ctx.id,
    organization_id: ctx.manifest.organization_id,
    installation_id: ctx.manifest.installation_id,
    generation: ctx.manifest.generation,
    manifest_sha256: ctx.row.manifest_sha256,
    attempt: ctx.review.attempt,
    validator_sha256: ctx.review.validator_sha256,
    source_revision: ctx.review.source_revision,
    state:
      head?.head_revision === ctx.review.source_revision
        ? ctx.review.state
        : 'stale',
    copied_rows: ctx.review.copied_rows,
    applied_changes: ctx.review.applied_changes,
    next_chunk: ctx.review.next_chunk,
    audit_entries: ctx.review.audit_entries,
    failed_rule: ctx.review.failed_rule,
    conflicts,
    financial_validated: false,
    canonical_committed: false,
    replication_active: false,
  };
}
export async function businessTransactionReviewStatus(
  session: DeviceSessionContext,
  id: unknown,
) {
  return response(await context(session, id));
}
export async function beginBusinessTransactionReview(
  session: DeviceSessionContext,
  id: unknown,
) {
  const tx = await requireBusinessTransaction(session, id);
  if (tx.row.state !== 'received')
    fail(
      'La transaction et ses documents doivent être reçus avant leur contrôle.',
    );
  const existing = await database()
    .prepare(
      'SELECT transfer_id FROM business_sync_transaction_reviews WHERE transfer_id=?',
    )
    .bind(tx.id)
    .first();
  if (existing) return businessTransactionReviewStatus(session, tx.id);
  const base = await publishedHistory(
    session,
    tx.manifest.bootstrap_transfer_id,
  );
  if (!base) fail('L’historique de référence n’est plus disponible.');
  const source = await database()
    .prepare(
      "SELECT transfer_id FROM business_sync_transfers WHERE organization_id=? AND generation=? AND revision=? AND state='committed' AND kind IN ('bootstrap','transaction')",
    )
    .bind(session.organizationId, tx.manifest.generation, base.head_revision)
    .first<{ transfer_id: string }>();
  if (!source) fail('La révision courante du dossier est indisponible.', 503);
  const branch = await database()
    .prepare(
      'SELECT last_hash,last_sequence,revision FROM business_sync_audit_branches WHERE organization_id=? AND generation=? AND installation_id=? AND capture_generation=?',
    )
    .bind(
      session.organizationId,
      tx.manifest.generation,
      session.installationId,
      tx.manifest.capture_generation,
    )
    .first<{
      last_hash: string | null;
      last_sequence: string;
      revision: number;
    }>();
  if (
    branch &&
    (branch.revision > base.head_revision ||
      !/^[1-9][0-9]*$/.test(branch.last_sequence))
  )
    fail('La preuve de l’appareil est incohérente.', 503);
  if (
    branch &&
    BigInt(tx.manifest.first_sequence) <= BigInt(branch.last_sequence)
  )
    fail(
      'Une opération plus récente de cet appareil a déjà été enregistrée. Réconciliez ce journal avant de continuer.',
    );
  const anchor = branch ? branch.last_hash : base.receipt.last_audit_hash;
  const review: Review = {
    transfer_id: tx.id,
    attempt: crypto.randomUUID(),
    generation: tx.manifest.generation,
    manifest_sha256: tx.row.manifest_sha256,
    validator_sha256: await transactionReviewValidatorHash(),
    source_transfer_id: source.transfer_id,
    source_revision: base.head_revision,
    state: 'copying',
    last_table: '',
    last_key: '',
    copied_rows: 0,
    copied_bytes: 0,
    next_chunk: 0,
    applied_changes: 0,
    base_audit_hash: anchor,
    last_audit_hash: anchor,
    audit_entries: 0,
    failed_rule: null,
  };
  const values = [
    ...tx.binding,
    review.attempt,
    review.validator_sha256,
    review.source_revision,
    'copying',
    '',
    '',
    0,
    0,
    0,
  ];
  await database().batch([
    database()
      .prepare(`INSERT OR IGNORE INTO business_sync_transaction_reviews(transfer_id,attempt,generation,manifest_sha256,validator_sha256,source_transfer_id,source_revision,state,base_audit_hash,last_audit_hash,updated_at)
      SELECT ?1,?6,?4,?5,?7,?8,?9,'copying',?10,?10,?11 FROM business_sync_transfers t JOIN business_sync_spaces s ON s.organization_id=t.organization_id AND s.generation=t.generation
      WHERE t.transfer_id=?1 AND t.organization_id=?2 AND t.installation_id=?3 AND t.generation=?4 AND t.manifest_sha256=?5 AND t.kind='transaction' AND t.state='received' AND s.state='ready' AND s.head_revision=?9 AND ${filesComplete}`)
      .bind(
        ...tx.binding,
        review.attempt,
        review.validator_sha256,
        review.source_transfer_id,
        review.source_revision,
        anchor,
        new Date().toISOString(),
      ),
    database()
      .prepare(`INSERT OR IGNORE INTO business_sync_candidate_order(transfer_id,table_name,last_value)
      SELECT ?1,c.value,MAX(0,COALESCE((SELECT last_value FROM business_sync_candidate_order WHERE transfer_id=?15 AND table_name=c.value),(SELECT MAX(CAST(source_rowid AS INTEGER)) FROM business_sync_row_order WHERE transfer_id=?15 AND table_name=c.value),0)) FROM json_each(?16) c WHERE ${gate}`)
      .bind(
        ...values,
        review.source_transfer_id,
        JSON.stringify(Object.keys(contract.tables)),
      ),
  ]);
  return businessTransactionReviewStatus(session, tx.id);
}
const sourceWhere = `v.transfer_id=?15 AND v.organization_id=?2 AND (v.table_name>?10 OR (v.table_name=?10 AND v.row_key_json>?11))`;
async function copySource(ctx: Context) {
  const db = database(),
    r = ctx.review;
  const meta = (
    await db
      .prepare(
        `SELECT v.table_name,v.row_key_json,length(CAST(v.row_json AS BLOB)) bytes,o.source_rowid FROM business_sync_versions v LEFT JOIN business_sync_row_order o ON o.transfer_id=v.transfer_id AND o.table_name=v.table_name AND o.row_key_json=v.row_key_json WHERE ${sourceWhere} ORDER BY v.table_name,v.row_key_json LIMIT ?16`,
      )
      .bind(...ctx.values, r.source_transfer_id, PAGE_ROWS)
      .all<{
        table_name: string;
        row_key_json: string;
        bytes: number;
        source_rowid: string | null;
      }>()
  ).results;
  let bytes = 0;
  const selected = [];
  for (const m of meta) {
    if (
      m.source_rowid === null ||
      !Number.isSafeInteger(m.bytes) ||
      m.bytes < 1 ||
      m.bytes > 1024 * 1024
    )
      fail('Une ligne de référence est absente ou altérée.', 503);
    if (bytes + m.bytes > PAGE_BYTES) break;
    selected.push(m);
    bytes += m.bytes;
  }
  if (!selected.length) {
    await db
      .prepare(
        `UPDATE business_sync_transaction_reviews SET state='applying',updated_at=?15 WHERE transfer_id=?1 AND ${gate}`,
      )
      .bind(...ctx.values, new Date().toISOString())
      .run();
    return;
  }
  const raw = (
    await db
      .prepare(
        `SELECT v.row_json,v.row_sha256 FROM business_sync_versions v WHERE ${sourceWhere} ORDER BY v.table_name,v.row_key_json LIMIT ?16`,
      )
      .bind(...ctx.values, r.source_transfer_id, selected.length)
      .all<{ row_json: string; row_sha256: string }>()
  ).results;
  if (raw.length !== selected.length)
    fail('La référence a changé pendant sa copie.');
  for (const [index, row] of raw.entries()) {
    if ((await sha256Hex(row.row_json)) !== row.row_sha256)
      fail(
        'Les données de référence ne correspondent plus à leur empreinte.',
        503,
      );
    sourceRowid(
      selected[index].source_rowid,
      selected[index].table_name,
      JSON.parse(row.row_json) as Record<string, unknown>,
    );
  }
  const last = selected.at(-1)!;
  await db.batch([
    db
      .prepare(`INSERT INTO business_sync_versions(transfer_id,organization_id,table_name,row_key_json,row_json,row_sha256,before_sha256)
      SELECT ?1,?2,v.table_name,v.row_key_json,v.row_json,v.row_sha256,v.before_sha256 FROM business_sync_versions v WHERE ${sourceWhere} AND ${gate} ORDER BY v.table_name,v.row_key_json LIMIT ?16`)
      .bind(...ctx.values, r.source_transfer_id, selected.length),
    db
      .prepare(`INSERT INTO business_sync_row_order(transfer_id,table_name,row_key_json,source_rowid)
      SELECT ?1,v.table_name,v.row_key_json,o.source_rowid FROM business_sync_versions v JOIN business_sync_row_order o ON o.transfer_id=v.transfer_id AND o.table_name=v.table_name AND o.row_key_json=v.row_key_json WHERE ${sourceWhere} AND ${gate} ORDER BY v.table_name,v.row_key_json LIMIT ?16`)
      .bind(...ctx.values, r.source_transfer_id, selected.length),
    db
      .prepare(
        `UPDATE business_sync_transaction_reviews SET last_table=?15,last_key=?16,copied_rows=copied_rows+?17,copied_bytes=copied_bytes+?18,updated_at=?19 WHERE transfer_id=?1 AND ${gate}`,
      )
      .bind(
        ...ctx.values,
        last.table_name,
        last.row_key_json,
        selected.length,
        bytes,
        new Date().toISOString(),
      ),
  ]);
}
async function reject(ctx: Context, rule: string) {
  await database()
    .prepare(
      `UPDATE business_sync_transaction_reviews SET state='invalid',failed_rule=?15,updated_at=?16 WHERE transfer_id=?1 AND ${gate}`,
    )
    .bind(...ctx.values, rule, new Date().toISOString())
    .run();
}
async function applyChunk(ctx: Context) {
  const r = ctx.review,
    index = r.next_chunk,
    part = ctx.manifest.chunks[index];
  if (!part) fail('Le contrôle a dépassé les fragments disponibles.', 503);
  const stored = await database()
    .prepare(
      'SELECT object_key,sha256,size_bytes,change_count FROM business_sync_transaction_parts WHERE transaction_id=? AND part_index=?',
    )
    .bind(ctx.id, index)
    .first<{
      object_key: string;
      sha256: string;
      size_bytes: number;
      change_count: number;
    }>();
  const expectedKey = `business-sync/${ctx.manifest.organization_id}/transactions/${ctx.manifest.capture_generation}/${ctx.id}/${index}-${part.sha256}.json`;
  if (
    !stored ||
    stored.object_key !== expectedKey ||
    stored.sha256 !== part.sha256 ||
    stored.size_bytes !== part.size_bytes ||
    stored.change_count !== part.change_count
  )
    fail('Un fragment de la transaction est absent ou incohérent.', 503);
  const bytes = await storedBlobPart(expectedKey, part.size_bytes);
  if (
    bytes.length !== part.size_bytes ||
    (await sha256Hex(bytes)) !== part.sha256
  )
    fail('Le fragment de transaction conservé est altéré.', 503);
  // A received fragment can contain 200 changes. Bound the SQL batch as well
  // as its bytes; the saved applied_changes cursor resumes within that fragment.
  const allChanges = transactionChanges(bytes, ctx.manifest, index);
  const changes = allChanges.slice(
    ctx.changeOffset,
    ctx.changeOffset + APPLY_CHANGES,
  );
  const finishedChunk = ctx.changeOffset + changes.length === allChanges.length;
  let audit = r.last_audit_hash,
    auditCount = 0;
  for (const c of changes)
    if (c.table === 'audit_log') {
      if (c.operation !== 'insert') {
        await reject(ctx, 'audit:immutable');
        return;
      }
      const node = await verifiedAuditNode(
        JSON.parse(c.after_json!) as Record<string, unknown>,
      );
      if (!node) {
        await reject(ctx, 'audit:hash');
        return;
      }
      if (node.previous_hash !== audit) {
        await reject(ctx, 'audit:parent');
        return;
      }
      audit = node.entry_hash;
      auditCount++;
    }
  const db = database(),
    statements: D1PreparedStatement[] = [];
  const current = `(SELECT row_sha256 FROM business_sync_versions WHERE transfer_id=?1 AND table_name=?15 AND row_key_json=?16)`;
  for (const [at, c] of changes.entries()) {
    const before =
        c.before_json === null ? null : await sha256Hex(c.before_json),
      after = c.after_json === null ? null : await sha256Hex(c.after_json);
    const values = [
      ...ctx.values,
      c.table,
      c.key_json,
      before,
      c.after_json,
      after,
      index,
      ctx.changeOffset + at,
    ];
    statements.push(
      db
        .prepare(`INSERT OR IGNORE INTO business_sync_transaction_conflicts(transfer_id,attempt,table_name,row_key_json,part_index,change_index,expected_sha256,current_sha256,incoming_sha256,reason)
      SELECT ?1,?6,?15,?16,?20,?21,?17,${current},?19,'before_mismatch' WHERE ${gate} AND ${clear} AND ${current} IS NOT ?17`)
        .bind(...values),
    );
    if (c.operation === 'delete') {
      for (const table of ['business_sync_versions', 'business_sync_row_order'])
        statements.push(
          db
            .prepare(
              `DELETE FROM ${table} WHERE transfer_id=?1 AND table_name=?15 AND row_key_json=?16 AND ${gate} AND ${clear}`,
            )
            .bind(...values.slice(0, 16)),
        );
      continue;
    }
    if (c.operation === 'insert') {
      const shared = sharedRowid(
        c.table,
        JSON.parse(c.after_json!) as Record<string, unknown>,
      );
      if (shared !== null) {
        statements.push(
          db
            .prepare(`INSERT OR IGNORE INTO business_sync_transaction_conflicts(transfer_id,attempt,table_name,row_key_json,part_index,change_index,expected_sha256,current_sha256,incoming_sha256,reason)
          SELECT ?1,?6,?15,?16,?20,?21,?17,NULL,?19,'row_id_collision' WHERE ${gate} AND ${clear} AND EXISTS(SELECT 1 FROM business_sync_row_order WHERE transfer_id=?1 AND table_name=?15 AND source_rowid=?22)`)
            .bind(...values, shared),
        );
        statements.push(
          db
            .prepare(
              `UPDATE business_sync_candidate_order SET last_value=MAX(last_value,CAST(?17 AS INTEGER)) WHERE transfer_id=?1 AND table_name=?15 AND ${gate} AND ${clear}`,
            )
            .bind(...values.slice(0, 16), shared),
        );
        statements.push(
          db
            .prepare(
              `INSERT INTO business_sync_row_order(transfer_id,table_name,row_key_json,source_rowid) SELECT ?1,?15,?16,?17 WHERE ${gate} AND ${clear}`,
            )
            .bind(...values.slice(0, 16), shared),
        );
      } else {
        statements.push(
          db
            .prepare(`INSERT OR IGNORE INTO business_sync_transaction_conflicts(transfer_id,attempt,table_name,row_key_json,part_index,change_index,expected_sha256,current_sha256,incoming_sha256,reason)
        SELECT ?1,?6,?15,?16,?20,?21,?17,NULL,?19,'order_exhausted' WHERE ${gate} AND ${clear} AND NOT EXISTS(SELECT 1 FROM business_sync_candidate_order WHERE transfer_id=?1 AND table_name=?15 AND last_value<9223372036854775807)`)
            .bind(...values),
        );
        statements.push(
          db
            .prepare(
              `UPDATE business_sync_candidate_order SET last_value=last_value+1 WHERE transfer_id=?1 AND table_name=?15 AND ${gate} AND ${clear}`,
            )
            .bind(...values.slice(0, 15)),
        );
        statements.push(
          db
            .prepare(
              `INSERT INTO business_sync_row_order(transfer_id,table_name,row_key_json,source_rowid) SELECT ?1,?15,?16,CAST(last_value AS TEXT) FROM business_sync_candidate_order WHERE transfer_id=?1 AND table_name=?15 AND ${gate} AND ${clear}`,
            )
            .bind(...values.slice(0, 16)),
        );
      }
    }
    statements.push(
      db
        .prepare(`INSERT INTO business_sync_versions(transfer_id,organization_id,table_name,row_key_json,row_json,row_sha256,before_sha256)
      SELECT ?1,?2,?15,?16,?18,?19,?17 WHERE ${gate} AND ${clear} ON CONFLICT(transfer_id,table_name,row_key_json) DO UPDATE SET row_json=excluded.row_json,row_sha256=excluded.row_sha256,before_sha256=excluded.before_sha256`)
        .bind(...values.slice(0, 19)),
    );
  }
  statements.push(
    db
      .prepare(`UPDATE business_sync_transaction_reviews SET state=CASE WHEN ${clear} THEN ?15 ELSE 'conflict' END,failed_rule=CASE WHEN ${clear} THEN NULL ELSE 'conflict:before-image-or-order' END,
    next_chunk=CASE WHEN ${clear} THEN ?20 ELSE next_chunk END,applied_changes=CASE WHEN ${clear} THEN applied_changes+?16 ELSE applied_changes END,last_audit_hash=CASE WHEN ${clear} THEN ?17 ELSE last_audit_hash END,audit_entries=CASE WHEN ${clear} THEN audit_entries+?18 ELSE audit_entries END,updated_at=?19 WHERE transfer_id=?1 AND ${gate}`)
      .bind(
        ...ctx.values,
        finishedChunk && index + 1 === ctx.manifest.chunks.length
          ? 'projected'
          : 'applying',
        changes.length,
        audit,
        auditCount,
        new Date().toISOString(),
        index + (finishedChunk ? 1 : 0),
      ),
  );
  await db.batch(statements);
}
export async function reviewBusinessTransaction(
  session: DeviceSessionContext,
  id: unknown,
) {
  const ctx = await context(session, id);
  const status = await response(ctx);
  if (status.state === 'stale') return status;
  if (ctx.review.state === 'copying') await copySource(ctx);
  else if (ctx.review.state === 'applying') await applyChunk(ctx);
  return businessTransactionReviewStatus(session, ctx.id);
}
