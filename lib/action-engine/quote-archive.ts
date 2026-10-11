import { inflateRawSync } from 'node:zlib';
import {
  PUBLISHED_RESOURCES_MAX_PREFIX_BYTES,
  PUBLISHED_RESOURCES_PATH,
  PublishedResourcesError,
  readPublishedResourcesPrefix,
} from './published-resources';

// Deliberately smaller than general-purpose native restore limits. A larger
// company archive requires another reviewed server profile, never truncation.
export const QUOTE_ARCHIVE_MAX_BYTES = 16 * 1024 * 1024;
export const QUOTE_ARCHIVE_MAX_SQLITE_BYTES = 8 * 1024 * 1024;
export const QUOTE_ARCHIVE_MAX_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;
export const QUOTE_ARCHIVE_MAX_ENTRIES = 512;

export type CanonicalQuoteArchiveOrigin = Readonly<{
  organizationId: string;
  snapshotId: string;
  baseRevision: number;
  archiveSha256: string;
}>;
export class CanonicalQuoteArchiveError extends Error {
  constructor(readonly code: 'invalid_archive' | 'service_unavailable') {
    super(code);
  }
}
function invalid(): never {
  throw new CanonicalQuoteArchiveError('invalid_archive');
}

const typedArrayPrototype: object = Object.getPrototypeOf(Uint8Array.prototype);
function intrinsicGetter(key: PropertyKey): (this: unknown) => unknown {
  // oxlint-disable-next-line typescript/unbound-method -- Callers use Reflect.apply with the typed-array receiver, rejecting proxies without invoking user getters.
  return Object.getOwnPropertyDescriptor(typedArrayPrototype, key)!.get!;
}
const lengthGetter = intrinsicGetter('byteLength');
const bufferGetter = intrinsicGetter('buffer');
const tagGetter = intrinsicGetter(Symbol.toStringTag);
function captureBytes(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  // Intrinsic typed-array accessors reject proxies/DataViews and ignore an
  // own length, iterator or species. Shared memory cannot be captured atomically.
  const length: unknown = Reflect.apply(lengthGetter, raw, []);
  const buffer: unknown = Reflect.apply(bufferGetter, raw, []);
  if (
    Reflect.apply(tagGetter, raw, []) !== 'Uint8Array' ||
    !(buffer instanceof ArrayBuffer) ||
    typeof length !== 'number' ||
    length < 22 ||
    length > QUOTE_ARCHIVE_MAX_BYTES
  )
    return invalid();
  return new Uint8Array(raw);
}
function captureOrigin(
  raw: CanonicalQuoteArchiveOrigin,
): CanonicalQuoteArchiveOrigin {
  if (
    !raw ||
    typeof raw !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
  )
    return invalid();
  const keys = [
    'organizationId',
    'snapshotId',
    'baseRevision',
    'archiveSha256',
  ];
  const actual = Reflect.ownKeys(raw);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== 'string' || !keys.includes(key))
  )
    return invalid();
  const values: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor))
      return invalid();
    values[key] = descriptor.value;
  }
  const { organizationId, snapshotId, baseRevision, archiveSha256 } = values;
  for (const id of [organizationId, snapshotId])
    if (
      typeof id !== 'string' ||
      id.length > 160 ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:@-]*$/.test(id)
    )
      return invalid();
  if (
    typeof baseRevision !== 'number' ||
    !Number.isSafeInteger(baseRevision) ||
    Object.is(baseRevision, -0) ||
    baseRevision < 0 ||
    typeof archiveSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(archiveSha256)
  )
    return invalid();
  return Object.freeze({
    organizationId: organizationId as string,
    snapshotId: snapshotId as string,
    baseRevision,
    archiveSha256,
  });
}
async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  try {
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
  } catch {
    throw new CanonicalQuoteArchiveError('service_unavailable');
  }
}
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++)
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes)
    value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
