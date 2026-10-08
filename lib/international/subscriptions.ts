import { validateCompanyConfiguration } from './country-config';
import type {
  CompanyConfiguration,
  CountryCode,
  Currency,
  Money,
} from './types';

export type SaasModule = 'gestion' | 'support' | 'automation' | 'complet';
export type SubscriptionEnvironment = 'TEST' | 'PRODUCTION';
export type SubscriptionContractCode =
  | 'invalid_offer'
  | 'offer_unavailable'
  | 'ambiguous_offer'
  | 'price_mismatch'
  | 'scope_mismatch'
  | 'access_denied';

export class SubscriptionContractError extends Error {
  constructor(public readonly code: SubscriptionContractCode) {
    super(code);
    this.name = 'SubscriptionContractError';
  }
}

/** Server-approved catalogue. There is deliberately no default US entry. */
export interface SaasSubscriptionOffer {
  readonly kind: 'saas_subscription';
  readonly catalogVersion: string;
  readonly country: CountryCode;
  readonly currency: Currency;
  readonly module: SaasModule;
  readonly plan: string;
  readonly priceId: string;
  readonly productId: string;
  readonly environment: SubscriptionEnvironment;
  readonly unitAmountMinor: string;
  readonly interval: 'month' | 'year';
  readonly intervalCount: number;
  readonly taxBehavior: 'inclusive' | 'exclusive';
}

/** Read from Stripe on the server; not a client claim or a payment receipt. */
export interface ServerStripePrice {
  readonly id: string;
  readonly active: boolean;
  readonly livemode: boolean;
  readonly currency: string;
  readonly unit_amount: number | null;
  readonly type: 'recurring' | 'one_time';
  readonly tax_behavior: 'inclusive' | 'exclusive' | 'unspecified';
  readonly recurring: {
    readonly interval: string;
    readonly interval_count: number;
    readonly usage_type: string;
  } | null;
  readonly product:
    | {
        readonly id: string;
        readonly active: boolean;
        readonly deleted?: boolean;
      }
    | string
    | null;
}

const modules: readonly SaasModule[] = [
  'gestion',
  'support',
  'automation',
  'complet',
];
const environments: readonly SubscriptionEnvironment[] = ['TEST', 'PRODUCTION'];
const key = (value: unknown) =>
  typeof value === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const instant = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function assertOffer(offer: SaasSubscriptionOffer): void {
  if (
    !offer ||
    offer.kind !== 'saas_subscription' ||
    !key(offer.catalogVersion) ||
    !key(offer.plan) ||
    !modules.includes(offer.module) ||
    !environments.includes(offer.environment) ||
    !['CH', 'US'].includes(offer.country) ||
    offer.currency !== (offer.country === 'CH' ? 'CHF' : 'USD') ||
    !/^price_[A-Za-z0-9_]+$/.test(offer.priceId) ||
    !/^prod_[A-Za-z0-9_]+$/.test(offer.productId) ||
    typeof offer.unitAmountMinor !== 'string' ||
    !/^[1-9][0-9]{0,15}$/.test(offer.unitAmountMinor) ||
    BigInt(offer.unitAmountMinor) > BigInt(Number.MAX_SAFE_INTEGER) ||
    !['month', 'year'].includes(offer.interval) ||
    !Number.isSafeInteger(offer.intervalCount) ||
    offer.intervalCount < 1 ||
    !['inclusive', 'exclusive'].includes(offer.taxBehavior)
  ) {
    throw new SubscriptionContractError('invalid_offer');
  }
}

/** Shared server validation; it does not create or approve a catalogue entry. */
export function validateSubscriptionOffer(offer: SaasSubscriptionOffer): SaasSubscriptionOffer {
  assertOffer(offer);
  return Object.freeze({ ...offer });
}

export function resolveSubscriptionOffer(
  company: CompanyConfiguration,
  selection: {
    readonly module: SaasModule;
    readonly plan: string;
    readonly environment: SubscriptionEnvironment;
  },
  trustedCatalog: readonly SaasSubscriptionOffer[],
): Readonly<SaasSubscriptionOffer> {
  const context = validateCompanyConfiguration(company);
  if (
    !modules.includes(selection.module) ||
    !environments.includes(selection.environment) ||
    !key(selection.plan)
  ) {
    throw new SubscriptionContractError('invalid_offer');
  }
  for (const offer of trustedCatalog) assertOffer(offer);
  const matches = trustedCatalog.filter(
    (offer) =>
      offer.country === context.country &&
      offer.currency === context.currency &&
      offer.module === selection.module &&
      offer.plan === selection.plan &&
      offer.environment === selection.environment,
  );
  if (matches.length === 0)
    throw new SubscriptionContractError('offer_unavailable');
  if (matches.length !== 1)
    throw new SubscriptionContractError('ambiguous_offer');
  return Object.freeze({ ...matches[0] });
}

export function verifyServerStripePrice(
  offer: SaasSubscriptionOffer,
  price: ServerStripePrice,
): Readonly<SaasSubscriptionOffer> {
  assertOffer(offer);
  if (
    !price ||
    price.id !== offer.priceId ||
    price.active !== true ||
    typeof price.livemode !== 'boolean' ||
    price.livemode !== (offer.environment === 'PRODUCTION') ||
    price.currency !== offer.currency.toLowerCase() ||
    !Number.isSafeInteger(price.unit_amount) ||
    String(price.unit_amount) !== offer.unitAmountMinor ||
    price.type !== 'recurring' ||
    price.tax_behavior !== offer.taxBehavior ||
    price.recurring?.interval !== offer.interval ||
    price.recurring.interval_count !== offer.intervalCount ||
    price.recurring.usage_type !== 'licensed' ||
    !price.product ||
    typeof price.product === 'string' ||
    price.product.id !== offer.productId ||
    price.product.active !== true ||
    price.product.deleted === true
  ) {
    throw new SubscriptionContractError('price_mismatch');
  }
  return Object.freeze({ ...offer });
}

