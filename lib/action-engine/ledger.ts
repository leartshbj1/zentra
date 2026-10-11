import { quotePlanFingerprint } from './engine';
import { captureQuoteReservationBinding } from './reservation-binding';
import {
  ActionEngineError,
  type ActionActor,
  type ActionAdmission,
  type DraftQuoteReceipt,
  type QuotePlan,
  type StoredQuoteProposal,
} from './types';
import {
  actionIdentifier,
  captureActor,
  captureAdmission,
  captureProposal,
  captureQuotePlan,
  captureReceipt,
} from './validation';
import {
  QuoteLedgerError,
  type QuoteExecutionReservation,
  type QuoteLedgerFence,
  type QuoteLedgerFenceRequest,
  type QuoteLedgerPredicate,
  type QuoteProposalLedger,
  type QuoteReservationResult,
  type QuoteReservationBinding,
} from './ledger-types';

type LedgerDatabase = Pick<D1Database, 'prepare' | 'batch'>;
type ProposalRow = {
  id: string;
  organization_id: string;
  source_id: string;
  action_kind: string;
  fingerprint: string;
  source_revision: string;
  context_revision: string;
  plan_json: string;
  created_by: string;
  created_at: number;
};
type ReservationRow = {
  id: string;
  organization_id: string;
  proposal_id: string;
  fingerprint: string;
  user_id: string;
  installation_id: string;
  customer_id: string;
  quote_id: string;
  created_at: number;
  receipt_json: string | null;
  confirmed_at: number | null;
};
const invalid = (): never => {
  throw new QuoteLedgerError('invalid_record');
};
const uuid = (raw: unknown): string => {
  if (
    typeof raw !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      raw,
    )
  )
    return invalid();
  return raw;
};
const timestamp = (raw: unknown): number => {
  if (
    typeof raw !== 'number' ||
    !Number.isSafeInteger(raw) ||
    raw < 1 ||
    raw > 253402300799
  )
    return invalid();
  return raw;
};
function databaseError(error: unknown): never {
  if (error instanceof QuoteLedgerError || error instanceof ActionEngineError)
    throw error;
  // Do not expose SQL, bindings, source text or server details in a public error.
  if (error instanceof Error && error.message.includes('action_engine_denied'))
    throw new QuoteLedgerError('forbidden');
  throw new QuoteLedgerError('service_unavailable');
}

function predicate(raw: QuoteLedgerPredicate): QuoteLedgerPredicate {
  // Capture the private fence result before any further await; no getters/coercion.
  if (
    !raw ||
    typeof raw !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
  )
    return invalid();
  const fields = Object.getOwnPropertyDescriptors(raw);
  if (
    Reflect.ownKeys(raw).length !== 2 ||
    !fields.sql?.enumerable ||
    !('value' in fields.sql) ||
    !fields.bindings?.enumerable ||
    !('value' in fields.bindings)
  )
    return invalid();
  const sql: unknown = fields.sql.value,
    values: unknown = fields.bindings.value;
  if (
    typeof sql !== 'string' ||
    !sql.trim() ||
    sql.length > 16000 ||
    sql.includes(';') ||
    sql.includes(String.fromCharCode(0)) ||
    !Array.isArray(values) ||
    Object.getPrototypeOf(values) !== Array.prototype
  )
    return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(values as object),
    length: unknown = descriptors.length?.value;
  if (
    typeof length !== 'number' ||
    !Number.isInteger(length) ||
    length > 64 ||
    length < 0 ||
    Reflect.ownKeys(values).length !== length + 1
  )
    return invalid();
  const bindings: (string | number | null)[] = [];
  for (let at = 0; at < length; at++) {
    const field = descriptors[String(at)];
    if (!field || !field.enumerable || !('value' in field)) return invalid();
    const value: unknown = field.value;
    if (
      value !== null &&
      !(typeof value === 'string' && value.length <= 65536) &&
      !(typeof value === 'number' && Number.isFinite(value))
    )
      return invalid();
    bindings.push(value as string | number | null);
  }
  return Object.freeze({ sql, bindings: Object.freeze(bindings) });
}

