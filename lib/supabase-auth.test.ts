import { describe, expect, it, vi } from 'vitest';
import {
  createSupabaseAuthClient,
  SupabaseAuthError,
  validateSupabaseAuthConfiguration,
} from './supabase-auth';
import {
  accessCookieMaxAge,
  authCookieOptions,
  SUPABASE_ACCESS_COOKIE,
  SUPABASE_PKCE_COOKIE,
  SUPABASE_REFRESH_COOKIE,
  PKCE_COOKIE_MAX_AGE,
} from './supabase-auth-cookie-policy';
import { MIN_AUTH_PASSWORD_LENGTH } from './supabase-auth-policy';
import {
  createSupabasePkceFlow,
  isValidSupabaseAuthCode,
  legacySupabaseConfirmationPath,
  pkceS256Challenge,
} from './supabase-auth-pkce';

const configuration = {
  url: 'https://example.supabase.co',
  publishableKey: `sb_publishable_${'a'.repeat(24)}`,
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Supabase Auth REST', () => {
  it('n’accepte qu’une URL sûre et une clé publiable', () => {
    expect(
      validateSupabaseAuthConfiguration({
        url: 'https://example.supabase.co/',
        publishableKey: configuration.publishableKey,
      }),
    ).toEqual(configuration);
    expect(() =>
      validateSupabaseAuthConfiguration({
        url: 'http://example.supabase.co',
        publishableKey: configuration.publishableKey,
      }),
    ).toThrow('HTTPS');
    expect(() =>
      validateSupabaseAuthConfiguration({
        url: configuration.url,
        publishableKey: `sb_secret_${'x'.repeat(32)}`,
      }),
    ).toThrow('clé publiable');
  });

  it('connecte par mot de passe sans envoyer la clé dans le corps', async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({
          access_token: 'access',
          refresh_token: 'refresh',
          expires_in: 3600,
          expires_at: 2_000_000_000,
          user: {
            id: 'user-1',
            email: 'TEST@EXAMPLE.CH',
            email_confirmed_at: '2026-01-01T00:00:00Z',
            user_metadata: { full_name: 'Marie Dupont' },
          },
        }),
    );
    const session = await createSupabaseAuthClient(
      configuration,
      fetcher as typeof fetch,
    ).signIn('test@example.ch', 'mot-de-passe');

    expect(session.user).toMatchObject({
      id: 'user-1',
      email: 'test@example.ch',
      displayName: 'Marie Dupont',
      emailConfirmed: true,
    });
    const call = fetcher.mock.calls[0];
    if (!call) throw new Error('Appel Auth manquant.');
    const [url, request = {}] = call;
    const headers = request.headers as Record<string, string>;
    if (typeof request.body !== 'string') {
      throw new Error('Corps Auth manquant.');
    }
    const body = request.body;
    expect(url).toBe(
      'https://example.supabase.co/auth/v1/token?grant_type=password',
    );
    expect(headers.apikey).toBe(configuration.publishableKey);
    expect(headers.Authorization).toBeUndefined();
    expect(JSON.parse(body)).toEqual({
      email: 'test@example.ch',
      password: 'mot-de-passe',
    });
    expect(body).not.toContain(configuration.publishableKey);
  });

  it('fait tourner le refresh token via GoTrue', async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({
          access_token: 'access-2',
          refresh_token: 'refresh-2',
          expires_in: 3600,
          user: { id: 'user-1', email: 'test@example.ch' },
        }),
    );
    const session = await createSupabaseAuthClient(
      configuration,
      fetcher as typeof fetch,
    ).refresh('refresh-1');
    expect(session.refreshToken).toBe('refresh-2');
    const call = fetcher.mock.calls[0];
    if (!call) throw new Error('Appel de rotation manquant.');
    const [url, request = {}] = call;
    expect(url).toContain('grant_type=refresh_token');
    if (typeof request.body !== 'string') {
      throw new Error('Corps de rotation manquant.');
    }
    expect(JSON.parse(request.body)).toEqual({
      refresh_token: 'refresh-1',
    });
  });

  it('gère une inscription qui attend la confirmation e-mail', async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ id: 'user-2', email: 'new@example.ch' }),
    );
    const result = await createSupabaseAuthClient(
      configuration,
      fetcher as typeof fetch,
    ).signUp('new@example.ch', 'mot-de-passe', 'Nouvelle personne', {
      emailRedirectTo: 'https://zentra.ch/api/auth/confirmation',
      codeChallenge: 'a'.repeat(43),
    });
    expect(result.session).toBeNull();
    expect(result.user.email).toBe('new@example.ch');
    const call = fetcher.mock.calls[0];
    if (!call) throw new Error('Appel d’inscription manquant.');
    const requestUrl =
      typeof call[0] === 'string'
        ? call[0]
        : call[0] instanceof URL
          ? call[0].toString()
          : call[0].url;
    expect(new URL(requestUrl).searchParams.get('redirect_to')).toBe(
      'https://zentra.ch/api/auth/confirmation',
    );
    const request = call[1] ?? {};
    if (typeof request.body !== 'string') {
      throw new Error('Corps PKCE d’inscription manquant.');
    }
    expect(JSON.parse(request.body)).toMatchObject({
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 's256',
    });
  });

  it('échange le code et le vérificateur sur le grant PKCE', async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({
          access_token: 'access-pkce',
          refresh_token: 'refresh-pkce',
          expires_in: 3600,
          user: { id: 'user-pkce', email: 'pkce@example.ch' },
        }),
    );
    const code = 'supabase.opaque-code~2026_abcdef';
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const session = await createSupabaseAuthClient(
      configuration,
      fetcher as typeof fetch,
    ).exchangePkceCode(code, verifier);
    expect(session.user.id).toBe('user-pkce');
    const call = fetcher.mock.calls[0];
    if (!call) throw new Error('Échange PKCE manquant.');
    expect(call[0]).toBe(
      'https://example.supabase.co/auth/v1/token?grant_type=pkce',
    );
    const request = call[1] ?? {};
    if (typeof request.body !== 'string') {
      throw new Error('Corps d’échange PKCE manquant.');
    }
    expect(JSON.parse(request.body)).toEqual({
      auth_code: code,
      code_verifier: verifier,
    });
  });

  it('refuse un challenge ou un échange PKCE invalide sans appel réseau', async () => {
    const fetcher = vi.fn(async () => jsonResponse({}));
    const client = createSupabaseAuthClient(
      configuration,
      fetcher as typeof fetch,
    );
    await expect(
      client.signUp('new@example.ch', 'mot-de-passe', '', {
        emailRedirectTo: 'https://zentra.ch/api/auth/confirmation',
        codeChallenge: 'trop-court',
      }),
    ).rejects.toMatchObject({ code: 'invalid_pkce_challenge' });
    await expect(
      client.exchangePkceCode('trop-court', 'a'.repeat(43)),
    ).rejects.toMatchObject({ code: 'invalid_pkce_exchange' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('retourne une erreur typée sans exposer de secret', async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse(
          { code: 'invalid_credentials', message: 'Invalid login credentials' },
          400,
        ),
    );
    const action = createSupabaseAuthClient(
      configuration,
      fetcher as typeof fetch,
    ).signIn('test@example.ch', 'wrong-password');
    await expect(action).rejects.toMatchObject({
      status: 400,
      code: 'invalid_credentials',
    } satisfies Partial<SupabaseAuthError>);
  });
});

