import type { QuoteLedgerPredicate } from './ledger-types';
import {
  PublicationLedgerError,
  type PublicationAttempt,
  type PublicationBeginResult,
  type PublicationExpectation,
  type PublicationIdentity,
  type PublicationLedger,
  type PublicationResult,
} from './publication-ledger-types';

type Database = Pick<D1Database, 'prepare' | 'batch'>;
const MAX_REVISION = Number.MAX_SAFE_INTEGER;
// The manifest caps one archive at 64 chunks of 8 MiB; 2 GiB is the org quota.
export const PUBLICATION_MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const identityKeys = [
  'organizationId',
  'snapshotId',
  'installationId',
  'userId',
  'baseRevision',
  'archiveSha256',
  'manifestSha256',
  'sizeBytes',
] as const;
const invalid = (): never => {
  throw new PublicationLedgerError('invalid_record');
};
const unavailable = (): never => {
  throw new PublicationLedgerError('service_unavailable');
};

function exact(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
  )
    return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Reflect.ownKeys(raw).length !== keys.length) return invalid();
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const field = descriptors[key];
    if (!field || !field.enumerable || !('value' in field)) return invalid();
    copy[key] = field.value;
  }
  return copy;
}
function id(raw: unknown): string {
  if (
    typeof raw !== 'string' ||
    raw.length > 160 ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:@-]*$/.test(raw)
  )
    return invalid();
  return raw;
}
function uuid(raw: unknown): string {
  if (
    typeof raw !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      raw,
    )
  )
    return invalid();
  return raw;
}
function integer(raw: unknown, min: number, max: number): number {
  if (
    typeof raw !== 'number' ||
    !Number.isSafeInteger(raw) ||
    raw < min ||
    raw > max
  )
    return invalid();
  return raw;
}
function hash(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[0-9a-f]{64}$/.test(raw)) return invalid();
  return raw;
}
function identityFields(raw: Record<string, unknown>): PublicationIdentity {
  return Object.freeze({
    organizationId: id(raw.organizationId),
    snapshotId: uuid(raw.snapshotId),
    installationId: uuid(raw.installationId),
    userId: id(raw.userId),
    baseRevision: integer(raw.baseRevision, 0, MAX_REVISION - 1),
    archiveSha256: hash(raw.archiveSha256),
    manifestSha256: hash(raw.manifestSha256),
    sizeBytes: integer(raw.sizeBytes, 1, PUBLICATION_MAX_ARCHIVE_BYTES),
  });
}
export function capturePublicationIdentity(raw: unknown): PublicationIdentity {
  return identityFields(exact(raw, identityKeys));
}
export function capturePublicationResult(
  raw: unknown,
  identity: PublicationIdentity,
): PublicationResult {
  // The helper is also used at private port boundaries: never read a caller's
  // identity through accessors, even when TypeScript calls it readonly.
  if (
    !identity ||
    typeof identity !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(identity))
  )
    return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(identity);
  const captured: Record<string, unknown> = Object.create(null);
  for (const key of identityKeys) {
    const field = descriptors[key];
    if (!field || !field.enumerable || !('value' in field)) return invalid();
    captured[key] = field.value;
  }
  const source = identityFields(captured);
  const fields = exact(raw, ['committed', 'revision', 'snapshotId']);
  if (typeof fields.committed !== 'boolean') return invalid();
  const revision = integer(fields.revision, 0, MAX_REVISION);
  const snapshotId =
    fields.snapshotId === null ? null : uuid(fields.snapshotId);
  if ((revision === 0) !== (snapshotId === null)) return invalid();
  if (fields.committed) {
    if (
      revision !== source.baseRevision + 1 ||
      snapshotId !== source.snapshotId
    )
      return invalid();
  } else if (revision < source.baseRevision || snapshotId === source.snapshotId)
    return invalid();
  return Object.freeze({ committed: fields.committed, revision, snapshotId });
}
export function capturePublicationAttempt(raw: unknown): PublicationAttempt {
  const fields = exact(raw, [
    ...identityKeys,
    'id',
    'state',
    'result',
    'createdAt',
    'settledAt',
  ]);
  const identity = identityFields(fields);
  const createdAt = integer(fields.createdAt, 1, 253402300799);
  const settledAt =
    fields.settledAt === null
      ? null
      : integer(fields.settledAt, createdAt, 253402300799);
  if (!['pending', 'committed', 'cancelled'].includes(fields.state as string))
    return invalid();
  const state = fields.state as PublicationAttempt['state'];
  const result =
    fields.result === null
      ? null
      : capturePublicationResult(fields.result, identity);
  if (
    state === 'pending'
      ? result !== null || settledAt !== null
      : result === null ||
        settledAt === null ||
        result.committed !== (state === 'committed')
  )
    return invalid();
  return Object.freeze({
    ...identity,
    id: uuid(fields.id),
    state,
    result,
    createdAt,
    settledAt,
  });
}
function fromRow(raw: unknown): PublicationAttempt {
  const r = exact(raw, [
    'id',
    'organization_id',
    'snapshot_id',
    'installation_id',
    'user_id',
    'base_revision',
    'archive_sha256',
    'manifest_sha256',
    'size_bytes',
    'state',
    'result_json',
    'created_at',
    'settled_at',
  ]);
  if (
    r.result_json !== null &&
    (typeof r.result_json !== 'string' || r.result_json.length > 1024)
  )
    return invalid();
  let result: unknown = null;
  if (typeof r.result_json === 'string') {
    try {
      result = JSON.parse(r.result_json);
    } catch {
      return invalid();
    }
  }
  return capturePublicationAttempt({
    id: r.id,
    organizationId: r.organization_id,
    snapshotId: r.snapshot_id,
    installationId: r.installation_id,
    userId: r.user_id,
    baseRevision: r.base_revision,
    archiveSha256: r.archive_sha256,
    manifestSha256: r.manifest_sha256,
    sizeBytes: r.size_bytes,
    state: r.state,
    result,
    createdAt: r.created_at,
    settledAt: r.settled_at,
  });
}
function sameIdentity(a: PublicationIdentity, b: PublicationIdentity): boolean {
  return identityKeys.every((key) => a[key] === b[key]);
}
function sameResult(a: PublicationResult, b: PublicationResult): boolean {
  return (
    a.committed === b.committed &&
    a.revision === b.revision &&
    a.snapshotId === b.snapshotId
  );
}
function databaseError(error: unknown): never {
  if (error instanceof PublicationLedgerError) throw error;
  const message =
    error instanceof Error
      ? Object.getOwnPropertyDescriptor(error, 'message')
      : null;
  if (
    message &&
    'value' in message &&
    typeof message.value === 'string' &&
    message.value.length <= 4096 &&
    message.value.includes('action_engine_publication_conflict')
  ) {
    throw new PublicationLedgerError('conflict');
  }
  return unavailable();
}
function rowsFromBatch(raw: unknown, index: number, count: number): unknown[] {
  if (!Array.isArray(raw)) return unavailable();
  const fields = Object.getOwnPropertyDescriptors(raw);
  if (Object.getOwnPropertyDescriptor(raw, 'length')?.value !== count)
    return unavailable();
  for (let at = 0; at < count; at++) {
    const item = fields[String(at)];
    if (
      !item ||
      !('value' in item) ||
      !item.value ||
      typeof item.value !== 'object'
    )
      return unavailable();
    const result = Object.getOwnPropertyDescriptors(item.value);
    if (
      !result.success ||
      !('value' in result.success) ||
      result.success.value !== true
    )
      return unavailable();
  }
  const item = fields[String(index)].value as object;
  const result = Object.getOwnPropertyDescriptors(item).results;
  if (!result || !('value' in result) || !Array.isArray(result.value))
    return unavailable();
  const descriptors = Object.getOwnPropertyDescriptors(result.value);
  const length: unknown = Object.getOwnPropertyDescriptor(
    result.value,
    'length',
  )?.value;
  if (
    typeof length !== 'number' ||
    length < 0 ||
    length > 2 ||
    Reflect.ownKeys(result.value).length !== length + 1
  )
    return unavailable();
  const rows: unknown[] = [];
  for (let at = 0; at < length; at++) {
    const field = descriptors[String(at)];
    if (!field || !field.enumerable || !('value' in field))
      return unavailable();
    rows.push(field.value);
  }
  return rows;
}

