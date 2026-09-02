import { env } from 'cloudflare:workers';

type RuntimeBindings = {
  DB?: D1Database;
  FILES?: R2Bucket;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_WEBHOOK_ENDPOINT_ID?: string;
  STRIPE_PRICE_ID?: string;
  LICENSE_SIGNING_KEY_PKCS8_B64URL?: string;
  OWNER_LICENSE_BINDING_SHA256?: string;
  PUBLIC_SITE_URL?: string;
  STRIPE_TEST_MODE?: string;
  OWNER_ACCOUNT_USER_ID?: string;
  ZENTRA_OWNER_EMAIL?: string;
};

const bindings = env as unknown as RuntimeBindings;

export function runtimeValue(
  name: keyof Omit<RuntimeBindings, 'DB' | 'FILES'>,
): string {
  const bound = bindings[name];
  if (typeof bound === 'string' && bound.trim()) return bound.trim();
  return process.env[name]?.trim() ?? '';
}

export function fileArchive(): R2Bucket {
  if (!bindings.FILES)
    throw new Error('Le coffre de documents R2 n’est pas configuré.');
  return bindings.FILES;
}

export function database(): D1Database {
  if (!bindings.DB)
    throw new Error('La base de licences D1 n’est pas configurée.');
  return bindings.DB;
}

export function stripeConfiguration() {
  const secretKey = runtimeValue('STRIPE_SECRET_KEY');
  const webhookSecret = runtimeValue('STRIPE_WEBHOOK_SECRET');
  const webhookEndpointId = runtimeValue('STRIPE_WEBHOOK_ENDPOINT_ID');
  const priceId = runtimeValue('STRIPE_PRICE_ID');
  const signingKey = runtimeValue('LICENSE_SIGNING_KEY_PKCS8_B64URL');
  const siteUrl = runtimeValue('PUBLIC_SITE_URL');
  const testMode = runtimeValue('STRIPE_TEST_MODE');
  const ownerAccountUserId = runtimeValue('OWNER_ACCOUNT_USER_ID');
  const ownerEmail = runtimeValue('ZENTRA_OWNER_EMAIL').toLowerCase();
  return {
    secretKey,
    webhookSecret,
    webhookEndpointId,
    priceId,
    signingKey,
    siteUrl,
    testMode,
    ownerAccountUserId,
    ownerEmail,
  };
}
