import { ArrowRight, FileText, MessagesSquare } from 'lucide-react';
import '@/app/produits/products.css';

export function ProductRange({ compact = false }: { compact?: boolean }) {
  return (
    <section
      className={`products-showcase ${compact ? 'products-showcase-compact' : ''}`}
      aria-label="Les produits Zentra"
    >
      {compact && (
        <div className="products-section-heading">
          <p>LES PRODUITS ZENTRA</p>
          <h2>Deux métiers. Deux produits.</h2>
          <a href="/produits">
            Découvrir notre gamme <ArrowRight size={16} />
          </a>
        </div>
      )}
      <div className="products-grid">
        <article className="product-card product-management">
          <span className="product-label">
            <FileText size={19} aria-hidden="true" /> GESTION D’ENTREPRISE
          </span>
          <h2>Zentra Gestion</h2>
          <p>
            Devis, factures, comptabilité, projets et salaires. Le quotidien de
            votre PME suisse dans un même logiciel.
          </p>
          <div className="product-visual" aria-hidden="true">
            <div>
              <span>Facture</span>
              <strong>Émise</strong>
            </div>
            <div>
              <span>Paiement</span>
              <strong>Encaissé</strong>
            </div>
            <div>
              <span>Comptabilité</span>
              <strong>Reliée</strong>
            </div>
          </div>
          <ul>
            <li>Application pour ordinateur et mobile</li>
            <li>Travail local et collaboration synchronisée</li>
            <li>Abonnement Gestion indépendant</li>
          </ul>
          <a href={compact ? '/features' : '/'}>
            Découvrir Zentra Gestion <ArrowRight size={18} />
          </a>
        </article>
        <article className="product-card product-support">
          <span className="product-label">
            <MessagesSquare size={19} aria-hidden="true" /> SERVICE CLIENT
          </span>
          <h2>Zentra Support</h2>
          <p>
            Tri, priorité et routage automatiques des tickets. Votre équipe se
            concentre sur les demandes qui ont besoin d’elle.
          </p>
          <div className="product-visual" aria-hidden="true">
            <div>
              <span>Nouveau ticket</span>
              <strong>Facturation</strong>
            </div>
            <div>
              <span>Priorité</span>
              <strong>Élevée</strong>
            </div>
            <div>
              <span>Destination</span>
              <strong>Comptabilité</strong>
            </div>
          </div>
          <ul>
            <li>Service en ligne dans votre navigateur</li>
            <li>Se connecte à votre outil de support</li>
            <li>Abonnement Support indépendant</li>
          </ul>
          <a href="/support">
            Découvrir Zentra Support <ArrowRight size={18} />
          </a>
        </article>
      </div>
    </section>
  );
}
