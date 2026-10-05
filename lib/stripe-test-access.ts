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
  testAccountUserIds?: string;
};

const ACCOUNT_USER_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TEST_ACCOUNTS = 20;
const MAX_ALLOWLIST_LENGTH = 4096;

function sandboxAccountAllowed(
  configuredIds: string | undefined,
  identity: StripeCheckoutIdentity,
) {
  if (
    identity.emailConfirmed !== true ||
    typeof identity.userId !== 'string' ||
    !ACCOUNT_USER_ID.test(identity.userId) ||
    typeof identity.email !== 'string' ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity.email.trim()) ||
    typeof configuredIds !== 'string' ||
    configuredIds.length > MAX_ALLOWLIST_LENGTH
  ) return false;
  let ids: unknown;
  try { ids = JSON.parse(configuredIds); } catch { return false; }
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_TEST_ACCOUNTS)
    return false;
  const admitted = new Set<string>();
  for (const id of ids) {
    if (typeof id !== 'string' || !ACCOUNT_USER_ID.test(id)) return false;
    const canonical = id.toLowerCase();
    if (admitted.has(canonical)) return false;
    admitted.add(canonical);
  }
  return admitted.has(identity.userId.toLowerCase());
}

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
  if (configuration.testMode === 'accounts_only')
    return sandboxAccountAllowed(configuration.testAccountUserIds, identity);
  if (configuration.testMode !== 'owner_only') return false;

  const configuredUserId = configuration.ownerAccountUserId.trim();
  const configuredEmail = configuration.ownerEmail.trim().toLowerCase();
  return Boolean(
    (configuredUserId && identity.userId === configuredUserId) ||
      (configuredEmail && identity.email.trim().toLowerCase() === configuredEmail),
  );
}
