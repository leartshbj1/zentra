import { actionIdentifier } from './validation';
import {
  QuoteLedgerError,
  type QuoteHistoricalPublication,
  type QuoteLedgerPredicate,
  type QuoteReservationBinding,
} from './ledger-types';

const invalid = (): never => {
  throw new QuoteLedgerError('invalid_record');
};
const publicationKeys = [
  'organizationId',
  'snapshotId',
  'revision',
  'baseRevision',
  'archiveSha256',
  'manifestSha256',
] as const;

export function bindingRecord(raw: unknown): Record<string, unknown> {
  if (
    !raw ||
    typeof raw !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
  )
    return invalid();
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(raw)) {
    const field = Object.getOwnPropertyDescriptor(raw, key);
    if (typeof key !== 'string' || !field?.enumerable || !('value' in field))
      return invalid();
    copy[key] = field.value;
  }
  return copy;
}
export function bindingExact(raw: unknown, keys: readonly string[]) {
  const copy = bindingRecord(raw);
  if (
    Object.keys(copy).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(copy, key))
  )
    return invalid();
  return copy;
}
export function bindingUuid(raw: unknown): string {
  if (
    typeof raw !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      raw,
    )
  )
    return invalid();
  return raw;
}
export function bindingHash(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[0-9a-f]{64}$/.test(raw)) return invalid();
  return raw;
}
export function bindingInteger(raw: unknown, min: number, max: number): number {
  if (
    typeof raw !== 'number' ||
    !Number.isSafeInteger(raw) ||
    raw < min ||
    raw > max
  )
    return invalid();
  return raw;
}
export function captureHistoricalQuotePublication(
  raw: unknown,
): QuoteHistoricalPublication {
  const fields = bindingExact(raw, publicationKeys);
  const baseRevision = bindingInteger(
    fields.baseRevision,
    0,
    Number.MAX_SAFE_INTEGER - 1,
  );
  const revision = bindingInteger(fields.revision, 1, Number.MAX_SAFE_INTEGER);
  if (revision !== baseRevision + 1) return invalid();
  return Object.freeze({
    organizationId: actionIdentifier(fields.organizationId),
    snapshotId: bindingUuid(fields.snapshotId),
    revision,
    baseRevision,
    archiveSha256: bindingHash(fields.archiveSha256),
    manifestSha256: bindingHash(fields.manifestSha256),
  });
}

/** Detached private context; capture before an asynchronous admission or digest. */
export function captureQuoteReservationBinding(
  raw: unknown,
): QuoteReservationBinding {
  const fields = bindingExact(raw, [
    'resourcesSha256',
    'sourceCanonicalSha256',
    'planningPublication',
  ]);
  return Object.freeze({
    resourcesSha256: bindingHash(fields.resourcesSha256),
    sourceCanonicalSha256: bindingHash(fields.sourceCanonicalSha256),
    planningPublication: captureHistoricalQuotePublication(
      fields.planningPublication,
    ),
  });
}

/** Historical transport witness only. It grants no permission and asserts no current head. */
export function historicalQuotePublicationPredicate(
  raw: QuoteHistoricalPublication,
): QuoteLedgerPredicate {
  const expected = captureHistoricalQuotePublication(raw);
  return Object.freeze({
    sql: `EXISTS(SELECT 1 FROM action_engine_publication_attempts p WHERE p.organization_id=? AND p.snapshot_id=? AND p.base_revision=? AND p.archive_sha256=? AND p.manifest_sha256=? AND p.state='committed' AND json_extract(p.result_json,'$.committed')=1 AND json_extract(p.result_json,'$.revision')=? AND json_extract(p.result_json,'$.snapshotId')=p.snapshot_id)`,
    bindings: Object.freeze([
      expected.organizationId,
      expected.snapshotId,
      expected.baseRevision,
      expected.archiveSha256,
      expected.manifestSha256,
      expected.revision,
    ]),
  });
}
