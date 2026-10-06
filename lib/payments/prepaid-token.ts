import type {
  PostFinanceCheckoutClient,
  SwissMethod,
} from './postfinance-client';
import { D1PrepaidReconciliationStore } from './prepaid-reconciliation-store';
import type { WebhookWork } from './postfinance-store';

/** Exact fields: official pfpayments/typescript-sdk, commit
 * bb1e4c34ffa44bc1da8f54c86f984961aa886c30, Token/TokenVersion/Transaction.
 * Transaction.token identifies Token; TokenVersion.token identifies the same
 * Token. Neither model has an owner or an originating transaction field.
 * TokenVersion.environment is TEST/PRODUCTION, not transaction LIVE/PREVIEW.
 * https://checkout.postfinance.ch/en-us/doc/payment/tokenization
 */
export type ExpectedPrepaidTokenBinding = Readonly<{
  contractId: string;
  ownerId: string;
  organizationId: string | null;
  workspaceId: string | null;
  apiOrigin: string;
  spaceId: number;
  environment: 'PRODUCTION' | 'TEST';
  initialPeriodId: string;
  initialTransactionId: number;
  initialInvoiceId: number;
  settlementFingerprint: string;
  customerReference: string;
  method: SwissMethod;
  paymentMethodConfigurationId: number;
  connectorConfigurationId: number;
  catalogVersion: string;
  priceChfMinor: number;
  /** Present for renewals: do not silently adopt a different active version. */
  tokenId?: number;
  tokenVersionId?: number;
  paymentMethodId?: number;
  tokenObjectVersion?: number;
  tokenVersionObjectVersion?: number;
}>;
export type PrepaidTokenEvidence = Readonly<{
  apiOrigin: string;
  spaceId: number;
  environment: 'PRODUCTION' | 'TEST';
  observedAt: number;
  transaction: unknown;
  token: unknown;
  activeVersion: unknown;
}>;
export type VerifiedPrepaidTokenBinding = Readonly<
  ExpectedPrepaidTokenBinding & {
    tokenId: number;
    tokenVersionId: number;
    paymentMethodId: number;
    tokenObjectVersion: number;
    tokenVersionObjectVersion: number;
    observedAt: number;
  }
>;
export type StoredPrepaidTokenBinding = Readonly<
  VerifiedPrepaidTokenBinding & {
    evidenceFingerprint: string;
    createdAt: number;
  }
>;
export class PrepaidTokenError extends Error {
  constructor(
    readonly code: 'binding' | 'unavailable' | 'unstable' | 'conflict',
  ) {
    super(`Prepaid token ${code}.`);
  }
}
type Json = Record<string, unknown>;
type Database = Pick<D1Database, 'prepare'>;
export type PrepaidTokenReadClient = Pick<
  PostFinanceCheckoutClient,
  'readScope' | 'readTransaction' | 'readToken' | 'readActiveTokenVersion'
>;
function object(value: unknown): Json | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : null;
}
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function version(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function identity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 180 &&
    !Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  );
}
function reject(code: PrepaidTokenError['code']): never {
  throw new PrepaidTokenError(code);
}
function validExpected(e: ExpectedPrepaidTokenBinding): boolean {
  return (
    /^pfp_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      e.contractId,
    ) &&
    identity(e.ownerId) &&
    (e.organizationId === null || identity(e.organizationId)) &&
    (e.workspaceId === null || identity(e.workspaceId)) &&
    (e.organizationId !== null || e.workspaceId !== null) &&
    ['https://checkout.postfinance.ch', 'https://app-wallee.com'].includes(
      e.apiOrigin,
    ) &&
    positive(e.spaceId) &&
    ['PRODUCTION', 'TEST'].includes(e.environment) &&
    /^pfperiod_[a-f0-9]{64}$/.test(e.initialPeriodId) &&
    positive(e.initialTransactionId) &&
    positive(e.initialInvoiceId) &&
    /^[a-f0-9]{64}$/.test(e.settlementFingerprint) &&
    /^[A-Za-z0-9_-]{1,120}$/.test(e.customerReference) &&
    ['postfinance_pay', 'twint'].includes(e.method) &&
    positive(e.paymentMethodConfigurationId) &&
    positive(e.connectorConfigurationId) &&
    identity(e.catalogVersion) &&
    positive(e.priceChfMinor) &&
    [e.tokenId, e.tokenVersionId, e.paymentMethodId].every(
      (x) => x === undefined || positive(x),
    ) &&
    [e.tokenObjectVersion, e.tokenVersionObjectVersion].every(
      (x) => x === undefined || version(x),
    )
  );
}
function validOptionalDate(
  value: unknown,
  now: number,
  future: boolean,
): boolean {
  if (value === undefined || value === null) return true;
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  )
    return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    (future ? milliseconds > now * 1000 : milliseconds <= now * 1000)
  );
}
function connector(
  value: unknown,
  e: ExpectedPrepaidTokenBinding,
): number | null {
  const c = object(value),
    m = c && object(c.paymentMethodConfiguration),
    p = m && object(m.paymentMethod);
  return c?.id === e.connectorConfigurationId &&
    c.linkedSpaceId === e.spaceId &&
    c.state === 'ACTIVE' &&
    c.applicableForTransactionProcessing !== false &&
    m?.id === e.paymentMethodConfigurationId &&
    m.linkedSpaceId === e.spaceId &&
    m.state === 'ACTIVE' &&
    positive(p?.id)
    ? p.id
    : null;
}
/** Pure validation; a usable token never creates a paid entitlement. A caller
 * must separately prove and persist initial settlement before binding it. */
