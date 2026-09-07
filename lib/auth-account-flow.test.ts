import { beforeEach, describe, expect, it, vi } from 'vitest';

const stubs = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  cookieOptions: new Map<string, Record<string, unknown>>(),
  signIn: vi.fn(),
  signUp: vi.fn(),
  exchangePkceCode: vi.fn(),
  requestPasswordReset: vi.fn(),
  updatePassword: vi.fn(),
  signOut: vi.fn(),
  getUser: vi.fn(),
  refresh: vi.fn(),
  rate: vi.fn(),
  run: vi.fn(),
  bind: vi.fn(),
  prepare: vi.fn(),
  sitesUser: vi.fn(),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      stubs.jar.has(name) ? { value: stubs.jar.get(name) } : undefined,
    set: (name: string, value: string, options: Record<string, unknown>) => {
      stubs.jar.set(name, value);
      stubs.cookieOptions.set(name, options);
    },
  }),
}));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@/app/chatgpt-auth', () => ({ getChatGPTUser: stubs.sitesUser }));
vi.mock('@/lib/account', () => ({ enforceAccountRateLimit: stubs.rate }));
vi.mock('@/lib/runtime', () => ({
  database: () => ({ prepare: stubs.prepare }),
}));
vi.mock('@/lib/supabase-auth-runtime', () => ({
  supabaseAuthClient: () => stubs,
  optionalSupabaseAuthClient: () => stubs,
  supabaseAuthSiteOrigin: () => 'https://zentra.example',
}));

import { POST as signIn } from '../app/api/auth/connexion/route';
import { POST as signUp } from '../app/api/auth/inscription/route';
import { GET as confirm } from '../app/api/auth/confirmation/route';
import {
  POST as recover,
  PUT as update,
} from '../app/api/auth/mot-de-passe/route';
import { POST as signOut } from '../app/api/auth/deconnexion/route';
import { GET as currentSession } from '../app/api/auth/session/route';
import { GET as browserSession } from '../app/api/account/browser-session/route';
import { getZentraUser } from '../app/zentra-auth';
import {
  SUPABASE_ACCESS_COOKIE,
  SUPABASE_AUTH_RETURN_COOKIE,
  SUPABASE_PKCE_COOKIE,
  SUPABASE_REFRESH_COOKIE,
} from './supabase-auth-cookie-policy';
import { SupabaseAuthError } from './supabase-auth';

