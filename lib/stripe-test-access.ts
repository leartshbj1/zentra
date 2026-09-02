export type StripeCheckoutIdentity = {
  userId: string;
  email: string;
  emailConfirmed: boolean;
};

export type StripeTestAccessConfiguration = {
  secretKey: string;
  testMode: string;
  ownerAccountUserId: string;
  ownerEmail: string;
};

export function stripeAutomaticTaxRequired(configuration: {
  secretKey: string;
  testMode: string;
}) {
  return !(
    configuration.secretKey.trim().startsWith('sk_test_') &&
    configuration.testMode === 'owner_only'
  );
}

export function stripeTestAccessAllowed(
  configuration: StripeTestAccessConfiguration,
  identity: StripeCheckoutIdentity | null,
): boolean {
  const secretKey = configuration.secretKey.trim();
  if (!identity) return false;
  if (!identity.emailConfirmed) return false;
  if (secretKey.startsWith('sk_live_')) return true;
  if (!secretKey.startsWith('sk_test_')) return false;
  if (configuration.testMode !== 'owner_only') return false;

  const configuredUserId = configuration.ownerAccountUserId.trim();
  const configuredEmail = configuration.ownerEmail.trim().toLowerCase();
  return Boolean(
    (configuredUserId && identity.userId === configuredUserId) ||
      (configuredEmail && identity.email.trim().toLowerCase() === configuredEmail),
  );
}
