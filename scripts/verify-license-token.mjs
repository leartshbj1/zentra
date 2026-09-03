import { readFile } from 'node:fs/promises';
import { stdin, stdout } from 'node:process';
import { webcrypto } from 'node:crypto';

const TOKEN_VERSION = 2;
const LICENSE_KEY_ID = 'hc-prod-v1';
const LICENSE_PRICE_CHF_CENTS = 5_000;
const LICENSE_PLANS = new Set([
  'zentra-monthly-50-chf',
  'elyko-monthly-50-chf',
  'helvichantier-monthly-50-chf',
]);
const INSTALLATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() ?? '' : '';
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const expectedInstallationId = argument('--installation-id');
  assert(
    INSTALLATION_ID.test(expectedInstallationId),
    'Pass a valid UUID v4 with --installation-id.',
  );
  const token = await readStdin();
  assert(token.length >= 100 && token.length <= 8_192, 'Invalid token length.');
  const parts = token.split('.');
  assert(parts.length === 2, 'Malformed token.');
  const [encoded, signatureText] = parts;
  assert(/^[A-Za-z0-9_-]+$/.test(encoded), 'Invalid payload encoding.');
  assert(
    /^[A-Za-z0-9_-]{80,100}$/.test(signatureText),
    'Invalid signature encoding.',
  );

  const publicKeyText = (
    await readFile(
      new URL('../desktop/src-tauri/license-public-key.b64url', import.meta.url),
      'utf8',
    )
  ).trim();
  const publicKeyBytes = Buffer.from(publicKeyText, 'base64url');
  assert(publicKeyBytes.length === 32, 'Invalid embedded public key.');
  const publicKey = await webcrypto.subtle.importKey(
    'raw',
    publicKeyBytes,
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
  const signatureValid = await webcrypto.subtle.verify(
    'Ed25519',
    publicKey,
    Buffer.from(signatureText, 'base64url'),
    Buffer.from(encoded, 'utf8'),
  );
  assert(signatureValid, 'The Ed25519 signature does not match the desktop key.');

  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  assert(payload.token_version === TOKEN_VERSION, 'Unsupported token version.');
  assert(
    typeof payload.license_id === 'string' &&
      /^lic_[0-9a-f-]{36}$/i.test(payload.license_id),
    'Invalid license ID.',
  );
  assert(
    payload.installation_id === expectedInstallationId,
    'Token is bound to another installation.',
  );
  assert(LICENSE_PLANS.has(payload.plan), 'Unsupported license plan.');
  assert(
    payload.price_chf_cents === LICENSE_PRICE_CHF_CENTS,
    'Unexpected license price.',
  );
  assert(payload.kid === LICENSE_KEY_ID, 'Unexpected license key ID.');
  assert(payload.access_role === 'owner', 'The token is not an owner token.');
  assert(
    payload.account_user_id === null && payload.account_session_id === null,
    'Unexpected account binding.',
  );
  assert(!Number.isNaN(Date.parse(payload.issued_at)), 'Invalid issue date.');
  assert(/^\d{4}-\d{2}-\d{2}$/.test(payload.valid_from), 'Invalid start date.');
  assert(/^\d{4}-\d{2}-\d{2}$/.test(payload.valid_until), 'Invalid end date.');

  stdout.write(
    `${JSON.stringify({
      verified: true,
      installationId: payload.installation_id,
      licenseId: payload.license_id,
      plan: payload.plan,
      accessRole: payload.access_role,
      validUntil: payload.valid_until,
    })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `License verification failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
