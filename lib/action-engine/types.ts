import type { DecisionInput, ProviderResult } from '@/lib/automation/types';

/** All context is loaded by an authenticated repository, never accepted from an email/model. */
export type ActionActor = Readonly<{ organizationId: string; userId: string }>;
export type ActionSource = Readonly<{
  id: string;
  revision: string;
  organizationId: string;
  senderEmail: string;
  senderName: string;
  subject: string;
  body: string;
}>;
export type ActionCustomer = Readonly<{
  id: string;
  revision: string;
  organizationId: string;
  name: string;
  email: string;
  archived: boolean;
}>;
export type ActionArticle = Readonly<{
  id: string;
  revision: string;
  organizationId: string;
  name: string;
  description: string;
  sku: string;
  unit: string;
  currency: string;
  unitPriceCents: number;
  taxRateBp: number;
  archived: boolean;
}>;
export type QuotePlanningContext = Readonly<{
  organizationId: string;
  revision: string;
  currency: string;
  source: ActionSource;
  customers: readonly ActionCustomer[];
  articles: readonly ActionArticle[];
}>;
export type ReviewReason =
  | 'missing_customer_name'
  | 'ambiguous_customer'
  | 'archived_customer'
  | 'missing_quantity'
  | 'ambiguous_quantity'
  | 'unsupported_quantity'
  | 'missing_article'
  | 'too_many_candidates'
  | 'source_too_long'
  | 'low_confidence'
  | 'not_quote_request'
  | 'invalid_decision'
  | 'provider_unavailable';
export type PlannedCustomer =
  | Readonly<{ kind: 'existing'; id: string; revision: string; name: string }>
  | Readonly<{ kind: 'new'; name: string; email: string }>;
export type PlannedQuoteLine = Readonly<{
  articleId: string;
  articleRevision: string;
  description: string;
  unit: string;
  quantityMilli: number;
  unitPriceCents: number;
  taxRateBp: number;
  netCents: number;
  /** Exact literal from the source, never text invented by the model. */
  evidence: string;
}>;
export type QuotePlan = Readonly<{
  schemaVersion: 1;
  engineVersion: 'action-engine-quote-v1';
  kind: 'prepare_quote_draft';
  organizationId: string;
  contextRevision: string;
  sourceId: string;
  sourceRevision: string;
  status: 'ready' | 'needs_review';
  reasons: readonly ReviewReason[];
  customer: PlannedCustomer | null;
  title: string;
  currency: string;
  lines: readonly PlannedQuoteLine[];
  netCents: number;
  confidence: number | null;
  requiresHumanValidation: true;
}>;
export type ActionAdmission = Readonly<{
  organizationId: string;
  userId: string;
  /** Opaque fresh server authorization revision; the commit adapter must recheck it. */
  revision: string;
  automationActive: boolean;
  /** Server grants draft creation AND conditional customer creation, not just catalogue reading. */
  mayPrepareQuote: boolean;
}>;
export type StoredQuoteProposal = Readonly<{
  id: string;
  organizationId: string;
  fingerprint: string;
  plan: QuotePlan;
}>;
export interface QuotePreparationPorts {
  authorize: (actor: ActionActor) => Promise<ActionAdmission>;
  loadContext: (
    actor: ActionActor,
    sourceId: string,
  ) => Promise<QuotePlanningContext>;
  findProposal: (
    actor: ActionActor,
    sourceId: string,
  ) => Promise<StoredQuoteProposal | null>;
  /**
   * Persist uniquely by tenant + source + kind. Same key/different fingerprint
   * MUST conflict. Recheck live admission and context/source revisions in the
   * persistence transaction; preflight checks alone do not authorize a write.
   */
  saveProposal: (
    actor: ActionActor,
    plan: QuotePlan,
    fingerprint: string,
    admission: ActionAdmission,
  ) => Promise<StoredQuoteProposal>;
  provider: Readonly<{
    decide: (input: DecisionInput) => Promise<ProviderResult>;
  }>;
}
export type DraftQuoteReceipt = Readonly<{
  organizationId: string;
  proposalId: string;
  fingerprint: string;
  customerId: string;
  quoteId: string;
  quoteNumber: string;
  status: 'draft';
  requiresHumanValidation: true;
}>;
export interface QuoteExecutionPorts {
  authorize: (actor: ActionActor) => Promise<ActionAdmission>;
  /** Tenant-scoped persisted plan. Never use a plan posted by the browser/model. */
  loadProposal: (
    actor: ActionActor,
    proposalId: string,
  ) => Promise<StoredQuoteProposal | null>;
  /** Tenant-scoped historical receipt. Recover before stale-resource checks, after fresh admission. */
  findReceipt: (
    actor: ActionActor,
    proposalId: string,
    fingerprint: string,
  ) => Promise<DraftQuoteReceipt | null>;
  loadContext: (
    actor: ActionActor,
    sourceId: string,
  ) => Promise<QuotePlanningContext>;
  /**
   * Implement as ONE transaction. Recheck live admission, context/source/resource
   * revisions, unique central reservation (tenant + source + kind, not just a
   * new proposal UUID) and fingerprint, then client + draft
   * + lines + receipt + audit + sync outbox. A duplicate returns the original
   * receipt; a changed payload refuses. No issue/send/post/payment capability.
   * A local receipt alone is insufficient for distributed execution.
   */
  commitDraft: (
    actor: ActionActor,
    proposal: StoredQuoteProposal,
    admission: ActionAdmission,
  ) => Promise<DraftQuoteReceipt>;
}
export type ActionErrorCode =
  | 'invalid_context'
  | 'forbidden'
  | 'stale_plan'
  | 'invalid_proposal'
  | 'review_required'
  | 'invalid_receipt';
export class ActionEngineError extends Error {
  constructor(readonly code: ActionErrorCode) {
    super(code);
  }
}
