import Stripe from 'stripe';
import { constructVerifiedStripeEvent } from '../stripe-webhook';
import { usTestBillingConfiguration } from './us-saas-test-bindings';
import { d1WorkspaceCreationStore } from './workspace-creation-d1';
import { d1UsTestLifecycleStore } from './us-saas-test-lifecycle-d1';
import { stripeUsTestLifecycleGateway } from './us-saas-test-lifecycle-stripe';
import { createUsTestLifecycleHandlers, type UsTestLifecycleDependencies } from './us-saas-test-lifecycle-server';
import { UsTestBillingError, usTestStripeApiVersion } from './us-saas-test-contract';

type Bindings = Record<string, string | undefined>;
const now = () => Math.floor(Date.now() / 1000);
export function usTestLifecycleConfiguration(values: Bindings) {
  const configuration = usTestBillingConfiguration(values, { allowEmptyCatalogue: true });
  if (values.INTERNATIONAL_US_SAAS_TEST_LIFECYCLE_ENABLED !== 'true') throw new UsTestBillingError('feature_unavailable', 404);
  if (!/^whsec_[A-Za-z0-9]{16,}$/.test(values.INTERNATIONAL_US_SAAS_TEST_LIFECYCLE_WEBHOOK_SECRET ?? '')) throw new UsTestBillingError('service_unavailable', 503);
  return configuration;
}
async function bindings(): Promise<Bindings> { return (await import('cloudflare:workers')).env as unknown as Bindings; }
async function stripe() {
  const values = await bindings(); usTestLifecycleConfiguration(values);
  return { values, client: new Stripe(values.INTERNATIONAL_US_SAAS_TEST_SECRET_KEY!, { apiVersion: usTestStripeApiVersion, httpClient: Stripe.createFetchHttpClient(), timeout: 20_000, maxNetworkRetries: 0 }) };
}
export const usTestLifecycleDependencies: UsTestLifecycleDependencies = {
  async enabled() { return (await bindings()).INTERNATIONAL_US_SAAS_TEST_LIFECYCLE_ENABLED === 'true'; },
  async configuration() { return usTestLifecycleConfiguration(await bindings()); },
  async gateway() { return stripeUsTestLifecycleGateway((await stripe()).client, now); },
  async store() { return d1UsTestLifecycleStore((await import('../runtime')).database()); },
  async creations() { return d1WorkspaceCreationStore((await import('../runtime')).database()); },
  async verifyEvent(rawBody, signature) {
    const { values, client } = await stripe();
    try {
      const event = await constructVerifiedStripeEvent({ client, rawBody, signatureHeader: signature, webhookSecret: values.INTERNATIONAL_US_SAAS_TEST_LIFECYCLE_WEBHOOK_SECRET!, toleranceSeconds: 300, expectedLivemode: false, expectedApiVersion: usTestStripeApiVersion });
      if (event.account || event.context) throw new Error('Wrong event scope');
      return event;
    } catch { throw new UsTestBillingError('invalid_signature', 400); }
  },
  now,
  diagnostic(value) { console.warn('[zentra-us-test-lifecycle]', JSON.stringify(value)); },
};
export const usTestLifecycleHandlers = createUsTestLifecycleHandlers(usTestLifecycleDependencies);
