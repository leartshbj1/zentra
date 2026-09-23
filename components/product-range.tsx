import { ArrowRight } from 'lucide-react';
import './zentra-presentation.css';

const products = [
  {
    name: 'Gestion',
    description: 'Votre activité, du premier devis au bilan.',
    price: 'Dès 49 CHF',
    note: '1, 3 ou 10 personnes, selon la formule.',
    href: '/gestion',
    demo: '/demo-facture',
    tariff: '/pricing',
    features: [
      ['Devis & factures', '/features#ventes'],
      ['Projets & documents', '/features#projets'],
      ['Achats & comptabilité', '/features#achats'],
      ['Équipe & salaires', '/features#salaires'],
    ],
  },
  {
    name: 'Support',
    description: 'Vos demandes clients, dans un espace dédié.',
    price: 'Dès 29 CHF',
    note: 'Abonnement distinct de Gestion.',
    href: '/support',
    demo: '/support/demo',
    tariff: '/support/tarifs',
    features: [
      ['Boîte de réception & tickets', '/support/fonctionnalites'],
      ['Connexions disponibles', '/support/connexions'],
      ['Équipes & affectations', '/support/fonctionnalites'],
      ['Tri et routage avec Automation', '/automation#fonctions'],
    ],
  },
  {
    name: 'Automation',
    description: 'Les tâches se suivent. Vous gardez le contrôle.',
    price: '15 CHF',
    note: 'Option par entreprise, avec Gestion.',
    href: '/automation',
    demo: '/automation#parcours',
    tariff: '/automation#tarif',
    features: [
      ['Factures & fournisseurs', '/automation#fonctions'],
      ['Rendez-vous & agenda', '/automation#fonctions'],
      ['Tâches & réponses préparées', '/automation#fonctions'],
      ['Activité & décisions à vérifier', '/automation#quotidien'],
    ],
  },
] as const;
export function ProductRange({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`zentra-range${compact ? ' zentra-range--compact' : ''}`}>
      {compact && (
        <div className="zentra-section-heading">
          <h2>Les produits Zentra.</h2>
          <a className="zentra-text-link" href="/#produits">
            Voir la gamme
            <ArrowRight size={16} aria-hidden="true" />
          </a>
        </div>
      )}
      <div className="zentra-range-grid">
        {products.map((p) => (
          <article
            className={`zentra-product zentra-product--${p.name.toLowerCase()}`}
            key={p.name}
          >
            <h3>
              <span>Zentra</span> {p.name}
            </h3>
            <p className="zentra-product-description">{p.description}</p>
            <p className="zentra-product-price">
              {p.price}
              <small>/ mois</small>
            </p>
            <p className="zentra-product-note">{p.note}</p>
            <a className="zentra-product-discover" href={p.href}>
              Découvrir {p.name}
              <ArrowRight size={17} aria-hidden="true" />
            </a>
            <ul>
              {p.features.map(([label, href]) => (
                <li key={label}>
                  <a href={href}>
                    {label}
                    <ArrowRight size={14} aria-hidden="true" />
                  </a>
                </li>
              ))}
            </ul>
            <div className="zentra-product-links">
              <a href={p.demo}>
                {p.name === 'Automation'
                  ? 'Voir le parcours'
                  : 'Essayer la démo'}
              </a>
              <a href={p.tariff}>Voir les tarifs</a>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
