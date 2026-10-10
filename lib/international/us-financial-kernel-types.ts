import type { FinancialAuthority, Ledger, LedgerAuditEvent, PostedJournal } from './accounting/ledger';
import type { CustomerPayment, IssuedInvoice, PublicSellerSnapshot, TaxAssessment } from './invoicing';
import type { ErpCommand, ErpCommit, ErpState } from './runtime-types';
import type { UsCustomerCreditAllocation, UsCustomerCreditSelection, UsCustomerCreditSource } from './us-customer-credit-types';

/** Internal TEST financial policy, shared by memory and the limited private
 * PostgreSQL adapter. Never pass it to the published ErpStore or advertise ERP5. */
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
export type UsFinancialErpCommandV5 = Exclude<ErpCommand, Readonly<{type:'initialize'|'upgrade_accounting'|'refresh_configuration'|'record_payment'}>>;
/** Private facts resolved by the trusted runtime. They are never client input. */
export type UsFinancialErpFactsV5 = Readonly<{kind:'none'}> | Readonly<{
  kind:'invoice_issuance'; sellerSnapshot:PublicSellerSnapshot; taxAssessment:TaxAssessment;
}>;
export interface UsFinancialErpOperationV5 {
  readonly type:'erp_command';
  readonly idempotencyKey:string;
  readonly command:UsFinancialErpCommandV5;
  readonly facts:UsFinancialErpFactsV5;
}
export type UsFinancialOperationV5 =
  | (UsFinancialCreditInputV5 & Readonly<{ taxProof: UsFinancialTaxProofV5 }>)
  | UsFinancialPaymentInputV5
  | UsFinancialErpOperationV5;
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
export interface UsFinancialPostingEventV5 {
  readonly revision: number;
  readonly id: string;
  readonly operation: Exclude<UsFinancialOperationV5,UsFinancialErpOperationV5>;
  readonly actor: FinancialAuthority;
  readonly record: UsFinancialCreditRecordV5 | CustomerPayment;
  readonly posting: PostedJournal;
}
export interface UsFinancialErpEventV5 {
  readonly revision:number;
  readonly id:string;
  readonly operation:UsFinancialErpOperationV5;
  readonly actor:FinancialAuthority;
  /** Exact reconstructed ERP4 command result in the private compatibility projection. */
  readonly commit:ErpCommit;
  /** Actual effects on the sole V5 ledger, with its uncompressed revisions. */
  readonly effects:Readonly<{postings:readonly PostedJournal[];audit:readonly LedgerAuditEvent[]}>;
}
export type UsFinancialEventV5=UsFinancialPostingEventV5|UsFinancialErpEventV5;
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
  readonly configuration:ErpState['configuration'];
  readonly counters:ErpState['counters'];
  readonly customers:ErpState['customers'];
  readonly estimates:ErpState['estimates'];
  readonly vendors:NonNullable<ErpState['vendors']>;
  readonly vendorBills:NonNullable<ErpState['vendorBills']>;
  readonly vendorPayments:NonNullable<ErpState['vendorPayments']>;
  readonly projects:NonNullable<ErpState['projects']>;
  readonly ledger: Ledger;
  readonly invoices: readonly IssuedInvoice[];
  readonly credits: readonly UsFinancialCreditRecordV5[];
  readonly settlements: readonly UsFinancialInvoiceSettlementV5[];
}
