import {
  PostFinanceCheckoutClient,
  CheckoutApiError,
  type CheckoutConfiguration,
  type JsonObject,
} from './postfinance-client';
import {
  D1PostFinanceWebhookInbox,
  type WebhookListener,
  type WebhookFailure,
  type WebhookWork,
} from './postfinance-store';
import { D1PrepaidReconciliationStore } from './prepaid-reconciliation-store';
import {
  verifyPrepaidSettlement,
  type PrepaidSettlementReason,
} from './prepaid-settlement';
import { PrepaidPeriodError } from './prepaid-periods';
import {
  D1PrepaidProvisioning,
  PrepaidProvisioningError,
} from './prepaid-provisioning';
import { D1PrepaidTokens, PrepaidTokenError } from './prepaid-token';

export type ReconciliationListener = WebhookListener &
  Readonly<{ kind: 'transaction' | 'invoice' | 'refund' }>;
export type PostFinanceReconciliationConfiguration = Readonly<{
  enabled: boolean;
  apiOrigin: 'https://checkout.postfinance.ch' | 'https://app-wallee.com';
  spaceId: number;
  connection: CheckoutConfiguration;
  listeners: readonly ReconciliationListener[];
  /** Merchant simulation prerequisite, not a value from a request or webhook. */
  settlementEvidenceVerified: boolean;
}>;
type Dependencies = {
  database: () => Pick<D1Database, 'prepare' | 'batch'>;
  fetch?: typeof fetch;
  now?: () => number;
};
class LeaseLost extends Error {}
class InvalidPaymentRead extends Error {}
function id(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
function transactionRelation(value: unknown) {
  const candidate =
    value && typeof value === 'object' ? (value as JsonObject).id : value;
  if (!id(candidate)) throw new InvalidPaymentRead();
  return candidate;
}
function failureCode(reason: PrepaidSettlementReason): WebhookFailure {
  if (['invoice_ambiguous', 'refund_ambiguous'].includes(reason))
    return 'ambiguous_period';
  if (
    reason.includes('scope') ||
    reason.includes('binding') ||
    reason.includes('environment')
  )
    return 'ownership_mismatch';
  if (
    [
      'transaction_pending',
      'settlement_incomplete',
      'invoice_missing',
      'invoice_state',
      'refund_pending',
      'invoice_search_incomplete',
      'refund_search_incomplete',
    ].includes(reason)
  )
    return 'settlement_pending';
  return 'invalid_provider_state';
}
function sameRead(before: JsonObject, after: JsonObject) {
  // Financial fields and the optimistic version must remain stable while the
  // independently scoped invoice/refund searches are read. Compare values,
  // not JSON property order or unrelated provider diagnostics.
  const keys = [
    'id',
    'linkedSpaceId',
    'version',
    'state',
    'authorizationEnvironment',
    'environment',
    'currency',
    'customerId',
    'merchantReference',
    'invoiceMerchantReference',
    'authorizationAmount',
    'completedAmount',
    'totalSettledAmount',
    'refundedAmount',
  ];
  return id(before.version) && keys.every((key) => before[key] === after[key]);
}

/** Bounded server worker. Re-reads provider state, never trusts webhook.state,
 * never issues a financial POST, and writes only while its D1 lease is owned.
 * Disabled configuration touches neither the database nor the merchant. */
export async function reconcilePostFinanceJobs(
  configuration: PostFinanceReconciliationConfiguration,
  dependencies: Dependencies,
  maximumJobs = 1,
) {
  const result = {
    state: 'disabled' as 'disabled' | 'processed',
    claimed: 0,
    completed: 0,
    waiting: 0,
    lost: 0,
  };
  if (configuration.enabled !== true) return result;
  if (
    !Number.isSafeInteger(maximumJobs) ||
    maximumJobs < 1 ||
    maximumJobs > 4 ||
    !id(configuration.spaceId) ||
    configuration.connection.enabled !== true ||
    configuration.connection.apiOrigin !== configuration.apiOrigin ||
    configuration.connection.spaceId !== configuration.spaceId ||
    !configuration.listeners.length ||
    configuration.listeners.length > 16 ||
    configuration.listeners.some(
      (listener) =>
        !['transaction', 'invoice', 'refund'].includes(listener.kind),
    )
  )
    throw new InvalidPaymentRead();
  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  const deadline = startedAt + 120_000;
  const db = dependencies.database();
  const inbox = new D1PostFinanceWebhookInbox(
    db,
    { ...configuration, listeners: [...configuration.listeners] },
    () => Math.floor(now() / 1000),
  );
  const records = new D1PrepaidReconciliationStore(db, () =>
    Math.floor(now() / 1000),
  );
  let current: WebhookWork | null = null;
  let calls = 0;
  const transport: typeof fetch = async (input, init) => {
    if (
      !current ||
      now() >= deadline ||
      ++calls > 64 ||
      !(await inbox.renewWork(current))
    )
      throw new LeaseLost();
    const signal = AbortSignal.any([
      ...(init?.signal ? [init.signal] : []),
      AbortSignal.timeout(Math.max(1, deadline - now())),
    ]);
    return (dependencies.fetch ?? fetch)(input, { ...init, signal });
  };
  // No MutationLedger is provided: financial methods cannot execute here.
  const client = new PostFinanceCheckoutClient(configuration.connection, {
    fetch: transport,
    now,
  });
  result.state = 'processed';
  for (let index = 0; index < maximumJobs && now() < deadline; index++) {
    current = await inbox.claimNext();
    if (!current) break;
    result.claimed++;
    try {
      const kind = configuration.listeners.find(
        (listener) => listener.id === current!.event.webhookListenerId,
      )?.kind;
      let transactionId: number;
      let eventInvoiceId: number | null = null;
      let eventRefundId: number | null = null;
      let eventRefund: JsonObject | null = null;
      if (kind === 'transaction') transactionId = current.event.entityId;
      else if (kind === 'invoice') {
        const invoice = await client.readTransactionInvoice(
          current.event.entityId,
        );
        transactionId = transactionRelation(invoice.linkedTransaction);
        eventInvoiceId = current.event.entityId;
      } else if (kind === 'refund') {
        const refund = await client.readRefund(current.event.entityId);
        transactionId = transactionRelation(refund.transaction);
        eventRefundId = current.event.entityId;
        eventRefund = refund;
      } else throw new InvalidPaymentRead();
      const transaction = await client.readTransaction(transactionId);
      const target = await records.target(
        configuration.apiOrigin,
        configuration.spaceId,
        transactionId,
      );
      if (!target) {
        // A webhook may beat persistence of the transaction binding. Retry it;
        // never infer a contract from metadata owned by the provider response.
        if (await inbox.failWork(current, 'ownership_mismatch'))
          result.waiting++;
        else result.lost++;
        continue;
      }
      const expected = {
        ...target,
        contractId: target.period.contractId,
        productKey: target.period.catalog.productKey,
        settlementEvidenceVerified: configuration.settlementEvidenceVerified,
      };
      // A freshly re-read negative fact does not require an invented positive
      // invoice. An invoice outage must not prevent a refund tombstone.
      const negative = await verifyPrepaidSettlement(expected, {
        apiOrigin: configuration.apiOrigin,
        spaceId: configuration.spaceId,
        environment: target.environment,
        transaction,
        invoices: [],
        invoiceSearchComplete: false,
        refunds: eventRefund ? [eventRefund] : [],
        refundSearchComplete: false,
      });
      if (negative.state === 'revoked') {
        const confirmed = await client.readTransaction(transactionId);
        if (!sameRead(transaction, confirmed)) {
          if (await inbox.failWork(current, 'settlement_pending'))
            result.waiting++;
          else result.lost++;
          continue;
        }
        if (!(await inbox.renewWork(current))) {
          result.lost++;
          continue;
        }
        await records.recordReversal(
          target,
          negative.proof.evidenceFingerprint,
          current,
        );
        if (await inbox.completeWork(current)) result.completed++;
        else result.lost++;
        continue;
      }
      const invoice = await client.findTransactionInvoice(transactionId);
      const refunds = await client.listTransactionRefunds(transactionId);
      if (
        (eventInvoiceId !== null && invoice?.id !== eventInvoiceId) ||
        (eventRefundId !== null &&
          !refunds.some((refund) => refund.id === eventRefundId))
      )
        throw new InvalidPaymentRead();
      const latest = await client.readTransaction(transactionId);
      if (!sameRead(transaction, latest)) {
        if (await inbox.failWork(current, 'settlement_pending'))
          result.waiting++;
        else result.lost++;
        continue;
      }
      const decision = await verifyPrepaidSettlement(expected, {
        apiOrigin: configuration.apiOrigin,
        spaceId: configuration.spaceId,
        environment: target.environment,
        transaction: latest,
        invoices: invoice ? [invoice] : [],
        invoiceSearchComplete: true,
        refunds,
        refundSearchComplete: true,
      });
      if (!(await inbox.renewWork(current))) {
        result.lost++;
        continue;
      }
      if (decision.state === 'paid') {
        const initial =
          target.period.ordinal === 0
            ? await db
                .prepare(
                  `SELECT intent_id FROM prepaid_purchase_targets WHERE contract_id=?`,
                )
                .bind(target.period.contractId)
                .first<{ intent_id: string }>()
            : null;
        if (initial) {
          // Proof and entitlement handoff share one D1 batch. Never store the
          // paid proof separately first: standalone addons could see it early.
          await new D1PrepaidProvisioning(db, () =>
            Math.floor(now() / 1000),
          ).provision(decision.proof, current);
          const method = await db
            .prepare(`SELECT json_extract(parameters,'$.method') AS method
            FROM purchase_intents WHERE intent_id=? AND owner_id=? AND provider='postfinance'`)
            .bind(initial.intent_id, target.ownerId)
            .first<{ method: unknown }>();
          if (
            !method ||
            !['postfinance_pay', 'twint'].includes(String(method.method))
          )
            throw new InvalidPaymentRead();
          const tokens = new D1PrepaidTokens(db, () =>
            Math.floor(now() / 1000),
          );
          const expectedToken = await tokens.initialContext(
            target.period.contractId,
            method.method as 'postfinance_pay' | 'twint',
          );
          if (!expectedToken) throw new PrepaidTokenError('binding');
          // The paid company persists even if the independently verified
          // recurring token is unavailable. Retrying only re-reads the token.
          if (!(await tokens.load(target.period.contractId)))
            await tokens.bindInitial(client, expectedToken, current);
        } else await records.recordPaid(decision.proof, current);
      } else if (decision.state === 'revoked')
        await records.recordReversal(
          target,
          decision.proof.evidenceFingerprint,
          current,
        );
      else {
        if (await inbox.failWork(current, failureCode(decision.reason)))
          result.waiting++;
        else result.lost++;
        continue;
      }
      if (await inbox.completeWork(current)) result.completed++;
      else result.lost++;
    } catch (error) {
      if (error instanceof LeaseLost) {
        result.lost++;
        continue;
      }
      const code: WebhookFailure =
        error instanceof CheckoutApiError
          ? 'provider_unavailable'
          : error instanceof InvalidPaymentRead
            ? 'ownership_mismatch'
            : error instanceof PrepaidPeriodError ||
                error instanceof PrepaidProvisioningError
              ? 'storage_unavailable'
              : error instanceof PrepaidTokenError
                ? error.code === 'unavailable'
                  ? 'provider_unavailable'
                  : 'invalid_provider_state'
                : 'provider_unavailable';
      if (await inbox.failWork(current, code)) result.waiting++;
      else result.lost++;
    }
  }
  return result;
}
