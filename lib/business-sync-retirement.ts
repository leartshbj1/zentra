import type { DeviceSessionContext } from './account';
import { AccountPublicError, sha256Hex } from './account-security';
import { businessSyncTransferId } from './business-sync-bootstrap';
import { businessFileHash } from './business-sync-files';
import { sequence } from './business-sync-transaction-format';
import { database } from './runtime';

type Retirement = {
  resolution_id: string;
  generation: string;
  capture_generation: string;
  first_sequence: string;
  last_sequence: string;
  base_revision: number;
  receipt_sha256: string;
  review_id: string;
  decision_sha256: string;
};
type Stored = {
  resolution_id: string;
  organization_id: string;
  installation_id: string;
  generation: string;
  capture_generation: string;
  first_sequence: string;
  last_sequence: string;
  base_revision: number;
  binding_json: string;
  binding_sha256: string;
  created_by: string;
  created_at: string;
};
function fail(message: string, status = 409): never {
  throw new AccountPublicError(message, status);
}
function parse(raw: unknown): Retirement {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    fail('La décision de rapprochement est illisible.', 400);
  const v = raw as Record<string, unknown>;
  const fields = [
    'resolution_id',
    'generation',
    'capture_generation',
    'first_sequence',
    'last_sequence',
    'base_revision',
    'receipt_sha256',
    'review_id',
    'decision_sha256',
  ];
  if (Object.keys(v).sort().join(',') !== fields.sort().join(','))
    fail('La décision de rapprochement est incomplète.', 400);
  const first = sequence(v.first_sequence),
    last = sequence(v.last_sequence);
  if (
    BigInt(last) < BigInt(first) ||
    BigInt(last) - BigInt(first) >= BigInt(200_000) ||
    !Number.isSafeInteger(v.base_revision) ||
    (v.base_revision as number) < 2
  )
    fail('La plage ou la révision du rapprochement est invalide.', 400);
  return {
    resolution_id: businessSyncTransferId(v.resolution_id),
    generation: businessSyncTransferId(v.generation),
    capture_generation: businessSyncTransferId(v.capture_generation),
    first_sequence: first,
    last_sequence: last,
    base_revision: v.base_revision as number,
    receipt_sha256: businessFileHash(v.receipt_sha256),
    review_id: businessFileHash(v.review_id),
    decision_sha256: businessFileHash(v.decision_sha256),
  };
}

async function read(session: DeviceSessionContext, id: string, cancelled = false) {
  return database()
    .prepare(
      `SELECT * FROM ${cancelled ? 'business_sync_retirement_cancellations' : 'business_sync_retirements'} WHERE resolution_id=? AND organization_id=? AND installation_id=?`,
    )
    .bind(id, session.organizationId, session.installationId)
    .first<Stored>();
}
async function verifiedBinding(row: Stored) {
  if ((await sha256Hex(row.binding_json)) !== row.binding_sha256)
    fail('La preuve du rapprochement est altérée.', 503);
  const binding = parse(JSON.parse(row.binding_json));
  if (
    binding.resolution_id !== row.resolution_id ||
    binding.generation !== row.generation ||
    binding.capture_generation !== row.capture_generation ||
    binding.first_sequence !== row.first_sequence ||
    binding.last_sequence !== row.last_sequence ||
    binding.base_revision !== row.base_revision
  )
    fail('La preuve ne correspond plus au rapprochement.', 503);
  return binding;
}
async function report(row: Stored) {
  const binding = await verifiedBinding(row);
  return {
    format: 'zentra-conflict-retirement' as const,
    version: 1,
    organization_id: row.organization_id,
    installation_id: row.installation_id,
    ...binding,
    binding_sha256: row.binding_sha256,
    registered_at: row.created_at,
    retired: true,
    business_revision_changed: false,
    transaction_acknowledged: false,
  };
}

