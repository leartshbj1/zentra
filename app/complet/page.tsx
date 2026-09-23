import { ArrowRight, FileText, Inbox, Workflow } from 'lucide-react';
import { SiteHeader } from '@/components/site-header';
import { SiteFooter } from '@/components/site-footer';
import { CompleteOffer } from '@/components/complete-offer';
import { ProductStory } from '@/components/product-story';
import '@/components/zentra-presentation.css';
import './complet.css';

export const metadata = {
  title: { absolute: 'Zentra Complet — Gestion, Support et Automation réunis' },
  description:
    'Un pack pour votre entreprise : Gestion, Support et Automation dès 79 CHF/mois. Solo, Équipe ou Pro. Un abonnement commun, des outils qui travaillent ensemble.',
  alternates: { canonical: '/complet' },
};

export default function CompletePage() {
  return (
    <div className="zentra-presentation complete-page">
      <a className="site-skip-link" href="#contenu">
        Aller au contenu
      </a>
      <SiteHeader />
      <main id="contenu" tabIndex={-1}>
        <section className="zentra-intro complete-intro">
          <h1>
            Zentra Complet.
            <br />
            <span>Tout, ensemble.</span>
          </h1>
          <p>
            Gestion, Support et Automation.
            <br /> Un abonnement, un même espace.
          </p>
        </section>
        <div className="zentra-width">
          <CompleteOffer />
        </div>
        <section
          className="zentra-section zentra-width complete-included"
          id="inclus"
        >
          <div className="zentra-section-heading">
            <h2>
              Trois outils.
              <br />
              <span>Un quotidien plus simple.</span>
            </h2>
            <p>
              Les mêmes fonctions dans chaque pack. Choisissez selon votre
              équipe et le volume de demandes à analyser.
            </p>
          </div>
          <div className="complete-products">
            <article>
              <FileText aria-hidden="true" size={30} />
              <h3>Gestion</h3>
              <p>
                Devis, factures, achats, projets et comptabilité. Votre
                entreprise dans un espace partagé.
              </p>
              <a href="/gestion">
                Découvrir Gestion <ArrowRight size={17} aria-hidden="true" />
              </a>
            </article>
            <article>
              <Inbox aria-hidden="true" size={30} />
              <h3>Support</h3>
              <p>
                Vos messages et tickets rassemblés, avec les connexions
                compatibles, l’historique et le travail en équipe.
              </p>
              <a href="/support/connexions">
                Voir les connexions <ArrowRight size={17} aria-hidden="true" />
              </a>
            </article>
            <article>
              <Workflow aria-hidden="true" size={30} />
              <h3>Automation</h3>
              <p>
                Le tri, les documents et les rendez-vous préparés selon vos
                règles. Les cas incertains restent à vérifier.
              </p>
              <a href="/automation">
                Explorer Automation <ArrowRight size={17} aria-hidden="true" />
              </a>
            </article>
          </div>
        </section>
        <section className="complete-story-section">
          <div className="zentra-width">
            <div className="zentra-section-heading">
              <h2>
                Du message reçu
                <br />
                <span>au travail qui avance.</span>
              </h2>
              <p>
                Explorez un exemple. Les traitements automatiques suivent les
                connexions et les règles que vous activez.
              </p>
            </div>
            <ProductStory />
          </div>
        </section>
        <section className="zentra-section zentra-width complete-start">
          <h2>
            Votre équipe.
            <br />
            <span>Un même espace.</span>
          </h2>
          <ol>
            <li>
              <span>01</span>
              <h3>Choisissez votre pack</h3>
              <p>
                Un seul paiement mensuel pour les trois produits, lié à votre
                compte.
              </p>
            </li>
            <li>
              <span>02</span>
              <h3>Reliez vos outils</h3>
              <p>
                Retrouvez votre entreprise dans Gestion, connectez votre boîte
                mail ou votre outil dans Support.
              </p>
            </li>
            <li>
              <span>03</span>
              <h3>Activez vos règles</h3>
              <p>
                Décidez ce qu’Automation peut traiter. Votre équipe retrouve le
                suivi dans la même entreprise.
              </p>
            </li>
          </ol>
        </section>
        <section className="complete-existing zentra-width" id="deja-client">
          <div>
            <h2>Vous utilisez déjà Zentra ?</h2>
            <p>
              Changez de formule depuis votre compte. Votre entreprise est
              conservée et le pack prend le relais après les périodes déjà
              payées, sans double renouvellement.
            </p>
          </div>
          <a
            className="zentra-text-link"
            href="/compte/abonnement"
          >
            Changer ma formule{' '}
            <ArrowRight size={18} aria-hidden="true" />
          </a>
        </section>
        <section
          className="zentra-section zentra-width zentra-faq complete-faq"
          id="questions"
        >
          <h2>Simple, jusqu’aux détails.</h2>
          <details>
            <summary>Puis-je essayer les trois produits ?</summary>
            <p>
              Oui, pendant 14 jours, sans carte bancaire ni paiement automatique.
              L’essai comprend une entreprise, 3 personnes titulaire compris et
              250 analyses Support partagées. Vous connectez vos outils et
              choisissez les automatismes à activer.{' '}
              <a href="/compte">Commencer mon essai</a>.
            </p>
          </details>
          <details>
            <summary>Que comprend le prix ?</summary>
            <p>
              Gestion, Support et Automation pour une entreprise, avec 1, 3 ou
              10 personnes dans Gestion, titulaire compris. Les volumes Support
              sont de 2 000, 5 000 ou 15 000 analyses par période mensuelle. Les
              services tiers que vous connectez gardent leurs propres
              abonnements.
            </p>
          </details>
          <details>
            <summary>Qu’est-ce qu’une analyse Support ?</summary>
            <p>
              C’est le traitement d’un message ou d’un ticket par le système de
              classement. Une nouvelle analyse peut consommer une unité
              supplémentaire. Le compteur est visible dans Support. Une fois le
              volume atteint, les analyses reprennent au renouvellement ; aucun
              supplément n’est facturé automatiquement.
            </p>
          </details>
          <details>
            <summary>Est-ce que tout devient automatique ?</summary>
            <p>
              Vous choisissez les règles et connectez vos outils. Automation
              peut classer, préparer les informations et appliquer les actions
              autorisées. Les éléments ambigus restent à vérifier. Il ne paie
              pas vos factures à votre place et n’envoie pas de réponse sans
              votre validation.
            </p>
          </details>
          <details>
            <summary>Puis-je garder les produits séparés ?</summary>
            <p>
              Oui. <a href="/pricing">Gestion</a>,{' '}
              <a href="/support/tarifs">Support</a> et l’option{' '}
              <a href="/automation#tarif">Automation</a> restent disponibles
              séparément. Le pack rassemble les trois avec un prix commun plus
              avantageux.
            </p>
          </details>
          <details>
            <summary>Comment arrêter l’abonnement ?</summary>
            <p>
              Depuis votre compte, ouvrez la gestion de l’abonnement et résiliez
              le pack. L’accès reste disponible jusqu’à la fin de la période
              payée. Les trois produits suivent le même abonnement.{' '}
              <a href="/complet/conditions">Lire les conditions du pack</a>.
            </p>
          </details>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
