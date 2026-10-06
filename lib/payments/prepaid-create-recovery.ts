import {
  PostFinanceCheckoutClient,
  type JsonObject,
} from './postfinance-client';
import { prepaidProduct } from './prepaid-catalog';
import { prepaidMonthlyPeriod } from './prepaid-calendar';
import type { PrepaidPurchaseConfiguration } from './prepaid-purchase-preparation';

type Database = Pick<D1Database, 'prepare' | 'batch'>;
export type PrepaidCreateRecoveryConfiguration = PrepaidPurchaseConfiguration &
  Readonly<{ createRecoveryEnabled?: boolean }>;
export type PrepaidCreateRecoveryResult =
  | Readonly<{ state: 'disabled' }>
  | Readonly<{
      state: 'pending';
      reason: 'absent' | 'ambiguous' | 'unstable' | 'unavailable';
    }>
  | Readonly<{
      state: 'bound';
      periodId: string;
      transactionId: number;
      reconciliationOnly: boolean;
    }>;
export class PrepaidCreateRecoveryError extends Error {
  constructor(
    readonly code:
      | 'configuration'
      | 'binding'
      | 'not-claimed'
      | 'provider-binding',
  ) {
    super(`Prepaid CREATE recovery ${code}.`);
  }
}
type Row = {
  period_id: string;
  contract_id: string;
  ordinal: number;
  starts_at: number;
  ends_at: number;
  price_chf_minor: number;
  currency: string;
  catalog_json: string;
  catalog_version: string;
  owner_id: string;
  organization_id: string | null;
  workspace_id: string | null;
  api_origin: string;
  space_id: number;
  environment: 'TEST' | 'PRODUCTION';
  product_key: string;
  anchor_start: number;
  contract_catalog: string;
  contract_fingerprint: string;
  customer_reference: string;
  plan_reference: string;
  payment_method_configuration_id: number;
  connector_configuration_id: number;
  expectation_fingerprint: string;
  intent_id: string;
  intent_fingerprint: string;
  parameters: string;
  intent_state: string;
  previous_subscription_id: string | null;
  renewal_parameters: string | null;
  renewal_fingerprint: string | null;
  create_scope_hash: string | null;
  token_id: number | null;
};
type Ledger = {
  state: string;
  fingerprint: string;
  claim_token: string | null;
  response_json: string | null;
};
type Receipt = {
  transaction_id: number;
  observed_state: string;
  source_json: string;
  request_fingerprint: string;
};
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
  if (s === undefined) throw new PrepaidCreateRecoveryError('binding');
  return s;
}
async function digest(s: string, base64 = false) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)),
  );
  return base64
    ? btoa(String.fromCharCode(...bytes))
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
    : Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
const positive = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
function reject(code: PrepaidCreateRecoveryError['code']): never {
  throw new PrepaidCreateRecoveryError(code);
}
const states = new Set([
  'PENDING',
  'CONFIRMED',
  'PROCESSING',
  'AUTHORIZED',
  'COMPLETED',
  'FULFILL',
  'FAILED',
  'DECLINE',
  'VOIDED',
]);
// SQL guards below intentionally use original immutable identities and actual
// owners. Cancellation/expiry does not hide a possibly accepted payment. They
// do not grant rights or permit another POST; dispatch has its own stricter fence.
const sourceFrom = `FROM prepaid_periods p JOIN prepaid_contracts c ON c.contract_id=p.contract_id
  JOIN prepaid_payment_expectations e ON e.period_id=p.period_id
  JOIN prepaid_purchase_targets x ON x.contract_id=c.contract_id
  JOIN purchase_intents i ON i.intent_id=x.intent_id
  LEFT JOIN prepaid_renewal_requests r ON r.period_id=p.period_id`;
