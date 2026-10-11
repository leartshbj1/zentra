import type { ActionArticle, ActionCustomer } from './types';

export const PUBLISHED_RESOURCES_MAX_BYTES = 4 * 1024 * 1024;
export const PUBLISHED_RESOURCES_MAX_PREFIX_BYTES = 8 * 1024 * 1024;
export const PUBLISHED_RESOURCES_MAX_MANIFEST_BYTES = 64 * 1024;
export const PUBLISHED_RESOURCES_PATH = 'automation/resources.v1.json';

export type PublishedResourcesOrigin = Readonly<{
  organizationId: string;
  snapshotId: string;
  baseRevision: number;
}>;
export type PublishedResourceCompany = Readonly<{
  country: 'CH';
  currency: 'CHF';
  onboardingComplete: true;
  vatRegistered: boolean;
  defaultVatBp: number;
  paymentTermsDays: number;
  quoteValidityDays: number;
  updatedAt: string;
}>;
export type PublishedResourceCustomer = Readonly<{
  id: string;
  name: string;
  email: string | null;
  archived: boolean;
  updatedAt: string;
}>;
export type PublishedResourceArticle = Readonly<{
  id: string;
  kind: 'product' | 'service';
  sku: string | null;
  name: string;
  description: string;
  unit: string;
  unitPriceCents: number;
  taxRateBp: number;
  archived: boolean;
  updatedAt: string;
}>;
export type PublishedResourceFacts = Readonly<{
  company: PublishedResourceCompany;
  customers: readonly PublishedResourceCustomer[];
  articles: readonly PublishedResourceArticle[];
}>;
export type PublishedResources = PublishedResourcesOrigin &
  Readonly<{
    resourcesHash: string;
    sidecarSha256: string;
    sidecarBytes: number;
    compartmentBytes: number;
    resources: PublishedResourceFacts;
    customers: readonly ActionCustomer[];
    articles: readonly ActionArticle[];
  }>;

export class PublishedResourcesError extends Error {
  constructor(
    readonly code:
      | 'missing_resources'
      | 'invalid_resources'
      | 'service_unavailable',
  ) {
    super(code);
  }
}

function invalid(): never {
  throw new PublishedResourcesError('invalid_resources');
}
function object(raw: unknown): Record<string, unknown> {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
  )
    return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== 'string') return invalid();
    const d = descriptors[key];
    if (!d || !('value' in d) || !d.enumerable) return invalid();
    copy[key] = d.value;
  }
  return copy;
}
function exact(raw: unknown, keys: readonly string[]) {
  const value = object(raw);
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    return invalid();
  return value;
}
function text(raw: unknown, max: number, required = true): string {
  if (
    typeof raw !== 'string' ||
    raw.length > max ||
    !raw.isWellFormed() ||
    (required && !raw.trim()) ||
    [0, 11, 12, 127].some((code) => raw.includes(String.fromCharCode(code)))
  )
    return invalid();
  return raw;
}
function id(raw: unknown): string {
  const value = text(raw, 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:@-]*$/.test(value)) return invalid();
  return value;
}
function integer(raw: unknown, min: number, max: number): number {
  if (
    typeof raw !== 'number' ||
    !Number.isSafeInteger(raw) ||
    Object.is(raw, -0) ||
    raw < min ||
    raw > max
  )
    return invalid();
  return raw;
}
function bool(raw: unknown): boolean {
  if (typeof raw !== 'boolean') return invalid();
  return raw;
}
function hash(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[0-9a-f]{64}$/.test(raw)) return invalid();
  return raw;
}
function nullableText(raw: unknown, max: number): string | null {
  return raw === null ? null : text(raw, max, false);
}
function email(raw: unknown): string | null {
  const value = nullableText(raw, 254);
  if (
    value !== null &&
    value !== '' &&
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(
      value.trim(),
    )
  )
    return invalid();
  return value;
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) frozen(item);
    Object.freeze(value);
  }
  return value;
}

// The intrinsic getters reject proxies and other views without consulting
// caller-owned properties, iterators or species. The copy precedes every await.
const typedArrayPrototype: object = Object.getPrototypeOf(Uint8Array.prototype);
function intrinsicGetter(key: PropertyKey): (this: unknown) => unknown {
  // Built-in accessor deliberately called with Reflect.apply below. This is
  // trusted intrinsic metadata, never a getter supplied by the caller.
  const descriptor = Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    key,
  ) as { get: (this: unknown) => unknown };
  return descriptor.get;
}
const byteLengthGetter = intrinsicGetter('byteLength');
const bufferGetter = intrinsicGetter('buffer');
const tagGetter = intrinsicGetter(Symbol.toStringTag);
function capturePrefix(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  try {
    const length: unknown = Reflect.apply(byteLengthGetter, raw, []);
    const buffer: unknown = Reflect.apply(bufferGetter, raw, []);
    if (
      Reflect.apply(tagGetter, raw, []) !== 'Uint8Array' ||
      !(buffer instanceof ArrayBuffer) ||
      typeof length !== 'number' ||
      length < 1 ||
      length > PUBLISHED_RESOURCES_MAX_PREFIX_BYTES
    )
      return invalid();
    return new Uint8Array(raw);
  } catch {
    return invalid();
  }
}

