import type { PrepaidContractInput, PrepaidPeriod } from './prepaid-periods';

/** Field contract: official pfpayments/typescript-sdk at
 * bb1e4c34ffa44bc1da8f54c86f984961aa886c30, models Transaction,
 * TransactionInvoice, Refund, Environment and ChargeAttemptEnvironment.
 * https://checkout.postfinance.ch/en-us/doc/payment/transaction-process
 * https://checkout.postfinance.ch/en-us/doc/payment/refund
 * Invoice has no currency or paidAmount: transaction.currency and its actual
 * totalSettledAmount establish currency and settlement independently of PAID.
 */
export type ExpectedPrepaidSettlement = Readonly<
  PrepaidContractInput & {
    period: PrepaidPeriod;
    transactionId: number;
    customerReference: string;
    planReference: string;
    paymentMethodConfigurationId: number;
    connectorConfigurationId: number;
    /** Server configuration only, after real connector settlement simulation.
     * Never infer this from a browser, a webhook or FULFILL alone. */
    settlementEvidenceVerified: boolean;
  }
>;

/** These local completeness assertions belong to the authenticated caller.
 * It must exhaust correctly scoped searches and re-read every returned ID.
 * They are not fictitious fields on PostFinance's JSON models.
 */
export type PrepaidSettlementEvidence = Readonly<{
  apiOrigin: string;
  spaceId: number;
  environment: 'TEST' | 'PRODUCTION';
  transaction: unknown;
  invoices: readonly unknown[];
  invoiceSearchComplete: boolean;
  refunds: readonly unknown[];
  refundSearchComplete: boolean;
}>;

export type PrepaidSettlementProof = Readonly<{
  periodId: string;
  contractId: string;
  transactionId: number;
  invoiceId: number;
  apiOrigin: string;
  spaceId: number;
  environment: 'PRODUCTION';
  ownerId: string;
  organizationId: string | null;
  workspaceId: string | null;
  startsAt: number;
  endsAt: number;
  currency: 'CHF';
  priceChfMinor: number;
  catalogVersion: string;
  evidenceFingerprint: string;
}>;
export type PrepaidRevocationProof = Readonly<
  Omit<PrepaidSettlementProof, 'invoiceId'> & {
    invoiceId: number | null;
  }
>;
export type PrepaidSettlementReason =
  | 'invalid_binding'
  | 'read_scope'
  | 'transaction_scope'
  | 'transaction_binding'
  | 'transaction_environment'
  | 'transaction_pending'
  | 'transaction_state'
  | 'transaction_amount'
  | 'transaction_items'
  | 'connector_scope'
  | 'connector_settlement_unverified'
  | 'settlement_incomplete'
  | 'invoice_search_incomplete'
  | 'invoice_missing'
  | 'invoice_ambiguous'
  | 'invoice_scope'
  | 'invoice_environment'
  | 'invoice_state'
  | 'invoice_amount'
  | 'invoice_items'
  | 'refund_search_incomplete'
  | 'refund_ambiguous'
  | 'refund_scope'
  | 'refund_environment'
  | 'refund_unknown'
  | 'refund_pending'
  | 'refunded'
  | 'transaction_reversed';
export type PrepaidSettlementResult =
  | Readonly<{ state: 'paid'; proof: PrepaidSettlementProof }>
  | Readonly<{
      state: 'revoked';
      reason: 'refunded' | 'transaction_reversed';
      proof: PrepaidRevocationProof;
    }>
  | Readonly<{ state: 'pending' | 'manual'; reason: PrepaidSettlementReason }>;

type Json = Record<string, unknown>;
function object(value: unknown): Json | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : null;
}
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function identity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 180 &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}
/** API JSON monetary numbers are CHF units. Parse their decimal representation
 * into cents, never round sub-cent amounts or accept numeric strings. */