type Entry = Readonly<{
  name: string;
  method: number;
  crc: number;
  size: number;
  start: number;
  end: number;
}>;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function safeName(bytes: Uint8Array, flags: number): string {
  if (
    !bytes.length ||
    bytes.length > 1024 ||
    (flags !== 0x0800 && bytes.some((byte) => byte > 127))
  )
    return invalid();
  const name = decoder.decode(bytes);
  // oxlint-disable-next-line eslint/no-control-regex -- ZIP paths must explicitly reject C0/C1 controls, including NUL.
  if (/[\\:<>"|?*\u0000-\u001f\u007f-\u009f\ufeff]/u.test(name))
    return invalid();
  const parts = name.split('/');
  if (
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  )
    return invalid();
  return name;
}
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((byte, index) => byte === right[index])
  );
}
function entries(bytes: Uint8Array<ArrayBuffer>): readonly Entry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  if (
    view.getUint32(eocd, true) !== 0x06054b50 ||
    view.getUint16(eocd + 4, true) !== 0 ||
    view.getUint16(eocd + 6, true) !== 0 ||
    view.getUint16(eocd + 20, true) !== 0
  )
    return invalid();
  const count = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryStart = view.getUint32(eocd + 16, true);
  if (
    count < 3 ||
    count > QUOTE_ARCHIVE_MAX_ENTRIES ||
    view.getUint16(eocd + 8, true) !== count ||
    directorySize < count * 46 ||
    directoryStart + directorySize !== eocd
  )
    return invalid();
  const result: Entry[] = [];
  const names = new Set<string>();
  let cursor = directoryStart,
    local = 0,
    total = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > eocd || view.getUint32(cursor, true) !== 0x02014b50)
      return invalid();
    const version = view.getUint16(cursor + 6, true);
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const compressed = view.getUint32(cursor + 20, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const attributes = view.getUint32(cursor + 38, true);
    const offset = view.getUint32(cursor + 42, true);
    const fileMode = (attributes >>> 16) & 0o170000;
    if (
      (version !== 10 && version !== 20) ||
      (flags !== 0 && flags !== 0x0800) ||
      method !== (index < 2 ? 0 : 8) ||
      (method === 8 && version !== 20) ||
      compressed === 0xffffffff ||
      size === 0xffffffff ||
      offset === 0xffffffff ||
      extraLength !== 0 ||
      commentLength !== 0 ||
      view.getUint16(cursor + 34, true) !== 0 ||
      (attributes & 0x18) !== 0 ||
      (fileMode !== 0 && fileMode !== 0o100000) ||
      offset !== local ||
      cursor + 46 + nameLength > eocd ||
      total + size > QUOTE_ARCHIVE_MAX_UNCOMPRESSED_BYTES ||
      (index === 2 && (size < 100 || size > QUOTE_ARCHIVE_MAX_SQLITE_BYTES))
    )
      return invalid();
    const filename = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = safeName(filename, flags);
    const expected = [
      'manifest.json',
      PUBLISHED_RESOURCES_PATH,
      'database.sqlite3',
    ][index];
    if (
      (index < 3 && name !== expected) ||
      (index >= 3 && !name.startsWith('attachments/'))
    )
      return invalid();
    // Conservative Unicode case folding prevents aliases across platforms.
    const folded = name.normalize('NFKC').toUpperCase().toLowerCase();
    if (names.has(folded)) return invalid();
    names.add(folded);
    if (
      local + 30 > directoryStart ||
      view.getUint32(local, true) !== 0x04034b50 ||
      view.getUint16(local + 4, true) !== version ||
      view.getUint16(local + 6, true) !== flags ||
      view.getUint16(local + 8, true) !== method ||
      view.getUint32(local + 10, true) !== view.getUint32(cursor + 12, true) ||
      view.getUint32(local + 14, true) !== crc ||
      view.getUint32(local + 18, true) !== compressed ||
      view.getUint32(local + 22, true) !== size ||
      view.getUint16(local + 26, true) !== nameLength ||
      view.getUint16(local + 28, true) !== 0
    )
      return invalid();
    const start = local + 30 + nameLength,
      end = start + compressed;
    if (
      end > directoryStart ||
      !equalBytes(bytes.subarray(local + 30, start), filename) ||
      (method === 0 && compressed !== size)
    )
      return invalid();
    result.push({ name, method, crc, size, start, end });
    total += size;
    local = end;
    cursor += 46 + nameLength;
  }
  if (cursor !== eocd || local !== directoryStart) return invalid();
  return result;
}
function content(
  bytes: Uint8Array<ArrayBuffer>,
  entry: Entry,
): Uint8Array<ArrayBuffer> {
  const compressed = bytes.subarray(entry.start, entry.end);
  let output: Uint8Array<ArrayBuffer>;
  if (entry.method === 0) output = compressed;
  else {
    // Node's type declaration omits info:true's record return. Runtime shape
    // and consumed-byte count are checked; a second stream/opaque tail fails.
    const inflated = inflateRawSync(compressed, {
      info: true,
      maxOutputLength: Math.max(1, entry.size),
    }) as unknown as {
      buffer: Uint8Array<ArrayBuffer>;
      engine: { bytesWritten: number };
    };
    if (
      !inflated?.buffer ||
      inflated.engine?.bytesWritten !== compressed.length
    )
      return invalid();
    output = inflated.buffer;
  }
  if (output.byteLength !== entry.size || crc32(output) !== entry.crc)
    return invalid();
  return output;
}

/**
 * Strict complete ZIP capture, not an authority/SQLite parser. The caller must
 * separately corroborate publication, receipt, audit and actual database rows.
 * The sidecar authenticates its own origin/hash; pre/post client resources need
 * not have the same global hash after a customer was created.
 */
export async function readCanonicalQuoteArchive(
  rawBytes: Uint8Array,
  expected: CanonicalQuoteArchiveOrigin,
): Promise<{ sqliteBytes: Uint8Array<ArrayBuffer> }> {
  let bytes: Uint8Array<ArrayBuffer>, origin: CanonicalQuoteArchiveOrigin;
  try {
    bytes = captureBytes(rawBytes);
    origin = captureOrigin(expected);
  } catch {
    return invalid();
  }
  if ((await sha256(bytes)) !== origin.archiveSha256) return invalid();
  try {
    const records = entries(bytes);
    await readPublishedResourcesPrefix(
      bytes.subarray(
        0,
        Math.min(bytes.length, PUBLISHED_RESOURCES_MAX_PREFIX_BYTES),
      ),
      {
        organizationId: origin.organizationId,
        snapshotId: origin.snapshotId,
        baseRevision: origin.baseRevision,
      },
    );
    let sqliteBytes: Uint8Array<ArrayBuffer> | undefined;
    for (const record of records) {
      const output = content(bytes, record);
      if (record.name === 'database.sqlite3')
        sqliteBytes = new Uint8Array(output);
    }
    if (
      !sqliteBytes ||
      !equalBytes(
        sqliteBytes.subarray(0, 16),
        new TextEncoder().encode('SQLite format 3\0'),
      )
    )
      return invalid();
    return { sqliteBytes };
  } catch (error) {
    if (
      error instanceof PublishedResourcesError &&
      error.code === 'service_unavailable'
    )
      throw new CanonicalQuoteArchiveError('service_unavailable');
    if (error instanceof CanonicalQuoteArchiveError) throw error;
    return invalid();
  }
}