/** Pure SQL witness for a separately admitted confirmation batch, not a grant. */
export function publicationPredicate(
  raw: PublicationExpectation,
): QuoteLedgerPredicate {
  const e = exact(raw, [
    'organizationId',
    'snapshotId',
    'revision',
    'baseRevision',
    'archiveSha256',
    'manifestSha256',
  ]);
  const organizationId = id(e.organizationId),
    snapshotId = uuid(e.snapshotId);
  const baseRevision = integer(e.baseRevision, 0, MAX_REVISION - 1);
  const revision = integer(e.revision, 1, MAX_REVISION);
  if (revision !== baseRevision + 1) return invalid();
  const archive = hash(e.archiveSha256),
    manifest = hash(e.manifestSha256);
  return Object.freeze({
    sql: `EXISTS(SELECT 1 FROM action_engine_publication_attempts p
      WHERE p.organization_id=? AND p.snapshot_id=? AND p.base_revision=?
      AND p.archive_sha256=? AND p.manifest_sha256=? AND p.state='committed'
      AND json_extract(p.result_json,'$.committed')=1
      AND json_extract(p.result_json,'$.revision')=? AND json_extract(p.result_json,'$.snapshotId')=p.snapshot_id)
      AND NOT EXISTS(SELECT 1 FROM action_engine_publication_attempts p WHERE p.organization_id=? AND p.state='pending')
      AND NOT EXISTS(SELECT 1 FROM action_engine_publication_attempts p WHERE p.organization_id=? AND p.state='committed'
        AND json_extract(p.result_json,'$.revision')>?)`,
    bindings: Object.freeze([
      organizationId,
      snapshotId,
      baseRevision,
      archive,
      manifest,
      revision,
      organizationId,
      organizationId,
      revision,
    ]),
  });
}

