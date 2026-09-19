import { SupportError } from './types';
const encoder = new TextEncoder();
function base64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}
function bytes(value: string) {
  try {
    return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  } catch {
    throw new SupportError('Le coffre des connexions est indisponible.', 503);
  }
}
async function keyFrom(secret: string) {
  const raw = bytes(secret);
  if (raw.length !== 32)
    throw new SupportError(
      'Le coffre des connexions doit être configuré par Zentra.',
      503,
    );
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}
export async function encryptSecret(
  secret: string,
  plaintext: string,
  context: string,
) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(context) },
    await keyFrom(secret),
    encoder.encode(plaintext),
  );
  return `v1.${base64(iv)}.${base64(new Uint8Array(ciphertext))}`;
}
export async function decryptSecret(
  secret: string,
  ciphertext: string,
  context: string,
) {
  try {
    const [v, iv, data] = ciphertext.split('.');
    if (v !== 'v1') throw new Error();
    const value = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: bytes(iv),
        additionalData: encoder.encode(context),
      },
      await keyFrom(secret),
      bytes(data),
    );
    return new TextDecoder().decode(value);
  } catch {
    throw new SupportError(
      'Cette connexion doit être reconnectée dans Connexions.',
      503,
    );
  }
}
export function newHookToken() {
  return (
    'zsup_' +
    base64(crypto.getRandomValues(new Uint8Array(32)))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '')
  );
}
export async function digest(value: string) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest('SHA-256', encoder.encode(value)),
    ),
  ]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}
export function equalHash(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
