import { redirect } from 'next/navigation';
import { StructuredData } from '@/components/structured-data';
import { productData, breadcrumbData } from '@/lib/seo';
import { ArrowRight, Route, ScanText, UsersRound } from 'lucide-react';
import { RoutingExample } from '@/components/support/presentation';
import { AutomationBridge } from '@/components/product-story';
import {
  SupportCallToAction,
  SupportMarketingShell,
} from '@/components/support/marketing-shell';
import { supportMetadata } from '@/lib/support/marketing';

export const metadata = supportMetadata(
  'Classement et routage des tickets clients',
  'Centralisez les demandes avec Zentra Support. Ajoutez Zentra Automation pour leur classement, leur priorité et leur routage automatique.',
  '/support',
);

const steps = [
  {
    Icon: ScanText,
    title: 'Comprendre la demande',
    text: 'Bug, facturation, livraison, remboursement… Le contenu du ticket détermine sa catégorie et sa priorité.',
  },
  {
    Icon: Route,
    title: 'Appliquer vos règles',
    text: 'Vous associez les catégories aux équipes. Les décisions suffisamment sûres sont appliquées dans votre outil connecté.',
  },
  {
    Icon: UsersRound,
    title: 'Vous confier les exceptions',
    text: 'Un message ambigu, une confiance insuffisante ou une demande d’intervention humaine ? Le ticket reste à vérifier.',
  },
];

export default async function SupportPresentation({
  searchParams,
}: {
  searchParams: Promise<{ workspace?: string }>;
}) {
  const params = await searchParams;
  if (params.workspace)
    redirect(
      `/support/espace?workspace=${encodeURIComponent(params.workspace)}`,
    );
  return (
    <SupportMarketingShell>
      <StructuredData data={productData('support')} />
      <StructuredData data={breadcrumbData('/support', 'Zentra Support')} />
      <section className="sp-hero sp-wrap">
        <div className="sp-hero-copy">
          <p className="sp-kicker">
            <span /> ZENTRA SUPPORT
          </p>
          <h1>
            Le bon ticket.
            <br />
            <em>La bonne équipe.</em>
          </h1>
          <p className="sp-lead">
            Vos demandes et votre équipe, au même endroit. Avec l’option
            Zentra Automation, les tickets sont classés, priorisés et orientés
            vers les bonnes personnes.
          </p>
          <div className="sp-actions">
            <a href="/support/demo" className="sp-button sp-button-dark">
              Voir le produit en action <ArrowRight size={17} />
            </a>
            <a href="/support/tarifs" className="sp-text-link">
              Découvrir les formules <ArrowRight size={16} />
            </a>
          </div>
          <p className="sp-hero-note">
            Support dès 29 CHF/mois. Tri automatique avec Automation (+15 CHF/mois) et une entreprise Gestion active.
          </p>
        </div>
        <RoutingExample />
      </section>
      <section
        className="sp-product-statement sp-wrap"
        aria-label="Un produit indépendant"
      >
        <span>VOTRE SERVICE CLIENT, MIEUX ORGANISÉ</span>
        <p>
          Votre logiciel de support reste au cœur du travail.{' '}
          <strong>Zentra Support rassemble les demandes de votre équipe.</strong>
        </p>
        <a href="/support/connexions" className="sp-text-link">
          Voir les connexions disponibles <ArrowRight size={16} />
        </a>
      </section>
      <section className="sp-section sp-soft" id="fonctionnement">
        <div className="sp-wrap">
          <div className="sp-section-title">
            <p className="sp-kicker">AVEC L’OPTION ZENTRA AUTOMATION</p>
            <h2>
              Le tri avance.
              <br />
              <span>Votre équipe aussi.</span>
            </h2>
          </div>
          <div className="sp-steps">
            {steps.map(({ Icon, title, text }, index) => (
              <article key={title}>
                <div className="sp-step-top">
                  <Icon size={23} />
                  <span>0{index + 1}</span>
                </div>
                <h3>{title}</h3>
                <p>{text}</p>
              </article>
            ))}
          </div>
          <a
            href="/support/fonctionnalites"
            className="sp-text-link sp-section-link"
          >
            Explorer les fonctionnalités <ArrowRight size={16} />
          </a>
        </div>
      </section>
      <section className="sp-section sp-wrap">
        <div className="sp-section-title">
          <p className="sp-kicker">PENSÉ POUR VOTRE QUOTIDIEN</p>
          <h2>
            Des demandes différentes.
            <br />
            <span>Une même clarté.</span>
          </h2>
        </div>
        <div className="sp-usecase-grid">
          <a href="/support/solutions#ecommerce">
            <span>01 / E-COMMERCE</span>
            <h3>
              Les commandes d’un côté.
              <br />
              Les remboursements de l’autre.
            </h3>
            <p>Orientez chaque demande vers le bon service.</p>
            <ArrowRight size={20} />
          </a>
          <a href="/support/solutions#saas">
            <span>02 / SAAS</span>
            <h3>
              Le produit et la facturation
              <br />
              retrouvent leur place.
            </h3>
            <p>Séparez les incidents des questions d’utilisation.</p>
            <ArrowRight size={20} />
          </a>
          <a href="/support/solutions#agences">
            <span>03 / AGENCES</span>
            <h3>
              Chaque demande
              <br />a son interlocuteur.
            </h3>
            <p>Organisez la réception entre vos équipes.</p>
            <ArrowRight size={20} />
          </a>
        </div>
      </section>
      <section className="sp-section sp-dark">
        <div className="sp-wrap sp-product-split">
          <div>
            <p className="sp-kicker">UN PRODUIT. SON PROPRE ESPACE.</p>
            <h2>
              Votre support a<br />
              son adresse.
            </h2>
            <p>
              Un tableau de bord dédié, vos connexions, vos règles et un
              abonnement pour toute l’équipe. Utilisable indépendamment de
              Zentra Gestion.
            </p>
          </div>
          <div className="sp-product-links">
            <a href="/support/connexions" id="connexions">
              <span>Connecter votre outil</span>
              <ArrowRight size={20} />
            </a>
            <a href="/support/tarifs" id="tarifs">
              <span>Choisir votre formule · dès 29 CHF/mois</span>
              <ArrowRight size={20} />
            </a>
            <a href="/support/securite">
              <span>Comprendre le traitement des données</span>
              <ArrowRight size={20} />
            </a>
          </div>
        </div>
      </section>
      <AutomationBridge from="support" />
      <SupportCallToAction />
    </SupportMarketingShell>
  );
}
