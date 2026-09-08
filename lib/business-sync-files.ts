import { createHash } from 'node:crypto';
import type { DeviceSessionContext } from './account';
import {
  AccountPublicError,
  isInstallationId,
  roleCanManageMembers,
  sha256Hex,
} from './account-security';
import { readBytesBodyWithinLimit } from './request-body';
import { database, fileArchive } from './runtime';

export const BUSINESS_FILE_PART_BYTES = 4 * 1024 * 1024;
export const BUSINESS_FILE_PAGE_BYTES = 512 * 1024;
export const BUSINESS_FILES_PER_PAGE = 200;
const MAX_FILES = 50_000;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024 * 1024;
const EMPTY_SHA256 = createHash('sha256').digest('hex');
type FilePage = { sha256: string; size_bytes: number; file_count: number };
export type BusinessFileManifest = {
  format: 'zentra-business-files';
  version: 1 | 2;
  pages: FilePage[];
  file_count: number;
  size_bytes: number;
};
type FileEntry = { path: string; sha256: string; size_bytes: number };
type FileBlob = {
  sha256: string;
  size_bytes: number;
  verified_at: string | null;
};
type FilePart = {
  part_index: number;
  sha256: string;
  size_bytes: number;
  object_key: string;
};
type FileSet = {
  manifest_json: string;
  manifest_sha256: string;
  state: string;
};
type Transfer = { installation_id: string; generation: string; state: string };

function invalid(message: string, status = 400): never {
  throw new AccountPublicError(message, status);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid('Le catalogue de fichiers est invalide.');
  return value as Record<string, unknown>;
}
function exact(input: Record<string, unknown>, fields: string[]) {
  if (
    Object.keys(input).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(input, field))
  )
    invalid('Le catalogue contient un champ inconnu ou manquant.');
}
function integer(value: unknown, maximum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > maximum
  )
    invalid('La taille ou le nombre de fichiers est hors limites.');
  return value;
}
export function businessFileHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))
    invalid('Empreinte de fichier invalide.');
  return value;
}
function transferId(value: unknown): string {
  if (typeof value !== 'string' || !isInstallationId(value))
    invalid('Référence de préparation invalide.');
  return value.toLowerCase();
}
export function businessFilePath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    !value.isWellFormed() ||
    new TextEncoder().encode(value).length > 1024 ||
    /[\\:<>"|?*\p{Cc}]/u.test(value) ||
    value
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  )
    invalid(
      'Le nom d’une pièce jointe n’est pas portable sur les autres appareils.',
    );
  return value;
}
export function businessFileManifest(value: unknown): BusinessFileManifest {
  const input = object(value);
  exact(input, ['format', 'version', 'pages', 'file_count', 'size_bytes']);
  if (
    input.format !== 'zentra-business-files' ||
    (input.version !== 1 && input.version !== 2) ||
    !Array.isArray(input.pages)
  )
    invalid(
      'Cette version du catalogue de fichiers n’est pas prise en charge.',
    );
  const fileCount = integer(input.file_count, MAX_FILES);
  const size = integer(input.size_bytes, MAX_TOTAL_BYTES);
  if (
    input.pages.length !== Math.ceil(fileCount / BUSINESS_FILES_PER_PAGE) ||
    (!fileCount && size)
  )
    invalid('Le nombre de pages du catalogue est incohérent.');
  const pages = input.pages.map((value, index) => {
    const part = object(value);
    exact(part, ['sha256', 'size_bytes', 'file_count']);
    const bytes = integer(part.size_bytes, BUSINESS_FILE_PAGE_BYTES);
    const count = integer(part.file_count, BUSINESS_FILES_PER_PAGE);
    if (
      !bytes ||
      count !==
        Math.min(
          BUSINESS_FILES_PER_PAGE,
          fileCount - index * BUSINESS_FILES_PER_PAGE,
        )
    )
      invalid('Une page du catalogue a une taille incohérente.');
    return {
      sha256: businessFileHash(part.sha256),
      size_bytes: bytes,
      file_count: count,
    };
  });
  return {
    format: 'zentra-business-files',
    version: input.version,
    pages,
    file_count: fileCount,
    size_bytes: size,
  };
}

