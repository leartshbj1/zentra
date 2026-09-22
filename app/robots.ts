import type { MetadataRoute } from 'next';
import { absoluteSiteUrl } from '@/lib/site-url';

export default function robots(): MetadataRoute.Robots {
  return {
    // Crawlers must be able to read noindex headers on account pages.
    // The wildcard includes search crawlers such as OAI-SearchBot.
    rules: { userAgent: '*', allow: '/', disallow: ['/api/'] },
    sitemap: absoluteSiteUrl('/sitemap.xml'),
  };
}
