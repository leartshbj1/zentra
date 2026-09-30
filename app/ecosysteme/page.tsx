import { SiteHeader } from '@/components/site-header';
import { SiteFooter } from '@/components/site-footer';
import { ProductHero, ProductDetails } from '@/components/quiet-product';

export const metadata = {
  title: { absolute: 'Zentra — Des outils qui travaillent ensemble' },
  description: 'Du message reçu au bon dossier : découvrez comment Gestion, Support et Automation travaillent ensemble pour votre entreprise.',
  alternates: { canonical: '/ecosysteme' },
};

export default function EcosystemPage() {
  return <div className="quiet-site quiet-ecosystem">
    <a href="#contenu" className="site-skip-link">Aller au contenu</a>
    <SiteHeader />
    <main id="contenu" tabIndex={-1}>
      <ProductHero title={<>Tout se relie.<br /><span>Votre journée avance.</span></>}
        description="Un message arrive dans Support. Automation prépare la suite. Gestion retrouve les informations au bon endroit."
        href="#parcours" action="Explorer le parcours" />
      <ProductDetails title="Chacun son rôle. Un même quotidien." id="parcours">
        <details><summary>Gestion : votre entreprise</summary><p>Les clients, devis, factures, achats, projets, salaires et la comptabilité, dans un espace partagé avec les membres autorisés.</p><a className="quiet-link" href="/gestion">Découvrir Gestion</a></details>
        <details><summary>Support : vos échanges</summary><p>Les messages et demandes de votre équipe, avec l’historique et les connexions compatibles. Support peut aussi s’utiliser sans Gestion.</p><a className="quiet-link" href="/support">Découvrir Support</a></details>
        <details><summary>Automation : le lien entre les tâches</summary><p>Une option de Gestion qui classe et prépare les informations selon vos règles. Pour les messages, Support doit être relié à la même entreprise. Les réponses restent à valider et aucun paiement ne part automatiquement.</p><a className="quiet-link" href="/automation">Découvrir Automation</a></details>
      </ProductDetails>
      <section className="quiet-offer quiet-width"><div><h2>Réunis dans Zentra Complet.</h2><p>Les trois produits, dans un même abonnement.</p></div><a className="quiet-primary" href="/complet">Découvrir le pack</a></section>
    </main>
    <SiteFooter />
  </div>;
}
