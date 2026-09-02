import {
  isValidPkceChallenge,
  isValidPkceVerifier,
  isValidSupabaseAuthCode,
} from './supabase-auth-pkce';

export type SupabaseAuthConfiguration = {
  url: string;
  publishableKey: string;
};

export type SupabaseAuthUser = {
  id: string;
  email: string;
  displayName: string;
  emailConfirmed: boolean;
};

export type SupabaseAuthSession = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  expiresAt: number | null;
  user: SupabaseAuthUser;
};

export type SupabaseSignUpResult = {
  session: SupabaseAuthSession | null;
  user: SupabaseAuthUser;
};

export type SupabasePkceSignUpOptions = {
  emailRedirectTo: string;
  codeChallenge: string;
};

export class SupabaseAuthError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code = 'supabase_auth_error') {
    super(message);
    this.name = 'SupabaseAuthError';
    this.status = status;
    this.code = code;
  }
}

type JsonRecord = Record<string, unknown>;
type AuthFetch = typeof fetch;

const AUTH_TIMEOUT_MS = 12_000;

export function validateSupabaseAuthConfiguration(
  input: SupabaseAuthConfiguration,
): SupabaseAuthConfiguration {
  const rawUrl = input.url.trim();
  const publishableKey = input.publishableKey.trim();
  if (!rawUrl || !publishableKey) {
    throw new Error('Supabase Auth n’est pas configuré.');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('SUPABASE_URL est invalide.');
  }

  const isLocal =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '::1';
  if (parsed.protocol !== 'https:' && !(isLocal && parsed.protocol === 'http:')) {
    throw new Error('SUPABASE_URL doit utiliser HTTPS.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('SUPABASE_URL ne doit contenir ni identifiants ni paramètres.');
  }
  if (!/^sb_publishable_[A-Za-z0-9_-]{16,}$/.test(publishableKey)) {
    throw new Error('SUPABASE_PUBLISHABLE_KEY doit être une clé publiable Supabase.');
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return {
    url: parsed.toString().replace(/\/$/, ''),
    publishableKey,
  };
}

export function createSupabaseAuthClient(
  rawConfiguration: SupabaseAuthConfiguration,
  fetcher: AuthFetch = fetch,
) {
  const configuration = validateSupabaseAuthConfiguration(rawConfiguration);

  async function request<T>(
    path: string,
    options: {
      method?: 'GET' | 'POST';
      accessToken?: string;
      body?: JsonRecord;
    } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);
    try {
      const response = await fetcher(`${configuration.url}${path}`, {
        method: options.method ?? 'GET',
        headers: {
          apikey: configuration.publishableKey,
          Accept: 'application/json',
          ...(options.accessToken
            ? { Authorization: `Bearer ${options.accessToken}` }
            : {}),
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          'X-Client-Info': 'zentra-site/1.0',
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        cache: 'no-store',
        redirect: 'manual',
        signal: controller.signal,
      });
      const text = await response.text();
      const payload = parseJsonRecord(text);
      if (!response.ok) {
        const message =
          readString(payload, 'msg') ??
          readString(payload, 'message') ??
          readString(payload, 'error_description') ??
          'La demande d’authentification a échoué.';
        const code =
          readString(payload, 'code') ??
          readString(payload, 'error_code') ??
          'supabase_auth_error';
        throw new SupabaseAuthError(message, response.status, code);
      }
      return payload as T;
    } catch (error) {
      if (error instanceof SupabaseAuthError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new SupabaseAuthError(
          'Le service d’authentification ne répond pas.',
          504,
          'auth_timeout',
        );
      }
      throw new SupabaseAuthError(
        'Le service d’authentification est temporairement indisponible.',
        502,
        'auth_unavailable',
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async signIn(email: string, password: string): Promise<SupabaseAuthSession> {
      const payload = await request<JsonRecord>(
        '/auth/v1/token?grant_type=password',
        {
          method: 'POST',
          body: { email, password },
        },
      );
      return parseSession(payload);
    },

    async signUp(
      email: string,
      password: string,
      displayName: string,
      options: SupabasePkceSignUpOptions,
    ): Promise<SupabaseSignUpResult> {
      if (!isValidPkceChallenge(options.codeChallenge)) {
        throw new SupabaseAuthError(
          'Le challenge PKCE est invalide.',
          400,
          'invalid_pkce_challenge',
        );
      }
      const redirectUrl = validatedAuthRedirect(options.emailRedirectTo);
      const query = `?redirect_to=${encodeURIComponent(redirectUrl)}`;
      const payload = await request<JsonRecord>(`/auth/v1/signup${query}`, {
        method: 'POST',
        body: {
          email,
          password,
          ...(displayName ? { data: { full_name: displayName } } : {}),
          code_challenge: options.codeChallenge,
          code_challenge_method: 's256',
        },
      });
      const user = parseUser(asRecord(payload.user) ?? payload);
      const sessionPayload = asRecord(payload.session) ?? payload;
      const session = hasString(sessionPayload, 'access_token')
        ? parseSession(sessionPayload, user)
        : null;
      return { session, user };
    },

    async exchangePkceCode(
      authCode: string,
      codeVerifier: string,
    ): Promise<SupabaseAuthSession> {
      if (
        !isValidSupabaseAuthCode(authCode) ||
        !isValidPkceVerifier(codeVerifier)
      ) {
        throw new SupabaseAuthError(
          'La confirmation PKCE est invalide.',
          400,
          'invalid_pkce_exchange',
        );
      }
      const payload = await request<JsonRecord>(
        '/auth/v1/token?grant_type=pkce',
        {
          method: 'POST',
          body: {
            auth_code: authCode,
            code_verifier: codeVerifier,
          },
        },
      );
      return parseSession(payload);
    },

    async refresh(refreshToken: string): Promise<SupabaseAuthSession> {
      const payload = await request<JsonRecord>(
        '/auth/v1/token?grant_type=refresh_token',
        {
          method: 'POST',
          body: { refresh_token: refreshToken },
        },
      );
      return parseSession(payload);
    },

    async getUser(accessToken: string): Promise<SupabaseAuthUser> {
      const payload = await request<JsonRecord>('/auth/v1/user', {
        accessToken,
      });
      return parseUser(payload);
    },

    async signOut(accessToken: string): Promise<void> {
      await request<JsonRecord>('/auth/v1/logout?scope=local', {
        method: 'POST',
        accessToken,
      });
    },
  };
}

function parseSession(
  payload: JsonRecord,
  fallbackUser?: SupabaseAuthUser,
): SupabaseAuthSession {
  const accessToken = readString(payload, 'access_token');
  const refreshToken = readString(payload, 'refresh_token');
  if (!accessToken || !refreshToken) {
    throw new SupabaseAuthError(
      'La réponse de session Supabase est incomplète.',
      502,
      'invalid_auth_response',
    );
  }
  const rawExpiresIn = readNumber(payload, 'expires_in');
  const rawExpiresAt = readNumber(payload, 'expires_at');
  const userRecord = asRecord(payload.user);
  return {
    accessToken,
    refreshToken,
    expiresIn:
      rawExpiresIn && Number.isFinite(rawExpiresIn)
        ? Math.max(60, Math.floor(rawExpiresIn))
        : 3_600,
    expiresAt:
      rawExpiresAt && Number.isFinite(rawExpiresAt)
        ? Math.floor(rawExpiresAt)
        : null,
    user: userRecord ? parseUser(userRecord) : requireFallbackUser(fallbackUser),
  };
}

function parseUser(payload: JsonRecord): SupabaseAuthUser {
  const id = readString(payload, 'id');
  const email = readString(payload, 'email')?.trim().toLowerCase();
  if (!id || !email) {
    throw new SupabaseAuthError(
      'La réponse utilisateur Supabase est incomplète.',
      502,
      'invalid_user_response',
    );
  }
  const metadata = asRecord(payload.user_metadata);
  const name =
    (metadata &&
      (readString(metadata, 'full_name') ?? readString(metadata, 'name'))?.trim()) ||
    '';
  return {
    id,
    email,
    displayName: name || email,
    emailConfirmed: Boolean(readString(payload, 'email_confirmed_at')),
  };
}

function requireFallbackUser(user: SupabaseAuthUser | undefined) {
  if (user) return user;
  throw new SupabaseAuthError(
    'La réponse de session Supabase ne contient pas d’utilisateur.',
    502,
    'invalid_auth_response',
  );
}

function parseJsonRecord(text: string): JsonRecord {
  if (!text.trim()) return {};
  try {
    return asRecord(JSON.parse(text)) ?? {};
  } catch {
    return {};
  }
}

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function readString(record: JsonRecord, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value ? value : null;
}

function readNumber(record: JsonRecord, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' ? value : null;
}

function hasString(record: JsonRecord, key: string): boolean {
  return typeof record[key] === 'string' && Boolean(record[key]);
}

function validatedAuthRedirect(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SupabaseAuthError(
      'L’URL de confirmation est invalide.',
      400,
      'invalid_redirect_url',
    );
  }
  const isLocal =
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '::1';
  if (
    (url.protocol !== 'https:' && !(isLocal && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new SupabaseAuthError(
      'L’URL de confirmation est invalide.',
      400,
      'invalid_redirect_url',
    );
  }
  return url.toString();
}
