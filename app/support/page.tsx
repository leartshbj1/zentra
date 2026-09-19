import type { Metadata } from 'next';
import { SupportWorkspace } from '@/components/support/application';
import './support.css';

export const metadata: Metadata = {
  title: 'Zentra Support — tri et routage des tickets',
  description:
    'Classez les demandes, choisissez leur priorité et affectez-les à la bonne équipe avec Jev.',
  robots: { index: false, follow: false },
};
export default function SupportPage() {
  return <SupportWorkspace />;
}
