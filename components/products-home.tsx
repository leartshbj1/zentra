import { ArrowRight, Check } from 'lucide-react';
import { StructuredData } from './structured-data';
import { homeQuestions, faqData } from '@/lib/seo';
import { SiteHeader } from './site-header';
import { SiteFooter } from './site-footer';
import { ProductRange } from './product-range';
import { HomeExperience, ProductFinder } from './home-experience';
import { CompleteBanner } from './complete-banner';
import './zentra-presentation.css';

export function ProductsHome() {
  return (
    <div className="zentra-presentation intuitive-home">
      <a className="site-skip-link" href="#contenu">
        Aller au contenu
      </a>
      <StructuredData data={faqData()} />
      <SiteHeader />
      <main id="contenu" tabIndex={-1}>
        <HomeExperience />
        <section
          className="zentra-section zentra-width"
          id="produits"
          aria-labelledby="range-title"
        >
          <div className="zentra-section-heading">
            <h2 id="range-title">
              Trois produits.
              <br />
              <span>Une même façon de travailler.</span>
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
        <ProductFinder />
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
