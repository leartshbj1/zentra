import type { Metadata } from 'next';
import { ProductsHome } from '@/components/products-home';

export const metadata: Metadata = {
  title: { absolute: 'Les produits Zentra — Gestion, Support et Automation' },
  description:
    'Comparez Zentra Gestion, Zentra Support et l’option Automation. Les usages, les tarifs et les premiers pas au même endroit.',
  alternates: { canonical: '/' },
};
export default ProductsHome;
