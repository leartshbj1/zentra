/** Test-only transport fixture. Actual native schema executes in Node SQLite;
 * ZIP/DEFLATE/CRC/hashes are real. Neither a Rust writer nor PG is simulated as
 * a production proof, and the valid empty sidecar is not SQLite equality. */
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import type { DeviceSessionContext } from '@/lib/account';
import { BACKUP_CHUNK_BYTES, backupManifest } from '@/lib/workspace-backup';
import { makeCanonicalQuoteFixture } from './canonical-quote.fixture';
import type { PublicationAttempt } from './publication-ledger-types';

const hash = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
function crc(bytes: Uint8Array) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++)
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
export function buildConfirmationPublicationTransport(
  sqlite: Uint8Array,
  source: PublicationAttempt,
  contentVersion: 0 | 1 = 0,
  attachments: readonly { name: string; bytes: Uint8Array }[] = [],
) {
  const company = {
    country: 'CH',
    currency: 'CHF',
    onboardingComplete: true,
    vatRegistered: true,
    defaultVatBp: 810,
    paymentTermsDays: 30,
    quoteValidityDays: 30,
    updatedAt: '2026-10-11T12:00:01Z',
  };
  const resources = { company, customers: [], articles: [] };
  const sidecar = Buffer.from(
    JSON.stringify({
      format: 'zentra-action-resources',
      version: 1,
      schemaVersion: 62,
      organizationId: source.organizationId,
      snapshotId: source.snapshotId,
      baseRevision: source.baseRevision,
      resources,
      resourcesHash: hash(JSON.stringify([1, Object.values(company), [], []])),
    }),
  );
  const internalManifest = Buffer.from(
    JSON.stringify({
      format: 'zentra-backup',
      format_version: 2,
      app_version: '1.90.15',
      created_at: company.updatedAt,
      database_file: 'database.sqlite3',
      attachments_prefix: 'attachments/',
      action_engine_resources: {
        format: 'zentra-action-resources',
        version: 1,
        path: 'automation/resources.v1.json',
        sha256: hash(sidecar),
        size_bytes: sidecar.length,
        customer_count: 0,
        article_count: 0,
      },
    }),
  );
  const files = [
    { name: 'manifest.json', bytes: internalManifest, method: 0 },
    { name: 'automation/resources.v1.json', bytes: sidecar, method: 0 },
    { name: 'database.sqlite3', bytes: sqlite, method: 8 },
    ...attachments.map((file) => ({ ...file, method: 8 })),
  ];
  let offset = 0,
    centralLength = 0;
  const local: Uint8Array[] = [],
    central: Uint8Array[] = [];
  for (const file of files) {
    const name = Buffer.from(file.name),
      compressed = file.method === 8 ? deflateRawSync(file.bytes) : file.bytes;
    const h = Buffer.alloc(30),
      c = Buffer.alloc(46),
      checksum = crc(file.bytes);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(file.method, 8);
    h.writeUInt32LE(checksum, 14);
    h.writeUInt32LE(compressed.length, 18);
    h.writeUInt32LE(file.bytes.length, 22);
    h.writeUInt16LE(name.length, 26);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE((3 << 8) | 20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(file.method, 10);
    c.writeUInt32LE(checksum, 16);
    c.writeUInt32LE(compressed.length, 20);
    c.writeUInt32LE(file.bytes.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE((0o100600 << 16) >>> 0, 38);
    c.writeUInt32LE(offset, 42);
    local.push(h, name, compressed);
    central.push(c, name);
    offset += h.length + name.length + compressed.length;
    centralLength += c.length + name.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralLength, 12);
  end.writeUInt32LE(offset, 16);
  const bytes = new Uint8Array(Buffer.concat([...local, ...central, end]));
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for (let start = 0; start < bytes.length; start += BACKUP_CHUNK_BYTES)
    chunks.push(bytes.slice(start, start + BACKUP_CHUNK_BYTES));
  const manifest = backupManifest({
    format: 'zentra-cloud-backup',
    version: 1,
    app_version: '1.90.15',
    sha256: hash(bytes),
    size_bytes: bytes.length,
    chunks: chunks.map((part) => ({
      sha256: hash(part),
      size_bytes: part.length,
    })),
  });
  const attempt: PublicationAttempt = {
    ...source,
    archiveSha256: manifest.sha256,
    manifestSha256: hash(JSON.stringify(manifest)),
    sizeBytes: manifest.size_bytes,
  };
  const result = {
    committed: true,
    revision: attempt.baseRevision + 1,
    snapshotId: attempt.snapshotId,
  };
  const fact = {
    operationId: attempt.id,
    organizationId: attempt.organizationId,
    snapshotId: attempt.snapshotId,
    installationId: attempt.installationId,
    userId: attempt.userId,
    baseRevision: attempt.baseRevision,
    state: 'committed',
    manifest,
    sizeBytes: manifest.size_bytes,
    contentVersion,
    result,
  };
  const snapshot = {
    id: attempt.snapshotId,
    organization_id: attempt.organizationId,
    installation_id: attempt.installationId,
    created_by: attempt.userId,
    base_revision: attempt.baseRevision,
    revision: result.revision,
    manifest,
    size_bytes: manifest.size_bytes,
    content_version: contentVersion,
  };
  const pendingAttempt: PublicationAttempt = {
    ...attempt,
    state: 'pending',
    result: null,
    settledAt: null,
  };
  return { bytes, chunks, manifest, attempt, pendingAttempt, fact, snapshot };
}
export function makeConfirmationPublicationFixture(
  kind: 'new' | 'existing' = 'new',
) {
  const native = makeCanonicalQuoteFixture(kind);
  const transport = buildConfirmationPublicationTransport(
    native.bytes(),
    native.publication,
  );
  const session: DeviceSessionContext = {
    organizationId: transport.attempt.organizationId,
    organizationName: 'Synthetic confirmation company',
    subscriptionId: 'sub_synthetic',
    role: 'owner',
    sessionId: 'synthetic-session',
    userId: transport.attempt.userId,
    installationId: transport.attempt.installationId,
    entitlementValidUntil: 2_000_000_000,
  };
  return { native, ...transport, session, close: () => native.close() };
}
