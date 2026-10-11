import type { ActionActor, QuotePlan } from './types';
import type { QuoteLedgerPredicate } from './ledger-types';

export type QuotePreparationInput = Readonly<{
  organizationId: string;
  sourceId: string;
  kind: 'prepare_quote_draft';
  engineVersion: 'action-engine-quote-v1';
  sourceRevision: string;
  contextRevision: string;
  contextHash: string;
}>;

/** A private worker capability, never a browser DTO or permission by itself. */
export type QuotePreparationClaim = Readonly<{
  id: string;
  input: QuotePreparationInput;
  inputHash: string;
  userId: string;
  ownerToken: string;
  leaseUntil: number;
}>;

export type QuotePreparationResult = Readonly<{
  inputHash: string;
  plan: QuotePlan;
  fingerprint: string;
}>;

export type QuotePreparationClaimResult =
  | Readonly<{ state: 'owned'; claim: QuotePreparationClaim }>
  | Readonly<{ state: 'held'; sourceId: string }>
  | Readonly<{ state: 'uncertain'; sourceId: string }>
  | Readonly<{ state: 'finished'; result: QuotePreparationResult }>;

export type QuotePreparationSnapshot = Readonly<{
  input: QuotePreparationInput;
  inputHash: string;
  state: 'preparing' | 'started' | 'finished' | 'uncertain';
  result: QuotePreparationResult | null;
}>;

/**
 * Trusted server composition must corroborate fresh session, tenant membership,
 * seat, Gestion/Automation, consent and the specific action. Progression also
 * fences the exact source + catalogue/customer-identity context. Historical
 * read is admission only; its old context is disclosed, never silently renewed.
 * SQL and identities are never accepted from an HTTP/model request.
 */
export type QuotePreparationFenceRequest =
  | Readonly<{
      operation: 'read' | 'claim';
      actor: ActionActor;
      input: QuotePreparationInput;
    }>
  | Readonly<{
      operation: 'start' | 'uncertain';
      actor: ActionActor;
      claim: QuotePreparationClaim;
    }>
  | Readonly<{
      operation: 'finish';
      actor: ActionActor;
      claim: QuotePreparationClaim;
      result: QuotePreparationResult;
    }>;

export type QuotePreparationFence = (
  request: QuotePreparationFenceRequest,
) => Promise<QuoteLedgerPredicate>;

export interface QuotePreparationIntake {
  read: (
    actor: ActionActor,
    input: QuotePreparationInput,
  ) => Promise<QuotePreparationSnapshot | null>;
  claim: (
    actor: ActionActor,
    input: QuotePreparationInput,
  ) => Promise<QuotePreparationClaimResult>;
  /** Durable one-shot marker before invoking the single-attempt provider. */
  start: (actor: ActionActor, claim: QuotePreparationClaim) => Promise<void>;
  /** Retain a closed deterministic plan before publishing it to the A1 ledger. */
  finish: (
    actor: ActionActor,
    claim: QuotePreparationClaim,
    plan: QuotePlan,
    fingerprint: string,
  ) => Promise<QuotePreparationResult>;
  uncertain: (
    actor: ActionActor,
    claim: QuotePreparationClaim,
  ) => Promise<void>;
}

export type QuotePreparationErrorCode =
  | 'held'
  | 'uncertain'
  | 'conflict'
  | 'forbidden'
  | 'invalid_record'
  | 'service_unavailable';

export class QuotePreparationError extends Error {
  constructor(readonly code: QuotePreparationErrorCode) {
    super(code);
  }
}
