import type { FinancialAuthority } from './accounting/ledger';
import type { ErpCommit, ErpReceipt } from './runtime-types';
import type { ErpSchemaVersion } from './erp-schema-capability';
import type { UsSupplierExtraction } from './us-supplier-extraction';

/** A literal source and untrusted extracted proposal, never financial approval. */
export interface UsSupplierSource {
  readonly kind: 'document_import' | 'support_mail';
  readonly sha256: string;
  readonly fileName: string;
  readonly mediaType: 'text/plain' | 'application/pdf';
  readonly workspaceId: string | null;
  readonly connectionId: string | null;
  readonly messageId: string | null;
  readonly receivedAt: string;
  /** Bounded source text for review, not executable mail HTML or provider state. */
  readonly documentText: string;
}
export interface UsSupplierProposal {
  readonly schemaVersion: 1;
  readonly organizationId: string;
  readonly id: string;
  readonly revision: 0 | 1;
  readonly source: UsSupplierSource;
  readonly extraction: UsSupplierExtraction;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly state: 'review' | 'recorded';
  readonly recording?: UsSupplierRecording;
}
export interface UsSupplierReview {
  readonly vendorId: string;
  readonly reference: string;
  readonly date: string;
  readonly accountingDate: string;
  readonly dueDate: string;
  readonly periodId: string;
  readonly netMinor: string;
  readonly printedTaxMinor: string;
}
export interface UsSupplierApprovalRequest {
  readonly schemaVersion: 1;
  readonly idempotencyKey: string;
  readonly proposalId: string;
  readonly expectedProposalRevision: 0;
  readonly expectedErpRevision: number;
  readonly confirmed: true;
  readonly taxReviewed: true;
  readonly review: UsSupplierReview;
}
export interface UsSupplierRecording {
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly by: string;
  readonly at: string;
  readonly review: UsSupplierReview;
  readonly erpReceipt: ErpReceipt;
}
export interface UsSupplierReadResponse {
  readonly schemaVersion: 1;
  readonly organizationId: string;
  readonly erpRevision: number;
  readonly proposals: readonly UsSupplierProposal[];
}
export interface UsSupplierPrepareResponse { readonly proposal: UsSupplierProposal; readonly replayed: boolean }
export interface UsSupplierApproveResponse { readonly recording: UsSupplierRecording; readonly replayed: boolean }
export interface UsSupplierStore {
  readonly supportedSchemaVersion: ErpSchemaVersion;
  list(actor: FinancialAuthority): Promise<readonly UsSupplierProposal[]>;
  read(actor: FinancialAuthority, proposalId: string): Promise<UsSupplierProposal | null>;
  findSource(actor: FinancialAuthority, sha256: string): Promise<UsSupplierProposal | null>;
  /** Exact source deduplication, no changes to ERP, no inferred human approval. */
  create(actor: FinancialAuthority, proposal: UsSupplierProposal): Promise<UsSupplierProposal>;
  /** Atomically commit the existing ERP mutation, approval, proposal and audit. */
  approve(input: Readonly<{ actor: FinancialAuthority; request: UsSupplierApprovalRequest; requestHash: string; erp: ErpCommit }>): Promise<UsSupplierRecording>;
}
