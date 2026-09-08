import type { DeviceSessionContext } from './account';
import {
  AccountPublicError,
  roleCanManageMembers,
  sha256Hex,
} from './account-security';
import {
  bootstrapManifest,
  businessSyncTransferId,
} from './business-sync-bootstrap';
import { businessFileManifest } from './business-sync-files';
import { businessFileLinksSql } from './business-sync-file-links';
import { historicalNumberFloorsSql } from './business-sync-numbering';
import {
  bootstrapIntegrityStatus,
  bootstrapAccountingRules,
  integrityValidatorHash,
} from './business-sync-integrity';
import { structuralRules } from './business-sync-structure';
import { database } from './runtime';

const eligible = `SELECT 1 FROM business_sync_transfers t
 JOIN business_sync_spaces s ON s.organization_id=t.organization_id AND s.bootstrap_transfer_id=t.transfer_id AND s.generation=t.generation
 JOIN business_sync_structural_checks c ON c.transfer_id=t.transfer_id AND c.validator_sha256=?6 AND c.manifest_sha256=t.manifest_sha256 AND c.generation=t.generation
 JOIN business_sync_integrity_checks i ON i.transfer_id=t.transfer_id AND i.validator_sha256=?7 AND i.manifest_sha256=t.manifest_sha256 AND i.generation=t.generation
 JOIN business_sync_credit_projection p ON p.transfer_id=t.transfer_id AND p.validator_sha256=?7 AND p.manifest_sha256=t.manifest_sha256 AND p.generation=t.generation
 JOIN business_sync_file_sets f ON f.transfer_id=t.transfer_id
 WHERE t.transfer_id=?1 AND t.organization_id=?2 AND t.installation_id=?3 AND t.generation=?4 AND t.manifest_sha256=?5
 AND t.kind='bootstrap' AND t.state='uploaded' AND t.base_revision=0 AND t.revision IS NULL AND s.state='initializing' AND s.head_revision=0
 AND c.state='valid' AND c.failed_rule IS NULL AND c.next_rule=?12
 AND i.state='valid' AND i.failed_rule IS NULL AND i.next_accounting_rule=?13 AND i.indexed_entries=?11 AND i.walked_entries=?11
 AND json_extract(p.state_json,'$.phase')='valid'
 AND f.state='uploaded' AND f.manifest_sha256=?9
 AND (SELECT COUNT(*) FROM business_sync_versions WHERE transfer_id=?1 AND organization_id=?2)=?10
 AND (SELECT COUNT(*) FROM business_sync_file_entries WHERE transfer_id=?1)=?14
 AND (SELECT COALESCE(SUM(size_bytes),0) FROM business_sync_file_entries WHERE transfer_id=?1)=?15
 AND NOT EXISTS(SELECT 1 FROM business_sync_file_entries e LEFT JOIN business_sync_file_blobs b ON b.transfer_id=e.transfer_id AND b.sha256=e.sha256 WHERE e.transfer_id=?1 AND (b.sha256 IS NULL OR b.verified_at IS NULL OR b.size_bytes<>e.size_bytes))
 AND NOT EXISTS(SELECT 1 FROM business_sync_file_blobs b WHERE b.transfer_id=?1 AND NOT EXISTS(SELECT 1 FROM business_sync_file_entries e WHERE e.transfer_id=b.transfer_id AND e.sha256=b.sha256))`;
const ours = `SELECT 1 FROM business_sync_publications p JOIN business_sync_transfers t ON t.transfer_id=p.transfer_id
 JOIN business_sync_spaces s ON s.organization_id=t.organization_id AND s.bootstrap_transfer_id=t.transfer_id AND s.generation=t.generation
 WHERE p.transfer_id=?1 AND p.organization_id=?2 AND t.installation_id=?3 AND p.generation=?4 AND p.manifest_sha256=?5
 AND p.validator_sha256=?8 AND p.files_manifest_sha256=?9 AND t.generation=p.generation AND t.manifest_sha256=p.manifest_sha256
 AND t.kind='bootstrap' AND t.state='uploaded' AND s.state='initializing' AND s.head_revision=0`;
