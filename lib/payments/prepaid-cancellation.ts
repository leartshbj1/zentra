import type { SwissMethod } from './postfinance-client';
import { PostFinanceCheckoutClient } from './postfinance-client';
import { D1PostFinanceMutationLedger } from './postfinance-store';
import { D1PrepaidReconciliationStore } from './prepaid-reconciliation-store';
import type { PrepaidPurchaseConfiguration } from './prepaid-purchase-preparation';
import { validatePrepaidRenewalTransaction } from './prepaid-renewal';

type Database = Pick<D1Database, 'prepare'>;
const contractPattern =
  /^pfp_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export class PrepaidCancellationError extends Error {
  constructor(
    readonly code: 'authentication' | 'ownership' | 'configuration' | 'binding',
  ) {
    super(`Prepaid cancellation ${code}.`);
  }
}

/** The authenticated account controller calls this with its refreshed user.
 * Local cancellation is persisted first, fencing every new financial dispatch.
 * It preserves paid periods and business data, and never promises a refund or
 * cancellation of a payment that has already been submitted to the merchant. */
export async function cancelPrepaidRenewal(
  db: Database,
  user: { userId: string; emailConfirmed: boolean },
  contractId: string,
  now = Math.floor(Date.now() / 1000),
) {
  if (!user.userId || user.emailConfirmed !== true)
    throw new PrepaidCancellationError('authentication');
  if (
    !contractPattern.test(contractId) ||
    !Number.isSafeInteger(now) ||
    now <= 0
  )
    throw new PrepaidCancellationError('binding');
  const authority = `FROM prepaid_contracts c WHERE c.contract_id=? AND c.owner_id=?
    AND EXISTS(SELECT 1 FROM prepaid_purchase_projections x
      WHERE x.contract_id=c.contract_id AND x.owner_id=c.owner_id AND x.closed_at IS NOT NULL)
    AND (c.organization_id IS NULL OR EXISTS(SELECT 1 FROM organizations o
      JOIN organization_members m ON m.organization_id=o.organization_id
      WHERE o.organization_id=c.organization_id AND o.created_by_user_id=c.owner_id
      AND m.user_id=c.owner_id AND m.role='owner' AND m.revoked_at IS NULL))
    AND (c.workspace_id IS NULL OR EXISTS(SELECT 1 FROM support_workspaces w
      WHERE w.id=c.workspace_id AND w.owner_id=c.owner_id))`;
  await db
    .prepare(`UPDATE prepaid_contracts SET cancelled_at=COALESCE(cancelled_at,?)
    WHERE contract_id IN(SELECT c.contract_id ${authority}) AND created_at<=?`)
    .bind(now, contractId, user.userId, now)
    .run();
  const cancelled = await db
    .prepare(`SELECT c.cancelled_at ${authority}`)
    .bind(contractId, user.userId)
    .first<{ cancelled_at: number | null }>();
  if (!cancelled?.cancelled_at) throw new PrepaidCancellationError('ownership');
  const coverage = await db
    .prepare(`SELECT MAX(p.ends_at) AS ends_at
    FROM prepaid_periods p JOIN prepaid_settlement_proofs s ON s.period_id=p.period_id
    WHERE p.contract_id=? AND NOT EXISTS(SELECT 1 FROM prepaid_effective_revocations r
      WHERE r.period_id=p.period_id)`)
    .bind(contractId)
    .first<{ ends_at: number | null }>();
  return {
    cancelled: true as const,
    cancelledAt: cancelled.cancelled_at,
    paidUntil: coverage?.ends_at ?? null,
  };
}

/** Private, bounded retry worker. Each known in-flight renewal is stopped at
 * most once; an interrupted merchant POST remains uncertain and is never
 * repeated blindly. A scoped terminal GET is durably observed, without claiming
 * that cancelFlow stopped it or that the transaction has settled. Unknown create
 * results remain in the financial journal.
 * The settlement reconciler handles a payment racing cancellation independently. */
