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

export const metadata: Metadata = {
  title: 'HelviChantier — Gestion de chantier en Suisse',
  description: 'La véritable application Windows locale pour vos devis, factures, heures, dépenses et chantiers.',
  applicationName: 'HelviChantier',
  icons: { icon: '/favicon.svg' },
  openGraph: {
    type: 'website',
    locale: 'fr_CH',
    title: 'HelviChantier — Chaque chantier. Chaque franc. Enfin clair.',
    description: 'Le logiciel Windows suisse pour gérer devis, factures, heures, dépenses et rentabilité, avec les données sur votre PC.',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'HelviChantier' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'HelviChantier',
    description: 'Chaque chantier. Chaque franc. Enfin clair.',
    images: ['/og.png'],
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
