import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

const configuredSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;
const metadataBase = configuredSiteUrl ? new URL(configuredSiteUrl) : undefined;
const socialImage = metadataBase ? new URL('/og.png', metadataBase).toString() : undefined;

export const metadata: Metadata = {
  ...(metadataBase ? { metadataBase } : {}),
  title: 'HelviChantier — Gestion d’entreprise multisectorielle en Suisse',
  description: 'L’application Windows locale pour piloter projets, chantiers, devis, factures, heures, salaires et comptabilité dans tous les secteurs NOGA 2025.',
  applicationName: 'HelviChantier',
  icons: { icon: '/favicon.svg' },
  openGraph: {
    type: 'website',
    locale: 'fr_CH',
    title: 'HelviChantier — Chaque activité. Chaque franc. Enfin clair.',
    description: 'Le logiciel Windows suisse multisectoriel pour gérer projets, chantiers, devis, factures, salaires et comptabilité avec les données sur votre PC.',
    ...(socialImage ? { images: [{ url: socialImage, width: 1200, height: 630, alt: 'HelviChantier' }] } : {}),
  },
  twitter: {
    card: 'summary_large_image',
    title: 'HelviChantier',
    description: 'Chaque activité. Chaque franc. Enfin clair.',
    ...(socialImage ? { images: [socialImage] } : {}),
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fr">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        {children}
      </body>
    </html>
  );
}
