/** Every plan includes the same current and future product features. */
export const ZENTRA_PLANS = [
  {
    id: 'solo',
    name: 'Solo',
    licensePlan: 'zentra-solo-monthly-49-chf',
    priceChfCents: 4_900,
    seats: 1,
    priceEnvironmentKey: 'STRIPE_PRICE_SOLO_ID',
  },
  {
    id: 'start',
    name: 'Start',
    licensePlan: 'zentra-start-monthly-59-chf',
    priceChfCents: 5_900,
    seats: 3,
    priceEnvironmentKey: 'STRIPE_PRICE_START_ID',
  },
  {
    id: 'pro',
    name: 'Pro',
    licensePlan: 'zentra-pro-monthly-89-chf',
    priceChfCents: 8_900,
    seats: 10,
    priceEnvironmentKey: 'STRIPE_PRICE_PRO_ID',
  },
] as const;

export type PlanId = (typeof ZENTRA_PLANS)[number]['id'];
export type ZentraPlan = (typeof ZENTRA_PLANS)[number];
export const LEGACY_PLAN = {
  id: 'legacy',
  name: 'Ancienne formule',
  licensePlan: 'zentra-monthly-50-chf',
  priceChfCents: 5_000,
  seats: null,
  priceEnvironmentKey: 'STRIPE_PRICE_ID',
} as const;
export const LEGACY_LICENSE_PLAN_IDS = [
  LEGACY_PLAN.licensePlan,
  'elyko-monthly-50-chf',
  'helvichantier-monthly-50-chf',
] as const;
export type SupportedPlan = ZentraPlan | typeof LEGACY_PLAN;

export function planById(value: unknown): ZentraPlan | undefined {
  return ZENTRA_PLANS.find((plan) => plan.id === value);
}

export function planByLicense(value: unknown): SupportedPlan | undefined {
  return (
    ZENTRA_PLANS.find((plan) => plan.licensePlan === value) ??
    (LEGACY_LICENSE_PLAN_IDS.some((id) => id === value)
      ? LEGACY_PLAN
      : undefined)
  );
}

export function validLicensePrice(plan: unknown, price: unknown): boolean {
  const definition = planByLicense(plan);
  return definition !== undefined && price === definition.priceChfCents;
}

export const PLAN_FEATURE_PROMISE =
  'Toutes les fonctionnalités actuelles et futures sont incluses dans chaque formule.';
export const PLAN_SEAT_EXPLANATION =
  'Le titulaire compte dans le total. Une personne peut utiliser plusieurs appareils. Les fiches de salariés ne consomment pas d’accès.';
