import type { Metadata } from 'next';
import { UsLanding } from '@/components/us/landing';
import { usMarket } from '@/lib/markets/us';
import { absoluteSiteUrl } from '@/lib/site-url';
import './us.css';

export const metadata: Metadata = {
  title: { absolute: usMarket.title },
  description: usMarket.description,
  alternates: { canonical: absoluteSiteUrl('/us') },
  openGraph: {
    type: 'website',
    locale: 'en_US',
    siteName: 'Zentra',
    url: absoluteSiteUrl('/us'),
    title: 'Zentra Is Coming to the US — Join the Pilot',
    description:
      'Customer management, projects, estimates, invoicing and planned AI workflows for US small businesses. Join the pilot: 1 month free when access starts. No commitment.',
    images: [
      {
        url: absoluteSiteUrl('/us/og.png'),
        width: 1200,
        height: 630,
        alt: 'Zentra is coming to the US. Join the pilot: 1 month free, no commitment.',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Zentra Is Coming to the US — Join the Pilot',
    description:
      'Customer management, projects, estimates, invoicing and planned AI workflows for US small businesses. Join the pilot: 1 month free when access starts. No commitment.',
    images: [absoluteSiteUrl('/us/og.png')],
  },
};
export default function UsPage() {
  return <UsLanding />;
}
