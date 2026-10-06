import { prepaidCatalog, prepaidProduct } from './prepaid-catalog';
import { CheckoutUnavailable, type SwissMethod } from './postfinance-client';
import type { PrepaidPurchaseConfiguration } from './prepaid-purchase-preparation';

export type PostFinancePurchaseBinding =
  | 'POSTFINANCE_PURCHASES_ENABLED'
  | 'POSTFINANCE_MERCHANT_APPROVED'
  | 'POSTFINANCE_API_ORIGIN'
  | 'POSTFINANCE_APPLICATION_USER_ID'
  | 'POSTFINANCE_AUTHENTICATION_KEY_BASE64'
  | 'POSTFINANCE_SPACE_ID'
  | 'POSTFINANCE_RETURN_ORIGIN'
  | 'POSTFINANCE_PREPAID_ENVIRONMENT'
  | 'POSTFINANCE_PREPAID_CATALOG_JSON'
  | 'POSTFINANCE_PREPAID_CONNECTORS_JSON'
  | 'POSTFINANCE_CHARGE_FLOW_ENABLED'
  | 'POSTFINANCE_PAY_TOKEN_ENABLED'
  | 'POSTFINANCE_TWINT_USER_ON_FILE_ENABLED'
  | 'POSTFINANCE_SETTLEMENT_EVIDENCE_VERIFIED'
  | 'POSTFINANCE_TEST_ACCOUNT_USER_IDS';

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function parse(raw: string): Record<string, unknown> {
  if (!raw || new TextEncoder().encode(raw).byteLength > 16_384)
    throw new CheckoutUnavailable('Invalid server payment configuration.');
  const value: unknown = JSON.parse(raw);
  if (!record(value))
    throw new CheckoutUnavailable('Invalid server payment configuration.');
  return value;
}

/** All bindings are private deployment settings. They must never be populated
 * from a query, request JSON, user profile or browser preference. Off reads only
 * the activation switch, and deliberately returns before parsing credentials. */
