import { afterEach, describe, expect, it, vi } from 'vitest';
import { trustedSiteRequestOrigin } from './site-origins';

const canonical = 'https://zentraapp.ch';
const legacy = 'https://elyko.alb-leart1.chatgpt.site';
const aliases = `${legacy},https://www.zentraapp.ch`;
vi.mock('cloudflare:workers', () => ({ env: {} }));
afterEach(() => vi.unstubAllEnvs());

describe('custom domain migration', () => {
  it.each([canonical, legacy, 'https://www.zentraapp.ch'])(
    'keeps cookies and payment returns on %s',
    async (origin) => {
      vi.stubEnv('PUBLIC_SITE_URL', canonical);
      vi.stubEnv('SITE_ORIGIN_ALIASES', aliases);
      const request = new Request(`${origin}/api/auth/inscription`, {
        headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin' },
      });
      const { supabaseAuthSiteOrigin } =
        await import('./supabase-auth-runtime');
      const { requireSameOrigin } = await import('./stripe');
      expect(supabaseAuthSiteOrigin(request)).toBe(origin);
      expect(requireSameOrigin(request)).toBe(origin);
    },
  );

  it('rejects cross-origin requests even between trusted domains', async () => {
    vi.stubEnv('PUBLIC_SITE_URL', canonical);
    vi.stubEnv('SITE_ORIGIN_ALIASES', aliases);
    const { requireSameOrigin } = await import('./stripe');
    expect(() =>
      requireSameOrigin(
        new Request(`${canonical}/api/stripe/checkout`, {
          headers: { Origin: legacy, 'Sec-Fetch-Site': 'same-origin' },
        }),
      ),
    ).toThrow('Requête intersite');
  });

  it('ignores forged forwarded hosts and rejects unregistered domains', () => {
    const request = new Request('https://attacker.example/path', {
      headers: { 'X-Forwarded-Host': 'zentraapp.ch' },
    });
    expect(() => trustedSiteRequestOrigin(request, canonical, aliases)).toThrow(
      'Origine du site refusée',
    );
  });

  it.each([
    'https://zentraapp.ch.evil.example',
    'http://zentraapp.ch',
    'https://www.zentraapp.ch:444',
  ])('rejects the untrusted request %s', (origin) => {
    expect(() =>
      trustedSiteRequestOrigin(new Request(`${origin}/`), canonical, aliases),
    ).toThrow();
  });

  it('allows unconfigured development only on loopback', () => {
    expect(
      trustedSiteRequestOrigin(
        new Request('http://127.0.0.1:5193/api?x=1'),
        '',
      ),
    ).toBe('http://127.0.0.1:5193');
    expect(() =>
      trustedSiteRequestOrigin(new Request(`${canonical}/`), ''),
    ).toThrow('requis');
    expect(() =>
      trustedSiteRequestOrigin(
        new Request(`${canonical}/`),
        `${canonical}/bad`,
      ),
    ).toThrow();
  });

  it('keeps the existing webhook address independent of the canonical domain', async () => {
    vi.stubEnv('PUBLIC_SITE_URL', canonical);
    vi.stubEnv('STRIPE_WEBHOOK_URL', `${legacy}/api/stripe/webhook`);
    const { stripeConfiguration } = await import('./runtime');
    expect(stripeConfiguration().siteUrl).toBe(canonical);
    expect(stripeConfiguration().webhookUrl).toBe(
      `${legacy}/api/stripe/webhook`,
    );
  });
});
