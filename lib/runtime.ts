import { env } from 'cloudflare:workers';

type RuntimeBindings = {
  DB?: D1Database;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  LICENSE_SIGNING_KEY_PKCS8_B64URL?: string;
  PUBLIC_SITE_URL?: string;
};

const bindings = env as unknown as RuntimeBindings;

export function runtimeValue(name: keyof Omit<RuntimeBindings, 'DB'>): string {
  const bound = bindings[name];
  if (typeof bound === 'string' && bound.trim()) return bound.trim();
  return process.env[name]?.trim() ?? '';
}

export function database(): D1Database {
  if (!bindings.DB) throw new Error('La base de licences D1 n’est pas configurée.');
  return bindings.DB;
}

export function stripeConfiguration() {
  const secretKey = runtimeValue('STRIPE_SECRET_KEY');
  const webhookSecret = runtimeValue('STRIPE_WEBHOOK_SECRET');
  const signingKey = runtimeValue('LICENSE_SIGNING_KEY_PKCS8_B64URL');
  const siteUrl = runtimeValue('PUBLIC_SITE_URL');
  return {
    secretKey,
    webhookSecret,
    signingKey,
    siteUrl,
    checkoutReady: Boolean(secretKey && webhookSecret && signingKey),
  };
}
