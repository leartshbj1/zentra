import { SiteHeader } from '@/components/site-header';
import { SiteFooter } from '@/components/site-footer';
import { CompleteOffer } from '@/components/complete-offer';
import { ProductHero, ProductDetails } from '@/components/quiet-product';
import '@/components/zentra-presentation.css';
import './complet.css';

export const metadata = {
  title: { absolute: 'Zentra Complet — Gestion, Support et Automation réunis' },
  description: 'Gestion, Support et Automation réunis dès 79 CHF/mois. Un abonnement commun. Essai de 14 jours sans carte bancaire.',
  alternates: { canonical: '/complet' },
};

export default function CompletePage() {
  return (
    <div className="quiet-site quiet-complete">
      <a className="site-skip-link" href="#contenu">Aller au contenu</a>
      <SiteHeader />
      <main id="contenu" tabIndex={-1}>
        <ProductHero title={<>Zentra Complet.<br /><span>Tout, ensemble.</span></>}
          description="Gestion, Support et Automation. Les trois produits réunis pour votre entreprise."
          href="#formules" action="Choisir mon pack" />
        <div className="quiet-width"><CompleteOffer /></div>
        <section className="quiet-section quiet-width" id="inclus">
          <h2>Trois produits inclus. Dans chaque pack.</h2>
          <div className="quiet-module-links">
            <a href="/gestion"><h3>Gestion</h3><p>Devis, factures, projets et comptabilité dans votre entreprise partagée.</p></a>
            <a href="/support"><h3>Support</h3><p>Vos messages et demandes clients, avec les connexions compatibles.</p></a>
            <a href="/automation"><h3>Automation</h3><p>Le tri, les documents et les rendez-vous préparés selon vos règles.</p></a>
          </div>
        </section>
        <ProductDetails title="Quelques détails utiles." id="questions">
          <details><summary>Puis-je essayer sans carte bancaire ?</summary>
            <p>Oui, pendant 14 jours : une entreprise, 3 personnes titulaire compris et 250 analyses Support partagées. Aucun paiement automatique. Connectez vos outils et choisissez vos automatismes.</p>
            <a className="quiet-link" href="/compte">Commencer mon essai</a>
          </details>
          <details id="deja-client"><summary>J’utilise déjà Zentra. Comment passer au pack ?</summary>
            <p>Changez de formule depuis votre compte. Votre entreprise est conservée et le pack prend le relais après les périodes déjà payées, sans double renouvellement.</p>
            <a className="quiet-link" href="/compte/abonnement">Changer ma formule</a>
          </details>
          <details><summary>Que se passe-t-il à la limite d’analyses ?</summary>
            <p>Une analyse traite un message ou un ticket. Une nouvelle analyse peut consommer une unité supplémentaire. Le compteur est visible dans Support ; à la limite, les analyses reprennent au renouvellement, sans supplément facturé automatiquement.</p>
          </details>
          <details><summary>Qu’est-ce qui reste à configurer ?</summary>
            <p>Reliez vos outils à la même entreprise et activez vos règles. Les services tiers conservent leurs abonnements. Les cas incertains restent à vérifier ; aucun paiement bancaire ni réponse ne part automatiquement.</p>
          </details>
          <details><summary>Puis-je garder les produits séparés ?</summary>
            <p>Oui. Gestion, Support et l’option Automation restent disponibles séparément.</p>
            <a className="quiet-link" href="/#produits">Les produits Zentra</a>
          </details>
          <details><summary>Comment arrêter l’abonnement ?</summary>
            <p>Résiliez depuis votre compte. L’accès aux trois produits reste disponible jusqu’à la fin de la période payée.</p>
            <a className="quiet-link" href="/complet/conditions">Conditions du pack</a>
          </details>
        </ProductDetails>
      </main>
      <SiteFooter />
    </div>
  );
}
