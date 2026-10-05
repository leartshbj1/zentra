export const SITE_LANGUAGES = ['fr', 'de', 'it', 'en'] as const;
export type SiteLanguage = (typeof SITE_LANGUAGES)[number];
export const SITE_LANGUAGE_COOKIE = 'zentra_locale';
export const SITE_LANGUAGE_HEADER = 'x-zentra-site-language';
export const SITE_PATH_HEADER = 'x-zentra-site-path';
export const SITE_LANGUAGE_TAGS: Record<SiteLanguage, string> = {
  fr: 'fr-CH', de: 'de-CH', it: 'it-CH', en: 'en-CH',
};
export const SITE_LANGUAGE_NAMES: Record<SiteLanguage, string> = {
  fr: 'Français', de: 'Deutsch', it: 'Italiano', en: 'English',
};

export function isSiteLanguage(value: unknown): value is SiteLanguage {
  return typeof value === 'string' && (SITE_LANGUAGES as readonly string[]).includes(value);
}

export function resolveSiteLanguage(request: Request): SiteLanguage {
  const explicit = new URL(request.url).searchParams.get('lang');
  if (isSiteLanguage(explicit)) return explicit;
  const cookie = request.headers.get('cookie')?.split(';').map(p => p.trim())
    .find(p => p.startsWith(SITE_LANGUAGE_COOKIE + '='))?.slice(SITE_LANGUAGE_COOKIE.length + 1);
  if (isSiteLanguage(cookie)) return cookie;
  const preferences = (request.headers.get('accept-language') || '').split(',')
    .map((part, index) => {
      const [tag, ...parameters] = part.trim().split(';');
      const q = parameters.find(p => p.trim().startsWith('q='));
      const weight = q ? Number(q.trim().slice(2)) : 1;
      return { language: tag.toLowerCase().split('-')[0], weight, index };
    })
    .filter(p => isSiteLanguage(p.language) && Number.isFinite(p.weight) && p.weight > 0 && p.weight <= 1)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  return (preferences[0]?.language as SiteLanguage) || 'fr';
}

export function localizedSiteUrl(input: string, language: SiteLanguage): string {
  const url = new URL(input, 'https://www.zentraapp.ch');
  url.searchParams.set('lang', language);
  return url.pathname + url.search + url.hash;
}
