import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, createHash } from 'node:crypto';
const env = vi.hoisted(() => ({
  values: {} as Record<string, string>,
  rate: vi.fn(),
}));
vi.mock('@/lib/runtime', () => ({
  runtimeValue: (k: string) => env.values[k] || '',
}));
vi.mock('@/lib/account', () => ({ enforceAccountRateLimit: env.rate }));
import {
  createAdminSession,
  hasAdminSession,
  adminCookie,
  ADMIN_SESSION_SECONDS,
} from './admin-session';

const token = 'zsa_' + randomBytes(48).toString('base64url');
const request = (cookie = '') =>
  new Request('https://zentraapp.ch/api/support?admin=1', {
    headers: { Cookie: cookie },
  });
describe('Accès privé par jeton', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-19T12:00:00Z'));
    env.values = {
      SUPPORT_ADMIN_TOKEN_SHA256: createHash('sha256')
        .update(token)
        .digest('hex'),
      SUPPORT_ADMIN_SESSION_KEY: randomBytes(32).toString('base64url'),
    };
    env.rate.mockReset();
    env.rate.mockResolvedValue(undefined);
  });
  afterEach(() => vi.useRealTimers());
  it('échange le jeton contre une session signée privée de 8 heures', async () => {
    const session = await createAdminSession(request(), token),
      cookie = adminCookie(request(), session);
    expect(session).not.toContain(token);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/api/support');
    expect(await hasAdminSession(request(cookie.split(';')[0]))).toBe(true);
    expect(env.rate).toHaveBeenCalledWith(
      expect.any(Request),
      'support-admin-login',
      'platform',
      12,
    );
    vi.advanceTimersByTime(ADMIN_SESSION_SECONDS * 1000);
    expect(await hasAdminSession(request(cookie.split(';')[0]))).toBe(false);
  });
  it('refuse un faux jeton, une signature modifiée et les doubles cookies', async () => {
    await expect(
      createAdminSession(request(), 'zsa_' + 'x'.repeat(64)),
    ).rejects.toMatchObject({ status: 401 });
    const session = await createAdminSession(request(), token),
      cookie = adminCookie(request(), session).split(';')[0];
    expect(await hasAdminSession(request(cookie.slice(0, -6) + 'aaaaaa'))).toBe(
      false,
    );
    expect(await hasAdminSession(request(cookie + '; ' + cookie))).toBe(false);
    expect(
      await hasAdminSession(
        new Request('https://zentraapp.ch/api/support?admin=1&token=' + token),
      ),
    ).toBe(false);
  });
  it('révoque les sessions quand le jeton maître ou la clé de session change', async () => {
    const cookie = adminCookie(
      request(),
      await createAdminSession(request(), token),
    ).split(';')[0];
    env.values.SUPPORT_ADMIN_TOKEN_SHA256 = 'a'.repeat(64);
    expect(await hasAdminSession(request(cookie))).toBe(false);
    env.values.SUPPORT_ADMIN_TOKEN_SHA256 = createHash('sha256')
      .update(token)
      .digest('hex');
    env.values.SUPPORT_ADMIN_SESSION_KEY =
      randomBytes(32).toString('base64url');
    expect(await hasAdminSession(request(cookie))).toBe(false);
  });
  it('reste fermé si non configuré ou limité et utilise HTTPS hors développement', async () => {
    env.rate.mockRejectedValueOnce(
      Object.assign(new Error('rate'), { status: 429 }),
    );
    await expect(createAdminSession(request(), token)).rejects.toMatchObject({
      status: 429,
    });
    delete env.values.SUPPORT_ADMIN_TOKEN_SHA256;
    await expect(createAdminSession(request(), token)).rejects.toMatchObject({
      status: 503,
    });
    expect(await hasAdminSession(request('garbage'))).toBe(false);
    expect(() =>
      adminCookie(new Request('http://zentraapp.ch/api/support'), 'x'),
    ).toThrow('HTTPS');
    expect(adminCookie(request(), '', 0)).toContain('Max-Age=0');
  });
});
