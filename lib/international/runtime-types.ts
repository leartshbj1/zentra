import type { CompanyConfiguration } from './types';
import type { Contact, Estimate, IssuedInvoice, SalesLine } from './invoicing';
import type { AccountingPeriod, FinancialAuthority, Ledger, LedgerAuditEvent } from './accounting/ledger';
import type { BillInput, PaymentInput, RecordedVendorBill, RecordedVendorPayment } from './purchasing';

/** One financial authority per workspace. The CH historical SQLite book is not imported here. */
export interface ErpState {
  readonly schemaVersion: 1 | 2;
  readonly revision: number;
  readonly configuration: CompanyConfiguration;
  readonly counters: Readonly<{ estimate: number; invoice: number }>;
  readonly ledger: Ledger;
  readonly customers: readonly Contact[];
  readonly estimates: readonly Estimate[];
  readonly invoices: readonly IssuedInvoice[];
  /** These three fields exist together only in schema2. Legacy books and
   * archived events remain schema1 without silently adding empty fields. */
  readonly vendors?: readonly Contact[];
  readonly vendorBills?: readonly RecordedVendorBill[];
  readonly vendorPayments?: readonly RecordedVendorPayment[];
}
export type ErpHeader = Omit<ErpState, 'customers' | 'estimates' | 'invoices' | 'vendors' | 'vendorBills' | 'vendorPayments' | 'ledger'> & {
  readonly ledger: Omit<Ledger, 'entries' | 'audit'>;
};
export type ErpRecordKind = 'customer' | 'estimate' | 'invoice' | 'journal' | 'vendor' | 'vendor_bill' | 'vendor_payment';
export type ErpRecordChange = Readonly<{ kind: ErpRecordKind; id: string; payload: unknown }>;
export interface ErpReceipt {
  readonly idempotencyKey: string;
  readonly commandHash: string;
  readonly revision: number;
  readonly entityId: string;
  readonly action: ErpCommand['type'];
}
export interface ErpCommit {
  readonly organizationId: string;
  readonly expectedRevision: number;
  readonly header: ErpHeader;
  readonly changes: readonly ErpRecordChange[];
  readonly ledgerAudit: readonly LedgerAuditEvent[];
  readonly receipt: ErpReceipt;
  readonly actor: FinancialAuthority;
}
/** commit must atomically CAS, store changed entities, append journal/audit and retain a receipt. */
export interface ErpStore {
  /** Trusted server capability; default1. This is not a browser grant. */
  readonly supportedSchemaVersion?: 1 | 2;
  read:(organizationId: string)=>Promise<ErpState | null>;
  receipt:(organizationId: string, idempotencyKey: string)=>Promise<ErpReceipt | null>;
  commit:(input: ErpCommit)=>Promise<ErpReceipt>;
}
export type ErpCommand =
  | Readonly<{ type: 'initialize'; periods: readonly AccountingPeriod[] }>
  | Readonly<{ type: 'refresh_configuration' }>
  | Readonly<{ type: 'save_customer'; customer: Contact }>
  | Readonly<{ type: 'save_estimate'; id: string; expectedEstimateRevision: number; customerId: string; projectId?: string; date: string; expiresAt: string; paymentTermsDays: number; lines: readonly SalesLine[]; notes: string }>
  | Readonly<{ type: 'accept_estimate'; estimateId: string; expectedEstimateRevision: number }>
  | Readonly<{ type: 'issue_invoice'; id: string; estimateId: string; expectedEstimateRevision: number; date: string; accountingDate: string; dueDate: string; periodId: string }>
  | Readonly<{ type: 'record_payment'; id: string; invoiceId: string; amountMinor: string; paymentDate: string; accountingDate: string; periodId: string; reference: string }>
  | Readonly<{ type: 'save_vendor'; vendor: Contact }>
  | (Readonly<{ type: 'record_vendor_bill' }> & BillInput)
  | (Readonly<{ type: 'record_vendor_payment' }> & PaymentInput)
  | Readonly<{ type: 'close_period'; periodId: string }>;
export interface ErpRequest {
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
  readonly command: ErpCommand;
}
