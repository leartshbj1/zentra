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

  it.each(appLanguages)('rend le changement d’espace natif avec uniquement une reprise de lecture en %s', language => {
    locale.language = language;
    const titles = { fr: 'Entreprise ouverte à vérifier', de: 'Geöffnetes Unternehmen prüfen', it: 'Verifica l’azienda aperta', en: 'Check the open company' };
    const verification = { fr: 'Vérifiez ce qui est déjà enregistré', de: 'Prüfen Sie vor einer Wiederholung', it: 'Prima di ripeterla, verifica', en: 'Check what was already saved' };
    const labels = userErrorCopy(language), reload = vi.fn(), review = vi.fn(), reconnect = vi.fn();
    for (const message of [
      'La connexion ou l’entreprise ouverte a changé. Rouvrez la réception.',
      'L’entreprise ouverte a changé. Rouvrez cette action dans le bon espace.',
    ]) {
      const error = `Champ invalide : ${message} token=private-workspace-secret alice@example.ch`;
      const read = renderToStaticMarkup(<ErrorGuidance error={error} operation="read" onReload={reload} onReview={review} onReconnect={reconnect} incidentCode="ZT-workspace-incident" />);
      const mutation = renderToStaticMarkup(<ErrorGuidance error={error} operation="mutation" onReload={reload} onReview={review} onReconnect={reconnect} incidentCode="ZT-workspace-incident" />);
      const text = (html: string) => html.replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/<[^>]+>/g, ' ');
      expect(text(read)).toContain(titles[language]);
      expect(text(read)).toContain(labels.reload);
      expect(text(read)).not.toContain(labels.validation.action);
      expect(text(read)).not.toContain(verification[language]);
      expect(text(mutation)).toContain(titles[language]);
      expect(text(mutation)).toContain(verification[language]);
      expect(mutation).not.toContain('error-guidance__actions');
      for (const html of [read, mutation]) {
        expect(text(html)).not.toContain(labels.review);
        expect(text(html)).not.toContain(labels.reconnect);
        expect(html).toContain('ZT-workspace-incident');
        expect(html).toContain('<details'); expect(html).not.toContain('<details open');
        expect(html).not.toMatch(/private-workspace-secret|alice@example.ch/);
      }
    }
    expect(reload).not.toHaveBeenCalled(); expect(review).not.toHaveBeenCalled(); expect(reconnect).not.toHaveBeenCalled();
  });

  it('ne crée pas de reprise sans callback autorisé et respecte son indisponibilité', () => {
    const error = 'Champ invalide : La connexion ou l’entreprise ouverte a changé. Rouvrez la réception.';
    const noRead = renderToStaticMarkup(<ErrorGuidance error={error} operation="read" onReview={vi.fn()} />);
    expect(noRead).not.toContain('error-guidance__actions');
    const disabled = renderToStaticMarkup(<ErrorGuidance error={error} operation="read" onReload={vi.fn()} disabled />);
    expect(disabled).toContain('disabled=""');
    expect(disabled).toContain('Actualiser l’affichage');
    const defaultMutation = renderToStaticMarkup(<ErrorGuidance error={error} onReload={vi.fn()} />);
    expect(defaultMutation).not.toContain('error-guidance__actions');
  });
});