let validator: Promise<string> | undefined;
export function publicationValidatorHash() {
  return (validator ??= integrityValidatorHash().then((integrity) =>
    sha256Hex(
      JSON.stringify([
        'zentra-canonical-bootstrap',
        1,
        integrity,
        eligible,
        ours,
        businessFileLinksSql,
        historicalNumberFloorsSql,
      ]),
    ),
  ));
}
function fail(message: string, status = 409): never {
  throw new AccountPublicError(message, status);
}
export type PublicationReceipt = {
  format: 'zentra-shared-history';
  version: 1;
  transfer_id: string;
  organization_id: string;
  generation: string;
  revision: 1;
  manifest_sha256: string;
  files_manifest_sha256: string;
  validator_sha256: string;
  integrity_validator_sha256: string;
  structural_validator_sha256: string;
  row_count: number;
  file_count: number;
  audit_entries: number;
  last_audit_hash: string | null;
  committed_at: string;
};
// All readers pin an immutable initial revision. Future transaction replication
// is separate from this first publication and must retain that initial source.
export async function publishedHistory(
  session: DeviceSessionContext,
  rawId?: unknown,
) {
  const id = rawId == null ? null : businessSyncTransferId(rawId);
  const row = await database()
    .prepare(`SELECT p.*,t.manifest_json,t.installation_id,f.manifest_json files_manifest_json,
      t.revision,t.committed_at transfer_committed_at,s.head_revision
    FROM business_sync_publications p JOIN business_sync_transfers t ON t.transfer_id=p.transfer_id
    JOIN business_sync_spaces s ON s.organization_id=t.organization_id AND s.bootstrap_transfer_id=t.transfer_id AND s.generation=t.generation
    JOIN business_sync_file_sets f ON f.transfer_id=t.transfer_id
    WHERE p.organization_id=? AND t.organization_id=p.organization_id AND (? IS NULL OR p.transfer_id=?)
    AND t.kind='bootstrap' AND t.state='committed' AND t.revision=1 AND s.state='ready' AND s.head_revision>=1
    AND t.generation=p.generation AND t.manifest_sha256=p.manifest_sha256 AND f.manifest_sha256=p.files_manifest_sha256 AND f.state='uploaded'`)
    .bind(session.organizationId, id, id)
    .first<{
      transfer_id: string;
      organization_id: string;
      generation: string;
      manifest_sha256: string;
      files_manifest_sha256: string;
      validator_sha256: string;
      receipt_json: string;
      committed_at: string;
      manifest_json: string;
      files_manifest_json: string;
      installation_id: string;
      revision: number;
      transfer_committed_at: string;
      head_revision: number;
    }>();
  if (!row) return null;
  if (
    (await sha256Hex(row.manifest_json)) !== row.manifest_sha256 ||
    (await sha256Hex(row.files_manifest_json)) !== row.files_manifest_sha256
  )
    fail('L’historique publié ne correspond plus à ses empreintes.', 503);
  let receipt: PublicationReceipt;
  try {
    receipt = JSON.parse(row.receipt_json);
  } catch {
    fail('Le reçu de publication est illisible.', 503);
  }
  if (
    !receipt ||
    receipt.format !== 'zentra-shared-history' ||
    receipt.version !== 1 ||
    receipt.revision !== 1 ||
    receipt.transfer_id !== row.transfer_id ||
    receipt.organization_id !== row.organization_id ||
    receipt.generation !== row.generation ||
    receipt.manifest_sha256 !== row.manifest_sha256 ||
    receipt.files_manifest_sha256 !== row.files_manifest_sha256 ||
    receipt.validator_sha256 !== row.validator_sha256 ||
    receipt.committed_at !== row.committed_at ||
    row.transfer_committed_at !== row.committed_at
  )
    fail('Le reçu de publication est incohérent.', 503);
  return {
    receipt,
    manifest_json: row.manifest_json,
    files_manifest_json: row.files_manifest_json,
    head_revision: row.head_revision,
    installation_id: row.installation_id,
  };
}

