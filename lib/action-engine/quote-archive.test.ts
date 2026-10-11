import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CanonicalQuoteArchiveError,
  QUOTE_ARCHIVE_MAX_BYTES,
  QUOTE_ARCHIVE_MAX_ENTRIES,
  QUOTE_ARCHIVE_MAX_SQLITE_BYTES,
  QUOTE_ARCHIVE_MAX_UNCOMPRESSED_BYTES,
  readCanonicalQuoteArchive,
} from './quote-archive';

// Real ZIP/DEFLATE/CRC and resource envelopes, synthetic SQLite-shaped bytes.
// Database validity/business facts are deliberately another verifier's job.
const encoder = new TextEncoder();
const origin = {
  organizationId: 'organization-demo',
  snapshotId: 'snapshot-demo',
  baseRevision: 2,
};
function sha(bytes: Uint8Array | string) {
  return createHash('sha256').update(bytes).digest('hex');
}
function crc(bytes: Uint8Array) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++)
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function join(parts: readonly Uint8Array[]) {
  const bytes = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let cursor = 0;
  for (const part of parts) {
    bytes.set(part, cursor);
    cursor += part.length;
  }
  return bytes;
}
function sqlite(size = 4096) {
  const bytes = new Uint8Array(size);
  bytes.set(encoder.encode('SQLite format 3\0'));
  return bytes;
}
type File = {
  name: string;
  data: Uint8Array;
  method?: number;
  flags?: number;
  nameBytes?: Uint8Array;
  compressed?: Uint8Array;
  declaredSize?: number;
  checksum?: number;
};
function baseFiles(): File[] {
  const company = {
    country: 'CH',
    currency: 'CHF',
    onboardingComplete: true,
    vatRegistered: true,
    defaultVatBp: 810,
    paymentTermsDays: 30,
    quoteValidityDays: 30,
    updatedAt: '2026-10-11T08:00:00Z',
  };
  const resources = { company, customers: [], articles: [] };
  const c = company;
  const resourcesHash = sha(
    JSON.stringify([
      1,
      [
        c.country,
        c.currency,
        c.onboardingComplete,
        c.vatRegistered,
        c.defaultVatBp,
        c.paymentTermsDays,
        c.quoteValidityDays,
        c.updatedAt,
      ],
      [],
      [],
    ]),
  );
  const sidecar = encoder.encode(
    JSON.stringify({
      format: 'zentra-action-resources',
      version: 1,
      schemaVersion: 62,
      ...origin,
      resources,
      resourcesHash,
    }),
  );
  const manifest = encoder.encode(
    JSON.stringify({
      format: 'zentra-backup',
      format_version: 2,
      app_version: '1.90.15',
      created_at: '2026-10-11T08:00:00Z',
      database_file: 'database.sqlite3',
      attachments_prefix: 'attachments/',
      action_engine_resources: {
        format: 'zentra-action-resources',
        version: 1,
        path: 'automation/resources.v1.json',
        sha256: sha(sidecar),
        size_bytes: sidecar.length,
        customer_count: 0,
        article_count: 0,
      },
    }),
  );
  return [
    { name: 'manifest.json', data: manifest, method: 0 },
    { name: 'automation/resources.v1.json', data: sidecar, method: 0 },
    { name: 'database.sqlite3', data: sqlite(), method: 8 },
  ] satisfies File[];
}
function fixture(files: File[] = baseFiles()) {
  const locals: Uint8Array[] = [],
    directory: Uint8Array[] = [];
  const offsets: {
    local: number;
    central: number;
    content: number;
    nameLength: number;
  }[] = [];
  let local = 0,
    central = 0;
  for (const file of files) {
    const name = file.nameBytes ?? encoder.encode(file.name);
    const flags = file.flags ?? (name.some((byte) => byte > 127) ? 0x0800 : 0);
    const method = file.method ?? 8;
    const data =
      file.compressed ?? (method === 8 ? deflateRawSync(file.data) : file.data);
    const checksum = file.checksum ?? crc(file.data);
    const size = file.declaredSize ?? file.data.length;
    const header = new Uint8Array(30),
      record = new Uint8Array(46);
    const h = new DataView(header.buffer),
      r = new DataView(record.buffer);
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);
    h.setUint16(6, flags, true);
    h.setUint16(8, method, true);
    h.setUint32(14, checksum, true);
    h.setUint32(18, data.length, true);
    h.setUint32(22, size, true);
    h.setUint16(26, name.length, true);
    r.setUint32(0, 0x02014b50, true);
    r.setUint16(4, (3 << 8) | 20, true);
    r.setUint16(6, 20, true);
    r.setUint16(8, flags, true);
    r.setUint16(10, method, true);
    r.setUint32(16, checksum, true);
    r.setUint32(20, data.length, true);
    r.setUint32(24, size, true);
    r.setUint16(28, name.length, true);
    r.setUint32(38, 0o100600 << 16, true);
    r.setUint32(42, local, true);
    offsets.push({
      local,
      central,
      content: local + 30 + name.length,
      nameLength: name.length,
    });
    locals.push(header, name, data);
    directory.push(record, name);
    local += header.length + name.length + data.length;
    central += record.length + name.length;
  }
  const end = new Uint8Array(22),
    e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, files.length, true);
  e.setUint16(10, files.length, true);
  e.setUint32(12, central, true);
  e.setUint32(16, local, true);
  return {
    bytes: join([...locals, ...directory, end]),
    offsets: offsets.map((offset) => ({
      ...offset,
      central: local + offset.central,
    })),
    directoryStart: local,
  };
}
function expected(bytes: Uint8Array) {
  return { ...origin, archiveSha256: sha(bytes) };
}
async function refuses(bytes: Uint8Array) {
  await expect(
    readCanonicalQuoteArchive(bytes, expected(bytes)),
  ).rejects.toMatchObject({ code: 'invalid_archive' });
}
function patch16(bytes: Uint8Array, offset: number, value: number) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(
    offset,
    value,
    true,
  );
}
function patch32(bytes: Uint8Array, offset: number, value: number) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(
    offset,
    value,
    true,
  );
}
afterEach(() => vi.restoreAllMocks());