const sourceGuard = `p.period_id=? AND c.fingerprint=? AND e.fingerprint=? AND i.fingerprint=?
  AND i.parameters=? AND x.previous_subscription_id IS ? AND r.parameters IS ?
  AND r.fingerprint IS ? AND r.create_scope_hash IS ?
  AND c.environment IN('TEST','PRODUCTION') AND c.owner_id=i.owner_id AND c.organization_id IS i.organization_id
  AND c.workspace_id IS i.workspace_id AND i.provider='postfinance'
  AND i.environment=c.environment AND i.provider_scope=(c.api_origin||'|'||c.space_id)
  AND x.owner_id=c.owner_id AND x.organization_id IS c.organization_id AND x.workspace_id IS c.workspace_id
  AND (p.ordinal=0 AND i.state IN('dispatched','uncertain') OR p.ordinal>0 AND i.state='settled'
    AND EXISTS(SELECT 1 FROM prepaid_purchase_projections v WHERE v.contract_id=c.contract_id
      AND v.intent_id=i.intent_id AND v.closed_at IS NOT NULL))
  AND (c.organization_id IS NULL OR EXISTS(SELECT 1 FROM organizations o JOIN organization_members m
    ON m.organization_id=o.organization_id WHERE o.organization_id=c.organization_id
    AND o.created_by_user_id=c.owner_id AND m.user_id=c.owner_id AND m.role='owner' AND m.revoked_at IS NULL))
  AND (c.workspace_id IS NULL OR EXISTS(SELECT 1 FROM support_workspaces w WHERE w.id=c.workspace_id AND w.owner_id=c.owner_id))
  AND NOT EXISTS(SELECT 1 FROM account_session_policy a WHERE a.user_id=c.owner_id AND a.deleted_at IS NOT NULL)
  AND NOT EXISTS(SELECT 1 FROM support_gestion_links l WHERE
    (l.organization_id=c.organization_id AND l.workspace_id IS NOT c.workspace_id AND c.workspace_id IS NOT NULL)
    OR (l.workspace_id=c.workspace_id AND l.organization_id IS NOT c.organization_id))`;
