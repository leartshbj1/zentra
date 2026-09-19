import type { Metadata } from 'next';
import { SupportAdministration } from '@/components/support/administration';
import '../support.css';

export const metadata: Metadata = {
  title: 'Administration — Zentra Support',
  robots: { index: false, follow: false },
};
export default function AdminPage() {
  return <SupportAdministration />;
}
