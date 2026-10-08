import type { FinancialAuthority } from './accounting/ledger';
import type { ErpSchemaVersion } from './erp-schema-capability';
import type { UsSupplierProposal, UsSupplierSource } from './us-supplier-contract';

/** Private server evidence only, never a client grant or Stripe payment claim. */
export interface UsAutomationGrant {
  readonly schemaVersion: 1;
  readonly organizationId: string;
  readonly environment: 'TEST' | 'PRODUCTION';
  readonly bucket: 'supplier_invoice_extract';
  readonly periodId: string;
  readonly periodStart: number;
  readonly periodEnd: number;
  readonly limit: number;
  readonly subscriptionId: string;
  readonly authorityReference: string;
  readonly catalogVersion: string;
  readonly priceId: string;
  readonly budgetPolicyVersion: string;
  readonly processingPolicyVersion: string;
  readonly checkedAt: number;
}
export interface UsAutomationSettings {
  readonly schemaVersion: 1;
  readonly organizationId: string;
  readonly revision: number;
  readonly enabled: boolean;
  readonly consent: null | Readonly<{ processingPolicyVersion: string; acceptedBy: string; acceptedAt: string }>;
}
export type UsAutomationSettingsRequest = Readonly<{ schemaVersion: 1; requestId: string; expectedRevision: number }> & (
  Readonly<{ action: 'activate'; processingPolicyVersion: string; consent: true }> | Readonly<{ action: 'pause'; processingPolicyVersion: string | null; consent: false }>
);
export interface UsAutomationJob {
  readonly schemaVersion: 1;
  readonly organizationId: string;
  readonly id: string;
  readonly environment: 'TEST' | 'PRODUCTION';
  readonly bucket: 'supplier_invoice_extract';
  readonly source: UsSupplierSource;
  readonly recipeVersion: string;
  readonly requestId: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly grant: UsAutomationGrant;
  readonly consentRevision: number;
  readonly state: 'held' | 'released' | 'dispatched' | 'uncertain' | 'completed';
  /** Private worker fence; never returned by a browser/native public DTO. */
  readonly leaseToken: string | null;
  readonly leaseUntil: string | null;
  readonly leaseGeneration: number;
  readonly dispatchId: string | null;
  readonly dispatchedAt: string | null;
  readonly resultBody: string | null;
  readonly resultSha256: string | null;
  readonly proposalId: string | null;
}
export interface UsAutomationUsage {
  readonly schemaVersion: 1;
  readonly organizationId: string;
  readonly environment: 'TEST' | 'PRODUCTION';
  readonly bucket: 'supplier_invoice_extract';
  readonly periodId: string;
  readonly limit: number;
  readonly held: number;
  readonly consumed: number;
  readonly remaining: number;
}
export interface UsAutomationClaim {
  readonly actor: FinancialAuthority;
  readonly grant: UsAutomationGrant;
  readonly source: UsSupplierSource;
  readonly recipeVersion: string;
  readonly requestId: string;
  readonly leaseToken: string;
}
export interface UsAutomationCompletion {
  readonly actor: FinancialAuthority;
  readonly grant: UsAutomationGrant;
  readonly jobId: string;
  readonly dispatchId: string;
  /** Exact canonicalErpJson(validateUsSupplierExtraction(...)), hashed UTF8.
   * PostgreSQL preserves bytes; it must not reserialize floating probabilities. */
  readonly resultBody: string;
  readonly resultSha256: string;
}
/** Fresh Auth/D1 subscriptions must be checked before/after these private RPCs.
 * The database validates scope/cap4, not distributed D1 revocation atomically. */
export interface UsAutomationStore {
  readonly supportedSchemaVersion: ErpSchemaVersion;
  readSettings(actor: FinancialAuthority): Promise<UsAutomationSettings>;
  saveSettings(actor: FinancialAuthority, request: UsAutomationSettingsRequest): Promise<Readonly<{ settings: UsAutomationSettings; replayed: boolean }>>;
  claim(input: UsAutomationClaim): Promise<Readonly<{ job: UsAutomationJob; claimed: boolean }>>;
  dispatch(input: Readonly<{ actor: FinancialAuthority; grant: UsAutomationGrant; jobId: string; leaseToken: string }>): Promise<Readonly<{ job: UsAutomationJob; mayDispatch: boolean }>>;
  complete(input: UsAutomationCompletion): Promise<Readonly<{ job: UsAutomationJob; proposal: UsSupplierProposal }>>;
  markUncertain(actor: FinancialAuthority, jobId: string, dispatchId: string): Promise<UsAutomationJob>;
  read(actor: FinancialAuthority, jobId: string): Promise<UsAutomationJob | null>;
  findSource(actor: FinancialAuthority, grant: UsAutomationGrant, sourceSha256: string): Promise<UsAutomationJob | null>;
  usage(actor: FinancialAuthority, grant: UsAutomationGrant): Promise<UsAutomationUsage>;
  expireHeld(actor: FinancialAuthority, grant: UsAutomationGrant): Promise<number>;
}
