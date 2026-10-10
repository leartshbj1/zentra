/** Internal preparation contracts only. None of these objects is an issued
 * credit note, a tax reversal, a journal or a refundable customer balance. */
export interface UsCustomerCreditSourceLine {
  readonly lineId: string;
  readonly quantityUnits: string;
  readonly quantityScale: number;
  readonly netMinor: string;
  readonly taxMinor: string;
  readonly jurisdiction: string;
  readonly evidenceReference: string;
}
export interface UsCustomerCreditSource {
  readonly schemaVersion: 1;
  readonly organizationId: string;
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly customerId: string;
  readonly currency: 'USD';
  readonly invoiceFingerprint: string;
  readonly lines: readonly UsCustomerCreditSourceLine[];
}
export interface UsCustomerCreditSelection {
  readonly lineId: string;
  /** Uses the original line's quantityScale; never a floating-point quantity. */
  readonly quantityUnits: string;
}
export interface UsCustomerCreditAllocationLine extends UsCustomerCreditSelection {
  readonly netMinor: string;
  /** A historical proportional candidate, not an authorized tax adjustment. */
  readonly taxMinor: string;
  readonly totalMinor: string;
}
export interface UsCustomerCreditAllocation {
  readonly invoiceFingerprint: string;
  readonly lines: readonly UsCustomerCreditAllocationLine[];
  readonly netMinor: string;
  readonly taxMinor: string;
  readonly totalMinor: string;
}
export interface UsCustomerCreditAllocationHistory {
  readonly id: string;
  readonly allocation: UsCustomerCreditAllocation;
}
export interface UsCustomerCreditRemainingLine extends UsCustomerCreditSourceLine {
  readonly remainingQuantityUnits: string;
  readonly remainingNetMinor: string;
  readonly remainingTaxMinor: string;
}
