import { describe, expect, it } from 'vitest';
import { canonicalNavigationTarget } from './canonical-navigation';

describe('Zentra domain navigation', () => {
  it.each(['/compte', '/appareil?code=ABCD-EFGH', '/invitation?token=example', '/download', '/paiement/succes?session_id=cs_example'])(
    'preserves the route and parameters of %s', path => {
      expect(canonicalNavigationTarget(new Request(`https://elyko.alb-leart1.chatgpt.site${path}`))).toBe(`https://zentraapp.ch${path}`);
    },
  );
  it('does not trust forwarded hosts or permit an open redirect', () => {
    expect(canonicalNavigationTarget(new Request('https://zentraapp.ch/compte', { headers: { 'x-forwarded-host': 'evil.example' } }))).toBeNull();
    expect(canonicalNavigationTarget(new Request('https://www.zentraapp.ch//evil.example/'))).toBe('https://zentraapp.ch//evil.example/');
  });
  it.each(['/api/auth/confirmation?code=example', '/api/account/collaboration?watch=1', '/mot-de-passe/nouveau', '/connexion?code=example'])(
    'preserves an existing API or PKCE flow %s', path => expect(canonicalNavigationTarget(new Request(`https://elyko.alb-leart1.chatgpt.site${path}`))).toBeNull(),
  );
  it('never redirects a mutation or the canonical host', () => {
    expect(canonicalNavigationTarget(new Request('https://www.zentraapp.ch/api/stripe/webhook', { method: 'POST' }))).toBeNull();
    expect(canonicalNavigationTarget(new Request('https://zentraapp.ch/compte'))).toBeNull();
  });
});
