import type { Metadata } from 'next';
import { SupportWorkspace } from '@/components/support/application';
import '../support.css';

export const metadata: Metadata = {
  title: 'Mon espace — Zentra Support',
  robots: { index: false, follow: false },
};
export default function SupportPage() {
  return <SupportWorkspace />;
}
