import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppLanguage } from './language';
const locale = vi.hoisted(() => ({ language: 'fr' as AppLanguage }));
// SSR's language snapshot intentionally defaults to French. Inject only the
// selected locale to exercise the real ErrorGuidance and its translated copy.
vi.mock('./language', async importOriginal => ({ ...await importOriginal<typeof import('./language')>(), useAppLanguage: () => locale.language }));
vi.mock('./diagnostics', () => ({ resolveErrorIncident: () => ({ code: 'ZEN-TEST-0001' }) }));
import { ErrorGuidance } from './ErrorGuidance';
import { appLanguages } from './language';
import { userErrorCopy } from './userErrors';

afterEach(() => { locale.language = 'fr'; });

describe('guide commun des erreurs', () => {
  it('affiche une correction puis des détails fermés et un code copiable', () => {
    const html = renderToStaticMarkup(<ErrorGuidance error={new Error('Failed to fetch; token=private; alice@example.ch')} operation="read" onReload={vi.fn()} />);
    expect(html).toContain('Connexion indisponible');
    expect(html).toContain('Vérifiez votre connexion Internet.');
    expect(html).toContain('Actualiser l’affichage');
    expect(html).toContain('<details');
    expect(html).not.toContain('<details open');
    expect(html).toContain('ZEN-TEST-0001');
    expect(html).toContain('Copier le code');
    expect(html).not.toContain('private');
    expect(html).not.toContain('alice@example.ch');
    expect(html).toContain('role="alert"');
    expect(html).toContain('type="button"');
  });

  it('ne propose aucune relance de mutation, même si un callback existe', () => {
    const html = renderToStaticMarkup(<ErrorGuidance error="Failed to fetch" operation="mutation" onReload={vi.fn()} />);
    expect(html).not.toContain('Actualiser l’affichage');
    expect(html).not.toContain('Réessayer');
    expect(html).toContain('vérifiez si l’action apparaît déjà');
  });

  it.each(appLanguages)('rend le guide de lecture et préserve la vérification avant mutation en %s', language => {
    locale.language = language;
    const labels = userErrorCopy(language);
    const reload = vi.fn();
    const read = renderToStaticMarkup(<ErrorGuidance error="unexpected internal state" operation="read" onReload={reload} />);
    const mutation = renderToStaticMarkup(<ErrorGuidance error="unexpected internal state" operation="mutation" onReload={reload} />);
    // Decode HTML punctuation while asserting the copy visible to the user.
    const text = (html: string) => html.replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/<[^>]+>/g, ' ');
    for (const expected of Object.values(labels.unknownRead)) expect(text(read)).toContain(expected);
    expect(text(read)).toContain(labels.reload);
    expect(text(read)).not.toContain(labels.uncertain);
    expect(text(read)).not.toContain(labels.unknown.action);
    expect(text(mutation)).toContain(`${labels.unknown.action} ${labels.uncertain}`);
    expect(text(mutation)).not.toContain(labels.reload);
    expect(text(mutation)).not.toContain(labels.unknownRead.action);
    expect(reload).not.toHaveBeenCalled();
  });

  it('réserve les actions à leur catégorie', () => {
    const session = renderToStaticMarkup(<ErrorGuidance error="JWT expired" onReconnect={vi.fn()} onReview={vi.fn()} onReload={vi.fn()} operation="read" />);
    expect(session).toContain('Ouvrir la connexion');
    expect(session).not.toContain('Actualiser l’affichage');
    expect(session).not.toContain('Vérifier les informations');
    const validation = renderToStaticMarkup(<ErrorGuidance error="invalid input" onReview={vi.fn()} onReconnect={vi.fn()} />);
    expect(validation).toContain('Vérifier les informations');
    expect(validation).not.toContain('Ouvrir la connexion');
  });
});
