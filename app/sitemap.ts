import type { MetadataRoute } from 'next';
import { absoluteSiteUrl } from '@/lib/site-url';

export default function sitemap(): MetadataRoute.Sitemap {
  const pages = [
    ['/', 1, 'weekly'],
    ['/features', 0.9, 'weekly'],
    ['/pricing', 0.85, 'monthly'],
    ['/security', 0.8, 'monthly'],
    ['/download', 0.9, 'weekly'],
    ['/demo-facture', 0.75, 'monthly'],
    ['/confidentialite', 0.5, 'monthly'],
  ] as const;

  return pages.map(([path, priority, changeFrequency]) => ({
    url: absoluteSiteUrl(path),
    changeFrequency,
    priority,
  }));
}
