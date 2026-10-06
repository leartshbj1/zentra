import { LEGAL_VERSION } from '@/lib/legal';
import { SUPPORT_LEGAL_VERSION } from '@/lib/support/plans';
import { COMPLETE_TERMS_VERSION } from '@/lib/complete/plans';
import { AUTOMATION_TERMS_VERSION } from '@/lib/automation/billing';
import { AUTOMATION_CONSENT_VERSION } from '@/lib/automation/config';
import {
  CheckoutUnavailable,
  type CheckoutConfiguration,
  type SwissMethod,
} from './postfinance-client';
import { authorizePrepaidPurchase } from './prepaid-purchase-access';
import { D1PurchaseIntents } from './purchase-intents';
import { D1PrepaidPeriods, type PrepaidContractInput } from './prepaid-periods';
import { D1PrepaidReconciliationStore } from './prepaid-reconciliation-store';
import { D1PrepaidProvisioning } from './prepaid-provisioning';

export type PrepaidPurchaseConfiguration = Readonly<{
  enabled: boolean;
  settlementEvidenceVerified: boolean;
  connection: CheckoutConfiguration;
  connectorConfigurations: Partial<Record<SwissMethod, number>>;
}>;
export class PrepaidPreparationError extends Error {
  constructor(
    public readonly code: 'request' | 'terms' | 'state' | 'configuration',
  ) {
    super(`Prepaid preparation ${code}.`);
  }
}
const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
async function customerReference(ownerId: string) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ownerId)),
  );
  return (
    'pfpayer_' +
    Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  );
}

/** Prepares a durable, authorized initial purchase; no provider call or paid
 * projection occurs here. A future server purchase entrypoint must supply this
 * server-owned configuration, enforce same-origin/rate limits and authenticate
 * user freshly. Never return the internal parameters directly to a browser. */
