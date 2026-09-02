export const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
export const PKCE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type SupabasePkceFlow = {
  verifier: string;
  challenge: string;
};

export async function createSupabasePkceFlow(): Promise<SupabasePkceFlow> {
  assertWebCrypto();
  const verifier = randomBase64Url(64);
  const challenge = await pkceS256Challenge(verifier);
  if (
    !PKCE_VERIFIER_PATTERN.test(verifier) ||
    !PKCE_CHALLENGE_PATTERN.test(challenge)
  ) {
    throw new Error('La génération PKCE a produit une valeur invalide.');
  }
  return { verifier, challenge };
}

export async function pkceS256Challenge(verifier: string): Promise<string> {
  assertWebCrypto();
  if (!PKCE_VERIFIER_PATTERN.test(verifier)) {
    throw new Error('Le vérificateur PKCE est invalide.');
  }
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  );
  return bytesToBase64Url(new Uint8Array(digest));
}

export function isValidPkceVerifier(value: string) {
  return PKCE_VERIFIER_PATTERN.test(value);
}

export function isValidPkceChallenge(value: string) {
  return PKCE_CHALLENGE_PATTERN.test(value);
}

export function isValidSupabaseAuthCode(value: string) {
  return (
    value.length >= 16 && value.length <= 1024 && !/[^\x21-\x7e]/.test(value)
  );
}

export function legacySupabaseConfirmationPath(parameters: {
  confirmation?: string | string[];
  code?: string | string[];
  error?: string | string[];
}) {
  if (parameters.confirmation !== '1') return null;
  const query = new URLSearchParams();
  const codes = Array.isArray(parameters.code)
    ? parameters.code
    : parameters.code
      ? [parameters.code]
      : [];
  if (codes.length === 1) query.set('code', codes[0]);
  if (parameters.error !== undefined) query.set('error', 'supabase');
  if (!query.size) query.set('code', '');
  return `/api/auth/confirmation?${query.toString()}`;
}

function randomBase64Url(length: number) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function assertWebCrypto() {
  if (
    typeof crypto === 'undefined' ||
    typeof crypto.getRandomValues !== 'function' ||
    !crypto.subtle
  ) {
    throw new Error('Web Crypto est requis pour PKCE.');
  }
}
