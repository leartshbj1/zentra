import {
  PostFinanceCheckoutClient,
  type JsonObject,
} from './postfinance-client';
import {
  D1PostFinanceMutationLedger,
  type PrepaidMutationFence,
} from './postfinance-store';
import { D1PrepaidPeriods } from './prepaid-periods';
import {
  D1PrepaidReconciliationStore,
  type ReconciliationTarget,
} from './prepaid-reconciliation-store';
import {
  D1PrepaidTokens,
  PrepaidTokenError,
  verifyFreshTokenBinding,
} from './prepaid-token';
import type { MandateFailureCode } from './prepaid-renewal-admission';
import { prepaidProduct } from './prepaid-catalog';
import type { PrepaidPurchaseConfiguration } from './prepaid-purchase-preparation';

type Database = Pick<D1Database, 'prepare' | 'batch'>;
export class PrepaidRenewalError extends Error {
  constructor(readonly code: 'configuration' | 'binding' | 'provider-binding') {
    super(`Prepaid renewal ${code}.`);
  }
}
/** The only recoverable scheduling failure: no new merchant operation has
 * been started by this call. Existing immutable financial receipts stay intact. */
export class PrepaidMandateAdmissionError extends Error {
  constructor(readonly code: MandateFailureCode) {
    super(`Prepaid mandate ${code}.`);
  }
}
export type PrepaidRenewalResult = Readonly<{
  state: 'disabled' | 'submitted' | 'uncertain';
  periodId?: string;
  transactionId?: number;
}>;
const object = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  const o = object(v);
  if (o)
    return (
      '{' +
      Object.keys(o)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical(o[k]))
        .join(',') +
      '}'
    );
  const s = JSON.stringify(v);
  if (s === undefined) throw new PrepaidRenewalError('binding');
  return s;
}
async function digest(s: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)),
    ),
  )
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
const positive = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

/** Validates an order only. Processing/fulfilment does not extend paid access;
 * the independent invoice/refund reconciler is the sole settlement verifier. */
export function validatePrepaidRenewalTransaction(
  tx: JsonObject,
  target: ReconciliationTarget,
  parameters: {
    tokenId: number;
    emailAddress: string;
    urls: { successUrl: string; failureUrl: string };
  },
  requirePending: boolean,
) {
  const line =
    Array.isArray(tx.lineItems) && tx.lineItems.length === 1
      ? object(tx.lineItems[0])
      : null;
  const metadata = object(tx.metaData),
    token = object(tx.token);
  const connector = object(tx.paymentConnectorConfiguration),
    method = connector && object(connector.paymentMethodConfiguration);
  if (
    tx.id !== target.transactionId ||
    tx.linkedSpaceId !== target.spaceId ||
    !Number.isSafeInteger(tx.version) ||
    (tx.version as number) < 0 ||
    (requirePending
      ? tx.state !== 'PENDING'
      : ![
          'PENDING',
          'CONFIRMED',
          'PROCESSING',
          'AUTHORIZED',
          'COMPLETED',
          'FULFILL',
          'FAILED',
          'DECLINE',
          'VOIDED',
        ].includes(String(tx.state))) ||
    tx.environment !==
      (target.environment === 'PRODUCTION' ? 'LIVE' : 'PREVIEW') ||
    tx.environmentSelectionStrategy !==
      (target.environment === 'PRODUCTION'
        ? 'FORCE_PRODUCTION_ENVIRONMENT'
        : 'FORCE_TEST_ENVIRONMENT') ||
    (tx.authorizationEnvironment != null &&
      tx.authorizationEnvironment !== target.environment) ||
    tx.currency !== 'CHF' ||
    tx.customerId !== target.customerReference ||
    tx.customerEmailAddress !== parameters.emailAddress ||
    tx.merchantReference !== target.period.periodId ||
    tx.invoiceMerchantReference !== target.period.periodId ||
    metadata?.zentra_period_id !== target.period.periodId ||
    metadata.zentra_plan_version !== target.planReference ||
    canonical(tx.allowedPaymentMethodConfigurations) !==
      canonical([target.paymentMethodConfigurationId]) ||
    token?.id !== parameters.tokenId ||
    (token.linkedSpaceId !== undefined &&
      token.linkedSpaceId !== target.spaceId) ||
    tx.customersPresence !== 'NOT_PRESENT' ||
    tx.autoConfirmationEnabled !== false ||
    tx.completionBehavior !== 'COMPLETE_IMMEDIATELY' ||
    tx.successUrl !== parameters.urls.successUrl ||
    tx.failedUrl !== parameters.urls.failureUrl ||
    !line ||
    line.quantity !== 1 ||
    line.type !== 'PRODUCT' ||
    line.uniqueId !== target.period.periodId ||
    line.sku !== target.planReference ||
    line.name !== target.period.catalog.name ||
    line.amountIncludingTax !== target.period.priceChfMinor / 100 ||
    line.shippingRequired !== false ||
    tx.authorizationAmount !== target.period.priceChfMinor / 100 ||
    (tx.paymentConnectorConfiguration != null &&
      (!connector ||
        connector.id !== target.connectorConfigurationId ||
        !method ||
        method.id !== target.paymentMethodConfigurationId))
  )
    throw new PrepaidRenewalError('provider-binding');
}

