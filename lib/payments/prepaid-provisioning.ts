import {
  D1PrepaidReconciliationStore,
  type SettlementRecord,
} from './prepaid-reconciliation-store';
import {
  assertSettlementWork,
  settlementWorkFence,
  type SettlementWork,
} from './prepaid-settlement-work';
import type { PrepaidProduct } from './prepaid-catalog';

type Database = Pick<D1Database, 'prepare' | 'batch'>;
export type PrepaidPurchaseTarget = Readonly<{
  intentId: string;
  contractId: string;
  ownerId: string;
  organizationId: string | null;
  workspaceId: string | null;
  previousSubscriptionId: string | null;
}>;
export type PrepaidProvisioningResult = Readonly<{
  state: 'projected' | 'replayed';
  periodId: string;
  contractId: string;
  organizationId: string | null;
  workspaceId: string | null;
  productKind: PrepaidProduct['productKind'];
}>;
export class PrepaidProvisioningError extends Error {
  constructor(
    public readonly code: 'invalid' | 'scope' | 'state' | 'unavailable',
  ) {
    super(`Prepaid provisioning ${code}.`);
  }
}
type TargetRow = {
  intent_id: string;
  contract_id: string;
  owner_id: string;
  organization_id: string | null;
  workspace_id: string | null;
  previous_subscription_id: string | null;
};
type ProjectionRow = {
  invoice_id: number | null;
  closed_at: number | null;
  evidence_fingerprint: string;
  owner_id: string;
  organization_id: string | null;
  workspace_id: string | null;
  contract_id: string;
  intent_id: string;
  period_id: string;
};
const identity = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 180 &&
  Array.from(value).every((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 && code !== 127;
  });
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
const hash = (value: string) => /^[0-9a-f]{64}$/.test(value);
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
function validateTarget(target: PrepaidPurchaseTarget) {
  if (
    !new RegExp(`^purchase_${uuid}$`).test(target.intentId) ||
    target.contractId !== `pfp_${target.intentId.slice('purchase_'.length)}` ||
    !identity(target.ownerId) ||
    [
      target.organizationId,
      target.workspaceId,
      target.previousSubscriptionId,
    ].some((value) => value !== null && !identity(value)) ||
    (target.organizationId === null) !==
      (target.previousSubscriptionId === null)
  )
    throw new PrepaidProvisioningError('invalid');
}
function matches(target: PrepaidPurchaseTarget, row: TargetRow) {
  return (
    target.intentId === row.intent_id &&
    target.contractId === row.contract_id &&
    target.ownerId === row.owner_id &&
    target.organizationId === row.organization_id &&
    target.workspaceId === row.workspace_id &&
    target.previousSubscriptionId === row.previous_subscription_id
  );
}
/** Private first-period handoff. No merchant calls, licence issuance, renewals
 * or status-derived rights. Migration 0078's mandatory projection/closure
 * triggers make any lost owner, target, lease or proof roll back the batch. */
export class D1PrepaidProvisioning {
  constructor(
    private readonly db: Database,
    private readonly clock = () => Math.floor(Date.now() / 1000),
  ) {}

  async freezeTarget(
    target: PrepaidPurchaseTarget,
  ): Promise<PrepaidPurchaseTarget> {
    validateTarget(target);
    const now = this.clock();
    if (!positive(now)) throw new PrepaidProvisioningError('invalid');
    await this.db
      .prepare(`INSERT INTO prepaid_purchase_targets
      (intent_id,contract_id,owner_id,organization_id,workspace_id,previous_subscription_id,created_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(intent_id) DO NOTHING`)
      .bind(
        target.intentId,
        target.contractId,
        target.ownerId,
        target.organizationId,
        target.workspaceId,
        target.previousSubscriptionId,
        now,
      )
      .run();
    const stored = await this.db
      .prepare('SELECT * FROM prepaid_purchase_targets WHERE intent_id=?')
      .bind(target.intentId)
      .first<TargetRow>();
    if (!stored || !matches(target, stored))
      throw new PrepaidProvisioningError('scope');
    return Object.freeze({ ...target });
  }

