import type { Metadata } from 'next';
import DownloadPage from '@/app/telecharger/page';
import { ZENTRA_VERSION } from '@/lib/downloads';

export const metadata: Metadata = {
  title: `Télécharger Zentra ${ZENTRA_VERSION}`,
  description: `Téléchargez Zentra ${ZENTRA_VERSION} pour Windows x64 et consultez le statut réel de l’aperçu macOS universel.`,
  alternates: { canonical: '/download' },
  openGraph: {
    title: `Télécharger Zentra ${ZENTRA_VERSION}`,
    description:
      'Application Windows disponible et aperçu macOS privé en attente de signature Developer ID et de notarisation.',
    url: '/download',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'Zentra' }],
  },
};

export default DownloadPage;
