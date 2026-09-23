import { COMPLETE_PLANS, completePlan } from './plans';
import { ensureCompletePrice, ensureCompletePortalConfiguration } from './stripe';
import { assertStripeCheckoutReady } from '@/lib/stripe-readiness';
import { PublicError } from '@/lib/stripe';

/** Owner-only maintenance: prepares the approved catalog, never a customer or subscription. */
export async function prepareCompleteCatalog() {
  const checks = [];
  for (const entry of COMPLETE_PLANS) {
    const plan = completePlan(entry.id)!;
    try {
      await assertStripeCheckoutReady(plan.gestion);
      const price = await ensureCompletePrice(plan);
      checks.push({ plan: `Complet ${plan.name}`, ready: true, priceId: price.id, message: `${plan.priceChfCents / 100} CHF/mois · prêt` });
    } catch (error) {
      checks.push({ plan: `Complet ${plan.name}`, ready: false, message: error instanceof PublicError ? error.message : 'Le catalogue Stripe doit être vérifié.' });
    }
  }
  if (checks.every(check => check.ready)) {
    try {
      await ensureCompletePortalConfiguration();
      checks.push({ plan: 'Portail du pack', ready: true, message: 'Prêt' });
    } catch (error) {
      checks.push({ plan: 'Portail du pack', ready: false, message: error instanceof PublicError ? error.message : 'Le portail Stripe doit être vérifié.' });
    }
  }
  return { checks };
}
