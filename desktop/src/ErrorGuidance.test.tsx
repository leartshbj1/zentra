import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('./diagnostics', () => ({ resolveErrorIncident: () => ({ code: 'ZEN-TEST-0001' }) }));
import { ErrorGuidance } from './ErrorGuidance';

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
