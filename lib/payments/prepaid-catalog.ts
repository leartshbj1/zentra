import { ZENTRA_PLANS, planById, type PlanId } from '@/lib/plans';
import {
  SUPPORT_PLANS,
  supportPlan,
  type SupportPlanId,
} from '@/lib/support/plans';
import { COMPLETE_PLANS, type CompletePlanId } from '@/lib/complete/plans';
import {
  AUTOMATION_PRICE_CENTS,
  AUTOMATION_PRODUCT,
} from '@/lib/automation/types';

/** Persist this version and the complete product snapshot before a provider POST.
 * A change to a published price or entitlement requires a new catalogue version.
 * This pure catalogue does not enable any payment method or grant paid access.
 */
export const PREPAID_CATALOG_VERSION = 'zentra-prepaid-chf-monthly-v1' as const;
export type PrepaidIncludedProduct = 'gestion' | 'support' | 'automation';
export type PrepaidProductKind = PrepaidIncludedProduct | 'complete';
export type PrepaidProductKey =
  | `gestion:${PlanId}`
  | `support:${SupportPlanId}`
  | 'automation'
  | `complet:${CompletePlanId}`;

export type PrepaidGestionProjection = Readonly<{
  planId: PlanId;
  licensePlan: string;
  /** The signed Gestion licence requires this component price, not the pack price. */
  licensePriceChfMinor: number;
  seats: number;
  ownerIncluded: true;
}>;
export type PrepaidSupportProjection = Readonly<{
  planId: SupportPlanId;
  analyses: number;
}>;
export type PrepaidProduct = Readonly<{
  productKey: PrepaidProductKey;
  catalogVersion: typeof PREPAID_CATALOG_VERSION;
  productKind: PrepaidProductKind;
  planId: PlanId | SupportPlanId | CompletePlanId | typeof AUTOMATION_PRODUCT;
  name: string;
  scope: 'organization';
  currency: 'CHF';
  billingPeriod: 'P1M';
  priceChfMinor: number;
  includedProducts: readonly PrepaidIncludedProduct[];
  /** null means this purchase grants no Gestion seats; it never means unlimited. */
  gestion: PrepaidGestionProjection | null;
  /** null means this purchase grants no Support analysis quota. */
  support: PrepaidSupportProjection | null;
  automation: boolean;
}>;

function gestionProjection(planId: PlanId): PrepaidGestionProjection {
  const plan = planById(planId);
  if (!plan) throw new Error('Unknown Gestion catalogue projection.');
  return Object.freeze({
    planId: plan.id,
    licensePlan: plan.licensePlan,
    licensePriceChfMinor: plan.priceChfCents,
    seats: plan.seats,
    ownerIncluded: true,
  });
}

function supportProjection(planId: SupportPlanId): PrepaidSupportProjection {
  const plan = supportPlan(planId);
  if (!plan) throw new Error('Unknown Support catalogue projection.');
  return Object.freeze({ planId: plan.id, analyses: plan.analyses });
}

function product(
  entry: Omit<
    PrepaidProduct,
    'catalogVersion' | 'scope' | 'currency' | 'billingPeriod'
  >,
): PrepaidProduct {
  if (!Number.isSafeInteger(entry.priceChfMinor) || entry.priceChfMinor <= 0) {
    throw new Error('Invalid prepaid catalogue price.');
  }
  return Object.freeze({
    ...entry,
    includedProducts: Object.freeze([...entry.includedProducts]),
    catalogVersion: PREPAID_CATALOG_VERSION,
    scope: 'organization',
    currency: 'CHF',
    billingPeriod: 'P1M',
  });
}

const catalogue: readonly PrepaidProduct[] = Object.freeze([
  ...ZENTRA_PLANS.map((plan) =>
    product({
      productKey: `gestion:${plan.id}`,
      productKind: 'gestion',
      planId: plan.id,
      name: `Zentra Gestion ${plan.name}`,
      priceChfMinor: plan.priceChfCents,
      includedProducts: ['gestion'],
      gestion: gestionProjection(plan.id),
      support: null,
      automation: false,
    }),
  ),
  ...SUPPORT_PLANS.map((plan) =>
    product({
      productKey: `support:${plan.id}`,
      productKind: 'support',
      planId: plan.id,
      name: `Zentra Support ${plan.name}`,
      priceChfMinor: plan.priceChfCents,
      includedProducts: ['support'],
      gestion: null,
      support: supportProjection(plan.id),
      automation: false,
    }),
  ),
  product({
    productKey: 'automation',
    productKind: 'automation',
    planId: AUTOMATION_PRODUCT,
    name: 'Zentra Automation',
    priceChfMinor: AUTOMATION_PRICE_CENTS,
    includedProducts: ['automation'],
    gestion: null,
    support: null,
    automation: true,
  }),
  ...COMPLETE_PLANS.map((plan) =>
    product({
      productKey: `complet:${plan.id}`,
      productKind: 'complete',
      planId: plan.id,
      name: `Zentra Complet ${plan.name}`,
      priceChfMinor: plan.priceChfCents,
      includedProducts: ['gestion', 'support', 'automation'],
      gestion: gestionProjection(plan.gestion),
      support: supportProjection(plan.support),
      automation: true,
    }),
  ),
]);

export function prepaidCatalog(): readonly PrepaidProduct[] {
  return catalogue;
}

/** Unknown and legacy keys are not purchasable in this prepaid catalogue. */
export function prepaidProduct(
  productKey: unknown,
): PrepaidProduct | undefined {
  return catalogue.find((entry) => entry.productKey === productKey);
}
