import { prepaidMonthlyPeriod } from './prepaid-calendar';
import { prepaidProduct, type PrepaidProduct } from './prepaid-catalog';
import type { WebhookWork } from './postfinance-store';

type StoreDatabase = Pick<D1Database, 'prepare'>;
export type PrepaidEnvironment = 'TEST' | 'PRODUCTION';
export type PrepaidContractInput = Readonly<{
  contractId: string;
  ownerId: string;
  organizationId: string | null;
  workspaceId: string | null;
  apiOrigin: string;
  spaceId: number;
  environment: PrepaidEnvironment;
  productKey: string;
}>;
type ContractRow = {
  contract_id: string;
  owner_id: string;
  organization_id: string | null;
  workspace_id: string | null;
  api_origin: string;
  space_id: number;
  environment: PrepaidEnvironment;
  product_key: string;
  catalog_version: string;
  catalog_json: string;
  anchor_start: number;
  fingerprint: string;
  cancelled_at: number | null;
  created_at: number;
};
export type PrepaidPeriod = Readonly<{
  periodId: string;
  contractId: string;
  ordinal: number;
  startsAt: number;
  endsAt: number;
  currency: 'CHF';
  priceChfMinor: number;
  catalogVersion: string;
  catalog: PrepaidProduct;
}>;
type PeriodRow = {
  period_id: string;
  contract_id: string;
  ordinal: number;
  starts_at: number;
  ends_at: number;
  currency: 'CHF';
  price_chf_minor: number;
  catalog_version: string;
  catalog_json: string;
};
export class PrepaidPeriodError extends Error {
  constructor(
    public readonly code:
      | 'invalid'
      | 'conflict'
      | 'unavailable'
      | 'cancelled'
      | 'not_due'
      | 'unpaid_previous',
  ) {
    super(`Prepaid period ${code}.`);
  }
}
const encoder = new TextEncoder();
function invalid(): never {
  throw new PrepaidPeriodError('invalid');
}
function localId(value: string) {
  if (
    !/^pfp_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      value,
    )
  )
    invalid();
}
function identity(value: string | null) {
  if (
    value !== null &&
    (typeof value !== 'string' ||
      !value ||
      value.length > 180 ||
      Array.from(value).some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ))
  )
    invalid();
}
function clockValue(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0) invalid();
  return value;
}
function positiveId(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0) invalid();
}
function evidence(value: string) {
  if (!/^[0-9a-f]{64}$/.test(value)) invalid();
}
async function digest(value: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', encoder.encode(value)),
    ),
  )
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
function period(row: PeriodRow): PrepaidPeriod {
  if (encoder.encode(row.catalog_json).length > 8192) invalid();
  const catalog = JSON.parse(row.catalog_json) as PrepaidProduct;
  if (
    catalog.currency !== 'CHF' ||
    catalog.billingPeriod !== 'P1M' ||
    catalog.catalogVersion !== row.catalog_version ||
    catalog.priceChfMinor !== row.price_chf_minor
  )
    invalid();
  Object.freeze(catalog.includedProducts);
  if (catalog.gestion) Object.freeze(catalog.gestion);
  if (catalog.support) Object.freeze(catalog.support);
  Object.freeze(catalog);
  return Object.freeze({
    periodId: row.period_id,
    contractId: row.contract_id,
    ordinal: row.ordinal,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    currency: row.currency,
    priceChfMinor: row.price_chf_minor,
    catalogVersion: row.catalog_version,
    catalog,
  });
}

/** Durable dates/catalogue binding for the future prepaid orchestrator.
 * It never calls a payment API or projects an entitlement into legacy tables.
 * Inputs must originate from the authenticated purchase controller, not a URL.
 */
