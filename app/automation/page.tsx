import {
  ArrowRight,
  Check,
  CalendarDays,
  FileText,
  ListChecks,
} from 'lucide-react';
import { StructuredData } from '@/components/structured-data';
import { productData, breadcrumbData } from '@/lib/seo';
import { SiteHeader } from '@/components/site-header';
import { SiteFooter } from '@/components/site-footer';
import { ProductStory } from '@/components/product-story';
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
    <div className="zentra-presentation automation-showcase">
      <a className="site-skip-link" href="#contenu">
        Aller au contenu
      </a>
      <StructuredData data={productData('automation')} />
      <StructuredData
        data={breadcrumbData('/automation', 'Zentra Automation')}
      />
      <SiteHeader />
      <main id="contenu" tabIndex={-1}>
        <section className="zentra-intro automation-intro">
          <h1>
            Le travail avance.
            <br />
            <span>Vous gardez la main.</span>
          </h1>
          <p>
            Zentra Automation relie vos messages, vos documents et votre
            gestion.
            <br className="zentra-desktop-break" /> Il prépare la suite. Vous
            voyez ce qui est fait et ce qui reste à vérifier.
          </p>
          <div className="zentra-actions">
            <a className="zentra-primary" href="#parcours">
              Voir Automation en action
              <ArrowRight size={17} aria-hidden="true" />
            </a>
            <a className="zentra-text-link" href="#tarif">
              15 CHF / mois par entreprise
              <ArrowRight size={17} aria-hidden="true" />
            </a>
          </div>
          <p className="automation-intro-note">
            Une option de Zentra Gestion. Pour les parcours e-mail, ajoutez un
            espace Support relié.
          </p>
        </section>
        <section
          className="zentra-width"
          id="parcours"
          aria-label="Démonstration des parcours Automation"
        >
          <ProductStory />
        </section>
        <section
          className="zentra-section zentra-width automation-functions"
          id="fonctions"
          aria-labelledby="functions-title"
        >
          <div className="zentra-section-heading">
            <h2 id="functions-title">
              Les bonnes tâches.
              <br />
              <span>Au bon endroit.</span>
            </h2>
            <p>
              Découvrez ce qu’Automation prépare, ce qu’il peut appliquer et ce
              qui reste entre vos mains.
            </p>
          </div>
          <div className="automation-function-list">
            {functions.map((f) => (
              <details key={f.title}>
                <summary>
                  <span>
                    <strong>{f.title}</strong>
                    <small>{f.intro}</small>
                  </span>
                  <span className="automation-expand" aria-hidden="true" />
                </summary>
                <div className="automation-function-body">
                  <p>{f.body}</p>
                  <p className="zentra-fine">{f.detail}</p>
                  <a className="zentra-text-link" href={f.link}>
                    {f.label}
                    <ArrowRight size={16} aria-hidden="true" />
                  </a>
                </div>
              </details>
            ))}
          </div>
        </section>
        <section
          className="automation-daily-section"
          id="quotidien"
          aria-labelledby="daily-title"
        >
          <div className="zentra-width zentra-split">
            <div>
              <h2 id="daily-title">
                Votre journée.
                <br />
                <span>En un coup d’œil.</span>
              </h2>
              <p>
                Ouvrez Gestion ou l’onglet Automation de Support. Retrouvez
                l’activité de la même entreprise et les éléments qui ont besoin
                de vous.
              </p>
              <ul className="automation-daily-explain">
                <li>
                  <strong>Aujourd’hui</strong>
                  <span>Les résultats et les prochaines actions.</span>
                </li>
                <li>
                  <strong>Suivi</strong>
                  <span>
                    L’historique, les tâches et les réponses préparées.
                  </span>
                </li>
                <li>
                  <strong>Réglages</strong>
                  <span>Vos fonctions, vos règles et vos seuils.</span>
                </li>
              </ul>
              <a className="zentra-text-link" href="/compte/automation">
                Ouvrir mon espace Automation
                <ArrowRight size={17} aria-hidden="true" />
              </a>
            </div>
            <div className="automation-daily-artifact">
              <div className="zentra-preview-heading">
                <strong>Automation · Aujourd’hui</strong>
                <span>Exemple fictif</span>
              </div>
              <h3>Bonjour, Camille.</h3>
              <p>Votre entreprise a avancé.</p>
              <div className="automation-daily-result">
                <Check size={19} aria-hidden="true" />
                <span>
                  <strong>4 factures enregistrées</strong>
                  <small>Dans les achats de Gestion.</small>
                </span>
              </div>
              <div className="automation-daily-result">
                <CalendarDays size={19} aria-hidden="true" />
                <span>
                  <strong>1 rendez-vous ajouté</strong>
                  <small>Dans l’agenda de l’équipe.</small>
                </span>
              </div>
              <h4>À votre attention</h4>
              <div className="automation-daily-pending">
                <FileText size={20} aria-hidden="true" />
                <span>Une facture à compléter</span>
                <strong>1</strong>
              </div>
              <div className="automation-daily-pending">
                <ListChecks size={20} aria-hidden="true" />
                <span>Réponses préparées, à relire</span>
                <strong>2</strong>
              </div>
              <p className="automation-daily-caption">
                Les actions en attente restent distinctes des traitements
                terminés.
              </p>
            </div>
          </div>
        </section>
        <section
          className="zentra-section zentra-width automation-control"
          aria-labelledby="control-title"
        >
          <div>
            <h2 id="control-title">
              Automatique.
              <br />
              <span>Quand vous l’autorisez.</span>
            </h2>
            <p>
              Choisissez les traitements utiles à votre entreprise et le niveau
              de confiance attendu. Vous pouvez commencer par observer, puis
              activer les fonctions à votre rythme.
            </p>
          </div>
          <ul>
            <li>
              <Check size={19} aria-hidden="true" />
              <span>
                <strong>Des règles explicites</strong>Les actions suivent les
                fonctions activées et leurs contrôles.
              </span>
            </li>
            <li>
              <Check size={19} aria-hidden="true" />
              <span>
                <strong>Les incertitudes vous reviennent</strong>Une référence
                illisible ou une date ambiguë reste à vérifier.
              </span>
            </li>
            <li>
              <Check size={19} aria-hidden="true" />
              <span>
                <strong>Une trace des décisions</strong>Retrouvez les
                traitements, les résultats et les choix confirmés.
              </span>
            </li>
            <li>
              <Check size={19} aria-hidden="true" />
              <span>
                <strong>Les actions sensibles restent encadrées</strong>Aucun
                paiement bancaire ni envoi automatique de réponse.
              </span>
            </li>
          </ul>
        </section>
        <section
          className="automation-start-section"
          id="utilisation"
          aria-labelledby="start-title"
        >
          <div className="zentra-width">
            <h2 id="start-title">
              Un compte. Votre entreprise.
              <br />
              <span>Et les bonnes connexions.</span>
            </h2>
            <ol>
              <li>
                <strong>Choisissez votre entreprise</strong>
                <p>
                  Connectez votre compte et sélectionnez l’espace Gestion
                  concerné. Automation est lié à cet espace, avec ses
                  collaborateurs autorisés.
                </p>
              </li>
              <li>
                <strong>Activez Automation</strong>
                <p>
                  Le titulaire confirme l’option, puis choisit les fonctions et
                  les règles. Aucune clé technique à fournir.
                </p>
              </li>
              <li>
                <strong>Reliez Support si nécessaire</strong>
                <p>
                  Pour les e-mails et tickets, reliez Support à la même
                  entreprise et configurez une connexion compatible.
                </p>
              </li>
            </ol>
            <div className="zentra-actions">
              <a className="zentra-primary" href="/compte/automation">
                Configurer mon entreprise
                <ArrowRight size={17} aria-hidden="true" />
              </a>
              <a className="zentra-text-link" href="/support/connexions">
                Voir les connexions
                <ArrowRight size={17} aria-hidden="true" />
              </a>
            </div>
            <p className="zentra-fine">
              Dans l’application : Paramètres → Zentra Automation.{' '}
              <a href="/download">Télécharger la dernière version</a>.
            </p>
          </div>
        </section>
        <section
          className="zentra-section zentra-width automation-offer"
          id="tarif"
          aria-labelledby="offer-title"
        >
          <div>
            <h2 id="offer-title">
              Une option pour
              <br />
              toute votre entreprise.
            </h2>
            <p>
              Les collaborateurs autorisés en bénéficient dans le même espace.
              Les limites de personnes restent celles de votre formule Gestion.
            </p>
            <a className="zentra-text-link" href="/pricing">
              Comparer les formules Gestion
              <ArrowRight size={17} aria-hidden="true" />
            </a>
          </div>
          <div className="automation-offer-price">
            <h3>Zentra Automation</h3>
            <p>
              <strong>15 CHF</strong>
              <span>/ mois par entreprise</span>
            </p>
            <a className="zentra-primary" href="/compte/automation">
              Découvrir et activer
              <ArrowRight size={17} aria-hidden="true" />
            </a>
            <p className="zentra-fine">
              Abonnement Gestion actif requis. Support se souscrit séparément.
              Résiliation pour la prochaine échéance.
            </p>
            <a href="/automation/conditions">Lire les conditions de l’option</a>
          </div>
        </section>
        <section
          className="zentra-section zentra-width zentra-faq"
          aria-labelledby="automation-faq-title"
        >
          <h2 id="automation-faq-title">
            Tout est clair
            <br />
            avant de commencer.
          </h2>
          <div>
            <details>
              <summary>Ai-je besoin des trois produits ?</summary>
              <p>
                Non. Gestion et Support restent des produits distincts.
                Automation nécessite une entreprise Gestion active. Pour traiter
                les e-mails et les tickets puis les transmettre à Gestion, il
                faut aussi un espace Support relié et une connexion compatible.
              </p>
            </details>
            <details>
              <summary>
                Est-ce que tout fonctionne lorsque l’app est fermée ?
              </summary>
              <p>
                Les traitements nécessitent une connexion et les services
                correspondants. L’exécution continue lorsque toutes les
                applications sont fermées n’est pas encore activée. Sur mobile,
                les transferts reprennent à la réouverture de l’application.
              </p>
            </details>
            <details>
              <summary>
                Automation remplace-t-il mon contrôle comptable ?
              </summary>
              <p>
                Non. Il aide à préparer les informations et peut appliquer les
                traitements autorisés qui passent leurs contrôles. Les données
                manquantes, les cas incertains et la validation de votre
                comptabilité restent à examiner.
              </p>
            </details>
            <details>
              <summary>
                Mes collaborateurs doivent-ils payer l’option chacun ?
              </summary>
              <p>
                Non. L’option s’applique à l’entreprise choisie. Les membres
                autorisés en bénéficient selon leur rôle, dans les limites de
                votre formule Gestion.
              </p>
            </details>
            <details>
              <summary>Que se passe-t-il si je désactive l’option ?</summary>
              <p>
                Les fonctions habituelles de Gestion restent disponibles. Vous
                pouvez continuer à organiser vos documents et vos opérations
                manuellement. Consultez les conditions pour les modalités de
                résiliation.
              </p>
              <a href="/automation/conditions">
                Conditions Automation
                <ArrowRight size={15} aria-hidden="true" />
              </a>
            </details>
          </div>
        </section>
        <div className="zentra-width automation-referral">
          <p>Vous connaissez une entreprise qui pourrait aimer Zentra ?</p>
          <a className="zentra-text-link" href="/parrainage/conditions">
            Découvrir le parrainage
            <ArrowRight size={16} aria-hidden="true" />
          </a>
          <p className="zentra-fine">
            −50 % sur son premier mois de Gestion ; −25 % sur votre prochaine
            mensualité après son premier paiement, selon les conditions.
          </p>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