/**
 * Private transport ledger only. The caller verifies admission and PG outcomes;
 * neither possession of this object nor a pending row confirms a publication.
 * No expiry, network, reconciliation loop or automatic ownership transfer.
 */
export function createPublicationLedger(
  database: Database,
  options: { nextId?: () => string; now?: () => number } = {},
): PublicationLedger {
  const prepare = database.prepare.bind(database),
    batch = database.batch.bind(database);
  if (!options || typeof options !== 'object' || Array.isArray(options))
    return invalid();
  const optionFields = Object.getOwnPropertyDescriptors(options);
  if (
    ![Object.prototype, null].includes(Object.getPrototypeOf(options)) ||
    Reflect.ownKeys(options).some(
      (key) => typeof key !== 'string' || !['nextId', 'now'].includes(key),
    )
  )
    return invalid();
  for (const key of ['nextId', 'now']) {
    const field = optionFields[key];
    if (
      field &&
      (!field.enumerable ||
        !('value' in field) ||
        typeof field.value !== 'function')
    )
      return invalid();
  }
  const nextId =
    (optionFields.nextId?.value as (() => string) | undefined) ??
    (() => crypto.randomUUID());
  const clock =
    (optionFields.now?.value as (() => number) | undefined) ??
    (() => Math.floor(Date.now() / 1000));
  const timestamp = () => integer(clock(), 1, 253402300799);
  return Object.freeze({
    publicationPredicate,
    async read(
      rawOrganizationId: string,
      rawSnapshotId: string,
    ): Promise<PublicationAttempt | null> {
      const organizationId = id(rawOrganizationId),
        snapshotId = uuid(rawSnapshotId);
      try {
        const results = await batch([
          prepare(
            'SELECT * FROM action_engine_publication_attempts WHERE organization_id=? AND snapshot_id=? LIMIT 1',
          ).bind(organizationId, snapshotId),
        ]);
        const rows = rowsFromBatch(results, 0, 1);
        if (rows.length > 1) return unavailable();
        if (rows.length === 0) return null;
        const attempt = fromRow(rows[0]);
        if (
          attempt.organizationId !== organizationId ||
          attempt.snapshotId !== snapshotId
        )
          return unavailable();
        return attempt;
      } catch (error) {
        return databaseError(error);
      }
    },
    async begin(raw: PublicationIdentity): Promise<PublicationBeginResult> {
      const identity = capturePublicationIdentity(raw);
      try {
        const attemptId = uuid(nextId()),
          at = timestamp();
        const results = await batch([
          prepare(`INSERT INTO action_engine_publication_attempts
            (id,organization_id,snapshot_id,installation_id,user_id,base_revision,archive_sha256,manifest_sha256,size_bytes,state,result_json,created_at,settled_at)
            SELECT ?,?,?,?,?,?,?,?,?,'pending',NULL,?,NULL
            WHERE NOT EXISTS(SELECT 1 FROM action_engine_publication_attempts WHERE organization_id=? AND snapshot_id=?)
              AND NOT EXISTS(SELECT 1 FROM action_engine_publication_attempts WHERE organization_id=? AND state='pending')`).bind(
            attemptId,
            identity.organizationId,
            identity.snapshotId,
            identity.installationId,
            identity.userId,
            identity.baseRevision,
            identity.archiveSha256,
            identity.manifestSha256,
            identity.sizeBytes,
            at,
            identity.organizationId,
            identity.snapshotId,
            identity.organizationId,
          ),
          prepare(
            `SELECT * FROM action_engine_publication_attempts WHERE organization_id=? AND (snapshot_id=? OR state='pending') ORDER BY snapshot_id LIMIT 2`,
          ).bind(identity.organizationId, identity.snapshotId),
        ]);
        const attempts = rowsFromBatch(results, 1, 2).map(fromRow);
        const previous = attempts.find(
          (attempt) => attempt.snapshotId === identity.snapshotId,
        );
        if (previous) {
          if (!sameIdentity(previous, identity))
            throw new PublicationLedgerError('conflict');
          return Object.freeze({
            state: previous.state === 'pending' ? 'owned' : 'settled',
            attempt: previous,
          });
        }
        const held = attempts.find((attempt) => attempt.state === 'pending');
        if (held) return Object.freeze({ state: 'held', attempt: held });
        throw new PublicationLedgerError('conflict');
      } catch (error) {
        return databaseError(error);
      }
    },
    async settle(
      raw: PublicationAttempt,
      rawResult: PublicationResult,
    ): Promise<PublicationAttempt> {
      const attempt = capturePublicationAttempt(raw),
        result = capturePublicationResult(rawResult, attempt);
      try {
        const at = timestamp();
        if (at < attempt.createdAt) return invalid();
        const results = await batch([
          prepare(`UPDATE action_engine_publication_attempts SET state=?,result_json=?,settled_at=?
            WHERE id=? AND organization_id=? AND snapshot_id=? AND installation_id=? AND user_id=?
              AND base_revision=? AND archive_sha256=? AND manifest_sha256=? AND size_bytes=? AND created_at=? AND state='pending' AND ?='pending'`).bind(
            result.committed ? 'committed' : 'cancelled',
            JSON.stringify(result),
            at,
            attempt.id,
            attempt.organizationId,
            attempt.snapshotId,
            attempt.installationId,
            attempt.userId,
            attempt.baseRevision,
            attempt.archiveSha256,
            attempt.manifestSha256,
            attempt.sizeBytes,
            attempt.createdAt,
            attempt.state,
          ),
          prepare(
            'SELECT * FROM action_engine_publication_attempts WHERE id=? AND organization_id=?',
          ).bind(attempt.id, attempt.organizationId),
        ]);
        const rows = rowsFromBatch(results, 1, 2);
        if (rows.length !== 1) return invalid();
        const current = fromRow(rows[0]);
        if (
          current.id !== attempt.id ||
          current.createdAt !== attempt.createdAt ||
          !sameIdentity(current, attempt)
        )
          return invalid();
        if (current.state === 'pending' || current.result === null)
          return invalid();
        if (
          attempt.state !== 'pending' &&
          (attempt.state !== current.state ||
            attempt.settledAt !== current.settledAt ||
            attempt.result === null ||
            !sameResult(attempt.result, current.result))
        )
          return invalid();
        if (!sameResult(current.result, result))
          throw new PublicationLedgerError('conflict');
        return current;
      } catch (error) {
        return databaseError(error);
      }
    },
  });
}