async function proposalFromRow(
  row: ProposalRow,
  actor: ActionActor,
): Promise<StoredQuoteProposal> {
  try {
    const stored = captureProposal(
      {
        id: row.id,
        organizationId: row.organization_id,
        fingerprint: row.fingerprint,
        plan: JSON.parse(row.plan_json),
      },
      actor,
    );
    if (
      row.source_id !== stored.plan.sourceId ||
      row.action_kind !== stored.plan.kind ||
      row.source_revision !== stored.plan.sourceRevision ||
      row.context_revision !== stored.plan.contextRevision ||
      (await quotePlanFingerprint(stored.plan)) !== stored.fingerprint
    )
      return invalid();
    actionIdentifier(row.created_by);
    timestamp(row.created_at);
    return stored;
  } catch (error) {
    if (error instanceof QuoteLedgerError) throw error;
    return invalid();
  }
}

function reservationFromRow(
  row: ReservationRow,
  stored: StoredQuoteProposal,
): QuoteExecutionReservation {
  try {
    if (
      row.organization_id !== stored.organizationId ||
      row.proposal_id !== stored.id ||
      row.fingerprint !== stored.fingerprint ||
      (row.receipt_json === null) !== (row.confirmed_at === null)
    )
      return invalid();
    const reservation = {
      id: uuid(row.id),
      organizationId: stored.organizationId,
      proposalId: stored.id,
      fingerprint: stored.fingerprint,
      userId: actionIdentifier(row.user_id),
      installationId: actionIdentifier(row.installation_id),
      customerId: actionIdentifier(row.customer_id),
      quoteId: uuid(row.quote_id),
      createdAt: timestamp(row.created_at),
      receipt:
        row.receipt_json === null
          ? null
          : captureReceipt(JSON.parse(row.receipt_json), stored),
    };
    if (stored.plan.customer?.kind === 'existing') {
      if (reservation.customerId !== stored.plan.customer.id) return invalid();
    } else {
      uuid(reservation.customerId);
    }
    if (
      reservation.receipt !== null &&
      (reservation.receipt.customerId !== reservation.customerId ||
        reservation.receipt.quoteId !== reservation.quoteId ||
        timestamp(row.confirmed_at) < reservation.createdAt)
    )
      return invalid();
    return Object.freeze(reservation);
  } catch (error) {
    if (error instanceof QuoteLedgerError) throw error;
    return invalid();
  }
}

function receiptClaim(raw: DraftQuoteReceipt): DraftQuoteReceipt {
  if (
    !raw ||
    typeof raw !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
  )
    return invalid();
  const keys = [
    'organizationId',
    'proposalId',
    'fingerprint',
    'customerId',
    'quoteId',
    'quoteNumber',
    'status',
    'requiresHumanValidation',
  ];
  const descriptors = Object.getOwnPropertyDescriptors(raw),
    data: Record<string, unknown> = Object.create(null);
  if (Reflect.ownKeys(raw).length !== keys.length) return invalid();
  for (const key of keys) {
    const field = descriptors[key];
    if (!field || !field.enumerable || !('value' in field)) return invalid();
    data[key] = field.value;
  }
  if (
    typeof data.fingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/.test(data.fingerprint) ||
    data.quoteNumber !== null ||
    data.status !== 'draft' ||
    data.requiresHumanValidation !== true
  )
    return invalid();
  return Object.freeze({
    organizationId: actionIdentifier(data.organizationId),
    proposalId: actionIdentifier(data.proposalId),
    fingerprint: data.fingerprint,
    customerId: actionIdentifier(data.customerId),
    quoteId: actionIdentifier(data.quoteId),
    quoteNumber: null,
    status: 'draft',
    requiresHumanValidation: true,
  });
}

/**
 * Private D1 ledger; deliberately not a route or a native writer.
 * Its mandatory fence guarantees atomic evaluation of the supplied predicate,
 * not the correctness of an as-yet-unimplemented commercial authorization adapter.
 */
