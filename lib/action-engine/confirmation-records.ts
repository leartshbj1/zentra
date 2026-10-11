import { quotePlanFingerprint } from './fingerprint';
import {
  QuoteLedgerError,
  type QuoteExecutionReservation,
  type QuoteLedgerPredicate,
  type QuoteReservationBinding,
} from './ledger-types';
import {
  bindingExact,
  bindingInteger,
  bindingRecord,
  bindingUuid,
  captureQuoteReservationBinding,
} from './reservation-binding';
import {
  ActionEngineError,
  type ActionActor,
  type StoredQuoteProposal,
} from './types';
import {
  actionIdentifier,
  captureActor,
  captureProposal,
  captureReceipt,
} from './validation';

export type QuoteConfirmationIdentity = Readonly<{
  actor: ActionActor;
  installationId: string;
  sourceId: string;
  proposalId: string;
  reservationId: string;
}>;
export type BoundQuoteExecution = Readonly<{
  proposal: StoredQuoteProposal;
  reservation: QuoteExecutionReservation;
  binding: QuoteReservationBinding;
}>;
/** Trusted server capability; neither this function nor its SQL is a request DTO. */
export type QuoteConfirmationReadFence = (
  identity: QuoteConfirmationIdentity,
) => Promise<QuoteLedgerPredicate>;

