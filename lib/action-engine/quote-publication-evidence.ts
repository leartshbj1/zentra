import {
  bindingRecord as record,
  bindingExact as exact,
  bindingUuid as uuid,
  bindingHash as hash,
  bindingInteger as integer,
  captureHistoricalQuotePublication as publication,
  captureQuoteReservationBinding,
} from './reservation-binding';
export {
  captureQuoteReservationBinding,
  historicalQuotePublicationPredicate,
} from './reservation-binding';
import {
  captureVerifiedCanonicalQuote,
  type VerifiedCanonicalQuote,
} from './canonical-quote';
import {
  ActionEngineError,
  type ActionActor,
  type DraftQuoteReceipt,
} from './types';
import { actionIdentifier, captureActor } from './validation';
import { QuoteLedgerError, type QuoteLedgerPredicate } from './ledger-types';

type Database = Pick<D1Database, 'prepare' | 'batch'>;
const VERSION = 'quote-canonical-v1' as const;
const invalid = (): never => {
  throw new QuoteLedgerError('invalid_record');
};
const evidenceKeys = [
  'organizationId',
  'proposalId',
  'reservationId',
  'fingerprint',
  'userId',
  'installationId',
  'customerId',
  'quoteId',
  'publicationAttemptId',
  'snapshotId',
  'baseRevision',
  'revision',
  'archiveSha256',
  'manifestSha256',
  'sqliteSha256',
  'receiptSha256',
  'canonicalFactsSha256',
  'validatorVersion',
  'receipt',
  'reservationBinding',
] as const;

type EvidenceFields = Pick<
  VerifiedCanonicalQuote,
  (typeof evidenceKeys)[number]
>;
export type QuotePublicationEvidence = Readonly<
  EvidenceFields & { sourceId: string; createdAt: number }
>;
export type QuotePublicationEvidenceExpectation = Readonly<
  Pick<
    EvidenceFields,
    | 'organizationId'
    | 'proposalId'
    | 'reservationId'
    | 'fingerprint'
    | 'userId'
    | 'installationId'
    | 'customerId'
    | 'quoteId'
    | 'receipt'
  >
>;
export type QuotePublicationEvidenceFenceRequest =
  | Readonly<{ operation: 'read'; actor: ActionActor; reservationId: string }>
  | Readonly<{
      operation: 'append';
      actor: ActionActor;
      verified: VerifiedCanonicalQuote;
    }>;
export type QuotePublicationEvidenceFence = (
  request: QuotePublicationEvidenceFenceRequest,
) => Promise<QuoteLedgerPredicate>;