/** JSON only: duplicate decoded keys, floats/exponents, unsafe integers,
 * malformed UTF-8/surrogates, excessive nesting and allocation are rejected.
 * Whitespace/key order need not match a serializer (native uses pretty JSON).
 */
function json(bytes: Uint8Array, maximum: number): unknown {
  if (!bytes.length || bytes.length > maximum) return invalid();
  let raw: string;
  try {
    raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return invalid();
  }
  let at = 0;
  let nodes = 0;
  const whitespace = () => {
    while (' \t\n\r'.includes(raw[at] ?? '\0')) at++;
  };
  const string = (): string => {
    if (raw[at] !== '"') return invalid();
    const start = at++;
    while (at < raw.length) {
      if (at - start > 6 * 4096 + 2) return invalid();
      const character = raw[at++];
      if (character === '\\') at++;
      else if (character === '"') {
        let value: unknown;
        try {
          value = JSON.parse(raw.slice(start, at));
        } catch {
          return invalid();
        }
        if (
          typeof value !== 'string' ||
          value.length > 4096 ||
          !value.isWellFormed()
        )
          return invalid();
        return value;
      }
    }
    return invalid();
  };
  const value = (depth: number): unknown => {
    if (++nodes > 200_000 || depth > 8) return invalid();
    whitespace();
    const first = raw[at];
    if (first === '"') return string();
    if (first === '{') {
      at++;
      whitespace();
      const result: Record<string, unknown> = Object.create(null);
      const keys = new Set<string>();
      if (raw[at] === '}') {
        at++;
        return result;
      }
      while (at < raw.length) {
        const key = string();
        if (key.length > 128 || keys.has(key) || keys.size >= 32)
          return invalid();
        keys.add(key);
        whitespace();
        if (raw[at++] !== ':') return invalid();
        result[key] = value(depth + 1);
        whitespace();
        if (raw[at] === '}') {
          at++;
          return result;
        }
        if (raw[at++] !== ',') return invalid();
        whitespace();
      }
      return invalid();
    }
    if (first === '[') {
      at++;
      whitespace();
      const result: unknown[] = [];
      if (raw[at] === ']') {
        at++;
        return result;
      }
      while (at < raw.length) {
        if (result.length >= 5000) return invalid();
        result.push(value(depth + 1));
        whitespace();
        if (raw[at] === ']') {
          at++;
          return result;
        }
        if (raw[at++] !== ',') return invalid();
      }
      return invalid();
    }
    for (const [token, literal] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (raw.startsWith(token, at)) {
        at += token.length;
        return literal;
      }
    }
    const start = at;
    if (raw[at] === '-') at++;
    if (raw[at] === '0') at++;
    else {
      if (!/[1-9]/.test(raw[at] ?? '')) return invalid();
      while (/[0-9]/.test(raw[at] ?? '') && at - start < 18) at++;
    }
    if (/[0-9.eE]/.test(raw[at] ?? '') || at - start > 17) return invalid();
    const number = Number(raw.slice(start, at));
    if (!Number.isSafeInteger(number) || Object.is(number, -0))
      return invalid();
    return number;
  };
  const result = value(0);
  whitespace();
  if (at !== raw.length) return invalid();
  return result;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++)
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes)
    value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function storedEntry(
  prefix: Uint8Array<ArrayBuffer>,
  offset: number,
  name: string,
  maximum: number,
) {
  if (offset < 0 || offset + 30 > prefix.length) return invalid();
  const header = new DataView(prefix.buffer, prefix.byteOffset + offset, 30);
  const version = header.getUint16(4, true);
  const flags = header.getUint16(6, true);
  const compressed = header.getUint32(18, true);
  const size = header.getUint32(22, true);
  const nameLength = header.getUint16(26, true);
  const extraLength = header.getUint16(28, true);
  if (
    header.getUint32(0, true) !== 0x04034b50 ||
    (version !== 10 && version !== 20) ||
    (flags !== 0 && flags !== 0x0800) ||
    header.getUint16(8, true) !== 0 ||
    compressed !== size ||
    size < 1 ||
    size > maximum ||
    nameLength !== name.length ||
    extraLength !== 0
  )
    return invalid();
  const start = offset + 30 + nameLength;
  const end = start + size;
  if (end > prefix.length) return invalid();
  for (let i = 0; i < nameLength; i++)
    if (prefix[offset + 30 + i] !== name.charCodeAt(i)) return invalid();
  const bytes = prefix.subarray(start, end);
  if (crc32(bytes) !== header.getUint32(14, true)) return invalid();
  return { bytes, end };
}

