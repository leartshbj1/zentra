import type { DeviceSessionContext } from './account';
import { AccountPublicError, sha256Hex } from './account-security';
import { businessSyncTransferId } from './business-sync-bootstrap';
import { publishedHistory } from './business-sync-publication';
import {
  transactionManifest,
  transactionChanges,
} from './business-sync-transaction-format';
import { readBytesBodyWithinLimit } from './request-body';
import { database, fileArchive } from './runtime';

function fail(message: string, status = 409): never {
  throw new AccountPublicError(message, status);
}
function writer(s: DeviceSessionContext) {
  if (!['owner', 'admin', 'member', 'accountant'].includes(s.role))
    fail('Ce compte ne peut pas envoyer de modifications métier.', 403);
}
type Transfer = {
  transfer_id: string;
  organization_id: string;
  installation_id: string;
  generation: string;
  manifest_json: string;
  manifest_sha256: string;
  state: string;
  base_revision: number;
};
type Part = {
  part_index: number;
  sha256: string;
  size_bytes: number;
  change_count: number;
  first_sequence: string;
  last_sequence: string;
  object_key: string;
};
const active = `EXISTS(SELECT 1 FROM business_sync_transfers t JOIN business_sync_spaces s ON s.organization_id=t.organization_id AND s.generation=t.generation
 WHERE t.transfer_id=? AND t.organization_id=? AND t.installation_id=? AND t.generation=? AND t.manifest_sha256=?
 AND t.kind='transaction' AND t.state='receiving' AND s.state='ready' AND s.head_revision>=t.base_revision)`;