function sourceValues(r: Row) {
  return [
    r.period_id,
    r.contract_fingerprint,
    r.expectation_fingerprint,
    r.intent_fingerprint,
    r.parameters,
    r.previous_subscription_id,
    r.renewal_parameters,
    r.renewal_fingerprint,
    r.create_scope_hash,
  ];
}
async function load(db: Database, periodId: string): Promise<Row> {
  const r = await db
    .prepare(`SELECT p.*,c.owner_id,c.organization_id,c.workspace_id,c.api_origin,c.space_id,
    c.environment,c.product_key,c.anchor_start,c.catalog_json AS contract_catalog,c.fingerprint AS contract_fingerprint,
    e.customer_reference,e.plan_reference,e.payment_method_configuration_id,e.connector_configuration_id,
    e.fingerprint AS expectation_fingerprint,i.intent_id,i.fingerprint AS intent_fingerprint,i.parameters,
    i.state AS intent_state,x.previous_subscription_id,r.parameters AS renewal_parameters,
    r.fingerprint AS renewal_fingerprint,r.create_scope_hash,r.token_id
    ${sourceFrom} WHERE p.period_id=?
    AND NOT EXISTS(SELECT 1 FROM json_tree(i.parameters) GROUP BY parent,key HAVING COUNT(*)>1)
    AND (r.parameters IS NULL OR NOT EXISTS(SELECT 1 FROM json_tree(r.parameters) GROUP BY parent,key HAVING COUNT(*)>1))`)
    .bind(periodId)
    .first<Row>();
  if (!r) reject('binding');
  if (
    !(await db
      .prepare(`SELECT 1 ${sourceFrom} WHERE ${sourceGuard}`)
      .bind(...sourceValues(r))
      .first())
  )
    reject('binding');
  return r;
}
async function frozenBody(r: Row, config: PrepaidCreateRecoveryConfiguration) {
  const product = prepaidProduct(r.product_key),
    params = object(JSON.parse(r.parameters));
  if (!product || !params) reject('binding');
  const connection = config.connection,
    method = params.method;
  const providerProduct = connection.prepaidProducts?.[product.productKey];
  const dates = prepaidMonthlyPeriod(r.anchor_start, r.ordinal);
  const contractFingerprint = await digest(
    JSON.stringify([
      r.owner_id,
      r.organization_id,
      r.workspace_id,
      r.api_origin,
      r.space_id,
      r.environment,
      r.product_key,
      r.contract_catalog,
    ]),
  );
  const expectationFingerprint = await digest(
    JSON.stringify([
      r.period_id,
      r.customer_reference,
      r.plan_reference,
      r.payment_method_configuration_id,
      r.connector_configuration_id,
    ]),
  );
  if (
    r.period_id !==
      `pfperiod_${await digest(`${r.contract_id}|${r.ordinal}`)}` ||
    r.contract_id !== 'pfp_' + r.intent_id.slice('purchase_'.length) ||
    r.contract_fingerprint !== contractFingerprint ||
    r.expectation_fingerprint !== expectationFingerprint ||
    r.customer_reference !== 'pfpayer_' + (await digest(r.owner_id)) ||
    r.catalog_json !== JSON.stringify(product) ||
    r.contract_catalog !== r.catalog_json ||
    r.catalog_version !== product.catalogVersion ||
    r.plan_reference !== product.catalogVersion ||
    r.currency !== 'CHF' ||
    r.price_chf_minor !== product.priceChfMinor ||
    r.starts_at !== dates.startSeconds ||
    r.ends_at !== dates.endSeconds ||
    params.productKey !== product.productKey ||
    params.catalogVersion !== product.catalogVersion ||
    params.priceChfMinor !== product.priceChfMinor ||
    params.name !== product.name ||
    params.previousSubscriptionId !== r.previous_subscription_id ||
    params.methodConfigurationId !== r.payment_method_configuration_id ||
    params.connectorConfigurationId !== r.connector_configuration_id ||
    !['postfinance_pay', 'twint'].includes(String(method)) ||
    (method === 'postfinance_pay'
      ? connection.postfinancePayTokenEnabled !== true
      : connection.twintUserOnFileEnabled !== true) ||
    !providerProduct ||
    providerProduct.reference !== product.catalogVersion ||
    providerProduct.name !== product.name ||
    providerProduct.currency !== 'CHF' ||
    providerProduct.billingPeriod !== 'P1M' ||
    providerProduct.priceChfMinor !== r.price_chf_minor ||
    providerProduct.methodConfigurations[
      method as 'postfinance_pay' | 'twint'
    ] !== r.payment_method_configuration_id ||
    config.connectorConfigurations[method as 'postfinance_pay' | 'twint'] !==
      r.connector_configuration_id ||
    typeof params.returnOrigin !== 'string' ||
    params.returnOrigin !== connection.returnOrigin ||
    typeof params.emailAddress !== 'string' ||
    !/^[^\s@]{1,128}@[^\s@]{1,128}\.[^\s@]{1,64}$/.test(params.emailAddress)
  )
    reject('binding');
  const input = {
    productKey: r.product_key,
    periodId: r.period_id,
    customerReference: r.customer_reference,
    emailAddress: params.emailAddress,
    ...(r.ordinal === 0 ? {} : { tokenId: r.token_id }),
    urls: {
      successUrl: `${params.returnOrigin}/compte?paiement=confirmation&achat=${r.intent_id}`,
      failureUrl: `${params.returnOrigin}/pricing?paiement=annule&achat=${r.intent_id}`,
    },
  };
  const scope = `${r.api_origin}|${r.space_id}|POST|/payment/transactions|${r.period_id}_create`;
  if (
    r.ordinal > 0 &&
    (!positive(r.token_id) ||
      r.renewal_parameters !== canonical(input) ||
      r.renewal_fingerprint !== (await digest(canonical(input))) ||
      r.create_scope_hash !== (await digest(scope)))
  )
    reject('binding');
  // Exact wire body pinned to createPrepaidTransaction (SDK bb1e4c34). The
  // ledger's original body fingerprint makes any future divergent shape fail.
  const body: JsonObject = {
    currency: 'CHF',
    environmentSelectionStrategy:
      r.environment === 'TEST'
        ? 'FORCE_TEST_ENVIRONMENT'
        : 'FORCE_PRODUCTION_ENVIRONMENT',
    customerId: r.customer_reference,
    customerEmailAddress: params.emailAddress,
    merchantReference: r.period_id,
    invoiceMerchantReference: r.period_id,
    metaData: {
      zentra_period_id: r.period_id,
      zentra_plan_version: r.plan_reference,
    },
    lineItems: [
      {
        quantity: 1,
        name: product.name,
        amountIncludingTax: r.price_chf_minor / 100,
        type: 'PRODUCT',
        uniqueId: r.period_id,
        sku: r.plan_reference,
        shippingRequired: false,
      },
    ],
    allowedPaymentMethodConfigurations: [r.payment_method_configuration_id],
    customersPresence: r.ordinal === 0 ? 'VIRTUAL_PRESENT' : 'NOT_PRESENT',
    completionBehavior: 'COMPLETE_IMMEDIATELY',
    autoConfirmationEnabled: false,
    successUrl: input.urls.successUrl,
    failedUrl: input.urls.failureUrl,
    ...(r.ordinal === 0
      ? { tokenizationMode: 'FORCE_CREATION' }
      : { token: r.token_id }),
  };
  return {
    body,
    scope,
    scopeHash: await digest(scope),
    requestFingerprint: await digest(canonical(body), true),
  };
}
function validate(tx: JsonObject, r: Row, body: JsonObject) {
  if (
    !positive(tx.id) ||
    tx.linkedSpaceId !== r.space_id ||
    !states.has(String(tx.state)) ||
    !Number.isSafeInteger(tx.version) ||
    (tx.version as number) < 0 ||
    tx.environment !== (r.environment === 'TEST' ? 'PREVIEW' : 'LIVE') ||
    (tx.authorizationEnvironment != null &&
      tx.authorizationEnvironment !== r.environment) ||
    tx.authorizationAmount !== r.price_chf_minor / 100
  )
    reject('provider-binding');
  for (const [key, value] of Object.entries(body)) {
    if (key === 'token') {
      const token = object(tx.token);
      if (!token || token.id !== value || token.linkedSpaceId !== r.space_id)
        reject('provider-binding');
    } else if (key === 'lineItems') {
      const line =
        Array.isArray(tx.lineItems) && tx.lineItems.length === 1
          ? object(tx.lineItems[0])
          : null;
      if (!line) reject('provider-binding');
      for (const [field, expected] of Object.entries(
        (value as JsonObject[])[0],
      ))
        if (line[field] !== expected) reject('provider-binding');
    } else if (key === 'metaData') {
      const metadata = object(tx.metaData);
      if (
        !metadata ||
        Object.entries(value as JsonObject).some(
          ([field, expected]) => metadata[field] !== expected,
        )
      )
        reject('provider-binding');
    } else if (canonical(tx[key]) !== canonical(value))
      reject('provider-binding');
  }
  if (tx.paymentConnectorConfiguration != null) {
    const connector = object(tx.paymentConnectorConfiguration),
      method = object(connector?.paymentMethodConfiguration);
    if (
      connector?.id !== r.connector_configuration_id ||
      method?.id !== r.payment_method_configuration_id
    )
      reject('provider-binding');
  }
}

