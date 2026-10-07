import type { MetadataRoute } from 'next';
import { absoluteSiteUrl } from '@/lib/site-url';
import { SITE_LANGUAGES, SITE_LANGUAGE_TAGS, localizedSiteUrl } from '@/lib/site-language';

export default function sitemap(): MetadataRoute.Sitemap {
  const pages = [
    ['/', 1, 'weekly'],
    ['/commencer', 0.8, 'monthly'],
    ['/ecosysteme', 0.85, 'monthly'],
    ['/questions', 0.7, 'monthly'],
    ['/gestion', 0.95, 'weekly'],
    ['/gestion/notes', 0.75, 'monthly'],
    ['/comparatif/bexio', 0.8, 'monthly'],
    ['/complet', 0.95, 'monthly'],
    ['/complet/conditions', 0.5, 'monthly'],
    ['/features', 0.9, 'weekly'],
    ['/support', 0.9, 'weekly'],
    ['/automation', 0.85, 'monthly'],
    ['/automation/conditions', 0.5, 'monthly'],
    ['/parrainage/conditions', 0.5, 'monthly'],
    ['/support/fonctionnalites', 0.8, 'monthly'],
    ['/support/solutions', 0.8, 'monthly'],
    ['/support/connexions', 0.8, 'weekly'],
    ['/support/tarifs', 0.85, 'monthly'],
    ['/support/securite', 0.7, 'monthly'],
    ['/support/conditions', 0.5, 'monthly'],
    ['/pricing', 0.85, 'monthly'],
    ['/security', 0.8, 'monthly'],
    ['/download', 0.9, 'weekly'],
    ['/demo-facture', 0.75, 'monthly'],
    ['/confidentialite', 0.5, 'monthly'],
    ['/conditions', 0.5, 'monthly'],
    ['/mentions-legales', 0.5, 'monthly'],
    ['/sous-traitance', 0.5, 'monthly'],
    ['/cookies', 0.3, 'monthly'],
  ] as const;

  return [...pages.flatMap(([path, priority, changeFrequency]) => SITE_LANGUAGES.map(language=>({
    url: absoluteSiteUrl(localizedSiteUrl(path,language)),
    changeFrequency,
    priority,
    alternates: {languages:Object.fromEntries(SITE_LANGUAGES.map(lang=>[SITE_LANGUAGE_TAGS[lang],absoluteSiteUrl(localizedSiteUrl(path,lang))]))},
  }))),
  { url: absoluteSiteUrl('/us'), changeFrequency: 'monthly', priority: 0.8 },
  { url: absoluteSiteUrl('/us/privacy'), changeFrequency: 'yearly', priority: 0.1 },
  ];
}
