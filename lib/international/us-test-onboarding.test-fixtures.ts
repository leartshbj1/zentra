import { buildUsTestWorkspaceCreation, type UsTestOnboardingDraft } from './browser-us-test-onboarding';
import type { UsTestPublicOffer, UsTestPublicState } from './us-saas-test-public';
import { validateCompanyConfiguration } from './country-config';

export const onboardingActor = '00000000-0000-4000-8000-000000000010';
export const onboardingRequestId = '00000000-0000-4000-8000-000000000011';
export const onboardingOrganizationId = '00000000-0000-4000-8000-000000000012';
export const onboardingDraft: UsTestOnboardingDraft = { companyName: 'Fictitious US Company', line1: '1 Example Street', city: 'New York', subdivision: 'NY', postalCode: '10001', timeZone: 'America/New_York', language: 'en', accountingBasis: 'accrual' };
export const onboardingOffer: UsTestPublicOffer = { module: 'gestion', plan: 'synthetic-monthly', catalogVersion: 'synthetic-v1', amountMinor: '2500', currency: 'USD', interval: 'month', intervalCount: 1, seatLimit: 3 };
export function onboardingState(state: 'reserved' | 'postgres_confirmed' | 'ready' = 'postgres_confirmed', purchase: 'not_started' | 'checkout_pending' | 'ready' = 'not_started'): UsTestPublicState {
  const request = buildUsTestWorkspaceCreation(onboardingDraft, onboardingRequestId);
  return { workspace: { creationId: '00000000-0000-4000-8000-000000000013', organizationId: onboardingOrganizationId, requestId: onboardingRequestId, companyName: request.companyName, country: 'US', currency: 'USD', state, configuration: validateCompanyConfiguration({ ...request.configuration, organizationId: onboardingOrganizationId }), setupStatus: state === 'reserved' ? 'confirmation_pending' : state === 'ready' ? 'ready' : 'us_subscription_required', createdAt: '2026-10-10T12:00:00.000Z', updatedAt: '2026-10-10T12:00:00.000Z' }, offers: [onboardingOffer], purchase: { state: purchase, ...(purchase === 'checkout_pending' ? { expiresAt: Math.floor(Date.now() / 1000) + 3600 } : {}) } };
}