export async function businessRetirement(
  session: DeviceSessionContext,
  id: unknown,
) {
  const row = await read(session, businessSyncTransferId(id));
  if (!row) fail('Ce rapprochement est introuvable sur cet appareil.', 404);
  return report(row);
}

export async function retireBusinessTransactions(
  session: DeviceSessionContext,
  raw: unknown,
) {
  if (!['owner', 'admin', 'member', 'accountant'].includes(session.role))
    fail('Votre accès ne permet pas de résoudre ces modifications.', 403);
  const value = parse(raw),
    binding = JSON.stringify(value),
    hash = await sha256Hex(binding);
  const previous = await read(session, value.resolution_id);
  if (previous) {
    if (previous.binding_json !== binding || previous.binding_sha256 !== hash)
      fail('Ce rapprochement a déjà été engagé avec d’autres choix.');
    return report(previous);
  }
  // This single SQLite write races atomically against canonical commitment.
  // If a commit won first, the head/branch condition fails. If this fence won,
  // the canonical commit's own eligibility predicate rejects old sequences.
  await database()
    .prepare(`INSERT OR IGNORE INTO business_sync_retirements
    (resolution_id,organization_id,installation_id,generation,capture_generation,first_sequence,last_sequence,base_revision,binding_json,binding_sha256,created_by,created_at)
    SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12
    FROM business_sync_spaces s JOIN business_sync_transaction_commits c ON c.organization_id=s.organization_id AND c.generation=s.generation AND c.revision=s.head_revision
    JOIN business_sync_transfers t ON t.transfer_id=c.transfer_id AND t.organization_id=c.organization_id AND t.generation=c.generation AND t.revision=c.revision
    WHERE s.organization_id=?2 AND s.generation=?4 AND s.state='ready' AND s.head_revision=?8 AND t.state='committed' AND c.receipt_sha256=?13
    AND NOT EXISTS(SELECT 1 FROM business_sync_audit_branches b WHERE b.organization_id=?2 AND b.generation=?4 AND b.installation_id=?3 AND b.capture_generation=?5 AND CAST(b.last_sequence AS INTEGER)>=CAST(?6 AS INTEGER))
    AND NOT EXISTS(SELECT 1 FROM business_sync_retirement_cancellations x WHERE x.resolution_id=?1)
    AND NOT EXISTS(SELECT 1 FROM business_sync_transfers p WHERE p.organization_id=?2 AND p.generation=?4 AND p.installation_id=?3 AND p.kind='transaction' AND json_extract(p.manifest_json,'$.capture_generation')=?5
      AND CAST(json_extract(p.manifest_json,'$.first_sequence') AS INTEGER)<=CAST(?7 AS INTEGER) AND CAST(json_extract(p.manifest_json,'$.last_sequence') AS INTEGER)>=CAST(?6 AS INTEGER)
      AND (CAST(json_extract(p.manifest_json,'$.first_sequence') AS INTEGER)<CAST(?6 AS INTEGER) OR CAST(json_extract(p.manifest_json,'$.last_sequence') AS INTEGER)>CAST(?7 AS INTEGER)))
    AND NOT EXISTS(SELECT 1 FROM business_sync_retirements r WHERE r.organization_id=?2 AND r.generation=?4 AND r.installation_id=?3 AND r.capture_generation=?5 AND CAST(r.first_sequence AS INTEGER)<=CAST(?7 AS INTEGER) AND CAST(r.last_sequence AS INTEGER)>=CAST(?6 AS INTEGER))`)
    .bind(
      value.resolution_id,
      session.organizationId,
      session.installationId,
      value.generation,
      value.capture_generation,
      value.first_sequence,
      value.last_sequence,
      value.base_revision,
      binding,
      hash,
      session.userId,
      new Date().toISOString(),
      value.receipt_sha256,
    )
    .run();
  const saved = await read(session, value.resolution_id);
  if (!saved || saved.binding_json !== binding || saved.binding_sha256 !== hash)
    fail(
      'Le dossier ou un envoi a avancé. Récupérez les confirmations et actualisez la comparaison.',
    );
  return report(saved);
}

