import { QuoteLedgerError, type QuoteLedgerPredicate } from './ledger-types';
import {
  bindingExact,
  bindingRecord,
  bindingUuid,
} from './reservation-binding';
import { ActionEngineError, type ActionActor } from './types';
import { actionIdentifier, captureActor } from './validation';

/** Private server selectors. The caller must obtain actor/installation from auth. */
export type QuoteReservationStateSelection = Readonly<{
  actor: ActionActor;
  installationId: string;
  sourceId: string;
  proposalId: string;
}>;
export type QuoteReservationState =
  | Readonly<{ state: 'unreserved' }>
  | Readonly<{ state: 'held' }>
  | Readonly<{
      state: 'owned';
      reservationId: string;
      hasReceipt: boolean;
      evidenceSnapshotId: string | null;
    }>;
/** Current device/country/Support access, authored only by trusted server code.
 * This read capability does not authorize execution or certify an A6 proof. */
export type QuoteReservationStateFence = (
  selection: QuoteReservationStateSelection,
) => Promise<QuoteLedgerPredicate>;

const invalid = (): never => {
  throw new QuoteLedgerError('invalid_record');
};
const unavailable = (): never => {
  throw new QuoteLedgerError('service_unavailable');
};
function captureSelection(raw: QuoteReservationStateSelection) {
  try {
    const fields = bindingExact(raw, [
      'actor',
      'installationId',
      'sourceId',
      'proposalId',
    ]);
    return Object.freeze({
      actor: captureActor(fields.actor),
      installationId: actionIdentifier(fields.installationId),
      sourceId: actionIdentifier(fields.sourceId),
      proposalId: actionIdentifier(fields.proposalId),
    });
  } catch {
    return invalid();
  }
}
function array(raw: unknown, maximum: number): unknown[] {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype)
    return invalid();
  const length: unknown = Object.getOwnPropertyDescriptor(raw, 'length')?.value;
  if (
    typeof length !== 'number' ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > maximum ||
    Reflect.ownKeys(raw).length !== length + 1
  )
    return invalid();
  const captured: unknown[] = [];
  for (let at = 0; at < length; at++) {
    const field = Object.getOwnPropertyDescriptor(raw, String(at));
    if (!field?.enumerable || !('value' in field)) return invalid();
    captured.push(field.value);
  }
  return captured;
}
function predicate(raw: unknown): QuoteLedgerPredicate {
  const fields = bindingExact(raw, ['sql', 'bindings']);
  if (
    typeof fields.sql !== 'string' ||
    !fields.sql.trim() ||
    fields.sql.length > 16000 ||
    fields.sql.includes(';') ||
    fields.sql.includes(String.fromCharCode(0))
  )
    return invalid();
  const bindings = array(fields.bindings, 64).map((value) => {
    if (
      value !== null &&
      !(typeof value === 'string' && value.length <= 65536) &&
      !(typeof value === 'number' && Number.isFinite(value))
    )
      return invalid();
    return value as string | number | null;
  });
  return Object.freeze({ sql: fields.sql, bindings: Object.freeze(bindings) });
}
function boundedError(error: unknown): QuoteLedgerError {
  try {
    if (error instanceof QuoteLedgerError) {
      const code: unknown = Object.getOwnPropertyDescriptor(
        error,
        'code',
      )?.value;
      if (
        code === 'forbidden' ||
        code === 'conflict' ||
        code === 'invalid_record' ||
        code === 'service_unavailable'
      )
        return new QuoteLedgerError(code);
    }
    if (
      error instanceof ActionEngineError &&
      Object.getOwnPropertyDescriptor(error, 'code')?.value === 'forbidden'
    )
      return new QuoteLedgerError('forbidden');
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
  } catch {
    // A rejected port can also throw a proxy; never publish its traps/message.
  }
  return new QuoteLedgerError('service_unavailable');
}

