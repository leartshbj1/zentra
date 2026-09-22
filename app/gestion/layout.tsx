import { StructuredData } from '@/components/structured-data';
import { breadcrumbData, productData } from '@/lib/seo';
export default function Layout({ children }: { children: React.ReactNode }) {
  return <><StructuredData data={breadcrumbData('/gestion', 'Zentra Gestion')} /><StructuredData data={productData('gestion')} />{children}</>;
}