export function verifyPrepaidTokenBinding(
  e: ExpectedPrepaidTokenBinding,
  evidence: PrepaidTokenEvidence,
  now: number,
): VerifiedPrepaidTokenBinding {
  if (
    !validExpected(e) ||
    !positive(now) ||
    !positive(evidence.observedAt) ||
    evidence.observedAt > now ||
    now - evidence.observedAt > 60 ||
    evidence.apiOrigin !== e.apiOrigin ||
    evidence.spaceId !== e.spaceId ||
    evidence.environment !== e.environment
  )
    reject('binding');
  const tx = object(evidence.transaction),
    t = object(evidence.token),
    v = object(evidence.activeVersion);
  const transactionToken = tx && object(tx.token),
    versionToken = v && object(v.token),
    method = v && object(v.paymentMethod);
  const metadata = tx && object(tx.metaData);
  if (
    !tx ||
    !t ||
    !v ||
    tx.id !== e.initialTransactionId ||
    tx.linkedSpaceId !== e.spaceId ||
    !version(tx.version) ||
    tx.state !== 'FULFILL' ||
    tx.environment !== (e.environment === 'PRODUCTION' ? 'LIVE' : 'PREVIEW') ||
    tx.authorizationEnvironment !== e.environment ||
    tx.currency !== 'CHF' ||
    tx.totalSettledAmount !== e.priceChfMinor / 100 ||
    tx.refundedAmount !== 0 ||
    tx.customerId !== e.customerReference ||
    tx.merchantReference !== e.initialPeriodId ||
    metadata?.zentra_period_id !== e.initialPeriodId ||
    metadata.zentra_plan_version !== e.catalogVersion ||
    tx.tokenizationMode !== 'FORCE_CREATION' ||
    tx.customersPresence !== 'VIRTUAL_PRESENT'
  )
    reject('binding');
  if (
    !positive(t.id) ||
    transactionToken?.id !== t.id ||
    (transactionToken.linkedSpaceId !== undefined &&
      transactionToken.linkedSpaceId !== e.spaceId) ||
    (transactionToken.customerId !== undefined &&
      transactionToken.customerId !== e.customerReference) ||
    t.linkedSpaceId !== e.spaceId ||
    !version(t.version) ||
    t.state !== 'ACTIVE' ||
    t.customerId !== e.customerReference ||
    !validOptionalDate(t.plannedPurgeDate, now, true) ||
    (e.tokenId !== undefined && t.id !== e.tokenId) ||
    (e.tokenObjectVersion !== undefined && t.version !== e.tokenObjectVersion)
  )
    reject('binding');
  if (
    !positive(v.id) ||
    !version(v.version) ||
    v.state !== 'ACTIVE' ||
    v.linkedSpaceId !== e.spaceId ||
    v.environment !== e.environment ||
    versionToken?.id !== t.id ||
    (versionToken.linkedSpaceId !== undefined &&
      versionToken.linkedSpaceId !== e.spaceId) ||
    (versionToken.customerId !== undefined &&
      versionToken.customerId !== e.customerReference) ||
    (versionToken.state !== undefined && versionToken.state !== 'ACTIVE') ||
    (versionToken.version !== undefined &&
      versionToken.version !== t.version) ||
    (v.obsoletedOn !== undefined && v.obsoletedOn !== null) ||
    !validOptionalDate(v.expiresOn, now, true) ||
    !validOptionalDate(v.plannedPurgeDate, now, true) ||
    !validOptionalDate(v.activatedOn, now, false) ||
    // All processor retry advice needs explicit handling in a future policy;
    // NO_RETRY is a prohibition, not a successful mandate confirmation.
    (v.retryStrategy !== undefined && v.retryStrategy !== null) ||
    (e.tokenVersionId !== undefined && v.id !== e.tokenVersionId) ||
    (e.tokenVersionObjectVersion !== undefined &&
      v.version !== e.tokenVersionObjectVersion)
  )
    reject('binding');
  const methodId = connector(tx.paymentConnectorConfiguration, e),
    versionMethodId = connector(v.paymentConnectorConfiguration, e);
  if (
    !positive(methodId) ||
    versionMethodId !== methodId ||
    method?.id !== methodId ||
    (e.paymentMethodId !== undefined && methodId !== e.paymentMethodId)
  )
    reject('binding');
  return Object.freeze({
    ...e,
    tokenId: t.id,
    tokenVersionId: v.id,
    paymentMethodId: methodId,
    tokenObjectVersion: t.version,
    tokenVersionObjectVersion: v.version,
    observedAt: evidence.observedAt,
  });
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const obj = object(value);
  if (obj)
    return (
      '{' +
      Object.keys(obj)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical(obj[k]))
        .join(',') +
      '}'
    );
  const json = JSON.stringify(value);
  if (json === undefined) reject('binding');
  return json;
}
async function digest(value: unknown): Promise<string> {
  return digestText(canonical(value));
}
async function digestText(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  );
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
/** Exactly six bounded GETs through the existing client. The server owns its
 * connection and expected context. Missing unexpanded fields fail closed.
 * Stable observations do not lock a remotely revocable token. */
