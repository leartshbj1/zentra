import { redirect } from 'next/navigation';
import { StructuredData } from '@/components/structured-data';
import { productData, breadcrumbData } from '@/lib/seo';
import { SupportMarketingShell } from '@/components/support/marketing-shell';
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
    <SupportMarketingShell>
      <StructuredData data={productData('support')} />
      <StructuredData data={breadcrumbData('/support', 'Zentra Support')} />
        <section className="sp-hero sp-wrap">
          <div className="sp-hero-copy">
            <h1>Chaque demande.<br /><em>À sa place.</em></h1>
            <p className="sp-lead">Vos messages et tickets rassemblés dans un espace clair, pour toute votre équipe.</p>
            <div className="sp-actions">
              <a className="sp-button sp-button-dark" href="/support/demo">Explorer la démo</a>
              <a className="sp-text-link" href="/support/connexions">Voir les connexions</a>
            </div>
            <p className="sp-caption">Support dès 29 CHF / mois. <a href="/support/tarifs">Voir les formules</a></p>
          </div>
        </section>
        <section className="sp-product-overview sp-wrap" id="fonctionnement">
          <div><h2>Un support<br /><span>facile à suivre.</span></h2><p>De la réception à la décision, retrouvez le contexte et le prochain pas.</p></div>
          <div className="sp-overview-details">
          <details><summary>Rassembler les demandes</summary>
            <p>Connectez une messagerie ou un outil compatible. Retrouvez les demandes, les dossiers et l’historique dans Support.</p>
            <a className="sp-text-link" href="/support/connexions">Les connexions disponibles</a>
          </details>
          <details><summary>Travailler en équipe</summary>
            <p>Organisez les messages, affectez les demandes et préparez vos réponses dans un espace partagé. Support peut s’utiliser seul, sans Gestion.</p>
            <a className="sp-text-link" href="/support/fonctionnalites">Toutes les fonctionnalités</a>
          </details>
          <details><summary>Automatiser le tri et le routage</summary>
            <p>Avec Automation, la catégorie, la priorité et la destination suivent vos règles. Les décisions suffisamment sûres peuvent être appliquées dans un outil compatible ; les demandes ambiguës restent à vérifier.</p>
            <p>Ce parcours nécessite Automation (+15 CHF/mois), une entreprise Gestion active et Support relié à cette même entreprise. Les trois sont inclus dans Complet.</p>
            <a className="sp-text-link" href="/automation">Découvrir Automation</a>
          </details>
          <details><summary>Comprendre les données et la sécurité</summary>
            <p>Retrouvez le traitement des messages, les permissions et les conditions du service avant de connecter vos outils.</p>
            <a className="sp-text-link" href="/support/securite">Sécurité de Support</a>
          </details>
          </div>
        </section>
        <section className="sp-offer sp-wrap" id="tarifs">
          <div><h2>Dès 29 CHF / mois.</h2><p>Choisissez votre formule selon votre activité.</p></div>
          <div className="sp-actions"><a className="sp-button sp-button-dark" href="/support/tarifs">Voir les formules</a><a className="sp-text-link" href="/support/espace">Ouvrir mon espace</a></div>
        </section>
    </SupportMarketingShell>
  );
}
