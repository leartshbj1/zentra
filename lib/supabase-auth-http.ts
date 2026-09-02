import { SupabaseAuthError } from './supabase-auth';
import { AccountPublicError } from './account-security';
import {
  MAX_AUTH_PASSWORD_LENGTH,
  MIN_AUTH_PASSWORD_LENGTH,
} from './supabase-auth-policy';

type JsonObject = Record<string, unknown>;

export class AuthPublicError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'AuthPublicError';
    this.status = status;
  }
}

export function requireAuthSameOrigin(
  request: Request,
  options: { requireOrigin?: boolean } = {},
) {
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite === 'cross-site') {
    throw new AuthPublicError('Origine de la demande refusée.', 403);
  }
  const origin = request.headers.get('origin');
  if (!origin) {
    if (options.requireOrigin) {
      throw new AuthPublicError('Origine de la demande absente.', 403);
    }
    return;
  }
  let supplied: URL;
  let expected: URL;
  try {
    supplied = new URL(origin);
    expected = new URL(request.url);
  } catch {
    throw new AuthPublicError('Origine de la demande refusée.', 403);
  }
  if (supplied.origin !== expected.origin) {
    throw new AuthPublicError('Origine de la demande refusée.', 403);
  }
}

export async function readAuthCredentials(
  request: Request,
  options: { requireStrongPassword?: boolean } = {},
) {
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > 8_192) {
    throw new AuthPublicError('La demande est trop volumineuse.', 413);
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 8_192) {
    throw new AuthPublicError('La demande est trop volumineuse.', 413);
  }
  let body: JsonObject;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw 0;
    body = parsed as JsonObject;
  } catch {
    throw new AuthPublicError('La demande est invalide.');
  }
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const displayName =
    typeof body.displayName === 'string' ? body.displayName.trim() : '';
  if (
    !email ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw new AuthPublicError('Saisissez une adresse e-mail valide.');
  }
  if (!password || password.length > MAX_AUTH_PASSWORD_LENGTH) {
    throw new AuthPublicError('Le mot de passe est invalide.');
  }
  if (options.requireStrongPassword && password.length < MIN_AUTH_PASSWORD_LENGTH) {
    throw new AuthPublicError(
      `Le mot de passe doit contenir au moins ${MIN_AUTH_PASSWORD_LENGTH} caractères.`,
    );
  }
  if (displayName.length > 120) {
    throw new AuthPublicError('Le nom affiché est trop long.');
  }
  return { email, password, displayName };
}

export function safeAuthReturnPath(value: string | null | undefined) {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/compte';
  try {
    const url = new URL(value, 'https://zentra.local');
    if (url.origin !== 'https://zentra.local') return '/compte';
    if (url.pathname.startsWith('/api/auth') || url.pathname === '/connexion') {
      return '/compte';
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '/compte';
  }
}

export function authNoStoreHeaders() {
  return {
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };
}

export function publicAuthUser(user: {
  id: string;
  email: string;
  displayName: string;
  emailConfirmed: boolean;
}) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    emailConfirmed: user.emailConfirmed,
  };
}

export function authJsonError(error: unknown) {
  let status = 500;
  let message = 'L’authentification est temporairement indisponible.';
  if (error instanceof AuthPublicError || error instanceof AccountPublicError) {
    status = error.status;
    message = error.message;
  } else if (error instanceof SupabaseAuthError) {
    const code = error.code.toLowerCase();
    if (code.includes('invalid_credentials') || error.status === 401) {
      status = 401;
      message = 'Adresse e-mail ou mot de passe incorrect.';
    } else if (code.includes('email_not_confirmed')) {
      status = 403;
      message = 'Confirmez votre adresse e-mail avant de vous connecter.';
    } else if (code.includes('weak_password')) {
      status = 400;
      message = 'Choisissez un mot de passe plus robuste.';
    } else if (
      code.includes('user_already_exists') ||
      code.includes('email_exists')
    ) {
      status = 409;
      message = 'Un compte existe déjà pour cette adresse e-mail.';
    } else if (code.includes('rate') || error.status === 429) {
      status = 429;
      message = 'Trop de tentatives. Réessayez dans quelques minutes.';
    } else if (error.status >= 400 && error.status < 500) {
      status = 400;
      message = 'La demande d’authentification a été refusée.';
    } else {
      status = error.status === 504 ? 504 : 502;
    }
  }
  return Response.json(
    { error: message },
    { status, headers: authNoStoreHeaders() },
  );
}

export function isRejectedAuthCredential(error: unknown) {
  return (
    error instanceof SupabaseAuthError &&
    (error.status === 400 || error.status === 401 || error.status === 403)
  );
}
