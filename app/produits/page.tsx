import type { Metadata } from 'next';
import { BrandWordmark } from '@/components/brand-mark';
import { ProductRange } from '@/components/product-range';
import { SiteFooter } from '@/components/site-footer';
import './products.css';

export const metadata: Metadata = {
  title: { absolute: 'Zentra — Deux produits pour simplifier votre quotidien' },
  description:
    'Découvrez Zentra Gestion pour piloter votre PME suisse et Zentra Support pour classer et orienter vos tickets clients. Deux produits indépendants.',
  alternates: { canonical: '/produits' },
  openGraph: {
    title: 'Les produits Zentra',
    url: '/produits',
    description:
      'Gestion d’entreprise et service client : choisissez le produit adapté à votre besoin.',
  },
};

export default function ProductsPage() {
  return (
    <div className="products-page">
      <a className="site-skip-link" href="#contenu">
        Aller au contenu
      </a>
      <header className="products-header">
        <a href="/produits" aria-label="Zentra, nos produits">
          <BrandWordmark />
        </a>
        <nav aria-label="Choisir un produit">
          <a href="/">Zentra Gestion</a>
          <a href="/support">Zentra Support</a>
        </nav>
      </header>
      <main id="contenu" tabIndex={-1}>
        <section className="products-intro">
          <p>LES PRODUITS ZENTRA</p>
          <h1>
            Moins de tâches.
            <br />
            <span>Plus de place pour l’essentiel.</span>
          </h1>
          <p>
            Gérer votre entreprise. Organiser votre service client.
            <br />
            Deux produits indépendants, une même envie de vous simplifier la
            vie.
          </p>
        </section>
        <ProductRange />
        <section className="products-independence">
          <h2>Choisissez selon votre besoin.</h2>
          <p>
            Chaque produit possède ses fonctionnalités, son espace et son
            abonnement. Zentra Support s’utilise avec votre logiciel de service
            client, sans abonnement à Zentra Gestion.
          </p>
          <a href="mailto:info@zentraapp.ch">Un doute ? Écrivez-nous.</a>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