describe('complete canonical quote archive profile', () => {
  it('reads native-shaped stored JSON + deflated SQLite and attachments, including UTF-8 paths', async () => {
    const files = baseFiles();
    files.push({
      name: 'attachments/Élodie 🚀/facture.pdf',
      data: encoder.encode('%PDF synthetic'),
    });
    const { bytes } = fixture(files);
    const result = await readCanonicalQuoteArchive(bytes, expected(bytes));
    expect(result.sqliteBytes).toEqual(sqlite());
    expect(result.sqliteBytes.buffer).toBeInstanceOf(ArrayBuffer);
    expect(result.sqliteBytes.buffer).not.toBe(bytes.buffer);
  });
  it('accepts a subarray/Buffer without hashing backing-buffer padding', async () => {
    const { bytes } = fixture();
    const padded = join([new Uint8Array(9), bytes, new Uint8Array(17)]);
    const input = Buffer.from(padded.buffer, 9, bytes.length);
    expect(
      (await readCanonicalQuoteArchive(input, expected(bytes))).sqliteBytes,
    ).toEqual(sqlite());
  });
  it('requires the full archive SHA, not only a valid prefix or database hash', async () => {
    const { bytes } = fixture();
    await expect(
      readCanonicalQuoteArchive(bytes, {
        ...expected(bytes),
        archiveSha256: sha(sqlite()),
      }),
    ).rejects.toMatchObject({ code: 'invalid_archive' });
  });
  it.each(['organizationId', 'snapshotId', 'baseRevision'] as const)(
    'checks the sidecar %s against captured publication origin',
    async (key) => {
      const { bytes } = fixture();
      const value = {
        ...expected(bytes),
        [key]: key === 'baseRevision' ? 3 : 'different',
      };
      await expect(
        readCanonicalQuoteArchive(bytes, value),
      ).rejects.toMatchObject({ code: 'invalid_archive' });
    },
  );
  it('requires the exact SQLite Format 3 header and a complete minimum header', async () => {
    const files = baseFiles();
    files[2].data[0] ^= 1;
    await refuses(fixture(files).bytes);
    const short: File[] = baseFiles();
    short[2].data = sqlite(99);
    await refuses(fixture(short).bytes);
  });
  it('validates attachment CRCs even though it only returns SQLite', async () => {
    const files: File[] = baseFiles();
    files.push({
      name: 'attachments/a.txt',
      data: encoder.encode('an attachment'),
      checksum: 0,
    });
    await refuses(fixture(files).bytes);
  });
  it.each([0, 1, 2])(
    'rejects a bad CRC in reserved entry %i even when central/local agree',
    async (index) => {
      const files: File[] = baseFiles();
      files[index].checksum = 123;
      await refuses(fixture(files).bytes);
    },
  );
  it('rejects malformed DEFLATE and extra compressed bytes/concatenated streams', async () => {
    const files: File[] = baseFiles();
    files[2].compressed = new Uint8Array([255, 255, 255]);
    await refuses(fixture(files).bytes);
    for (const tail of [
      new Uint8Array([0]),
      deflateRawSync(encoder.encode('second stream')),
    ]) {
      files[2].compressed = join([deflateRawSync(sqlite()), tail]);
      await refuses(fixture(files).bytes);
    }
  });
  it('bounds actual DEFLATE output, not merely its dishonest declared size', async () => {
    const files: File[] = baseFiles();
    files[2] = {
      ...files[2],
      data: sqlite(QUOTE_ARCHIVE_MAX_SQLITE_BYTES + 1),
      declaredSize: 4096,
    };
    await refuses(fixture(files).bytes);
  });
  it('rejects declared database and total decompressed sizes before allocation', async () => {
    const files: File[] = baseFiles();
    files[2].declaredSize = QUOTE_ARCHIVE_MAX_SQLITE_BYTES + 1;
    await refuses(fixture(files).bytes);
    files[2].declaredSize = 4096;
    files.push({
      name: 'attachments/oversized.bin',
      data: new Uint8Array(),
      declaredSize: QUOTE_ARCHIVE_MAX_UNCOMPRESSED_BYTES,
    });
    await refuses(fixture(files).bytes);
  });
  it('limits the complete capture to 16 MiB and 512 entries', async () => {
    await expect(
      readCanonicalQuoteArchive(
        new Uint8Array(QUOTE_ARCHIVE_MAX_BYTES + 1),
        expected(new Uint8Array()),
      ),
    ).rejects.toMatchObject({ code: 'invalid_archive' });
    const files: File[] = baseFiles();
    while (files.length < QUOTE_ARCHIVE_MAX_ENTRIES)
      files.push({
        name: `attachments/${files.length}.txt`,
        data: new Uint8Array(),
      });
    expect(
      (
        await readCanonicalQuoteArchive(
          fixture(files).bytes,
          expected(fixture(files).bytes),
        )
      ).sqliteBytes,
    ).toEqual(sqlite());
    files.push({ name: 'attachments/too-many.txt', data: new Uint8Array() });
    await refuses(fixture(files).bytes);
  });
  it.each(['MANIFEST.JSON', 'automation/other.json', 'another.sqlite3'])(
    'rejects misplaced/unknown reserved name %s',
    async (name) => {
      const files: File[] = baseFiles();
      files[2].name = name;
      await refuses(fixture(files).bytes);
    },
  );
  it.each([
    'other/file.txt',
    'attachments/../x',
    '/attachments/x',
    'attachments//x',
    'attachments/./x',
    'attachments/x\\y',
    'attachments/x:y',
    'attachments/x\0y',
    'attachments/x\ny',
    'attachments/x.',
    'attachments/x ',
    'attachments/NUL.txt',
    'attachments/',
    'attachments/\ufeffx',
  ])('rejects unsafe or outside path %j', async (name) => {
    await refuses(
      fixture([...baseFiles(), { name, data: new Uint8Array() }]).bytes,
    );
  });
  it.each([
    ['a.txt', 'a.txt'],
    ['a.txt', 'A.TXT'],
    ['É.txt', 'E\u0301.txt'],
    ['Straße.txt', 'STRASSE.TXT'],
  ])(
    'rejects duplicate/case-folded Unicode paths %s / %s',
    async (first, second) => {
      await refuses(
        fixture([
          ...baseFiles(),
          ...[first, second].map((name) => ({
            name: `attachments/${name}`,
            data: new Uint8Array(),
          })),
        ]).bytes,
      );
    },
  );
  it('requires UTF-8 flags for non-ASCII and fatal UTF-8 decoding', async () => {
    await refuses(
      fixture([
        ...baseFiles(),
        { name: 'attachments/é.txt', flags: 0, data: new Uint8Array() },
      ]).bytes,
    );
    await refuses(
      fixture([
        ...baseFiles(),
        {
          name: 'attachments/x',
          nameBytes: join([
            encoder.encode('attachments/'),
            new Uint8Array([0xc3, 0x28]),
          ]),
          flags: 0x0800,
          data: new Uint8Array(),
        },
      ]).bytes,
    );
  });
  it.each([1, 8, 0x40, 0x2000, 0x0801])(
    'rejects encryption, data descriptor or unknown flags %i',
    async (flag) => {
      const { bytes, offsets } = fixture();
      patch16(bytes, offsets[2].local + 6, flag);
      patch16(bytes, offsets[2].central + 8, flag);
      await refuses(bytes);
    },
  );
  it.each([
    ['version', 4, 6, 45],
    ['flags', 6, 8, 0x0800],
    ['method', 8, 10, 0],
    ['time', 10, 12, 1],
    ['date', 12, 14, 1],
    ['nameLength', 26, 28, 1],
  ])(
    'rejects mismatched local/central %s',
    async (_name, localOffset, _centralOffset, value) => {
      const { bytes, offsets } = fixture();
      patch16(bytes, offsets[2].local + Number(localOffset), Number(value));
      await refuses(bytes);
    },
  );
  it.each([14, 18, 22])(
    'rejects mismatched local/central 32-bit field %i',
    async (offset) => {
      const { bytes, offsets } = fixture();
      patch32(bytes, offsets[2].local + offset, 999);
      await refuses(bytes);
    },
  );
  it('requires identical local/central filename bytes', async () => {
    const { bytes, offsets } = fixture([
      ...baseFiles(),
      { name: 'attachments/a.txt', data: new Uint8Array() },
    ]);
    bytes[offsets[3].local + 30 + 'attachments/'.length] = 'b'.charCodeAt(0);
    await refuses(bytes);
  });
  it.each([
    'localExtra',
    'centralExtra',
    'entryComment',
    'diskStart',
    'symlink',
    'directory',
  ])('rejects unsupported metadata %s', async (kind) => {
    const { bytes, offsets } = fixture();
    const entry = offsets[2];
    if (kind === 'localExtra') patch16(bytes, entry.local + 28, 1);
    if (kind === 'centralExtra') patch16(bytes, entry.central + 30, 1);
    if (kind === 'entryComment') patch16(bytes, entry.central + 32, 1);
    if (kind === 'diskStart') patch16(bytes, entry.central + 34, 1);
    if (kind === 'symlink') patch32(bytes, entry.central + 38, 0o120777 << 16);
    if (kind === 'directory') patch32(bytes, entry.central + 38, 0x10);
    await refuses(bytes);
  });
  it.each([0, 1, 0xffffffff])(
    'rejects overlapping/gapped/out-of-bounds local offset %i',
    async (offset) => {
      const { bytes, offsets } = fixture();
      patch32(bytes, offsets[2].central + 42, offset);
      await refuses(bytes);
    },
  );
  it.each(['offset', 'size', 'count', 'disk', 'comment', 'zip64', 'localSize'])(
    'rejects malformed EOCD/ZIP64/bounds %s',
    async (kind) => {
      const { bytes, offsets } = fixture();
      const eocd = bytes.length - 22;
      if (kind === 'offset') patch32(bytes, eocd + 16, 0xfffffff0);
      if (kind === 'size') patch32(bytes, eocd + 12, 0xffffffff);
      if (kind === 'count') patch16(bytes, eocd + 8, 2);
      if (kind === 'disk') patch16(bytes, eocd + 4, 1);
      if (kind === 'comment') patch16(bytes, eocd + 20, 1);
      if (kind === 'zip64') patch32(bytes, offsets[2].central + 24, 0xffffffff);
      if (kind === 'localSize') {
        patch32(bytes, offsets[2].local + 18, 0xffffffff);
        patch32(bytes, offsets[2].central + 20, 0xffffffff);
      }
      await refuses(bytes);
    },
  );
  it('rejects an opaque gap, central tail, leading junk and trailing archive bytes', async () => {
    const { bytes, directoryStart } = fixture();
    await refuses(join([new Uint8Array([0]), bytes]));
    await refuses(join([bytes, new Uint8Array([0])]));
    const gap = join([
      bytes.subarray(0, directoryStart),
      new Uint8Array([0]),
      bytes.subarray(directoryStart),
    ]);
    patch32(gap, gap.length - 22 + 16, directoryStart + 1);
    await refuses(gap);
    const tail = join([
      bytes.subarray(0, bytes.length - 22),
      new Uint8Array([0]),
      bytes.subarray(bytes.length - 22),
    ]);
    const size = new DataView(bytes.buffer).getUint32(
      bytes.length - 22 + 12,
      true,
    );
    patch32(tail, tail.length - 22 + 12, size + 1);
    await refuses(tail);
  });
});