function receipt(raw: unknown): DraftQuoteReceipt {
  const fields = exact(raw, [
    'organizationId',
    'proposalId',
    'fingerprint',
    'customerId',
    'quoteId',
    'quoteNumber',
    'status',
    'requiresHumanValidation',
  ]);
  if (
    fields.quoteNumber !== null ||
    fields.status !== 'draft' ||
    fields.requiresHumanValidation !== true
  )
    return invalid();
  return Object.freeze({
    organizationId: actionIdentifier(fields.organizationId),
    proposalId: actionIdentifier(fields.proposalId),
    fingerprint: hash(fields.fingerprint),
    customerId: actionIdentifier(fields.customerId),
    quoteId: uuid(fields.quoteId),
    quoteNumber: null,
    status: 'draft',
    requiresHumanValidation: true,
  });
}
function expectation(raw: unknown): QuotePublicationEvidenceExpectation {
  const fields = exact(raw, [
    'organizationId',
    'proposalId',
    'reservationId',
    'fingerprint',
    'userId',
    'installationId',
    'customerId',
    'quoteId',
    'receipt',
  ]);
  const value = Object.freeze({
    organizationId: actionIdentifier(fields.organizationId),
    proposalId: actionIdentifier(fields.proposalId),
    reservationId: uuid(fields.reservationId),
    fingerprint: hash(fields.fingerprint),
    userId: actionIdentifier(fields.userId),
    installationId: actionIdentifier(fields.installationId),
    customerId: actionIdentifier(fields.customerId),
    quoteId: uuid(fields.quoteId),
    receipt: receipt(fields.receipt),
  });
  if (
    value.receipt.organizationId !== value.organizationId ||
    value.receipt.proposalId !== value.proposalId ||
    value.receipt.fingerprint !== value.fingerprint ||
    value.receipt.customerId !== value.customerId ||
    value.receipt.quoteId !== value.quoteId
  )
    return invalid();
  return value;
}
function evidenceFields(raw: unknown): Readonly<EvidenceFields> {
  const fields = exact(raw, evidenceKeys);
  const e = expectation(
    Object.fromEntries(
      [
        'organizationId',
        'proposalId',
        'reservationId',
        'fingerprint',
        'userId',
        'installationId',
        'customerId',
        'quoteId',
        'receipt',
      ].map((key) => [key, fields[key]]),
    ),
  );
  const p = publication({
    organizationId: e.organizationId,
    snapshotId: fields.snapshotId,
    revision: fields.revision,
    baseRevision: fields.baseRevision,
    archiveSha256: fields.archiveSha256,
    manifestSha256: fields.manifestSha256,
  });
  if (fields.validatorVersion !== VERSION) return invalid();
  const reservationBinding = captureQuoteReservationBinding(
    fields.reservationBinding,
  );
  if (
    reservationBinding.planningPublication.organizationId !==
      e.organizationId ||
    p.revision <= reservationBinding.planningPublication.revision
  )
    return invalid();
  return Object.freeze({
    ...e,
    publicationAttemptId: uuid(fields.publicationAttemptId),
    snapshotId: p.snapshotId,
    baseRevision: p.baseRevision,
    revision: p.revision,
    archiveSha256: p.archiveSha256,
    manifestSha256: p.manifestSha256,
    sqliteSha256: hash(fields.sqliteSha256),
    receiptSha256: hash(fields.receiptSha256),
    canonicalFactsSha256: hash(fields.canonicalFactsSha256),
    validatorVersion: VERSION,
    reservationBinding,
  });
}

const bindingJson = `json_object('resourcesSha256',b.resources_sha256,'sourceCanonicalSha256',b.source_canonical_sha256,'planningPublication',json_object('organizationId',b.organization_id,'snapshotId',b.planning_snapshot_id,'revision',b.planning_revision,'baseRevision',b.planning_base_revision,'archiveSha256',b.planning_archive_sha256,'manifestSha256',b.planning_manifest_sha256)) AS reservation_binding_json`;

const evidenceJoin = `FROM action_engine_quote_publication_evidence e
 JOIN action_engine_quote_reservations r ON r.id=e.reservation_id AND r.organization_id=e.organization_id AND r.proposal_id=e.proposal_id AND r.fingerprint=e.fingerprint AND r.user_id=e.user_id AND r.installation_id=e.installation_id AND r.customer_id=e.customer_id AND r.quote_id=e.quote_id
 JOIN action_engine_quote_proposals q ON q.id=r.proposal_id AND q.organization_id=r.organization_id AND q.fingerprint=r.fingerprint AND q.source_id=e.source_id
 JOIN action_engine_quote_reservation_bindings b ON b.reservation_id=r.id AND b.organization_id=r.organization_id AND b.proposal_id=r.proposal_id AND b.fingerprint=r.fingerprint
 JOIN action_engine_publication_attempts p ON p.id=e.publication_attempt_id AND p.organization_id=e.organization_id AND p.user_id=e.user_id AND p.installation_id=e.installation_id AND p.created_at>=r.created_at AND e.revision>b.planning_revision AND p.snapshot_id=e.snapshot_id AND p.base_revision=e.base_revision AND p.archive_sha256=e.archive_sha256 AND p.manifest_sha256=e.manifest_sha256 AND p.state='committed' AND json_extract(p.result_json,'$.committed')=1 AND json_extract(p.result_json,'$.revision')=e.revision AND json_extract(p.result_json,'$.snapshotId')=e.snapshot_id
 JOIN action_engine_publication_attempts h ON h.organization_id=b.organization_id AND h.snapshot_id=b.planning_snapshot_id AND h.base_revision=b.planning_base_revision AND h.archive_sha256=b.planning_archive_sha256 AND h.manifest_sha256=b.planning_manifest_sha256 AND h.state='committed' AND json_extract(h.result_json,'$.committed')=1 AND json_extract(h.result_json,'$.revision')=b.planning_revision AND json_extract(h.result_json,'$.snapshotId')=h.snapshot_id`;