async function required(session: DeviceSessionContext, rawId: unknown) {
  writer(session);
  const id = businessSyncTransferId(rawId);
  const row = await database()
    .prepare(`SELECT t.* FROM business_sync_transfers t JOIN business_sync_spaces s ON s.organization_id=t.organization_id AND s.generation=t.generation
      WHERE t.transfer_id=? AND t.organization_id=? AND t.installation_id=? AND t.kind='transaction' AND s.state='ready' AND s.head_revision>=t.base_revision`)
    .bind(id, session.organizationId, session.installationId)
    .first<Transfer>();
  if (!row)
    fail(
      'Cette transaction est introuvable pour ce dossier et cet appareil.',
      404,
    );
  if (!['receiving', 'received', 'invalid', 'committed'].includes(row.state))
    fail(
      'L’état de cette transaction nécessite une version plus récente de l’application.',
    );
  if ((await sha256Hex(row.manifest_json)) !== row.manifest_sha256)
    fail('Le manifeste conservé est altéré.', 503);
  const manifest = await transactionManifest(row.manifest_json);
  if (
    manifest.transaction_id !== id ||
    manifest.organization_id !== session.organizationId ||
    manifest.installation_id !== session.installationId ||
    manifest.generation !== row.generation ||
    manifest.base_revision !== row.base_revision
  )
    fail('La transaction conservée ne correspond pas à sa liaison.', 503);
  const base = await publishedHistory(session, manifest.bootstrap_transfer_id);
  if (!base || base.receipt.generation !== manifest.generation)
    fail('La référence initiale de cette transaction n’est plus disponible.');
  return {
    row,
    manifest,
    id,
    binding: [
      id,
      session.organizationId,
      session.installationId,
      row.generation,
      row.manifest_sha256,
    ],
  };
}
export { required as requireBusinessTransaction };
type Context = Awaited<ReturnType<typeof required>>;
function key(session: DeviceSessionContext, ctx: Context, index: number) {
  return `business-sync/${session.organizationId}/transactions/${ctx.manifest.capture_generation}/${ctx.id}/${index}-${ctx.manifest.chunks[index].sha256}.json`;
}
async function parts(ctx: Context) {
  return (
    await database()
      .prepare(
        'SELECT * FROM business_sync_transaction_parts WHERE transaction_id=? ORDER BY part_index',
      )
      .bind(ctx.id)
      .all<Part>()
  ).results;
}
function matches(p: Part, ctx: Context, session: DeviceSessionContext) {
  const e = ctx.manifest.chunks[p.part_index];
  return (
    e &&
    p.sha256 === e.sha256 &&
    p.size_bytes === e.size_bytes &&
    p.change_count === e.change_count &&
    p.object_key === key(session, ctx, p.part_index)
  );
}
async function response(session: DeviceSessionContext, ctx: Context) {
  const committed =
    ctx.row.state === 'committed'
      ? await (
          await import('./business-sync-transaction-commit')
        ).committedBusinessTransaction(session, ctx.id)
      : null;
  if (ctx.row.state === 'committed' && !committed)
    fail('Le reçu de cette opération enregistrée est introuvable.', 503);
  const received = await parts(ctx);
  if (
    received.some((p) => !matches(p, ctx, session)) ||
    new Set(received.map((p) => p.part_index)).size !== received.length
  )
    fail('Un reçu de fragment conservé est incohérent.', 503);
  const pendingCondition = `NOT EXISTS(SELECT 1 FROM business_sync_file_blobs b WHERE b.transfer_id=t.transfer_id AND b.sha256=json_extract(f.value,'$.sha256') AND b.size_bytes=json_extract(f.value,'$.size_bytes') AND b.verified_at IS NOT NULL)`;
  const summary = await database()
    .prepare(`WITH pending AS (SELECT json_extract(f.value,'$.sha256') sha256,json_extract(f.value,'$.size_bytes') size_bytes FROM business_sync_transfers t,json_each(t.manifest_json,'$.files') f WHERE t.transfer_id=? AND ${pendingCondition})
    SELECT COUNT(*) files_pending,(SELECT json_group_array(json_object('sha256',sha256,'size_bytes',size_bytes)) FROM (SELECT * FROM pending ORDER BY sha256 LIMIT 8)) pending_json FROM pending`)
    .bind(ctx.id)
    .first<{ files_pending: number; pending_json: string }>();
  if (!summary) fail('Le catalogue des documents est indisponible.', 503);
  const filesPending = summary.files_pending,
    pendingFiles = JSON.parse(summary.pending_json) as {
      sha256: string;
      size_bytes: number;
    }[];
  return {
    transaction_id: ctx.id,
    organization_id: session.organizationId,
    installation_id: session.installationId,
    generation: ctx.manifest.generation,
    capture_generation: ctx.manifest.capture_generation,
    manifest_sha256: ctx.row.manifest_sha256,
    state: committed
      ? 'committed'
      : ctx.row.state === 'invalid'
        ? 'invalid'
        : ctx.row.state === 'received'
          ? filesPending
            ? 'awaiting_files'
            : 'awaiting_validation'
          : 'receiving',
    received_chunks: received.map((p) => ({
      chunk_index: p.part_index,
      sha256: p.sha256,
      size_bytes: p.size_bytes,
      change_count: p.change_count,
    })),
    files_pending: filesPending,
    pending_files: pendingFiles,
    canonical_committed: !!committed,
    ...(committed ? { receipt: committed.receipt } : {}),
    replication_active: false,
  };
}
export async function beginBusinessTransaction(
  session: DeviceSessionContext,
  raw: unknown,
) {
  writer(session);
  const manifest = await transactionManifest(raw);
  if (
    manifest.organization_id !== session.organizationId ||
    manifest.installation_id !== session.installationId
  )
    fail(
      'La transaction appartient à une autre entreprise ou à un autre appareil.',
      403,
    );
  const base = await publishedHistory(session, manifest.bootstrap_transfer_id);
  if (
    !base ||
    base.receipt.generation !== manifest.generation ||
    manifest.base_revision > base.head_revision
  )
    fail(
      'La copie initiale et la révision de cette transaction doivent être installées avant son envoi.',
    );
  const hash = await sha256Hex(raw as string);
  await database()
    .prepare(`INSERT OR IGNORE INTO business_sync_transfers
      (transfer_id,organization_id,installation_id,created_by,generation,kind,state,base_revision,manifest_json,manifest_sha256,created_at)
      SELECT ?,?,?,?,?,'transaction','receiving',?,?,?,? FROM business_sync_spaces
      WHERE organization_id=? AND generation=? AND bootstrap_transfer_id=? AND state='ready' AND head_revision>=?`)
    .bind(
      manifest.transaction_id,
      session.organizationId,
      session.installationId,
      session.userId,
      manifest.generation,
      manifest.base_revision,
      raw as string,
      hash,
      new Date().toISOString(),
      session.organizationId,
      manifest.generation,
      manifest.bootstrap_transfer_id,
      manifest.base_revision,
    )
    .run();
  const ctx = await required(session, manifest.transaction_id);
  if (ctx.row.manifest_sha256 !== hash || ctx.row.manifest_json !== raw)
    fail('Cette opération a déjà été préparée avec un autre contenu.');
  return response(session, ctx);
}
export async function businessTransactionStatus(
  session: DeviceSessionContext,
  id: unknown,
) {
  return response(session, await required(session, id));
}

