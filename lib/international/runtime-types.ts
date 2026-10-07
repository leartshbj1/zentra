import type { CompanyConfiguration } from './types';
import type { Contact, Estimate, IssuedInvoice, SalesLine } from './invoicing';
import type { AccountingPeriod, FinancialAuthority, Ledger, LedgerAuditEvent } from './accounting/ledger';

/** One financial authority per workspace. The CH historical SQLite book is not imported here. */
export interface ErpState {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly configuration: CompanyConfiguration;
  readonly counters: Readonly<{ estimate: number; invoice: number }>;
  readonly ledger: Ledger;
  readonly customers: readonly Contact[];
  readonly estimates: readonly Estimate[];
  readonly invoices: readonly IssuedInvoice[];
}
export type ErpHeader = Omit<ErpState, 'customers' | 'estimates' | 'invoices' | 'ledger'> & {
  readonly ledger: Omit<Ledger, 'entries' | 'audit'>;
};
export type ErpRecordKind = 'customer' | 'estimate' | 'invoice' | 'journal';
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
  | Readonly<{ type: 'close_period'; periodId: string }>;
export interface ErpRequest {
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
  readonly command: ErpCommand;
}
