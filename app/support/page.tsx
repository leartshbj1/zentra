import { redirect } from 'next/navigation';
import { StructuredData } from '@/components/structured-data';
import { productData, breadcrumbData } from '@/lib/seo';
import { SiteHeader } from '@/components/site-header';
import { SiteFooter } from '@/components/site-footer';
import { ProductHero, ProductDetails } from '@/components/quiet-product';
import { supportMetadata } from '@/lib/support/marketing';

export const metadata = supportMetadata(
  'Messages et tickets, simplement',
  'Organisez les demandes de votre équipe avec Zentra Support, dès 29 CHF/mois. Tri et routage automatique avec Automation et Gestion reliés.',
  '/support',
);

export default async function SupportPresentation({ searchParams }: {
  searchParams: Promise<{ workspace?: string }>;
}) {
  const params = await searchParams;
  if (params.workspace) redirect(`/support/espace?workspace=${encodeURIComponent(params.workspace)}`);
  return (
    <div className="quiet-site quiet-support">
      <a href="#support-content" className="site-skip-link">Aller au contenu</a>
      <StructuredData data={productData('support')} />
      <StructuredData data={breadcrumbData('/support', 'Zentra Support')} />
      <SiteHeader />
      <main id="support-content" tabIndex={-1}>
        <ProductHero title={<>Chaque demande.<br /><span>À sa place.</span></>}
          description="Vos messages et tickets rassemblés dans un espace clair, pour toute votre équipe."
          href="/support/connexions" action="Voir les connexions" price="Voir les formules" priceHref="/support/tarifs" />
        <ProductDetails title="Un support facile à suivre." id="fonctionnement">
          <details><summary>Rassembler les demandes</summary>
            <p>Connectez une messagerie ou un outil compatible. Retrouvez les demandes, les dossiers et l’historique dans Support.</p>
            <a className="quiet-link" href="/support/connexions">Les connexions disponibles</a>
          </details>
          <details><summary>Travailler en équipe</summary>
            <p>Organisez les messages, affectez les demandes et préparez vos réponses dans un espace partagé. Support peut s’utiliser seul, sans Gestion.</p>
            <a className="quiet-link" href="/support/fonctionnalites">Toutes les fonctionnalités</a>
          </details>
          <details><summary>Automatiser le tri et le routage</summary>
            <p>Avec Automation, la catégorie, la priorité et la destination suivent vos règles. Les décisions suffisamment sûres peuvent être appliquées dans un outil compatible ; les demandes ambiguës restent à vérifier.</p>
            <p>Ce parcours nécessite Automation (+15 CHF/mois), une entreprise Gestion active et Support relié à cette même entreprise. Les trois sont inclus dans Complet.</p>
            <a className="quiet-link" href="/automation">Découvrir Automation</a>
          </details>
          <details><summary>Comprendre les données et la sécurité</summary>
            <p>Retrouvez le traitement des messages, les permissions et les conditions du service avant de connecter vos outils.</p>
            <a className="quiet-link" href="/support/securite">Sécurité de Support</a>
          </details>
        </ProductDetails>
        <section className="quiet-offer quiet-width" id="tarifs">
          <div><h2>Dès 29 CHF / mois.</h2><p>Choisissez votre formule selon votre activité.</p></div>
          <div className="quiet-actions"><a className="quiet-primary" href="/support/tarifs">Voir les formules</a><a className="quiet-link" href="/support/demo">Voir un exemple</a></div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
