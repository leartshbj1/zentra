// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalValidationError, localValidationDetails } from './localValidation';
import { classifyUserError, getUserError, userErrorCopy } from './userErrors';
import { classifyDiagnosticError, recentDiagnosticEvents, resolveErrorIncident } from './diagnostics';
import { ErrorGuidance } from './ErrorGuidance';
import type { AppLanguage } from './language';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const instructions: Record<AppLanguage, string> = {
  fr: 'Ligne 1 : Indiquez le prix unitaire, ou 0 pour une prestation offerte.',
  de: 'Zeile 1: Geben Sie den Einzelpreis ein, oder 0 für eine kostenlose Leistung.',
  it: 'Riga 1: Indica il prezzo unitario, oppure 0 per una prestazione gratuita.',
  en: 'Line 1: Enter the unit price, or 0 for a free service.',
};
afterEach(() => vi.unstubAllGlobals());

describe('explicit local validation provenance', () => {
  it.each(['fr', 'de', 'it', 'en'] as const)('shows the authored instruction without uncertain-save copy in %s', language => {
    const error = createLocalValidationError(instructions[language], language);
    const guidance = getUserError(error, { language, operation: 'mutation' });
    expect(guidance).toEqual({ kind: 'validation', title: userErrorCopy(language).validation.title, message: instructions[language], action: userErrorCopy(language).validation.action, technicalDetails: '' });
    expect(guidance.action).not.toContain(userErrorCopy(language).uncertain);
    expect(classifyDiagnosticError(error)).toBe('VALIDATION');
    expect(Object.isFrozen(error)).toBe(true);
    expect(Object.isFrozen(localValidationDetails(error))).toBe(true);
  });

  it.each(['fr', 'de', 'it', 'en'] as const)('keeps the language of a pending instruction and uses current generic validation after a language change from %s', language => {
    const other = language === 'fr' ? 'en' : 'fr';
    const error = createLocalValidationError(instructions[language], language);
    expect(getUserError(error, { language: other })).toMatchObject({ kind: 'validation', ...userErrorCopy(other).validation, technicalDetails: '' });
    expect(localValidationDetails(error)?.language).toBe(language);
    expect(getUserError(error, { language }).message).toBe(instructions[language]);
  });

  it.each([
    ['empty', '', 'fr'], ['blank', '   ', 'fr'],
    ['unknown language', 'Instruction locale.', 'xx'], ['non string', 12, 'fr'],
  ])('rejects invalid local metadata: %s', (_name, message, language) => {
    expect(() => createLocalValidationError(message as string, language as AppLanguage)).toThrow(TypeError);
  });

  it.each([901, 5000, 100000])('bounds a long local template validation of %s units without throwing during render', size => {
    const message = 'Un autre modèle porte déjà le nom « ' + 'N'.repeat(size) + ' ». Choisissez un autre nom.';
    const error = createLocalValidationError(message, 'fr');
    expect(error.message).toBe(message.slice(0, 899) + '…');
    expect(error.message.length).toBe(900);
    expect(localValidationDetails(error)?.message).toBe(error.message);
    expect(getUserError(error).message).toBe(error.message);
    expect(getUserError(error).kind).toBe('validation');
    expect(classifyDiagnosticError(error)).toBe('VALIDATION');
  });

  it('does not split an emoji pair at the retained UTF-16 boundary', () => {
    const message = 'N'.repeat(898) + '💚'.repeat(100);
    const error = createLocalValidationError(message, 'fr');
    expect(error.message).toBe('N'.repeat(898) + '…');
    expect(error.message.length).toBeLessThanOrEqual(900);
    expect(error.message).not.toMatch(/[\uD800-\uDBFF]…$/);
    expect(localValidationDetails(error)?.message).toBe(error.message);
    expect(getUserError(error).kind).toBe('validation');
  });

  it.each([
    ['primitive', () => instructions.fr],
    ['native Error', () => new Error(instructions.fr)],
    ['lookalike', () => ({ message: instructions.fr, language: 'fr', localValidation: true })],
    ['same properties', () => Object.assign(new Error(instructions.fr), { language: 'fr' })],
    ['serialized', () => JSON.parse(JSON.stringify({ message: instructions.fr, language: 'fr' }))],
    ['cloned', () => structuredClone(createLocalValidationError(instructions.fr, 'fr'))],
  ] as const)('does not trust a %s as local field guidance', (_name, factory) => {
    const error = factory();
    expect(localValidationDetails(error)).toBeUndefined();
    expect(getUserError(error).message).not.toBe(instructions.fr);
  });

  it('looks up provenance without reading getters or traversing a hostile proxy', () => {
    let accesses = 0;
    const proxy = new Proxy({}, { get() { accesses++; throw Error('Must not read.'); }, getPrototypeOf() { accesses++; throw Error('Must not inspect.'); } });
    expect(localValidationDetails(proxy)).toBeUndefined();
    expect(accesses).toBe(0);
    expect(localValidationDetails(null)).toBeUndefined();
    expect(localValidationDetails(undefined)).toBeUndefined();
  });

  it('does not transfer private provenance to a proxy around a trusted error', () => {
    const error = createLocalValidationError(instructions.fr, 'fr');
    expect(localValidationDetails(new Proxy(error, {}))).toBeUndefined();
    expect(localValidationDetails(error)).toEqual({ message: instructions.fr, language: 'fr' });
  });

  it('preserves native session, permission and unknown failure guidance', () => {
    for (const [reason, kind] of [[{ status: 401 }, 'session'], [{ status: 403 }, 'permission'], [new Error('Unexpected native failure.'), 'unknown']] as const) {
      expect(classifyUserError(reason)).toBe(kind);
      expect(localValidationDetails(reason)).toBeUndefined();
    }
    expect(getUserError(new Error('Unexpected native failure.')).action).toContain(userErrorCopy('fr').uncertain);
  });

  it('records a stable fixed validation category without retaining authored content in the journal', () => {
    const before = recentDiagnosticEvents().length;
    const error = createLocalValidationError('Instruction locale unique : email@example.test password=PRIVATE_REFERENCE.', 'fr');
    const first = resolveErrorIncident(error).code;
    expect(resolveErrorIncident(error).code).toBe(first);
    const events = recentDiagnosticEvents().slice(before);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ area: 'error', operation: 'client.present_error', phase: 'failure', errorCode: 'VALIDATION' });
    expect(first).toBe(`ZT-${events[0].id}`);
    expect(JSON.stringify(events)).not.toMatch(/email@example|PRIVATE_REFERENCE|password|Instruction locale/);
    expect(Object.keys(events[0]).sort()).toEqual(['area', 'errorCode', 'id', 'operation', 'phase', 'sessionId', 'timestamp']);
  });

  it('renders a short correction, logs once across renders, and keeps technical disclosure for a native failure', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    const before = recentDiagnosticEvents().length;
    const error = createLocalValidationError(instructions.fr, 'fr');
    try {
      await act(async () => root.render(createElement(ErrorGuidance, { error })));
      expect(host.querySelector('[role="alert"]')?.textContent).toContain(instructions.fr);
      expect(host.querySelector('.error-guidance__details')).toBeNull();
      expect(host.querySelector('.error-guidance__incident')).toBeNull();
      await act(async () => root.render(createElement(ErrorGuidance, { error, compact: true })));
      expect(recentDiagnosticEvents().slice(before)).toHaveLength(1);
      await act(async () => root.render(createElement(ErrorGuidance, { error: new Error('Unexpected native failure.') })));
      expect(host.querySelector('.error-guidance__details')).not.toBeNull();
      expect(host.querySelector('.error-guidance__incident')).not.toBeNull();
      expect(host.querySelector('[role="alert"]')?.textContent).toContain('n’a pas pu être confirmé');
    } finally { await act(async () => root.unmount()); host.remove(); }
  });
});