export async function verifyFreshTokenBinding(
  client: PrepaidTokenReadClient,
  expected: ExpectedPrepaidTokenBinding,
  now = Math.floor(Date.now() / 1000),
  clock = () => Math.floor(Date.now() / 1000),
): Promise<VerifiedPrepaidTokenBinding> {
  if (!validExpected(expected) || !positive(now)) reject('binding');
  const scope = client.readScope();
  if (
    scope.apiOrigin !== expected.apiOrigin ||
    scope.spaceId !== expected.spaceId
  )
    reject('binding');
  async function read(): Promise<PrepaidTokenEvidence> {
    const transaction = await client.readTransaction(
      expected.initialTransactionId,
    );
    const tokenId = object(transaction.token)?.id;
    if (
      !positive(tokenId) ||
      (expected.tokenId !== undefined && tokenId !== expected.tokenId)
    )
      reject('binding');
    const token = await client.readToken(tokenId);
    const activeVersion = await client.readActiveTokenVersion(tokenId);
    return {
      apiOrigin: expected.apiOrigin,
      spaceId: expected.spaceId,
      environment: expected.environment,
      observedAt: now,
      transaction,
      token,
      activeVersion,
    };
  }
  const first = await read();
  verifyPrepaidTokenBinding(expected, first, now);
  const second = await read();
  const finishedAt = clock();
  if (!positive(finishedAt) || finishedAt < now || finishedAt - now > 60)
    reject('unstable');
  const binding = verifyPrepaidTokenBinding(expected, second, finishedAt);
  // Also compare provider transaction/version facts; a refund/version change
  // between the reads cannot be hidden by a stable token ID.
  if (
    canonical([first.transaction, first.token, first.activeVersion]) !==
    canonical([second.transaction, second.token, second.activeVersion])
  )
    reject('unstable');
  return binding;
}

