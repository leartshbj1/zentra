import { SupportWorkspace } from '@/components/support/application';
import '../support.css';
export const metadata = {
  title: { absolute: 'Démonstration — Zentra Support' },
  description: 'Explorez Zentra Support avec des tickets fictifs, sans compte.',
  alternates: { canonical: '/support/demo' },
};
export default function SupportDemoPage() {
  return <SupportWorkspace demo />;
}
