import type { Metadata } from 'next';

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
      siteName: 'Zentra Support',
    },
    twitter: { title: fullTitle, description },
  };
}