export function createD1QuoteLedger(
  database: LedgerDatabase,
  rawFence: QuoteLedgerFence,
  options: {
    nowSeconds?: () => number;
    newUuid?: () => string;
    reservationBinding?: QuoteReservationBinding;
  } = {},
): QuoteProposalLedger {
  if (typeof rawFence !== 'function') throw new QuoteLedgerError('forbidden');
  if (
    !options ||
    typeof options !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(options))
  )
    return invalid();
  const optionFields = Object.getOwnPropertyDescriptors(options);
  if (
    Reflect.ownKeys(options).some(
      (key) =>
        typeof key !== 'string' ||
        !['nowSeconds', 'newUuid', 'reservationBinding'].includes(key) ||
        !optionFields[key]?.enumerable ||
        !('value' in optionFields[key]),
    )
  )
    return invalid();
  for (const key of ['nowSeconds', 'newUuid'])
    if (
      optionFields[key] &&
      optionFields[key].value !== undefined &&
      typeof optionFields[key].value !== 'function'
    )
      return invalid();
  const reservationBinding =
    optionFields.reservationBinding?.value === undefined
      ? null
      : captureQuoteReservationBinding(optionFields.reservationBinding.value);
  const fence = rawFence.bind(undefined),
    nowSeconds =
      (optionFields.nowSeconds?.value as (() => number) | undefined) ??
      (() => Math.floor(Date.now() / 1000)),
    newUuid =
      (optionFields.newUuid?.value as (() => string) | undefined) ??
      (() => crypto.randomUUID());
  const nextId = () => {
    try {
      return uuid(newUuid());
    } catch (error) {
      return databaseError(error);
    }
  };
  const now = () => {
    try {
      return timestamp(nowSeconds());
    } catch (error) {
      return databaseError(error);
    }
  };
  const prepare = database.prepare.bind(database),
    batch = database.batch.bind(database);
  const assertion = (operationId: string, p: QuoteLedgerPredicate) =>
    prepare(
      `INSERT INTO action_engine_atomic_assertions(operation_id,allowed) SELECT ?,CASE WHEN (${p.sql}) THEN 1 ELSE 0 END`,
    ).bind(operationId, ...p.bindings);
  const cleanup = (operationId: string) =>
    prepare(
      'DELETE FROM action_engine_atomic_assertions WHERE operation_id=?',
    ).bind(operationId);
  async function atomic(
    request: QuoteLedgerFenceRequest,
    statements: D1PreparedStatement[],
    readIndex: number,
  ): Promise<unknown[]> {
    try {
      const gate = predicate(await fence(Object.freeze(request))),
        operationId = nextId();
      const results = await batch([
        assertion(operationId, gate),
        ...statements,
        cleanup(operationId),
      ]);
      if (
        results.some((result) => !result.success) ||
        !Array.isArray(results[readIndex + 1]?.results)
      )
        throw new QuoteLedgerError('service_unavailable');
      return results[readIndex + 1].results;
    } catch (error) {
      return databaseError(error);
    }
  }
  async function readProposal(
    actor: ActionActor,
    sourceId: string | null,
    proposalId: string | null,
  ): Promise<StoredQuoteProposal | null> {
    const rows = await atomic(
      { operation: 'read', actor, sourceId, proposalId },
      [
        prepare(
          `SELECT * FROM action_engine_quote_proposals WHERE organization_id=? AND ${sourceId !== null ? "source_id=? AND action_kind='prepare_quote_draft'" : 'id=?'}`,
        ).bind(actor.organizationId, sourceId ?? proposalId),
      ],
      0,
    );
    if (rows.length > 1) return invalid();
    return rows.length ? proposalFromRow(rows[0] as ProposalRow, actor) : null;
  }
  const reservationSelect = (stored: StoredQuoteProposal) =>
    prepare(
      reservationBinding
        ? `SELECT r.*,(SELECT json_object('resourcesSha256',b.resources_sha256,'sourceCanonicalSha256',b.source_canonical_sha256,'planningPublication',json_object('organizationId',b.organization_id,'snapshotId',b.planning_snapshot_id,'revision',b.planning_revision,'baseRevision',b.planning_base_revision,'archiveSha256',b.planning_archive_sha256,'manifestSha256',b.planning_manifest_sha256)) FROM action_engine_quote_reservation_bindings b WHERE b.reservation_id=r.id AND b.organization_id=r.organization_id AND b.proposal_id=r.proposal_id AND b.fingerprint=r.fingerprint) AS reservation_binding_json FROM action_engine_quote_reservations r WHERE r.organization_id=? AND r.proposal_id=? AND r.fingerprint=?`
        : 'SELECT * FROM action_engine_quote_reservations WHERE organization_id=? AND proposal_id=? AND fingerprint=?',
    ).bind(stored.organizationId, stored.id, stored.fingerprint);
  function requireBinding(raw: unknown) {
    if (!reservationBinding) return;
    const field =
      raw && typeof raw === 'object'
        ? Object.getOwnPropertyDescriptor(raw, 'reservation_binding_json')
        : undefined;
    if (!field || !('value' in field) || typeof field.value !== 'string')
      throw new QuoteLedgerError('conflict');
    let binding: QuoteReservationBinding;
    try {
      binding = captureQuoteReservationBinding(JSON.parse(field.value));
    } catch {
      return invalid();
    }
    if (JSON.stringify(binding) !== JSON.stringify(reservationBinding))
      throw new QuoteLedgerError('conflict');
  }
  function audit(
    stored: StoredQuoteProposal,
    actor: ActionActor,
    kind: string,
    at: number,
    reservationId: string | null = null,
  ) {
    const condition =
      kind === 'proposal_saved'
        ? ''
        : kind === 'execution_reserved'
          ? ' AND EXISTS(SELECT 1 FROM action_engine_quote_reservations r WHERE r.proposal_id=p.id AND r.id=?)'
          : ' AND EXISTS(SELECT 1 FROM action_engine_quote_reservations r WHERE r.proposal_id=p.id AND r.id=? AND r.receipt_json IS NOT NULL)';
    return prepare(`INSERT INTO action_engine_quote_events(id,organization_id,proposal_id,fingerprint,event_type,actor_user_id,created_at)
      SELECT ?,p.organization_id,p.id,p.fingerprint,?,?,? FROM action_engine_quote_proposals p WHERE p.id=? AND p.organization_id=? AND p.fingerprint=?
      AND NOT EXISTS(SELECT 1 FROM action_engine_quote_events e WHERE e.proposal_id=p.id AND e.event_type=?)${condition}`).bind(
      nextId(),
      kind,
      actor.userId,
      at,
      stored.id,
      actor.organizationId,
      stored.fingerprint,
      kind,
      ...(reservationId === null ? [] : [reservationId]),
    );
  }
  async function readReservation(
    actor: ActionActor,
    stored: StoredQuoteProposal,
  ): Promise<QuoteExecutionReservation | null> {
    const rows = await atomic(
      { operation: 'read', actor, sourceId: null, proposalId: stored.id },
      [reservationSelect(stored)],
      0,
    );
    if (rows.length > 1) return invalid();
    if (rows.length) requireBinding(rows[0]);
    return rows.length
      ? reservationFromRow(rows[0] as ReservationRow, stored)
      : null;
  }
  return {
    findProposal: (rawActor, rawSourceId) =>
      readProposal(captureActor(rawActor), actionIdentifier(rawSourceId), null),
    loadProposal: (rawActor, rawProposalId) =>
      readProposal(
        captureActor(rawActor),
        null,
        actionIdentifier(rawProposalId),
      ),
    async saveProposal(
      rawActor: ActionActor,
      rawPlan: QuotePlan,
      rawFingerprint: string,
      rawAdmission: ActionAdmission,
    ) {
      const actor = captureActor(rawActor),
        admission = captureAdmission(rawAdmission, actor),
        plan = captureQuotePlan(rawPlan);
      if (
        plan.organizationId !== actor.organizationId ||
        typeof rawFingerprint !== 'string' ||
        !/^[0-9a-f]{64}$/.test(rawFingerprint)
      )
        return invalid();
      const fingerprint = rawFingerprint;
      if ((await quotePlanFingerprint(plan)) !== fingerprint) return invalid();
      const candidate = captureProposal(
          {
            id: nextId(),
            organizationId: actor.organizationId,
            fingerprint,
            plan,
          },
          actor,
        ),
        at = now();
      const rows = await atomic(
        { operation: 'save', actor, admission, proposal: candidate },
        [
          prepare(`INSERT INTO action_engine_quote_proposals(id,organization_id,source_id,action_kind,fingerprint,source_revision,context_revision,plan_json,created_by,created_at)
          SELECT ?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM action_engine_quote_proposals WHERE organization_id=? AND source_id=? AND action_kind=?)`).bind(
            candidate.id,
            actor.organizationId,
            plan.sourceId,
            plan.kind,
            fingerprint,
            plan.sourceRevision,
            plan.contextRevision,
            JSON.stringify(plan),
            actor.userId,
            at,
            actor.organizationId,
            plan.sourceId,
            plan.kind,
          ),
          // Insert the audit for the stored identity, even when a prior response was lost.
          prepare(`INSERT INTO action_engine_quote_events(id,organization_id,proposal_id,fingerprint,event_type,actor_user_id,created_at)
          SELECT ?,p.organization_id,p.id,p.fingerprint,'proposal_saved',p.created_by,p.created_at FROM action_engine_quote_proposals p
          WHERE p.organization_id=? AND p.source_id=? AND p.action_kind=? AND NOT EXISTS(SELECT 1 FROM action_engine_quote_events e WHERE e.proposal_id=p.id AND e.event_type='proposal_saved')`).bind(
            nextId(),
            actor.organizationId,
            plan.sourceId,
            plan.kind,
          ),
          prepare(
            'SELECT * FROM action_engine_quote_proposals WHERE organization_id=? AND source_id=? AND action_kind=?',
          ).bind(actor.organizationId, plan.sourceId, plan.kind),
        ],
        2,
      );
      if (rows.length !== 1) return invalid();
      const saved = await proposalFromRow(rows[0] as ProposalRow, actor);
      if (saved.fingerprint !== fingerprint)
        throw new QuoteLedgerError('conflict');
      return saved;
    },
    async reserveExecution(
      rawActor,
      rawProposalId,
      rawInstallationId,
    ): Promise<QuoteReservationResult> {
      const actor = captureActor(rawActor),
        proposalId = actionIdentifier(rawProposalId),
        installationId = actionIdentifier(rawInstallationId);
      if (
        reservationBinding &&
        reservationBinding.planningPublication.organizationId !==
          actor.organizationId
      )
        return invalid();
      const stored = await readProposal(actor, null, proposalId);
      if (!stored) return invalid();
      if (stored.plan.status !== 'ready')
        throw new ActionEngineError('review_required');
      // Historical confirmation is recovered with current authorization only,
      // without requiring old source/catalogue revisions to remain current.
      const prior = await readReservation(actor, stored);
      if (prior?.receipt)
        return Object.freeze({ state: 'confirmed', receipt: prior.receipt });
      if (prior !== null) {
        if (
          prior.userId !== actor.userId ||
          prior.installationId !== installationId
        )
          return Object.freeze({ state: 'held', proposalId });
        // A read permission is not permission to resume a draft write. Recheck
        // the full reserve fence (including source/catalogue) in a fresh batch.
        // The native adapter still must recover its local receipt before writing.
        const replayRows = await atomic(
          { operation: 'reserve', actor, proposal: stored, installationId },
          [reservationSelect(stored)],
          0,
        );
        if (replayRows.length !== 1) return invalid();
        requireBinding(replayRows[0]);
        const replay = reservationFromRow(
          replayRows[0] as ReservationRow,
          stored,
        );
        if (replay.receipt)
          return Object.freeze({ state: 'confirmed', receipt: replay.receipt });
        if (
          replay.userId !== actor.userId ||
          replay.installationId !== installationId ||
          replay.id !== prior.id
        )
          return invalid();
        return Object.freeze({ state: 'reserved', reservation: replay });
      }
      const id = nextId(),
        customerId =
          stored.plan.customer?.kind === 'existing'
            ? stored.plan.customer.id
            : nextId(),
        quoteId = nextId(),
        at = now();
      const rows = await atomic(
        { operation: 'reserve', actor, proposal: stored, installationId },
        [
          prepare(`INSERT INTO action_engine_quote_reservations(id,organization_id,proposal_id,fingerprint,user_id,installation_id,customer_id,quote_id,created_at)
          SELECT ?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM action_engine_quote_reservations WHERE proposal_id=?)`).bind(
            id,
            actor.organizationId,
            stored.id,
            stored.fingerprint,
            actor.userId,
            installationId,
            customerId,
            quoteId,
            at,
            stored.id,
          ),
          ...(reservationBinding
            ? [
                prepare(`INSERT INTO action_engine_quote_reservation_bindings(reservation_id,organization_id,proposal_id,fingerprint,resources_sha256,source_canonical_sha256,planning_snapshot_id,planning_revision,planning_base_revision,planning_archive_sha256,planning_manifest_sha256,created_at)
            SELECT r.id,r.organization_id,r.proposal_id,r.fingerprint,?,?,?,?,?,?,?,r.created_at FROM action_engine_quote_reservations r WHERE r.id=? AND r.organization_id=? AND r.proposal_id=?`).bind(
                  reservationBinding.resourcesSha256,
                  reservationBinding.sourceCanonicalSha256,
                  reservationBinding.planningPublication.snapshotId,
                  reservationBinding.planningPublication.revision,
                  reservationBinding.planningPublication.baseRevision,
                  reservationBinding.planningPublication.archiveSha256,
                  reservationBinding.planningPublication.manifestSha256,
                  id,
                  actor.organizationId,
                  stored.id,
                ),
              ]
            : []),
          audit(stored, actor, 'execution_reserved', at, id),
          reservationSelect(stored),
        ],
        reservationBinding ? 3 : 2,
      );
      if (rows.length !== 1) return invalid();
      requireBinding(rows[0]);
      const reservation = reservationFromRow(rows[0] as ReservationRow, stored);
      if (reservation.receipt)
        return Object.freeze({
          state: 'confirmed',
          receipt: reservation.receipt,
        });
      return reservation.userId === actor.userId &&
        reservation.installationId === installationId
        ? Object.freeze({ state: 'reserved', reservation })
        : Object.freeze({ state: 'held', proposalId });
    },
    async confirmExecution(
      rawActor,
      rawProposalId,
      rawInstallationId,
      rawReservationId,
      rawReceipt,
    ) {
      const actor = captureActor(rawActor),
        proposalId = actionIdentifier(rawProposalId),
        installationId = actionIdentifier(rawInstallationId),
        reservationId = uuid(rawReservationId);
      // Capture caller-owned values before the first await.
      const claim = receiptClaim(rawReceipt);
      const stored = await readProposal(actor, null, proposalId);
      if (!stored) return invalid();
      let receipt: DraftQuoteReceipt;
      try {
        receipt = captureReceipt(claim, stored);
      } catch {
        return invalid();
      }
      const reservation = await readReservation(actor, stored);
      if (
        !reservation ||
        reservation.id !== reservationId ||
        reservation.userId !== actor.userId ||
        reservation.installationId !== installationId
      )
        throw new QuoteLedgerError('forbidden');
      if (
        reservation.customerId !== receipt.customerId ||
        reservation.quoteId !== receipt.quoteId
      )
        return invalid();
      const receiptJson = JSON.stringify(receipt);
      if (reservation.receipt !== null) {
        if (JSON.stringify(reservation.receipt) !== receiptJson)
          throw new QuoteLedgerError('conflict');
        return reservation.receipt;
      }
      const at = now();
      if (at < reservation.createdAt) return invalid();
      const rows = await atomic(
        { operation: 'confirm', actor, proposal: stored, reservation, receipt },
        [
          prepare(`UPDATE action_engine_quote_reservations SET receipt_json=?,confirmed_at=?
          WHERE organization_id=? AND proposal_id=? AND fingerprint=? AND id=? AND user_id=? AND installation_id=? AND receipt_json IS NULL`).bind(
            receiptJson,
            at,
            actor.organizationId,
            stored.id,
            stored.fingerprint,
            reservationId,
            actor.userId,
            installationId,
          ),
          audit(stored, actor, 'receipt_confirmed', at, reservationId),
          reservationSelect(stored),
        ],
        2,
      );
      if (rows.length !== 1) return invalid();
      const saved = reservationFromRow(rows[0] as ReservationRow, stored);
      if (
        saved.receipt === null ||
        JSON.stringify(saved.receipt) !== receiptJson
      )
        throw new QuoteLedgerError('conflict');
      return saved.receipt;
    },
  };
}
