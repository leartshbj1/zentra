import type Stripe from 'stripe';
import { AccountPublicError } from '@/lib/account-security';
import { runtimeValue } from '@/lib/runtime';
import { STRIPE_API_VERSION } from '@/lib/stripe';
import { stripeSecretKeyLivemode } from '@/lib/stripe-event';

/** Ask Stripe to redeliver an existing, non-financial event. Never forge proof. */
export async function retryStripeDeliveryCheck(stripe: Stripe) {
  const endpointId = runtimeValue('STRIPE_WEBHOOK_ENDPOINT_ID');
  const live = stripeSecretKeyLivemode(runtimeValue('STRIPE_SECRET_KEY'));
  const hook = await stripe.webhookEndpoints.retrieve(endpointId);
  if (
    live === null ||
    hook.id !== endpointId ||
    hook.livemode !== live ||
    hook.status !== 'enabled' ||
    hook.api_version !== STRIPE_API_VERSION ||
    hook.url !== runtimeValue('PUBLIC_SITE_URL') + '/api/stripe/webhook' ||
    !hook.enabled_events.some((e) => e === '*' || e === 'customer.created')
  ) {
    throw new AccountPublicError(
      'Vérifiez d’abord la destination des notifications Stripe.',
      503,
    );
  }
  const since = Math.floor(Date.now() / 1000) - 29 * 86400;
  const events = await stripe.events.list({
    type: 'customer.created',
    created: { gte: since },
    limit: 100,
  });
  const event = events.data.find(
    (e) =>
      e.type === 'customer.created' &&
      e.livemode === live &&
      e.api_version === STRIPE_API_VERSION &&
      e.created >= since &&
      /^evt_[A-Za-z0-9]+$/.test(e.id),
  );
  if (!event)
    throw new AccountPublicError(
      'Aucune notification compatible récente. Envoyez un événement de test depuis le tableau de bord Stripe.',
      409,
    );
  // Same endpoint used by the official Stripe CLI `events resend` command.
  await stripe.rawRequest('POST', `/v1/events/${event.id}/retry`, {
    webhook_endpoint: endpointId,
  });
  return { requested: true };
}
