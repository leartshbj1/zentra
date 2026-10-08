import type { FinancialAuthority } from './accounting/ledger';
import type { BankStatement, Reconciliation } from './accounting/reconciliation';
import type { ErpSchemaVersion } from './erp-schema-capability';

/** Separate US bank-review store; never a replacement or promotion of an ERP book. */
export interface UsBankRecord {
  readonly schemaVersion: 1;
  readonly reconciliation: Reconciliation;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly voided?: Readonly<{ by: string; at: string; reason: string }>;
}
export type UsBankCommand =
  | Readonly<{ type: 'create_statement'; statement: BankStatement }>
  | Readonly<{ type: 'approve_match'; id: string; statementLineIds: readonly string[]; ledgerEntryIds: readonly string[] }>
  | Readonly<{ type: 'complete' }>
  | Readonly<{ type: 'void_statement'; reason: string }>;
export interface UsBankRequest {
  readonly schemaVersion: 1;
  readonly idempotencyKey: string;
  readonly reconciliationId: string;
  readonly expectedErpRevision: number;
  readonly expectedReconciliationRevision: number | null;
  readonly command: UsBankCommand;
}
export interface UsBankReceipt {
  readonly schemaVersion: 1;
  readonly organizationId: string;
  readonly idempotencyKey: string;
  readonly commandHash: string;
  readonly actorId: string;
  readonly reconciliationId: string;
  readonly action: UsBankCommand['type'];
  readonly revision: number;
  readonly erpRevision: number;
}
export interface UsBankCommit {
  readonly actor: FinancialAuthority;
  readonly expectedErpRevision: number;
  readonly expectedReconciliationRevision: number | null;
  readonly record: UsBankRecord;
  readonly receipt: UsBankReceipt;
}
export interface UsBankStore {
  /** Server factory ceiling, captured once; cannot be upgraded by request JSON. */
  readonly supportedSchemaVersion: ErpSchemaVersion;
  list(actor: FinancialAuthority): Promise<readonly UsBankRecord[]>;
  read(actor: FinancialAuthority, reconciliationId: string): Promise<UsBankRecord | null>;
  receipt(actor: FinancialAuthority, idempotencyKey: string): Promise<UsBankReceipt | null>;
  /** Atomic CAS + ERP-head fence + overlap/global match checks + immutable audit/receipt. */
  commit(input: UsBankCommit): Promise<UsBankReceipt>;
}
export interface UsBankReadResponse {
  readonly schemaVersion: 1;
  readonly organizationId: string;
  readonly erpRevision: number;
  readonly ledgerRevision: number;
  readonly records: readonly UsBankRecord[];
}
export interface UsBankWriteResponse {
  readonly receipt: UsBankReceipt;
  readonly replayed: boolean;
}
