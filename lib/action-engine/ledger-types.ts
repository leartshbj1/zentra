import type {
  ActionActor,
  ActionAdmission,
  DraftQuoteReceipt,
  QuotePlan,
  StoredQuoteProposal,
} from './types';

export type QuoteExecutionReservation = Readonly<{
  id: string;
  organizationId: string;
  proposalId: string;
  fingerprint: string;
  userId: string;
  installationId: string;
  customerId: string;
  quoteId: string;
  createdAt: number;
  receipt: DraftQuoteReceipt | null;
}>;

/** Private server context captured when a NEW execution reservation is made. */
export type QuoteHistoricalPublication = Readonly<{
  organizationId: string;
  snapshotId: string;
  revision: number;
  baseRevision: number;
  archiveSha256: string;
  manifestSha256: string;
}>;

export type QuoteReservationBinding = Readonly<{
  resourcesSha256: string;
  sourceCanonicalSha256: string;
  planningPublication: QuoteHistoricalPublication;
}>;

export type QuoteReservationResult =
  | Readonly<{ state: 'reserved'; reservation: QuoteExecutionReservation }>
  | Readonly<{ state: 'held'; proposalId: string }>
  | Readonly<{ state: 'confirmed'; receipt: DraftQuoteReceipt }>;

/**
 * This is a private server composition boundary, NOT a request DTO.
 * Every predicate must check current authenticated session, tenant membership,
 * seat, commercial rights, action permission and consent (including recovery).
 * Save/reserve must first corroborate the plan against a trusted context using
 * validatePlanAgainstContext, then atomically compare the
 * exact source + catalogue + customer-identity generation/revision (including
 * absence/uniqueness of a new customer's email and existing client archives).
 * Confirm must corroborate the
 * receipt against a committed canonical business-sync publication, not trust a
 * native/browser claim. Historical reads/confirmation must not require the old
 * catalogue to remain current after a successful business commit.
 *
 * SQL is authored by trusted server code. All data uses bindings. Never accept
 * a predicate, admission, actor or installation identity from a request body.
 * Unsupported commercial/session branches must fail closed. There is no new
 * authorization mirror. No production fence is provided by this lot: no route.
 */
export type QuoteLedgerFenceRequest =
  | Readonly<{
      operation: 'read';
      actor: ActionActor;
      sourceId: string | null;
      proposalId: string | null;
    }>
  | Readonly<{
      operation: 'save';
      actor: ActionActor;
      admission: ActionAdmission;
      proposal: StoredQuoteProposal;
    }>
  | Readonly<{
      operation: 'reserve';
      actor: ActionActor;
      proposal: StoredQuoteProposal;
      installationId: string;
    }>
  | Readonly<{
      operation: 'confirm';
      actor: ActionActor;
      proposal: StoredQuoteProposal;
      reservation: QuoteExecutionReservation;
      receipt: DraftQuoteReceipt;
    }>;

export type QuoteLedgerPredicate = Readonly<{
  /** A scalar boolean SQL expression; never interpolated user/model content. */
  sql: string;
  bindings: readonly (string | number | null)[];
}>;

export type QuoteLedgerFence = (
  request: QuoteLedgerFenceRequest,
) => Promise<QuoteLedgerPredicate>;

export interface QuoteProposalLedger {
  findProposal: (
    actor: ActionActor,
    sourceId: string,
  ) => Promise<StoredQuoteProposal | null>;
  loadProposal: (
    actor: ActionActor,
    proposalId: string,
  ) => Promise<StoredQuoteProposal | null>;
  saveProposal: (
    actor: ActionActor,
    plan: QuotePlan,
    fingerprint: string,
    admission: ActionAdmission,
  ) => Promise<StoredQuoteProposal>;
  reserveExecution: (
    actor: ActionActor,
    proposalId: string,
    installationId: string,
  ) => Promise<QuoteReservationResult>;
  confirmExecution: (
    actor: ActionActor,
    proposalId: string,
    installationId: string,
    reservationId: string,
    receipt: DraftQuoteReceipt,
  ) => Promise<DraftQuoteReceipt>;
}

export type QuoteLedgerErrorCode =
  | 'forbidden'
  | 'conflict'
  | 'invalid_record'
  | 'service_unavailable';

export class QuoteLedgerError extends Error {
  constructor(readonly code: QuoteLedgerErrorCode) {
    super(code);
  }
}
