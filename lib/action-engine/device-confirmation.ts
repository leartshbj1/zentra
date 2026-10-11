import { requireDeviceSession, type DeviceSessionContext } from '@/lib/account';
import { ACCOUNT_ROLES, roleCanWriteInvoices } from '@/lib/account-security';
import { database } from '@/lib/runtime';
import { createDeviceQuoteAuthority } from './production-admission';
import { readSupportQuoteAccess } from './support-source';
import { createHistoricalQuoteFences } from './historical-quote-fences';
import {
  readBoundQuoteExecution,
  type BoundQuoteExecution,
} from './confirmation-records';
import { loadCanonicalQuotePublication } from './confirmation-publication';
import {
  createPublicationLedger,
  capturePublicationAttempt,
} from './publication-ledger';
import { createD1QuoteLedger } from './ledger';
import { QuoteLedgerError } from './ledger-types';
import {
  createD1QuotePublicationEvidence,
  type QuotePublicationEvidence,
} from './quote-publication-evidence';
import {
  verifyCanonicalQuotePublication,
  CanonicalQuoteError,
} from './canonical-quote';
import { bindingExact, bindingUuid } from './reservation-binding';
import { ActionEngineError, type DraftQuoteReceipt } from './types';
import { actionIdentifier, captureReceipt } from './validation';

/** Selectors only: no request identity, permission, receipt, plan or SQL is trusted. */
export type QuoteConfirmationInput = Readonly<{
  sourceId: string;
  proposalId: string;
  reservationId: string;
  publicationSnapshotId: string;
}>;
function captureInput(raw: unknown): QuoteConfirmationInput {
  const fields = bindingExact(raw, [
    'sourceId',
    'proposalId',
    'reservationId',
    'publicationSnapshotId',
  ]);
  return Object.freeze({
    sourceId: actionIdentifier(fields.sourceId),
    proposalId: actionIdentifier(fields.proposalId),
    reservationId: bindingUuid(fields.reservationId),
    publicationSnapshotId: bindingUuid(fields.publicationSnapshotId),
  });
}
function matchEvidence(
  evidence: QuotePublicationEvidence,
  record: BoundQuoteExecution,
  input: QuoteConfirmationInput,
): DraftQuoteReceipt {
  const r = record.reservation;
  if (
    evidence.organizationId !== r.organizationId ||
    evidence.sourceId !== input.sourceId ||
    evidence.proposalId !== r.proposalId ||
    evidence.reservationId !== r.id ||
    evidence.fingerprint !== r.fingerprint ||
    evidence.userId !== r.userId ||
    evidence.installationId !== r.installationId ||
    evidence.customerId !== r.customerId ||
    evidence.quoteId !== r.quoteId ||
    evidence.snapshotId !== input.publicationSnapshotId ||
    JSON.stringify(evidence.reservationBinding) !==
      JSON.stringify(record.binding)
  )
    throw new QuoteLedgerError('conflict');
  const receipt = captureReceipt(evidence.receipt, record.proposal);
  if (
    r.receipt !== null &&
    JSON.stringify(r.receipt) !== JSON.stringify(receipt)
  )
    throw new QuoteLedgerError('conflict');
  return receipt;
}

/**
 * Private A7 composition. No HTTP route, trigger, native command or notification.
 * This confirms a historical creation fact; it never creates/issues/sends a quote.
 * Rights, country and Support delegation are fenced again at every D1 mutation.
 * Recovery requires A6 evidence even if a legacy ledger receipt already exists.
 */
