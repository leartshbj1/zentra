import { ArrowRight } from 'lucide-react';
import { SiteHeader } from './site-header';
import { SiteFooter } from './site-footer';
import { ProductRange } from './product-range';
import '@/app/produits/products.css';

export function ProductsHome() {
  return (
    <div className="products-page">
      <a className="site-skip-link" href="#contenu">
        Aller au contenu
      </a>
      <SiteHeader />
      <main id="contenu" tabIndex={-1}>
        <section className="products-intro">
          <p>BIENVENUE CHEZ ZENTRA</p>
          <h1>
            Votre entreprise.
            <br />
            <span>Simplement.</span>
          </h1>
          <p>
            Votre gestion. Votre service client. Vos tâches répétitives.
            <br />
            Le bon outil pour chaque partie de votre quotidien.
          </p>
        </section>
        <ProductRange />
        <section
          className="products-guide"
          id="workflow"
          aria-labelledby="products-guide-title"
        >
          <div className="products-guide-heading">
            <p className="products-kicker">TROUVEZ VOTRE POINT DE DÉPART</p>
            <h2 id="products-guide-title">Qu’aimeriez-vous simplifier ?</h2>
          </div>
          <div className="products-guide-links">
            <a href="/gestion">
              <span>
                <strong>Devis, factures et gestion d’entreprise</strong>
                <small>Découvrez Zentra Gestion</small>
              </span>
              <ArrowRight aria-hidden="true" size={20} />
            </a>
            <a href="/support">
              <span>
                <strong>Le tri des demandes de vos clients</strong>
                <small>Découvrez Zentra Support</small>
              </span>
              <ArrowRight aria-hidden="true" size={20} />
            </a>
            <a href="/automation">
              <span>
                <strong>Le classement dans Zentra Gestion</strong>
                <small>Ajoutez l’option Zentra Automation</small>
              </span>
              <ArrowRight aria-hidden="true" size={20} />
            </a>
          </div>
        </section>
        <section
          className="products-relationship"
          aria-labelledby="products-relationship-title"
        >
          <div>
            <p className="products-kicker">CHACUN À SA PLACE</p>
            <h2 id="products-relationship-title">
              Choisissez ce qui vous est utile.
            </h2>
          </div>
          <div className="products-relationship-copy">
            <p>
              <strong>Gestion et Support sont indépendants.</strong> Vous pouvez
              utiliser l’un, l’autre ou les deux, avec leurs abonnements
              distincts.
            </p>
            <p>
              <strong>Automation complète Gestion.</strong> Vous l’activez
              uniquement si vous souhaitez recevoir des suggestions pour vos
              opérations et vos documents.
            </p>
            <a href="mailto:info@zentraapp.ch">
              Besoin d’un conseil ? Écrivez-nous{' '}
              <ArrowRight size={16} aria-hidden="true" />
            </a>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
