/** Raw Ed25519 public key embedded in the signed Windows application. */
export const LICENSE_PUBLIC_KEY_B64URL =
  'FySkIPXpEIfZ9UCBlXuhFAgFx3LpchgBFWTh65Aa040';

/**
 * Public, non-secret contract shared by the Stripe service and the Windows
 * verifier. Keep the matching Rust constants covered by the contract test.
 */
export const LICENSE_PLAN = 'zentra-monthly-50-chf';
export const LEGACY_LICENSE_PLANS = [
  'elyko-monthly-50-chf',
  'helvichantier-monthly-50-chf',
] as const;
export const LICENSE_PRICE_CHF_CENTS = 5_000;
export const LICENSE_TOKEN_VERSION = 2;
export const LICENSE_KEY_ID = 'hc-prod-v1';

export function isSupportedLicensePlan(value: unknown): value is string {
  return (
    value === LICENSE_PLAN ||
    LEGACY_LICENSE_PLANS.some((legacyPlan) => value === legacyPlan)
  );
}