/** Exact canonical creation evidence, deliberately independent of a later head/catalogue. */
export function quotePublicationEvidencePredicate(
  raw: QuotePublicationEvidenceExpectation,
): QuoteLedgerPredicate {
  const e = expectation(raw);
  return Object.freeze({
    sql: `EXISTS(SELECT 1 ${evidenceJoin} WHERE e.organization_id=? AND e.proposal_id=? AND e.reservation_id=? AND e.fingerprint=? AND e.user_id=? AND e.installation_id=? AND e.customer_id=? AND e.quote_id=? AND e.receipt_json=? AND e.validator_version='${VERSION}')`,
    bindings: Object.freeze([
      e.organizationId,
      e.proposalId,
      e.reservationId,
      e.fingerprint,
      e.userId,
      e.installationId,
      e.customerId,
      e.quoteId,
      JSON.stringify(e.receipt),
    ]),
  });
}

function gate(raw: unknown): QuoteLedgerPredicate {
  const fields = exact(raw, ['sql', 'bindings']);
  if (
    typeof fields.sql !== 'string' ||
    !fields.sql.trim() ||
    fields.sql.length > 16000 ||
    fields.sql.includes(';') ||
    fields.sql.includes('\0') ||
    !Array.isArray(fields.bindings) ||
    Object.getPrototypeOf(fields.bindings) !== Array.prototype
  )
    return invalid();
  const array = fields.bindings;
  if (array.length > 64 || Reflect.ownKeys(array).length !== array.length + 1)
    return invalid();
  const bindings: (string | number | null)[] = [];
  for (let at = 0; at < array.length; at++) {
    const field = Object.getOwnPropertyDescriptor(array, String(at));
    if (!field?.enumerable || !('value' in field)) return invalid();
    const value: unknown = field.value;
    if (
      value !== null &&
      !(typeof value === 'string' && value.length <= 65536) &&
      !(typeof value === 'number' && Number.isFinite(value))
    )
      return invalid();
    bindings.push(value as string | number | null);
  }
  return Object.freeze({ sql: fields.sql, bindings: Object.freeze(bindings) });
}
function databaseError(error: unknown): never {
  if (error instanceof QuoteLedgerError || error instanceof ActionEngineError)
    throw error;
  const message =
    error instanceof Error
      ? Object.getOwnPropertyDescriptor(error, 'message')
      : undefined;
  if (
    message &&
    'value' in message &&
    typeof message.value === 'string' &&
    message.value.includes('action_engine_denied')
  )
    throw new QuoteLedgerError('forbidden');
  throw new QuoteLedgerError('service_unavailable');
}
function fromRow(raw: unknown): QuotePublicationEvidence {
  const r = exact(raw, [
    'organization_id',
    'source_id',
    'proposal_id',
    'reservation_id',
    'fingerprint',
    'user_id',
    'installation_id',
    'customer_id',
    'quote_id',
    'publication_attempt_id',
    'snapshot_id',
    'base_revision',
    'revision',
    'archive_sha256',
    'manifest_sha256',
    'sqlite_sha256',
    'receipt_sha256',
    'canonical_facts_sha256',
    'validator_version',
    'receipt_json',
    'created_at',
    'reservation_binding_json',
  ]);
  if (
    typeof r.receipt_json !== 'string' ||
    r.receipt_json.length > 4096 ||
    typeof r.reservation_binding_json !== 'string' ||
    r.reservation_binding_json.length > 4096
  )
    return invalid();
  const value = evidenceFields({
    organizationId: r.organization_id,
    proposalId: r.proposal_id,
    reservationId: r.reservation_id,
    fingerprint: r.fingerprint,
    userId: r.user_id,
    installationId: r.installation_id,
    customerId: r.customer_id,
    quoteId: r.quote_id,
    publicationAttemptId: r.publication_attempt_id,
    snapshotId: r.snapshot_id,
    baseRevision: r.base_revision,
    revision: r.revision,
    archiveSha256: r.archive_sha256,
    manifestSha256: r.manifest_sha256,
    sqliteSha256: r.sqlite_sha256,
    receiptSha256: r.receipt_sha256,
    canonicalFactsSha256: r.canonical_facts_sha256,
    validatorVersion: r.validator_version,
    receipt: JSON.parse(r.receipt_json),
    reservationBinding: JSON.parse(r.reservation_binding_json),
  });
  return Object.freeze({
    ...value,
    sourceId: actionIdentifier(r.source_id),
    createdAt: integer(r.created_at, 1, 253402300799),
  });
}

