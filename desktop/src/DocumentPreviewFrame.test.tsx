import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
vi.mock('react-dom', async importOriginal => ({
  ...await importOriginal<typeof import('react-dom')>(),
  createPortal: (children: ReactNode) => children,
}));
import { DocumentPreviewFrame } from './DocumentPreviewFrame';
import { setAppLanguage, type AppLanguage } from './language';
import { translations } from './translations';

beforeEach(() => {
  vi.stubGlobal('document', { body: {}, documentElement: { lang: '' } });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const index = url.includes('de.') ? 0 : url.includes('it.') ? 1 : 2;
    return new Response(JSON.stringify(Object.fromEntries(Object.entries(translations).map(([key, values]) => [key, values[index]]))));
  }));
});
afterEach(() => vi.unstubAllGlobals());

it.each([
  ['fr', 'Lecture', 'Mise en page', 'Fermer l’aperçu'],
  ['de', 'Lesen', 'Layout', 'Vorschau schliessen'],
  ['it', 'Lettura', 'Impaginazione', 'Chiudi l’anteprima'],
  ['en', 'Reading', 'Layout', 'Close preview'],
] as const)('translates interface controls in %s without translating caller-owned document or actions', async (language, reading, layout, close) => {
  await setAppLanguage(language);
  const html = renderToStaticMarkup(<DocumentPreviewFrame title="Factures" number="Réessayer" customer="Annuler" total="Enregistrer" finalDocument onClose={vi.fn()} actions={<button>Exporter</button>}><article>Conditions</article></DocumentPreviewFrame>);
  // These values deliberately match catalogue keys: they remain document data.
  expect(html).toContain('Factures <span>Réessayer</span>');
  expect(html).toContain('<p>Annuler</p>');
  expect(html).toContain('<strong>Enregistrer</strong>');
  expect(html).toContain('<article>Conditions</article>');
  expect(html).toContain('<button>Exporter</button>');
  expect(html).toContain(`aria-label="${close}"`);
  expect(html).toContain(`</svg> ${reading}</button>`);
  expect(html).toContain(`</svg> ${layout}</button>`);
});

it.each(['fr', 'de', 'it', 'en'] as const)('localizes empty interface fallbacks and interpolates the total without altering it in %s', async (language: AppLanguage) => {
  await setAppLanguage(language);
  const value = (source: string) => language === 'fr' ? source : translations[source][['de', 'it', 'en'].indexOf(language)];
  const html = renderToStaticMarkup(<DocumentPreviewFrame title="Unchanged title" number="" customer="" total="CHF 2’400.00" finalDocument={false} onClose={vi.fn()} actions={null}><article>Original</article></DocumentPreviewFrame>);
  expect(html).toContain(value('Sans numéro'));
  expect(html).toContain(value('Destinataire à compléter'));
  expect(html).toContain(value('Brouillon'));
  expect(html).toContain(value('Aller au total du document : {total}').replace('{total}', 'CHF 2’400.00'));
  expect(html).toContain('<strong>CHF 2’400.00</strong>');
});