// Ownership is projected inside SQL. A held response never loads the other
// actor's receipt, business IDs, reservation ID, plan or publication selector.
const selectionSql = `WITH caller(user_id,installation_id) AS (VALUES(?,?))
 SELECT
  CASE WHEN r.id IS NULL THEN 'unreserved'
    WHEN r.user_id=c.user_id AND r.installation_id=c.installation_id THEN 'owned'
    ELSE 'held' END AS state,
  CASE WHEN r.user_id=c.user_id AND r.installation_id=c.installation_id
    THEN r.id ELSE NULL END AS reservation_id,
  CASE WHEN r.user_id=c.user_id AND r.installation_id=c.installation_id
    THEN CASE WHEN r.receipt_json IS NULL THEN 0 ELSE 1 END ELSE 0 END AS has_receipt,
  CASE WHEN r.user_id=c.user_id AND r.installation_id=c.installation_id
    THEN e.snapshot_id ELSE NULL END AS evidence_snapshot_id
 FROM action_engine_quote_proposals q CROSS JOIN caller c
 LEFT JOIN action_engine_quote_reservations r ON r.organization_id=q.organization_id
  AND r.proposal_id=q.id AND r.fingerprint=q.fingerprint
 LEFT JOIN action_engine_quote_publication_evidence e ON e.organization_id=r.organization_id
  AND e.reservation_id=r.id AND e.proposal_id=q.id AND e.source_id=q.source_id
  AND e.fingerprint=q.fingerprint AND e.user_id=r.user_id
  AND e.installation_id=r.installation_id AND e.customer_id=r.customer_id AND e.quote_id=r.quote_id
 WHERE q.organization_id=? AND q.source_id=? AND q.id=?
  AND q.action_kind='prepare_quote_draft' LIMIT 2`;

function captureState(rows: unknown[]): QuoteReservationState {
  if (rows.length !== 1) return invalid();
  const row = bindingExact(rows[0], [
    'state',
    'reservation_id',
    'has_receipt',
    'evidence_snapshot_id',
  ]);
  if (row.state === 'unreserved' || row.state === 'held') {
    if (
      row.reservation_id !== null ||
      row.has_receipt !== 0 ||
      row.evidence_snapshot_id !== null
    )
      return invalid();
    return Object.freeze({ state: row.state });
  }
  if (row.state !== 'owned' || (row.has_receipt !== 0 && row.has_receipt !== 1))
    return invalid();
  return Object.freeze({
    state: 'owned',
    reservationId: bindingUuid(row.reservation_id),
    hasReceipt: row.has_receipt === 1,
    evidenceSnapshotId:
      row.evidence_snapshot_id === null
        ? null
        : bindingUuid(row.evidence_snapshot_id),
  });
}

/** Read-only private classifier. Absence of a proposal/table/ACK is never an
 * unreserved result. Owned metadata is only a recovery hint: the caller must
 * separately corroborate A6 evidence, or acquire the full fresh reserve fence. */
export async function readQuoteReservationState(
  database: Pick<D1Database, 'prepare' | 'batch'>,
  rawFence: QuoteReservationStateFence,
  rawSelection: QuoteReservationStateSelection,
): Promise<QuoteReservationState> {
  const selection = captureSelection(rawSelection);
  if (typeof rawFence !== 'function') throw new QuoteLedgerError('forbidden');
  const fence = rawFence.bind(undefined),
    prepare = database.prepare.bind(database),
    batch = database.batch.bind(database);
  async function read(guardOnly = false): Promise<unknown[]> {
    const gate = predicate(await fence(selection)),
      operationId = bindingUuid(crypto.randomUUID());
    const raw = await batch([
      prepare(
        `INSERT INTO action_engine_atomic_assertions(operation_id,allowed) SELECT ?,CASE WHEN (${gate.sql}) THEN 1 ELSE 0 END`,
      ).bind(operationId, ...gate.bindings),
      guardOnly
        ? prepare('SELECT 1 AS admitted')
        : prepare(selectionSql).bind(
            selection.actor.userId,
            selection.installationId,
            selection.actor.organizationId,
            selection.sourceId,
            selection.proposalId,
          ),
      prepare(
        'DELETE FROM action_engine_atomic_assertions WHERE operation_id=?',
      ).bind(operationId),
    ]);
    let results: unknown[];
    try {
      results = array(raw, 3);
      if (results.length !== 3) return unavailable();
      const captured = results.map((result) => {
        const fields = bindingExact(result, ['success', 'results', 'meta']);
        if (fields.success !== true) return unavailable();
        bindingRecord(fields.meta);
        return array(fields.results, 2);
      });
      if (captured[0].length !== 0 || captured[2].length !== 0)
        return unavailable();
      if (guardOnly) {
        if (
          captured[1].length !== 1 ||
          bindingExact(captured[1][0], ['admitted']).admitted !== 1
        )
          return unavailable();
      }
      return captured[1];
    } catch {
      return unavailable();
    }
  }
  let state: QuoteReservationState;
  try {
    // Capture the closed result before the next admission await.
    state = captureState(await read());
  } catch (error) {
    try {
      await read(true);
    } catch (fresh) {
      throw boundedError(fresh);
    }
    throw boundedError(error);
  }
  try {
    await read(true);
  } catch (error) {
    throw boundedError(error);
  }
  return state;
}