const SAFE_INITIAL = `FROM prepaid_contracts c JOIN prepaid_periods p ON p.contract_id=c.contract_id AND p.ordinal=0
  JOIN prepaid_transactions tx ON tx.period_id=p.period_id AND tx.api_origin=c.api_origin AND tx.space_id=c.space_id
  JOIN prepaid_settlement_proofs proof ON proof.period_id=p.period_id
  JOIN prepaid_payment_expectations e ON e.period_id=p.period_id
  WHERE c.contract_id=? AND c.cancelled_at IS NULL
  AND NOT EXISTS(SELECT 1 FROM prepaid_effective_revocations r WHERE r.period_id=p.period_id)
  AND NOT EXISTS(SELECT 1 FROM account_session_policy a WHERE a.user_id=c.owner_id AND a.deleted_at IS NOT NULL)
  AND (c.organization_id IS NULL OR EXISTS(SELECT 1 FROM organizations o JOIN organization_members m ON m.organization_id=o.organization_id
    WHERE o.organization_id=c.organization_id AND o.created_by_user_id=c.owner_id AND m.user_id=c.owner_id AND m.role='owner' AND m.revoked_at IS NULL
    AND (c.product_key NOT LIKE 'gestion:%' AND c.product_key NOT LIKE 'complet:%' OR o.subscription_id=c.contract_id)))
  AND (c.workspace_id IS NULL OR EXISTS(SELECT 1 FROM support_workspaces w WHERE w.id=c.workspace_id AND w.owner_id=c.owner_id))
  AND (c.organization_id IS NULL OR c.workspace_id IS NULL OR EXISTS(SELECT 1 FROM support_gestion_links l WHERE l.organization_id=c.organization_id AND l.workspace_id=c.workspace_id))
  AND (NOT EXISTS(SELECT 1 FROM prepaid_purchase_targets target WHERE target.contract_id=c.contract_id)
    OR EXISTS(SELECT 1 FROM prepaid_purchase_targets target
      JOIN purchase_intents i ON i.intent_id=target.intent_id
      JOIN prepaid_purchase_projections x ON x.intent_id=target.intent_id AND x.contract_id=target.contract_id AND x.period_id=p.period_id
      WHERE target.contract_id=c.contract_id AND target.owner_id=c.owner_id AND target.organization_id IS c.organization_id AND target.workspace_id IS c.workspace_id
      AND x.owner_id=c.owner_id AND x.organization_id IS c.organization_id AND x.workspace_id IS c.workspace_id
      AND x.closed_at IS NOT NULL AND x.evidence_fingerprint=proof.evidence_fingerprint
      AND i.state='settled' AND i.provider='postfinance' AND i.provider_scope=(c.api_origin||'|'||c.space_id)
      AND i.environment=c.environment AND i.owner_id=c.owner_id AND i.organization_id IS c.organization_id AND i.workspace_id IS c.workspace_id
      AND json_extract(i.parameters,'$.method')=? AND json_extract(i.parameters,'$.methodConfigurationId')=e.payment_method_configuration_id
      AND json_extract(i.parameters,'$.connectorConfigurationId')=e.connector_configuration_id
      AND json_extract(i.parameters,'$.productKey')=c.product_key AND json_extract(i.parameters,'$.catalogVersion')=p.catalog_version
      AND json_extract(i.parameters,'$.priceChfMinor')=p.price_chf_minor))`;
type InitialRow = {
  transaction_id: number;
  invoice_id: number;
  evidence_fingerprint: string;
  period_id: string;
  reconciled_at: number;
};
type TokenRow = {
  contract_id: string;
  initial_period_id: string;
  initial_transaction_id: number;
  initial_invoice_id: number;
  settlement_fingerprint: string;
  owner_id: string;
  organization_id: string | null;
  workspace_id: string | null;
  api_origin: string;
  space_id: number;
  environment: 'PRODUCTION' | 'TEST';
  customer_reference: string;
  method: SwissMethod;
  payment_method_configuration_id: number;
  connector_configuration_id: number;
  payment_method_id: number;
  token_id: number;
  token_version_id: number;
  token_object_version: number;
  token_version_object_version: number;
  evidence_fingerprint: string;
  observed_at: number;
  created_at: number;
};
const columns = [
  'contract_id',
  'initial_period_id',
  'initial_transaction_id',
  'initial_invoice_id',
  'settlement_fingerprint',
  'owner_id',
  'organization_id',
  'workspace_id',
  'api_origin',
  'space_id',
  'environment',
  'customer_reference',
  'method',
  'payment_method_configuration_id',
  'connector_configuration_id',
  'payment_method_id',
  'token_id',
  'token_version_id',
  'token_object_version',
  'token_version_object_version',
  'evidence_fingerprint',
  'observed_at',
  'created_at',
] as const;
function persistedValues(b: VerifiedPrepaidTokenBinding) {
  return [
    b.contractId,
    b.initialPeriodId,
    b.initialTransactionId,
    b.initialInvoiceId,
    b.settlementFingerprint,
    b.ownerId,
    b.organizationId,
    b.workspaceId,
    b.apiOrigin,
    b.spaceId,
    b.environment,
    b.customerReference,
    b.method,
    b.paymentMethodConfigurationId,
    b.connectorConfigurationId,
    b.paymentMethodId,
    b.tokenId,
    b.tokenVersionId,
    b.tokenObjectVersion,
    b.tokenVersionObjectVersion,
  ] as const;
}
/** Admission is rechecked in the INSERT statement itself. Only a verified
 * initial paid period can bind a token; no projections or entitlements change.
 * Renewal eligibility/previous period/dispatch fencing belong to its worker. */
