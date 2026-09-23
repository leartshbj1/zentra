import { planById } from '@/lib/plans';
import { supportPlan } from '@/lib/support/plans';

export const COMPLETE_PRODUCT = 'zentra-complet';
export const COMPLETE_TERMS_VERSION = 'complet-2026-09-23';
export const COMPLETE_PLANS = [
  {
    id: 'solo',
    name: 'Solo',
    gestion: 'solo',
    support: 'starter',
    priceChfCents: 7900,
    description: 'Votre entreprise, à votre rythme.',
  },
  {
    id: 'team',
    name: 'Équipe',
    gestion: 'start',
    support: 'team',
    priceChfCents: 9900,
    description: 'Tout pour avancer à trois.',
  },
  {
    id: 'pro',
    name: 'Pro',
    gestion: 'pro',
    support: 'business',
    priceChfCents: 16900,
    description: 'De la place pour toute votre équipe.',
  },
] as const;
export type CompletePlanId = (typeof COMPLETE_PLANS)[number]['id'];
export function completePlan(value: unknown) {
  const p = COMPLETE_PLANS.find((p) => p.id === value);
  if (!p) return null;
  const gestion = planById(p.gestion)!;
  const support = supportPlan(p.support)!;
  const separatePrice = gestion.priceChfCents + support.priceChfCents + 1500;
  return {
    ...p,
    seats: gestion.seats,
    analyses: support.analyses,
    licensePlan: gestion.licensePlan,
    gestionName: gestion.name,
    supportName: support.name,
    separatePrice,
    saving: separatePrice - p.priceChfCents,
    productId: `zentra_complet_${p.id}_monthly_v1`,
    lookupKey: `zentra_complet_${p.id}_chf_monthly_v1`,
  };
}
export type CompletePlan = NonNullable<ReturnType<typeof completePlan>>;
