import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { ScrollExperience } from '@/components/scroll-experience';
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
const configuredSiteUrl =
  process.env.PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_SITE_URL;
const metadataBase = configuredSiteUrl ? new URL(configuredSiteUrl) : undefined;
const socialImage = metadataBase
  ? new URL('/og.png', metadataBase).toString()
  : undefined;

export const metadata: Metadata = {
  ...(metadataBase ? { metadataBase } : {}),
  title: 'Zentra — Gestion d’entreprise multisectorielle en Suisse',
  description:
    'Application de bureau suisse disponible sur Windows, avec version macOS en préparation de distribution : gestion locale, compte d’entreprise et archivage optionnel des factures.',
  applicationName: 'Zentra',
  ...(metadataBase ? { alternates: { canonical: '/' } } : {}),
  icons: { icon: '/favicon.svg' },
  openGraph: {
    type: 'website',
    locale: 'fr_CH',
    title: 'Zentra — Toute votre entreprise, dans une seule application',
    description:
      'Application suisse multisectorielle : Windows disponible, macOS en préparation, données opérationnelles locales et archivage optionnel des factures.',
    ...(metadataBase ? { url: '/' } : {}),
    ...(socialImage
      ? {
          images: [
            { url: socialImage, width: 1200, height: 630, alt: 'Zentra' },
          ],
        }
      : {}),
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Zentra',
    description:
      'Gestion locale complète sur Windows, version macOS en préparation et compte d’entreprise avec archive de factures sur option.',
    ...(socialImage ? { images: [socialImage] } : {}),
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fr" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: "document.documentElement.classList.add('motion-ready')",
          }}
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <ScrollExperience />
        {children}
      </body>
    </html>
  );
}
