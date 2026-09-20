import { database, runtimeValue } from './runtime';
import { AccountPublicError } from './account-security';
import {
  FOUNDER_DOMAIN,
  FOUNDER_PATH,
  isUuid,
  parseAction,
} from './founder-access-policy';

function decode(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new AccountPublicError('Signature administrateur invalide.', 401);
  const text = atob(
    value.replaceAll('-', '+').replaceAll('_', '/') +
      '='.repeat((4 - (value.length % 4)) % 4),
  );
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

export async function authenticateFounder(
  body: Record<string, unknown>,
  request: Request,
) {
  return authenticateFounderCommand(
    body,
    request,
    FOUNDER_PATH,
    FOUNDER_DOMAIN,
    parseAction,
  );
}

export async function authenticateFounderCommand<T>(
  body: Record<string, unknown>,
  request: Request,
  path: string,
  domain: string,
  parse: (input: unknown) => T,
) {
  if (request.headers.has('Origin') || new URL(request.url).pathname !== path)
    throw new AccountPublicError(
      'Cette commande est réservée à votre application PC.',
      403,
    );
  const publicText = runtimeValue('FOUNDER_ADMIN_PUBLIC_KEY_B64URL');
  if (!publicText)
    throw new AccountPublicError(
      'L’accès fondateur n’est pas encore configuré.',
      503,
    );
  if (
    typeof body.payload !== 'string' ||
    body.payload.length > 16000 ||
    typeof body.signature !== 'string' ||
    body.signature.length !== 86 ||
    Object.keys(body).some((k) => k !== 'payload' && k !== 'signature')
  )
    throw new AccountPublicError('Commande signée invalide.', 401);
  let envelope: {
    version: number;
    timestamp: number;
    nonce: string;
    action: unknown;
  };
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      decode(publicText),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    const valid = await crypto.subtle.verify(
      'Ed25519',
      key,
      decode(body.signature),
      new TextEncoder().encode(domain + body.payload),
    );
    if (!valid) throw new Error('signature');
    envelope = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(decode(body.payload)),
    );
    if (
      !envelope ||
      Object.keys(envelope).some(
        (k) => !['version', 'timestamp', 'nonce', 'action'].includes(k),
      ) ||
      envelope.version !== 1 ||
      !isUuid(envelope.nonce) ||
      !Number.isSafeInteger(envelope.timestamp) ||
      Math.abs(Math.floor(Date.now() / 1000) - envelope.timestamp) > 300
    )
      throw new Error('freshness');
  } catch {
    throw new AccountPublicError(
      'La commande n’est pas authentifiée ou l’heure du PC est incorrecte.',
      401,
    );
  }
  const action = parse(envelope.action);
  const now = Math.floor(Date.now() / 1000);
  const db = database();
  await db
    .prepare('DELETE FROM founder_admin_nonces WHERE expires_at<?')
    .bind(now)
    .run();
  const nonce = await db
    .prepare(
      'INSERT INTO founder_admin_nonces(nonce,expires_at) VALUES(?,?) ON CONFLICT(nonce) DO NOTHING',
    )
    .bind(envelope.nonce, now + 660)
    .run();
  if ((nonce.meta.changes ?? 0) !== 1)
    throw new AccountPublicError(
      'Cette commande a déjà été reçue. Réessayez depuis l’application.',
      409,
    );
  return action;
}
