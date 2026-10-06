import type { Metadata } from 'next';
import { PricingPlans } from '@/components/pricing-plans';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import { ProductHero, ProductDetails } from '@/components/quiet-product';
import { redirect } from 'next/navigation';
import { prepaidReceiptPath } from '@/lib/payments/prepaid-receipt-types';

export const metadata: Metadata = {
  title: 'Tarifs — Solo, Start et Pro dès 49 CHF par mois',
  description:
    'Solo 49 CHF pour 1 personne, Start 59 CHF pour 3 et Pro 89 CHF pour 10. Fonctions de gestion incluses, titulaire compris. Zentra Automation est une option séparée à 15 CHF/mois.',
  alternates: { canonical: '/pricing' },
  openGraph: {
    title: 'Zentra — Solo 49 CHF, Start 59 CHF, Pro 89 CHF',
    description:
      'Trois formules selon la taille de votre équipe, avec les mêmes fonctions de gestion.',
    url: '/pricing',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'Zentra' }],
  },
};

const questions = [
  [
    'Le prix augmente-t-il avec le nombre de collaborateurs ?',
    'Choisissez Solo à 49 CHF pour 1 personne, Start à 59 CHF pour 3 personnes ou Pro à 89 CHF pour 10 personnes. Le titulaire, les collaborateurs, les comptables et les accès en lecture seule comptent dans ce total. Les invitations en attente réservent une place. Plusieurs appareils peuvent être liés à une même personne.',
  ],
  [
    'Faut-il acheter des modules séparément ?',
    'Les fonctions de gestion décrites dans ces trois formules sont incluses. Zentra Automation est une option facultative à 15 CHF/mois par entreprise. Le nombre de personnes qui peuvent se connecter est la seule différence. Les fiches de salariés dans la paie ne consomment pas de place. Zentra Support est un produit avec un abonnement distinct.',
  ],
  [
    'Comment fonctionne la résiliation ?',
    'L’abonnement est renouvelé mensuellement. Lorsque Stripe est activé pour votre compte, le portail client permet de gérer le moyen de paiement, les factures Stripe et la résiliation pour la fin de la période en cours.',
  ],
  [
    'Le téléchargement déclenche-t-il un paiement ?',
    'Non. Télécharger l’installateur ne crée aucun abonnement. Une licence active est ensuite nécessaire pour utiliser l’application complète.',
  ],
] as const;


export default async function PricingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  if (query.achat !== undefined) redirect(prepaidReceiptPath(query.achat));
  return (
    <div className="quiet-site quiet-pricing">
      <a href="#contenu" className="site-skip-link">Aller au contenu</a>
      <SiteHeader />
      <main id="contenu" tabIndex={-1}>
        <ProductHero title={<>La même gestion.<br /><span>À la taille de votre équipe.</span></>}
          description="Toutes les fonctions de Gestion. Choisissez 1, 3 ou 10 personnes, titulaire compris."
          href="#formules" action="Choisir ma formule" />
        <section className="quiet-width" id="formules"><PricingPlans /></section>
        <ProductDetails title="Les réponses à vos questions." id="questions">
          {questions.map(([question, answer]) => <details key={question}><summary>{question}</summary><p>{answer}</p></details>)}
        </ProductDetails>
        <section className="quiet-offer quiet-width">
          <div><h2>Vous voulez les trois produits ?</h2><p>Gestion, Support et Automation sont réunis dans Complet, dès 79 CHF/mois.</p></div>
          <a className="quiet-primary" href="/complet">Découvrir Complet</a>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