/** Internal recovery prototype: no public route/worker invokes it. Mock
 * PRODUCTION fixtures do not prove a production merchant integration.
 * Only GET requests may discover an accepted CREATE. Never infer nonexistence,
 * release a reservation, resolve confirm/ChargeFlow, or project a paid right.
 * PENDING can omit a selected connector/authorization environment; if present
 * they must match. Advanced transactions are bound for reconciliation only. */
export async function recoverPrepaidCreate(
  configuration: PrepaidCreateRecoveryConfiguration,
  input: Readonly<{ periodId: string }>,
  dependencies: {
    database: () => Database;
    now?: () => number;
    fetch?: typeof fetch;
  },
): Promise<PrepaidCreateRecoveryResult> {
  if (
    configuration.createRecoveryEnabled !== true ||
    configuration.enabled !== true
  )
    return { state: 'disabled' };
  const config = structuredClone(configuration),
    c = config.connection;
  if (
    c.enabled !== true ||
    c.merchantApproved !== true ||
    c.prepaidFeatureEnabled !== true ||
    c.chargeFlowEnabled !== true ||
    !['TEST', 'PRODUCTION'].includes(c.prepaidEnvironment ?? '') ||
    (c.prepaidEnvironment === 'PRODUCTION' &&
      config.settlementEvidenceVerified !== true) ||
    !positive(c.spaceId) ||
    !/^[1-9][0-9]{0,15}$/.test(c.applicationUserId ?? '') ||
    !positive(Number(c.applicationUserId)) ||
    !/^[A-Za-z0-9+/]{43}=$/.test(c.authenticationKeyBase64 ?? '') ||
    !['https://checkout.postfinance.ch', 'https://app-wallee.com'].includes(
      c.apiOrigin ?? 'https://checkout.postfinance.ch',
    )
  )
    reject('configuration');
  try {
    const key = c.authenticationKeyBase64!,
      origin = new URL(c.returnOrigin!);
    if (
      atob(key).length !== 32 ||
      btoa(atob(key)) !== key ||
      origin.protocol !== 'https:' ||
      origin.origin !== c.returnOrigin ||
      origin.username ||
      origin.password
    )
      reject('configuration');
  } catch {
    reject('configuration');
  }
  if (!/^pfperiod_[0-9a-f]{64}$/.test(input.periodId)) reject('binding');
  const db = dependencies.database(),
    now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));
  if (!positive(now())) reject('binding');
  const r = await load(db, input.periodId);
  if (
    r.environment !== c.prepaidEnvironment ||
    r.space_id !== c.spaceId ||
    r.api_origin !== (c.apiOrigin ?? 'https://checkout.postfinance.ch')
  )
    reject('configuration');
  const frozen = await frozenBody(r, config);
  // Cancellation is intentionally absent from immutable provenance; dispatch
  // remains separately fenced. Exclude mutable intent state from this digest.
  const { intent_state: ignored, ...immutable } = r;
  void ignored;
  const sourceJson = canonical(immutable);
  const receipt = await db
    .prepare(
      'SELECT transaction_id,observed_state,source_json,request_fingerprint FROM prepaid_create_recoveries WHERE period_id=?',
    )
    .bind(r.period_id)
    .first<Receipt>();
  if (receipt) {
    if (
      receipt.source_json !== sourceJson ||
      receipt.request_fingerprint !== frozen.requestFingerprint
    )
      reject('binding');
    const binding = await db
      .prepare(`SELECT 1 FROM prepaid_transactions t JOIN postfinance_mutations m ON m.scope_hash=?
      WHERE t.period_id=? AND t.transaction_id=? AND t.api_origin=? AND t.space_id=?
      AND m.state='completed' AND m.fingerprint=? AND json_extract(m.response_json,'$.id')=t.transaction_id`)
      .bind(
        frozen.scopeHash,
        r.period_id,
        receipt.transaction_id,
        r.api_origin,
        r.space_id,
        frozen.requestFingerprint,
      )
      .first();
    if (!binding) reject('binding');
    return {
      state: 'bound',
      periodId: r.period_id,
      transactionId: receipt.transaction_id,
      reconciliationOnly: receipt.observed_state !== 'PENDING',
    };
  }
  const ledger = await db
    .prepare(
      'SELECT state,fingerprint,claim_token,response_json FROM postfinance_mutations WHERE scope_hash=?',
    )
    .bind(frozen.scopeHash)
    .first<Ledger>();
  if (
    !ledger ||
    !['claimed', 'uncertain'].includes(ledger.state) ||
    !ledger.claim_token ||
    ledger.response_json !== null
  )
    reject('not-claimed');
  if (ledger.fingerprint !== frozen.requestFingerprint) reject('binding');
  const client = new PostFinanceCheckoutClient(c, {
    fetch: dependencies.fetch,
    now: () => now() * 1000,
  });
  let found: JsonObject[],
    first: JsonObject,
    second: JsonObject,
    repeated: JsonObject[];
  try {
    found = await client.searchPrepaidTransactions(r.period_id);
    if (found.length !== 1)
      return {
        state: 'pending',
        reason: found.length === 0 ? 'absent' : 'ambiguous',
      };
    if (!positive(found[0].id)) reject('provider-binding');
    first = await client.readTransaction(found[0].id);
    second = await client.readTransaction(found[0].id);
    validate(first, r, frozen.body);
    validate(second, r, frozen.body);
    if (canonical(first) !== canonical(second))
      return { state: 'pending', reason: 'unstable' };
    repeated = await client.searchPrepaidTransactions(r.period_id);
    if (
      canonical(found.map((tx) => tx.id)) !==
      canonical(repeated.map((tx) => tx.id))
    )
      return { state: 'pending', reason: 'unstable' };
  } catch (error) {
    if (error instanceof PrepaidCreateRecoveryError) throw error;
    return { state: 'pending', reason: 'unavailable' };
  }
  const transactionId = first.id as number,
    response = canonical(first),
    observedAt = now();
  if (
    new TextEncoder().encode(response).length > 262144 ||
    !positive(observedAt)
  )
    reject('provider-binding');
  const evidence = await digest(
    canonical([
      frozen.scopeHash,
      frozen.requestFingerprint,
      sourceJson,
      response,
      found.map((tx) => tx.id),
    ]),
  );
  const ledgerGuard = `EXISTS(SELECT 1 FROM postfinance_mutations m WHERE m.scope_hash=? AND m.fingerprint=?
    AND m.state=? AND m.claim_token=? AND m.response_json IS NULL)`;
  const values = [
    ...sourceValues(r),
    frozen.scopeHash,
    frozen.requestFingerprint,
    ledger.state,
    ledger.claim_token,
  ];
  // The unconditional final INSERT is guarded by SQL. If any conditional CAS
  // misses, its BEFORE trigger raises and rolls back every preceding write.
  await db.batch([
    db
      .prepare(`INSERT INTO prepaid_transactions(period_id,api_origin,space_id,transaction_id,created_at)
      SELECT p.period_id,c.api_origin,c.space_id,?,? ${sourceFrom} WHERE ${sourceGuard} AND ${ledgerGuard}
      ON CONFLICT(period_id) DO NOTHING`)
      .bind(transactionId, observedAt, ...values),
    db
      .prepare(`UPDATE purchase_intents SET provider_reference=? WHERE intent_id=? AND state IN('dispatched','uncertain')
      AND (provider_reference IS NULL OR provider_reference=?) AND EXISTS(SELECT 1 ${sourceFrom}
        WHERE ${sourceGuard} AND p.ordinal=0 AND ${ledgerGuard})`)
      .bind(
        String(transactionId),
        r.intent_id,
        String(transactionId),
        ...values,
      ),
    db
      .prepare(`UPDATE postfinance_mutations SET state='completed',claim_token=NULL,response_json=?,updated_at=?
      WHERE scope_hash=? AND fingerprint=? AND state=? AND claim_token=? AND response_json IS NULL
      AND EXISTS(SELECT 1 ${sourceFrom} WHERE ${sourceGuard})
      AND EXISTS(SELECT 1 FROM prepaid_transactions t WHERE t.period_id=? AND t.api_origin=? AND t.space_id=? AND t.transaction_id=?)`)
      .bind(
        response,
        observedAt,
        frozen.scopeHash,
        frozen.requestFingerprint,
        ledger.state,
        ledger.claim_token,
        ...sourceValues(r),
        r.period_id,
        r.api_origin,
        r.space_id,
        transactionId,
      ),
    db
      .prepare(`INSERT INTO prepaid_create_recoveries(period_id,contract_id,intent_id,scope_hash,request_fingerprint,
      original_claim_token,transaction_id,observed_state,observed_version,source_json,response_json,evidence_fingerprint,recovered_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(period_id) DO NOTHING`)
      .bind(
        r.period_id,
        r.contract_id,
        r.intent_id,
        frozen.scopeHash,
        frozen.requestFingerprint,
        ledger.claim_token,
        transactionId,
        String(first.state),
        first.version as number,
        sourceJson,
        response,
        evidence,
        observedAt,
      ),
  ]);
  return {
    state: 'bound',
    periodId: r.period_id,
    transactionId,
    reconciliationOnly: first.state !== 'PENDING',
  };
}