/** Server-only monthly orchestrator. The original customer, company, method,
 * terms, catalogue and token are read from durable records. create + applyFlow
 * use separate immutable ledger operations. A renewal is NEVER confirmed first
 * (official ChargeFlow requires PENDING), and no paid rights are granted here. */
export async function runPrepaidRenewal(
  configuration: PrepaidPurchaseConfiguration,
  input: { contractId: string; ordinal: number },
  dependencies: {
    database: () => Database;
    now?: () => number;
    fetch?: typeof fetch;
  },
): Promise<PrepaidRenewalResult> {
  if (!configuration.enabled) return { state: 'disabled' };
  const config = structuredClone(configuration),
    c = config.connection;
  const origin = c.apiOrigin ?? 'https://checkout.postfinance.ch';
  if (
    c.enabled !== true ||
    c.merchantApproved !== true ||
    c.prepaidFeatureEnabled !== true ||
    c.chargeFlowEnabled !== true ||
    !['TEST', 'PRODUCTION'].includes(c.prepaidEnvironment ?? '') ||
    (c.prepaidEnvironment === 'PRODUCTION' &&
      !config.settlementEvidenceVerified)
  )
    throw new PrepaidRenewalError('configuration');
  if (
    !/^pfp_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      input.contractId,
    ) ||
    !Number.isSafeInteger(input.ordinal) ||
    input.ordinal < 1
  )
    throw new PrepaidRenewalError('binding');
  const db = dependencies.database(),
    now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));
  const row = await db
    .prepare(`SELECT c.*,i.intent_id,i.parameters,i.state AS purchase_state
    FROM prepaid_contracts c JOIN prepaid_purchase_targets t ON t.contract_id=c.contract_id
    JOIN prepaid_purchase_projections x ON x.contract_id=c.contract_id AND x.intent_id=t.intent_id AND x.closed_at IS NOT NULL
    JOIN purchase_intents i ON i.intent_id=t.intent_id
    WHERE c.contract_id=? AND c.cancelled_at IS NULL AND c.api_origin=? AND c.space_id=? AND c.environment=?
    AND i.state='settled' AND i.provider='postfinance' AND i.owner_id=c.owner_id
    AND i.organization_id IS c.organization_id AND i.workspace_id IS c.workspace_id`)
    .bind(input.contractId, origin, c.spaceId!, c.prepaidEnvironment!)
    .first<{
      contract_id: string;
      owner_id: string;
      organization_id: string | null;
      workspace_id: string | null;
      product_key: string;
      catalog_json: string;
      catalog_version: string;
      intent_id: string;
      parameters: string;
    }>();
  if (!row) throw new PrepaidRenewalError('binding');
  const params = JSON.parse(row.parameters) as Record<string, unknown>,
    product = prepaidProduct(row.product_key);
  const method =
    params.method === 'postfinance_pay'
      ? 'postfinance_pay'
      : params.method === 'twint'
        ? 'twint'
        : null;
  const providerProduct = c.prepaidProducts?.[row.product_key];
  if (
    !product ||
    !method ||
    !providerProduct ||
    canonical(product) !== canonical(JSON.parse(row.catalog_json)) ||
    params.productKey !== product.productKey ||
    params.catalogVersion !== row.catalog_version ||
    params.priceChfMinor !== product.priceChfMinor ||
    params.name !== product.name ||
    params.returnOrigin !== c.returnOrigin ||
    typeof params.emailAddress !== 'string' ||
    providerProduct.reference !== row.catalog_version ||
    providerProduct.currency !== 'CHF' ||
    providerProduct.billingPeriod !== 'P1M' ||
    providerProduct.priceChfMinor !== product.priceChfMinor ||
    providerProduct.name !== product.name ||
    providerProduct.methodConfigurations[method] !==
      params.methodConfigurationId ||
    config.connectorConfigurations[method] !==
      params.connectorConfigurationId ||
    (method === 'postfinance_pay'
      ? c.postfinancePayTokenEnabled !== true
      : c.twintUserOnFileEnabled !== true)
  )
    throw new PrepaidRenewalError('configuration');
  const tokens = new D1PrepaidTokens(db, now),
    binding = await tokens.load(row.contract_id);
  if (
    !binding ||
    binding.ownerId !== row.owner_id ||
    binding.organizationId !== row.organization_id ||
    binding.workspaceId !== row.workspace_id ||
    binding.apiOrigin !== origin ||
    binding.spaceId !== c.spaceId ||
    binding.environment !== c.prepaidEnvironment ||
    binding.method !== method ||
    binding.paymentMethodConfigurationId !== params.methodConfigurationId ||
    binding.connectorConfigurationId !== params.connectorConfigurationId
  )
    throw new PrepaidRenewalError('binding');
  const readClient = new PostFinanceCheckoutClient(c, {
    fetch: dependencies.fetch,
    now: () => now() * 1000,
  });
  const periods = new D1PrepaidPeriods(db, now),
    period = await periods.reservePeriod(row.contract_id, input.ordinal);
  if (period.startsAt > now() || period.endsAt <= now())
    throw new PrepaidRenewalError('binding');
  try {
    await verifyFreshTokenBinding(readClient, binding, now(), now);
  } catch (error) {
    throw new PrepaidMandateAdmissionError(
      error instanceof PrepaidTokenError
        ? 'mandate_rejected'
        : 'mandate_unavailable',
    );
  }
  const expectation = {
    customerReference: binding.customerReference,
    planReference: period.catalogVersion,
    paymentMethodConfigurationId: binding.paymentMethodConfigurationId,
    connectorConfigurationId: binding.connectorConfigurationId,
  };
  const records = new D1PrepaidReconciliationStore(db, now);
  await records.freezeExpectation(period.periodId, expectation);
  const createInput = {
    productKey: row.product_key,
    periodId: period.periodId,
    customerReference: binding.customerReference,
    emailAddress: params.emailAddress,
    tokenId: binding.tokenId,
    urls: {
      successUrl: `${c.returnOrigin}/compte?paiement=confirmation&achat=${row.intent_id}`,
      failureUrl: `${c.returnOrigin}/pricing?paiement=annule&achat=${row.intent_id}`,
    },
  };
  const serialized = canonical(createInput),
    fingerprint = await digest(serialized);
  const createScopeHash = await digest(
    `${origin}|${c.spaceId}|POST|/payment/transactions|${period.periodId}_create`,
  );
  await db
    .prepare(`INSERT INTO prepaid_renewal_requests
    (period_id,contract_id,token_id,token_version_id,parameters,fingerprint,create_scope_hash,created_at)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(period_id) DO NOTHING`)
    .bind(
      period.periodId,
      row.contract_id,
      binding.tokenId,
      binding.tokenVersionId,
      serialized,
      fingerprint,
      createScopeHash,
      now(),
    )
    .run();
  const frozen = await db
    .prepare(
      'SELECT fingerprint FROM prepaid_renewal_requests WHERE period_id=?',
    )
    .bind(period.periodId)
    .first<{ fingerprint: string }>();
  if (frozen?.fingerprint !== fingerprint)
    throw new PrepaidRenewalError('binding');
  const client = (
    operation: PrepaidMutationFence['operation'],
    transactionId?: number,
  ) =>
    new PostFinanceCheckoutClient(c, {
      fetch: dependencies.fetch,
      now: () => now() * 1000,
      ledger: new D1PostFinanceMutationLedger(db, now, {
        contractId: row.contract_id,
        periodId: period.periodId,
        ownerId: row.owner_id,
        organizationId: row.organization_id,
        workspaceId: row.workspace_id,
        apiOrigin: origin,
        spaceId: c.spaceId!,
        environment: c.prepaidEnvironment!,
        operation,
        ...(transactionId === undefined ? {} : { transactionId }),
      }),
    });
  try {
    const created = await client('create').createPrepaidTransaction(
      createInput,
      method,
      `${period.periodId}_create`,
    );
    if (!positive(created.id))
      throw new PrepaidRenewalError('provider-binding');
    await periods.bindTransaction(period.periodId, created.id);
    const target = await records.target(origin, c.spaceId!, created.id);
    if (!target || target.period.periodId !== period.periodId)
      throw new PrepaidRenewalError('binding');
    const scope = `${origin}|${c.spaceId}|POST|/payment/transactions/${created.id}/charge-flow/apply|${period.periodId}_chargeflow`;
    const applied = await db
      .prepare('SELECT state FROM postfinance_mutations WHERE scope_hash=?')
      .bind(await digest(scope))
      .first<{ state: string }>();
    if (applied && applied.state !== 'completed')
      return {
        state: 'uncertain',
        periodId: period.periodId,
        transactionId: created.id,
      };
    const latest = await readClient.readTransaction(created.id);
    validatePrepaidRenewalTransaction(latest, target, createInput, !applied);
    const applyScopeHash = await digest(scope);
    await db
      .prepare(
        `UPDATE prepaid_renewal_requests SET apply_scope_hash=? WHERE period_id=? AND apply_scope_hash IS NULL`,
      )
      .bind(applyScopeHash, period.periodId)
      .run();
    const dispatch = await db
      .prepare(
        'SELECT apply_scope_hash FROM prepaid_renewal_requests WHERE period_id=?',
      )
      .bind(period.periodId)
      .first<{ apply_scope_hash: string }>();
    if (dispatch?.apply_scope_hash !== applyScopeHash)
      throw new PrepaidRenewalError('binding');
    const result = await client(
      'chargeflow',
      created.id,
    ).applyPrepaidChargeFlow(
      created.id,
      method,
      `${period.periodId}_chargeflow`,
    );
    if (result.id !== created.id || result.linkedSpaceId !== c.spaceId)
      throw new PrepaidRenewalError('provider-binding');
    return {
      state: 'submitted',
      periodId: period.periodId,
      transactionId: created.id,
    };
  } catch (error) {
    if (error instanceof PrepaidRenewalError) throw error;
    return { state: 'uncertain', periodId: period.periodId };
  }
}