// This seals transport metadata only. Canonical commitment has its own guarded
// transaction and receipt; receiving all chunks cannot publish an operation.
async function sealRows(session: DeviceSessionContext, ctx: Context) {
  const m = ctx.manifest;
  await database()
    .prepare(`UPDATE business_sync_transfers SET state=CASE WHEN
      (SELECT COUNT(*) FROM business_sync_transaction_changes WHERE transaction_id=?1)=?6
      AND (SELECT first_sequence FROM business_sync_transaction_parts WHERE transaction_id=?1 AND part_index=0)=?7
      AND (SELECT last_sequence FROM business_sync_transaction_parts WHERE transaction_id=?1 ORDER BY part_index DESC LIMIT 1)=?8
      AND NOT EXISTS(SELECT 1 FROM (SELECT CAST(first_sequence AS INTEGER) first_seq,LAG(CAST(last_sequence AS INTEGER)) OVER(ORDER BY part_index) previous_seq FROM business_sync_transaction_parts WHERE transaction_id=?1) WHERE first_seq<=previous_seq)
      AND NOT EXISTS(SELECT 1 FROM (SELECT before_sha256,LAG(after_sha256) OVER(PARTITION BY table_name,row_key_json ORDER BY part_index,change_index) previous_sha,ROW_NUMBER() OVER(PARTITION BY table_name,row_key_json ORDER BY part_index,change_index) row_position FROM business_sync_transaction_changes WHERE transaction_id=?1) WHERE row_position>1 AND before_sha256 IS NOT previous_sha)
      AND (SELECT COUNT(DISTINCT json_extract(f.value,'$.sha256')) FROM business_sync_transaction_changes c,json_each(c.files_json) f WHERE c.transaction_id=?1)=?9
      THEN 'received' ELSE 'invalid' END
      WHERE transfer_id=?1 AND organization_id=?2 AND installation_id=?3 AND generation=?4 AND manifest_sha256=?5 AND kind='transaction' AND state='receiving'
      AND (SELECT COUNT(*) FROM business_sync_transaction_parts WHERE transaction_id=?1)=?10
      AND EXISTS(SELECT 1 FROM business_sync_spaces WHERE organization_id=?2 AND generation=?4 AND state='ready')`)
    .bind(
      ...ctx.binding,
      m.change_count,
      m.first_sequence,
      m.last_sequence,
      m.files.length,
      m.chunks.length,
    )
    .run();
  return response(session, await required(session, ctx.id));
}
export async function uploadBusinessTransactionChunk(
  session: DeviceSessionContext,
  rawId: unknown,
  index: number,
  request: Request,
) {
  const ctx = await required(session, rawId);
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= ctx.manifest.chunks.length
  )
    fail('Le fragment ne figure pas dans cette transaction.', 400);
  const expected = ctx.manifest.chunks[index];
  const bytes = await readBytesBodyWithinLimit(request, expected.size_bytes);
  if (
    bytes.length !== expected.size_bytes ||
    (await sha256Hex(bytes)) !== expected.sha256
  )
    fail('Les octets reçus ne correspondent pas au fragment préparé.');
  const changes = transactionChanges(bytes, ctx.manifest, index);
  const previous = await database()
    .prepare(
      'SELECT * FROM business_sync_transaction_parts WHERE transaction_id=? AND part_index=?',
    )
    .bind(ctx.id, index)
    .first<Part>();
  if (previous) {
    if (!matches(previous, ctx, session))
      fail('Le reçu existant ne correspond pas au fragment.', 503);
    return sealRows(session, ctx);
  }
  if (ctx.row.state !== 'receiving')
    fail('Cette transaction ne peut plus recevoir de fragments.');
  const objectKey = key(session, ctx, index);
  const archive = fileArchive();
  const old = await archive.get(objectKey);
  if (old) {
    if (
      old.size !== bytes.length ||
      (await sha256Hex(new Uint8Array(await old.arrayBuffer()))) !==
        expected.sha256
    )
      fail('Le fragment déjà conservé est altéré.', 503);
  } else
    await archive.put(objectKey, bytes, {
      httpMetadata: { contentType: 'application/json' },
    });
  const rows = await Promise.all(
    changes.map(async (c) => ({
      ...c,
      before_sha256:
        c.before_json === null ? null : await sha256Hex(c.before_json),
      after_sha256:
        c.after_json === null ? null : await sha256Hex(c.after_json),
    })),
  );
  const db = database();
  await db.batch([
    db
      .prepare(`INSERT INTO business_sync_transaction_parts(transaction_id,part_index,sha256,size_bytes,change_count,first_sequence,last_sequence,object_key)
        SELECT ?,?,?,?,?,?,?,? WHERE ${active} ON CONFLICT(transaction_id,part_index) DO NOTHING`)
      .bind(
        ctx.id,
        index,
        expected.sha256,
        expected.size_bytes,
        expected.change_count,
        changes[0].sequence,
        changes.at(-1)!.sequence,
        objectKey,
        ...ctx.binding,
      ),
    ...rows.map((c, at) =>
      db
        .prepare(`INSERT INTO business_sync_transaction_changes(transaction_id,organization_id,installation_id,capture_generation,sequence,part_index,change_index,table_name,row_key_json,operation,before_sha256,after_sha256,source_rowid,files_json)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${active} ON CONFLICT(transaction_id,part_index,change_index) DO NOTHING`)
        .bind(
          ctx.id,
          session.organizationId,
          session.installationId,
          ctx.manifest.capture_generation,
          c.sequence,
          index,
          at,
          c.table,
          c.key_json,
          c.operation,
          c.before_sha256,
          c.after_sha256,
          c.source_rowid,
          JSON.stringify([...c.files_before, ...c.files_after]),
          ...ctx.binding,
        ),
    ),
  ]);
  const stored = await database()
    .prepare(
      'SELECT * FROM business_sync_transaction_parts WHERE transaction_id=? AND part_index=?',
    )
    .bind(ctx.id, index)
    .first<Part>();
  if (!stored || !matches(stored, ctx, session))
    fail(
      'La transaction a changé pendant l’envoi ; aucune application métier n’est confirmée.',
    );
  return sealRows(session, ctx);
}