const invalid = (): never => {
  throw new QuoteLedgerError('invalid_record');
};
export function captureQuoteConfirmationIdentity(
  raw: QuoteConfirmationIdentity,
): QuoteConfirmationIdentity {
  const f = bindingExact(raw, [
    'actor',
    'installationId',
    'sourceId',
    'proposalId',
    'reservationId',
  ]);
  return Object.freeze({
    actor: captureActor(f.actor),
    installationId: actionIdentifier(f.installationId),
    sourceId: actionIdentifier(f.sourceId),
    proposalId: actionIdentifier(f.proposalId),
    reservationId: bindingUuid(f.reservationId),
  });
}
function array(raw: unknown): unknown[] {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype)
    return invalid();
  const length: unknown = Object.getOwnPropertyDescriptor(raw, 'length')?.value;
  if (
    typeof length !== 'number' ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > 64 ||
    Reflect.ownKeys(raw).length !== length + 1
  )
    return invalid();
  const result: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const field = Object.getOwnPropertyDescriptor(raw, String(index));
    if (!field?.enumerable || !('value' in field)) return invalid();
    result.push(field.value);
  }
  return result;
}
function predicate(raw: unknown): QuoteLedgerPredicate {
  const f = bindingExact(raw, ['sql', 'bindings']);
  if (
    typeof f.sql !== 'string' ||
    !f.sql.trim() ||
    f.sql.length > 16000 ||
    f.sql.includes(';') ||
    f.sql.includes(String.fromCharCode(0))
  )
    return invalid();
  const bindings = array(f.bindings).map((value) => {
    if (
      value !== null &&
      !(typeof value === 'string' && value.length <= 65536) &&
      !(typeof value === 'number' && Number.isFinite(value))
    )
      return invalid();
    return value as string | number | null;
  });
  return Object.freeze({ sql: f.sql, bindings: Object.freeze(bindings) });
}
function boundedError(error: unknown): QuoteLedgerError | ActionEngineError {
  if (error instanceof QuoteLedgerError || error instanceof ActionEngineError)
    return error;
  const message =
    error && typeof error === 'object'
      ? Object.getOwnPropertyDescriptor(error, 'message')
      : undefined;
  if (
    message &&
    'value' in message &&
    typeof message.value === 'string' &&
    message.value.length <= 2000 &&
    message.value.includes('action_engine_denied')
  )
    return new QuoteLedgerError('forbidden');
  return new QuoteLedgerError('service_unavailable');
}
function json(raw: unknown, max: number): unknown {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > max)
    return invalid();
  try {
    return JSON.parse(raw);
  } catch {
    return invalid();
  }
}
const rowKeys = [
  'proposal_id',
  'organization_id',
  'source_id',
  'action_kind',
  'fingerprint',
  'source_revision',
  'context_revision',
  'plan_json',
  'created_by',
  'proposal_created_at',
  'reservation_id',
  'user_id',
  'installation_id',
  'customer_id',
  'quote_id',
  'reservation_created_at',
  'receipt_json',
  'confirmed_at',
  'binding_json',
  'planning_witness',
] as const;
const timestamp = (value: unknown) => bindingInteger(value, 1, 253402300799);
function captureRow(
  raw: unknown,
  identity: QuoteConfirmationIdentity,
): { execution: BoundQuoteExecution; immutable: string } {
  try {
    const r = bindingExact(raw, rowKeys);
    const proposal = captureProposal(
      {
        id: r.proposal_id,
        organizationId: r.organization_id,
        fingerprint: r.fingerprint,
        plan: json(r.plan_json, 65536),
      },
      identity.actor,
    );
    if (
      proposal.id !== identity.proposalId ||
      proposal.plan.sourceId !== identity.sourceId ||
      proposal.plan.sourceId !== r.source_id ||
      proposal.plan.kind !== r.action_kind ||
      proposal.plan.sourceRevision !== r.source_revision ||
      proposal.plan.contextRevision !== r.context_revision ||
      proposal.plan.status !== 'ready' ||
      r.reservation_id !== identity.reservationId ||
      r.user_id !== identity.actor.userId ||
      r.installation_id !== identity.installationId ||
      (r.receipt_json === null) !== (r.confirmed_at === null)
    )
      return invalid();
    actionIdentifier(r.created_by);
    const proposalCreatedAt = timestamp(r.proposal_created_at),
      createdAt = timestamp(r.reservation_created_at);
    if (createdAt < proposalCreatedAt) return invalid();
    const receipt =
      r.receipt_json === null
        ? null
        : captureReceipt(json(r.receipt_json, 4096), proposal);
    const reservation: QuoteExecutionReservation = Object.freeze({
      id: bindingUuid(r.reservation_id),
      organizationId: proposal.organizationId,
      proposalId: proposal.id,
      fingerprint: proposal.fingerprint,
      userId: actionIdentifier(r.user_id),
      installationId: actionIdentifier(r.installation_id),
      customerId: actionIdentifier(r.customer_id),
      quoteId: bindingUuid(r.quote_id),
      createdAt,
      receipt,
    });
    if (proposal.plan.customer?.kind === 'existing') {
      if (reservation.customerId !== proposal.plan.customer.id)
        return invalid();
    } else bindingUuid(reservation.customerId);
    if (
      receipt &&
      (receipt.customerId !== reservation.customerId ||
        receipt.quoteId !== reservation.quoteId ||
        timestamp(r.confirmed_at) < createdAt)
    )
      return invalid();
    if (r.binding_json === null) throw new ActionEngineError('review_required');
    const binding = captureQuoteReservationBinding(json(r.binding_json, 4096));
    if (
      binding.planningPublication.organizationId !== proposal.organizationId ||
      r.planning_witness !== 1
    )
      return invalid();
    // Only the receipt can change between reads. All remaining values are
    // immutable SQL facts, compared again after the asynchronous digest.
    const immutable = JSON.stringify(
      rowKeys
        .filter((key) => key !== 'receipt_json' && key !== 'confirmed_at')
        .map((key) => r[key]),
    );
    return {
      execution: Object.freeze({ proposal, reservation, binding }),
      immutable,
    };
  } catch (error) {
    if (error instanceof QuoteLedgerError) throw error;
    if (error instanceof ActionEngineError && error.code === 'review_required')
      throw error;
    return invalid();
  }
}
const select = `SELECT p.id AS proposal_id,p.organization_id,p.source_id,p.action_kind,p.fingerprint,p.source_revision,p.context_revision,p.plan_json,p.created_by,p.created_at AS proposal_created_at,r.id AS reservation_id,r.user_id,r.installation_id,r.customer_id,r.quote_id,r.created_at AS reservation_created_at,r.receipt_json,r.confirmed_at,
 (SELECT json_object('resourcesSha256',b.resources_sha256,'sourceCanonicalSha256',b.source_canonical_sha256,'planningPublication',json_object('organizationId',b.organization_id,'snapshotId',b.planning_snapshot_id,'revision',b.planning_revision,'baseRevision',b.planning_base_revision,'archiveSha256',b.planning_archive_sha256,'manifestSha256',b.planning_manifest_sha256)) FROM action_engine_quote_reservation_bindings b WHERE b.reservation_id=r.id AND b.organization_id=r.organization_id AND b.proposal_id=p.id AND b.fingerprint=p.fingerprint) AS binding_json,
 EXISTS(SELECT 1 FROM action_engine_quote_reservation_bindings b JOIN action_engine_publication_attempts t ON t.organization_id=b.organization_id AND t.snapshot_id=b.planning_snapshot_id WHERE b.reservation_id=r.id AND b.organization_id=r.organization_id AND b.proposal_id=p.id AND b.fingerprint=p.fingerprint AND b.created_at=r.created_at AND t.state='committed' AND t.base_revision=b.planning_base_revision AND t.archive_sha256=b.planning_archive_sha256 AND t.manifest_sha256=b.planning_manifest_sha256 AND json_extract(t.result_json,'$.committed')=1 AND json_extract(t.result_json,'$.revision')=b.planning_revision AND json_extract(t.result_json,'$.snapshotId')=t.snapshot_id) AS planning_witness
 FROM action_engine_quote_proposals p JOIN action_engine_quote_reservations r ON r.organization_id=p.organization_id AND r.proposal_id=p.id AND r.fingerprint=p.fingerprint
 WHERE p.organization_id=? AND p.id=? AND p.source_id=? AND r.id=? AND r.user_id=? AND r.installation_id=?`;

