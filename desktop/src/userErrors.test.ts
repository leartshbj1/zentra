import { describe, expect, it } from 'vitest';
import { appLanguages } from './language';
import { classifyUserError, getUserError, safeErrorDetails, userErrorCopy } from './userErrors';
import { errorMessage } from './utils';

describe('messages humains et données brutes des erreurs', () => {
  it.each([
    [new Error('Failed to fetch'), 'network'], [{ status: 503, message: 'unavailable' }, 'network'], ['network request failed', 'network'],
    [{ status: 401, message: 'JWT expired' }, 'session'], ['refresh_token expired', 'session'],
    [{ statusCode: '403', message: 'denied' }, 'permission'], ['new row violates row-level security policy', 'permission'],
    [{ code: '23505', message: 'duplicate key' }, 'conflict'], ['database is locked', 'conflict'], ['version modifiée ailleurs', 'conflict'],
    [{ status: 422, message: 'invalid input' }, 'validation'], ['Le montant doit être positif.', 'validation'],
    ['ENOENT no such file', 'file'], ['no space left on device', 'file'], ['Fichier introuvable', 'file'],
    [new Error('unexpected internal state at crate::secret'), 'unknown'], [null, 'unknown'], [{ unexpected: true }, 'unknown'],
  ])('classe %s sans modifier la raison originale', (reason, kind) => {
    const raw = errorMessage(reason, 'fallback');
    expect(classifyUserError(reason)).toBe(kind);
    expect(errorMessage(reason, 'fallback')).toBe(raw);
  });

  it.each(appLanguages)('donne une explication et une correction pour toutes les familles en %s', language => {
    const labels = userErrorCopy(language);
    for (const kind of ['network', 'session', 'permission', 'conflict', 'validation', 'file', 'unknown'] as const) {
      expect(labels[kind].title.length).toBeGreaterThan(8);
      expect(labels[kind].message.length).toBeGreaterThan(20);
      expect(labels[kind].action.length).toBeGreaterThan(20);
      if (language !== 'fr') expect(labels[kind]).not.toEqual(userErrorCopy('fr')[kind]);
    }
  });

  it.each(appLanguages)('explique une mutation incertaine sans inviter à la répéter en %s', language => {
    const mutation = getUserError('Failed to fetch', { language, operation: 'mutation' });
    expect(mutation.action).toContain(userErrorCopy(language).uncertain);
    expect(getUserError('Failed to fetch', { language, operation: 'read' }).action).not.toContain(userErrorCopy(language).uncertain);
  });

  it('ne transforme pas un message interne inconnu en explication principale', () => {
    const raw = 'panic internal::billing customer="Alice" password=unsafe';
    const error = getUserError(raw, { fallback: 'Le brouillon reste ouvert.' });
    expect(error.message).toBe('Le brouillon reste ouvert.');
    expect(error.message).not.toContain('panic');
    expect(error.technicalDetails).not.toContain('Alice');
    expect(error.technicalDetails).not.toContain('unsafe');
  });

  it('évite les invitations à réenregistrer héritées des anciens fallbacks', () => {
    const error = getUserError('internal panic', { fallback: 'Réessayez de créer la facture.' });
    expect(error.message).not.toMatch(/Réessayez/);
    expect(error.action).toContain('vérifiez si l’action apparaît déjà');
  });

  it('conserve les messages métier utilisés par les garde-fous et contract tests', () => {
    const original = new Error('UNIQUE constraint failed: invoices.number');
    getUserError(original);
    expect(errorMessage(original, 'Erreur')).toBe('UNIQUE constraint failed: invoices.number');
    expect(original.message).toBe('UNIQUE constraint failed: invoices.number');
  });
});

describe('détails techniques sans secrets', () => {
  it.each([
    ['Authorization: Bearer abcdefghijklmnop', 'abcdefghijklmnop'],
    ['password=very-secret', 'very-secret'],
    ['password contains private phrase with spaces', 'private phrase'],
    ['Cookie: first=secret; second=private-value', 'private-value'],
    ['{"client_secret":"very-secret"}', 'very-secret'],
    ['token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature', 'eyJhbGciOiJIUzI1NiJ9'],
    ['postgres://user:secret@host/private_db', 'secret@host'],
    ['https://host/private?api_key=my-secret#access', 'my-secret'],
    ['alice@example.ch', 'alice@example.ch'],
    ['C:\\Users\\Alice\\private\\bank.pdf', 'Alice'],
    ['/home/alice/private/company.db', 'alice'],
    ["INSERT INTO customers VALUES ('Private customer', 'confidential')", 'Private customer'],
    ['sk_test_123456789abcdefghijk', 'sk_test_'],
    ['CH9300762011623852957', 'CH9300762011623852957'],
  ])('retire la donnée sensible de %s', (raw, secret) => expect(safeErrorDetails(raw)).not.toContain(secret));

  it('borne les détails sans conserver une pile complète ni un objet arbitraire', () => {
    const reason = Object.assign(new Error('network failed'), { password: 'hidden', stack: 'secret stack' });
    expect(safeErrorDetails(reason)).toBe('network failed');
    expect(safeErrorDetails('unexpected '.repeat(1_000)).length).toBeLessThanOrEqual(900);
    expect(safeErrorDetails({ password: 'hidden' })).toBe('');
  });

  it('peut expliquer une erreur dont les propriétés ne sont pas lisibles', () => {
    const error = Object.defineProperties({}, { message: { get() { throw new Error('unreadable'); } }, status: { get() { throw new Error('unreadable'); } }, code: { get() { throw new Error('unreadable'); } } });
    expect(getUserError(error).kind).toBe('unknown');
    expect(safeErrorDetails(error)).toBe('');
  });
});
