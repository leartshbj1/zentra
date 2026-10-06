import {
  D1PrepaidPeriods,
  PrepaidPeriodError,
  type PrepaidPeriod,
} from './prepaid-periods';
import { prepaidProduct } from './prepaid-catalog';
import { prepaidMonthlyPeriod } from './prepaid-calendar';
import type { WebhookWork } from './postfinance-store';

type Database = Pick<D1Database, 'prepare'>;
export type PaymentExpectation = Readonly<{
  customerReference: string;
  planReference: string;
  paymentMethodConfigurationId: number;
  connectorConfigurationId: number;
}>;
export type ReconciliationTarget = PaymentExpectation &
  Readonly<{
    apiOrigin: string;
    spaceId: number;
    environment: 'TEST' | 'PRODUCTION';
    ownerId: string;
    organizationId: string | null;
    workspaceId: string | null;
    transactionId: number;
    period: PrepaidPeriod;
  }>;
export type SettlementRecord = Parameters<
  D1PrepaidPeriods['recordReconciledSettlement']
>[0];
type TargetRow = {
  contract_id: string;
  owner_id: string;
  organization_id: string | null;
  workspace_id: string | null;
  api_origin: string;
  space_id: number;
  environment: 'TEST' | 'PRODUCTION';
  product_key: string;
  anchor_start: number;
  contract_catalog_json: string;
  contract_catalog_version: string;
  period_id: string;
  ordinal: number;
  starts_at: number;
  ends_at: number;
  currency: string;
  price_chf_minor: number;
  catalog_json: string;
  catalog_version: string;
  transaction_id: number;
  customer_reference: string;
  plan_reference: string;
  payment_method_configuration_id: number;
  connector_configuration_id: number;
  expectation_fingerprint: string;
};
const encode = new TextEncoder();
async function digest(value: string) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', encode.encode(value))),
  )
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
function reference(value: string) {
  return /^[A-Za-z0-9_-]{1,120}$/.test(value);
}
function positive(value: number) {
  return Number.isSafeInteger(value) && value > 0;
}
function expectationValues(value: PaymentExpectation) {
  if (
    !reference(value.customerReference) ||
    !reference(value.planReference) ||
    !positive(value.paymentMethodConfigurationId) ||
    !positive(value.connectorConfigurationId)
  )
    throw new PrepaidPeriodError('invalid');
  return [
    value.customerReference,
    value.planReference,
    value.paymentMethodConfigurationId,
    value.connectorConfigurationId,
  ] as const;
}

/** Internal durable binding. Nothing here accepts browser claims or calls a
 * merchant. The purchase controller must authorise the owner before freezing
 * these expectations and dispatching a financial mutation. */
export class D1PrepaidReconciliationStore {
  constructor(
    private db: Database,
    private clock = () => Math.floor(Date.now() / 1000),
  ) {}

  async freezeExpectation(periodId: string, value: PaymentExpectation) {
    if (!/^pfperiod_[0-9a-f]{64}$/.test(periodId))
      throw new PrepaidPeriodError('invalid');
    const values = expectationValues(value);
    const fingerprint = await digest(JSON.stringify([periodId, ...values]));
    await this.db
      .prepare(`INSERT INTO prepaid_payment_expectations
      (period_id,customer_reference,plan_reference,payment_method_configuration_id,connector_configuration_id,fingerprint,created_at)
      SELECT period_id,?,?,?,?,?,? FROM prepaid_periods WHERE period_id=? AND catalog_version=?
      ON CONFLICT(period_id) DO NOTHING`)
      .bind(...values, fingerprint, this.clock(), periodId, value.planReference)
      .run();
    const row = await this.db
      .prepare(
        'SELECT fingerprint FROM prepaid_payment_expectations WHERE period_id=?',
      )
      .bind(periodId)
      .first<{ fingerprint: string }>();
    if (!row || row.fingerprint !== fingerprint)
      throw new PrepaidPeriodError('conflict');
  }