export class D1PrepaidTokens {
  constructor(
    private db: Database,
    private clock = () => Math.floor(Date.now() / 1000),
  ) {}
  private async requireWork(
    expected: ExpectedPrepaidTokenBinding,
    work: WebhookWork,
    now: number,
  ): Promise<string> {
    if (
      !validExpected(expected) ||
      !positive(now) ||
      !/^[a-f0-9]{64}$/.test(work.scopeHash) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        work.lease,
      ) ||
      work.event.spaceId !== expected.spaceId ||
      !positive(work.event.webhookListenerId) ||
      !positive(work.event.eventId) ||
      work.scopeHash !==
        (await digestText(
          `${expected.apiOrigin}|${expected.spaceId}|${work.event.webhookListenerId}|${work.event.eventId}`,
        ))
    )
      reject('binding');
    const row = await this.db
      .prepare(`SELECT event_json FROM postfinance_webhook_inbox
      WHERE scope_hash=? AND state='processing' AND lease=? AND lease_until>?`)
      .bind(work.scopeHash, work.lease, now)
      .first<{ event_json: string }>();
    if (!row || new TextEncoder().encode(row.event_json).length > 65536)
      reject('unavailable');
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.event_json);
    } catch {
      reject('binding');
    }
    if (canonical(parsed) !== canonical(work.event)) reject('binding');
    return row.event_json;
  }
  async initialContext(
    contractId: string,
    method: SwissMethod,
  ): Promise<ExpectedPrepaidTokenBinding | null> {
    if (
      !/^pfp_[0-9a-f-]{36}$/.test(contractId) ||
      !['postfinance_pay', 'twint'].includes(method)
    )
      reject('binding');
    const row = await this.db
      .prepare(
        `SELECT tx.transaction_id,proof.invoice_id,proof.evidence_fingerprint,p.period_id,proof.reconciled_at ${SAFE_INITIAL}`,
      )
      .bind(contractId, method)
      .first<InitialRow>();
    if (
      !row ||
      !positive(row.reconciled_at) ||
      row.reconciled_at > this.clock()
    )
      return null;
    const scope = await this.db
      .prepare(
        'SELECT api_origin,space_id FROM prepaid_contracts WHERE contract_id=?',
      )
      .bind(contractId)
      .first<{ api_origin: string; space_id: number }>();
    if (!scope) return null;
    const target = await new D1PrepaidReconciliationStore(
      this.db,
      this.clock,
    ).target(scope.api_origin, scope.space_id, row.transaction_id);
    if (
      !target ||
      target.period.contractId !== contractId ||
      target.period.ordinal !== 0 ||
      target.period.periodId !== row.period_id
    )
      reject('conflict');
    const e: ExpectedPrepaidTokenBinding = {
      contractId,
      ownerId: target.ownerId,
      organizationId: target.organizationId,
      workspaceId: target.workspaceId,
      apiOrigin: target.apiOrigin,
      spaceId: target.spaceId,
      environment: target.environment,
      initialPeriodId: row.period_id,
      initialTransactionId: row.transaction_id,
      initialInvoiceId: row.invoice_id,
      settlementFingerprint: row.evidence_fingerprint,
      customerReference: target.customerReference,
      method,
      paymentMethodConfigurationId: target.paymentMethodConfigurationId,
      connectorConfigurationId: target.connectorConfigurationId,
      catalogVersion: target.period.catalogVersion,
      priceChfMinor: target.period.priceChfMinor,
    };
    if (!validExpected(e)) reject('binding');
    return Object.freeze(e);
  }
  async load(contractId: string): Promise<StoredPrepaidTokenBinding | null> {
    const row = await this.db
      .prepare('SELECT * FROM prepaid_tokens WHERE contract_id=?')
      .bind(contractId)
      .first<TokenRow>();
    if (!row) return null;
    const expected = await this.initialContext(contractId, row.method);
    if (!expected) return null;
    const b: VerifiedPrepaidTokenBinding = {
      ...expected,
      tokenId: row.token_id,
      tokenVersionId: row.token_version_id,
      paymentMethodId: row.payment_method_id,
      tokenObjectVersion: row.token_object_version,
      tokenVersionObjectVersion: row.token_version_object_version,
      observedAt: row.observed_at,
    };
    if (
      !validExpected(b) ||
      !positive(row.observed_at) ||
      !positive(row.created_at) ||
      row.created_at < row.observed_at ||
      row.created_at > this.clock() ||
      canonical(persistedValues(b)) !==
        canonical(columns.slice(0, 20).map((k) => row[k])) ||
      row.evidence_fingerprint !== (await digest(persistedValues(b)))
    )
      reject('conflict');
    return Object.freeze({
      ...b,
      evidenceFingerprint: row.evidence_fingerprint,
      createdAt: row.created_at,
    });
  }
  async bindInitial(
    client: PrepaidTokenReadClient,
    expected: ExpectedPrepaidTokenBinding,
    work?: WebhookWork,
  ): Promise<StoredPrepaidTokenBinding> {
    const started = this.clock();
    const eventJson = work
      ? await this.requireWork(expected, work, started)
      : null;
    const b = await verifyFreshTokenBinding(
        client,
        expected,
        started,
        this.clock,
      ),
      now = this.clock();
    const current = await this.initialContext(b.contractId, b.method);
    if (
      !current ||
      canonical(current) !==
        canonical(
          Object.fromEntries(
            Object.keys(current).map((k) => [
              k,
              b[k as keyof VerifiedPrepaidTokenBinding],
            ]),
          ),
        )
    )
      reject('conflict');
    const values = persistedValues(b),
      fingerprint = await digest(values);
    await this.db
      .prepare(`INSERT INTO prepaid_tokens (${columns.join(',')}) SELECT ${columns.map(() => '?').join(',')}
      ${SAFE_INITIAL} AND c.owner_id=? AND c.organization_id IS ? AND c.workspace_id IS ? AND c.api_origin=? AND c.space_id=? AND c.environment=?
      AND p.period_id=? AND tx.transaction_id=? AND proof.invoice_id=? AND proof.evidence_fingerprint=?
      AND e.customer_reference=? AND e.payment_method_configuration_id=? AND e.connector_configuration_id=?
      AND e.plan_reference=? AND p.price_chf_minor=? AND proof.reconciled_at<=?
      AND NOT EXISTS(SELECT 1 FROM prepaid_tokens other WHERE other.api_origin=c.api_origin AND other.space_id=c.space_id AND other.environment=c.environment AND other.token_id=? AND other.owner_id<>c.owner_id)
      AND (? IS NULL OR EXISTS(SELECT 1 FROM postfinance_webhook_inbox w WHERE w.scope_hash=?
        AND w.state='processing' AND w.lease=? AND w.lease_until>? AND w.event_json=?))
      ON CONFLICT(contract_id) DO NOTHING`)
      .bind(
        ...values,
        fingerprint,
        b.observedAt,
        now,
        b.contractId,
        b.method,
        b.ownerId,
        b.organizationId,
        b.workspaceId,
        b.apiOrigin,
        b.spaceId,
        b.environment,
        b.initialPeriodId,
        b.initialTransactionId,
        b.initialInvoiceId,
        b.settlementFingerprint,
        b.customerReference,
        b.paymentMethodConfigurationId,
        b.connectorConfigurationId,
        b.catalogVersion,
        b.priceChfMinor,
        now,
        b.tokenId,
        work?.scopeHash ?? null,
        work?.scopeHash ?? null,
        work?.lease ?? null,
        now,
        eventJson,
      )
      .run();
    const stored = await this.load(b.contractId);
    if (!stored || stored.evidenceFingerprint !== fingerprint)
      reject('conflict');
    if (work) await this.requireWork(expected, work, this.clock());
    return stored;
  }
}