export class D1PrepaidPeriods {
  constructor(
    private readonly db: StoreDatabase,
    private readonly clock = () => Math.floor(Date.now() / 1000),
  ) {}
  async createContract(input: PrepaidContractInput) {
    localId(input.contractId);
    identity(input.ownerId);
    identity(input.organizationId);
    identity(input.workspaceId);
    if (
      !input.ownerId ||
      !['TEST', 'PRODUCTION'].includes(input.environment) ||
      !['https://checkout.postfinance.ch', 'https://app-wallee.com'].includes(
        input.apiOrigin,
      )
    )
      invalid();
    positiveId(input.spaceId);
    const catalog = prepaidProduct(input.productKey);
    if (!catalog) invalid();
    if (
      (catalog.productKind === 'support' && !input.workspaceId) ||
      (catalog.productKind !== 'support' && !input.organizationId)
    )
      invalid();
    const catalogJson = JSON.stringify(catalog),
      now = clockValue(this.clock());
    const fingerprint = await digest(
      JSON.stringify([
        input.ownerId,
        input.organizationId,
        input.workspaceId,
        input.apiOrigin,
        input.spaceId,
        input.environment,
        input.productKey,
        catalogJson,
      ]),
    );
    await this.db
      .prepare(`INSERT INTO prepaid_contracts(contract_id,owner_id,organization_id,workspace_id,api_origin,space_id,environment,product_key,catalog_version,catalog_json,anchor_start,fingerprint,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(contract_id) DO NOTHING`)
      .bind(
        input.contractId,
        input.ownerId,
        input.organizationId,
        input.workspaceId,
        input.apiOrigin,
        input.spaceId,
        input.environment,
        input.productKey,
        catalog.catalogVersion,
        catalogJson,
        now,
        fingerprint,
        now,
      )
      .run();
    const row = await this.contract(input.contractId);
    if (!row || row.fingerprint !== fingerprint)
      throw new PrepaidPeriodError('conflict');
    return { contractId: row.contract_id, anchorStart: row.anchor_start };
  }
  private async contract(contractId: string) {
    localId(contractId);
    return this.db
      .prepare('SELECT * FROM prepaid_contracts WHERE contract_id=?')
      .bind(contractId)
      .first<ContractRow>();
  }
  async reservePeriod(
    contractId: string,
    ordinal: number,
  ): Promise<PrepaidPeriod> {
    const contract = await this.contract(contractId);
    if (!contract) throw new PrepaidPeriodError('unavailable');
    const dates = prepaidMonthlyPeriod(contract.anchor_start, ordinal),
      now = clockValue(this.clock());
    const id = `pfperiod_${await digest(`${contractId}|${ordinal}`)}`;
    // A completed reservation is stable even after cancellation. It is not permission to charge.
    const existing = await this.db
      .prepare(
        'SELECT * FROM prepaid_periods WHERE contract_id=? AND ordinal=?',
      )
      .bind(contractId, ordinal)
      .first<PeriodRow>();
    if (existing) return period(existing);
    if (contract.cancelled_at !== null)
      throw new PrepaidPeriodError('cancelled');
    if (dates.startSeconds > now || dates.endSeconds <= now)
      throw new PrepaidPeriodError('not_due');
    const catalog = JSON.parse(contract.catalog_json) as PrepaidProduct;
    const result = await this.db
      .prepare(`INSERT INTO prepaid_periods(period_id,contract_id,ordinal,starts_at,ends_at,currency,price_chf_minor,catalog_version,catalog_json,created_at)
      SELECT ?,c.contract_id,?,?,?,'CHF',?,c.catalog_version,c.catalog_json,? FROM prepaid_contracts c
      WHERE c.contract_id=? AND c.cancelled_at IS NULL AND (?=0 OR EXISTS(
        SELECT 1 FROM prepaid_periods p JOIN prepaid_settlement_proofs s ON s.period_id=p.period_id
        WHERE p.contract_id=c.contract_id AND p.ordinal=? AND p.ends_at=?
        AND NOT EXISTS(SELECT 1 FROM prepaid_effective_revocations r WHERE r.period_id=p.period_id)))
      ON CONFLICT(contract_id,ordinal) DO NOTHING`)
      .bind(
        id,
        ordinal,
        dates.startSeconds,
        dates.endSeconds,
        catalog.priceChfMinor,
        now,
        contractId,
        ordinal,
        ordinal - 1,
        dates.startSeconds,
      )
      .run();
    const row = await this.db
      .prepare(
        'SELECT * FROM prepaid_periods WHERE contract_id=? AND ordinal=?',
      )
      .bind(contractId, ordinal)
      .first<PeriodRow>();
    if (row) return period(row);
    if ((await this.contract(contractId))?.cancelled_at !== null)
      throw new PrepaidPeriodError('cancelled');
    if (!result.success && result.error)
      throw new PrepaidPeriodError('unavailable');
    throw new PrepaidPeriodError('unpaid_previous');
  }
  async bindTransaction(periodId: string, transactionId: number) {
    positiveId(transactionId);
    await this.db
      .prepare(`INSERT INTO prepaid_transactions(period_id,api_origin,space_id,transaction_id,created_at)
      SELECT p.period_id,c.api_origin,c.space_id,?,? FROM prepaid_periods p JOIN prepaid_contracts c ON c.contract_id=p.contract_id
      WHERE p.period_id=? ON CONFLICT DO NOTHING`)
      .bind(transactionId, clockValue(this.clock()), periodId)
      .run();
    const row = await this.db
      .prepare(
        'SELECT transaction_id FROM prepaid_transactions WHERE period_id=?',
      )
      .bind(periodId)
      .first<{ transaction_id: number }>();
    if (!row || row.transaction_id !== transactionId)
      throw new PrepaidPeriodError('conflict');
  }
  /** A persistence sink, not a settlement verifier. The private reconciler must
   * freshly verify the provider transaction/invoice, owner, environment, amount,
   * references and refunds before calling this method with its current work lease.
   * No customer purchase route calls this sink.
   */
  async recordReconciledSettlement(
    input: {
      periodId: string;
      transactionId: number;
      invoiceId: number;
      apiOrigin: string;
      spaceId: number;
      environment: PrepaidEnvironment;
      ownerId: string;
      organizationId: string | null;
      workspaceId: string | null;
      startsAt: number;
      endsAt: number;
      currency: 'CHF';
      priceChfMinor: number;
      catalogVersion: string;
      evidenceFingerprint: string;
    },
    work?: WebhookWork,
  ) {
    positiveId(input.transactionId);
    positiveId(input.invoiceId);
    positiveId(input.spaceId);
    evidence(input.evidenceFingerprint);
    const now = clockValue(this.clock());
    if (
      work &&
      (work.event.spaceId !== input.spaceId ||
        !/^[0-9a-f-]{36}$/.test(work.lease) ||
        work.scopeHash !==
          (await digest(
            `${input.apiOrigin}|${input.spaceId}|${work.event.webhookListenerId}|${work.event.eventId}`,
          )))
    )
      throw new PrepaidPeriodError('conflict');
    await this.db
      .prepare(`INSERT INTO prepaid_settlement_proofs(period_id,invoice_id,evidence_fingerprint,reconciled_at)
      SELECT p.period_id,?,?,? FROM prepaid_periods p
      JOIN prepaid_contracts c ON c.contract_id=p.contract_id JOIN prepaid_transactions t ON t.period_id=p.period_id
      WHERE p.period_id=? AND t.transaction_id=? AND t.api_origin=? AND t.space_id=? AND c.environment=?
      AND c.owner_id=? AND c.organization_id IS ? AND c.workspace_id IS ?
      AND p.starts_at=? AND p.ends_at=? AND p.currency=? AND p.price_chf_minor=? AND p.catalog_version=?
      AND NOT EXISTS(SELECT 1 FROM prepaid_effective_revocations r WHERE r.period_id=p.period_id)
      AND (? IS NULL OR EXISTS(SELECT 1 FROM postfinance_webhook_inbox w WHERE w.scope_hash=?
        AND w.state='processing' AND w.lease=? AND w.lease_until>?))
      ON CONFLICT(period_id) DO NOTHING`)
      .bind(
        input.invoiceId,
        input.evidenceFingerprint,
        now,
        input.periodId,
        input.transactionId,
        input.apiOrigin,
        input.spaceId,
        input.environment,
        input.ownerId,
        input.organizationId,
        input.workspaceId,
        input.startsAt,
        input.endsAt,
        input.currency,
        input.priceChfMinor,
        input.catalogVersion,
        work?.scopeHash ?? null,
        work?.scopeHash ?? null,
        work?.lease ?? null,
        now,
      )
      .run();
    const stored = await this.db
      .prepare(`SELECT s.invoice_id,s.evidence_fingerprint FROM prepaid_settlement_proofs s
      JOIN prepaid_periods p ON p.period_id=s.period_id JOIN prepaid_contracts c ON c.contract_id=p.contract_id
      JOIN prepaid_transactions t ON t.period_id=p.period_id
      WHERE p.period_id=? AND t.transaction_id=? AND t.api_origin=? AND t.space_id=? AND c.environment=?
      AND c.owner_id=? AND c.organization_id IS ? AND c.workspace_id IS ?
      AND p.starts_at=? AND p.ends_at=? AND p.currency=? AND p.price_chf_minor=? AND p.catalog_version=?`)
      .bind(
        input.periodId,
        input.transactionId,
        input.apiOrigin,
        input.spaceId,
        input.environment,
        input.ownerId,
        input.organizationId,
        input.workspaceId,
        input.startsAt,
        input.endsAt,
        input.currency,
        input.priceChfMinor,
        input.catalogVersion,
      )
      .first<{ invoice_id: number; evidence_fingerprint: string }>();
    if (
      !stored ||
      stored.invoice_id !== input.invoiceId ||
      stored.evidence_fingerprint !== input.evidenceFingerprint
    )
      throw new PrepaidPeriodError('conflict');
    if (
      work &&
      !(await this.db
        .prepare(`SELECT 1 FROM postfinance_webhook_inbox
      WHERE scope_hash=? AND state='processing' AND lease=? AND lease_until>?`)
        .bind(work.scopeHash, work.lease, clockValue(this.clock()))
        .first())
    )
      throw new PrepaidPeriodError('conflict');
  }
  /** Stop scheduling, preserving coverage already paid. This is not a provider refund. */
  async cancelRenewal(contractId: string) {
    localId(contractId);
    await this.db
      .prepare(
        'UPDATE prepaid_contracts SET cancelled_at=? WHERE contract_id=? AND cancelled_at IS NULL',
      )
      .bind(clockValue(this.clock()), contractId)
      .run();
    const row = await this.contract(contractId);
    if (!row || row.cancelled_at === null)
      throw new PrepaidPeriodError('unavailable');
    return row.cancelled_at;
  }
  async revokeReconciledPeriod(periodId: string, evidenceFingerprint: string) {
    evidence(evidenceFingerprint);
    await this.db
      .prepare(`INSERT INTO prepaid_period_revocations(period_id,evidence_fingerprint,revoked_at)
      SELECT period_id,?,? FROM prepaid_settlement_proofs WHERE period_id=? ON CONFLICT(period_id) DO NOTHING`)
      .bind(evidenceFingerprint, clockValue(this.clock()), periodId)
      .run();
    if (
      !(await this.db
        .prepare('SELECT 1 FROM prepaid_period_revocations WHERE period_id=?')
        .bind(periodId)
        .first())
    )
      throw new PrepaidPeriodError('unavailable');
  }
  async paidCoverage(
    input: Pick<
      PrepaidContractInput,
      | 'contractId'
      | 'ownerId'
      | 'organizationId'
      | 'workspaceId'
      | 'environment'
    >,
  ) {
    localId(input.contractId);
    const now = clockValue(this.clock());
    const row = await this.db
      .prepare(`SELECT p.* FROM prepaid_periods p JOIN prepaid_contracts c ON c.contract_id=p.contract_id
      JOIN prepaid_settlement_proofs s ON s.period_id=p.period_id WHERE c.contract_id=? AND c.owner_id=?
      AND c.organization_id IS ? AND c.workspace_id IS ? AND c.environment=? AND p.starts_at<=? AND p.ends_at>?
      AND NOT EXISTS(SELECT 1 FROM prepaid_effective_revocations r WHERE r.period_id=p.period_id)
      ORDER BY p.ordinal DESC LIMIT 1`)
      .bind(
        input.contractId,
        input.ownerId,
        input.organizationId,
        input.workspaceId,
        input.environment,
        now,
        now,
      )
      .first<PeriodRow>();
    return row ? period(row) : null;
  }
}