  async provision(
    proof: SettlementRecord,
    work: SettlementWork,
  ): Promise<PrepaidProvisioningResult> {
    const now = this.clock();
    if (
      !positive(now) ||
      !positive(proof.invoiceId) ||
      !hash(proof.evidenceFingerprint) ||
      proof.environment !== 'PRODUCTION'
    )
      throw new PrepaidProvisioningError('invalid');
    const target = await new D1PrepaidReconciliationStore(
      this.db,
      this.clock,
    ).target(proof.apiOrigin, proof.spaceId, proof.transactionId);
    if (
      !target ||
      target.environment !== 'PRODUCTION' ||
      target.period.ordinal !== 0 ||
      target.ownerId !== proof.ownerId ||
      target.organizationId !== proof.organizationId ||
      target.workspaceId !== proof.workspaceId ||
      target.period.periodId !== proof.periodId ||
      target.period.startsAt !== proof.startsAt ||
      target.period.endsAt !== proof.endsAt ||
      target.period.priceChfMinor !== proof.priceChfMinor ||
      target.period.currency !== proof.currency ||
      target.period.catalogVersion !== proof.catalogVersion
    )
      throw new PrepaidProvisioningError('scope');
    const context = { ...proof, contractId: target.period.contractId };
    let fence;
    try {
      fence = await settlementWorkFence(work, context, this.clock());
    } catch {
      throw new PrepaidProvisioningError('invalid');
    }
    const row = await this.db
      .prepare('SELECT * FROM prepaid_purchase_targets WHERE contract_id=?')
      .bind(target.period.contractId)
      .first<TargetRow>();
    if (
      !row ||
      row.owner_id !== proof.ownerId ||
      row.organization_id !== proof.organizationId ||
      row.workspace_id !== proof.workspaceId
    )
      throw new PrepaidProvisioningError('scope');
    const result = (state: 'projected' | 'replayed') =>
      Object.freeze({
        state,
        periodId: proof.periodId,
        contractId: row.contract_id,
        organizationId: row.organization_id,
        workspaceId: row.workspace_id,
        productKind: target.period.catalog.productKind,
      });
    const stored = await this.db
      .prepare(`SELECT p.*, s.invoice_id FROM prepaid_purchase_projections p
        LEFT JOIN prepaid_settlement_proofs s ON s.period_id=p.period_id
        WHERE p.period_id=?`)
      .bind(proof.periodId)
      .first<ProjectionRow>();
    if (stored) {
      if (
        stored.closed_at === null ||
        stored.invoice_id !== proof.invoiceId ||
        stored.evidence_fingerprint !== proof.evidenceFingerprint ||
        stored.contract_id !== row.contract_id ||
        stored.intent_id !== row.intent_id ||
        stored.owner_id !== proof.ownerId ||
        stored.organization_id !== proof.organizationId ||
        stored.workspace_id !== proof.workspaceId
      )
        throw new PrepaidProvisioningError('state');
      try {
        await assertSettlementWork(this.db, work, context, this.clock());
      } catch {
        throw new PrepaidProvisioningError('state');
      }
      // Returning a closed historical handoff never re-grants revoked access.
      return result('replayed');
    }
    if (proof.startsAt > now || proof.endsAt <= now)
      throw new PrepaidProvisioningError('state');
    const catalog = target.period.catalog;
    const binding = `EXISTS(SELECT 1 FROM prepaid_initial_purchase_bindings b
      WHERE b.period_id=? AND b.intent_id=? AND b.contract_id=? AND b.owner_id=?
      AND b.invoice_id=? AND b.evidence_fingerprint=?)`;
    const values = [
      proof.periodId,
      row.intent_id,
      row.contract_id,
      proof.ownerId,
      proof.invoiceId,
      proof.evidenceFingerprint,
    ];
    const statements = [
      this.db
        .prepare(`INSERT INTO prepaid_settlement_proofs(period_id,invoice_id,evidence_fingerprint,reconciled_at)
      SELECT p.period_id,?,?,? FROM prepaid_periods p JOIN prepaid_contracts c ON c.contract_id=p.contract_id
      JOIN prepaid_transactions t ON t.period_id=p.period_id
      WHERE p.period_id=? AND p.ordinal=0 AND t.transaction_id=? AND t.api_origin=? AND t.space_id=?
      AND c.environment='PRODUCTION' AND c.owner_id=? AND c.organization_id IS ? AND c.workspace_id IS ?
      AND p.starts_at=? AND p.ends_at=? AND p.currency=? AND p.price_chf_minor=? AND p.catalog_version=?
      AND NOT EXISTS(SELECT 1 FROM prepaid_effective_revocations r WHERE r.period_id=p.period_id)
      AND (${fence.sql})
      ON CONFLICT(period_id) DO NOTHING`)
        .bind(
          proof.invoiceId,
          proof.evidenceFingerprint,
          now,
          proof.periodId,
          proof.transactionId,
          proof.apiOrigin,
          proof.spaceId,
          proof.ownerId,
          proof.organizationId,
          proof.workspaceId,
          proof.startsAt,
          proof.endsAt,
          proof.currency,
          proof.priceChfMinor,
          proof.catalogVersion,
          ...fence.values,
        ),
    ];
    if (catalog.gestion) {
      statements.push(
        this.db
          .prepare(`INSERT INTO subscriptions(subscription_id,customer_id,customer_name,price_id,
        plan_id,entitlement_plan_id,seat_limit,status,current_period_end,entitlement_valid_until,last_paid_invoice_id,last_paid_at,
        cancel_at_period_end,livemode,updated_at)
        SELECT ?,?,o.name,?,?,?,?, 'active',?,?,?, ?,c.cancelled_at IS NOT NULL,1,?
        FROM organizations o JOIN prepaid_contracts c ON c.contract_id=?
        WHERE o.organization_id=? AND o.created_by_user_id=? AND ${binding}
        ON CONFLICT(subscription_id) DO NOTHING`)
          .bind(
            row.contract_id,
            row.contract_id,
            catalog.productKey,
            catalog.gestion.licensePlan,
            catalog.gestion.licensePlan,
            catalog.gestion.seats,
            proof.endsAt,
            proof.endsAt,
            proof.periodId,
            now,
            now,
            row.contract_id,
            row.organization_id,
            proof.ownerId,
            ...values,
          ),
      );
      statements.push(
        this.db
          .prepare(`UPDATE organizations SET subscription_id=?,updated_at=?
        WHERE organization_id=? AND created_by_user_id=? AND subscription_id=? AND ${binding}`)
          .bind(
            row.contract_id,
            now,
            row.organization_id,
            proof.ownerId,
            row.previous_subscription_id,
            ...values,
          ),
      );
    }
    if (catalog.productKind === 'complete') {
      statements.push(
        this.db
          .prepare(`INSERT INTO support_gestion_links(workspace_id,organization_id,enabled,auto_post,connected_by,created_at)
        SELECT ?,?,1,0,?,? WHERE ${binding} AND NOT EXISTS(SELECT 1 FROM support_gestion_links WHERE workspace_id=? OR organization_id=?)
        ON CONFLICT DO NOTHING`)
          .bind(
            row.workspace_id,
            row.organization_id,
            proof.ownerId,
            now,
            ...values,
            row.workspace_id,
            row.organization_id,
          ),
      );
    }
    if (catalog.productKind === 'support' && catalog.support) {
      statements.push(
        this.db
          .prepare(`INSERT INTO support_subscriptions(workspace_id,subscription_id,customer_id,
        plan_id,paid_plan_id,status,paid_from,paid_until,last_paid_invoice_id,cancel_at_period_end,livemode,updated_at)
        SELECT ?,?,?,?,?,'active',?,?,?,c.cancelled_at IS NOT NULL,1,? FROM prepaid_contracts c
        WHERE c.contract_id=? AND ${binding}
        ON CONFLICT(workspace_id) DO UPDATE SET subscription_id=excluded.subscription_id,customer_id=excluded.customer_id,
        plan_id=excluded.plan_id,paid_plan_id=excluded.paid_plan_id,status=excluded.status,paid_from=excluded.paid_from,
        paid_until=excluded.paid_until,last_paid_invoice_id=excluded.last_paid_invoice_id,
        cancel_at_period_end=excluded.cancel_at_period_end,livemode=excluded.livemode,updated_at=excluded.updated_at`)
          .bind(
            row.workspace_id,
            row.contract_id,
            row.contract_id,
            catalog.support.planId,
            catalog.support.planId,
            proof.startsAt,
            proof.endsAt,
            proof.periodId,
            now,
            row.contract_id,
            ...values,
          ),
      );
    }
    if (catalog.productKind === 'automation') {
      statements.push(
        this.db
          .prepare(`INSERT INTO automation_subscriptions(organization_id,subscription_id,customer_id,
        status,paid_from,paid_until,last_paid_invoice_id,cancel_at_period_end,livemode,updated_at)
        SELECT ?,?,?,'active',?,?,?,c.cancelled_at IS NOT NULL,1,? FROM prepaid_contracts c
        WHERE c.contract_id=? AND ${binding}
        ON CONFLICT(organization_id) DO UPDATE SET subscription_id=excluded.subscription_id,customer_id=excluded.customer_id,
        status=excluded.status,paid_from=excluded.paid_from,paid_until=excluded.paid_until,
        last_paid_invoice_id=excluded.last_paid_invoice_id,cancel_at_period_end=excluded.cancel_at_period_end,
        livemode=excluded.livemode,updated_at=excluded.updated_at`)
          .bind(
            row.organization_id,
            row.contract_id,
            row.contract_id,
            proof.startsAt,
            proof.endsAt,
            proof.periodId,
            now,
            row.contract_id,
            ...values,
          ),
      );
    }
    statements.push(
      this.db
        .prepare(`INSERT INTO prepaid_purchase_projections
      (period_id,intent_id,contract_id,owner_id,organization_id,workspace_id,projected_at,evidence_fingerprint,scope_hash,lease)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(period_id) DO NOTHING`)
        .bind(
          proof.periodId,
          row.intent_id,
          row.contract_id,
          proof.ownerId,
          row.organization_id,
          row.workspace_id,
          now,
          proof.evidenceFingerprint,
          work.scopeHash,
          work.lease,
        ),
    );
    if (catalog.gestion) {
      statements.push(
        this.db
          .prepare(`UPDATE account_trials SET converted_subscription_id=?
        WHERE user_id=? AND organization_id=? AND subscription_id=? AND converted_subscription_id IS NULL
        AND EXISTS(SELECT 1 FROM prepaid_initial_purchase_effective WHERE period_id=? AND evidence_fingerprint=?)`)
          .bind(
            row.contract_id,
            proof.ownerId,
            row.organization_id,
            row.previous_subscription_id,
            proof.periodId,
            proof.evidenceFingerprint,
          ),
      );
      statements.push(
        this.db
          .prepare(`UPDATE license_activations SET subscription_id=? WHERE subscription_id=?
        AND EXISTS(SELECT 1 FROM prepaid_initial_purchase_effective WHERE period_id=? AND evidence_fingerprint=?)`)
          .bind(
            row.contract_id,
            row.previous_subscription_id,
            proof.periodId,
            proof.evidenceFingerprint,
          ),
      );
    }
    statements.push(
      this.db
        .prepare(`UPDATE purchase_intents SET state='settled',finalized_at=?,evidence_fingerprint=?
      WHERE intent_id=? AND state IN ('dispatched','uncertain')
      AND EXISTS(SELECT 1 FROM prepaid_initial_purchase_effective WHERE period_id=? AND evidence_fingerprint=?)`)
        .bind(
          now,
          proof.evidenceFingerprint,
          row.intent_id,
          proof.periodId,
          proof.evidenceFingerprint,
        ),
    );
    statements.push(
      this.db
        .prepare(`UPDATE purchase_intent_footprints SET released_at=(SELECT finalized_at FROM purchase_intents WHERE intent_id=?)
      WHERE intent_id=? AND released_at IS NULL AND EXISTS(SELECT 1 FROM purchase_intents WHERE intent_id=? AND state='settled')`)
        .bind(row.intent_id, row.intent_id, row.intent_id),
    );
    statements.push(
      this.db
        .prepare(
          `UPDATE prepaid_purchase_projections SET closed_at=? WHERE period_id=? AND closed_at IS NULL`,
        )
        .bind(now, proof.periodId),
    );
    try {
      await this.db.batch(statements);
    } catch {
      throw new PrepaidProvisioningError('unavailable');
    }
    const completed = await this.db
      .prepare(`SELECT closed_at FROM prepaid_purchase_projections
      WHERE period_id=? AND evidence_fingerprint=? AND closed_at IS NOT NULL`)
      .bind(proof.periodId, proof.evidenceFingerprint)
      .first<{ closed_at: number }>();
    if (!completed) throw new PrepaidProvisioningError('state');
    return result('projected');
  }
}
