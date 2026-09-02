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
    'Zentra 1.19 est disponible sur Windows. Un aperçu macOS universel Intel et Apple Silicon est compilé en privé pour les tests, avant la future distribution signée et notariée.',
  applicationName: 'Zentra',
  ...(metadataBase ? { alternates: { canonical: '/' } } : {}),
  icons: { icon: '/favicon.svg' },
  openGraph: {
    type: 'website',
    locale: 'fr_CH',
    title: 'Zentra — Toute votre entreprise, dans une seule application',
    description:
      'Zentra 1.19 : application suisse multisectorielle disponible sur Windows, avec données opérationnelles locales et aperçu macOS universel réservé aux tests privés.',
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
      'Gestion locale complète sur Windows. Aperçu macOS universel privé en attendant la signature Developer ID et la notarisation Apple.',
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
