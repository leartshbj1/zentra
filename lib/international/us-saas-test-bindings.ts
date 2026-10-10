import Stripe from 'stripe';
import { assertDeploymentRuntime, deploymentBindingReader, deploymentProfile, isSandboxDeployment } from '../deployment-contract';
import { constructVerifiedStripeEvent } from '../stripe-webhook';
import { parseUsSaasPolicy } from './saas-authority-d1';
import { canonicalCreationJson, createOrResumeUsWorkspace } from './workspace-creation';
import { workspaceCreationDependencies } from './workspace-creation-server';
import { d1WorkspaceCreationStore } from './workspace-creation-d1';
import { d1UsTestPurchaseStore } from './us-saas-test-d1';
import { stripeUsTestGateway } from './us-saas-test-stripe';
import { UsTestBillingError, usTestStripeApiVersion } from './us-saas-test-contract';
import { createUsTestBillingHandlers, type UsTestBillingConfiguration, type UsTestBillingDependencies } from './us-saas-test-server';

type UsTestBindings = Record<string, string | undefined>;
const now = () => Math.floor(Date.now() / 1000);
/** An explicit sandbox deployment and dedicated TEST credentials are required.
 * No CH secret, merchant key, price, trial or production fallback is consulted. */
export function usTestBillingConfiguration(bindings: UsTestBindings): UsTestBillingConfiguration {
  if (!isSandboxDeployment) throw new UsTestBillingError('feature_unavailable', 404);
  assertDeploymentRuntime(deploymentBindingReader(bindings));
  if (['INTERNATIONAL_CORE_ENABLED', 'INTERNATIONAL_US_CREATION_ENABLED', 'INTERNATIONAL_US_SAAS_TEST_ENABLED'].some(flag => bindings[flag] !== 'true')) throw new UsTestBillingError('feature_unavailable', 404);
  if (bindings.INTERNATIONAL_US_BILLING_ENVIRONMENT !== 'TEST' || bindings.INTERNATIONAL_US_SAAS_TEST_TAX_MODE !== 'sandbox_no_tax' || !/^rk_test_[A-Za-z0-9]{16,}$/.test(bindings.INTERNATIONAL_US_SAAS_TEST_SECRET_KEY ?? '') || !/^whsec_[A-Za-z0-9]{16,}$/.test(bindings.INTERNATIONAL_US_SAAS_TEST_WEBHOOK_SECRET ?? '') || !/^acct_[A-Za-z0-9]+$/.test(bindings.INTERNATIONAL_US_SAAS_TEST_ACCOUNT_ID ?? '') || bindings.PUBLIC_SITE_URL !== deploymentProfile.siteOrigin) throw new UsTestBillingError('service_unavailable', 503);
  const policy = parseUsSaasPolicy(bindings, now());
  const eligible = policy.catalog.filter(entry => ['gestion', 'complet'].includes(entry.offer.module));
  if (!eligible.length || eligible.length > 20 || new Set(eligible.map(entry => canonicalCreationJson([entry.offer.module, entry.offer.plan]))).size !== eligible.length) throw new UsTestBillingError('service_unavailable', 503);
  return { policy, providerAccountId: bindings.INTERNATIONAL_US_SAAS_TEST_ACCOUNT_ID!, siteOrigin: deploymentProfile.siteOrigin };
}
async function bindings(): Promise<UsTestBindings> { return (await import('cloudflare:workers')).env as unknown as UsTestBindings; }
export async function usTestBillingEnabled(): Promise<boolean> {
  try { usTestBillingConfiguration(await bindings()); return true; } catch { return false; }
}
async function stripe() {
  const values = await bindings(); usTestBillingConfiguration(values);
  return { client: new Stripe(values.INTERNATIONAL_US_SAAS_TEST_SECRET_KEY!, { apiVersion: usTestStripeApiVersion, httpClient: Stripe.createFetchHttpClient(), timeout: 20_000, maxNetworkRetries: 0 }), values };
}
function integrationIdentifier(): string {
  // Rejection sampling avoids modulo bias; persisted once before provider dispatch.
  let suffix = '';
  while (suffix.length < 8) for (const value of crypto.getRandomValues(new Uint8Array(16))) {
    if (value < 234 && suffix.length < 8) suffix += String.fromCharCode(97 + value % 26);
  }
  return 'zentra_us_test_' + suffix;
}
export const usTestBillingDependencies: UsTestBillingDependencies = {
  enabled: usTestBillingEnabled,
  async configuration() { return usTestBillingConfiguration(await bindings()); },
  async user() { return (await import('../../app/zentra-auth')).getZentraUser({ offerAccess: false, refreshSession: true }); },
  async creations() { return d1WorkspaceCreationStore((await import('../runtime')).database()); },
  async purchases() { return d1UsTestPurchaseStore((await import('../runtime')).database()); },
  async gateway() { return stripeUsTestGateway((await stripe()).client, now); },
  async confirmCreation(intent, revalidate) {
    const { organizationId: _organizationId, ...configuration } = intent.configuration;
    return createOrResumeUsWorkspace(intent.actorUserId, { requestId: intent.requestId, confirmationVersion: 1, companyName: intent.companyName, configuration }, { store: await workspaceCreationDependencies.store(), allocateId: workspaceCreationDependencies.allocateId, now: workspaceCreationDependencies.now, fingerprint: workspaceCreationDependencies.fingerprint, admit: workspaceCreationDependencies.admit, revalidate });
  },
  async verifyEvent(rawBody, signature) {
    const { client, values } = await stripe();
    try {
      const event = await constructVerifiedStripeEvent({ client, rawBody, signatureHeader: signature, webhookSecret: values.INTERNATIONAL_US_SAAS_TEST_WEBHOOK_SECRET!, toleranceSeconds: 300, expectedLivemode: false, expectedApiVersion: usTestStripeApiVersion });
      if (event.account || event.context) throw new Error('Wrong event scope');
      return event;
    } catch { throw new UsTestBillingError('invalid_signature', 400); }
  },
  async rateLimit(request, userId, operation) { await (await import('../account')).enforceAccountRateLimit(request, 'international-us-test-billing-' + operation, userId, operation === 'read' ? 120 : 12); },
  now, allocateId: () => crypto.randomUUID(), integrationIdentifier,
  diagnostic(event) { console.warn('[zentra-us-test-billing]', JSON.stringify(event)); },
};
export const usTestBillingHandlers = createUsTestBillingHandlers(usTestBillingDependencies);
