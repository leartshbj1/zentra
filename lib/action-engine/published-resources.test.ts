import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PUBLISHED_RESOURCES_MAX_BYTES,
  PUBLISHED_RESOURCES_MAX_MANIFEST_BYTES,
  PUBLISHED_RESOURCES_MAX_PREFIX_BYTES,
  PUBLISHED_RESOURCES_PATH,
  PublishedResourcesError,
  readPublishedResourcesPrefix,
} from './published-resources';

// Synthetic native-shaped bytes only. No connection, native writer, SQLite,
// hosted snapshot or provider is invoked by this codec suite.
const encoder = new TextEncoder();
const origin = {
  organizationId: 'organization-demo',
  snapshotId: 'snapshot-demo',
  baseRevision: 0,
};
function facts() {
  return {
    company: {
      country: 'CH',
      currency: 'CHF',
      onboardingComplete: true,
      vatRegistered: true,
      defaultVatBp: 810,
      paymentTermsDays: 30,
      quoteValidityDays: 30,
      updatedAt: '2026-10-11T08:00:00.123Z',
    },
    customers: [
      {
        id: 'customer-a',
        name: 'Élodie 🚧',
        email: ' ELODIE@example.test ',
        archived: false,
        updatedAt: '2026-10-11T08:01:00Z',
      },
      {
        id: 'customer-b',
        name: 'Ancien client',
        email: null,
        archived: true,
        updatedAt: '2026-10-10T08:01:00Z',
      },
    ],
    articles: [
      {
        id: 'article-a',
        kind: 'product',
        sku: 'RAD-600',
        name: 'Radiateur',
        description: 'Radiateur 600 mm',
        unit: 'pce',
        unitPriceCents: 55_000,
        taxRateBp: 810,
        archived: false,
        updatedAt: '2026-10-11T08:02:00Z',
      },
      {
        id: 'article-b',
        kind: 'service',
        sku: null,
        name: 'Visite offerte',
        description: '',
        unit: 'h',
        unitPriceCents: 0,
        taxRateBp: 0,
        archived: true,
        updatedAt: '2026-10-10T08:02:00Z',
      },
    ],
  };
}
type Facts = ReturnType<typeof facts>;
function sha(bytes: Uint8Array | string) {
  return createHash('sha256').update(bytes).digest('hex');
}
function tuples(resources: Facts) {
  const c = resources.company;
  return [
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
    resources.customers.map((v) => [
      v.id,
      v.name,
      v.email,
      v.archived,
      v.updatedAt,
    ]),
    resources.articles.map((v) => [
      v.id,
      v.kind,
      v.sku,
      v.name,
      v.description,
      v.unit,
      v.unitPriceCents,
      v.taxRateBp,
      v.archived,
      v.updatedAt,
    ]),
  ];
}
function envelope(resources = facts()) {
  return {
    format: 'zentra-action-resources',
    version: 1,
    schemaVersion: 62,
    ...origin,
    resources,
    resourcesHash: sha(JSON.stringify(tuples(resources))),
  };
}
function checksum(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function join(...parts: Uint8Array[]) {
  const bytes = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}
type EntryOptions = Partial<{
  version: number;
  flags: number;
  method: number;
  size: number;
  compressed: number;
  extra: number;
  crc: number;
  nameLength: number;
}>;
function entry(name: string, data: Uint8Array, options: EntryOptions = {}) {
  const filename = encoder.encode(name);
  const header = new Uint8Array(30);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, options.version ?? 20, true);
  view.setUint16(6, options.flags ?? 0, true);
  view.setUint16(8, options.method ?? 0, true);
  view.setUint32(14, options.crc ?? checksum(data), true);
  view.setUint32(18, options.compressed ?? data.length, true);
  view.setUint32(22, options.size ?? data.length, true);
  view.setUint16(26, options.nameLength ?? filename.length, true);
  view.setUint16(28, options.extra ?? 0, true);
  return join(header, filename, data);
}
function backupManifest(bytes: Uint8Array, resources = facts()) {
  return {
    format: 'zentra-backup',
    format_version: 2,
    app_version: '1.90.15',
    created_at: '2026-10-11T08:00:00Z',
    database_file: 'database.sqlite3',
    attachments_prefix: 'attachments/',
    action_engine_resources: {
      format: 'zentra-action-resources',
      version: 1,
      path: PUBLISHED_RESOURCES_PATH,
      sha256: sha(bytes),
      size_bytes: bytes.length,
      customer_count: resources.customers.length,
      article_count: resources.articles.length,
    },
  };
}
function fixture(
  value = envelope(),
  options: {
    rawSidecar?: string | Uint8Array;
    mutateManifest?: (value: ReturnType<typeof backupManifest>) => void;
    rawManifest?: (value: ReturnType<typeof backupManifest>) => string;
    first?: EntryOptions;
    second?: EntryOptions;
    secondName?: string;
    tail?: Uint8Array;
  } = {},
) {
  const sidecar =
    typeof options.rawSidecar === 'string'
      ? encoder.encode(options.rawSidecar)
      : (options.rawSidecar ?? encoder.encode(JSON.stringify(value, null, 2)));
  const manifest = backupManifest(sidecar, value.resources);
  options.mutateManifest?.(manifest);
  const manifestBytes = encoder.encode(
    options.rawManifest?.(manifest) ?? JSON.stringify(manifest, null, 2),
  );
  const first = entry('manifest.json', manifestBytes, options.first);
  const second = entry(
    options.secondName ?? PUBLISHED_RESOURCES_PATH,
    sidecar,
    options.second,
  );
  return {
    prefix: join(first, second, options.tail ?? new Uint8Array()),
    first,
    second,
    sidecar,
    manifestBytes,
  };
}
async function refused(bytes: Uint8Array, code = 'invalid_resources') {
  await expect(
    readPublishedResourcesPrefix(bytes, { ...origin }),
  ).rejects.toMatchObject({ code });
}
afterEach(() => vi.restoreAllMocks());