export async function prepareInitialPrepaidPurchase(
  configuration: PrepaidPurchaseConfiguration,
  input: {
    user: { userId: string; email: string; emailConfirmed: boolean };
    requestId: string;
    productKey: unknown;
    organizationId?: unknown;
    workspaceId?: unknown;
    method: SwissMethod;
    acceptTerms: boolean;
    legalVersion: string;
    consentVersion?: string;
  },
  dependencies: {
    database: () => Pick<D1Database, 'prepare' | 'batch'>;
    now?: () => number;
  },
) {
  if (configuration.enabled !== true) return { state: 'disabled' as const };
  const connection = configuration.connection;
  const origin = connection.apiOrigin ?? 'https://checkout.postfinance.ch';
  if (
    connection.enabled !== true ||
    connection.merchantApproved !== true ||
    connection.prepaidFeatureEnabled !== true ||
    connection.chargeFlowEnabled !== true ||
    !['PRODUCTION', 'TEST'].includes(connection.prepaidEnvironment ?? '') ||
    (connection.prepaidEnvironment === 'PRODUCTION' &&
      configuration.settlementEvidenceVerified !== true) ||
    !['https://checkout.postfinance.ch', 'https://app-wallee.com'].includes(
      origin,
    ) ||
    !positive(connection.spaceId) ||
    !/^[1-9][0-9]{0,15}$/.test(connection.applicationUserId ?? '') ||
    !positive(Number(connection.applicationUserId)) ||
    !/^[A-Za-z0-9+/]{43}=$/.test(connection.authenticationKeyBase64 ?? '')
  )
    throw new CheckoutUnavailable(
      'PostFinance purchase configuration is unavailable.',
    );
  try {
    const key = connection.authenticationKeyBase64!;
    if (atob(key).length !== 32 || btoa(atob(key)) !== key) throw new Error();
    const returns = new URL(connection.returnOrigin!);
    if (
      returns.protocol !== 'https:' ||
      returns.origin !== connection.returnOrigin ||
      returns.username ||
      returns.password
    )
      throw new Error();
  } catch {
    throw new PrepaidPreparationError('configuration');
  }
  if (
    !/^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.test(
      input.requestId,
    ) ||
    !['postfinance_pay', 'twint'].includes(input.method)
  )
    throw new PrepaidPreparationError('request');
  if (
    (input.method === 'postfinance_pay' &&
      connection.postfinancePayTokenEnabled !== true) ||
    (input.method === 'twint' && connection.twintUserOnFileEnabled !== true)
  )
    throw new PrepaidPreparationError('configuration');
  const db = dependencies.database(),
    now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));
  const authority = await authorizePrepaidPurchase(db, input.user, input);
  const product = authority.product;
  const version =
    product.productKind === 'gestion'
      ? LEGAL_VERSION
      : product.productKind === 'support'
        ? SUPPORT_LEGAL_VERSION
        : product.productKind === 'complete'
          ? COMPLETE_TERMS_VERSION
          : AUTOMATION_TERMS_VERSION;
  if (
    input.acceptTerms !== true ||
    input.legalVersion !== version ||
    (product.productKind === 'automation' &&
      input.consentVersion !== AUTOMATION_CONSENT_VERSION)
  )
    throw new PrepaidPreparationError('terms');
  const providerProduct = connection.prepaidProducts?.[product.productKey];
  const methodConfigurationId =
    providerProduct?.methodConfigurations[input.method];
  const connectorConfigurationId =
    configuration.connectorConfigurations[input.method];
  if (
    !providerProduct ||
    providerProduct.currency !== 'CHF' ||
    providerProduct.billingPeriod !== 'P1M' ||
    providerProduct.priceChfMinor !== product.priceChfMinor ||
    providerProduct.reference !== product.catalogVersion ||
    providerProduct.name !== product.name ||
    !positive(methodConfigurationId) ||
    !positive(connectorConfigurationId)
  )
    throw new PrepaidPreparationError('configuration');
  const environment = connection.prepaidEnvironment!;
  // Server-owned compare-and-swap target. A delayed settlement must never
  // replace whichever subscription happens to be current when it arrives.
  const previous =
    authority.organizationId === null
      ? null
      : await db
          .prepare(`SELECT o.subscription_id FROM organizations o JOIN organization_members m
      ON m.organization_id=o.organization_id AND m.user_id=o.created_by_user_id
      AND m.role='owner' AND m.revoked_at IS NULL
      WHERE o.organization_id=? AND o.created_by_user_id=?`)
          .bind(authority.organizationId, authority.ownerId)
          .first<{ subscription_id: string }>();
  if (authority.organizationId !== null && !previous)
    throw new PrepaidPreparationError('state');
  const previousSubscriptionId = previous?.subscription_id ?? null;
  const intent = await new D1PurchaseIntents(db, now).reserve({
    ownerId: authority.ownerId,
    environment,
    provider: 'postfinance',
    providerScope: `${origin}|${connection.spaceId}`,
    product: product.productKind,
    organizationId: authority.organizationId,
    workspaceId: authority.workspaceId,
    planId: product.planId,
    parameters: {
      requestId: input.requestId,
      productKey: product.productKey,
      priceChfMinor: product.priceChfMinor,
      catalogVersion: product.catalogVersion,
      name: product.name,
      emailAddress: authority.emailAddress,
      returnOrigin: connection.returnOrigin!,
      method: input.method,
      methodConfigurationId,
      connectorConfigurationId,
      previousSubscriptionId,
    },
    terms: {
      version,
      consentVersion:
        product.productKind === 'automation'
          ? AUTOMATION_CONSENT_VERSION
          : null,
      origin: connection.returnOrigin!,
    },
  });
  if (
    !['reserved', 'dispatched', 'uncertain'].includes(intent.state) ||
    intent.expiresAt <= now()
  )
    throw new PrepaidPreparationError('state');
  const contract: PrepaidContractInput = {
    contractId: 'pfp_' + intent.intentId.slice('purchase_'.length),
    ownerId: authority.ownerId,
    organizationId: authority.organizationId,
    workspaceId: authority.workspaceId,
    apiOrigin: origin,
    spaceId: connection.spaceId!,
    environment,
    productKey: product.productKey,
  };
  const periods = new D1PrepaidPeriods(db, now);
  await periods.createContract(contract);
  const period = await periods.reservePeriod(contract.contractId, 0);
  if (period.startsAt > now() || period.endsAt <= now())
    throw new PrepaidPreparationError('state');
  const expectation = {
    customerReference: await customerReference(authority.ownerId),
    planReference: period.catalogVersion,
    paymentMethodConfigurationId: methodConfigurationId,
    connectorConfigurationId,
  };
  await new D1PrepaidReconciliationStore(db, now).freezeExpectation(
    period.periodId,
    expectation,
  );
  const target = await new D1PrepaidProvisioning(db, now).freezeTarget({
    intentId: intent.intentId,
    contractId: contract.contractId,
    ownerId: authority.ownerId,
    organizationId: authority.organizationId,
    workspaceId: authority.workspaceId,
    previousSubscriptionId,
  });
  return {
    state: 'prepared' as const,
    intent,
    contract,
    period,
    expectation,
    target,
    createInput: {
      productKey: product.productKey,
      periodId: period.periodId,
      customerReference: expectation.customerReference,
      emailAddress: authority.emailAddress,
      urls: {
        successUrl: `${connection.returnOrigin}/compte?paiement=confirmation&achat=${intent.intentId}`,
        failureUrl: `${connection.returnOrigin}/pricing?paiement=annule&achat=${intent.intentId}`,
      },
    },
    businessKeys: {
      create: `${period.periodId}_create`,
      confirm: `${period.periodId}_confirm`,
      chargeflow: `${period.periodId}_chargeflow`,
    },
  };
}
