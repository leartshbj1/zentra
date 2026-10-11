import { database } from '@/lib/runtime';
import { sha256Hex, AccountPublicError } from '@/lib/account-security';
import { createDeviceQuoteAuthority } from './production-admission';
import { publicationCoordinationEnabled } from './publication-gateway';
import { loadDeviceQuotePlanningContext } from './published-context';
import { createPublishedQuoteFences } from './published-fences';
import {
  readSupportQuoteAccess,
  combineQuotePredicates,
} from './support-source';
import { createHistoricalQuoteFences } from './historical-quote-fences';
import { createD1QuoteLedger } from './ledger';
import {
  QuoteLedgerError,
  type QuoteExecutionReservation,
  type QuoteReservationBinding,
  type QuoteLedgerPredicate,
} from './ledger-types';
import {
  readQuoteReservationState,
  type QuoteReservationState,
} from './reservation-state';
import { readBoundQuoteExecution } from './confirmation-records';
import { confirmDeviceSupportQuote } from './device-confirmation';
import { bindingExact } from './reservation-binding';
import {
  actionIdentifier,
  captureActor,
  captureReceipt,
  validatePlanAgainstContext,
} from './validation';
import {
  ActionEngineError,
  type ActionActor,
  type ActionSource,
  type DraftQuoteReceipt,
  type StoredQuoteProposal,
} from './types';

export type DeviceQuoteReservationInput = Readonly<{
  sourceId: string;
  proposalId: string;
}>;
export type DeviceQuoteReservationResult =
  | Readonly<{ state: 'held'; proposalId: string }>
  | Readonly<{
      state: 'confirmed';
      sourceId: string;
      proposalId: string;
      reservationId: string;
      publicationSnapshotId: string;
      receipt: DraftQuoteReceipt;
    }>
  | Readonly<{
      state: 'recovery_required';
      proposalId: string;
      reservationId: string;
      fingerprint: string;
    }>
  | Readonly<{
      state: 'reserved';
      actor: ActionActor;
      installationId: string;
      authorizationRevision: string;
      proposal: StoredQuoteProposal;
      canonicalPlanJson: string;
      reservation: QuoteExecutionReservation;
      binding: QuoteReservationBinding;
      source: ActionSource;
    }>;

const own = (state: QuoteReservationState) => state.state === 'owned';
function serializableStrings(
  proposal: StoredQuoteProposal,
  source: ActionSource,
) {
  const customer = proposal.plan.customer;
  const strings = [
    proposal.plan.title,
    ...Object.values(source),
    ...(customer
      ? [customer.name, ...(customer.kind === 'new' ? [customer.email] : [])]
      : []),
    ...proposal.plan.lines.flatMap((line) => [
      line.description,
      line.unit,
      line.evidence,
    ]),
  ];
  // Serde rejects lone surrogates; do not normalize their bytes or repair a hash.
  for (const value of strings)
    for (const point of value) {
      const code = point.charCodeAt(0);
      if (point.length === 1 && code >= 0xd800 && code <= 0xdfff)
        throw new ActionEngineError('review_required');
    }
}

/** Private server composition; no endpoint/IPC/Support trigger calls this yet.
 * Only a fresh `reserved` result supplies a draft-write input. Historical
 * recovery grants no write, never transfers a reservation and never calls AI.
 * Rust must recover its receipt first and recorroborate local resources/origin.
 */
