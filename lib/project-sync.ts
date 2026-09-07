import { AccountPublicError, sha256Hex } from '@/lib/account-security';
import { readBytesBodyWithinLimit } from '@/lib/request-body';
import { database, fileArchive } from '@/lib/runtime';

export const MAX_PROJECT_FILE_BYTES = 25 * 1024 * 1024;
export type ProjectDocumentEvent = {
  sequence: number;
  document_id: string;
  project_id: string;
  project_name: string;
  action: 'stored' | 'deleted';
  original_name: string;
  media_type: string;
  size_bytes: number;
  sha256: string;
  object_key: string;
  created_at: string;
};
export function documentId(value: string | null): string {
  if (
    !value ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new AccountPublicError(
      'Référence de document ou de projet invalide.',
    );
  return value.toLowerCase();
}
function headerText(request: Request, name: string, max: number) {
  let value: string;
  try {
    value = decodeURIComponent(request.headers.get(name) || '').trim();
  } catch {
    throw new AccountPublicError('Nom de fichier ou de projet invalide.');
  }
  let control = false;
  for (let index = 0; index < value.length; index++)
    if (value.charCodeAt(index) < 32 || value.charCodeAt(index) === 127)
      control = true;
  if (!value || value.length > max || control)
    throw new AccountPublicError('Nom de fichier ou de projet invalide.');
  return value;
}
function mediaType(name: string, bytes: Uint8Array) {
  const extension = name.split('.').at(-1)?.toLowerCase();
  const prefix = new TextDecoder('latin1').decode(bytes.slice(0, 16));
  const mapping: Record<string, [string, boolean]> = {
    pdf: ['application/pdf', prefix.startsWith('%PDF-')],
    png: [
      'image/png',
      [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v),
    ],
    jpg: [
      'image/jpeg',
      bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255,
    ],
    jpeg: [
      'image/jpeg',
      bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255,
    ],
    webp: [
      'image/webp',
      prefix.startsWith('RIFF') && prefix.slice(8, 12) === 'WEBP',
    ],
    heic: [
      'image/heic',
      prefix.slice(4, 8) === 'ftyp' &&
        /^(heic|heix|hevc|hevx|mif1|msf1)$/.test(prefix.slice(8, 12)),
    ],
    heif: [
      'image/heic',
      prefix.slice(4, 8) === 'ftyp' &&
        /^(heic|heix|hevc|hevx|mif1|msf1)$/.test(prefix.slice(8, 12)),
    ],
  };
  if (extension === 'txt' || extension === 'csv') {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (text.includes('\0')) throw new Error();
    } catch {
      throw new AccountPublicError('Le document texte est illisible.');
    }
    return extension === 'txt' ? 'text/plain' : 'text/csv';
  }
  const office: Record<string, string> = {
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    odt: 'application/vnd.oasis.opendocument.text',
    ods: 'application/vnd.oasis.opendocument.spreadsheet',
    odp: 'application/vnd.oasis.opendocument.presentation',
  };
  if (
    extension &&
    office[extension] &&
    bytes[0] === 80 &&
    bytes[1] === 75 &&
    bytes[2] === 3 &&
    bytes[3] === 4
  )
    return office[extension];
  if (extension && mapping[extension]?.[1]) return mapping[extension][0];
  throw new AccountPublicError('Format du document non pris en charge.');
}
export function publicDocument(row: ProjectDocumentEvent) {
  const { object_key: _key, ...metadata } = row;
  return metadata;
}
export async function storedDocument(org: string, id: string) {
  return database()
    .prepare(
      "SELECT * FROM project_document_events WHERE organization_id=? AND document_id=? AND action='stored'",
    )
    .bind(org, id)
    .first<ProjectDocumentEvent>();
}
async function isDeleted(org: string, id: string) {
  return Boolean(
    await database()
      .prepare(
        "SELECT 1 FROM project_document_events WHERE organization_id=? AND document_id=? AND action='deleted'",
      )
      .bind(org, id)
      .first(),
  );
}
export async function storeDocument(request: Request, org: string) {
  const url = new URL(request.url);
  const id = documentId(url.searchParams.get('id'));
  const project = documentId(url.searchParams.get('projectId'));
  const name = headerText(request, 'X-Zentra-Name', 255);
  if (/[\\/]/.test(name))
    throw new AccountPublicError('Nom de fichier invalide.');
  const projectName = headerText(request, 'X-Zentra-Project', 255);
  const hash = request.headers.get('X-Zentra-Sha256');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash))
    throw new AccountPublicError('Empreinte de fichier invalide.');
  if (await isDeleted(org, id)) return { deleted: true };
  const bytes = await readBytesBodyWithinLimit(request, MAX_PROJECT_FILE_BYTES);
  if (!bytes.length) throw new AccountPublicError('Le fichier est vide.');
  if ((await sha256Hex(bytes)) !== hash)
    throw new AccountPublicError('Le fichier reçu est incomplet ou altéré.');
  const mime = mediaType(name, bytes);
  const previous = await storedDocument(org, id);
  const matches = (row: ProjectDocumentEvent) =>
    row.project_id === project &&
    row.sha256 === hash &&
    row.original_name === name &&
    row.size_bytes === bytes.length;
  if (previous) {
    if (!matches(previous))
      throw new AccountPublicError(
        'Cette référence contient déjà un autre document. Ajoutez la nouvelle version comme un nouveau fichier.',
        409,
      );
    return { document: publicDocument(previous), alreadyStored: true };
  }
  const count = await database()
    .prepare(
      "SELECT COUNT(*) AS count FROM project_document_events s WHERE organization_id=? AND project_id=? AND action='stored' AND NOT EXISTS(SELECT 1 FROM project_document_events d WHERE d.organization_id=s.organization_id AND d.document_id=s.document_id AND d.action='deleted')",
    )
    .bind(org, project)
    .first<{ count: number }>();
  if ((count?.count || 0) >= 1000)
    throw new AccountPublicError(
      'Ce projet contient déjà 1 000 fichiers.',
      409,
    );
  const key = `project-documents/${org}/${project}/${id}/${hash}`;
  await fileArchive().put(key, bytes, {
    httpMetadata: { contentType: mime, cacheControl: 'private, no-store' },
    customMetadata: { sha256: hash },
  });
  await database()
    .prepare(`INSERT OR IGNORE INTO project_document_events(organization_id,document_id,project_id,project_name,action,original_name,media_type,size_bytes,sha256,object_key,created_at)
    SELECT ?,?,?,?,'stored',?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM project_document_events WHERE organization_id=? AND document_id=? AND action='deleted')`)
    .bind(
      org,
      id,
      project,
      projectName,
      name,
      mime,
      bytes.length,
      hash,
      key,
      new Date().toISOString(),
      org,
      id,
    )
    .run();
  if (await isDeleted(org, id)) {
    await fileArchive().delete(key);
    return { deleted: true };
  }
  const saved = await storedDocument(org, id);
  if (!saved || !matches(saved)) {
    // A simultaneous upload may have won with different content. Never remove its object.
    if (saved?.object_key !== key) await fileArchive().delete(key);
    throw new AccountPublicError(
      'Une autre version utilise déjà cette référence.',
      409,
    );
  }
  return { document: publicDocument(saved), alreadyStored: false };
}
export async function deleteDocument(org: string, id: string, project: string) {
  const previous = await storedDocument(org, id);
  if (previous && previous.project_id !== project)
    throw new AccountPublicError('Document introuvable.', 404);
  // A tombstone also records deletion before an offline upload arrives.
  await database()
    .prepare(`INSERT OR IGNORE INTO project_document_events(organization_id,document_id,project_id,project_name,action,original_name,media_type,size_bytes,sha256,object_key,created_at)
    VALUES(?,?,?,?,'deleted',?,?,0,?,?,?)`)
    .bind(
      org,
      id,
      project,
      previous?.project_name || 'Projet',
      previous?.original_name || '',
      previous?.media_type || '',
      previous?.sha256 || '',
      previous?.object_key || '',
      new Date().toISOString(),
    )
    .run();
  if (previous) await fileArchive().delete(previous.object_key);
}
export async function downloadDocument(org: string, id: string) {
  if (await isDeleted(org, id))
    throw new AccountPublicError('Ce document a été supprimé.', 410);
  const row = await storedDocument(org, id);
  if (!row) throw new AccountPublicError('Document introuvable.', 404);
  const file = await fileArchive().get(row.object_key);
  if (!file)
    throw new AccountPublicError(
      'Ce fichier est momentanément indisponible. La synchronisation réessaiera.',
      503,
    );
  return { row, file };
}
