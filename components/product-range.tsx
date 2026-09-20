import {
  ArrowRight,
  FileText,
  MessagesSquare,
  Workflow,
  Check,
} from 'lucide-react';
import '@/app/produits/products.css';

const range = [
  {
    name: 'Gestion',
    kind: 'LE LOGICIEL POUR VOTRE PME',
    icon: FileText,
    className: 'management',
    title: 'Tout votre quotidien.\nAu même endroit.',
    description:
      'Devis, factures, comptabilité, projets et salaires pour les PME suisses.',
    price: 'Dès 49 CHF',
    period: '/ mois',
    detail: 'Application pour ordinateur et mobile',
    features: [
      'Devis et QR-factures reliés',
      'Projets, comptabilité et salaires',
      'Travail local et collaboration',
    ],
    example: [
      ['Devis', 'Accepté'],
      ['Facture', 'Émise'],
      ['Paiement', 'Encaissé'],
    ],
    href: '/gestion',
    secondary: '/pricing',
    secondaryLabel: 'Comparer les formules',
    cta: 'Découvrir Gestion',
  },
  {
    name: 'Support',
    kind: 'LE SERVICE POUR VOTRE ÉQUIPE',
    icon: MessagesSquare,
    className: 'support',
    title: 'Le bon ticket.\nLa bonne équipe.',
    description:
      'Classez et orientez les demandes de vos clients depuis votre logiciel de support.',
    price: 'Dès 29 CHF',
    period: '/ mois',
    detail: 'Service en ligne · abonnement indépendant',
    features: [
      'Catégorie et priorité proposées',
      'Routage selon vos règles',
      'Cas incertains confiés à votre équipe',
    ],
    example: [
      ['Demande reçue', 'Double prélèvement'],
      ['Catégorie', 'Facturation'],
      ['Destination', 'Équipe facturation'],
    ],
    href: '/support',
    secondary: '/support/tarifs',
    secondaryLabel: 'Comparer les formules',
    cta: 'Découvrir Support',
  },
  {
    name: 'Automation',
    kind: 'L’OPTION DE ZENTRA GESTION',
    icon: Workflow,
    className: 'automation',
    title: 'Moins de tri.\nPlus de temps.',
    description:
      'Des suggestions pour classer vos opérations, traiter vos documents et préparer vos achats.',
    price: '15 CHF',
    period: '/ mois',
    detail: 'Par entreprise · abonnement Gestion requis',
    features: [
      'Classement des opérations bancaires',
      'Orientation de vos documents',
      'Vous validez les actions importantes',
    ],
    example: [
      ['Opération', 'Achat de fournitures'],
      ['Suggestion', 'Matériel'],
      ['Votre choix', 'À confirmer'],
    ],
    href: '/automation',
    secondary: '/automation#utilisation',
    secondaryLabel: 'Comment l’activer',
    cta: 'Découvrir Automation',
  },
] as const;

export function ProductRange({ compact = false }: { compact?: boolean }) {
  return (
    <section
      className={
        'products-showcase' + (compact ? ' products-showcase-compact' : '')
      }
      aria-label="Découvrez les produits Zentra"
    >
      {compact && (
        <div className="products-section-heading">
          <p>LA GAMME ZENTRA</p>
          <h2>À chaque besoin, sa solution.</h2>
          <a href="/produits">
            Voir toute la gamme <ArrowRight size={16} aria-hidden="true" />
          </a>
        </div>
      )}
      <div className="products-grid">
        {range.map((product) => (
          <article
            className={'product-card product-' + product.className}
            key={product.name}
          >
            <div className="product-label">
              <product.icon size={22} aria-hidden="true" />
              <span>{product.kind}</span>
            </div>
            <p className="product-name">Zentra {product.name}</p>
            <h2>
              {product.title.split('\n').map((line, index) => (
                <span key={line}>
                  {index > 0 && <br />}
                  {line}
                </span>
              ))}
            </h2>
            <p className="product-description">{product.description}</p>
            <p className="product-price">
              <strong>{product.price}</strong>
              <span>{product.period}</span>
            </p>
            <p className="product-detail">{product.detail}</p>
            <div className="product-card-actions">
              <a className="product-discover" href={product.href}>
                {product.cta} <ArrowRight size={16} aria-hidden="true" />
              </a>
              <a className="product-secondary" href={product.secondary}>
                {product.secondaryLabel}
              </a>
            </div>
            <div className="product-visual">
              <span className="product-example-label">EXEMPLE DE PARCOURS</span>
              {product.example.map(([label, value]) => (
                <div key={label}>
                  <span>{label}</span>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
            <ul>
              {product.features.map((feature) => (
                <li key={feature}>
                  <Check size={16} aria-hidden="true" />
                  {feature}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </section>
  );
}