describe('published resource positional compartment', () => {
  it('corroborates exact byte and semantic hashes, preserving native facts and archive status', async () => {
    const f = fixture();
    const result = await readPublishedResourcesPrefix(f.prefix, { ...origin });
    expect(result).toMatchObject({
      ...origin,
      sidecarSha256: sha(f.sidecar),
      sidecarBytes: f.sidecar.length,
      compartmentBytes: f.prefix.length,
      resourcesHash: sha(JSON.stringify(tuples(facts()))),
      resources: facts(),
    });
    expect(result.customers).toEqual([
      {
        id: 'customer-a',
        name: 'Élodie 🚧',
        email: 'elodie@example.test',
        archived: false,
        organizationId: origin.organizationId,
        revision: sha(
          JSON.stringify([
            'customer',
            'customer-a',
            'Élodie 🚧',
            ' ELODIE@example.test ',
            false,
            '2026-10-11T08:01:00Z',
          ]),
        ),
      },
      {
        id: 'customer-b',
        name: 'Ancien client',
        email: '',
        archived: true,
        organizationId: origin.organizationId,
        revision: sha(
          JSON.stringify([
            'customer',
            'customer-b',
            'Ancien client',
            null,
            true,
            '2026-10-10T08:01:00Z',
          ]),
        ),
      },
    ]);
    expect(result.articles[1]).toEqual({
      id: 'article-b',
      name: 'Visite offerte',
      description: '',
      sku: '',
      unit: 'h',
      currency: 'CHF',
      unitPriceCents: 0,
      taxRateBp: 0,
      archived: true,
      organizationId: origin.organizationId,
      revision: sha(
        JSON.stringify([
          'article',
          'article-b',
          'service',
          null,
          'Visite offerte',
          '',
          'h',
          0,
          0,
          true,
          '2026-10-10T08:02:00Z',
        ]),
      ),
    });
    for (const value of [
      result,
      result.resources,
      result.resources.company,
      result.resources.customers,
      result.resources.customers[0],
      result.customers,
      result.customers[0],
      result.articles,
      result.articles[0],
    ])
      expect(Object.isFrozen(value)).toBe(true);
  });
  it('accepts empty lists, safe base revision and the UTF-8 flag on exact ASCII names', async () => {
    const e = envelope();
    e.baseRevision = Number.MAX_SAFE_INTEGER;
    e.resources.customers = [];
    e.resources.articles = [];
    e.resourcesHash = sha(JSON.stringify(tuples(e.resources)));
    const f = fixture(e, {
      first: { version: 10, flags: 0x0800 },
      second: { flags: 0x0800 },
    });
    const result = await readPublishedResourcesPrefix(f.prefix, {
      ...origin,
      baseRevision: e.baseRevision,
    });
    expect(result.customers).toEqual([]);
    expect(result.articles).toEqual([]);
  });
  it('treats the post-compartment tail as opaque, never as a by-name override or full archive proof', async () => {
    const tail = entry(
      PUBLISHED_RESOURCES_PATH,
      encoder.encode('{"malicious":true}'),
    );
    const f = fixture(envelope(), { tail });
    const result = await readPublishedResourcesPrefix(f.prefix, origin);
    expect(result.compartmentBytes).toBe(f.first.length + f.second.length);
    expect(result.resources.articles[0].unitPriceCents).toBe(55_000);
  });
  it('reports a valid legacy manifest without the optional descriptor as unavailable', async () => {
    const f = fixture(envelope(), {
      rawManifest: (m) => {
        const legacy: Record<string, unknown> = { ...m };
        delete legacy.action_engine_resources;
        return JSON.stringify(legacy);
      },
    });
    await refused(f.prefix, 'missing_resources');
  });
  it.each([
    { version: 45 },
    { version: 9 },
    { flags: 1 },
    { flags: 8 },
    { flags: 4 },
    { method: 8 },
    { compressed: 1 },
    { size: 0xffffffff },
    { size: 0 },
    { extra: 1 },
    { nameLength: 1 },
    { crc: 0 },
  ])('refuses unsupported or ambiguous Stored metadata %j', async (second) => {
    await refused(fixture(envelope(), { second }).prefix);
  });
  it('refuses a compressed first entry, alternate paths, duplicate first entry and incomplete prefix', async () => {
    await refused(fixture(envelope(), { first: { method: 8 } }).prefix);
    for (const secondName of [
      'manifest.json',
      '../resources.v1.json',
      'automation\\resources.v1.json',
      'automation/resources.v2.json',
    ])
      await refused(fixture(envelope(), { secondName }).prefix);
    const f = fixture();
    for (const end of [
      0,
      29,
      f.first.length - 1,
      f.first.length + 29,
      f.prefix.length - 1,
    ])
      await refused(f.prefix.slice(0, end));
  });
  it('checks sizes, counts and hashes independently of valid ZIP checksums', async () => {
    for (const mutateManifest of [
      (m: ReturnType<typeof backupManifest>) => {
        m.action_engine_resources.size_bytes++;
      },
      (m: ReturnType<typeof backupManifest>) => {
        m.action_engine_resources.customer_count++;
      },
      (m: ReturnType<typeof backupManifest>) => {
        m.action_engine_resources.article_count--;
      },
      (m: ReturnType<typeof backupManifest>) => {
        m.action_engine_resources.sha256 = '0'.repeat(64);
      },
    ])
      await refused(fixture(envelope(), { mutateManifest }).prefix);
    const e = envelope();
    e.resourcesHash = '0'.repeat(64);
    await refused(fixture(e).prefix);
  });
});

