import contract from '../desktop/src-tauri/src/business_sync_tables.json';
import type { DeviceSessionContext } from './account';
import {
  AccountPublicError,
  isInstallationId,
  roleCanManageMembers,
  sha256Hex,
} from './account-security';
import { readBytesBodyWithinLimit } from './request-body';
import { database, fileArchive } from './runtime';
import { cleanupBootstrapFiles } from './business-sync-files';
import { numberingFloors, type NumberFloor } from './business-sync-numbering';
import { sourceRowid } from './business-sync-order';

export const SYNC_CHUNK_BYTES = 4 * 1024 * 1024;
export const SYNC_ROW_BYTES = 1024 * 1024;
export const SYNC_ROWS_PER_CHUNK = 200;
const MAX_CHUNKS = 1024;
const MAX_TRANSFER_BYTES = 512 * 1024 * 1024;
const MAX_ROWS = 200_000;
const tables = contract.tables as Record<
  string,
  { key: string[]; columns: string[]; local_columns: string[] }
>;
const tableNames = Object.keys(tables).sort();
let contractHash: Promise<string> | undefined;

export function businessSyncContractHash() {
  // Arrays keep this fingerprint independent of OS line endings and JSON map
  // serialization. The native client uses the same ordered schema contract.
  return (contractHash ??= sha256Hex(
    JSON.stringify([
      'zentra-business-contract',
      1,
      60,
      tableNames.map((name) => [
        name,
        tables[name].key,
        tables[name].columns,
        tables[name].local_columns,
      ]),
    ]),
  ));
}

type Chunk = { sha256: string; size_bytes: number; row_count: number };
export type BootstrapManifest = {
  format: 'zentra-business-bootstrap';
  version: 1 | 2 | 3;
  schema_version: 60;
  contract_sha256: string;
  tables: Record<string, number>;
  chunks: Chunk[];
  row_count: number;
  size_bytes: number;
  numbering_floors?: NumberFloor[];
};
type Transfer = {
  transfer_id: string;
  organization_id: string;
  installation_id: string;
  generation: string;
  state: string;
  manifest_json: string;
  manifest_sha256: string;
};
type Space = {
  bootstrap_transfer_id: string;
  generation: string;
  state: string;
  head_revision: number;
};
type StoredChunk = {
  chunk_index: number;
  sha256: string;
  size_bytes: number;
  row_count: number;
};
type PortableRow = {
  table: string;
  key_json: string;
  row_json: string;
  sha256: string;
  source_rowid: string | null;
};

function invalid(message: string, status = 400): never {
  throw new AccountPublicError(message, status);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid('Les données de synchronisation sont invalides.');
  return value as Record<string, unknown>;
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))
    invalid('Empreinte de synchronisation invalide.');
  return value;
}
function integer(value: unknown, min: number, max: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    invalid('La taille ou le nombre de lignes est hors limites.');
  return value;
}
export function businessSyncTransferId(value: unknown): string {
  if (typeof value !== 'string' || !isInstallationId(value))
    invalid('Référence de synchronisation invalide.');
  return value.toLowerCase();
}
function requireInitializer(session: DeviceSessionContext) {
  if (!roleCanManageMembers(session.role))
    invalid(
      'Seuls le titulaire et les administrateurs peuvent préparer la base de référence de l’entreprise.',
      403,
    );
}