async function cancellationReport(row: Stored) {
  const binding = await verifiedBinding(row);
  return {
    format: 'zentra-conflict-retirement-cancellation' as const,
    version: 1,
    organization_id: row.organization_id,
    installation_id: row.installation_id,
    ...binding,
    binding_sha256: row.binding_sha256,
    registered_at: row.created_at,
    cancelled: true,
    retired: false,
    business_revision_changed: false,
    transaction_acknowledged: false,
  };
}

export async function businessRetirementCancellation(session: DeviceSessionContext, id: unknown) {
  const key = businessSyncTransferId(id);
  const retired = await read(session, key);
  if (retired) return report(retired);
  const cancelled = await read(session, key, true);
  if (!cancelled) fail('Aucune confirmation de résolution ou d’annulation pour cet appareil.', 404);
  return cancellationReport(cancelled);
}

export async function cancelBusinessRetirement(session: DeviceSessionContext, raw: unknown) {
  if (!['owner', 'admin', 'member', 'accountant'].includes(session.role))
    fail('Votre accès ne permet pas d’annuler cette résolution.', 403);
  const value = parse(raw), binding = JSON.stringify(value), hash = await sha256Hex(binding);
  const exact = (row: Stored) => {
    if (row.binding_json !== binding || row.binding_sha256 !== hash)
      fail('Cette résolution appartient à d’autres choix. Reprenez la décision enregistrée.');
    return row;
  };
  const retired = await read(session, value.resolution_id);
  if (retired) return report(exact(retired));
  const cancelled = await read(session, value.resolution_id, true);
  if (cancelled) return cancellationReport(exact(cancelled));
  // Both competing INSERTs check the other table inside the SQLite write.
  // A stale head is deliberately allowed here: this cancels the exact request,
  // never a committed retirement, transaction, capture or business revision.
  await database().prepare(`INSERT OR IGNORE INTO business_sync_retirement_cancellations
    (resolution_id,organization_id,installation_id,generation,capture_generation,first_sequence,last_sequence,base_revision,binding_json,binding_sha256,created_by,created_at)
    SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12
    WHERE NOT EXISTS(SELECT 1 FROM business_sync_retirements r WHERE r.resolution_id=?1)`)
    .bind(value.resolution_id, session.organizationId, session.installationId, value.generation,
      value.capture_generation, value.first_sequence, value.last_sequence, value.base_revision,
      binding, hash, session.userId, new Date().toISOString()).run();
  const accepted = await read(session, value.resolution_id);
  if (accepted) return report(exact(accepted));
  const saved = await read(session, value.resolution_id, true);
  if (!saved) fail('La confirmation d’annulation est indisponible. Conservez la résolution et réessayez.');
  return cancellationReport(exact(saved));
}

export async function requireUnretiredTransaction(
  session: DeviceSessionContext,
  manifest: {
    generation: string;
    capture_generation: string;
    first_sequence: string;
    last_sequence: string;
  },
) {
  const found = await database()
    .prepare(`SELECT 1 FROM business_sync_retirements r WHERE r.organization_id=?1 AND r.installation_id=?2 AND r.generation=?3 AND r.capture_generation=?4
    AND CAST(r.first_sequence AS INTEGER)<=CAST(?6 AS INTEGER) AND CAST(r.last_sequence AS INTEGER)>=CAST(?5 AS INTEGER) LIMIT 1`)
    .bind(
      session.organizationId,
      session.installationId,
      manifest.generation,
      manifest.capture_generation,
      manifest.first_sequence,
      manifest.last_sequence,
    )
    .first();
  if (found)
    fail(
      'Ces opérations ont été écartées par un rapprochement. Reprenez la résolution sur cet appareil.',
    );
}