function manifest(raw: unknown) {
  const value = object(raw);
  const fields = [
    'format',
    'format_version',
    'app_version',
    'created_at',
    'database_file',
    'attachments_prefix',
  ];
  const present = Object.hasOwn(value, 'action_engine_resources');
  exact(value, present ? [...fields, 'action_engine_resources'] : fields);
  if (
    value.format !== 'zentra-backup' ||
    value.format_version !== 2 ||
    value.database_file !== 'database.sqlite3' ||
    value.attachments_prefix !== 'attachments/'
  )
    return invalid();
  text(value.app_version, 128);
  text(value.created_at, 128);
  if (!present) throw new PublishedResourcesError('missing_resources');
  const descriptor = exact(value.action_engine_resources, [
    'format',
    'version',
    'path',
    'sha256',
    'size_bytes',
    'customer_count',
    'article_count',
  ]);
  if (
    descriptor.format !== 'zentra-action-resources' ||
    descriptor.version !== 1 ||
    descriptor.path !== PUBLISHED_RESOURCES_PATH
  )
    return invalid();
  return {
    sha256: hash(descriptor.sha256),
    size: integer(descriptor.size_bytes, 1, PUBLISHED_RESOURCES_MAX_BYTES),
    customers: integer(descriptor.customer_count, 0, 5000),
    articles: integer(descriptor.article_count, 0, 5000),
  };
}
function company(raw: unknown): PublishedResourceCompany {
  const value = exact(raw, [
    'country',
    'currency',
    'onboardingComplete',
    'vatRegistered',
    'defaultVatBp',
    'paymentTermsDays',
    'quoteValidityDays',
    'updatedAt',
  ]);
  if (
    value.country !== 'CH' ||
    value.currency !== 'CHF' ||
    value.onboardingComplete !== true
  )
    return invalid();
  return {
    country: 'CH',
    currency: 'CHF',
    onboardingComplete: true,
    vatRegistered: bool(value.vatRegistered),
    defaultVatBp: integer(value.defaultVatBp, 0, 10_000),
    paymentTermsDays: integer(value.paymentTermsDays, 0, 365),
    quoteValidityDays: integer(value.quoteValidityDays, 0, 365),
    updatedAt: text(value.updatedAt, 128),
  };
}
function sortedRecords<T extends { id: string }>(
  raw: unknown,
  capture: (value: unknown) => T,
): readonly T[] {
  if (!Array.isArray(raw) || raw.length > 5000) return invalid();
  let previous = '';
  return raw.map((item) => {
    const result = capture(item);
    if (result.id <= previous) return invalid();
    previous = result.id;
    return result;
  });
}
function customer(raw: unknown): PublishedResourceCustomer {
  const value = exact(raw, ['id', 'name', 'email', 'archived', 'updatedAt']);
  return {
    id: id(value.id),
    name: text(value.name, 200),
    email: email(value.email),
    archived: bool(value.archived),
    updatedAt: text(value.updatedAt, 128),
  };
}
function article(raw: unknown): PublishedResourceArticle {
  const value = exact(raw, [
    'id',
    'kind',
    'sku',
    'name',
    'description',
    'unit',
    'unitPriceCents',
    'taxRateBp',
    'archived',
    'updatedAt',
  ]);
  if (value.kind !== 'product' && value.kind !== 'service') return invalid();
  return {
    id: id(value.id),
    kind: value.kind,
    sku: nullableText(value.sku, 100),
    name: text(value.name, 200),
    description: text(value.description, 1000, false),
    unit: text(value.unit, 40),
    unitPriceCents: integer(value.unitPriceCents, 0, 1_000_000_000),
    taxRateBp: integer(value.taxRateBp, 0, 10_000),
    archived: bool(value.archived),
    updatedAt: text(value.updatedAt, 128),
  };
}
function customerTuple(value: PublishedResourceCustomer) {
  return [value.id, value.name, value.email, value.archived, value.updatedAt];
}
function articleTuple(value: PublishedResourceArticle) {
  return [
    value.id,
    value.kind,
    value.sku,
    value.name,
    value.description,
    value.unit,
    value.unitPriceCents,
    value.taxRateBp,
    value.archived,
    value.updatedAt,
  ];
}
async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (n) =>
      n.toString(16).padStart(2, '0'),
    ).join('');
  } catch {
    throw new PublishedResourcesError('service_unavailable');
  }
}
function tupleHash(value: readonly unknown[]) {
  return sha256(new TextEncoder().encode(JSON.stringify(value)));
}
async function mapHashed<T, U>(
  values: readonly T[],
  project: (value: T) => Promise<U>,
): Promise<readonly U[]> {
  const result: U[] = [];
  for (let offset = 0; offset < values.length; offset += 64)
    result.push(
      ...(await Promise.all(values.slice(offset, offset + 64).map(project))),
    );
  return result;
}

