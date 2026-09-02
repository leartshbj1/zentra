import { database, runtimeValue, stripeConfiguration } from '@/lib/runtime';
import { isAccountRole, type AccountRole } from '@/lib/account-security';
import {
  LICENSE_KEY_ID,
  LICENSE_PLAN,
  LICENSE_PRICE_CHF_CENTS,
  LICENSE_PUBLIC_KEY_B64URL,
  LICENSE_TOKEN_VERSION,
  isSupportedLicensePlan,
} from '@/lib/license-constants';
import {
  base64Url,
  fromBase64Url,
  paidEntitlementForSubscription,
  PublicError,
  referenceId,
  retrieveInvoice,
  retrieveSubscription,
  upsertSubscription,
  validateActiveZentraSubscription,
  validatePaidZentraInvoice,
} from '@/lib/stripe';

const INSTALLATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACCOUNT_SESSION_ID =
  /^dss_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type LicensePayload = {
  token_version: typeof LICENSE_TOKEN_VERSION;
  license_id: string;
  installation_id: string;
  jti: string;
  kid: typeof LICENSE_KEY_ID;
  customer_name: string | null;
  access_role: AccountRole;
  account_user_id: string | null;
  account_session_id: string | null;
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
  const challenge = 'zentra-license-readiness-v1';
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
      'La clé de signature ne correspond pas aux applications Zentra.',
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
  channel: 'account' | 'checkout' | 'refresh';
  accessRole?: AccountRole;
  accountUserId?: string | null;
  accountSessionId?: string | null;
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
  const accountUserId = input.accountUserId?.trim() || null;
  const accountSessionId = input.accountSessionId?.trim() || null;
  if (
    (accountUserId === null) !== (accountSessionId === null) ||
    (accountUserId !== null && accountUserId.length > 255) ||
    (accountSessionId !== null && !ACCOUNT_SESSION_ID.test(accountSessionId)) ||
    (input.channel === 'account' &&
      (accountUserId === null || accountSessionId === null))
  ) {
    throw new PublicError(
      'La liaison entre la licence, le compte et la session est invalide.',
      400,
    );
  }
  const proposedLicenseId = `lic_${crypto.randomUUID()}`;
  let activation: { license_id: string } | null;
  if (input.channel === 'account') {
    activation = await db
      .prepare(`INSERT INTO license_activations(
          license_id,subscription_id,installation_id,activated_at,last_issued_at,revoked_at
        ) VALUES(?,?,?,?,?,NULL)
        ON CONFLICT(subscription_id,installation_id) DO UPDATE SET
          last_issued_at=excluded.last_issued_at,
          revoked_at=NULL
        RETURNING license_id`)
      .bind(
        proposedLicenseId,
        input.subscriptionId,
        input.installationId,
        now,
        now,
      )
      .first<{ license_id: string }>();
  } else {
    activation = await db
      .prepare(
        `UPDATE license_activations SET last_issued_at=?
          WHERE subscription_id=? AND installation_id=? AND revoked_at IS NULL
          RETURNING license_id`,
      )
      .bind(now, input.subscriptionId, input.installationId)
      .first<{ license_id: string }>();
    if (!activation && input.channel === 'checkout') {
      activation = await db
        .prepare(
          `INSERT INTO license_activations(
             license_id,subscription_id,installation_id,activated_at,last_issued_at,revoked_at
           )
           SELECT ?,?,?,?,?,NULL
            WHERE NOT EXISTS(
              SELECT 1 FROM organizations WHERE subscription_id=?
            )
              AND NOT EXISTS(
                SELECT 1 FROM license_activations WHERE subscription_id=?
              )
           RETURNING license_id`,
        )
        .bind(
          proposedLicenseId,
          input.subscriptionId,
          input.installationId,
          now,
          now,
          input.subscriptionId,
          input.subscriptionId,
        )
        .first<{ license_id: string }>();
    }
  }
  if (!activation) {
    throw new PublicError(
      input.channel === 'refresh'
        ? 'Cette activation a été révoquée. Autorisez de nouveau cet appareil depuis le compte Zentra.'
        : 'Pour autoriser un nouvel appareil, connectez-le au compte Zentra depuis l’application.',
      403,
    );
  }
  const licenseId = activation.license_id;
  const payload: LicensePayload = {
    token_version: LICENSE_TOKEN_VERSION,
    license_id: licenseId,
    installation_id: input.installationId,
    jti: crypto.randomUUID(),
    kid: LICENSE_KEY_ID,
    customer_name: input.customerName,
    access_role: input.accessRole ?? 'owner',
    account_user_id: accountUserId,
    account_session_id: accountSessionId,
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
    const accessRole = payload.access_role ?? 'owner';
    const accountUserId = payload.account_user_id ?? null;
    const accountSessionId = payload.account_session_id ?? null;
    if (
      payload.token_version !== LICENSE_TOKEN_VERSION ||
      !/^lic_[0-9a-f-]{36}$/i.test(payload.license_id ?? '') ||
      !INSTALLATION_ID.test(payload.installation_id ?? '') ||
      !isSupportedLicensePlan(payload.plan) ||
      payload.price_chf_cents !== LICENSE_PRICE_CHF_CENTS ||
      payload.kid !== LICENSE_KEY_ID ||
      !isAccountRole(accessRole) ||
      (accountUserId === null) !== (accountSessionId === null) ||
      (accountUserId !== null &&
        (accountUserId.trim().length === 0 || accountUserId.length > 255)) ||
      (accountSessionId !== null && !ACCOUNT_SESSION_ID.test(accountSessionId))
    ) {
      throw new Error('invalid payload');
    }
    payload.access_role = accessRole;
    payload.account_user_id = accountUserId;
    payload.account_session_id = accountSessionId;
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
        token_version: LICENSE_TOKEN_VERSION,
        license_id: licenseId,
        installation_id: installationId,
        jti: crypto.randomUUID(),
        kid: LICENSE_KEY_ID,
        customer_name: 'Licence propriétaire Zentra',
        access_role: 'owner',
        account_user_id: null,
        account_session_id: null,
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
       WHERE activation.license_id=? AND activation.installation_id=?
         AND activation.revoked_at IS NULL LIMIT 1`,
    )
    .bind(licenseId, installationId)
    .first<{ subscription_id: string }>();
  if (!activation) {
    throw new PublicError(
      'Cette activation n’est pas reconnue. Contactez le support Zentra.',
      403,
    );
  }
  const subscription = await retrieveSubscription(activation.subscription_id);
  validateActiveZentraSubscription(subscription);
  const latestInvoiceId = referenceId(subscription.latest_invoice);
  if (!latestInvoiceId) {
    throw new PublicError(
      'La dernière facture Stripe de cet abonnement est absente.',
      502,
    );
  }
  const latestInvoice = await retrieveInvoice(latestInvoiceId);
  const paidThrough = validatePaidZentraInvoice(latestInvoice, subscription);
  await upsertSubscription(subscription, null, {
    paidInvoiceId: latestInvoice.id,
    paidThrough,
    paidAt:
      latestInvoice.status_transitions?.paid_at ??
      Math.floor(Date.now() / 1000),
  });
  const entitlement = await paidEntitlementForSubscription(subscription.id);
  const organization = await db
    .prepare(
      `SELECT organization_id FROM organizations
        WHERE subscription_id=? LIMIT 1`,
    )
    .bind(subscription.id)
    .first<{ organization_id: string }>();
  let accessRole: AccountRole = payload.access_role;
  let accountUserId = payload.account_user_id;
  let accountSessionId = payload.account_session_id;
  if (organization) {
    if (!accountUserId || !accountSessionId) {
      throw new PublicError(
        'Cette ancienne licence n’est pas liée précisément au compte. Reconnectez Zentra au compte pour sécuriser cet appareil.',
        403,
      );
    }
    const accountAccess = await db
      .prepare(
        `SELECT member.role
           FROM device_sessions session
           JOIN organization_members member
             ON member.organization_id=session.organization_id
            AND member.user_id=session.user_id
            AND member.revoked_at IS NULL
          WHERE session.organization_id=? AND session.installation_id=?
            AND session.session_id=? AND session.user_id=?
            AND session.revoked_at IS NULL AND session.expires_at>=?
          LIMIT 1`,
      )
      .bind(
        organization.organization_id,
        installationId,
        accountSessionId,
        accountUserId,
        Math.floor(Date.now() / 1000),
      )
      .first<{ role: string }>();
    if (!accountAccess || !isAccountRole(accountAccess.role)) {
      throw new PublicError(
        'La session du compte liée à cet appareil a expiré ou a été révoquée. Reconnectez Zentra au compte.',
        403,
      );
    }
    accessRole = accountAccess.role;
  } else {
    accountUserId = null;
    accountSessionId = null;
  }
  return issueLicense({
    subscriptionId: subscription.id,
    installationId,
    customerName: entitlement.customer_name,
    periodEnd: entitlement.entitlement_valid_until,
    channel: 'refresh',
    accessRole,
    accountUserId,
    accountSessionId,
  });
}
