import {
  PostFinanceCheckoutClient,
  CheckoutApiError,
  type CheckoutConfiguration,
  type JsonObject,
} from '@/lib/payments/postfinance-client';
import {
  D1PostFinanceWebhookInbox,
  type WebhookListener,
  type WebhookFailure,
} from '@/lib/payments/postfinance-store';
import { D1PrepaidReconciliationStore } from '@/lib/payments/prepaid-reconciliation-store';
import {
  verifyPrepaidSettlement,
  type PrepaidSettlementReason,
} from '@/lib/payments/prepaid-settlement';
import { PrepaidPeriodError } from '@/lib/payments/prepaid-periods';
import {
  D1PrepaidProvisioning,
  PrepaidProvisioningError,
} from '@/lib/payments/prepaid-provisioning';
import {
  D1PrepaidTokens,
  PrepaidTokenError,
} from '@/lib/payments/prepaid-token';
import {
  D1PrepaidObservations,
  D1PostFinanceSettlementQueue,
} from '@/lib/payments/prepaid-observation-store';
import {
  assertObservationTarget,
  isObservationWork,
  SettlementWorkError,
  type SettlementWork,
} from '@/lib/payments/prepaid-settlement-work';

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
  /** Server-only activation and identity filter, independent of webhooks. */
  observations?: Readonly<{
    enabled: true;
    environment: 'TEST' | 'PRODUCTION';
    ownerIds?: readonly string[];
  }>;
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
    settlementWaiting: 0,
    failures: 0,
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
    (!configuration.listeners.length && !configuration.observations) ||
    (configuration.observations !== undefined &&
      (configuration.observations.enabled !== true ||
        !['TEST', 'PRODUCTION'].includes(
          configuration.observations.environment,
        ) ||
        (configuration.observations.ownerIds !== undefined &&
          (!configuration.observations.ownerIds.length ||
            configuration.observations.ownerIds.length > 20 ||
            configuration.observations.ownerIds.some(
              (owner) =>
                typeof owner !== 'string' ||
                !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
                  owner,
                ),
            ) ||
            new Set(configuration.observations.ownerIds).size !==
              configuration.observations.ownerIds.length)))) ||
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
  // Without observations the original inbox-only path never reads new tables.
  // The combined queue orders both sources by their durable due time.
  const combined = configuration.observations
    ? new D1PostFinanceSettlementQueue(db, configuration, () =>
        Math.floor(now() / 1000),
      )
    : null;
  const legacy = configuration.observations
    ? null
    : new D1PostFinanceWebhookInbox(
        db,
        { ...configuration, listeners: [...configuration.listeners] },
        () => Math.floor(now() / 1000),
      );
  const inbox = {
    claimNext: (): Promise<SettlementWork | null> =>
      combined ? combined.claimNext() : legacy!.claimNext(),
    renewWork: (work: SettlementWork) =>
      combined
        ? combined.renewWork(work)
        : !isObservationWork(work)
          ? legacy!.renewWork(work)
          : Promise.resolve(false),
    completeWork: (work: SettlementWork) =>
      combined
        ? combined.completeWork(work)
        : !isObservationWork(work)
          ? legacy!.completeWork(work)
          : Promise.resolve(false),
    failWork: (work: SettlementWork, code: WebhookFailure) =>
      combined
        ? combined.failWork(work, code)
        : !isObservationWork(work)
          ? legacy!.failWork(work, code)
          : Promise.resolve(false),
  };
  const records = new D1PrepaidReconciliationStore(db, () =>
    Math.floor(now() / 1000),
  );
  if (configuration.observations)
    await new D1PrepaidObservations(db, () =>
      Math.floor(now() / 1000),
    ).admitBoundTransactions({
      apiOrigin: configuration.apiOrigin,
      spaceId: configuration.spaceId,
      environment: configuration.observations.environment,
    });
  let current: SettlementWork | null = null;
  let calls = 0;
  const transport: typeof fetch = async (input, init) => {
    if (
      (init?.method !== undefined && init.method !== 'GET') ||
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
    const work = current;
    try {
      let targetHint: Awaited<ReturnType<typeof records.target>> = null;
      const kind = !isObservationWork(work)
        ? configuration.listeners.find(
            (listener) => listener.id === work.event.webhookListenerId,
          )?.kind
        : undefined;
      let transactionId: number;
      let eventInvoiceId: number | null = null;
      let eventRefundId: number | null = null;
      let eventRefund: JsonObject | null = null;
      if (isObservationWork(work)) {
        const binding = work.binding;
        if (
          !configuration.observations ||
          binding.apiOrigin !== configuration.apiOrigin ||
          binding.spaceId !== configuration.spaceId ||
          binding.environment !== configuration.observations.environment ||
          (configuration.observations.ownerIds !== undefined &&
            !configuration.observations.ownerIds.includes(binding.ownerId))
        )
          throw new InvalidPaymentRead();
        // Resolve the server binding before a merchant GET. No response
        // metadata or invented webhook is allowed to choose a local contract.
        transactionId = binding.transactionId;
        targetHint = await records.target(
          configuration.apiOrigin,
          configuration.spaceId,
          transactionId,
        );
        if (!targetHint) throw new InvalidPaymentRead();
        await assertObservationTarget(work, targetHint);
      } else if (kind === 'transaction') transactionId = work.event.entityId;
      else if (!isObservationWork(work) && kind === 'invoice') {
        const invoice = await client.readTransactionInvoice(
          work.event.entityId,
        );
        transactionId = transactionRelation(invoice.linkedTransaction);
        eventInvoiceId = work.event.entityId;
      } else if (!isObservationWork(work) && kind === 'refund') {
        const refund = await client.readRefund(work.event.entityId);
        transactionId = transactionRelation(refund.transaction);
        eventRefundId = work.event.entityId;
        eventRefund = refund;
      } else throw new InvalidPaymentRead();
      const transaction = await client.readTransaction(transactionId);
      const target =
        targetHint ??
        (await records.target(
          configuration.apiOrigin,
          configuration.spaceId,
          transactionId,
        ));
      if (!target) {
        // A webhook may beat persistence of the transaction binding. Retry it;
        // never infer a contract from metadata owned by the provider response.
        if (await inbox.failWork(work, 'ownership_mismatch')) result.waiting++;
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
          if (await inbox.failWork(work, 'settlement_pending'))
            result.waiting++;
          else result.lost++;
          continue;
        }
        if (!(await inbox.renewWork(work))) {
          result.lost++;
          continue;
        }
        await records.recordReversal(
          target,
          negative.proof.evidenceFingerprint,
          work,
        );
        if (await inbox.completeWork(work)) result.completed++;
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
        if (await inbox.failWork(work, 'settlement_pending')) result.waiting++;
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
      if (!(await inbox.renewWork(work))) {
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
          ).provision(decision.proof, work);
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
            await tokens.bindInitial(client, expectedToken, work);
        } else await records.recordPaid(decision.proof, work);
      } else if (decision.state === 'revoked')
        await records.recordReversal(
          target,
          decision.proof.evidenceFingerprint,
          work,
        );
      else {
        const code = failureCode(decision.reason);
        if (await inbox.failWork(work, code)) {
          result.waiting++;
          // Only a stable, exhaustive read waiting for a normal provider state
          // can bypass the relay's global cooldown. Attempt eight is terminal.
          if (
            decision.state === 'pending' &&
            code === 'settlement_pending' &&
            work.attempts < 8 &&
            [
              'transaction_pending',
              'settlement_incomplete',
              'invoice_missing',
              'invoice_state',
              'refund_pending',
            ].includes(decision.reason)
          )
            result.settlementWaiting++;
        } else result.lost++;
        continue;
      }
      if (await inbox.completeWork(work)) result.completed++;
      else result.lost++;
    } catch (error) {
      if (
        error instanceof LeaseLost ||
        (error instanceof SettlementWorkError && error.code === 'lost')
      ) {
        result.lost++;
        continue;
      }
      const code: WebhookFailure =
        error instanceof CheckoutApiError
          ? 'provider_unavailable'
          : error instanceof InvalidPaymentRead ||
              error instanceof SettlementWorkError
            ? 'ownership_mismatch'
            : error instanceof PrepaidPeriodError ||
                error instanceof PrepaidProvisioningError
              ? 'storage_unavailable'
              : error instanceof PrepaidTokenError
                ? error.code === 'unavailable'
                  ? 'provider_unavailable'
                  : 'invalid_provider_state'
                : 'provider_unavailable';
      if (await inbox.failWork(work, code)) result.waiting++;
      else result.lost++;
    }
  }
  result.failures = result.waiting - result.settlementWaiting;
  return result;
}
