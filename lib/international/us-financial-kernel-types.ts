import type { FinancialAuthority, Ledger, PostedJournal } from './accounting/ledger';
import type { CustomerPayment, IssuedInvoice } from './invoicing';
import type { ErpState } from './runtime-types';
import type { UsCustomerCreditAllocation, UsCustomerCreditSelection, UsCustomerCreditSource } from './us-customer-credit-types';

/** Internal memory-only financial capability. Never advertise it as the
 * existing ErpSchemaVersion or pass it to the published ErpStore. */
export interface UsFinancialPolicyV5 {
  readonly version: 'us-accrual-receivable-credit-v1';
  readonly environment: 'test';
  readonly approval: Readonly<{ reference: string; reviewedBy: string; reviewedAt: string }>;
}
interface UsFinancialTaxProofBaseV5 {
  readonly schemaVersion: 1;
  readonly environment: 'test';
  readonly invoiceFingerprint: string;
  readonly allocationSha256: string;
  readonly reference: string;
  readonly verifiedBy: string;
  readonly verifiedAt: string;
}
/** Trusted internal authorization for a plan, never proof that a provider
 * reversal has happened and never accepted in a public request DTO. */
export type UsFinancialTaxProofV5 =
  | (UsFinancialTaxProofBaseV5 & Readonly<{ kind: 'historical_zero_tax' }>)
  | (UsFinancialTaxProofBaseV5 & Readonly<{
    kind: 'test_adjustment_authorization';
    providerAccountReference: string;
    originalTaxTransactionReference: string;
    adjustmentPlanReference: string;
    authorizedTaxMinor: string;
  }>);
export interface UsFinancialCreditInputV5 {
  readonly type: 'customer_credit';
  readonly idempotencyKey: string;
  readonly invoiceId: string;
  readonly transactionDate: string;
  readonly accountingDate: string;
  readonly periodId: string;
  readonly reason: string;
  readonly selections: readonly UsCustomerCreditSelection[];
}
export interface UsFinancialPaymentInputV5 {
  readonly type: 'customer_payment';
  readonly idempotencyKey: string;
  readonly invoiceId: string;
  readonly amountMinor: string;
  readonly paymentDate: string;
  readonly accountingDate: string;
  readonly periodId: string;
  readonly reference: string;
}
export type UsFinancialOperationV5 =
  | (UsFinancialCreditInputV5 & Readonly<{ taxProof: UsFinancialTaxProofV5 }>)
  | UsFinancialPaymentInputV5;
export interface UsFinancialCreditCandidateV5 {
  readonly source: UsCustomerCreditSource;
  readonly invoiceFingerprint: string;
  readonly allocationSha256: string;
  readonly allocation: UsCustomerCreditAllocation;
}
export interface UsFinancialCreditRecordV5 {
  readonly id: string;
  readonly organizationId: string;
  readonly number: string;
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly invoiceFingerprint: string;
  readonly customerId: string;
  readonly currency: 'USD';
  readonly transactionDate: string;
  readonly accountingDate: string;
  readonly periodId: string;
  readonly reason: string;
  readonly allocation: UsCustomerCreditAllocation;
  readonly taxDisposition: 'historical_zero_tax' | 'adjustment_pending';
  readonly issuedBy: string;
  readonly issuedAt: string;
  readonly recordedRevision: number;
}
export interface UsFinancialEventV5 {
  readonly revision: number;
  readonly id: string;
  readonly operation: UsFinancialOperationV5;
  readonly actor: FinancialAuthority;
  readonly record: UsFinancialCreditRecordV5 | CustomerPayment;
  readonly posting: PostedJournal;
}
/** The validated baseline and ordered events are the only authoritative
 * financial state. There is no stored second copy of the current ledger. */
export interface UsFinancialBookV5 {
  readonly schemaVersion: 5;
  readonly revision: number;
  readonly baseline: ErpState;
  readonly policy: UsFinancialPolicyV5;
  readonly promotion: Readonly<{ actor: FinancialAuthority; baselineSha256: string }>;
  readonly events: readonly UsFinancialEventV5[];
}
export interface UsFinancialInvoiceSettlementV5 {
  readonly invoiceId: string;
  readonly currency: 'USD';
  readonly totalMinor: string;
  readonly receivedMinor: string;
  readonly creditedMinor: string;
  readonly outstandingMinor: string;
  readonly status: 'open' | 'partially_settled' | 'paid' | 'credited' | 'settled_with_credit';
}
/** Private derived projection. Invoice/ledger fields retain historical facts;
 * a future public projection must whitelist its own fields. */
export interface UsFinancialBookViewV5 {
  readonly schemaVersion: 5;
  readonly revision: number;
  readonly organizationId: string;
  readonly policyVersion: UsFinancialPolicyV5['version'];
  readonly ledger: Ledger;
  readonly invoices: readonly IssuedInvoice[];
  readonly credits: readonly UsFinancialCreditRecordV5[];
  readonly settlements: readonly UsFinancialInvoiceSettlementV5[];
}