export async function bootstrapManifest(
  value: unknown,
): Promise<BootstrapManifest> {
  const input = object(value);
  if (
    input.format !== 'zentra-business-bootstrap' ||
    (input.version !== 1 && input.version !== 2 && input.version !== 3) ||
    input.schema_version !== 60
  )
    invalid('Cette version de synchronisation n’est pas prise en charge.');
  if (input.version === 1 && Object.hasOwn(input, 'numbering_floors'))
    invalid(
      'Les bornes de numérotation nécessitent le nouveau format de préparation.',
    );
  const floors =
    input.version !== 1 ? numberingFloors(input.numbering_floors) : undefined;
  const fingerprint = hash(input.contract_sha256);
  if (fingerprint !== (await businessSyncContractHash()))
    invalid(
      'Le schéma de cette application ne correspond pas au serveur.',
      409,
    );
  const counts = object(input.tables);
  if (
    Object.keys(counts).length !== tableNames.length ||
    Object.keys(counts).some((name) => !Object.hasOwn(tables, name))
  )
    invalid(
      'Le manifeste doit classer toutes les tables métier et exclure les données propres à l’appareil.',
    );
  const normalized = Object.fromEntries(
    tableNames.map((name) => [name, integer(counts[name], 0, MAX_ROWS)]),
  );
  if (normalized.settings !== 1)
    invalid('La configuration complète de l’entreprise est nécessaire.');
  const rowCount = Object.values(normalized).reduce(
    (sum, count) => sum + count,
    0,
  );
  integer(rowCount, 1, MAX_ROWS);
  if (
    !Array.isArray(input.chunks) ||
    !input.chunks.length ||
    input.chunks.length > MAX_CHUNKS
  )
    invalid('Le nombre de fragments est hors limites.');
  const chunks = input.chunks.map((value) => {
    const part = object(value);
    return {
      sha256: hash(part.sha256),
      size_bytes: integer(part.size_bytes, 1, SYNC_CHUNK_BYTES),
      row_count: integer(part.row_count, 1, SYNC_ROWS_PER_CHUNK),
    };
  });
  const size = chunks.reduce((sum, part) => sum + part.size_bytes, 0);
  integer(size, 1, MAX_TRANSFER_BYTES);
  if (
    chunks.reduce((sum, part) => sum + part.row_count, 0) !== rowCount ||
    input.row_count !== rowCount ||
    input.size_bytes !== size
  )
    invalid('Les totaux du manifeste ne correspondent pas à ses fragments.');
  return {
    format: 'zentra-business-bootstrap',
    version: input.version,
    schema_version: 60,
    contract_sha256: fingerprint,
    tables: normalized,
    chunks,
    row_count: rowCount,
    size_bytes: size,
    ...(floors ? { numbering_floors: floors } : {}),
  };
}

async function required(
  session: DeviceSessionContext,
  id: string,
  sameDevice = true,
): Promise<Transfer> {
  const row = await database()
    .prepare(
      "SELECT * FROM business_sync_transfers WHERE organization_id=? AND transfer_id=? AND kind='bootstrap'",
    )
    .bind(session.organizationId, id)
    .first<Transfer>();
  if (!row) invalid('Préparation de synchronisation introuvable.', 404);
  if (sameDevice && row.installation_id !== session.installationId)
    invalid('Cette préparation appartient à un autre appareil.', 409);
  return row;
}

export async function bootstrapStatus(
  session: DeviceSessionContext,
  rawId: unknown,
) {
  requireInitializer(session);
  const id = businessSyncTransferId(rawId);
  const transfer = await required(session, id);
  const chunks = await database()
    .prepare(
      'SELECT chunk_index,sha256,size_bytes,row_count FROM business_sync_transfer_chunks WHERE transfer_id=? ORDER BY chunk_index',
    )
    .bind(id)
    .all<StoredChunk>();
  return {
    transfer_id: id,
    organization_id: session.organizationId,
    installation_id: transfer.installation_id,
    generation: transfer.generation,
    state: transfer.state,
    manifest_sha256: transfer.manifest_sha256,
    uploaded_chunks: chunks.results ?? [],
    replication_active: false,
  };
}

export async function beginBootstrap(
  session: DeviceSessionContext,
  rawId: unknown,
  value: unknown,
) {
  requireInitializer(session);
  const id = businessSyncTransferId(rawId);
  const manifest = await bootstrapManifest(value);
  const manifestJson = JSON.stringify(manifest);
  const manifestHash = await sha256Hex(manifestJson);
  const db = database();
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(`INSERT OR IGNORE INTO business_sync_spaces
      (organization_id,generation,bootstrap_transfer_id,state,head_revision,created_by,created_at)
      SELECT ?,?,?,'initializing',0,?,? WHERE NOT EXISTS(SELECT 1 FROM business_sync_transfers
        WHERE transfer_id=? AND state IN ('abandoning','abandoned'))`)
      .bind(
        session.organizationId,
        crypto.randomUUID(),
        id,
        session.userId,
        now,
        id,
      ),
    db
      .prepare(`INSERT OR IGNORE INTO business_sync_transfers
      (transfer_id,organization_id,installation_id,created_by,generation,kind,state,base_revision,manifest_json,manifest_sha256,created_at)
      SELECT ?,?,?,?,generation,'bootstrap','uploading',0,?,?,? FROM business_sync_spaces
      WHERE organization_id=? AND bootstrap_transfer_id=? AND state='initializing' AND head_revision=0`)
      .bind(
        id,
        session.organizationId,
        session.installationId,
        session.userId,
        manifestJson,
        manifestHash,
        now,
        session.organizationId,
        id,
      ),
    // A globally reused transfer UUID must not leave a new company bound to
    // another company's transfer. Roll back the new space as well.
    db
      .prepare(`INSERT INTO business_sync_transfer_chunks
      (transfer_id,chunk_index,sha256,size_bytes,row_count,object_key)
      SELECT NULL,0,'',0,0,'' WHERE EXISTS(SELECT 1 FROM business_sync_spaces
        WHERE organization_id=? AND bootstrap_transfer_id=?)
      AND NOT EXISTS(SELECT 1 FROM business_sync_transfers WHERE organization_id=? AND transfer_id=?)`)
      .bind(session.organizationId, id, session.organizationId, id),
  ]);
  const space = await db
    .prepare('SELECT * FROM business_sync_spaces WHERE organization_id=?')
    .bind(session.organizationId)
    .first<Space>();
  if (!space || space.bootstrap_transfer_id !== id)
    invalid(
      'Une base de référence est déjà préparée pour cette entreprise.',
      409,
    );
  const transfer = await required(session, id);
  if (
    transfer.manifest_sha256 !== manifestHash ||
    transfer.manifest_json !== manifestJson
  )
    invalid(
      'Cette demande contient déjà un autre historique. Reprenez sa préparation initiale.',
      409,
    );
  return bootstrapStatus(session, id);
}

