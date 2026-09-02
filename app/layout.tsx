import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { ScrollExperience } from '@/components/scroll-experience';
import { publicSiteUrl } from '@/lib/site-url';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

// PUBLIC_SITE_URL est l'origine canonique commune au site, à Stripe et aux
// liens de licence. NEXT_PUBLIC_SITE_URL reste lu pour les anciens déploiements.
const metadataBase = new URL(publicSiteUrl());
const socialImage = new URL('/og.png', metadataBase).toString();

export const metadata: Metadata = {
  metadataBase,
  title: {
    default: 'Zentra — ERP suisse pour PME',
    template: '%s | Zentra',
  },
  description:
    'Facturation suisse, comptabilité, achats, salaires, projets et banque réunis dans un logiciel de gestion local-first pour PME.',
  applicationName: 'Zentra',
  icons: { icon: '/favicon.svg' },
  openGraph: {
    type: 'website',
    locale: 'fr_CH',
    siteName: 'Zentra',
    title: 'Zentra — Toute votre PME. Un seul logiciel.',
    description:
      'Un ERP conçu pour les PME suisses : ventes, achats, comptabilité, salaires, projets et banque, avec une approche local-first.',
    images: [{ url: socialImage, width: 1200, height: 630, alt: 'Zentra' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Zentra — ERP suisse pour PME',
    description:
      'Facturation, comptabilité, salaires, achats et projets dans un logiciel local-first.',
    images: [socialImage],
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fr-CH" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <ScrollExperience />
        {children}
      </body>
    </html>
  );
}