describe('politique de cookies', () => {
  it('utilise des cookies __Host HttpOnly, Secure et SameSite=Lax', () => {
    expect(SUPABASE_ACCESS_COOKIE).toMatch(/^__Host-/);
    expect(SUPABASE_REFRESH_COOKIE).toMatch(/^__Host-/);
    expect(SUPABASE_PKCE_COOKIE).toBe('__Host-zentra_pkce');
    expect(PKCE_COOKIE_MAX_AGE).toBe(600);
    expect(authCookieOptions(120)).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 120,
    });
  });

  it('borne la durée du cookie d’accès', () => {
    expect(accessCookieMaxAge({ expiresIn: 3600, expiresAt: null }, 100)).toBe(
      3600,
    );
    expect(accessCookieMaxAge({ expiresIn: 1, expiresAt: 101 }, 100)).toBe(60);
  });
});

describe('PKCE S256', () => {
  it('reproduit le vecteur RFC 7636', async () => {
    await expect(
      pkceS256Challenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    ).resolves.toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('génère des flux indépendants conformes', async () => {
    const first = await createSupabasePkceFlow();
    const second = await createSupabasePkceFlow();
    expect(first.verifier.length).toBeGreaterThanOrEqual(43);
    expect(first.challenge).toHaveLength(43);
    await expect(pkceS256Challenge(first.verifier)).resolves.toBe(
      first.challenge,
    );
    expect(second.verifier).not.toBe(first.verifier);
  });

  it('accepte un code opaque borné et refuse les contrôles ou excès', () => {
    expect(isValidSupabaseAuthCode('opaque.code~non_uuid_1234')).toBe(true);
    expect(isValidSupabaseAuthCode('trop-court')).toBe(false);
    expect(isValidSupabaseAuthCode(`opaque-code-valide\n`)).toBe(false);
    expect(isValidSupabaseAuthCode('a'.repeat(1025))).toBe(false);
  });

  it('transfère l’ancienne URL de confirmation vers le callback interne exact', () => {
    expect(
      legacySupabaseConfirmationPath({
        confirmation: '1',
        code: 'opaque.code~non_uuid_1234',
      }),
    ).toBe('/api/auth/confirmation?code=opaque.code%7Enon_uuid_1234');
    expect(
      legacySupabaseConfirmationPath({ confirmation: '1', error: 'refused' }),
    ).toBe('/api/auth/confirmation?error=supabase');
    expect(
      legacySupabaseConfirmationPath({
        confirmation: '1',
        code: ['first-code-is-long', 'second-code-is-long'],
      }),
    ).toBe('/api/auth/confirmation?code=');
    expect(
      legacySupabaseConfirmationPath({ code: 'ignored-code-is-long' }),
    ).toBe(null);
  });
});

describe('politique de mot de passe', () => {
  it('reste alignée sur douze caractères minimum', () => {
    expect(MIN_AUTH_PASSWORD_LENGTH).toBe(12);
  });
});