describe('strict published JSON contract', () => {
  it.each([
    [
      'root duplicate',
      (s: string) => s.replace('"version": 1,', '"version": 1,"version":1,'),
    ],
    [
      'escaped duplicate',
      (s: string) =>
        s.replace('"version": 1,', '"version": 1,"\\u0076ersion":1,'),
    ],
    [
      'nested duplicate',
      (s: string) =>
        s.replace('"country": "CH",', '"country":"CH","country":"CH",'),
    ],
    [
      'record duplicate',
      (s: string) =>
        s.replace(
          '"name": "Radiateur",',
          '"name":"Radiateur","name":"Radiateur",',
        ),
    ],
    [
      'fraction',
      (s: string) =>
        s.replace('"unitPriceCents": 55000,', '"unitPriceCents":55000.0,'),
    ],
    [
      'exponent',
      (s: string) =>
        s.replace('"unitPriceCents": 55000,', '"unitPriceCents":5.5e4,'),
    ],
    [
      'negative zero',
      (s: string) => s.replace('"baseRevision": 0,', '"baseRevision":-0,'),
    ],
    [
      'unsafe number',
      (s: string) =>
        s.replace('"baseRevision": 0,', '"baseRevision":9007199254740992,'),
    ],
    [
      'leading zero',
      (s: string) => s.replace('"baseRevision": 0,', '"baseRevision":00,'),
    ],
    ['trailing data', (s: string) => s + '{}'],
    [
      'unpaired surrogate',
      (s: string) => s.replace('Radiateur 600 mm', '\\ud800'),
    ],
    ['BOM', (s: string) => '\uFEFF' + s],
  ])(
    'refuses %s even when descriptor SHA and CRC cover those exact bytes',
    async (_name, change) => {
      await refused(
        fixture(envelope(), {
          rawSidecar: change(JSON.stringify(envelope(), null, 2)),
        }).prefix,
      );
    },
  );
  it('rejects duplicate manifest fields including its descriptor and invalid UTF-8', async () => {
    await refused(
      fixture(envelope(), {
        rawManifest: (m) =>
          JSON.stringify(m).replace('"version":1', '"version":1,"version":1'),
      }).prefix,
    );
    const raw = encoder.encode(JSON.stringify(envelope()));
    raw[raw.length - 5] = 0xff;
    await refused(fixture(envelope(), { rawSidecar: raw }).prefix);
  });
  it('bounds recursive JSON and rejects non-JSON whitespace or hidden unknown structure', async () => {
    for (const rawSidecar of [
      '['.repeat(10) + '0' + ']'.repeat(10),
      '\u00a0' + JSON.stringify(envelope()),
      JSON.stringify({
        ...envelope(),
        unknown: { constructor: { prototype: true } },
      }),
      JSON.stringify({ ...envelope(), unknown: 'x'.repeat(4097) }),
    ])
      await refused(fixture(envelope(), { rawSidecar }).prefix);
  });
  it('rejects incompatible manifest versions, descriptor paths and unrecognized fields', async () => {
    for (const mutateManifest of [
      (m: ReturnType<typeof backupManifest>) => {
        m.format = 'helvichantier-backup';
      },
      (m: ReturnType<typeof backupManifest>) => {
        m.format_version = 1;
      },
      (m: ReturnType<typeof backupManifest>) => {
        m.database_file = '../database.sqlite3';
      },
      (m: ReturnType<typeof backupManifest>) => {
        m.action_engine_resources.version = 2;
      },
      (m: ReturnType<typeof backupManifest>) => {
        m.action_engine_resources.path = '../resources.v1.json';
      },
      (m: ReturnType<typeof backupManifest>) => {
        Object.assign(m, { unknown: true });
      },
    ])
      await refused(fixture(envelope(), { mutateManifest }).prefix);
  });
  it.each([
    ['format', 'other'],
    ['version', 2],
    ['schemaVersion', 61],
    ['organizationId', 'other-organization'],
    ['snapshotId', 'other-snapshot'],
    ['baseRevision', 1],
    ['extra', 'unknown'],
  ])('rejects an incompatible or foreign envelope %s', async (key, value) => {
    await refused(fixture({ ...envelope(), [key]: value }).prefix);
  });
  it('rejects incompatible country/currency, incomplete onboarding and closed-row extras', async () => {
    for (const company of [
      { country: 'US' },
      { currency: 'USD' },
      { onboardingComplete: false },
      { defaultVatBp: 10_001 },
      { paymentTermsDays: 366 },
      { quoteValidityDays: -1 },
      { updatedAt: '' },
      { vatRegistered: 'true' },
    ]) {
      const e = envelope();
      Object.assign(e.resources.company, company);
      e.resourcesHash = sha(JSON.stringify(tuples(e.resources)));
      await refused(fixture(e).prefix);
    }
    const e = envelope();
    Object.assign(e.resources.customers[0], { privateNotes: 'never exported' });
    await refused(fixture(e).prefix);
    const a = envelope();
    Object.assign(a.resources.articles[0], { purchaseCostCents: 42 });
    await refused(fixture(a).prefix);
  });
  it('requires sorted unique ASCII IDs and rejects blank or malformed native fields', async () => {
    for (const mutate of [
      (r: Facts) => {
        r.customers.reverse();
      },
      (r: Facts) => {
        r.customers[1].id = r.customers[0].id;
      },
      (r: Facts) => {
        r.articles.reverse();
      },
      (r: Facts) => {
        r.articles[1].id = r.articles[0].id;
      },
      (r: Facts) => {
        r.customers[0].id = 'client-É';
      },
      (r: Facts) => {
        r.customers[0].email = 'bad email';
      },
      (r: Facts) => {
        r.customers[0].name = ' ';
      },
      (r: Facts) => {
        r.articles[0].unit = '';
      },
      (r: Facts) => {
        r.articles[0].kind = 'other';
      },
      (r: Facts) => {
        r.articles[0].unitPriceCents = 1_000_000_001;
      },
      (r: Facts) => {
        r.articles[0].taxRateBp = 10_001;
      },
      (r: Facts) => {
        r.customers[0].updatedAt = 'x'.repeat(129);
      },
    ]) {
      const e = envelope();
      mutate(e.resources);
      e.resourcesHash = sha(JSON.stringify(tuples(e.resources)));
      await refused(fixture(e).prefix);
    }
  });
  it('enforces UTF-16 field bounds and row/byte bounds without truncating', async () => {
    const e = envelope();
    e.resources.customers[0].name = '🚧'.repeat(101);
    await refused(fixture(e).prefix);
    const many = envelope();
    many.resources.customers = Array.from({ length: 5001 }, (_, i) => ({
      ...facts().customers[0],
      id: `c${String(i).padStart(5, '0')}`,
    }));
    many.resourcesHash = sha(JSON.stringify(tuples(many.resources)));
    await refused(
      fixture(many, {
        mutateManifest: (m) => {
          m.action_engine_resources.customer_count = 5000;
        },
      }).prefix,
    );
    await refused(new Uint8Array(PUBLISHED_RESOURCES_MAX_PREFIX_BYTES + 1));
    await refused(
      fixture(envelope(), {
        rawManifest: () =>
          ' '.repeat(PUBLISHED_RESOURCES_MAX_MANIFEST_BYTES + 1),
      }).prefix,
    );
    await refused(
      fixture(envelope(), {
        rawSidecar: ' '.repeat(PUBLISHED_RESOURCES_MAX_BYTES + 1),
      }).prefix,
    );
  });
  it('accepts exactly 5000 sorted customers and refuses rather than omitting archived rows', async () => {
    const e = envelope();
    e.resources.customers = Array.from({ length: 5000 }, (_, i) => ({
      ...facts().customers[1],
      id: `c${String(i).padStart(5, '0')}`,
    }));
    e.resources.articles = [];
    e.resourcesHash = sha(JSON.stringify(tuples(e.resources)));
    const result = await readPublishedResourcesPrefix(
      fixture(e).prefix,
      origin,
    );
    expect(result.customers).toHaveLength(5000);
    expect(result.customers.every((c) => c.archived && c.email === '')).toBe(
      true,
    );
  });
  it('includes updatedAt, nullable fields and configured company values in their exact tuple hashes', async () => {
    const original = await readPublishedResourcesPrefix(
      fixture().prefix,
      origin,
    );
    const e = envelope();
    e.resources.company.updatedAt += '-changed';
    e.resources.company.paymentTermsDays = 0;
    e.resources.company.quoteValidityDays = 365;
    e.resources.customers[0].updatedAt += '-changed';
    e.resources.articles[0].sku = null;
    e.resourcesHash = sha(JSON.stringify(tuples(e.resources)));
    const changed = await readPublishedResourcesPrefix(
      fixture(e).prefix,
      origin,
    );
    expect(changed.resourcesHash).not.toBe(original.resourcesHash);
    expect(changed.customers[0].revision).not.toBe(
      original.customers[0].revision,
    );
    expect(changed.articles[0].revision).not.toBe(
      original.articles[0].revision,
    );
    expect(changed.customers[1].revision).toBe(original.customers[1].revision);
  });
  it('projects zero effective VAT for an unregistered company without changing catalogue facts or article revisions', async () => {
    const registered = await readPublishedResourcesPrefix(
      fixture().prefix,
      origin,
    );
    const e = envelope();
    e.resources.company.vatRegistered = false;
    e.resourcesHash = sha(JSON.stringify(tuples(e.resources)));
    const unregistered = await readPublishedResourcesPrefix(
      fixture(e).prefix,
      origin,
    );
    expect(registered.articles[0].taxRateBp).toBe(810);
    expect(unregistered.articles[0].taxRateBp).toBe(0);
    expect(unregistered.resources.articles[0].taxRateBp).toBe(810);
    expect(unregistered.articles[0].revision).toBe(
      registered.articles[0].revision,
    );
    expect(unregistered.resourcesHash).not.toBe(registered.resourcesHash);
  });
});

