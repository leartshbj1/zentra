import {
  PostFinanceCheckoutClient,
  type JsonObject,
  type SwissMethod,
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
import { D1PurchaseIntents } from './purchase-intents';
import { prepaidProduct } from './prepaid-catalog';
import type {
  prepareInitialPrepaidPurchase,
  PrepaidPurchaseConfiguration,
} from './prepaid-purchase-preparation';

export type PreparedInitialPrepaidPurchase = Extract<
  Awaited<ReturnType<typeof prepareInitialPrepaidPurchase>>,
  { state: 'prepared' }
>;
export type InitialPrepaidCheckoutResult =
  | Readonly<{ state: 'disabled' }>
  | Readonly<{ state: 'uncertain'; intentId: string; periodId: string }>
  | Readonly<{
      state: 'payment-page';
      intentId: string;
      periodId: string;
      transactionId: number;
      url: string;
    }>;
export class InitialPrepaidCheckoutError extends Error {
  constructor(readonly code: 'binding' | 'configuration' | 'provider-binding') {
    super(`Initial prepaid checkout ${code}.`);
  }
}
class UncertainSnapshot extends Error {}
type Database = Pick<D1Database, 'prepare' | 'batch'>;
const encode = new TextEncoder();
function reject(code: InitialPrepaidCheckoutError['code']): never {
  throw new InitialPrepaidCheckoutError(code);
}
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (object(value))
    return (
      '{' +
      Object.keys(value as object)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) +
            ':' +
            canonical((value as Record<string, unknown>)[key]),
        )
        .join(',') +
      '}'
    );
  const json = JSON.stringify(value);
  if (json === undefined) reject('binding');
  return json;
}
function equal(a: unknown, b: unknown) {
  return canonical(a) === canonical(b);
}
async function digest(value: string, base64 = false) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', encode.encode(value)),
  );
  if (base64)
    return btoa(String.fromCharCode(...bytes))
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}
function minor(value: unknown) {
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

/** Official Transaction fields from SDK bb1e4c34ffa44bc1da8f54c86f984961aa886c30.
 * PENDING has no selected connector/authorization environment necessarily. We
 * require the requested environment strategy and LIVE/PREVIEW, and validate
 * those optional fields if present; none of this proves settlement or rights. */
function validateTransaction(
  transaction: JsonObject,
  target: ReconciliationTarget,
  email: string,
  urls: { successUrl: string; failureUrl: string },
  allowConfirmed: boolean,
) {
  const p = target.period,
    line =
      Array.isArray(transaction.lineItems) && transaction.lineItems.length === 1
        ? object(transaction.lineItems[0])
        : null;
  const metadata = object(transaction.metaData);
  const connector = transaction.paymentConnectorConfiguration;
  const selected = object(connector),
    method = object(selected?.paymentMethodConfiguration);
  if (
    transaction.id !== target.transactionId ||
    transaction.linkedSpaceId !== target.spaceId ||
    !(
      transaction.state === 'PENDING' ||
      (allowConfirmed && transaction.state === 'CONFIRMED')
    ) ||
    !Number.isSafeInteger(transaction.version) ||
    (transaction.version as number) < 0 ||
    transaction.environment !==
      (target.environment === 'PRODUCTION' ? 'LIVE' : 'PREVIEW') ||
    transaction.environmentSelectionStrategy !==
      (target.environment === 'PRODUCTION'
        ? 'FORCE_PRODUCTION_ENVIRONMENT'
        : 'FORCE_TEST_ENVIRONMENT') ||
    (transaction.authorizationEnvironment != null &&
      transaction.authorizationEnvironment !== target.environment) ||
    transaction.currency !== 'CHF' ||
    transaction.customerId !== target.customerReference ||
    transaction.customerEmailAddress !== email ||
    transaction.merchantReference !== p.periodId ||
    transaction.invoiceMerchantReference !== p.periodId ||
    metadata?.zentra_period_id !== p.periodId ||
    metadata?.zentra_plan_version !== target.planReference ||
    !equal(transaction.allowedPaymentMethodConfigurations, [
      target.paymentMethodConfigurationId,
    ]) ||
    transaction.successUrl !== urls.successUrl ||
    transaction.failedUrl !== urls.failureUrl ||
    transaction.customersPresence !== 'VIRTUAL_PRESENT' ||
    transaction.tokenizationMode !== 'FORCE_CREATION' ||
    transaction.autoConfirmationEnabled !== false ||
    transaction.completionBehavior !== 'COMPLETE_IMMEDIATELY' ||
    !line ||
    line.quantity !== 1 ||
    line.type !== 'PRODUCT' ||
    line.uniqueId !== p.periodId ||
    line.sku !== target.planReference ||
    line.name !== p.catalog.name ||
    minor(line.amountIncludingTax) !== p.priceChfMinor ||
    line.shippingRequired !== false ||
    minor(transaction.authorizationAmount) !== p.priceChfMinor ||
    (connector != null &&
      (!selected ||
        selected.id !== target.connectorConfigurationId ||
        !method ||
        method.id !== target.paymentMethodConfigurationId))
  )
    reject('provider-binding');
}

/** Local immutable read snapshots use a distinct LOCAL scope, never a payment
 * POST or a financial fence. An interrupted winning snapshot stays uncertain:
 * do not replace a lost confirmation version with a newer provider version. */
async function snapshot<T>(
  db: Database,
  now: () => number,
  scope: string,
  fingerprint: string,
  produce?: () => Promise<T>,
): Promise<T | null> {
  const existing = await db
    .prepare(
      'SELECT fingerprint,state,response_json FROM postfinance_mutations WHERE scope_hash=?',
    )
    .bind(await digest(scope))
    .first<{
      fingerprint: string;
      state: string;
      response_json: string | null;
    }>();
  if (existing) {
    if (existing.fingerprint !== fingerprint) reject('binding');
    if (existing.state !== 'completed' || existing.response_json === null)
      throw new UncertainSnapshot();
    return JSON.parse(existing.response_json) as T;
  }
  if (!produce) return null;
  const result = await produce();
  const ledger = new D1PostFinanceMutationLedger(db, now);
  const claim = await ledger.claim(scope, fingerprint);
  if (claim.kind === 'completed') return JSON.parse(claim.json) as T;
  if (claim.kind === 'conflict') reject('binding');
  if (claim.kind !== 'claimed') throw new UncertainSnapshot();
  try {
    await ledger.complete(scope, JSON.stringify(result));
  } catch (error) {
    await ledger.markUncertain(scope);
    throw error;
  }
  return result;
}

/** Internal orchestration of an already authenticated, durable preparation.
 * The caller must authenticate freshly and never accept a prepared object from
 * a browser. Every supplied binding is re-read and compared to D1. No settlement,
 * entitlement, license, subscriber or ChargeFlow operation occurs here. */
export async function runInitialPrepaidCheckout(
  configuration: PrepaidPurchaseConfiguration,
  prepared: PreparedInitialPrepaidPurchase,
  dependencies: {
    database: () => Database;
    now?: () => number;
    fetch?: typeof fetch;
  },
): Promise<InitialPrepaidCheckoutResult> {
  if (configuration.enabled !== true) return { state: 'disabled' };
  const config = structuredClone(configuration),
    input = structuredClone(prepared);
  const connection = config.connection,
    origin = connection.apiOrigin ?? 'https://checkout.postfinance.ch';
  const db = dependencies.database(),
    now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));
  const intents = new D1PurchaseIntents(db, now),
    periods = new D1PrepaidPeriods(db, now);
  const records = new D1PrepaidReconciliationStore(db, now);
  const intent = await intents.read(input.intent),
    params = intent.parameters;
  const product =
    typeof params.productKey === 'string' && prepaidProduct(params.productKey);
  if (
    !product ||
    intent.provider !== 'postfinance' ||
    !['reserved', 'dispatched', 'uncertain'].includes(intent.state) ||
    intent.providerScope !== `${origin}|${connection.spaceId}` ||
    intent.environment !== connection.prepaidEnvironment ||
    intent.product !== product.productKind ||
    intent.planId !== product.planId ||
    !equal(input.intent.parameters, intent.parameters) ||
    !equal(input.intent.terms, intent.terms) ||
    input.intent.organizationId !== intent.organizationId ||
    input.intent.workspaceId !== intent.workspaceId ||
    input.intent.product !== intent.product ||
    input.intent.planId !== intent.planId ||
    input.intent.createdAt !== intent.createdAt ||
    input.intent.expiresAt !== intent.expiresAt
  )
    reject('binding');
  if (
    !(await db
      .prepare('SELECT 1 FROM purchase_valid_targets WHERE intent_id=?')
      .bind(intent.intentId)
      .first())
  )
    reject('binding');
  const method = params.method as SwissMethod,
    providerProduct = connection.prepaidProducts?.[product.productKey];
  if (
    connection.enabled !== true ||
    connection.merchantApproved !== true ||
    connection.prepaidFeatureEnabled !== true ||
    connection.chargeFlowEnabled !== true ||
    (intent.environment === 'PRODUCTION' &&
      config.settlementEvidenceVerified !== true) ||
    !['postfinance_pay', 'twint'].includes(method) ||
    (method === 'postfinance_pay'
      ? connection.postfinancePayTokenEnabled !== true
      : connection.twintUserOnFileEnabled !== true) ||
    !positive(params.methodConfigurationId) ||
    !positive(params.connectorConfigurationId) ||
    config.connectorConfigurations[method] !==
      params.connectorConfigurationId ||
    !providerProduct ||
    providerProduct.currency !== 'CHF' ||
    providerProduct.billingPeriod !== 'P1M' ||
    providerProduct.priceChfMinor !== product.priceChfMinor ||
    providerProduct.reference !== product.catalogVersion ||
    providerProduct.name !== product.name ||
    providerProduct.methodConfigurations[method] !==
      params.methodConfigurationId ||
    params.priceChfMinor !== product.priceChfMinor ||
    params.catalogVersion !== product.catalogVersion ||
    params.name !== product.name ||
    params.returnOrigin !== connection.returnOrigin ||
    intent.terms.origin !== connection.returnOrigin ||
    typeof params.emailAddress !== 'string'
  )
    reject('configuration');
  const contract = {
    contractId: 'pfp_' + intent.intentId.slice('purchase_'.length),
    ownerId: intent.ownerId,
    organizationId: intent.organizationId,
    workspaceId: intent.workspaceId,
    apiOrigin: origin,
    spaceId: connection.spaceId!,
    environment: intent.environment,
    productKey: product.productKey,
  };
  if (!equal(input.contract, contract)) reject('binding');
  // Existing rows must match their original immutable fingerprint/calendar.
  await periods.createContract(contract);
  const period = await periods.reservePeriod(contract.contractId, 0);
  const expectation = {
    customerReference: 'pfpayer_' + (await digest(intent.ownerId)),
    planReference: period.catalogVersion,
    paymentMethodConfigurationId: params.methodConfigurationId,
    connectorConfigurationId: params.connectorConfigurationId,
  };
  if (!equal(input.period, period) || !equal(input.expectation, expectation))
    reject('binding');
  await records.freezeExpectation(period.periodId, expectation);
  const createInput = {
    productKey: product.productKey,
    periodId: period.periodId,
    customerReference: expectation.customerReference,
    emailAddress: params.emailAddress,
    urls: {
      successUrl: `${connection.returnOrigin}/compte?paiement=confirmation&achat=${intent.intentId}`,
      failureUrl: `${connection.returnOrigin}/pricing?paiement=annule&achat=${intent.intentId}`,
    },
  };
  const keys = {
    create: `${period.periodId}_create`,
    confirm: `${period.periodId}_confirm`,
    chargeflow: `${period.periodId}_chargeflow`,
  };
  if (
    !equal(input.createInput, createInput) ||
    !equal(input.businessKeys, keys)
  )
    reject('binding');
  const base = { intentId: intent.intentId, periodId: period.periodId };
  const fence = (
    operation: PrepaidMutationFence['operation'],
    transactionId?: number,
  ): PrepaidMutationFence => ({
    ...contract,
    periodId: period.periodId,
    operation,
    ...(transactionId === undefined ? {} : { transactionId }),
  });
  const client = (
    operation: PrepaidMutationFence['operation'],
    transactionId?: number,
  ) =>
    new PostFinanceCheckoutClient(connection, {
      fetch: dependencies.fetch,
      now: () => now() * 1000,
      ledger: new D1PostFinanceMutationLedger(
        db,
        now,
        fence(operation, transactionId),
      ),
    });
  const snapshotBinding = canonical([
    intent.fingerprint,
    contract,
    period.periodId,
  ]);
  const localScope = (stage: string, transactionId?: number) =>
    `${origin}|${contract.spaceId}|LOCAL|initial-${stage}|${period.periodId}${transactionId === undefined ? '' : '_' + transactionId}`;
  const pageScope = localScope('payment-page'),
    pageFingerprint = await digest(snapshotBinding + '|payment-page', true);
  try {
    // A completed result may be replayed after expiry/cancellation without POST.
    const page = await snapshot<InitialPrepaidCheckoutResult>(
      db,
      now,
      pageScope,
      pageFingerprint,
    );
    if (page) {
      if (
        page.state !== 'payment-page' ||
        page.intentId !== intent.intentId ||
        page.periodId !== period.periodId ||
        !positive(page.transactionId) ||
        intent.providerReference !== String(page.transactionId)
      )
        reject('binding');
      const target = await records.target(
        origin,
        contract.spaceId,
        page.transactionId,
      );
      if (
        !target ||
        !equal(target.period, period) ||
        target.ownerId !== intent.ownerId ||
        target.organizationId !== intent.organizationId ||
        target.workspaceId !== intent.workspaceId
      )
        reject('binding');
      const url = new URL(page.url);
      if (
        url.protocol !== 'https:' ||
        url.origin !== origin ||
        url.username ||
        url.password
      )
        reject('binding');
      return page;
    }
    await intents.markDispatched(intent);
    const create = client('create'),
      created = await create.createPrepaidTransaction(
        createInput,
        method,
        keys.create,
      );
    if (!positive(created.id) || created.linkedSpaceId !== contract.spaceId)
      reject('provider-binding');
    const transactionId = created.id;
    await periods.bindTransaction(period.periodId, transactionId);
    await intents.bindProviderReference(intent, String(transactionId));
    const target = await records.target(
      origin,
      contract.spaceId,
      transactionId,
    );
    if (
      !target ||
      target.ownerId !== contract.ownerId ||
      target.organizationId !== contract.organizationId ||
      target.workspaceId !== contract.workspaceId ||
      target.environment !== contract.environment ||
      !equal(target.period, period) ||
      !equal(expectation, {
        customerReference: target.customerReference,
        planReference: target.planReference,
        paymentMethodConfigurationId: target.paymentMethodConfigurationId,
        connectorConfigurationId: target.connectorConfigurationId,
      })
    )
      reject('binding');
    const confirm = client('confirm', transactionId),
      versionScope = localScope('confirm-version', transactionId);
    const versionFingerprint = await digest(
      snapshotBinding + `|${transactionId}|confirm-version`,
      true,
    );
    let frozen = await snapshot<{ version: number }>(
      db,
      now,
      versionScope,
      versionFingerprint,
    );
    const transaction = await confirm.readTransaction(transactionId);
    validateTransaction(
      transaction,
      target,
      createInput.emailAddress,
      createInput.urls,
      frozen !== null,
    );
    if (!frozen)
      frozen = await snapshot(
        db,
        now,
        versionScope,
        versionFingerprint,
        async () => ({ version: transaction.version as number }),
      );
    if (
      !frozen ||
      !Number.isSafeInteger(frozen.version) ||
      frozen.version < 0 ||
      Object.keys(frozen).length !== 1
    )
      reject('binding');
    const confirmed = await confirm.confirmPrepaidTransaction(
      transactionId,
      frozen.version,
      method,
      keys.confirm,
    );
    if (
      confirmed.id !== transactionId ||
      confirmed.linkedSpaceId !== contract.spaceId ||
      confirmed.state !== 'CONFIRMED'
    )
      reject('provider-binding');
    // The POST receipt is not authoritative validation of the final basket.
    // Re-read CONFIRMED immediately before opening its payment page. This never
    // changes the frozen version or repeats a completed financial mutation.
    const current = await confirm.readTransaction(transactionId);
    validateTransaction(
      current,
      target,
      createInput.emailAddress,
      createInput.urls,
      true,
    );
    if (current.state !== 'CONFIRMED') reject('provider-binding');
    const url = await confirm.paymentPageUrl(transactionId);
    const result = {
      state: 'payment-page' as const,
      ...base,
      transactionId,
      url,
    };
    return (await snapshot(
      db,
      now,
      pageScope,
      pageFingerprint,
      async () => result,
    ))!;
  } catch (error) {
    // A dispatched intent is never TTL-released. GET/storage failures can resume
    // completed POSTs; lost financial responses remain blocked by the ledger.
    const current = await intents.read(intent);
    if (!['dispatched', 'uncertain'].includes(current.state)) throw error;
    await intents.markUncertain(intent);
    if (error instanceof InitialPrepaidCheckoutError) throw error;
    return { state: 'uncertain', ...base };
  }
}