export async function stopCancelledPrepaidFlows(
  configuration: PrepaidPurchaseConfiguration,
  dependencies: {
    database: () => Database;
    now?: () => number;
    fetch?: typeof fetch;
  },
  maximum = 1,
) {
  const result = {
    state: 'disabled' as 'disabled' | 'processed',
    inspected: 0,
    stopped: 0,
    terminalObserved: 0,
    uncertain: 0,
  };
  if (configuration.enabled !== true) return result;
  const c = configuration.connection,
    origin = c.apiOrigin ?? 'https://checkout.postfinance.ch';
  if (
    !['TEST', 'PRODUCTION'].includes(c.prepaidEnvironment ?? '') ||
    c.enabled !== true ||
    c.merchantApproved !== true ||
    c.prepaidFeatureEnabled !== true ||
    c.chargeFlowEnabled !== true ||
    (c.prepaidEnvironment === 'PRODUCTION' &&
      !configuration.settlementEvidenceVerified) ||
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > 4
  )
    throw new PrepaidCancellationError('configuration');
  const db = dependencies.database(),
    now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));
  const rows = await db
    .prepare(`SELECT c.contract_id,p.period_id,t.transaction_id,i.parameters,
    renewal.parameters AS renewal_parameters
    FROM prepaid_contracts c JOIN prepaid_periods p ON p.contract_id=c.contract_id
    JOIN prepaid_transactions t ON t.period_id=p.period_id
    JOIN prepaid_purchase_targets x ON x.contract_id=c.contract_id
    JOIN purchase_intents i ON i.intent_id=x.intent_id
    LEFT JOIN prepaid_renewal_requests renewal ON renewal.period_id=p.period_id
    WHERE c.cancelled_at IS NOT NULL AND p.ordinal>0 AND c.api_origin=? AND c.space_id=?
    AND c.environment=? AND t.api_origin=c.api_origin AND t.space_id=c.space_id
    AND NOT EXISTS(SELECT 1 FROM prepaid_settlement_proofs s WHERE s.period_id=p.period_id)
    AND NOT EXISTS(SELECT 1 FROM prepaid_effective_revocations r WHERE r.period_id=p.period_id)
    AND NOT EXISTS(SELECT 1 FROM prepaid_flow_cancellations f WHERE f.period_id=p.period_id)
    ORDER BY c.cancelled_at,p.ordinal LIMIT ?`)
    .bind(origin, c.spaceId!, c.prepaidEnvironment!, maximum)
    .all<{
      contract_id: string;
      period_id: string;
      transaction_id: number;
      parameters: string;
      renewal_parameters: string | null;
    }>();
  result.state = 'processed';
  const readClient = new PostFinanceCheckoutClient(c, {
    fetch: dependencies.fetch,
    now: () => now() * 1000,
  });
  const records = new D1PrepaidReconciliationStore(db, now);
  for (const row of rows.results) {
    result.inspected++;
    let claim: string | null = null;
    try {
      const params = JSON.parse(row.parameters) as Record<string, unknown>;
      const method = params.method as SwissMethod;
      if (!['twint', 'postfinance_pay'].includes(method)) throw new Error();
      const target = await records.target(
        origin,
        c.spaceId!,
        row.transaction_id,
      );
      if (
        !target ||
        target.period.contractId !== row.contract_id ||
        target.period.periodId !== row.period_id
      )
        throw new Error();
      const renewal = JSON.parse(row.renewal_parameters ?? '') as Record<
        string,
        unknown
      >;
      const urls = renewal.urls as Record<string, unknown> | undefined;
      if (
        !Number.isSafeInteger(renewal.tokenId) ||
        (renewal.tokenId as number) <= 0 ||
        typeof renewal.emailAddress !== 'string' ||
        renewal.emailAddress !== params.emailAddress ||
        !urls ||
        typeof urls.successUrl !== 'string' ||
        typeof urls.failureUrl !== 'string'
      )
        throw new Error();
      const transaction = await readClient.readTransaction(row.transaction_id);
      validatePrepaidRenewalTransaction(
        transaction,
        target,
        {
          tokenId: renewal.tokenId as number,
          emailAddress: renewal.emailAddress,
          urls: { successUrl: urls.successUrl, failureUrl: urls.failureUrl },
        },
        false,
      );
      // FULFILL alone is not payment evidence. This marker merely removes an
      // already terminal, correctly bound task from this cancellation queue;
      // settlement/refund reconciliation still decides every paid entitlement.
      const terminal = [
        'FULFILL',
        'COMPLETED',
        'FAILED',
        'DECLINE',
        'VOIDED',
      ].includes(String(transaction.state));
      claim = crypto.randomUUID();
      const won = await db
        .prepare(`INSERT INTO prepaid_flow_cancellations
        (period_id,contract_id,transaction_id,state,claim_token,created_at,updated_at)
        SELECT p.period_id,c.contract_id,t.transaction_id,'claimed',?,?,?
        FROM prepaid_periods p JOIN prepaid_contracts c ON c.contract_id=p.contract_id
        JOIN prepaid_transactions t ON t.period_id=p.period_id
        WHERE p.period_id=? AND c.contract_id=? AND c.cancelled_at IS NOT NULL
        AND t.transaction_id=? AND t.api_origin=? AND t.space_id=?
        AND NOT EXISTS(SELECT 1 FROM prepaid_settlement_proofs s WHERE s.period_id=p.period_id)
        ON CONFLICT(period_id) DO NOTHING`)
        .bind(
          claim,
          now(),
          now(),
          row.period_id,
          row.contract_id,
          row.transaction_id,
          origin,
          c.spaceId!,
        )
        .run();
      if (won.meta.changes !== 1) {
        claim = null;
        continue;
      }
      if (!terminal) {
        const client = new PostFinanceCheckoutClient(c, {
          fetch: dependencies.fetch,
          now: () => now() * 1000,
          ledger: new D1PostFinanceMutationLedger(db, now, {
            periodId: row.period_id,
            contractId: row.contract_id,
            ownerId: target.ownerId,
            organizationId: target.organizationId,
            workspaceId: target.workspaceId,
            apiOrigin: origin,
            spaceId: c.spaceId!,
            environment: target.environment,
            operation: 'cancel',
            transactionId: row.transaction_id,
          }),
        });
        const stopped = await client.cancelPrepaidChargeFlow(
          row.transaction_id,
          method,
          `${row.period_id}_cancel`,
        );
        if (
          stopped.id !== row.transaction_id ||
          stopped.linkedSpaceId !== c.spaceId
        )
          throw new Error();
      }
      const done = await db
        .prepare(`UPDATE prepaid_flow_cancellations
        SET state='completed',claim_token=NULL,updated_at=?
        WHERE period_id=? AND state='claimed' AND claim_token=?`)
        .bind(now(), row.period_id, claim)
        .run();
      if (done.meta.changes !== 1) throw new Error();
      if (terminal) result.terminalObserved++;
      else result.stopped++;
    } catch {
      if (claim)
        await db
          .prepare(`UPDATE prepaid_flow_cancellations
        SET state='uncertain',claim_token=NULL,updated_at=?
        WHERE period_id=? AND state='claimed' AND claim_token=?`)
          .bind(now(), row.period_id, claim)
          .run();
      result.uncertain++;
    }
  }
  return result;
}