function minor(value: unknown): number | null {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    Object.is(value, -0)
  )
    return null;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) return null;
  const result =
    Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(result) ? result : null;
}
function stop(
  state: 'pending' | 'manual',
  reason: PrepaidSettlementReason,
): PrepaidSettlementResult {
  return Object.freeze({ state, reason });
}
function expectedValid(expected: ExpectedPrepaidSettlement): boolean {
  if (!object(expected) || !object(expected.period)) return false;
  const p = expected.period;
  return (
    ['https://checkout.postfinance.ch', 'https://app-wallee.com'].includes(
      expected.apiOrigin,
    ) &&
    expected.environment === 'PRODUCTION' &&
    positive(expected.spaceId) &&
    positive(expected.transactionId) &&
    positive(expected.paymentMethodConfigurationId) &&
    positive(expected.connectorConfigurationId) &&
    typeof expected.contractId === 'string' &&
    /^pfp_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      expected.contractId,
    ) &&
    identity(expected.ownerId) &&
    (expected.organizationId === null || identity(expected.organizationId)) &&
    (expected.workspaceId === null || identity(expected.workspaceId)) &&
    typeof expected.productKey === 'string' &&
    (expected.productKey.startsWith('support:')
      ? expected.workspaceId !== null
      : expected.organizationId !== null) &&
    typeof expected.customerReference === 'string' &&
    /^[A-Za-z0-9_-]{1,120}$/.test(expected.customerReference) &&
    typeof expected.planReference === 'string' &&
    /^[A-Za-z0-9_-]{1,120}$/.test(expected.planReference) &&
    !!p &&
    p.contractId === expected.contractId &&
    typeof p.periodId === 'string' &&
    /^[A-Za-z0-9_-]{1,120}$/.test(p.periodId) &&
    Number.isSafeInteger(p.ordinal) &&
    p.ordinal >= 0 &&
    positive(p.startsAt) &&
    positive(p.endsAt) &&
    p.endsAt > p.startsAt &&
    p.currency === 'CHF' &&
    positive(p.priceChfMinor) &&
    identity(p.catalogVersion) &&
    p.catalog?.productKey === expected.productKey &&
    p.catalog?.currency === 'CHF' &&
    p.catalog?.billingPeriod === 'P1M' &&
    p.catalog?.catalogVersion === p.catalogVersion &&
    p.catalog?.priceChfMinor === p.priceChfMinor
  );
}
function itemsMatch(
  items: unknown,
  expected: ExpectedPrepaidSettlement,
): boolean {
  if (!Array.isArray(items) || items.length !== 1) return false;
  const line = object(items[0]);
  return (
    !!line &&
    line.type === 'PRODUCT' &&
    line.quantity === 1 &&
    line.uniqueId === expected.period.periodId &&
    line.sku === expected.planReference &&
    minor(line.amountIncludingTax) === expected.period.priceChfMinor
  );
}
function proofBinding(expected: ExpectedPrepaidSettlement) {
  return {
    periodId: expected.period.periodId,
    contractId: expected.contractId,
    transactionId: expected.transactionId,
    apiOrigin: expected.apiOrigin,
    spaceId: expected.spaceId,
    environment: 'PRODUCTION' as const,
    ownerId: expected.ownerId,
    organizationId: expected.organizationId,
    workspaceId: expected.workspaceId,
    startsAt: expected.period.startsAt,
    endsAt: expected.period.endsAt,
    currency: 'CHF' as const,
    priceChfMinor: expected.period.priceChfMinor,
    catalogVersion: expected.period.catalogVersion,
  };
}
async function fingerprint(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
async function reversed(
  expected: ExpectedPrepaidSettlement,
  reason: 'refunded' | 'transaction_reversed',
  evidence: readonly unknown[],
  invoiceId: number | null = null,
): Promise<PrepaidSettlementResult> {
  const binding = proofBinding(expected);
  const proof = Object.freeze({
    ...binding,
    invoiceId,
    evidenceFingerprint: await fingerprint([
      'zentra-prepaid-settlement-v1',
      'revoked',
      binding,
      reason,
      evidence,
    ]),
  });
  return Object.freeze({ state: 'revoked', reason, proof });
}

/** Pure verification of already re-read JSON; no HTTP, DB, cache or entitlement.
 * Local expected bindings and read provenance MUST originate from the worker,
 * not a customer return URL or webhook payload. Ownership itself is checked by
 * the caller against D1; provider customerId stores an opaque local reference.
 * A SHA-256 fingerprint is an audit digest, not a merchant signature.
 */
export async function verifyPrepaidSettlement(
  expected: ExpectedPrepaidSettlement,
  evidence: PrepaidSettlementEvidence,
): Promise<PrepaidSettlementResult> {
  if (!expectedValid(expected)) return stop('manual', 'invalid_binding');
  if (
    evidence.apiOrigin !== expected.apiOrigin ||
    evidence.spaceId !== expected.spaceId ||
    evidence.environment !== 'PRODUCTION'
  )
    return stop('manual', 'read_scope');
  const transaction = object(evidence.transaction);
  if (
    !transaction ||
    transaction.id !== expected.transactionId ||
    transaction.linkedSpaceId !== expected.spaceId
  )
    return stop('manual', 'transaction_scope');
  if (
    transaction.customerId !== expected.customerReference ||
    transaction.merchantReference !== expected.period.periodId ||
    transaction.invoiceMerchantReference !== expected.period.periodId ||
    object(transaction.metaData)?.zentra_period_id !==
      expected.period.periodId ||
    object(transaction.metaData)?.zentra_plan_version !== expected.planReference
  )
    return stop('manual', 'transaction_binding');
  if (
    transaction.environment !== 'LIVE' ||
    transaction.authorizationEnvironment !== 'PRODUCTION'
  )
    return stop('manual', 'transaction_environment');
  if (transaction.currency !== 'CHF')
    return stop('manual', 'transaction_amount');
  if (transaction.state === 'VOIDED' || transaction.state === 'DECLINE')
    return reversed(expected, 'transaction_reversed', [transaction.state]);
  const refunded = minor(transaction.refundedAmount);
  if (refunded !== null && refunded > 0)
    return reversed(expected, 'refunded', [
      'transaction.refundedAmount',
      refunded,
    ]);
  if (!Array.isArray(evidence.refunds)) return stop('manual', 'refund_unknown');
  const refundIds = new Set<number>();
  let pendingRefund = false;
  for (const value of evidence.refunds) {
    const refund = object(value),
      linked = object(refund?.transaction);
    if (
      !refund ||
      !positive(refund.id) ||
      refund.linkedSpaceId !== expected.spaceId ||
      linked?.id !== expected.transactionId ||
      linked.linkedSpaceId !== expected.spaceId
    )
      return stop('manual', 'refund_scope');
    if (refundIds.has(refund.id)) return stop('manual', 'refund_ambiguous');
    refundIds.add(refund.id);
    if (refund.environment !== 'LIVE')
      return stop('manual', 'refund_environment');
    if (
      ![
        'MERCHANT_INITIATED_ONLINE',
        'MERCHANT_INITIATED_OFFLINE',
        'CUSTOMER_INITIATED_AUTOMATIC',
        'CUSTOMER_INITIATED_MANUAL',
      ].includes(String(refund.type))
    )
      return stop('manual', 'refund_unknown');
    const amount = minor(refund.amount),
      settled = minor(refund.totalSettledAmount);
    if (refund.state === 'SUCCESSFUL' && amount !== null && amount > 0)
      return reversed(expected, 'refunded', [
        'refund',
        refund.id,
        refund.type,
        amount,
        settled,
      ]);
    if (
      ['CREATE', 'SCHEDULED', 'PENDING', 'MANUAL_CHECK'].includes(
        String(refund.state),
      )
    ) {
      pendingRefund = true;
    } else if (
      refund.state !== 'FAILED' ||
      amount === null ||
      settled !== 0 ||
      refund.succeededOn != null
    ) {
      return stop('manual', 'refund_unknown');
    }
  }
  if (pendingRefund) return stop('pending', 'refund_pending');
  if (evidence.refundSearchComplete !== true)
    return stop('pending', 'refund_search_incomplete');
  if (refunded !== 0) return stop('manual', 'refund_unknown');
  if (
    [
      'CREATE',
      'PENDING',
      'CONFIRMED',
      'PROCESSING',
      'AUTHORIZED',
      'COMPLETED',
    ].includes(String(transaction.state))
  )
    return stop('pending', 'transaction_pending');
  if (transaction.state !== 'FULFILL')
    return stop('manual', 'transaction_state');
  if (
    minor(transaction.authorizationAmount) !== expected.period.priceChfMinor ||
    minor(transaction.completedAmount) !== expected.period.priceChfMinor
  )
    return stop('manual', 'transaction_amount');
  if (!itemsMatch(transaction.lineItems, expected))
    return stop('manual', 'transaction_items');
  const connector = object(transaction.paymentConnectorConfiguration);
  if (
    connector?.id !== expected.connectorConfigurationId ||
    connector.linkedSpaceId !== expected.spaceId ||
    object(connector.paymentMethodConfiguration)?.id !==
      expected.paymentMethodConfigurationId
  )
    return stop('manual', 'connector_scope');
  if (evidence.invoiceSearchComplete !== true)
    return stop('pending', 'invoice_search_incomplete');
  if (!Array.isArray(evidence.invoices))
    return stop('manual', 'invoice_ambiguous');
  if (evidence.invoices.length === 0) return stop('pending', 'invoice_missing');
  if (evidence.invoices.length !== 1)
    return stop('manual', 'invoice_ambiguous');
  const invoice = object(evidence.invoices[0]);
  if (
    !invoice ||
    !positive(invoice.id) ||
    invoice.linkedSpaceId !== expected.spaceId ||
    invoice.linkedTransaction !== expected.transactionId ||
    invoice.merchantReference !== expected.period.periodId
  )
    return stop('manual', 'invoice_scope');
  if (invoice.environment !== 'LIVE')
    return stop('manual', 'invoice_environment');
  if (['CREATE', 'OPEN', 'OVERDUE'].includes(String(invoice.state)))
    return stop('pending', 'invoice_state');
  if (
    invoice.state !== 'PAID' ||
    invoice.derecognizedOn != null ||
    invoice.derecognizedBy != null
  )
    return stop('manual', 'invoice_state');
  if (
    minor(invoice.amount) !== expected.period.priceChfMinor ||
    minor(invoice.outstandingAmount) !== 0
  )
    return stop('manual', 'invoice_amount');
  if (!itemsMatch(invoice.lineItems, expected))
    return stop('manual', 'invoice_items');
  const settled = minor(transaction.totalSettledAmount);
  if (settled === null || settled < expected.period.priceChfMinor)
    return stop('pending', 'settlement_incomplete');
  if (settled !== expected.period.priceChfMinor)
    return stop('manual', 'transaction_amount');
  if (expected.settlementEvidenceVerified !== true)
    return stop('manual', 'connector_settlement_unverified');
  const binding = proofBinding(expected);
  const proof = Object.freeze({
    ...binding,
    invoiceId: invoice.id,
    evidenceFingerprint: await fingerprint([
      'zentra-prepaid-settlement-v1',
      'paid',
      binding,
      invoice.id,
      expected.customerReference,
      expected.planReference,
      expected.connectorConfigurationId,
      expected.paymentMethodConfigurationId,
      settled,
    ]),
  });
  return Object.freeze({ state: 'paid', proof });
}