// Every metadata mutation rechecks the source history inside the D1 transaction.
const ACTIVE = `EXISTS(SELECT 1 FROM business_sync_transfers t JOIN business_sync_spaces s
  ON s.organization_id=t.organization_id AND s.bootstrap_transfer_id=t.transfer_id
  WHERE t.transfer_id=? AND t.organization_id=? AND t.installation_id=? AND t.kind='bootstrap'
    AND t.state='uploaded' AND s.state='initializing' AND s.head_revision=0)`;
const activeValues = (s: DeviceSessionContext, id: string) => [
  id,
  s.organizationId,
  s.installationId,
];
async function required(session: DeviceSessionContext, id: string) {
  if (!roleCanManageMembers(session.role))
    invalid(
      'Seuls le titulaire et les administrateurs peuvent préparer les pièces de référence.',
      403,
    );
  const row = await database()
    .prepare(
      "SELECT installation_id,generation,state FROM business_sync_transfers WHERE transfer_id=? AND organization_id=? AND kind='bootstrap'",
    )
    .bind(id, session.organizationId)
    .first<Transfer>();
  if (!row) invalid('Préparation de fichiers introuvable.', 404);
  if (row.installation_id !== session.installationId)
    invalid('Cette préparation appartient à un autre appareil.', 409);
  const active = await database()
    .prepare(`SELECT 1 AS valid WHERE ${ACTIVE}`)
    .bind(...activeValues(session, id))
    .first();
  if (!active)
    invalid(
      'Les pièces de cet historique ne peuvent plus être envoyées, ou ses données ne sont pas encore reçues.',
      409,
    );
  return row;
}
async function requiredSet(id: string) {
  const set = await database()
    .prepare(
      'SELECT manifest_json,manifest_sha256,state FROM business_sync_file_sets WHERE transfer_id=?',
    )
    .bind(id)
    .first<FileSet>();
  if (!set)
    invalid('Le catalogue de fichiers doit être préparé avant cet envoi.', 404);
  return set;
}
function prefix(org: string, id: string) {
  return `business-sync/${org}/${id}/files/`;
}
function partKey(org: string, id: string, sha: string, index: number) {
  return `${prefix(org, id)}${sha}/${index}`;
}
async function rejectCancelled(
  session: DeviceSessionContext,
  id: string,
  key: string,
) {
  const row = await database()
    .prepare(
      'SELECT state FROM business_sync_transfers WHERE transfer_id=? AND organization_id=?',
    )
    .bind(id, session.organizationId)
    .first<{ state: string }>();
  if (row && ['abandoning', 'abandoned'].includes(row.state)) {
    await fileArchive().delete(key);
    invalid(
      'Cette préparation a été annulée. Le fragment tardif a été retiré.',
      409,
    );
  }
}

