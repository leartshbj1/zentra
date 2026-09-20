import { describe, expect, it } from 'vitest';
import {
  authJsonError,
  isRejectedAuthCredential,
  readAuthCredentials,
  requireAuthSameOrigin,
  safeAuthReturnPath,
} from './supabase-auth-http';
import { SupabaseAuthError } from './supabase-auth';

describe('garde-fous HTTP Auth', () => {
  it.each(['confirmation', 'recovery', 'magic link', 'email change'])(
    'explique un échec d’envoi %s sans exposer les détails du fournisseur',
    async (kind) => {
      const response = authJsonError(
        new SupabaseAuthError(
          `Error sending ${kind} email: SMTP private-detail@example.test`,
          500,
          'unexpected_failure',
        ),
      );
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toContain('no-store');
      const body = await response.json();
      expect(body).toEqual({ error: expect.stringContaining('notre service d’envoi') });
      expect(JSON.stringify(body)).not.toMatch(/SMTP|private-detail|unexpected_failure/);
    },
  );

  it('ne confond pas une erreur de base de données avec un échec d’envoi', async () => {
    const response = authJsonError(
      new SupabaseAuthError('Database error saving new user', 500, 'unexpected_failure'),
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: 'L’authentification est temporairement indisponible.',
    });
  });

  it('refuse une origine croisée', () => {
    const request = new Request('https://zentra.ch/api/auth/connexion', {
      method: 'POST',
      headers: {
        Origin: 'https://evil.example',
        'Sec-Fetch-Site': 'cross-site',
      },
    });
    expect(() => requireAuthSameOrigin(request)).toThrow('Origine');
  });

  it('accepte la même origine', () => {
    const request = new Request('https://zentra.ch/api/auth/connexion', {
      method: 'POST',
      headers: { Origin: 'https://zentra.ch', 'Sec-Fetch-Site': 'same-origin' },
    });
    expect(() => requireAuthSameOrigin(request)).not.toThrow();
  });

  it('exige une origine explicite sur les POST publics', () => {
    const request = new Request('https://zentra.ch/api/auth/connexion', {
      method: 'POST',
    });
    expect(() =>
      requireAuthSameOrigin(request, { requireOrigin: true }),
    ).toThrow('absente');
  });

  it('normalise les identifiants sans modifier le mot de passe', async () => {
    const request = new Request('https://zentra.ch/api/auth/connexion', {
      method: 'POST',
      body: JSON.stringify({
        email: ' Personne@Entreprise.CH ',
        password: ' mot de passe ',
        displayName: ' Marie Dupont ',
      }),
    });
    await expect(readAuthCredentials(request)).resolves.toEqual({
      email: 'personne@entreprise.ch',
      password: ' mot de passe ',
      displayName: 'Marie Dupont',
      returnTo: '/compte',
    });
  });

  it('impose douze caractères côté serveur', async () => {
    const request = new Request('https://zentra.ch/api/auth/inscription', {
      method: 'POST',
      body: JSON.stringify({
        email: 'personne@entreprise.ch',
        password: '12345678901',
      }),
    });
    await expect(
      readAuthCredentials(request, { requireStrongPassword: true }),
    ).rejects.toThrow('au moins 12 caractères');
  });

  it('laisse Supabase vérifier un ancien mot de passe court à la connexion', async () => {
    const request = new Request('https://zentra.ch/api/auth/connexion', {
      method: 'POST',
      body: JSON.stringify({
        email: 'personne@entreprise.ch',
        password: 'ancien',
      }),
    });
    await expect(readAuthCredentials(request)).resolves.toMatchObject({
      password: 'ancien',
    });
  });

  it('bloque les redirections externes et les boucles Auth', () => {
    expect(safeAuthReturnPath('https://evil.example')).toBe('/compte');
    expect(safeAuthReturnPath('//evil.example')).toBe('/compte');
    expect(safeAuthReturnPath('/connexion')).toBe('/compte');
    expect(safeAuthReturnPath('/compte?onglet=equipe')).toBe(
      '/compte?onglet=equipe',
    );
  });

  it('ne transforme pas une limitation Supabase en session invalide', () => {
    expect(
      isRejectedAuthCredential(new SupabaseAuthError('rate limit', 429)),
    ).toBe(false);
    expect(
      isRejectedAuthCredential(new SupabaseAuthError('expired', 401)),
    ).toBe(true);
  });
});