/** Private verifier-to-D1 journal. It does not extract SQLite, authorize a device,
 * activate confirmation, or accept browser/native JSON as verified evidence. */
export function createD1QuotePublicationEvidence(
  database: Database,
  rawFence: QuotePublicationEvidenceFence,
  options: { nowSeconds?: () => number; newUuid?: () => string } = {},
) {
  if (typeof rawFence !== 'function') throw new QuoteLedgerError('forbidden');
  const optionFields = record(options);
  if (
    Object.keys(optionFields).some(
      (key) => !['nowSeconds', 'newUuid'].includes(key),
    ) ||
    Object.values(optionFields).some((value) => typeof value !== 'function')
  )
    return invalid();
  const now =
    (optionFields.nowSeconds as (() => number) | undefined) ??
    (() => Math.floor(Date.now() / 1000));
  const newUuid =
    (optionFields.newUuid as (() => string) | undefined) ??
    (() => crypto.randomUUID());
  const prepare = database.prepare.bind(database),
    batch = database.batch.bind(database),
    fence = rawFence.bind(undefined);
  async function atomic(
    request: QuotePublicationEvidenceFenceRequest,
    statements: () => D1PreparedStatement[],
    index: number,
  ) {
    try {
      const predicate = gate(await fence(Object.freeze(request))),
        id = uuid(newUuid());
      const results = await batch([
        prepare(
          `INSERT INTO action_engine_atomic_assertions(operation_id,allowed) SELECT ?,CASE WHEN (${predicate.sql}) THEN 1 ELSE 0 END`,
        ).bind(id, ...predicate.bindings),
        ...statements(),
        prepare(
          'DELETE FROM action_engine_atomic_assertions WHERE operation_id=?',
        ).bind(id),
      ]);
      if (!Array.isArray(results) || results.length !== index + 3)
        throw new QuoteLedgerError('service_unavailable');
      let rows: unknown[] | null = null;
      for (let at = 0; at < results.length; at++) {
        const descriptor = Object.getOwnPropertyDescriptor(results, String(at));
        if (
          !descriptor ||
          !('value' in descriptor) ||
          !descriptor.value ||
          typeof descriptor.value !== 'object'
        )
          throw new QuoteLedgerError('service_unavailable');
        const success = Object.getOwnPropertyDescriptor(
          descriptor.value,
          'success',
        );
        if (!success || !('value' in success) || success.value !== true)
          throw new QuoteLedgerError('service_unavailable');
        if (at === index + 1) {
          const found = Object.getOwnPropertyDescriptor(
            descriptor.value,
            'results',
          );
          if (!found || !('value' in found) || !Array.isArray(found.value))
            throw new QuoteLedgerError('service_unavailable');
          rows = found.value;
        }
      }
      if (!rows) throw new QuoteLedgerError('service_unavailable');
      if (rows.length > 1 || Reflect.ownKeys(rows).length !== rows.length + 1)
        return invalid();
      const row = Object.getOwnPropertyDescriptor(rows, '0');
      if (rows.length && (!row || !('value' in row))) return invalid();
      return rows.length ? fromRow(row!.value) : null;
    } catch (error) {
      return databaseError(error);
    }
  }
  return Object.freeze({
    async read(
      rawActor: ActionActor,
      rawReservationId: string,
    ): Promise<QuotePublicationEvidence | null> {
      const actor = captureActor(rawActor),
        reservationId = uuid(rawReservationId);
      const value = await atomic(
        { operation: 'read', actor, reservationId },
        () => [
          prepare(
            `SELECT e.*,${bindingJson} ${evidenceJoin} WHERE e.organization_id=? AND e.reservation_id=? AND e.user_id=?`,
          ).bind(actor.organizationId, reservationId, actor.userId),
        ],
        0,
      );
      if (
        value &&
        (value.organizationId !== actor.organizationId ||
          value.reservationId !== reservationId ||
          value.userId !== actor.userId)
      )
        return invalid();
      return value;
    },
    async append(
      rawActor: ActionActor,
      rawVerified: VerifiedCanonicalQuote,
    ): Promise<QuotePublicationEvidence> {
      const actor = captureActor(rawActor);
      // The verifier's private WeakSet seal is checked BEFORE the first await.
      let verified: VerifiedCanonicalQuote;
      try {
        verified = captureVerifiedCanonicalQuote(rawVerified);
      } catch {
        return invalid();
      }
      const value = evidenceFields(verified);
      if (
        value.organizationId !== actor.organizationId ||
        value.userId !== actor.userId
      )
        throw new QuoteLedgerError('forbidden');
      const saved = await atomic(
        { operation: 'append', actor, verified },
        () => {
          const at = integer(now(), 1, 253402300799);
          const b = value.reservationBinding,
            p = b.planningPublication;
          return [
            prepare(`INSERT INTO action_engine_quote_publication_evidence(organization_id,source_id,proposal_id,reservation_id,fingerprint,user_id,installation_id,customer_id,quote_id,publication_attempt_id,snapshot_id,base_revision,revision,archive_sha256,manifest_sha256,sqlite_sha256,receipt_sha256,canonical_facts_sha256,validator_version,receipt_json,created_at)
            SELECT ?,q.source_id,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? FROM action_engine_quote_proposals q JOIN action_engine_quote_reservation_bindings b ON b.organization_id=q.organization_id AND b.proposal_id=q.id AND b.fingerprint=q.fingerprint JOIN action_engine_quote_reservations r ON r.id=b.reservation_id AND r.organization_id=b.organization_id AND r.proposal_id=b.proposal_id AND r.fingerprint=b.fingerprint AND r.receipt_json IS NULL WHERE q.organization_id=? AND q.id=? AND q.fingerprint=? AND b.reservation_id=? AND b.resources_sha256=? AND b.source_canonical_sha256=? AND b.planning_snapshot_id=? AND b.planning_revision=? AND b.planning_base_revision=? AND b.planning_archive_sha256=? AND b.planning_manifest_sha256=? AND NOT EXISTS(SELECT 1 FROM action_engine_quote_publication_evidence WHERE organization_id=? AND reservation_id=?)`).bind(
              value.organizationId,
              value.proposalId,
              value.reservationId,
              value.fingerprint,
              value.userId,
              value.installationId,
              value.customerId,
              value.quoteId,
              value.publicationAttemptId,
              value.snapshotId,
              value.baseRevision,
              value.revision,
              value.archiveSha256,
              value.manifestSha256,
              value.sqliteSha256,
              value.receiptSha256,
              value.canonicalFactsSha256,
              value.validatorVersion,
              JSON.stringify(value.receipt),
              at,
              value.organizationId,
              value.proposalId,
              value.fingerprint,
              value.reservationId,
              b.resourcesSha256,
              b.sourceCanonicalSha256,
              p.snapshotId,
              p.revision,
              p.baseRevision,
              p.archiveSha256,
              p.manifestSha256,
              value.organizationId,
              value.reservationId,
            ),
            prepare(
              `SELECT e.*,${bindingJson} ${evidenceJoin} WHERE e.organization_id=? AND e.reservation_id=?`,
            ).bind(value.organizationId, value.reservationId),
          ];
        },
        1,
      );
      if (!saved) return invalid();
      const {
        sourceId: _sourceId,
        createdAt: _createdAt,
        ...savedFields
      } = saved;
      if (JSON.stringify(savedFields) !== JSON.stringify(value))
        throw new QuoteLedgerError('conflict');
      return saved;
    },
  });
}
