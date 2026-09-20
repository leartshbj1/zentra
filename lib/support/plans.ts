export const SUPPORT_LEGAL_VERSION = 'support-2026-09-19';
export const SUPPORT_PRODUCT = 'zentra-support';
export const SUPPORT_PLANS = [
  {
    id: 'starter',
    name: 'Starter',
    priceChfCents: 2900,
    analyses: 2000,
    description: 'Pour un support qui démarre.',
  },
  {
    id: 'team',
    name: 'Équipe',
    priceChfCents: 4900,
    analyses: 5000,
    description: 'Pour les demandes du quotidien.',
  },
  {
    id: 'business',
    name: 'Business',
    priceChfCents: 9900,
    analyses: 15000,
    description: 'Pour un volume plus important.',
  },
] as const;
export type SupportPlanId = (typeof SUPPORT_PLANS)[number]['id'];
export function supportPlan(value: unknown) {
  return SUPPORT_PLANS.find((p) => p.id === value);
}
export type SupportBillingState = {
  active: boolean;
  ownerAccess: boolean;
  offeredAccess?: boolean;
  offeredUntil?: number | null;
  ready: boolean;
  testMode: boolean;
  plan: SupportPlanId | null;
  status: string;
  used: number;
  limit: number;
  periodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  hasSubscription: boolean;
};
