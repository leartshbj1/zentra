import { ArrowRight, Check } from 'lucide-react';
import { StructuredData } from './structured-data';
import { homeQuestions, faqData } from '@/lib/seo';
import { SiteHeader } from './site-header';
import { SiteFooter } from './site-footer';
import { ProductRange } from './product-range';
import { ProductStory } from './product-story';
import { CompleteBanner } from './complete-banner';
import './zentra-presentation.css';

export function ProductsHome() {
  return (
    <div className="zentra-presentation">
      <a className="site-skip-link" href="#contenu">
        Aller au contenu
      </a>
      <StructuredData data={faqData()} />
      <SiteHeader />
      <main id="contenu" tabIndex={-1}>
        <section className="zentra-intro zentra-home-intro">
          <div className="zentra-home-copy">
          <h1>
            Votre entreprise.
            <br />
            <span>Tout se rejoint.</span>
          </h1>
          <p>
            La gestion, les demandes clients et les tâches du quotidien.
            <br className="zentra-desktop-break" /> Des outils pensés pour
            travailler ensemble, au rythme de votre PME.
          </p>
          <div className="zentra-actions">
            <a className="zentra-primary" href="#parcours">
              Voir comment tout se relie{' '}
              <ArrowRight size={17} aria-hidden="true" />
            </a>
            <a className="zentra-text-link" href="#produits">
              Découvrir les produits <ArrowRight size={17} aria-hidden="true" />
            </a>
          </div>
          </div>
          <div
          className="zentra-journey zentra-home-stage"
          id="parcours"
          aria-label="Comment Gestion, Support et Automation travaillent ensemble"
        >
          <ProductStory compact />
          </div>
        </section>
        <section
          className="zentra-section zentra-width"
          id="produits"
          aria-labelledby="range-title"
        >
          <div className="zentra-section-heading">
            <h2 id="range-title">
              Choisissez vos outils.
              <br />
              <span>Ils partagent le même esprit.</span>
            </h2>
            <p>
              Gestion pour piloter. Support pour répondre. Automation pour
              préparer la suite.
            </p>
          </div>
          <ProductRange />
        </section>
        <CompleteBanner />
        <section
          className="zentra-automation-feature"
          aria-labelledby="automation-feature-title"
        >
          <div className="zentra-width zentra-split">
            <div>
              <h2 id="automation-feature-title">
                Automation.
                <br />
                Le lien entre
                <br />
                <span>les petites tâches.</span>
              </h2>
              <p>
                Le message reçu, le fournisseur retrouvé, le rendez-vous ajouté.
                Automation rassemble ce qui avance et vous montre ce qui demande
                votre attention.
              </p>
              <a className="zentra-primary" href="/automation">
                Explorer Automation <ArrowRight size={17} aria-hidden="true" />
              </a>
              <p className="zentra-fine">
                Option de Gestion · 15 CHF/mois par entreprise.
              </p>
            </div>
            <div
              className="zentra-day-preview"
              aria-label="Exemple fictif du bilan quotidien d’Automation"
            >
              <div className="zentra-preview-heading">
                <strong>Zentra Automation</strong>
                <span>Exemple illustratif</span>
              </div>
              <h3>Bonjour, Camille.</h3>
              <p>Voici ce qui a avancé aujourd’hui.</p>
              <ul>
                <li>
                  <Check size={19} aria-hidden="true" />
                  <span>
                    <strong>4 factures enregistrées</strong>
                    <small>Retrouvez-les dans vos achats.</small>
                  </span>
                </li>
                <li>
                  <Check size={19} aria-hidden="true" />
                  <span>
                    <strong>1 rendez-vous ajouté</strong>
                    <small>Les informations sont dans l’agenda.</small>
                  </span>
                </li>
              </ul>
              <div className="zentra-preview-attention">
                <span>À votre attention</span>
                <strong>Une facture à compléter</strong>
                <p>La référence n’est pas assez lisible.</p>
              </div>
              <a href="/automation#quotidien">
                Découvrir le suivi quotidien{' '}
                <ArrowRight size={16} aria-hidden="true" />
              </a>
            </div>
          </div>
        </section>
        <section
          className="zentra-section zentra-width zentra-choice"
          aria-labelledby="choice-title"
        >
          <h2 id="choice-title">
            Commencez par
            <br />
            ce qui vous est utile.
          </h2>
          <div>
            <a href="/demo-facture">
              <span>
                <strong>Je veux gérer mon entreprise</strong>
                <small>Explorez la démo de Gestion, sans compte.</small>
              </span>
              <ArrowRight size={20} aria-hidden="true" />
            </a>
            <a href="/support/demo">
              <span>
                <strong>Je veux organiser mon support</strong>
                <small>Testez des exemples de demandes clients.</small>
              </span>
              <ArrowRight size={20} aria-hidden="true" />
            </a>
            <a href="/automation#utilisation">
              <span>
                <strong>Je veux automatiser mes tâches</strong>
                <small>Découvrez les fonctions et leur activation.</small>
              </span>
              <ArrowRight size={20} aria-hidden="true" />
            </a>
            <p className="zentra-fine">
              Gestion et Support ont des abonnements distincts. Automation
              s’active pour une entreprise Gestion et ses collaborateurs
              autorisés.
            </p>
          </div>
        </section>
        <section
          className="zentra-section zentra-width zentra-faq"
          id="questions"
          aria-labelledby="questions-title"
        >
          <h2 id="questions-title">
            Les réponses,
            <br />
            simplement.
          </h2>
          <div>
            {homeQuestions.map(({ question, answer, href, label }) => (
              <details key={question}>
                <summary>{question}</summary>
                <p>{answer}</p>
                <a href={href}>
                  {label}
                  <ArrowRight size={15} aria-hidden="true" />
                </a>
              </details>
            ))}
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
