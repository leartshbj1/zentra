import type { Metadata } from 'next';
import { absoluteSiteUrl } from '@/lib/site-url';

export const supportNavigation = [
  ['/support/fonctionnalites', 'Fonctionnalités'],
  ['/support/solutions', 'Cas d’usage'],
  ['/support/connexions', 'Connexions'],
  ['/support/tarifs', 'Tarifs'],
  ['/support/securite', 'Sécurité'],
] as const;

export function supportMetadata(
  title: string,
  description: string,
  path: string,
): Metadata {
  const fullTitle = `${title} — Zentra Support`;
  return {
    title: { absolute: fullTitle },
    description,
    alternates: { canonical: path },
    openGraph: {
      title: fullTitle,
      description,
      url: path,
      siteName: 'Zentra',
      type: 'website',
      locale: 'fr_CH',
      images: [{ url: absoluteSiteUrl('/og.png'), width: 1200, height: 630, alt: 'Zentra Support' }],
    },
    twitter: { card: 'summary_large_image', title: fullTitle, description, images: [absoluteSiteUrl('/og.png')] },
  };
}
