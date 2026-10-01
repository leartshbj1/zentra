import { SiteHeader } from './site-header';
import { SiteFooter } from './site-footer';
import { ProductHero } from './quiet-product';
import {
  PanelsTopLeft,
  Inbox,
  Workflow,
  Layers,
  ChevronRight,
} from 'lucide-react';

const products = [
  {
    name: 'Gestion',
    text: 'Votre activité, au même endroit.',
    href: '/gestion',
    icon: PanelsTopLeft,
    tone: 'gestion',
  },
  {
    name: 'Support',
    text: 'Chaque demande à sa place.',
    href: '/support',
    icon: Inbox,
    tone: 'support',
  },
  {
    name: 'Automation',
    text: 'Moins de tâches à refaire.',
    href: '/automation',
    icon: Workflow,
    tone: 'automation',
  },
  {
    name: 'Complet',
    text: 'Les trois produits. Ensemble.',
    href: '/complet',
    icon: Layers,
    tone: 'complet',
  },
] as const;

export function ProductsHome() {
  return (
    <div className="quiet-site quiet-home">
      <a className="site-skip-link" href="#contenu">
        Aller au contenu
      </a>
      <SiteHeader />
      <main id="contenu" tabIndex={-1}>
        <ProductHero
          title={
            <>
              Votre entreprise.
              <br />
              <span>L’esprit libre.</span>
            </>
          }
          description="Gérez. Répondez. Avancez."
          href="#produits"
          action="Découvrir les produits"
        >
          <a className="quiet-link quiet-hero-discover" href="/ecosysteme">
            Comment tout se relie
          </a>
        </ProductHero>
        <section
          className="quiet-width quiet-products"
          id="produits"
          aria-label="Choisir un produit Zentra"
        >
          <span id="choisir" className="quiet-anchor" />
          {products.map(({ icon: Icon, ...product }) => (
            <a
              className={`quiet-product-row apple-product apple-product-${product.tone}`}
              key={product.name}
              href={product.href}
            >
              <Icon
                className="apple-product-icon"
                strokeWidth={1.25}
                aria-hidden="true"
              />
              <div className="apple-product-copy">
                <h2>{product.name}</h2>
                <p>{product.text}</p>
              </div>
              <span className="apple-product-open" aria-hidden="true">
                <ChevronRight size={20} strokeWidth={1.7} />
              </span>
            </a>
          ))}
        </section>
        <div className="quiet-width quiet-home-more" id="questions">
          <a className="quiet-link" href="/questions">
            Les réponses à vos questions
          </a>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
