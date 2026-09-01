import { database, runtimeValue, stripeConfiguration } from '@/lib/runtime';
import { LICENSE_PUBLIC_KEY_B64URL } from '@/lib/license-constants';
import {
  base64Url,
  fromBase64Url,
  LICENSE_PLAN,
  LICENSE_PRICE_CHF_CENTS,
  paidEntitlementForSubscription,
  PublicError,
  retrieveSubscription,
  upsertSubscription,
  validateActiveElykoSubscription,
} from '@/lib/stripe';

const INSTALLATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

async function signEncoded(encoded: string) {
  const { signingKey } = stripeConfiguration();
  if (!signingKey)
    throw new PublicError(
      'La signature des licences n’est pas configurée.',
      503,
    );
  const key = await crypto.subtle.importKey(
    'pkcs8',
    fromBase64Url(signingKey),
    { name: 'Ed25519' },
    false,
    ['sign'],
  );
  return new Uint8Array(
    await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(encoded)),
  );
}

export async function assertLicenseSignerReady() {
  const challenge = 'elyko-license-readiness-v1';
  const signature = await signEncoded(challenge);
  try {
    const publicKey = await crypto.subtle.importKey(
      'raw',
      fromBase64Url(LICENSE_PUBLIC_KEY_B64URL),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    const verified = await crypto.subtle.verify(
      'Ed25519',
      publicKey,
      signature,
      new TextEncoder().encode(challenge),
    );
    if (!verified) throw new Error('signer mismatch');
  } catch {
    throw new PublicError(
      'La clé de signature ne correspond pas à l’application Windows.',
      503,
    );
  }
}

async function signPayload(payload: LicensePayload) {
  const encoded = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await signEncoded(encoded);
  return `${encoded}.${base64Url(signature)}`;
}

export async function issueLicense(input: {
  subscriptionId: string;
  installationId: string;
  customerName: string | null;
  periodEnd: number;
}) {
  if (!INSTALLATION_ID.test(input.installationId))
    throw new PublicError(
      'Identifiant d’installation invalide. Recopiez celui affiché dans l’application.',
    );
  const db = database();
  const now = Math.floor(Date.now() / 1000);
  if (input.periodEnd + 3 * 86_400 < now) {
    throw new PublicError(
      'La dernière période payée est expirée. Régularisez l’abonnement dans le portail Stripe.',
      402,
    );
  }
  const existing = await db
    .prepare(
      'SELECT license_id,installation_id FROM license_activations WHERE subscription_id=? LIMIT 1',
    )
    .bind(input.subscriptionId)
    .first<{ license_id: string; installation_id: string }>();
  if (existing && existing.installation_id !== input.installationId) {
    throw new PublicError(
      'Cette licence est déjà liée à une autre installation. Contactez le support pour transférer la licence.',
      409,
    );
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

async function refreshIdentityFromToken(token: string) {
  if (token.length < 100 || token.length > 8_192)
    throw new PublicError('Jeton de licence invalide.', 400);
  const parts = token.split('.');
  if (
    parts.length !== 2 ||
    !/^[A-Za-z0-9_-]+$/.test(parts[0]) ||
    !/^[A-Za-z0-9_-]{80,100}$/.test(parts[1])
  ) {
    throw new PublicError('Jeton de licence invalide.', 400);
  }
  try {
    const providedSignature = fromBase64Url(parts[1]);
    const expectedSignature = await signEncoded(parts[0]);
    if (providedSignature.length !== expectedSignature.length) {
      throw new Error('invalid signature');
    }
    let difference = 0;
    for (let index = 0; index < expectedSignature.length; index += 1) {
      difference |= providedSignature[index] ^ expectedSignature[index];
    }
    if (difference !== 0) throw new Error('invalid signature');
    const payload = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(fromBase64Url(parts[0])),
    ) as Partial<LicensePayload>;
    if (
      payload.token_version !== 2 ||
      !/^lic_[0-9a-f-]{36}$/i.test(payload.license_id ?? '') ||
      !INSTALLATION_ID.test(payload.installation_id ?? '')
    ) {
      throw new Error('invalid payload');
    }
    return {
      licenseId: payload.license_id!,
      installationId: payload.installation_id!,
      payload: payload as LicensePayload,
    };
  } catch {
    throw new PublicError('Jeton de licence invalide.', 400);
  }
}

async function sha256Hex(value: string) {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function constantTimeTextEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * Réémet un bail signé pour la même installation après contrôle Stripe en
 * temps réel. Le jeton présenté sert de secret opaque : le couple aléatoire
 * licence/installation doit exister exactement dans D1 et ne permet aucun
 * transfert vers un autre PC. Son ancienne date d’expiration n’est pas une
 * preuve d’abonnement; l’état Stripe courant reste l’unique autorité.
 */
export async function refreshLicense(token: string) {
  const normalizedToken = token.trim();
  const { licenseId, installationId, payload } =
    await refreshIdentityFromToken(normalizedToken);
  const ownerBindingHash = runtimeValue(
    'OWNER_LICENSE_BINDING_SHA256',
  ).toLowerCase();
  if (ownerBindingHash) {
    if (!/^[0-9a-f]{64}$/.test(ownerBindingHash)) {
      throw new PublicError(
        'La configuration de la licence propriétaire est invalide.',
        503,
      );
    }
    const providedHash = await sha256Hex(`${licenseId}:${installationId}`);
    if (constantTimeTextEqual(providedHash, ownerBindingHash)) {
      const now = Math.floor(Date.now() / 1000);
      const refreshedOwnerPayload: LicensePayload = {
        ...payload,
        token_version: 2,
        license_id: licenseId,
        installation_id: installationId,
        jti: crypto.randomUUID(),
        kid: 'hc-prod-v1',
        customer_name: 'Licence propriétaire Elyko',
        plan: LICENSE_PLAN,
        price_chf_cents: LICENSE_PRICE_CHF_CENTS,
        issued_at: new Date().toISOString(),
        valid_from: isoDate(now - 86_400),
        valid_until: '2036-12-31',
      };
      return {
        token: await signPayload(refreshedOwnerPayload),
        payload: refreshedOwnerPayload,
      };
    }
  }
  const db = database();
  const activation = await db
    .prepare(
      `SELECT activation.subscription_id
       FROM license_activations activation
       WHERE activation.license_id=? AND activation.installation_id=? LIMIT 1`,
    )
    .bind(licenseId, installationId)
    .first<{ subscription_id: string }>();
  if (!activation) {
    throw new PublicError(
      'Cette activation n’est pas reconnue. Contactez le support Elyko.',
      403,
    );
  }
  const subscription = await retrieveSubscription(activation.subscription_id);
  validateActiveElykoSubscription(subscription);
  await upsertSubscription(subscription);
  const entitlement = await paidEntitlementForSubscription(subscription.id);
  return issueLicense({
    subscriptionId: subscription.id,
    installationId,
    customerName: entitlement.customer_name,
    periodEnd: entitlement.entitlement_valid_until,
  });
}
