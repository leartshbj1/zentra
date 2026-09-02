import type { MetadataRoute } from 'next';
import { absoluteSiteUrl, publicSiteUrl } from '@/lib/site-url';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: [
        '/api/',
        '/appareil',
        '/compte',
        '/connexion',
        '/invitation',
        '/paiement/',
      ],
    },
    host: publicSiteUrl(),
    sitemap: absoluteSiteUrl('/sitemap.xml'),
  };
}
