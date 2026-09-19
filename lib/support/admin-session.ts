import { runtimeValue } from '@/lib/runtime';
import { enforceAccountRateLimit } from '@/lib/account';
import { digest, equalHash } from './crypto';
import { SupportError } from './types';

const encoder = new TextEncoder();
export const ADMIN_SESSION_SECONDS = 8 * 60 * 60;
function encode(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}
function decode(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid encoding');
  return Uint8Array.from(
    atob(value.replaceAll('-', '+').replaceAll('_', '/')),
    (c) => c.charCodeAt(0),
  );
}
function tokenHash() {
  const value = runtimeValue('SUPPORT_ADMIN_TOKEN_SHA256');
  return /^[a-f0-9]{64}$/.test(value) ? value : '';
}
async function signingKey() {
  const value = runtimeValue('SUPPORT_ADMIN_SESSION_KEY');
  if (!value)
    throw new SupportError(
      'L’accès administrateur doit être configuré par Zentra.',
      503,
    );
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = decode(value);
  } catch {
    throw new SupportError('L’accès administrateur est indisponible.', 503);
  }
  if (raw.length !== 32)
    throw new SupportError('L’accès administrateur est indisponible.', 503);
  return crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}
function cookieSettings(request: Request) {
  const url = new URL(request.url);
  const local =
    url.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !local)
    throw new SupportError('Ouvrez l’administration en HTTPS.', 400);
  return {
    name: local
      ? 'zentra_support_admin_local'
      : '__Secure-zentra_support_admin',
    secure: local ? '' : '; Secure',
  };
}
export function adminCookie(
  request: Request,
  session: string,
  maxAge = ADMIN_SESSION_SECONDS,
) {
  const { name, secure } = cookieSettings(request);
  return `${name}=${session}; Path=/api/support; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}
export async function createAdminSession(request: Request, token: unknown) {
  await enforceAccountRateLimit(request, 'support-admin-login', 'platform', 12);
  const expected = tokenHash();
  if (!expected)
    throw new SupportError(
      'L’accès administrateur doit être configuré par Zentra.',
      503,
    );
  const candidate = typeof token === 'string' ? token.trim() : '';
  if (
    !/^zsa_[A-Za-z0-9_-]{64}$/.test(candidate) ||
    !equalHash(await digest(candidate), expected)
  )
    throw new SupportError(
      'Ce jeton n’est pas reconnu. Copiez le jeton complet puis réessayez.',
      401,
    );
  const issued = Math.floor(Date.now() / 1000);
  const payload = encode(
    encoder.encode(
      JSON.stringify({
        v: 1,
        issued,
        expires: issued + ADMIN_SESSION_SECONDS,
        nonce: crypto.randomUUID(),
        binding: expected,
      }),
    ),
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    await signingKey(),
    encoder.encode(`zentra-support-admin-v1:${payload}`),
  );
  return `${payload}.${encode(new Uint8Array(signature))}`;
}
export async function hasAdminSession(request: Request) {
  try {
    const { name } = cookieSettings(request);
    const cookies = (request.headers.get('Cookie') || '')
      .split(';')
      .map((v) => v.trim())
      .filter((v) => v.startsWith(`${name}=`));
    if (cookies.length !== 1) return false;
    const value = cookies[0].slice(name.length + 1);
    if (value.length > 1000) return false;
    const [payload, signature, extra] = value.split('.');
    if (!payload || !signature || extra !== undefined) return false;
    if (
      !(await crypto.subtle.verify(
        'HMAC',
        await signingKey(),
        decode(signature),
        encoder.encode(`zentra-support-admin-v1:${payload}`),
      ))
    )
      return false;
    const data = JSON.parse(new TextDecoder().decode(decode(payload)));
    const now = Math.floor(Date.now() / 1000),
      expected = tokenHash();
    return (
      !!expected &&
      data.v === 1 &&
      Number.isSafeInteger(data.issued) &&
      Number.isSafeInteger(data.expires) &&
      data.issued <= now + 60 &&
      data.expires > now &&
      data.expires - data.issued === ADMIN_SESSION_SECONDS &&
      typeof data.binding === 'string' &&
      equalHash(data.binding, expected) &&
      typeof data.nonce === 'string'
    );
  } catch {
    return false;
  }
}
