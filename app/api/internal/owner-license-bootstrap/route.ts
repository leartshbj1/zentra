import {
  LICENSE_KEY_ID,
  LICENSE_PLAN,
  LICENSE_PRICE_CHF_CENTS,
  LICENSE_TOKEN_VERSION,
} from '@/lib/license-constants';
import { stripeConfiguration } from '@/lib/runtime';
import {
  base64Url,
  fromBase64Url,
  jsonError,
  noStoreHeaders,
  PublicError,
} from '@/lib/stripe';
import { assertLicenseSignerReady } from '@/lib/license-token';

export const dynamic = 'force-dynamic';

// TEMPORARY BOOTSTRAP ROUTE. Remove immediately after the one requested token
// has been issued and verified. The raw challenge must never enter source.
const INSTALLATION_ID = 'e2431c92-c06d-44a8-bbfb-ab181ca49c45';
const CHALLENGE_SHA256 =
  '6adece08c26a552d9f08d459355cd7fb7c8b4cd001eb28d89b64313cb3b18030';
const BOOTSTRAP_EXPIRES_AT = Date.parse('2026-09-05T00:00:00.000Z');

type OwnerLicensePayload = {
  token_version: typeof LICENSE_TOKEN_VERSION;
  license_id: string;
  installation_id: string;
  jti: string;
  kid: typeof LICENSE_KEY_ID;
  customer_name: string;
  access_role: 'owner';
  account_user_id: null;
  account_session_id: null;
  plan: typeof LICENSE_PLAN;
  price_chf_cents: typeof LICENSE_PRICE_CHF_CENTS;
  issued_at: string;
  valid_from: string;
  valid_until: string;
};

function hex(bytes: Uint8Array) {
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Hex(value: string) {
  return hex(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
    ),
  );
}

function constantTimeTextEqual(left: string, right: string) {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |=
      (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function isoDate(seconds: number) {
  return new Date(seconds * 1_000).toISOString().slice(0, 10);
}

async function signPayload(payload: OwnerLicensePayload) {
  const { signingKey } = stripeConfiguration();
  if (!signingKey) {
    throw new PublicError(
      'La signature des licences n’est pas configurée.',
      503,
    );
  }
  const key = await crypto.subtle.importKey(
    'pkcs8',
    fromBase64Url(signingKey),
    { name: 'Ed25519' },
    false,
    ['sign'],
  );
  const encoded = base64Url(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      'Ed25519',
      key,
      new TextEncoder().encode(encoded),
    ),
  );
  return `${encoded}.${base64Url(signature)}`;
}

export async function POST(request: Request) {
  try {
    if (Date.now() >= BOOTSTRAP_EXPIRES_AT) {
      throw new PublicError('Cette opération temporaire a expiré.', 410);
    }
    const authorization = request.headers.get('authorization')?.trim() ?? '';
    const challenge = authorization.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length).trim()
      : '';
    const suppliedHash = await sha256Hex(challenge);
    if (
      challenge.length !== 64 ||
      !/^[0-9a-f]{64}$/.test(challenge) ||
      !constantTimeTextEqual(suppliedHash, CHALLENGE_SHA256)
    ) {
      throw new PublicError('Accès refusé.', 403);
    }

    await assertLicenseSignerReady();
    const now = Math.floor(Date.now() / 1_000);
    const payload: OwnerLicensePayload = {
      token_version: LICENSE_TOKEN_VERSION,
      license_id: `lic_${crypto.randomUUID()}`,
      installation_id: INSTALLATION_ID,
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
    const token = await signPayload(payload);
    return Response.json(
      {
        token,
        installationId: INSTALLATION_ID,
        validUntil: payload.valid_until,
        ownerBindingSha256: await sha256Hex(
          `${payload.license_id}:${INSTALLATION_ID}`,
        ),
      },
      { headers: noStoreHeaders() },
    );
  } catch (error) {
    return jsonError(error);
  }
}