/** Must originate in an authoritative verified-payment or separately authorized-trial sink. */
export interface SubscriptionEvidence {
  readonly kind: 'verified_payment' | 'authorized_trial';
  readonly referenceId: string;
  readonly organizationId: string;
  readonly subscriptionId: string;
  readonly environment: SubscriptionEnvironment;
  readonly catalogVersion: string;
  readonly priceId: string;
  readonly currency: Currency;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly revoked: boolean;
}

export interface SaasSubscriptionAuthority {
  readonly kind: 'saas_subscription_authority';
  readonly organizationId: string;
  readonly subscriptionId: string;
  readonly offer: SaasSubscriptionOffer;
  readonly status:
    | 'active'
    | 'past_due'
    | 'trialing'
    | 'canceled'
    | 'expired'
    | 'incomplete';
  readonly evidence: SubscriptionEvidence | null;
}

export interface SubscriptionRights {
  readonly organizationId: string;
  readonly module: SaasModule;
  readonly access: 'read_write' | 'read_only';
  readonly reason:
    | 'active'
    | 'missing_subscription'
    | 'scope_mismatch'
    | 'missing_evidence'
    | 'revoked'
    | 'expired'
    | 'inactive';
}

/** Configuration/preferences have no grant path. Cache status alone never enables writes. */
export function subscriptionRights(
  company: CompanyConfiguration,
  authority: SaasSubscriptionAuthority | null,
  expected: {
    readonly module: SaasModule;
    readonly environment: SubscriptionEnvironment;
    readonly now: number;
  },
): SubscriptionRights {
  const context = validateCompanyConfiguration(company);
  if (
    !modules.includes(expected.module) ||
    !environments.includes(expected.environment) ||
    !instant(expected.now)
  ) {
    throw new SubscriptionContractError('scope_mismatch');
  }
  const result = (reason: SubscriptionRights['reason']): SubscriptionRights =>
    Object.freeze({
      organizationId: context.organizationId,
      module: expected.module,
      access: reason === 'active' ? 'read_write' : 'read_only',
      reason,
    });
  if (!authority) return result('missing_subscription');
  try {
    assertOffer(authority.offer);
  } catch {
    return result('scope_mismatch');
  }
  if (
    authority.kind !== 'saas_subscription_authority' ||
    !key(authority.subscriptionId) ||
    authority.organizationId !== context.organizationId ||
    authority.offer.country !== context.country ||
    authority.offer.currency !== context.currency ||
    authority.offer.environment !== expected.environment ||
    (authority.offer.module !== expected.module &&
      authority.offer.module !== 'complet')
  )
    return result('scope_mismatch');
  const proof = authority.evidence;
  if (!proof) return result('missing_evidence');
  if (
    !['verified_payment', 'authorized_trial'].includes(proof.kind) ||
    !key(proof.referenceId) ||
    proof.organizationId !== context.organizationId ||
    proof.subscriptionId !== authority.subscriptionId ||
    proof.environment !== expected.environment ||
    proof.catalogVersion !== authority.offer.catalogVersion ||
    proof.priceId !== authority.offer.priceId ||
    proof.currency !== authority.offer.currency ||
    !instant(proof.startsAt) ||
    !instant(proof.endsAt) ||
    proof.endsAt <= proof.startsAt ||
    typeof proof.revoked !== 'boolean'
  )
    return result('scope_mismatch');
  if (proof.revoked) return result('revoked');
  if (proof.startsAt > expected.now || proof.endsAt <= expected.now)
    return result('expired');
  if (
    proof.kind === 'authorized_trial'
      ? authority.status !== 'trialing'
      : !['active', 'past_due', 'canceled'].includes(authority.status)
  ) {
    return result('inactive');
  }
  return result('active');
}

/** Proposal only: retains organization/subscription/history; no provider call or data wipe. */
export function proposeSubscriptionPlanChange(
  company: CompanyConfiguration,
  current: SaasSubscriptionAuthority,
  target: SaasSubscriptionOffer,
  now: number,
) {
  assertOffer(target);
  if (
    subscriptionRights(company, current, {
      module: current.offer.module,
      environment: target.environment,
      now,
    }).access !== 'read_write'
  ) {
    throw new SubscriptionContractError('access_denied');
  }
  if (
    target.country !== company.country ||
    target.currency !== company.currency ||
    target.module !== current.offer.module
  ) {
    throw new SubscriptionContractError('scope_mismatch');
  }
  return Object.freeze({
    kind: 'saas_plan_change' as const,
    organizationId: company.organizationId,
    subscriptionId: current.subscriptionId,
    previousOffer: Object.freeze({ ...current.offer }),
    targetOffer: Object.freeze({ ...target }),
    requiresProviderConfirmation: true as const,
    preserveExistingData: true as const,
  });
}

/** Customer invoices use their own merchant authority, not Zentra's SaaS credentials. */
export interface BusinessInvoicePaymentProposal {
  readonly kind: 'business_invoice_payment';
  readonly organizationId: string;
  readonly invoiceId: string;
  readonly amount: Money;
  readonly method: 'card' | 'ach' | 'bank_transfer';
  readonly merchantBindingId: string;
  readonly requiresHumanApproval: true;
}
