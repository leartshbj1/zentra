import { LEGACY_LICENSE_PLAN_IDS, planByLicense } from '@/lib/plans';
import { deploymentProfile } from './deployment-contract';

/** Raw Ed25519 public key embedded in the signed Windows application. */
export const LICENSE_PUBLIC_KEY_B64URL = deploymentProfile.license.publicKeyB64url;

/**
 * Public, non-secret contract shared by the Stripe service and the Windows
 * verifier. Keep the matching Rust constants covered by the contract test.
 */
export const LICENSE_PLAN = 'zentra-monthly-50-chf';
export const LEGACY_LICENSE_PLANS = LEGACY_LICENSE_PLAN_IDS;
export const LICENSE_PRICE_CHF_CENTS = 5_000;
export const LICENSE_TOKEN_VERSION = 2;
export const LICENSE_KEY_ID = deploymentProfile.license.kid;

export function isSupportedLicensePlan(value: unknown): value is string {
  return planByLicense(value) !== undefined;
}
