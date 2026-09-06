import { Check, UserRound, Users } from 'lucide-react';
import { PurchaseButton } from '@/components/purchase-button';
import {
  PLAN_FEATURE_PROMISE,
  PLAN_SEAT_EXPLANATION,
  ZENTRA_PLANS,
} from '@/lib/plans';

export function PricingPlans() {
  return (
    <div>
      <div className="grid gap-4 md:grid-cols-3">
        {ZENTRA_PLANS.map((plan) => (
          <article
            key={plan.id}
            id={plan.id}
            className="flex scroll-mt-28 flex-col rounded-3xl border border-[#d6d2c8] bg-white p-6 text-[#173d2c] sm:p-8"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-2xl font-semibold tracking-tight">
                {plan.name}
              </h2>
              {plan.seats === 1 ? (
                <UserRound className="size-5 text-[#788a7d]" />
              ) : (
                <Users className="size-5 text-[#788a7d]" />
              )}
            </div>
            <p className="mt-3 min-h-12 text-sm leading-6 text-[#657068]">
              {plan.id === 'solo'
                ? 'Votre entreprise, à votre rythme.'
                : plan.id === 'start'
                  ? 'Un espace pour votre petite équipe.'
                  : 'De la place pour votre équipe au complet.'}
            </p>
            <p className="mt-6">
              <strong className="text-5xl font-semibold tracking-[-.06em]">
                {plan.priceChfCents / 100}
              </strong>
              <span className="ml-2 text-sm text-[#657068]">CHF / mois</span>
            </p>
            <p className="mt-6 border-t border-[#e5e5df] pt-5 text-lg font-semibold">
              {plan.seats === 1
                ? '1 personne'
                : `Jusqu’à ${plan.seats} personnes`}
            </p>
            <p className="mt-1 text-sm text-[#657068]">Titulaire compris</p>
            <ul className="my-6 space-y-3 text-sm leading-6">
              {[
                'Toutes les fonctions actuelles',
                'Toutes les fonctions futures',
                'Mises à jour incluses',
                'Plusieurs appareils par personne',
              ].map((feature) => (
                <li key={feature} className="flex gap-2">
                  <Check
                    aria-hidden="true"
                    className="mt-1 size-4 shrink-0 text-[#41805b]"
                  />
                  {feature}
                </li>
              ))}
            </ul>
            <div className="mt-auto">
              <PurchaseButton planId={plan.id} compact />
            </div>
          </article>
        ))}
      </div>
      <p className="mt-6 text-center text-sm font-medium leading-6 text-[#354e40]">
        {PLAN_FEATURE_PROMISE}
      </p>
      <p className="mx-auto mt-2 max-w-3xl text-center text-sm leading-6 text-[#657068]">
        {PLAN_SEAT_EXPLANATION} Prix mensuels en CHF, taxe incluse lorsqu’elle
        s’applique.
      </p>
    </div>
  );
}
