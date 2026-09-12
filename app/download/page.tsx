import type { Metadata } from 'next';
import DownloadPage from '@/app/telecharger/page';
import { ZENTRA_VERSION, ZENTRA_WINDOWS_PREVIEW_VERSION } from '@/lib/downloads';

export const metadata: Metadata = {
  title: `Télécharger Zentra — Windows ${ZENTRA_WINDOWS_PREVIEW_VERSION} et macOS ${ZENTRA_VERSION}`,
  description: `Découvrez Zentra Windows ${ZENTRA_WINDOWS_PREVIEW_VERSION} en accès anticipé et macOS ${ZENTRA_VERSION}, universel Intel et Apple Silicon.`,
  alternates: { canonical: '/download' },
  openGraph: {
    title: `Télécharger Zentra — Windows ${ZENTRA_WINDOWS_PREVIEW_VERSION} et macOS ${ZENTRA_VERSION}`,
    description:
      'Applications Windows et macOS disponibles. La version macOS est proposée en accès anticipé avant notarisation Apple.',
    url: '/download',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'Zentra' }],
  },
};

export default DownloadPage;