export async function businessFilesStatus(
  session: DeviceSessionContext,
  rawId: unknown,
) {
  const id = transferId(rawId);
  const source = await required(session, id);
  const set = await database()
    .prepare(`SELECT manifest_json,manifest_sha256,state,
    (SELECT COALESCE(json_group_array(json_object('page_index',page_index,'sha256',sha256,'size_bytes',size_bytes,'file_count',file_count)),'[]')
      FROM (SELECT * FROM business_sync_file_pages WHERE transfer_id=? ORDER BY page_index)) AS pages_json,
    (SELECT COUNT(*) FROM business_sync_file_blobs WHERE transfer_id=?) AS total_blobs,
    (SELECT COUNT(*) FROM business_sync_file_blobs WHERE transfer_id=? AND verified_at IS NOT NULL) AS verified_blobs,
    (SELECT COALESCE(json_group_array(json_object('sha256',sha256,'size_bytes',size_bytes)),'[]')
      FROM (SELECT sha256,size_bytes FROM business_sync_file_blobs WHERE transfer_id=? AND verified_at IS NULL ORDER BY sha256 LIMIT 8)) AS pending_json
    FROM business_sync_file_sets WHERE transfer_id=? AND ${ACTIVE}`)
    .bind(id, id, id, id, id, ...activeValues(session, id))
    .first<
      FileSet & {
        pages_json: string;
        total_blobs: number;
        verified_blobs: number;
        pending_json: string;
      }
    >();
  if (!set)
    invalid(
      'Le catalogue de fichiers n’est pas disponible pour cette préparation.',
      409,
    );
  const manifest = businessFileManifest(JSON.parse(set.manifest_json));
  return {
    transfer_id: id,
    organization_id: session.organizationId,
    installation_id: source.installation_id,
    generation: source.generation,
    manifest_sha256: set.manifest_sha256,
    state: set.state,
    uploaded_pages: JSON.parse(set.pages_json) as (FilePage & {
      page_index: number;
    })[],
    file_count: manifest.file_count,
    size_bytes: manifest.size_bytes,
    total_blobs: set.total_blobs,
    verified_blobs: set.verified_blobs,
    pending_blobs: JSON.parse(set.pending_json) as {
      sha256: string;
      size_bytes: number;
    }[],
    replication_active: false,
  };
}
export async function beginBusinessFiles(
  session: DeviceSessionContext,
  rawId: unknown,
  value: unknown,
) {
  const id = transferId(rawId);
  await required(session, id);
  const manifest = businessFileManifest(value);
  const text = JSON.stringify(manifest),
    sha = await sha256Hex(text);
  await database()
    .prepare(`INSERT OR IGNORE INTO business_sync_file_sets(transfer_id,manifest_json,manifest_sha256,state)
    SELECT ?,?,?,? WHERE ${ACTIVE}`)
    .bind(
      id,
      text,
      sha,
      manifest.file_count ? 'cataloguing' : 'uploaded',
      ...activeValues(session, id),
    )
    .run();
  const set = await requiredSet(id);
  if (set.manifest_sha256 !== sha || set.manifest_json !== text)
    invalid('Un autre catalogue est déjà lié à cette préparation.', 409);
  return businessFilesStatus(session, id);
}
async function sealCatalog(session: DeviceSessionContext, id: string) {
  await database()
    .prepare(`UPDATE business_sync_file_sets SET state='uploading' WHERE transfer_id=? AND state='cataloguing'
    AND ${ACTIVE}
    AND (SELECT COUNT(*) FROM business_sync_file_pages WHERE transfer_id=business_sync_file_sets.transfer_id)=json_array_length(manifest_json,'$.pages')
    AND (SELECT COUNT(*) FROM business_sync_file_entries WHERE transfer_id=business_sync_file_sets.transfer_id)=json_extract(manifest_json,'$.file_count')
    AND (SELECT COALESCE(SUM(size_bytes),0) FROM business_sync_file_entries WHERE transfer_id=business_sync_file_sets.transfer_id)=json_extract(manifest_json,'$.size_bytes')`)
    .bind(id, ...activeValues(session, id))
    .run();
}
export async function uploadBusinessFilePage(
  session: DeviceSessionContext,
  rawId: unknown,
  rawIndex: unknown,
  request: Request,
) {
  const id = transferId(rawId),
    index = integer(
      rawIndex,
      Math.ceil(MAX_FILES / BUSINESS_FILES_PER_PAGE) - 1,
    );
  await required(session, id);
  const set = await requiredSet(id),
    manifest = businessFileManifest(JSON.parse(set.manifest_json)),
    page = manifest.pages[index];
  if (!page) invalid('Cette page ne figure pas dans le catalogue.');
  const bytes = await readBytesBodyWithinLimit(request, page.size_bytes);
  if (
    bytes.length !== page.size_bytes ||
    (await sha256Hex(bytes)) !== page.sha256
  )
    invalid('La page de fichiers reçue est altérée.', 409);
  const receipt = () =>
    database()
      .prepare(
        'SELECT sha256,size_bytes,file_count FROM business_sync_file_pages WHERE transfer_id=? AND page_index=?',
      )
      .bind(id, index)
      .first<FilePage>();
  const matches = (saved: FilePage) =>
    saved.sha256 === page.sha256 &&
    saved.size_bytes === page.size_bytes &&
    saved.file_count === page.file_count;
  const previous = await receipt();
  if (previous) {
    if (!matches(previous))
      invalid('Une confirmation de catalogue est contradictoire.', 409);
    await sealCatalog(session, id);
    return businessFilesStatus(session, id);
  }
  if (set.state !== 'cataloguing') invalid('Le catalogue est déjà figé.', 409);
  let input: Record<string, unknown>;
  try {
    input = object(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
  } catch {
    invalid('La page de fichiers est illisible.');
  }
  exact(input, ['version', 'files']);
  if (
    input.version !== manifest.version ||
    !Array.isArray(input.files) ||
    input.files.length !== page.file_count
  )
    invalid('Le nombre de fichiers de la page est incohérent.');
  const entries: FileEntry[] = input.files.map((value) => {
    const file = object(value);
    exact(file, ['path', 'sha256', 'size_bytes']);
    const entry = {
      path: businessFilePath(file.path),
      sha256: businessFileHash(file.sha256),
      size_bytes: integer(file.size_bytes, MAX_FILE_BYTES),
    };
    if (manifest.version === 2) {
      const [root, ...parts] = entry.path.split('/');
      if (!['attachments', 'exports'].includes(root) || parts.length === 0 ||
        (root === 'exports' && parts.length !== 1) ||
        (root === 'attachments' && parts[0].toLowerCase() === '.business-sync-pending'))
        invalid('Le document ne fait pas partie du stockage métier partagé.');
    }
    if ((entry.size_bytes === 0) !== (entry.sha256 === EMPTY_SHA256))
      invalid('L’empreinte d’un fichier vide est incohérente.');
    return entry;
  });
  const db = database();
  const statements: D1PreparedStatement[] = [];
  const blobs = new Map<string, number>();
  for (const entry of entries) {
    if (blobs.has(entry.sha256) && blobs.get(entry.sha256) !== entry.size_bytes)
      invalid('Un même fichier présente plusieurs tailles.');
    blobs.set(entry.sha256, entry.size_bytes);
    statements.push(
      db
        .prepare(`INSERT INTO business_sync_file_entries(transfer_id,path_key,path,sha256,size_bytes,page_index)
      SELECT ?,?,?,?,?,? WHERE ${ACTIVE} AND EXISTS(SELECT 1 FROM business_sync_file_sets WHERE transfer_id=? AND state='cataloguing')`)
        .bind(
          id,
          entry.path.toLowerCase(),
          entry.path,
          entry.sha256,
          entry.size_bytes,
          index,
          ...activeValues(session, id),
          id,
        ),
    );
  }
  for (const [sha, size] of blobs)
    statements.push(
      db
        .prepare(`INSERT OR IGNORE INTO business_sync_file_blobs(transfer_id,sha256,size_bytes,verified_at)
    SELECT ?,?,?,? WHERE ${ACTIVE} AND EXISTS(SELECT 1 FROM business_sync_file_sets WHERE transfer_id=? AND state='cataloguing')`)
        .bind(
          id,
          sha,
          size,
          size === 0 ? new Date().toISOString() : null,
          ...activeValues(session, id),
          id,
        ),
    );
  // Abort the whole batch on inconsistent deduplication, totals or missing bytes.
  statements.push(
    db
      .prepare(`INSERT INTO business_sync_file_pages(transfer_id,page_index,sha256,size_bytes,file_count)
    SELECT NULL,0,'',0,0 WHERE
      EXISTS(SELECT 1 FROM business_sync_file_entries e JOIN business_sync_file_blobs b ON b.transfer_id=e.transfer_id AND b.sha256=e.sha256 WHERE e.transfer_id=? AND e.size_bytes<>b.size_bytes)
      OR (SELECT COUNT(*) FROM business_sync_file_entries WHERE transfer_id=?)>?
      OR (SELECT COALESCE(SUM(size_bytes),0) FROM business_sync_file_entries WHERE transfer_id=?)>?
      OR ((SELECT COUNT(*) FROM business_sync_file_entries WHERE transfer_id=?)=? AND (SELECT COALESCE(SUM(size_bytes),0) FROM business_sync_file_entries WHERE transfer_id=?)<>?)`)
      .bind(
        id,
        id,
        manifest.file_count,
        id,
        manifest.size_bytes,
        id,
        manifest.file_count,
        id,
        manifest.size_bytes,
      ),
  );
  statements.push(
    db
      .prepare(`INSERT INTO business_sync_file_pages(transfer_id,page_index,sha256,size_bytes,file_count)
    SELECT ?,?,?,?,? WHERE ${ACTIVE} AND EXISTS(SELECT 1 FROM business_sync_file_sets WHERE transfer_id=? AND state='cataloguing')`)
      .bind(
        id,
        index,
        page.sha256,
        page.size_bytes,
        page.file_count,
        ...activeValues(session, id),
        id,
      ),
  );
  try {
    await db.batch(statements);
  } catch (cause) {
    const saved = await receipt();
    if (!saved || !matches(saved)) {
      const error = new AccountPublicError(
        'La page contient des références en double ou des totaux incohérents. Aucun fichier de cette page n’a été ajouté.',
        409,
      );
      error.cause = cause;
      throw error;
    }
  }
  if (!(await receipt()))
    invalid('La préparation a changé pendant la réception du catalogue.', 409);
  await sealCatalog(session, id);
  return businessFilesStatus(session, id);
}

async function requiredBlob(
  session: DeviceSessionContext,
  id: string,
  sha: string,
) {
  const source = await required(session, id),
    set = await requiredSet(id);
  if (!['uploading', 'uploaded'].includes(set.state))
    invalid('Le catalogue complet est nécessaire avant les fichiers.', 409);
  const blob = await database()
    .prepare(
      'SELECT sha256,size_bytes,verified_at FROM business_sync_file_blobs WHERE transfer_id=? AND sha256=?',
    )
    .bind(id, sha)
    .first<FileBlob>();
  if (!blob) invalid('Ce fichier ne figure pas dans le catalogue.', 404);
  return { source, blob };
}
export async function businessFileStatus(
  session: DeviceSessionContext,
  rawId: unknown,
  rawSha: unknown,
) {
  const id = transferId(rawId),
    sha = businessFileHash(rawSha);
  const { source, blob } = await requiredBlob(session, id, sha);
  const parts = await database()
    .prepare(
      'SELECT part_index,sha256,size_bytes FROM business_sync_file_parts WHERE transfer_id=? AND file_sha256=? ORDER BY part_index',
    )
    .bind(id, sha)
    .all();
  return {
    transfer_id: id,
    organization_id: session.organizationId,
    installation_id: source.installation_id,
    generation: source.generation,
    sha256: sha,
    size_bytes: blob.size_bytes,
    verified: blob.verified_at !== null,
    uploaded_parts: parts.results ?? [],
    replication_active: false,
  };
}
async function storedBytes(key: string, expected: number) {
  const blob = await fileArchive().get(key);
  if (!blob || blob.size !== expected)
    invalid('Un fragment de fichier conservé est absent ou incohérent.', 409);
  return readBytesBodyWithinLimit(
    new Request('https://storage.invalid/fragment', {
      method: 'POST',
      body: blob.body,
      duplex: 'half',
    } as RequestInit),
    expected,
  );
}
export async function uploadBusinessFilePart(
  session: DeviceSessionContext,
  rawId: unknown,
  rawSha: unknown,
  rawIndex: unknown,
  request: Request,
) {
  const id = transferId(rawId),
    sha = businessFileHash(rawSha),
    index = integer(rawIndex, MAX_FILE_BYTES / BUSINESS_FILE_PART_BYTES - 1);
  const { blob } = await requiredBlob(session, id, sha);
  const expectedSize = Math.min(
    BUSINESS_FILE_PART_BYTES,
    blob.size_bytes - index * BUSINESS_FILE_PART_BYTES,
  );
  if (expectedSize <= 0) invalid('Ce fragment ne figure pas dans le fichier.');
  const expectedSha = businessFileHash(request.headers.get('x-content-sha256'));
  const bytes = await readBytesBodyWithinLimit(request, expectedSize);
  if (bytes.length !== expectedSize || (await sha256Hex(bytes)) !== expectedSha)
    invalid('Le fragment de fichier reçu est altéré.', 409);
  const receipt = () =>
    database()
      .prepare(
        'SELECT part_index,sha256,size_bytes,object_key FROM business_sync_file_parts WHERE transfer_id=? AND file_sha256=? AND part_index=?',
      )
      .bind(id, sha, index)
      .first<FilePart>();
  const matches = (part: FilePart) =>
    part.sha256 === expectedSha &&
    part.size_bytes === expectedSize &&
    part.object_key === key;
  const key = partKey(session.organizationId, id, sha, index),
    previous = await receipt();
  if (previous) {
    if (!matches(previous))
      invalid('Ce fragment a déjà été reçu avec un autre contenu.', 409);
    const retained = await storedBytes(key, expectedSize);
    if (
      retained.length !== expectedSize ||
      (await sha256Hex(retained)) !== expectedSha
    )
      invalid('Le fragment conservé doit être réconcilié.', 409);
    return businessFileStatus(session, id, sha);
  }
  if (blob.verified_at !== null) invalid('Ce fichier a déjà été vérifié.', 409);
  try {
    // The fixed key lets cancellation remove even a lost receipt. Conditional
    // creation prevents a competing request from replacing confirmed bytes.
    const created = await fileArchive().put(key, bytes, {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: 'application/octet-stream' },
    });
    if (!created) {
      const retained = await storedBytes(key, expectedSize);
      if (
        retained.length !== expectedSize ||
        (await sha256Hex(retained)) !== expectedSha
      )
        invalid('Un autre contenu occupe déjà ce fragment.', 409);
    }
    await rejectCancelled(session, id, key);
    await database()
      .prepare(`INSERT OR IGNORE INTO business_sync_file_parts(transfer_id,file_sha256,part_index,sha256,size_bytes,object_key)
      SELECT ?,?,?,?,?,? WHERE ${ACTIVE} AND EXISTS(SELECT 1 FROM business_sync_file_sets WHERE transfer_id=? AND state='uploading')
      AND EXISTS(SELECT 1 FROM business_sync_file_blobs WHERE transfer_id=? AND sha256=? AND verified_at IS NULL)`)
      .bind(
        id,
        sha,
        index,
        expectedSha,
        expectedSize,
        key,
        ...activeValues(session, id),
        id,
        id,
        sha,
      )
      .run();
    const saved = await receipt();
    if (!saved || !matches(saved))
      invalid(
        'La confirmation du fragment n’a pas été conservée. Reprenez le même envoi.',
        409,
      );
    return await businessFileStatus(session, id, sha);
  } finally {
    await rejectCancelled(session, id, key);
  }
}
export async function verifyBusinessFile(
  session: DeviceSessionContext,
  rawId: unknown,
  rawSha: unknown,
) {
  const id = transferId(rawId),
    sha = businessFileHash(rawSha),
    { blob } = await requiredBlob(session, id, sha);
  if (blob.verified_at !== null) return businessFileStatus(session, id, sha);
  const parts =
    (
      await database()
        .prepare(
          'SELECT part_index,sha256,size_bytes,object_key FROM business_sync_file_parts WHERE transfer_id=? AND file_sha256=? ORDER BY part_index',
        )
        .bind(id, sha)
        .all<FilePart>()
    ).results ?? [];
  if (parts.length !== Math.ceil(blob.size_bytes / BUSINESS_FILE_PART_BYTES))
    invalid('Des fragments du fichier manquent encore.', 409);
  const digest = createHash('sha256');
  let size = 0;
  for (const [index, part] of parts.entries()) {
    const expected = Math.min(BUSINESS_FILE_PART_BYTES, blob.size_bytes - size);
    if (
      part.part_index !== index ||
      part.size_bytes !== expected ||
      part.object_key !== partKey(session.organizationId, id, sha, index)
    )
      invalid('Les fragments conservés sont incohérents.', 409);
    const bytes = await storedBytes(part.object_key, expected);
    if (bytes.length !== expected || (await sha256Hex(bytes)) !== part.sha256)
      invalid('Un fragment conservé est altéré.', 409);
    size += bytes.length;
    digest.update(bytes);
  }
  if (size !== blob.size_bytes || digest.digest('hex') !== sha)
    invalid('Le fichier complet ne correspond pas à la pièce d’origine.', 409);
  await database()
    .prepare(`UPDATE business_sync_file_blobs SET verified_at=? WHERE transfer_id=? AND sha256=? AND verified_at IS NULL
    AND ${ACTIVE} AND EXISTS(SELECT 1 FROM business_sync_file_sets WHERE transfer_id=? AND state='uploading')`)
    .bind(new Date().toISOString(), id, sha, ...activeValues(session, id), id)
    .run();
  return businessFileStatus(session, id, sha);
}
export async function completeBusinessFiles(
  session: DeviceSessionContext,
  rawId: unknown,
) {
  const id = transferId(rawId);
  await required(session, id);
  await sealCatalog(session, id);
  const set = await requiredSet(id);
  if (set.state === 'cataloguing')
    invalid('Le catalogue de fichiers est encore incomplet.', 409);
  await database()
    .prepare(`UPDATE business_sync_file_sets SET state='uploaded' WHERE transfer_id=? AND state='uploading' AND ${ACTIVE}
    AND NOT EXISTS(SELECT 1 FROM business_sync_file_blobs WHERE transfer_id=? AND verified_at IS NULL)`)
    .bind(id, ...activeValues(session, id), id)
    .run();
  const result = await businessFilesStatus(session, id);
  if (result.state !== 'uploaded')
    invalid(
      'Des fichiers attendent encore leur envoi ou leur vérification.',
      409,
    );
  return result;
}

