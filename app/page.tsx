import type { Metadata } from 'next';
import { ProductsHome } from '@/components/products-home';

export const metadata: Metadata = {
  title: { absolute: 'Zentra — Logiciels de gestion et support pour PME suisses' },
  description:
    'Découvrez comment Zentra Gestion, Support et Automation relient les messages, factures, rendez-vous et tâches de votre PME. Parcours interactifs, fonctions et tarifs.',
  alternates: { canonical: '/' },
  openGraph: {
    title: 'Zentra — Logiciels de gestion et support pour PME suisses',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'Zentra' }],
    url: '/',
    description:
      'Gestion, Support et Automation. Découvrez le produit adapté à votre quotidien.',
  },
};
export default ProductsHome;