  async target(
    apiOrigin: string,
    spaceId: number,
    transactionId: number,
  ): Promise<ReconciliationTarget | null> {
    if (
      !['https://checkout.postfinance.ch', 'https://app-wallee.com'].includes(
        apiOrigin,
      ) ||
      !positive(spaceId) ||
      !positive(transactionId)
    )
      throw new PrepaidPeriodError('invalid');
    const row = await this.db
      .prepare(`SELECT c.contract_id,c.owner_id,c.organization_id,c.workspace_id,
      c.api_origin,c.space_id,c.environment,c.product_key,c.anchor_start,
      c.catalog_json AS contract_catalog_json,c.catalog_version AS contract_catalog_version,
      p.*,t.transaction_id,e.customer_reference,e.plan_reference,e.payment_method_configuration_id,
      e.connector_configuration_id,e.fingerprint AS expectation_fingerprint
      FROM prepaid_transactions t JOIN prepaid_periods p ON p.period_id=t.period_id
      JOIN prepaid_contracts c ON c.contract_id=p.contract_id
      JOIN prepaid_payment_expectations e ON e.period_id=p.period_id
      WHERE t.api_origin=? AND t.space_id=? AND t.transaction_id=?
      AND c.api_origin=t.api_origin AND c.space_id=t.space_id`)
      .bind(apiOrigin, spaceId, transactionId)
      .first<TargetRow>();
    if (!row) return null;
    const catalog = prepaidProduct(row.product_key);
    const expectedJson = catalog && JSON.stringify(catalog);
    const value: PaymentExpectation = {
      customerReference: row.customer_reference,
      planReference: row.plan_reference,
      paymentMethodConfigurationId: row.payment_method_configuration_id,
      connectorConfigurationId: row.connector_configuration_id,
    };
    const values = expectationValues(value);
    const dates = prepaidMonthlyPeriod(row.anchor_start, row.ordinal);
    if (
      !catalog ||
      row.catalog_json !== expectedJson ||
      row.contract_catalog_json !== expectedJson ||
      row.catalog_version !== catalog.catalogVersion ||
      row.contract_catalog_version !== catalog.catalogVersion ||
      row.plan_reference !== catalog.catalogVersion ||
      row.currency !== 'CHF' ||
      row.price_chf_minor !== catalog.priceChfMinor ||
      row.starts_at !== dates.startSeconds ||
      row.ends_at !== dates.endSeconds ||
      !['TEST', 'PRODUCTION'].includes(row.environment) ||
      row.period_id !==
        `pfperiod_${await digest(`${row.contract_id}|${row.ordinal}`)}` ||
      row.expectation_fingerprint !==
        (await digest(JSON.stringify([row.period_id, ...values])))
    )
      throw new PrepaidPeriodError('conflict');
    const period: PrepaidPeriod = Object.freeze({
      periodId: row.period_id,
      contractId: row.contract_id,
      ordinal: row.ordinal,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      currency: 'CHF',
      priceChfMinor: row.price_chf_minor,
      catalogVersion: row.catalog_version,
      catalog,
    });
    return Object.freeze({
      ...value,
      apiOrigin,
      spaceId,
      environment: row.environment,
      ownerId: row.owner_id,
      organizationId: row.organization_id,
      workspaceId: row.workspace_id,
      transactionId,
      period,
    });
  }

  async isReversed(periodId: string) {
    return !!(await this.db
      .prepare('SELECT 1 FROM prepaid_effective_revocations WHERE period_id=?')
      .bind(periodId)
      .first());
  }

  async recordReversal(
    target: ReconciliationTarget,
    fingerprint: string,
    work: WebhookWork,
  ) {
    if (
      !/^[a-f0-9]{64}$/.test(fingerprint) ||
      !/^[0-9a-f-]{36}$/.test(work.lease) ||
      work.event.spaceId !== target.spaceId ||
      work.scopeHash !==
        (await digest(
          `${target.apiOrigin}|${target.spaceId}|${work.event.webhookListenerId}|${work.event.eventId}`,
        ))
    )
      throw new PrepaidPeriodError('invalid');
    // Even an idempotent negative fact must belong to this exact immutable
    // binding. A tombstone for periodId alone must not acknowledge a job whose
    // owner, transaction, catalogue or expected payer was changed by the caller.
    const current = await this.target(
      target.apiOrigin,
      target.spaceId,
      target.transactionId,
    );
    const binding = (value: ReconciliationTarget) =>
      JSON.stringify([
        value.apiOrigin,
        value.spaceId,
        value.environment,
        value.ownerId,
        value.organizationId,
        value.workspaceId,
        value.transactionId,
        value.customerReference,
        value.planReference,
        value.paymentMethodConfigurationId,
        value.connectorConfigurationId,
        value.period.periodId,
        value.period.contractId,
        value.period.ordinal,
        value.period.startsAt,
        value.period.endsAt,
        value.period.currency,
        value.period.priceChfMinor,
        value.period.catalogVersion,
        value.period.catalog,
      ]);
    if (!current || binding(current) !== binding(target))
      throw new PrepaidPeriodError('conflict');
    const now = this.clock();
    const result = await this.db
      .prepare(`INSERT INTO prepaid_provider_reversals(period_id,evidence_fingerprint,reversed_at)
      SELECT t.period_id,?,? FROM prepaid_transactions t JOIN prepaid_periods p ON p.period_id=t.period_id
      JOIN prepaid_contracts c ON c.contract_id=p.contract_id WHERE t.period_id=? AND t.transaction_id=?
      AND t.api_origin=? AND t.space_id=? AND c.environment=? AND c.owner_id=?
      AND c.organization_id IS ? AND c.workspace_id IS ? AND p.starts_at=? AND p.ends_at=?
      AND p.price_chf_minor=? AND p.catalog_version=?
      AND EXISTS(SELECT 1 FROM postfinance_webhook_inbox w WHERE w.scope_hash=?
        AND w.state='processing' AND w.lease=? AND w.lease_until>?) ON CONFLICT(period_id) DO NOTHING`)
      .bind(
        fingerprint,
        now,
        target.period.periodId,
        target.transactionId,
        target.apiOrigin,
        target.spaceId,
        target.environment,
        target.ownerId,
        target.organizationId,
        target.workspaceId,
        target.period.startsAt,
        target.period.endsAt,
        target.period.priceChfMinor,
        target.period.catalogVersion,
        work.scopeHash,
        work.lease,
        now,
      )
      .run();
    if (result.meta.changes !== 1) {
      const owned = await this.db
        .prepare(`SELECT 1 FROM postfinance_webhook_inbox
        WHERE scope_hash=? AND state='processing' AND lease=? AND lease_until>?`)
        .bind(work.scopeHash, work.lease, this.clock())
        .first();
      if (!owned || !(await this.isReversed(target.period.periodId)))
        throw new PrepaidPeriodError('conflict');
    }
  }

  async recordPaid(proof: SettlementRecord, work: WebhookWork) {
    await new D1PrepaidPeriods(this.db, this.clock).recordReconciledSettlement(
      proof,
      work,
    );
    return !(await this.isReversed(proof.periodId));
  }
}