/** Private historical loader. No source/catalogue-current requirement, no
 * mutation of a proposal/reservation/binding, and no legacy backfill. Permission
 * and selection are evaluated in the same D1 batch, then renewed after hashing. */
export async function readBoundQuoteExecution(
  database: Pick<D1Database, 'prepare' | 'batch'>,
  rawFence: QuoteConfirmationReadFence,
  rawIdentity: QuoteConfirmationIdentity,
): Promise<BoundQuoteExecution> {
  const identity = captureQuoteConfirmationIdentity(rawIdentity);
  if (typeof rawFence !== 'function') throw new QuoteLedgerError('forbidden');
  const fence = rawFence.bind(undefined),
    prepare = database.prepare.bind(database),
    batch = database.batch.bind(database);
  async function read(guardOnly = false): Promise<unknown[]> {
    const gate = predicate(await fence(identity)),
      operationId = bindingUuid(crypto.randomUUID());
    const results = array(
      await batch([
        prepare(
          `INSERT INTO action_engine_atomic_assertions(operation_id,allowed) SELECT ?,CASE WHEN (${gate.sql}) THEN 1 ELSE 0 END`,
        ).bind(operationId, ...gate.bindings),
        guardOnly
          ? prepare('SELECT 1 AS admitted')
          : prepare(select).bind(
              identity.actor.organizationId,
              identity.proposalId,
              identity.sourceId,
              identity.reservationId,
              identity.actor.userId,
              identity.installationId,
            ),
        prepare(
          'DELETE FROM action_engine_atomic_assertions WHERE operation_id=?',
        ).bind(operationId),
      ]),
    );
    if (results.length !== 3) throw new QuoteLedgerError('service_unavailable');
    const captures = results.map(bindingRecord);
    if (captures.some((result) => result.success !== true))
      throw new QuoteLedgerError('service_unavailable');
    return array(captures[1].results);
  }
  try {
    const rows = await read();
    if (rows.length !== 1) return invalid();
    const first = captureRow(rows[0], identity);
    let fingerprint: string;
    try {
      fingerprint = await quotePlanFingerprint(first.execution.proposal.plan);
    } catch {
      throw new QuoteLedgerError('service_unavailable');
    }
    if (fingerprint !== first.execution.proposal.fingerprint) return invalid();
    const finalRows = await read();
    if (finalRows.length !== 1) return invalid();
    const final = captureRow(finalRows[0], identity);
    if (final.immutable !== first.immutable) return invalid();
    return final.execution;
  } catch (error) {
    // Failures also require a fresh admission before publishing their bounded
    // result. A failed renewal never exposes the earlier record or error.
    try {
      await read(true);
    } catch (fresh) {
      throw boundedError(fresh);
    }
    throw boundedError(error);
  }
}