const user = {
  id: 'owner-test',
  email: 'owner@example.test',
  displayName: 'Test owner',
  emailConfirmed: true,
};
const session = {
  accessToken: 'test-access',
  refreshToken: 'test-refresh',
  expiresIn: 3600,
  expiresAt: null,
  user,
};
function request(
  path: string,
  body: unknown,
  method: 'POST' | 'PUT' = 'POST',
  origin = 'https://zentra.example',
) {
  return new Request(`https://zentra.example${path}`, {
    method,
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  stubs.jar.clear();
  stubs.cookieOptions.clear();
  stubs.signIn.mockResolvedValue(session);
  stubs.exchangePkceCode.mockResolvedValue(session);
  stubs.signUp.mockResolvedValue({ user, session: null });
  stubs.getUser.mockResolvedValue(user);
  stubs.refresh.mockResolvedValue(session);
  stubs.prepare.mockReturnValue({ bind: stubs.bind });
  stubs.bind.mockReturnValue({ run: stubs.run });
  stubs.run.mockResolvedValue({ success: true });
  stubs.sitesUser.mockResolvedValue(null);
});

describe('Account authentication routes and cookie flow', () => {
  it('recognizes the existing Sites account in navigation without redirecting personal sign-in', async () => {
    stubs.sitesUser.mockResolvedValue({
      userId: 'sites-owner',
      email: 'owner@example.test',
      displayName: 'Owner',
      fullName: 'Owner',
    });
    const response = await browserSession(
      new Request('https://zentra.example/api/account/browser-session'),
    );
    expect(await response.json()).toEqual({ authenticated: true });
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(
      await (
        await currentSession(
          new Request('https://zentra.example/api/auth/session'),
        )
      ).json(),
    ).toEqual({ authenticated: false });
  });

  it('shows a confirmed personal account in navigation and renews its expired session', async () => {
    stubs.jar.set(SUPABASE_ACCESS_COOKIE, 'expired');
    stubs.jar.set(SUPABASE_REFRESH_COOKIE, 'old-refresh');
    stubs.getUser.mockRejectedValue(
      new SupabaseAuthError('expired', 401, 'invalid_credentials'),
    );
    const response = await browserSession(
      new Request('https://zentra.example/api/account/browser-session'),
    );
    expect(await response.json()).toEqual({ authenticated: true });
    expect(stubs.jar.get(SUPABASE_REFRESH_COOKIE)).toBe(session.refreshToken);
    expect(stubs.sitesUser).not.toHaveBeenCalled();
  });

  it('does not replace rejected personal credentials with the Sites identity in navigation', async () => {
    stubs.jar.set(SUPABASE_ACCESS_COOKIE, 'expired');
    stubs.jar.set(SUPABASE_REFRESH_COOKIE, 'revoked');
    stubs.getUser.mockRejectedValue(
      new SupabaseAuthError('expired', 401, 'invalid_credentials'),
    );
    stubs.refresh.mockRejectedValue(
      new SupabaseAuthError('revoked', 401, 'invalid_credentials'),
    );
    const response = await browserSession(
      new Request('https://zentra.example/api/account/browser-session'),
    );
    expect(await response.json()).toEqual({ authenticated: false });
    expect(stubs.sitesUser).not.toHaveBeenCalled();
  });

  it('keeps anonymous navigation unauthenticated and rejects cross-site session reads', async () => {
    expect(
      await (
        await browserSession(
          new Request('https://zentra.example/api/account/browser-session'),
        )
      ).json(),
    ).toEqual({ authenticated: false });
    stubs.sitesUser.mockClear();
    const response = await browserSession(
      new Request('https://zentra.example/api/account/browser-session', {
        headers: { Origin: 'https://attacker.example' },
      }),
    );
    expect(response.status).toBe(403);
    expect(stubs.sitesUser).not.toHaveBeenCalled();
  });

  it('returns an invited person to the same invitation after confirming their signup', async () => {
    const returnTo = '/invitation?token=invitation-for-test';
    const created = await signUp(
      request('/api/auth/inscription', {
        email: user.email,
        password: 'test-password-123',
        displayName: 'Test owner',
        returnTo,
      }),
    );
    expect(created.status).toBe(202);
    expect(stubs.jar.get(SUPABASE_ACCESS_COOKIE)).toBeUndefined();
    expect(stubs.jar.get(SUPABASE_PKCE_COOKIE)?.length).toBeGreaterThanOrEqual(
      43,
    );
    expect(stubs.jar.get(SUPABASE_AUTH_RETURN_COOKIE)).toBe(returnTo);
    const confirmed = await confirm(
      new Request(
        'https://zentra.example/api/auth/confirmation?code=valid-code-for-testing-12345',
      ),
    );
    expect(confirmed.status).toBe(303);
    expect(confirmed.headers.get('location')).toBe(returnTo);
    expect(stubs.jar.get(SUPABASE_PKCE_COOKIE)).toBe('');
    expect(stubs.jar.get(SUPABASE_AUTH_RETURN_COOKIE)).toBe('');
    expect(stubs.jar.get(SUPABASE_ACCESS_COOKIE)).toBe(session.accessToken);
    expect(stubs.cookieOptions.get(SUPABASE_ACCESS_COOKIE)).toMatchObject({
      httpOnly: true,
      secure: true,
      path: '/',
      sameSite: 'lax',
    });
  });

  it('blocks an open redirect supplied at signup and consumes the PKCE verifier once', async () => {
    await signUp(
      request('/api/auth/inscription', {
        email: user.email,
        password: 'test-password-123',
        returnTo: '//attacker.example',
      }),
    );
    expect(stubs.jar.get(SUPABASE_AUTH_RETURN_COOKIE)).toBe('/compte');
    await confirm(
      new Request(
        'https://zentra.example/api/auth/confirmation?code=valid-code-for-testing-12345',
      ),
    );
    const replay = await confirm(
      new Request(
        'https://zentra.example/api/auth/confirmation?code=valid-code-for-testing-12345',
      ),
    );
    expect(replay.headers.get('location')).toContain('navigateur_different');
    expect(stubs.exchangePkceCode).toHaveBeenCalledTimes(1);
  });

  it('uses each personal account and never exposes access or refresh tokens in the response', async () => {
    for (const id of ['owner-test', 'collaborator-test']) {
      const account = { ...user, id, email: `${id}@example.test` };
      stubs.signIn.mockResolvedValue({ ...session, user: account });
      const response = await signIn(
        request('/api/auth/connexion', {
          email: account.email,
          password: 'test-password-123',
        }),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { user: { id: string } };
      expect(body.user.id).toBe(id);
      expect(JSON.stringify(body)).not.toContain(session.accessToken);
      expect(JSON.stringify(body)).not.toContain(session.refreshToken);
    }
  });

  it('denies unconfirmed email addresses at sign-in and on protected routes', async () => {
    stubs.signIn.mockResolvedValue({
      ...session,
      user: { ...user, emailConfirmed: false },
    });
    const response = await signIn(
      request('/api/auth/connexion', {
        email: user.email,
        password: 'test-password-123',
      }),
    );
    expect(response.status).toBe(403);
    expect(stubs.jar.get(SUPABASE_ACCESS_COOKIE)).toBeUndefined();
    stubs.jar.set(SUPABASE_ACCESS_COOKIE, 'unconfirmed');
    stubs.getUser.mockResolvedValue({ ...user, emailConfirmed: false });
    expect(await getZentraUser()).toBeNull();
    expect(stubs.sitesUser).not.toHaveBeenCalled();
    const sessionResponse = await currentSession(
      new Request('https://zentra.example/api/auth/session'),
    );
    expect(await sessionResponse.json()).toEqual({ authenticated: false });
    expect(stubs.jar.get(SUPABASE_ACCESS_COOKIE)).toBe('');
  });

  it('rotates an expired session without switching to another account provider', async () => {
    stubs.jar.set(SUPABASE_ACCESS_COOKIE, 'expired');
    stubs.jar.set(SUPABASE_REFRESH_COOKIE, 'old-refresh');
    stubs.getUser.mockRejectedValue(
      new SupabaseAuthError('expired', 401, 'invalid_credentials'),
    );
    expect((await getZentraUser({ refreshSession: true }))?.userId).toBe(
      user.id,
    );
    expect(stubs.refresh).toHaveBeenCalledWith('old-refresh');
    expect(stubs.jar.get(SUPABASE_REFRESH_COOKIE)).toBe(session.refreshToken);
    expect(stubs.sitesUser).not.toHaveBeenCalled();
  });

  it('requests recovery with PKCE and directs the confirmed link to the password form', async () => {
    const response = await recover(
      request('/api/auth/mot-de-passe', { email: user.email }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ requested: true });
    expect(stubs.requestPasswordReset).toHaveBeenCalledWith(user.email, {
      emailRedirectTo: 'https://zentra.example/api/auth/confirmation',
      codeChallenge: expect.any(String),
    });
    expect(stubs.jar.get(SUPABASE_AUTH_RETURN_COOKIE)).toBe(
      '/mot-de-passe/nouveau',
    );
  });

  it('updates a confirmed user password and revokes device and browser sessions', async () => {
    stubs.jar.set(SUPABASE_ACCESS_COOKIE, session.accessToken);
    const response = await update(
      request(
        '/api/auth/mot-de-passe',
        { password: 'new-password-1234' },
        'PUT',
      ),
    );
    expect(response.status).toBe(200);
    expect(stubs.updatePassword).toHaveBeenCalledWith(
      session.accessToken,
      'new-password-1234',
    );
    expect(stubs.prepare).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE device_sessions SET revoked_at='),
    );
    expect(stubs.bind).toHaveBeenCalledWith(expect.any(Number), user.id);
    expect(stubs.signOut).toHaveBeenCalledWith(session.accessToken, 'global');
    expect(stubs.jar.get(SUPABASE_ACCESS_COOKIE)).toBe('');
  });

  it('rejects malformed bodies, cross-site recovery and unauthenticated password updates', async () => {
    expect(
      (
        await recover(
          new Request('https://zentra.example/api/auth/mot-de-passe', {
            method: 'POST',
            headers: {
              Origin: 'https://zentra.example',
              'Content-Type': 'application/json',
            },
            body: '{bad',
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await recover(
          request(
            '/api/auth/mot-de-passe',
            { email: user.email },
            'POST',
            'https://attacker.example',
          ),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await update(
          request(
            '/api/auth/mot-de-passe',
            { password: 'new-password-1234' },
            'PUT',
          ),
        )
      ).status,
    ).toBe(401);
    expect(stubs.requestPasswordReset).not.toHaveBeenCalled();
    expect(stubs.updatePassword).not.toHaveBeenCalled();
  });

  it('clears local cookies even when upstream logout is unavailable', async () => {
    stubs.jar.set(SUPABASE_ACCESS_COOKIE, session.accessToken);
    stubs.jar.set(SUPABASE_REFRESH_COOKIE, session.refreshToken);
    stubs.signOut.mockRejectedValue(new Error('unavailable'));
    expect((await signOut(request('/api/auth/deconnexion', {}))).status).toBe(
      200,
    );
    expect(stubs.jar.get(SUPABASE_ACCESS_COOKIE)).toBe('');
    expect(stubs.jar.get(SUPABASE_REFRESH_COOKIE)).toBe('');
  });
});
