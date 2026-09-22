import { StructuredData } from '@/components/structured-data';
import { breadcrumbData } from '@/lib/seo';
export default function Layout({ children }: { children: React.ReactNode }) {
  return <><StructuredData data={breadcrumbData('/pricing', 'Tarifs Gestion')} />{children}</>;
}