export async function confirmDeviceSupportQuote(
  request: Request,
  rawInput: QuoteConfirmationInput,
): Promise<DraftQuoteReceipt> {
  // Capture all caller-owned values before authentication or any digest await.
  const input = captureInput(rawInput);
  const captured = new Request(request.url, {
    headers: new Headers(request.headers),
  });
  const authority = await createDeviceQuoteAuthority(captured);
  await authority.authorizeRead();
  let session: Readonly<DeviceSessionContext>;
  try {
    session = Object.freeze({
      ...(await requireDeviceSession(
        captured,
        ACCOUNT_ROLES.filter(roleCanWriteInvoices),
      )),
    });
  } catch (error) {
    await authority.authorizeRead();
    throw error;
  }
  if (
    session.organizationId !== authority.actor.organizationId ||
    session.userId !== authority.actor.userId ||
    session.installationId !== authority.installationId
  )
    throw new ActionEngineError('forbidden');
  let access;
  try {
    access = await readSupportQuoteAccess(authority.actor, input.sourceId);
  } catch (error) {
    await authority.authorizeRead();
    throw error;
  }
  if (access.sourceId !== input.sourceId)
    throw new ActionEngineError('forbidden');
  const fences = createHistoricalQuoteFences(authority, access);
  const db = database();
  const readFence = () =>
    fences.ledgerFence({
      operation: 'read',
      actor: authority.actor,
      sourceId: null,
      proposalId: input.proposalId,
    });
  const authorize = async () => {
    const predicate = await readFence();
    const row = await db
      .prepare(
        `SELECT CASE WHEN (${predicate.sql}) THEN 1 ELSE 0 END AS allowed`,
      )
      .bind(...predicate.bindings)
      .first<{ allowed: number }>();
    if (row?.allowed !== 1) throw new ActionEngineError('forbidden');
  };
  // A rejection never bypasses the fresh grant check to disclose stale data.
  const checked = async <T>(operation: () => Promise<T>): Promise<T> => {
    await authorize();
    let result: T;
    try {
      result = await operation();
    } catch (error) {
      await authorize();
      throw error;
    }
    await authorize();
    return result;
  };
  const record = await checked(() =>
    readBoundQuoteExecution(db, readFence, {
      actor: authority.actor,
      installationId: authority.installationId,
      sourceId: input.sourceId,
      proposalId: input.proposalId,
      reservationId: input.reservationId,
    }),
  );
  const evidenceStore = createD1QuotePublicationEvidence(
    db,
    fences.evidenceFence,
  );
  const ledger = createD1QuoteLedger(db, fences.ledgerFence);
  let evidence = await checked(() =>
    evidenceStore.read(authority.actor, input.reservationId),
  );
  if (evidence === null) {
    // A receipt from an older path is not retroactive canonical evidence.
    if (record.reservation.receipt !== null)
      throw new CanonicalQuoteError('review_required');
    const saved = await checked(() =>
      createPublicationLedger(db).read(
        authority.actor.organizationId,
        input.publicationSnapshotId,
      ),
    );
    if (!saved) throw new CanonicalQuoteError('review_required');
    const attempt = capturePublicationAttempt(saved);
    if (
      attempt.organizationId !== authority.actor.organizationId ||
      attempt.userId !== authority.actor.userId ||
      attempt.installationId !== authority.installationId ||
      attempt.snapshotId !== input.publicationSnapshotId ||
      attempt.createdAt < record.reservation.createdAt ||
      attempt.baseRevision < record.binding.planningPublication.revision
    )
      throw new QuoteLedgerError('conflict');
    const loaded = await checked(() =>
      loadCanonicalQuotePublication(session, attempt, authorize),
    );
    const verified = await checked(() =>
      verifyCanonicalQuotePublication({
        proposal: record.proposal,
        reservation: record.reservation,
        binding: record.binding,
        publication: loaded.publication,
        sqliteBytes: loaded.sqliteBytes,
      }),
    );
    evidence = await checked(() =>
      evidenceStore.append(authority.actor, verified),
    );
  }
  const receipt = matchEvidence(evidence, record, input);
  const confirmed = await checked(() =>
    ledger.confirmExecution(
      authority.actor,
      input.proposalId,
      authority.installationId,
      input.reservationId,
      receipt,
    ),
  );
  if (JSON.stringify(confirmed) !== JSON.stringify(receipt))
    throw new QuoteLedgerError('conflict');
  return captureReceipt(confirmed, record.proposal);
}