describe('capture and asynchronous hashing', () => {
  it('rejects proxies, SharedArrayBuffer, detached buffers and non-byte views', async () => {
    const { bytes } = fixture();
    for (const raw of [
      new Proxy(bytes, {}),
      new Uint16Array(bytes.length),
      new DataView(bytes.buffer),
      new Uint8Array(new SharedArrayBuffer(bytes.length)),
    ])
      await expect(
        readCanonicalQuoteArchive(raw as Uint8Array, expected(bytes)),
      ).rejects.toMatchObject({ code: 'invalid_archive' });
    const detached = bytes.slice();
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    await expect(
      readCanonicalQuoteArchive(detached, expected(bytes)),
    ).rejects.toMatchObject({ code: 'invalid_archive' });
  });
  it('ignores caller-owned accessors/iterators while copying genuine typed arrays', async () => {
    const { bytes } = fixture();
    const check = expected(bytes);
    const getter = vi.fn(() => {
      throw new Error('must not run');
    });
    for (const key of [
      'byteLength',
      'buffer',
      Symbol.iterator,
      Symbol.toStringTag,
    ])
      Object.defineProperty(bytes, key, { get: getter });
    expect((await readCanonicalQuoteArchive(bytes, check)).sqliteBytes).toEqual(
      sqlite(),
    );
    expect(getter).not.toHaveBeenCalled();
  });
  it('captures bytes and expected fields before hashing can yield or mutate the caller', async () => {
    const { bytes } = fixture();
    const check = expected(bytes);
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(
      async (algorithm, data) => {
        bytes.fill(0);
        check.organizationId = 'another-company';
        check.baseRevision = 9;
        check.archiveSha256 = '0'.repeat(64);
        await Promise.resolve();
        return digest(algorithm, data);
      },
    );
    expect((await readCanonicalQuoteArchive(bytes, check)).sqliteBytes).toEqual(
      sqlite(),
    );
  });
  it('rejects accessor/symbol/nonenumerable/unexpected/prototype origin fields without calling accessors', async () => {
    const { bytes } = fixture();
    const getter = vi.fn(() => origin.organizationId);
    const accessor = { ...expected(bytes) };
    Object.defineProperty(accessor, 'organizationId', { get: getter });
    const nonenumerable = { ...expected(bytes) };
    Object.defineProperty(nonenumerable, 'snapshotId', {
      value: origin.snapshotId,
      enumerable: false,
    });
    for (const check of [
      accessor,
      nonenumerable,
      { ...expected(bytes), [Symbol('extra')]: true },
      { ...expected(bytes), other: true },
      Object.assign(Object.create({ unexpected: true }), expected(bytes)),
      { ...expected(bytes), archiveSha256: 123 },
      { ...expected(bytes), baseRevision: -0 },
    ])
      await expect(
        readCanonicalQuoteArchive(
          bytes,
          check as Parameters<typeof readCanonicalQuoteArchive>[1],
        ),
      ).rejects.toMatchObject({ code: 'invalid_archive' });
    expect(getter).not.toHaveBeenCalled();
  });
  it('preserves an unavailable hash service as unavailable, without revealing data', async () => {
    const { bytes } = fixture();
    vi.spyOn(crypto.subtle, 'digest').mockRejectedValue(
      new Error('synthetic private failure'),
    );
    await expect(
      readCanonicalQuoteArchive(bytes, expected(bytes)),
    ).rejects.toEqual(new CanonicalQuoteArchiveError('service_unavailable'));
  });
});