async function portableRows(
  bytes: Uint8Array,
  version: 1 | 2 | 3,
): Promise<PortableRow[]> {
  let input: Record<string, unknown>;
  try {
    input = object(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
  } catch {
    invalid('Le fragment de synchronisation est illisible.');
  }
  if (
    input.version !== (version === 3 ? 2 : 1) ||
    !Array.isArray(input.rows) ||
    !input.rows.length ||
    input.rows.length > SYNC_ROWS_PER_CHUNK
  )
    invalid('Le fragment ne contient pas un lot de lignes valide.');
  const keys = new Set<string>();
  if (version === 3 && Object.keys(input).sort().join(',') !== 'rows,version')
    invalid('Le fragment contient des champs de transport inconnus.');
  return Promise.all(
    input.rows.map(async (value) => {
      const row = object(value);
      if (
        version === 3 &&
        Object.keys(row).sort().join(',') !==
          'key_json,row_json,source_rowid,table'
      )
        invalid(
          'La ligne contient des champs de transport inconnus ou incomplets.',
        );
      if (version !== 3 && Object.hasOwn(row, 'source_rowid'))
        invalid(
          'La position des événements nécessite une préparation récente.',
        );
      if (typeof row.table !== 'string' || !Object.hasOwn(tables, row.table))
        invalid(
          'Le fragment contient une table qui ne peut pas être partagée.',
        );
      if (
        typeof row.row_json !== 'string' ||
        new TextEncoder().encode(row.row_json).length > SYNC_ROW_BYTES
      )
        invalid('Une ligne est trop volumineuse pour la synchronisation.');
      let data: Record<string, unknown>;
      try {
        data = object(JSON.parse(row.row_json));
      } catch {
        invalid('Une ligne métier est illisible.');
      }
      rejectDuplicateFields(row.row_json);
      const rule = tables[row.table];
      const fields = Object.keys(data);
      if (
        fields.length !== rule.columns.length ||
        fields.some((field) => !rule.columns.includes(field))
      )
        invalid(
          'Une ligne comporte un champ manquant, inconnu ou réservé à cet appareil.',
        );
      for (const scalar of Object.values(data)) {
        if (
          scalar !== null &&
          typeof scalar !== 'string' &&
          typeof scalar !== 'number'
        )
          invalid('Un champ métier n’est pas une valeur SQLite portable.');
        if (
          typeof scalar === 'number' &&
          (!Number.isFinite(scalar) ||
            Math.abs(scalar) > Number.MAX_SAFE_INTEGER)
        )
          invalid(
            'Un nombre ne peut pas être transféré sans perte de précision.',
          );
        if (typeof scalar === 'string' && !scalar.isWellFormed())
          invalid('Un texte contient une séquence Unicode invalide.');
      }
      const key = rule.key.map((field) => data[field]);
      if (
        !key.length ||
        key.some(
          (value) =>
            value === null ||
            value === '' ||
            (typeof value === 'number' && !Number.isSafeInteger(value)),
        )
      )
        invalid('Une ligne métier n’a pas de référence stable.');
      const keyJson = JSON.stringify(key);
      if (row.key_json !== keyJson || keyJson.length > 1024)
        invalid('La référence ne correspond pas à la ligne métier.');
      const identity = `${row.table}\0${keyJson}`;
      if (keys.has(identity))
        invalid('Une ligne figure plusieurs fois dans le même fragment.');
      keys.add(identity);
      if (
        row.table === 'settings' &&
        (data.id !== 1 || data.onboarding_completed !== 1)
      )
        invalid(
          'La configuration de l’entreprise doit être terminée avant sa synchronisation.',
        );
      // Preserve native JSON bytes, including REAL values such as 1.0 and JSON
      // stored inside TEXT columns. Re-serializing would change conflict hashes.
      return {
        table: row.table,
        key_json: keyJson,
        row_json: row.row_json,
        sha256: await sha256Hex(row.row_json),
        source_rowid:
          version === 3 ? sourceRowid(row.source_rowid, row.table, data) : null,
      };
    }),
  );
}

export async function uploadBootstrapChunk(
  session: DeviceSessionContext,
  rawId: unknown,
  rawIndex: unknown,
  request: Request,
) {
  requireInitializer(session);
  const id = businessSyncTransferId(rawId);
  const index = integer(rawIndex, 0, MAX_CHUNKS - 1);
  const transfer = await required(session, id);
  const manifest = await bootstrapManifest(JSON.parse(transfer.manifest_json));
  const part = manifest.chunks[index];
  if (!part) invalid('Ce fragment ne figure pas dans le manifeste.');
  const bytes = await readBytesBodyWithinLimit(request, part.size_bytes);
  if (
    bytes.length !== part.size_bytes ||
    (await sha256Hex(bytes)) !== part.sha256
  )
    invalid('Le fragment reçu ne correspond pas à son empreinte.', 409);
  const db = database();
  const stored = () =>
    db
      .prepare(
        'SELECT chunk_index,sha256,size_bytes,row_count FROM business_sync_transfer_chunks WHERE transfer_id=? AND chunk_index=?',
      )
      .bind(id, index)
      .first<StoredChunk>();
  const matches = (receipt: StoredChunk) =>
    receipt.sha256 === part.sha256 &&
    receipt.row_count === part.row_count &&
    receipt.size_bytes === part.size_bytes;
  const existing = await stored();
  if (existing) {
    if (!matches(existing))
      invalid('L’accusé de réception ne correspond pas au manifeste.', 409);
    await sealUploadIfComplete(id);
    return bootstrapStatus(session, id);
  }
  if (transfer.state !== 'uploading')
    invalid('Cette préparation n’accepte plus de nouveaux fragments.', 409);
  const rows = await portableRows(bytes, manifest.version);
  if (rows.length !== part.row_count)
    invalid('Le nombre de lignes du fragment est incohérent.');
  const byTable: Record<string, number> = {};
  for (const row of rows) byTable[row.table] = (byTable[row.table] ?? 0) + 1;
  // The immutable blob is retained for verification; structured rows stay
  // invisible to readers until a later validated commit publishes a revision.
  const objectKey = `business-sync/${session.organizationId}/${id}/${index}-${part.sha256}.json`;
  await fileArchive().put(objectKey, bytes, {
    httpMetadata: { contentType: 'application/json' },
  });
  await rejectCancelledUpload(session, id, objectKey);
  const statements = rows.map((row) =>
    db
      .prepare(`INSERT INTO business_sync_versions
      (transfer_id,organization_id,table_name,row_key_json,row_json,row_sha256,before_sha256)
      SELECT ?,?,?,?,?,?,NULL WHERE EXISTS(SELECT 1 FROM business_sync_transfers
        WHERE transfer_id=? AND state='uploading' AND installation_id=? AND organization_id=?)`)
      .bind(
        id,
        session.organizationId,
        row.table,
        row.key_json,
        row.row_json,
        row.sha256,
        id,
        session.installationId,
        session.organizationId,
      ),
  );
  // Each table count is checked inside the same D1 transaction, after inserts.
  for (const row of rows)
    if (row.source_rowid !== null)
      statements.push(
        db
          .prepare(`INSERT INTO business_sync_row_order(transfer_id,table_name,row_key_json,source_rowid)
    SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM business_sync_transfers WHERE transfer_id=? AND state='uploading' AND installation_id=? AND organization_id=?)`)
          .bind(
            id,
            row.table,
            row.key_json,
            row.source_rowid,
            id,
            session.installationId,
            session.organizationId,
          ),
      );
  // A violated NOT NULL constraint is deliberate: abort the entire chunk, never
  // retain only some rows or publish a receipt for an incomplete batch.
  for (const name of Object.keys(byTable)) {
    statements.push(
      db
        .prepare(`INSERT INTO business_sync_transfer_chunks
      (transfer_id,chunk_index,sha256,size_bytes,row_count,object_key)
      SELECT NULL,0,'',0,0,'' WHERE
        (SELECT COUNT(*) FROM business_sync_versions WHERE transfer_id=? AND table_name=?)>?`)
        .bind(id, name, manifest.tables[name]),
    );
  }
  statements.push(
    db
      .prepare(`INSERT INTO business_sync_transfer_chunks
    (transfer_id,chunk_index,sha256,size_bytes,row_count,object_key)
    SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM business_sync_transfers
      WHERE transfer_id=? AND state='uploading' AND installation_id=? AND organization_id=?)`)
      .bind(
        id,
        index,
        part.sha256,
        part.size_bytes,
        part.row_count,
        objectKey,
        id,
        session.installationId,
        session.organizationId,
      ),
  );
  try {
    await db.batch(statements);
  } catch (error) {
    // Concurrent repeats may lose the unique-key race. Only a durable, matching
    // receipt proves the other request completed every row in this chunk.
    const receipt = await stored();
    await rejectCancelledUpload(session, id, objectKey);
    if (!receipt || !matches(receipt)) {
      const rejected = new AccountPublicError(
        'Le fragment n’a pas pu être enregistré intégralement. La préparation reste disponible pour une reprise.',
        409,
      );
      rejected.cause = error;
      throw rejected;
    }
  }
  if (!(await stored())) {
    await rejectCancelledUpload(session, id, objectKey);
    invalid(
      'La préparation a changé pendant cet envoi. Reprenez son état.',
      409,
    );
  }
  await sealUploadIfComplete(id);
  return bootstrapStatus(session, id);
}

async function rejectCancelledUpload(
  session: DeviceSessionContext,
  id: string,
  objectKey: string,
) {
  const current = await required(session, id);
  if (current.state === 'abandoning' || current.state === 'abandoned') {
    await fileArchive().delete(objectKey);
    invalid(
      'Cette préparation a été annulée. Un ancien envoi ne peut pas la reprendre.',
      409,
    );
  }
}

export async function abandonBootstrap(
  session: DeviceSessionContext,
  rawId: unknown,
) {
  requireInitializer(session);
  const id = businessSyncTransferId(rawId);
  // An administrator may recover preparation when its original PC is lost.
  const transfer = await required(session, id, false);
  const manifest = await bootstrapManifest(JSON.parse(transfer.manifest_json));
  const db = database();
  await db
    .prepare(`UPDATE business_sync_transfers SET state='abandoning'
    WHERE transfer_id=? AND organization_id=? AND kind='bootstrap'
      AND state IN ('uploading','uploaded','abandoning')
      AND EXISTS(SELECT 1 FROM business_sync_spaces s WHERE s.organization_id=business_sync_transfers.organization_id
        AND s.bootstrap_transfer_id=business_sync_transfers.transfer_id AND s.state='initializing' AND s.head_revision=0)`)
    .bind(id, session.organizationId)
    .run();
  const current = await required(session, id, false);
  if (!['abandoning', 'abandoned'].includes(current.state))
    invalid(
      'Un historique déjà publié ne peut pas être annulé par ce parcours.',
      409,
    );
  // The expected keys include uploads whose receipt was lost after R2's write.
  await cleanupBootstrapFiles(session.organizationId, id);
  const keys = manifest.chunks.map(
    (part, index) =>
      `business-sync/${session.organizationId}/${id}/${index}-${part.sha256}.json`,
  );
  for (let offset = 0; offset < keys.length; offset += 100)
    await fileArchive().delete(keys.slice(offset, offset + 100));
  await db.batch([
    ...[
      'business_sync_credit_lines',
      'business_sync_credit_movements',
      'business_sync_credit_projection',
      'business_sync_row_order',
    ].map((table) =>
      db
        .prepare(
          `DELETE FROM ${table} WHERE transfer_id=? AND EXISTS(SELECT 1 FROM business_sync_transfers WHERE transfer_id=? AND organization_id=? AND state IN ('abandoning','abandoned'))`,
        )
        .bind(id, id, session.organizationId),
    ),
    db
      .prepare(
        "DELETE FROM business_sync_audit_nodes WHERE transfer_id=? AND EXISTS(SELECT 1 FROM business_sync_transfers WHERE transfer_id=? AND organization_id=? AND state IN ('abandoning','abandoned'))",
      )
      .bind(id, id, session.organizationId),
    db
      .prepare(
        "DELETE FROM business_sync_integrity_checks WHERE transfer_id=? AND EXISTS(SELECT 1 FROM business_sync_transfers WHERE transfer_id=? AND organization_id=? AND state IN ('abandoning','abandoned'))",
      )
      .bind(id, id, session.organizationId),
    db
      .prepare(
        "DELETE FROM business_sync_structural_checks WHERE transfer_id=? AND EXISTS(SELECT 1 FROM business_sync_transfers WHERE transfer_id=? AND organization_id=? AND state IN ('abandoning','abandoned'))",
      )
      .bind(id, id, session.organizationId),
    db
      .prepare(
        "DELETE FROM business_sync_versions WHERE transfer_id=? AND organization_id=? AND EXISTS(SELECT 1 FROM business_sync_transfers WHERE transfer_id=? AND state IN ('abandoning','abandoned'))",
      )
      .bind(id, session.organizationId, id),
    db
      .prepare(
        "DELETE FROM business_sync_transfer_chunks WHERE transfer_id=? AND EXISTS(SELECT 1 FROM business_sync_transfers WHERE transfer_id=? AND organization_id=? AND state IN ('abandoning','abandoned'))",
      )
      .bind(id, id, session.organizationId),
    db
      .prepare(
        "UPDATE business_sync_transfers SET state='abandoned' WHERE transfer_id=? AND organization_id=? AND state='abandoning'",
      )
      .bind(id, session.organizationId),
    db
      .prepare(
        "DELETE FROM business_sync_spaces WHERE organization_id=? AND bootstrap_transfer_id=? AND state='initializing' AND head_revision=0 AND EXISTS(SELECT 1 FROM business_sync_transfers WHERE transfer_id=? AND state='abandoned')",
      )
      .bind(session.organizationId, id, id),
  ]);
  return { transfer_id: id, state: 'abandoned', replication_active: false };
}

async function sealUploadIfComplete(id: string) {
  // "uploaded" only attests durable reception. It neither publishes rows nor
  // reserves historical numbers; the authoritative bootstrap commit must first
  // validate relationships, financial invariants, files and numbering floors.
  await database()
    .prepare(`UPDATE business_sync_transfers SET state='uploaded'
    WHERE transfer_id=? AND state='uploading'
      AND (SELECT COUNT(*) FROM business_sync_transfer_chunks c WHERE c.transfer_id=business_sync_transfers.transfer_id)
        =json_array_length(manifest_json,'$.chunks')
      AND (SELECT SUM(row_count) FROM business_sync_transfer_chunks c WHERE c.transfer_id=business_sync_transfers.transfer_id)
        =json_extract(manifest_json,'$.row_count')`)
    .bind(id)
    .run();
}

// JSON.parse keeps the last duplicate key, whereas SQLite json_extract keeps
// the first. A flat SQLite row must never have these two interpretations.
function rejectDuplicateFields(raw: string) {
  let at = 0;
  const whitespace = () => {
    while (/\s/.test(raw[at] ?? '') && at < raw.length) at++;
  };
  const stringEnd = () => {
    const start = at++;
    while (at < raw.length) {
      const character = raw[at++];
      if (character === '\\') at++;
      else if (character === '"') return raw.slice(start, at);
    }
    return invalid('Une chaîne de la ligne métier est incomplète.');
  };
  whitespace();
  at++;
  whitespace();
  const seen = new Set<string>();
  while (raw[at] !== '}') {
    if (raw[at] !== '"')
      invalid('La ligne métier doit être un objet SQLite simple.');
    const field = JSON.parse(stringEnd()) as string;
    if (seen.has(field))
      invalid('Un champ figure plusieurs fois dans la ligne métier.');
    seen.add(field);
    whitespace();
    at++;
    whitespace();
    if (raw[at] === '"') stringEnd();
    else {
      const start = at;
      while (at < raw.length && raw[at] !== ',' && raw[at] !== '}') at++;
      if (
        !/^(?:null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)\s*$/.test(
          raw.slice(start, at),
        )
      )
        invalid('Un champ métier n’est pas une valeur SQLite portable.');
    }
    whitespace();
    if (raw[at] === ',') {
      at++;
      whitespace();
    } else if (raw[at] !== '}') invalid('La ligne métier est incomplète.');
  }
}
