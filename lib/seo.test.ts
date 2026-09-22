import { afterEach, describe, expect, it, vi } from 'vitest';
import { faqData, homeQuestions, productData, serializeStructuredData } from './seo';
import { isPrivateSearchPath } from './seo-indexing';
import sitemap from '../app/sitemap';
import robots from '../app/robots';

afterEach(() => vi.unstubAllEnvs());

describe('public search contract', () => {
  it('uses only canonical, public, unique URLs in the sitemap', () => {
    vi.stubEnv('PUBLIC_SITE_URL', 'https://zentraapp.ch');
    const urls = sitemap().map(({ url }) => url);
    expect(new Set(urls).size).toBe(urls.length);
    for (const url of urls) {
      expect(new URL(url).origin).toBe('https://zentraapp.ch');
      expect(isPrivateSearchPath(new URL(url).pathname)).toBe(false);
    }
    expect(urls).not.toContain('https://zentraapp.ch/produits');
    expect(urls).not.toContain('https://zentraapp.ch/telecharger');
  });
  it.each(['/compte', '/compte/archives', '/connexion', '/mot-de-passe/nouveau', '/support/espace', '/support/admin', '/support/demo', '/api/auth/session', '/appareil', '/invitation', '/paiement/succes'])('excludes the private route %s', path => {
    expect(isPrivateSearchPath(path)).toBe(true);
  });
  it.each(['/', '/support', '/support/tarifs', '/automation', '/gestion', '/features', '/compteur'])('keeps the public route %s discoverable', path => {
    expect(isPrivateSearchPath(path)).toBe(false);
  });
  it('does not prevent crawlers from reading noindex on account pages', () => {
    expect(robots().rules).toEqual({ userAgent: '*', allow: '/', disallow: ['/api/'] });
  });
  it('uses exactly the visible answers in structured FAQ data', () => {
    expect(faqData().mainEntity.map(q => q.acceptedAnswer.text)).toEqual(homeQuestions.map(q => q.answer));
    expect(productData('gestion')).not.toHaveProperty('aggregateRating');
  });
  it('cannot terminate a JSON-LD script with HTML from content', () => {
    const content = { name: '</script><img src=x onerror=alert(1)>' };
    const json = serializeStructuredData(content);
    expect(json).not.toContain('<');
    expect(JSON.parse(json)).toEqual(content);
  });
});
