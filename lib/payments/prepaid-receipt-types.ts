/** Public, owner-scoped receipt. These values describe recorded evidence; they
 * never serve as a licence, a quota, or a financial instruction. */
export type PrepaidReceiptStatus =
  | 'pending'
  | 'verification_required'
  | 'activation_pending'
  | 'active'
  | 'ended'
  | 'refunded'
  | 'not_completed'
  | 'test_confirmed';

export type PrepaidReceipt = Readonly<{
  intentId: string;
  environment: 'TEST' | 'PRODUCTION';
  name: string;
  priceChfMinor: number;
  method: 'postfinance_pay' | 'twint';
  organization: { id: string; name: string } | null;
  workspace: { id: string; name: string } | null;
  status: PrepaidReceiptStatus;
  /** The purchased first period, distinct from current renewed coverage. */
  purchasedPeriod: { from: number; until: number } | null;
  paidUntil: number | null;
  cancelAtPeriodEnd: boolean;
  canCancel: boolean;
  contractId: string | null;
  subscriptionHref: string;
  poll: boolean;
}>;

export function validPrepaidReceiptId(value: unknown): value is string {
  return typeof value === 'string' &&
    /^purchase_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

/** A browser return is only a pointer. No outcome or company query is copied. */
export function prepaidReceiptPath(value: unknown) {
  return validPrepaidReceiptId(value)
    ? `/compte/paiement?achat=${encodeURIComponent(value)}`
    : '/compte/paiement';
}