/**
 * Reads only the authoritative positional JSON compartment of a new .zentra.
 * Caller must authenticate and verify the published chunks/head independently.
 * No database decompression or central-directory/by-name lookup is performed.
 * A later duplicate ZIP name, directory mismatch or malformed opaque tail is
 * outside this codec's guarantee and cannot shadow these two fixed positions.
 * JSON facts are not proof of SQLite equality or of a created quote/receipt.
 */
export async function readPublishedResourcesPrefix(
  prefix: Uint8Array,
  expected: PublishedResourcesOrigin,
): Promise<PublishedResources> {
  let captured: Uint8Array<ArrayBuffer>;
  let origin: PublishedResourcesOrigin;
  let descriptor: ReturnType<typeof manifest>;
  let sidecar: ReturnType<typeof storedEntry>;
  let resources: PublishedResourceFacts;
  let resourcesHash: string;
  try {
    captured = capturePrefix(prefix);
    const e = exact(expected, ['organizationId', 'snapshotId', 'baseRevision']);
    origin = frozen({
      organizationId: id(e.organizationId),
      snapshotId: id(e.snapshotId),
      baseRevision: integer(e.baseRevision, 0, Number.MAX_SAFE_INTEGER),
    });
    const first = storedEntry(
      captured,
      0,
      'manifest.json',
      PUBLISHED_RESOURCES_MAX_MANIFEST_BYTES,
    );
    descriptor = manifest(
      json(first.bytes, PUBLISHED_RESOURCES_MAX_MANIFEST_BYTES),
    );
    sidecar = storedEntry(
      captured,
      first.end,
      PUBLISHED_RESOURCES_PATH,
      PUBLISHED_RESOURCES_MAX_BYTES,
    );
    if (sidecar.bytes.length !== descriptor.size) return invalid();
    const envelope = exact(json(sidecar.bytes, PUBLISHED_RESOURCES_MAX_BYTES), [
      'format',
      'version',
      'schemaVersion',
      'organizationId',
      'snapshotId',
      'baseRevision',
      'resources',
      'resourcesHash',
    ]);
    if (
      envelope.format !== 'zentra-action-resources' ||
      envelope.version !== 1 ||
      envelope.schemaVersion !== 62 ||
      envelope.organizationId !== origin.organizationId ||
      envelope.snapshotId !== origin.snapshotId ||
      envelope.baseRevision !== origin.baseRevision
    )
      return invalid();
    resourcesHash = hash(envelope.resourcesHash);
    const facts = exact(envelope.resources, [
      'company',
      'customers',
      'articles',
    ]);
    resources = frozen({
      company: company(facts.company),
      customers: sortedRecords(facts.customers, customer),
      articles: sortedRecords(facts.articles, article),
    });
    if (
      resources.customers.length !== descriptor.customers ||
      resources.articles.length !== descriptor.articles
    )
      return invalid();
  } catch (error) {
    if (error instanceof PublishedResourcesError) throw error;
    return invalid();
  }
  // Everything consumed by asynchronous hashing is now privately captured.
  const sidecarSha256 = await sha256(sidecar.bytes);
  if (sidecarSha256 !== descriptor.sha256) return invalid();
  const c = resources.company;
  if (
    (await tupleHash([
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
      resources.customers.map(customerTuple),
      resources.articles.map(articleTuple),
    ])) !== resourcesHash
  )
    return invalid();
  const customers = await mapHashed(resources.customers, async (value) => ({
    id: value.id,
    revision: await tupleHash(['customer', ...customerTuple(value)]),
    organizationId: origin.organizationId,
    name: value.name,
    email: value.email?.trim().toLowerCase() ?? '',
    archived: value.archived,
  }));
  const articles = await mapHashed(resources.articles, async (value) => ({
    id: value.id,
    revision: await tupleHash(['article', ...articleTuple(value)]),
    organizationId: origin.organizationId,
    name: value.name,
    description: value.description,
    sku: value.sku ?? '',
    unit: value.unit,
    currency: c.currency,
    unitPriceCents: value.unitPriceCents,
    // Preserve the configured catalogue rate in facts/revision hashes, but an
    // unregistered company's draft quote must use the native effective zero.
    taxRateBp: c.vatRegistered ? value.taxRateBp : 0,
    archived: value.archived,
  }));
  return frozen({
    ...origin,
    resourcesHash,
    sidecarSha256,
    sidecarBytes: sidecar.bytes.length,
    compartmentBytes: sidecar.end,
    resources,
    customers,
    articles,
  });
}