export async function cleanupBootstrapFiles(organization: string, id: string) {
  const cancelled = await database()
    .prepare(
      "SELECT 1 FROM business_sync_transfers WHERE transfer_id=? AND organization_id=? AND state IN ('abandoning','abandoned')",
    )
    .bind(id, organization)
    .first();
  if (!cancelled)
    invalid(
      'Un historique actif ne peut pas perdre ses pièces par ce parcours.',
      409,
    );
  // R2 listing also finds blobs whose process ended before writing its receipt.
  // Repeat cancellation can sweep an abandoned transfer without its D1 catalog.
  let cursor: string | undefined;
  do {
    const page = await fileArchive().list({
      prefix: prefix(organization, id),
      cursor,
      limit: 1000,
    });
    for (let index = 0; index < page.objects.length; index += 100)
      await fileArchive().delete(
        page.objects.slice(index, index + 100).map((item) => item.key),
      );
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  await database().batch(
    [
      'business_sync_file_parts',
      'business_sync_file_entries',
      'business_sync_file_pages',
      'business_sync_file_blobs',
      'business_sync_file_sets',
    ].map((table) =>
      database()
        .prepare(
          `DELETE FROM ${table} WHERE transfer_id=? AND EXISTS(SELECT 1 FROM business_sync_transfers WHERE transfer_id=? AND organization_id=? AND state IN ('abandoning','abandoned'))`,
        )
        .bind(id, id, organization),
    ),
  );
}