export function postFinancePurchaseConfiguration(
  read: (name: PostFinancePurchaseBinding) => string,
): PrepaidPurchaseConfiguration {
  if (read('POSTFINANCE_PURCHASES_ENABLED') !== 'true')
    return {
      enabled: false,
      settlementEvidenceVerified: false,
      connection: { enabled: false },
      connectorConfigurations: {},
    };
  try {
    const apiOrigin = read('POSTFINANCE_API_ORIGIN'),
      spaceId = Number(read('POSTFINANCE_SPACE_ID')),
      applicationUserId = read('POSTFINANCE_APPLICATION_USER_ID'),
      key = read('POSTFINANCE_AUTHENTICATION_KEY_BASE64'),
      returnOrigin = read('POSTFINANCE_RETURN_ORIGIN'),
      environment = read('POSTFINANCE_PREPAID_ENVIRONMENT');
    if (
      !['https://checkout.postfinance.ch', 'https://app-wallee.com'].includes(
        apiOrigin,
      ) ||
      !positive(spaceId) ||
      !/^[1-9][0-9]{0,15}$/.test(applicationUserId) ||
      !positive(Number(applicationUserId)) ||
      !/^[A-Za-z0-9+/]{43}=$/.test(key) ||
      atob(key).length !== 32 ||
      btoa(atob(key)) !== key ||
      !['TEST', 'PRODUCTION'].includes(environment) ||
      read('POSTFINANCE_MERCHANT_APPROVED') !== 'true' ||
      read('POSTFINANCE_CHARGE_FLOW_ENABLED') !== 'true' ||
      (environment === 'PRODUCTION' &&
        read('POSTFINANCE_SETTLEMENT_EVIDENCE_VERIFIED') !== 'true')
    )
      throw new Error();
    const returns = new URL(returnOrigin);
    if (
      returns.protocol !== 'https:' ||
      returns.origin !== returnOrigin ||
      returns.username ||
      returns.password
    )
      throw new Error();
    const connectorConfigurations: Partial<Record<SwissMethod, number>> = {};
    const rawConnectors = parse(read('POSTFINANCE_PREPAID_CONNECTORS_JSON'));
    for (const [method, value] of Object.entries(rawConnectors)) {
      if (!['postfinance_pay', 'twint'].includes(method) || !positive(value))
        throw new Error();
      connectorConfigurations[method as SwissMethod] = value;
    }
    const prepaidProducts: NonNullable<
      PrepaidPurchaseConfiguration['connection']['prepaidProducts']
    > = {};
    const catalog = parse(read('POSTFINANCE_PREPAID_CATALOG_JSON'));
    if (
      !Object.keys(catalog).length ||
      Object.keys(catalog).length > prepaidCatalog().length
    )
      throw new Error();
    for (const [productKey, value] of Object.entries(catalog)) {
      const product = prepaidProduct(productKey);
      if (
        !product ||
        !record(value) ||
        Object.keys(value).some(
          (key) =>
            ![
              'currency',
              'billingPeriod',
              'priceChfMinor',
              'reference',
              'name',
              'methodConfigurations',
            ].includes(key),
        ) ||
        value.currency !== 'CHF' ||
        value.billingPeriod !== 'P1M' ||
        value.priceChfMinor !== product.priceChfMinor ||
        value.reference !== product.catalogVersion ||
        value.name !== product.name ||
        !record(value.methodConfigurations)
      )
        throw new Error();
      const methodConfigurations: Partial<Record<SwissMethod, number>> = {};
      for (const [method, id] of Object.entries(value.methodConfigurations)) {
        if (
          !['postfinance_pay', 'twint'].includes(method) ||
          !positive(id) ||
          !connectorConfigurations[method as SwissMethod]
        )
          throw new Error();
        if (
          read(
            method === 'postfinance_pay'
              ? 'POSTFINANCE_PAY_TOKEN_ENABLED'
              : 'POSTFINANCE_TWINT_USER_ON_FILE_ENABLED',
          ) !== 'true'
        )
          throw new Error();
        methodConfigurations[method as SwissMethod] = id;
      }
      if (!Object.keys(methodConfigurations).length) throw new Error();
      prepaidProducts[productKey] = {
        currency: 'CHF',
        billingPeriod: 'P1M',
        priceChfMinor: product.priceChfMinor,
        reference: product.catalogVersion,
        name: product.name,
        methodConfigurations,
      };
    }
    return {
      enabled: true,
      settlementEvidenceVerified:
        read('POSTFINANCE_SETTLEMENT_EVIDENCE_VERIFIED') === 'true',
      connectorConfigurations,
      connection: {
        enabled: true,
        apiOrigin: apiOrigin as
          | 'https://checkout.postfinance.ch'
          | 'https://app-wallee.com',
        applicationUserId,
        authenticationKeyBase64: key,
        spaceId,
        returnOrigin,
        merchantApproved: true,
        chargeFlowEnabled: true,
        prepaidFeatureEnabled: true,
        prepaidEnvironment: environment as 'TEST' | 'PRODUCTION',
        prepaidProducts,
        postfinancePayTokenEnabled:
          read('POSTFINANCE_PAY_TOKEN_ENABLED') === 'true',
        twintUserOnFileEnabled:
          read('POSTFINANCE_TWINT_USER_ON_FILE_ENABLED') === 'true',
      },
    };
  } catch {
    throw new CheckoutUnavailable(
      'PostFinance purchase configuration is unavailable.',
    );
  }
}

/** TEST purchases remain private and never issue production entitlements.
 * A verified identity is necessary independently of this exact ID allowlist. */
export function postFinanceTestPurchaseAllowed(
  configuration: PrepaidPurchaseConfiguration,
  userId: string,
  read: (name: PostFinancePurchaseBinding) => string,
) {
  if (configuration.connection.prepaidEnvironment === 'PRODUCTION') return true;
  try {
    const raw = read('POSTFINANCE_TEST_ACCOUNT_USER_IDS');
    if (!raw || raw.length > 4096) return false;
    const ids: unknown = JSON.parse(raw);
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 20 ||
      ids.some(
        (id) =>
          typeof id !== 'string' ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
            id,
          ),
      ) ||
      new Set(ids).size !== ids.length
    )
      return false;
    return ids.includes(userId);
  } catch {
    return false;
  }
}
