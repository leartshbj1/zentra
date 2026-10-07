import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { StructuredData } from '@/components/structured-data';
import { identityData } from '@/lib/seo';
import { AuthSessionGuard } from '@/components/auth-session-guard';
import { Geist, Geist_Mono } from 'next/font/google';
import { ScrollExperience } from '@/components/scroll-experience';
import { publicSiteUrl } from '@/lib/site-url';
import { getSiteLanguage } from '@/lib/site-language-server';
import { SITE_LANGUAGE_TAGS, SITE_PATH_HEADER } from '@/lib/site-language';
import { serializeSiteDictionary } from '@/lib/site-copy';
import './globals.css';
import './refined.css';
import './product-navigation.css';
import './studio.css';
import './intuitive-site.css';
import './page-system.css';
import './brand-identity.css';
import './product-clarity.css';
import './quiet-site.css';
import './apple-design.css';
import './apple-pages.css';
import './apple-account.css';
import './support/apple-support.css';
import './site-language.css';
import './user-clarity.css';
import { SiteLanguagePicker } from '@/components/site-language-picker';

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
  verification: {
    google: process.env.GOOGLE_SITE_VERIFICATION || undefined,
    other: process.env.BING_SITE_VERIFICATION
      ? { 'msvalidate.01': process.env.BING_SITE_VERIFICATION }
      : undefined,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
      'max-video-preview': -1,
    },
  },
  icons: {
    icon: [{ url: '/favicon-20260926.png', type: 'image/png', sizes: '64x64' }],
    shortcut: '/favicon.ico?v=20260926',
    apple: [{ url: '/apple-touch-icon-20260926.png', sizes: '180x180' }],
  },
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

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const language = await getSiteLanguage();
  const path = (await headers()).get(SITE_PATH_HEADER) || '';
  const isUsMarketPage = path === '/us' || path.startsWith('/us/');
  return (
    <html lang={isUsMarketPage ? 'en-US' : SITE_LANGUAGE_TAGS[language]} suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <script type="application/json" id="zentra-site-copy" data-site-language={language} dangerouslySetInnerHTML={{ __html: serializeSiteDictionary(language) }} />
        <StructuredData data={identityData()} />
        <ScrollExperience />
        <AuthSessionGuard />
        {children}
        {!isUsMarketPage && <div className="site-language-fallback"><SiteLanguagePicker /></div>}
      </body>
    </html>
  );
}