export async function reserveDeviceSupportQuote(
  request: Request,
  rawInput: DeviceQuoteReservationInput,
): Promise<DeviceQuoteReservationResult> {
  const fields = bindingExact(rawInput, ['sourceId', 'proposalId']);
  const input = Object.freeze({
    sourceId: actionIdentifier(fields.sourceId),
    proposalId: actionIdentifier(fields.proposalId),
  });
  const captured = new Request(request.url, {
    headers: new Headers(request.headers),
  });
  const authority = await createDeviceQuoteAuthority(captured);
  await authority.authorizeRead();
  const actor = captureActor(authority.actor),
    installationId = actionIdentifier(authority.installationId);
  let access;
  try {
    access = await readSupportQuoteAccess(actor, input.sourceId);
  } catch (error) {
    await authority.authorizeRead();
    throw error;
  }
  if (access.sourceId !== input.sourceId)
    throw new ActionEngineError('forbidden');
  const db = database(),
    historical = createHistoricalQuoteFences(authority, access);
  const readFence = () =>
    historical.ledgerFence({
      operation: 'read',
      actor,
      sourceId: input.sourceId,
      proposalId: null,
    });
  const boundFence = () =>
    historical.ledgerFence({
      operation: 'read',
      actor,
      sourceId: null,
      proposalId: input.proposalId,
    });
  const authorizeRead = async () => {
    const predicate = await readFence();
    try {
      const row = await db
        .prepare(
          `SELECT CASE WHEN (${predicate.sql}) THEN 1 ELSE 0 END AS allowed`,
        )
        .bind(...predicate.bindings)
        .first<{ allowed: number }>();
      if (row?.allowed !== 1) throw new ActionEngineError('forbidden');
    } catch (error) {
      if (error instanceof ActionEngineError) throw error;
      throw new QuoteLedgerError('service_unavailable');
    }
  };
  const checked = async <T>(operation: () => Promise<T>): Promise<T> => {
    await authorizeRead();
    let result: T;
    try {
      result = await operation();
    } catch (error) {
      await authorizeRead();
      throw error;
    }
    await authorizeRead();
    return result;
  };
  const inspect = () =>
    checked(() =>
      readQuoteReservationState(db, readFence, {
        actor,
        installationId,
        sourceId: input.sourceId,
        proposalId: input.proposalId,
      }),
    );
  const bound = (reservationId: string) =>
    checked(() =>
      readBoundQuoteExecution(db, boundFence, {
        actor,
        installationId,
        sourceId: input.sourceId,
        proposalId: input.proposalId,
        reservationId,
      }),
    );
  async function historicalResult(
    state: QuoteReservationState,
  ): Promise<DeviceQuoteReservationResult | null> {
    if (state.state === 'held')
      return Object.freeze({ state: 'held', proposalId: input.proposalId });
    if (state.state !== 'owned') return null;
    const record = await bound(state.reservationId);
    if (state.evidenceSnapshotId !== null) {
      // Never expose reserveExecution's confirmed fast-path. Only A7 may
      // corroborate the exact canonical evidence and return a historical receipt.
      const receipt = await checked(() =>
        confirmDeviceSupportQuote(captured, {
          ...input,
          reservationId: state.reservationId,
          publicationSnapshotId: state.evidenceSnapshotId!,
        }),
      );
      return Object.freeze({
        state: 'confirmed',
        sourceId: input.sourceId,
        proposalId: input.proposalId,
        reservationId: state.reservationId,
        publicationSnapshotId: state.evidenceSnapshotId,
        receipt: captureReceipt(receipt, record.proposal),
      });
    }
    if (state.hasReceipt || record.reservation.receipt !== null)
      throw new ActionEngineError('review_required');
    return null;
  }
  const initial = await inspect();
  const recovered = await historicalResult(initial);
  if (recovered) return recovered;

  try {
    if (!publicationCoordinationEnabled(actor.organizationId))
      throw new ActionEngineError('forbidden');
    const cas = await checked(() => authority.preflightCas());
    const loaded = await checked(() =>
      loadDeviceQuotePlanningContext(captured, input.sourceId),
    );
    const fences = await checked(() =>
      createPublishedQuoteFences(authority, cas, loaded),
    );
    if (fences.context.currency !== 'CHF')
      throw new ActionEngineError('invalid_context');
    const authorizeProgress = async (
      finalReservation?: QuoteLedgerPredicate,
    ) => {
      await authorizeRead();
      if (!publicationCoordinationEnabled(actor.organizationId))
        throw new ActionEngineError('forbidden');
      const current = await authority.preflight();
      if (current.revision !== fences.admission.revision)
        throw new ActionEngineError('stale_plan');
      const predicate = combineQuotePredicates(
        fences.progression(),
        ...(finalReservation ? [finalReservation] : []),
      );
      const row = await db
        .prepare(
          `SELECT CASE WHEN (${predicate.sql}) THEN 1 ELSE 0 END AS allowed`,
        )
        .bind(...predicate.bindings)
        .first<{ allowed: number }>();
      if (row?.allowed !== 1) throw new ActionEngineError('forbidden');
      return current;
    };
    await checked(() => authorizeProgress());
    const ledger = createD1QuoteLedger(
      db,
      async (call) => {
        if (!publicationCoordinationEnabled(actor.organizationId))
          throw new ActionEngineError('forbidden');
        return fences.ledgerFence(call);
      },
      { reservationBinding: fences.reservationBinding },
    );
    const proposal = await checked(() =>
      ledger.loadProposal(actor, input.proposalId),
    );
    if (!proposal || proposal.plan.sourceId !== input.sourceId)
      throw new QuoteLedgerError('invalid_record');
    validatePlanAgainstContext(proposal.plan, fences.context);
    serializableStrings(proposal, fences.context.source);
    const canonicalPlanJson = JSON.stringify(proposal.plan);
    if (
      (await checked(() => sha256Hex(canonicalPlanJson))) !==
      proposal.fingerprint
    )
      throw new QuoteLedgerError('invalid_record');
    const current = await inspect();
    const existing = await historicalResult(current);
    if (existing) return existing;
    await checked(() => authorizeProgress());
    const reserved = await checked(() =>
      ledger.reserveExecution(actor, input.proposalId, installationId),
    );
    const final = await inspect();
    const terminal = await historicalResult(final);
    if (terminal) return terminal;
    if (!own(final)) throw new QuoteLedgerError('invalid_record');
    if (
      reserved.state !== 'reserved' ||
      reserved.reservation.id !== final.reservationId
    )
      throw new QuoteLedgerError('conflict');
    const record = await bound(final.reservationId);
    if (
      JSON.stringify(record.proposal) !== JSON.stringify(proposal) ||
      JSON.stringify(record.binding) !==
        JSON.stringify(fences.reservationBinding) ||
      record.reservation.receipt !== null ||
      (await checked(() =>
        sha256Hex(JSON.stringify(fences.context.source)),
      )) !== record.binding.sourceCanonicalSha256
    )
      throw new QuoteLedgerError('conflict');
    // The final await must check FULL progression and the still-unconfirmed
    // owner in the SAME SQL read. A historical/read-only check after it would
    // admit a paused consent or edited source, or overlook a competing receipt.
    // Immutable proposal/binding facts were corroborated above. On failure the
    // outer handler renews read access before any bounded recovery/confirmation.
    await authorizeProgress({
      sql: `EXISTS(SELECT 1 FROM action_engine_quote_reservations r
        WHERE r.organization_id=? AND r.id=? AND r.proposal_id=? AND r.fingerprint=?
          AND r.user_id=? AND r.installation_id=?
          AND r.receipt_json IS NULL AND NOT EXISTS(
            SELECT 1 FROM action_engine_quote_publication_evidence e
            WHERE e.organization_id=r.organization_id AND e.reservation_id=r.id))`,
      bindings: [
        actor.organizationId,
        record.reservation.id,
        input.proposalId,
        proposal.fingerprint,
        actor.userId,
        installationId,
      ],
    });
    return Object.freeze({
      state: 'reserved',
      actor,
      installationId,
      authorizationRevision: fences.admission.revision,
      proposal: record.proposal,
      canonicalPlanJson,
      reservation: record.reservation,
      binding: record.binding,
      source: fences.context.source,
    });
  } catch (error) {
    // A retained reservation may represent a completed local creation. A stale
    // context/paused consent can authorize local receipt recovery only, not an
    // old-context write. Infrastructure failures are never an absence fallback.
    await authorizeRead();
    if (!(error instanceof ActionEngineError)) {
      if (
        error instanceof QuoteLedgerError ||
        error instanceof AccountPublicError
      )
        throw error;
      throw new QuoteLedgerError('service_unavailable');
    }
    if (!['stale_plan', 'invalid_context', 'forbidden'].includes(error.code))
      throw error;
    const final = await inspect();
    const terminal = await historicalResult(final);
    if (terminal) return terminal;
    if (!own(final)) throw error;
    const record = await bound(final.reservationId);
    await authorizeRead();
    return Object.freeze({
      state: 'recovery_required',
      proposalId: input.proposalId,
      reservationId: final.reservationId,
      fingerprint: record.proposal.fingerprint,
    });
  }
}
