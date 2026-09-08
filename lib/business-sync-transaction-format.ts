import { AccountPublicError } from './account-security';
import {
  businessRowImage,
  businessSyncContractHash,
  businessSyncTransferId,
} from './business-sync-bootstrap';
import { businessFileHash, businessFilePath } from './business-sync-files';
import { sourceRowid } from './business-sync-order';

export const TRANSACTION_CHUNK_BYTES = 4 * 1024 * 1024;
export const TRANSACTION_MANIFEST_BYTES = 8 * 1024 * 1024;
function fail(message: string): never {
  throw new AccountPublicError(message);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('La transaction est illisible.');
  return value as Record<string, unknown>;
}
function fields(v: Record<string, unknown>, names: string[]) {
  if (Object.keys(v).sort().join(',') !== [...names].sort().join(','))
    fail('La transaction contient des champs inconnus ou incomplets.');
}
function integer(v: unknown, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max)
    fail('Une limite de transaction est dépassée.');
  return v;
}
function text(v: unknown, max = 200): string {
  if (typeof v !== 'string' || !v || !v.isWellFormed() || v.length > max)
    fail('Une référence de transaction est invalide.');
  return v;
}
export function sequence(v: unknown): string {
  const n = sourceRowid(v, '', {});
  if (BigInt(n) < BigInt(1))
    fail('Une séquence du journal doit être positive.');
  return n;
}
export function canonicalJson(
  raw: unknown,
  max: number,
): Record<string, unknown> {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > max)
    fail('Les données de transaction dépassent la taille autorisée.');
  let value: Record<string, unknown>;
  try {
    value = object(JSON.parse(raw));
  } catch {
    fail('Les données de transaction sont illisibles.');
  }
  // Envelopes contain only bounded integer metadata and original row JSON
  // strings. This catches duplicate keys without reserializing those rows.
  if (JSON.stringify(value) !== raw)
    fail('L’encodage de la transaction est ambigu ou non canonique.');
  return value;
}
export type TransactionManifest = {
  format: 'zentra-business-transaction';
  version: 1;
  schema_version: 60;
  contract_sha256: string;
  organization_id: string;
  installation_id: string;
  generation: string;
  capture_generation: string;
  bootstrap_transfer_id: string;
  transaction_id: string;
  base_revision: number;
  first_sequence: string;
  last_sequence: string;
  change_count: number;
  size_bytes: number;
  chunks: { sha256: string; size_bytes: number; change_count: number }[];
  files: { sha256: string; size_bytes: number }[];
};
export async function transactionManifest(
  raw: unknown,
): Promise<TransactionManifest> {
  const v = canonicalJson(raw, TRANSACTION_MANIFEST_BYTES);
  fields(v, [
    'format',
    'version',
    'schema_version',
    'contract_sha256',
    'organization_id',
    'installation_id',
    'generation',
    'capture_generation',
    'bootstrap_transfer_id',
    'transaction_id',
    'base_revision',
    'first_sequence',
    'last_sequence',
    'change_count',
    'size_bytes',
    'chunks',
    'files',
  ]);
  if (
    v.format !== 'zentra-business-transaction' ||
    v.version !== 1 ||
    v.schema_version !== 60 ||
    v.contract_sha256 !== (await businessSyncContractHash())
  )
    fail('Cette transaction ne correspond pas au contrat de synchronisation.');
  const first = sequence(v.first_sequence),
    last = sequence(v.last_sequence);
  const count = integer(v.change_count, 1, 200_000),
    size = integer(v.size_bytes, 1, 512 * 1024 * 1024);
  if (BigInt(last) - BigInt(first) + BigInt(1) < BigInt(count))
    fail('Les bornes de la transaction sont incohérentes.');
  if (!Array.isArray(v.chunks) || !v.chunks.length || v.chunks.length > 1024)
    fail('Le nombre de fragments est invalide.');
  const chunks = v.chunks.map((raw) => {
    const c = object(raw);
    fields(c, ['sha256', 'size_bytes', 'change_count']);
    return {
      sha256: businessFileHash(c.sha256),
      size_bytes: integer(c.size_bytes, 1, TRANSACTION_CHUNK_BYTES),
      change_count: integer(c.change_count, 1, 200),
    };
  });
  if (
    chunks.reduce((sum, c) => sum + c.size_bytes, 0) !== size ||
    chunks.reduce((sum, c) => sum + c.change_count, 0) !== count
  )
    fail('Les fragments ne couvrent pas exactement la transaction.');
  if (!Array.isArray(v.files) || v.files.length > 50_000)
    fail('Le catalogue des documents est trop volumineux.');
  let previous = '';
  let total = 0;
  const files = v.files.map((raw) => {
    const f = object(raw);
    fields(f, ['sha256', 'size_bytes']);
    const sha256 = businessFileHash(f.sha256),
      size_bytes = integer(f.size_bytes, 0, 512 * 1024 * 1024);
    if (sha256 <= previous)
      fail(
        'Le catalogue des documents contient un doublon ou un ordre invalide.',
      );
    previous = sha256;
    total += size_bytes;
    return { sha256, size_bytes };
  });
  if (total > 10 * 1024 * 1024 * 1024)
    fail('Les documents dépassent la limite de transfert.');
  return {
    format: 'zentra-business-transaction',
    version: 1,
    schema_version: 60,
    contract_sha256: v.contract_sha256 as string,
    organization_id: text(v.organization_id),
    installation_id: businessSyncTransferId(v.installation_id),
    generation: businessSyncTransferId(v.generation),
    capture_generation: businessSyncTransferId(v.capture_generation),
    bootstrap_transfer_id: businessSyncTransferId(v.bootstrap_transfer_id),
    transaction_id: businessSyncTransferId(v.transaction_id),
    base_revision: integer(v.base_revision, 1, Number.MAX_SAFE_INTEGER),
    first_sequence: first,
    last_sequence: last,
    change_count: count,
    size_bytes: size,
    chunks,
    files,
  };
}
export type TransactionFile = {
  root: 'attachments' | 'exports';
  path: string;
  sha256: string;
  size_bytes: number;
};
export type TransactionChange = {
  sequence: string;
  table: string;
  key_json: string;
  operation: 'insert' | 'update' | 'delete';
  before_json: string | null;
  after_json: string | null;
  source_rowid: string;
  files_before: TransactionFile[];
  files_after: TransactionFile[];
};
function imageFiles(
  table: string,
  data: Record<string, unknown> | null,
  raw: unknown,
  available: Map<string, number>,
): TransactionFile[] {
  if (!Array.isArray(raw) || raw.length > 1)
    fail('Les preuves de document sont invalides.');
  const string = (name: string) => text(data?.[name], 4096);
  let root = 'attachments',
    path: string | undefined,
    expectedHash: unknown,
    expectedSize: unknown;
  if (data) {
    if (table === 'attachments') {
      path = string('stored_name');
      expectedHash = data.sha256;
      expectedSize = data.size_bytes;
    } else if (table === 'company_brand_assets') {
      path = `branding/${string('file_name')}`;
      expectedHash = data.sha256;
      expectedSize = data.byte_size;
    } else if (
      table === 'payroll_document_imports' ||
      (table === 'settings' &&
        typeof data.logo_path === 'string' &&
        data.logo_path.trim())
    ) {
      const parts = string(table === 'settings' ? 'logo_path' : 'stored_path')
        .replaceAll('\\', '/')
        .split('/');
      if (parts.includes('..'))
        fail('Une référence de document sort de son dossier.');
      const name = parts.pop();
      const folder = table === 'settings' ? 'branding' : 'payroll-imports';
      if (table !== 'settings' && parts.pop() !== folder)
        fail('La fiche importée ne correspond pas au stockage géré.');
      path = `${folder}/${name}`;
      if (table === 'payroll_document_imports') {
        expectedHash = data.file_sha256;
        expectedSize = data.file_size;
      } else
        expectedHash = /^branding\/logo-([a-f0-9]{64})\.[^/]+$/.exec(path)?.[1];
    } else if (
      table === 'vat_return_exports' ||
      table === 'closing_package_exports'
    ) {
      root = 'exports';
      path = string('file_name');
      if (table === 'vat_return_exports') expectedHash = data.xml_sha256;
    }
  }
  if (path === undefined) {
    if (raw.length) fail('Cette ligne ne référence aucun document.');
    return [];
  }
  businessFilePath(path);
  if (/^\.business-sync-pending(?:\/|$)/i.test(path))
    fail('Le cache privé ne peut pas devenir un document partagé.');
  if (raw.length !== 1) fail('La copie du document référencé est absente.');
  const f = object(raw[0]);
  fields(f, ['root', 'path', 'sha256', 'size_bytes']);
  const hash = businessFileHash(f.sha256),
    size = integer(f.size_bytes, 0, 512 * 1024 * 1024);
  if (
    f.root !== root ||
    f.path !== path ||
    available.get(hash) !== size ||
    (expectedHash && expectedHash !== hash) ||
    (expectedSize !== undefined && expectedSize !== size)
  )
    fail('La preuve du document ne correspond pas à son image d’origine.');
  return [
    {
      root: root as TransactionFile['root'],
      path,
      sha256: hash,
      size_bytes: size,
    },
  ];
}
export function transactionChanges(
  bytes: Uint8Array,
  manifest: TransactionManifest,
  index: number,
): TransactionChange[] {
  let raw: string;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('Le fragment n’est pas un texte UTF-8 valide.');
  }
  const v = canonicalJson(raw, TRANSACTION_CHUNK_BYTES);
  fields(v, ['version', 'changes']);
  const expected = manifest.chunks[index];
  if (
    v.version !== 1 ||
    !expected ||
    !Array.isArray(v.changes) ||
    v.changes.length !== expected.change_count
  )
    fail('Le fragment ne correspond pas à la transaction préparée.');
  let previous = BigInt(0);
  const latest = new Map<string, string | null>();
  const files = new Map(manifest.files.map((f) => [f.sha256, f.size_bytes]));
  return v.changes.map((raw) => {
    const c = object(raw);
    fields(c, [
      'sequence',
      'table',
      'key_json',
      'operation',
      'before_json',
      'after_json',
      'source_rowid',
      'files_before',
      'files_after',
    ]);
    const seq = sequence(c.sequence),
      n = BigInt(seq);
    if (
      n <= previous ||
      n < BigInt(manifest.first_sequence) ||
      n > BigInt(manifest.last_sequence)
    )
      fail('L’ordre des modifications est incohérent.');
    previous = n;
    const before =
      c.before_json === null
        ? null
        : businessRowImage({
            table: c.table,
            key_json: c.key_json,
            row_json: c.before_json,
          });
    const after =
      c.after_json === null
        ? null
        : businessRowImage({
            table: c.table,
            key_json: c.key_json,
            row_json: c.after_json,
          });
    const image = after ?? before;
    if (!image) fail('Une modification ne contient aucune image.');
    if (
      !(
        (c.operation === 'insert' && !before && after) ||
        (c.operation === 'update' && before && after) ||
        (c.operation === 'delete' && before && !after)
      )
    )
      fail('Le type de modification ne correspond pas à ses images.');
    if (c.operation === 'update' && before?.row_json === after?.row_json)
      fail('Une modification ne change aucune donnée.');
    const position = sourceRowid(c.source_rowid, image.table, image.data);
    if (before) sourceRowid(position, before.table, before.data);
    const key = `${image.table}\0${image.key_json}`;
    if (latest.has(key) && latest.get(key) !== (before?.row_json ?? null))
      fail(
        'Deux modifications successives ne partagent pas la même image intermédiaire.',
      );
    latest.set(key, after?.row_json ?? null);
    return {
      sequence: seq,
      table: image.table,
      key_json: image.key_json,
      operation: c.operation as TransactionChange['operation'],
      before_json: before?.row_json ?? null,
      after_json: after?.row_json ?? null,
      source_rowid: position,
      files_before: imageFiles(
        image.table,
        before?.data ?? null,
        c.files_before,
        files,
      ),
      files_after: imageFiles(
        image.table,
        after?.data ?? null,
        c.files_after,
        files,
      ),
    };
  });
}