describe('capture and closed errors', () => {
  it('captures bytes and expected origin before asynchronous hashing', async () => {
    const f = fixture();
    const expected = { ...origin };
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(
      async (...args) => {
        await gate;
        return digest(...args);
      },
    );
    const pending = readPublishedResourcesPrefix(f.prefix, expected);
    f.prefix.fill(0);
    expected.organizationId = 'other-organization';
    expected.snapshotId = 'other-snapshot';
    expected.baseRevision = 123;
    release();
    const result = await pending;
    expect(result.organizationId).toBe(origin.organizationId);
    expect(result.snapshotId).toBe(origin.snapshotId);
    expect(result.baseRevision).toBe(0);
    expect(result.sidecarSha256).toBe(sha(f.sidecar));
  });
  it('rejects a failed digest using a stable error without leaking its cause', async () => {
    vi.spyOn(crypto.subtle, 'digest').mockRejectedValueOnce(
      new Error('secret material'),
    );
    await expect(
      readPublishedResourcesPrefix(fixture().prefix, origin),
    ).rejects.toEqual(new PublishedResourcesError('service_unavailable'));
  });
  it('does not execute typed-array iterators or origin getters, and rejects proxies/symbol fields', async () => {
    const f = fixture();
    const iterator = vi.fn(() => {
      throw new Error('must not execute');
    });
    Object.defineProperty(f.prefix, Symbol.iterator, { get: iterator });
    expect(
      (await readPublishedResourcesPrefix(f.prefix, origin)).customers,
    ).toHaveLength(2);
    expect(iterator).not.toHaveBeenCalled();
    const getter = vi.fn(() => origin.organizationId);
    const hostile = { ...origin };
    Object.defineProperty(hostile, 'organizationId', { get: getter });
    await expect(
      readPublishedResourcesPrefix(fixture().prefix, hostile),
    ).rejects.toMatchObject({ code: 'invalid_resources' });
    expect(getter).not.toHaveBeenCalled();
    await refused(new Proxy(fixture().prefix, {}));
    await expect(
      readPublishedResourcesPrefix(fixture().prefix, {
        ...origin,
        [Symbol('unknown')]: true,
      }),
    ).rejects.toMatchObject({ code: 'invalid_resources' });
    const hidden = { ...origin };
    Object.defineProperty(hidden, 'organizationId', {
      value: origin.organizationId,
      enumerable: false,
    });
    await expect(
      readPublishedResourcesPrefix(fixture().prefix, hidden),
    ).rejects.toMatchObject({ code: 'invalid_resources' });
    await expect(
      readPublishedResourcesPrefix(
        fixture().prefix,
        Object.assign(
          Object.create({ inherited: true }) as typeof origin,
          origin,
        ),
      ),
    ).rejects.toMatchObject({ code: 'invalid_resources' });
    await refused(new Uint8Array(new SharedArrayBuffer(64)));
  });
});
