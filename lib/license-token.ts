import { database, stripeConfiguration } from '@/lib/runtime';
import { base64Url, fromBase64Url, LICENSE_PLAN, LICENSE_PRICE_CHF_CENTS, PublicError } from '@/lib/stripe';

const INSTALLATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type LicensePayload = {
  token_version: 2;
  license_id: string;
  installation_id: string;
  jti: string;
  kid: 'hc-prod-v1';
  customer_name: string | null;
  plan: string;
  price_chf_cents: number;
  issued_at: string;
  valid_from: string;
  valid_until: string;
};

function isoDate(seconds: number) {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

async function signPayload(payload: LicensePayload) {
  const { signingKey } = stripeConfiguration();
  if (!signingKey) throw new PublicError('La signature des licences n’est pas configurée.', 503);
  const key = await crypto.subtle.importKey('pkcs8', fromBase64Url(signingKey), { name: 'Ed25519' }, false, ['sign']);
  const encoded = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(encoded)));
  return `${encoded}.${base64Url(signature)}`;
}

export async function issueLicense(input: {
  subscriptionId: string;
  installationId: string;
  customerName: string | null;
  periodEnd: number;
}) {
  if (!INSTALLATION_ID.test(input.installationId)) throw new PublicError('Identifiant d’installation invalide. Recopiez celui affiché dans l’application.');
  const db = database();
  const now = Math.floor(Date.now() / 1000);
  const existing = await db
    .prepare('SELECT license_id,installation_id FROM license_activations WHERE subscription_id=? LIMIT 1')
    .bind(input.subscriptionId)
    .first<{ license_id: string; installation_id: string }>();
  if (existing && existing.installation_id !== input.installationId) {
    throw new PublicError('Cette licence est déjà liée à une autre installation. Contactez le support pour transférer la licence.', 409);
  }
  const licenseId = existing?.license_id ?? `lic_${crypto.randomUUID()}`;
  await db
    .prepare(`INSERT INTO license_activations(license_id,subscription_id,installation_id,activated_at,last_issued_at)
      VALUES(?,?,?,?,?) ON CONFLICT(license_id) DO UPDATE SET last_issued_at=excluded.last_issued_at`)
    .bind(licenseId, input.subscriptionId, input.installationId, now, now)
    .run();
  const payload: LicensePayload = {
    token_version: 2,
    license_id: licenseId,
    installation_id: input.installationId,
    jti: crypto.randomUUID(),
    kid: 'hc-prod-v1',
    customer_name: input.customerName,
    plan: LICENSE_PLAN,
    price_chf_cents: LICENSE_PRICE_CHF_CENTS,
    issued_at: new Date().toISOString(),
    valid_from: isoDate(now - 86_400),
    valid_until: isoDate(input.periodEnd + 3 * 86_400),
  };
  return { token: await signPayload(payload), payload };
}
