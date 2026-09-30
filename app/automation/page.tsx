import { StructuredData } from '@/components/structured-data';
import { productData, breadcrumbData } from '@/lib/seo';
import { SiteHeader } from '@/components/site-header';
import { SiteFooter } from '@/components/site-footer';
import { ProductHero, ProductCapture, ProductDetails } from '@/components/quiet-product';
import '@/components/zentra-presentation.css';
import './presentation.css';

export const metadata = {
  title: {
    absolute:
      'Zentra Automation — Vos tâches reliées, votre quotidien simplifié',
  },
  description:
    'Factures fournisseurs, rendez-vous, tri des demandes et tâches préparées : découvrez comment Automation relie Gestion et Support. 15 CHF/mois par entreprise avec Gestion.',
  alternates: { canonical: '/automation' },
};

const functions = [
  {
    title: 'Factures et fournisseurs',
    intro: 'De la facture reçue au bon dossier d’achat.',
    body: 'Reconnaissance du document, extraction des informations disponibles et recherche du fournisseur. Gestion peut sélectionner une correspondance fiable ou créer le fournisseur. Vérifiez plusieurs factures ensemble ; les cas incertains restent à compléter.',
    detail:
      'Comptabilisation selon les règles activées, les montants et les contrôles du document. Aucun paiement bancaire automatique.',
    link: '/features#achats',
    label: 'Voir les achats dans Gestion',
  },
  {
    title: 'Rendez-vous et agenda',
    intro: 'Les confirmations deviennent des rendez-vous.',
    body: 'Automation reconnaît les confirmations reçues dans Support et transmet les informations disponibles à l’agenda de Gestion : intitulé, date, heure et lieu.',
    detail:
      'L’import doit être activé. Un rendez-vous ambigu ou incomplet reste à vérifier.',
    link: '/automation#parcours',
    label: 'Explorer un exemple',
  },
  {
    title: 'E-mails, tickets et équipes',
    intro: 'Chaque demande retrouve son sujet et sa destination.',
    body: 'Catégorie, priorité, choix de l’équipe ou du collaborateur : le tri suit vos règles. Les décisions assez sûres peuvent être appliquées dans un outil compatible. Les demandes ambiguës restent dans la file de vérification.',
    detail:
      'Support, Gestion et Automation doivent être reliés à la même entreprise. Les connexions disponibles sont détaillées dans Support.',
    link: '/support/connexions',
    label: 'Voir les connexions',
  },
  {
    title: 'Tâches, réponses et résumés',
    intro: 'La prochaine action est préparée.',
    body: 'À partir des e-mails classés, vos règles peuvent préparer des tâches pour l’équipe, des réponses issues de vos modèles personnalisables et des résumés des informations reçues.',
    detail:
      'Les brouillons restent à relire. Aucun message n’est envoyé automatiquement ; les résumés reprennent les informations disponibles.',
    link: '/compte/automation',
    label: 'Configurer les règles',
  },
  {
    title: 'Banque, documents et imports',
    intro: 'Moins de choix à refaire.',
    body: 'Suggestions de catégories pour les opérations bancaires, orientation des documents vers le bon parcours et correspondance des colonnes de vos fichiers CSV ou Excel avec le catalogue.',
    detail:
      'L’aperçu et les suggestions restent à vérifier avant validation. Les services en ligne nécessitent une connexion.',
    link: '/features#banque',
    label: 'Découvrir la gestion bancaire',
  },
  {
    title: 'Vos choix et votre équipe',
    intro: 'Un suivi commun, dans la bonne entreprise.',
    body: 'Les choix validés et les corrections sont conservés dans l’historique. Les membres autorisés retrouvent les actions de leur entreprise, les traitements terminés et les éléments qui restent à vérifier.',
    detail:
      'L’accès suit les rôles de Gestion. L’historique ne constitue pas une promesse d’apprentissage autonome illimité.',
    link: '/automation#quotidien',
    label: 'Découvrir le suivi',
  },
] as const;


export default function AutomationPage() {
  return (
    <div className="quiet-site quiet-automation">
      <a className="site-skip-link" href="#contenu">Aller au contenu</a>
      <StructuredData data={productData('automation')} />
      <StructuredData data={breadcrumbData('/automation', 'Zentra Automation')} />
      <SiteHeader />
      <main id="contenu" tabIndex={-1}>
        <ProductHero title={<>Le travail avance.<br /><span>Vous gardez la main.</span></>}
          description="Les factures, les messages et les rendez-vous trouvent leur place. Vous retrouvez ce qui est fait et ce qui reste à vérifier."
          href="#fonctions" action="Découvrir les fonctions" price="Activer Automation" priceHref="/compte/automation">
          <p className="quiet-note">Option de Gestion. Les parcours e-mail nécessitent Support relié.</p>
          <div id="parcours"><span id="quotidien" className="quiet-anchor" />
            <ProductCapture screen="automation" label="L’activité Automation et les éléments à vérifier dans Zentra Gestion" />
          </div>
        </ProductHero>
        <ProductDetails title="Ce qu’Automation fait pour vous." id="fonctions">
          {functions.map(f => <details key={f.title}><summary>{f.title}</summary>
            <p>{f.body}</p><p>{f.detail}</p><a className="quiet-link" href={f.link}>{f.label}</a>
          </details>)}
        </ProductDetails>
        <section className="quiet-offer quiet-width" id="tarif">
          <div><h2>15 CHF / mois. Pour l’entreprise.</h2>
            <p>L’option est partagée avec vos collaborateurs autorisés. Un abonnement Gestion actif est requis. Support se souscrit séparément, ou les trois sont réunis dans <a className="quiet-link" href="/complet">Complet</a>.</p>
          </div>
          <div className="quiet-actions" id="utilisation"><a className="quiet-primary" href="/compte/automation">Configurer Automation</a></div>
        </section>
        <ProductDetails title="Avant de commencer." id="questions">
          <details><summary>Comment l’activer ?</summary>
            <p>Choisissez votre entreprise Gestion, activez l’option, puis sélectionnez vos règles dans Paramètres → Zentra Automation. Pour les e-mails, reliez Support à la même entreprise et connectez votre outil.</p>
            <a className="quiet-link" href="/support/connexions">Les connexions compatibles</a>
          </details>
          <details><summary>Quelles actions restent à valider ?</summary>
            <p>Les cas incertains restent à vérifier. Automation ne remplace pas votre contrôle comptable, ne paie pas vos factures et n’envoie pas de réponse automatiquement. Les réponses préparées utilisent vos modèles personnalisables.</p>
          </details>
          <details><summary>Et lorsque toutes les apps sont fermées ?</summary>
            <p>L’exécution continue lorsque toutes les applications sont fermées n’est pas encore activée. Sur mobile, les transferts reprennent à la réouverture. Les services en ligne nécessitent une connexion.</p>
          </details>
          <details><summary>Puis-je arrêter l’option ?</summary>
            <p>Vous pouvez résilier pour la prochaine échéance. Les fonctions habituelles de Gestion restent disponibles.</p>
            <a className="quiet-link" href="/automation/conditions">Conditions Automation</a>
          </details>
        </ProductDetails>
      </main>
      <SiteFooter />
    </div>
  );
}