export async function publishBootstrap(
  session: DeviceSessionContext,
  rawId: unknown,
) {
  if (!roleCanManageMembers(session.role))
    fail(
      'Seuls le titulaire et les administrateurs peuvent publier la base de référence.',
      403,
    );
  const id = businessSyncTransferId(rawId),
    db = database();
  const existing = await publishedHistory(session, id);
  if (existing) {
    if (existing.installation_id !== session.installationId)
      fail('Cette préparation appartient à un autre appareil.');
    return existing.receipt;
  }
  const integrity = await bootstrapIntegrityStatus(session, id);
  if (integrity.state !== 'valid')
    fail('Terminez le contrôle de l’historique avant sa publication.');
  const source = await db
    .prepare(`SELECT t.manifest_json,f.manifest_json files_manifest_json,f.manifest_sha256 files_hash,f.state files_state
    FROM business_sync_transfers t JOIN business_sync_file_sets f ON f.transfer_id=t.transfer_id WHERE t.transfer_id=? AND t.organization_id=?`)
    .bind(id, session.organizationId)
    .first<{
      manifest_json: string;
      files_manifest_json: string;
      files_hash: string;
      files_state: string;
    }>();
  if (!source || source.files_state !== 'uploaded')
    fail('Terminez l’envoi des documents avant de publier cet historique.');
  const manifest = await bootstrapManifest(JSON.parse(source.manifest_json));
  const files = businessFileManifest(JSON.parse(source.files_manifest_json));
  if (
    manifest.version !== 2 ||
    !manifest.numbering_floors ||
    files.version !== 2
  )
    fail(
      'Préparez à nouveau l’historique avec la version actuelle pour conserver les compteurs et les exports.',
    );
  if (
    (await sha256Hex(source.manifest_json)) !== integrity.manifest_sha256 ||
    (await sha256Hex(source.files_manifest_json)) !== source.files_hash
  )
    fail('Les manifestes de cette préparation sont incohérents.', 503);
  const publicationHash = await publicationValidatorHash(),
    now = new Date().toISOString();
  const receipt: PublicationReceipt = {
    format: 'zentra-shared-history',
    version: 1,
    transfer_id: id,
    organization_id: session.organizationId,
    generation: integrity.generation,
    revision: 1,
    manifest_sha256: integrity.manifest_sha256,
    files_manifest_sha256: source.files_hash,
    validator_sha256: publicationHash,
    integrity_validator_sha256: integrity.validator_sha256,
    structural_validator_sha256: integrity.structural_validator_sha256,
    row_count: manifest.row_count,
    file_count: files.file_count,
    audit_entries: integrity.verified_audit_entries,
    last_audit_hash: integrity.last_audit_hash,
    committed_at: now,
  };
  const args = [
    id,
    session.organizationId,
    session.installationId,
    integrity.generation,
    integrity.manifest_sha256,
    integrity.structural_validator_sha256,
    integrity.validator_sha256,
    publicationHash,
    source.files_hash,
  ];
  await db.batch([
    db
      .prepare(`INSERT OR IGNORE INTO business_sync_publications(transfer_id,organization_id,generation,manifest_sha256,files_manifest_sha256,validator_sha256,receipt_json,committed_at)
      SELECT ?1,?2,?4,?5,?9,?8,?16,?17 WHERE EXISTS(${eligible}) AND NOT EXISTS(${businessFileLinksSql})`)
      .bind(
        ...args,
        manifest.row_count,
        manifest.tables.audit_log,
        structuralRules.length,
        bootstrapAccountingRules.length,
        files.file_count,
        files.size_bytes,
        JSON.stringify(receipt),
        now,
      ),
    db
      .prepare(`INSERT INTO business_sync_number_floors(organization_id,prefix,year,minimum,bootstrap_transfer_id)
      SELECT ?2,prefix,year,minimum,?1 FROM (${historicalNumberFloorsSql}) WHERE EXISTS(${ours})
      ON CONFLICT(organization_id,prefix,year) DO UPDATE SET minimum=MAX(business_sync_number_floors.minimum,excluded.minimum),
        bootstrap_transfer_id=CASE WHEN excluded.minimum>business_sync_number_floors.minimum THEN excluded.bootstrap_transfer_id ELSE business_sync_number_floors.bootstrap_transfer_id END`)
      .bind(...args),
    db
      .prepare(
        `UPDATE business_sync_transfers SET state='committed',revision=1,committed_at=?10 WHERE transfer_id=?1 AND organization_id=?2 AND EXISTS(${ours})`,
      )
      .bind(...args, now),
    db
      .prepare(`UPDATE business_sync_spaces SET state='ready',head_revision=1 WHERE organization_id=?2 AND bootstrap_transfer_id=?1 AND generation=?4 AND state='initializing' AND head_revision=0
      AND EXISTS(${ours.replace("t.state='uploaded'", "t.state='committed' AND t.revision=1")})`)
      .bind(...args),
  ]);
  const result = await publishedHistory(session, id);
  if (!result)
    fail(
      'La préparation a changé ou un document référencé manque. La publication n’a pas été effectuée.',
    );
  return result.receipt;
}
