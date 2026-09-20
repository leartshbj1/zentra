import {
  ArrowRight,
  Check,
  FileText,
  FolderOpen,
  SlidersHorizontal,
} from 'lucide-react';
import { SiteHeader } from '@/components/site-header';
import { SiteFooter } from '@/components/site-footer';
import '@/components/automation/automation.css';
import './presentation.css';
export const metadata = {
  title: { absolute: 'Zentra Automation — Moins de tri. Plus de temps.' },
  description:
    'Classez vos opérations et orientez vos documents avec les suggestions de Zentra Automation. Une option de Zentra Gestion à 15 CHF par mois par entreprise.',
  alternates: { canonical: '/automation' },
};
export default function AutomationPage() {
  return (
    <>
      <SiteHeader />
      <main className="automation-page automation-marketing" id="contenu">
        <div className="automation-wrap">
          <nav
            className="automation-product-nav"
            aria-label="Zentra Automation"
          >
            <a href="/automation">Zentra Automation</a>
            <a href="/compte/automation">
              Mon option <ArrowRight size={16} />
            </a>
          </nav>
          <header className="automation-hero">
            <p className="automation-eyebrow">
              L’OPTION QUI ALLÈGE VOTRE GESTION
            </p>
            <h1>
              Moins de tri.
              <br />
              <span>Plus de temps pour vous.</span>
            </h1>
            <p>
              Vos opérations trouvent leur catégorie. Vos documents, le bon
              écran. Zentra prépare le travail ; vous gardez le dernier mot.
            </p>
            <div className="automation-actions">
              <a className="automation-button" href="/compte/automation">
                Découvrir mon option <ArrowRight size={17} />
              </a>
              <span>15 CHF / mois par entreprise</span>
            </div>
            <p className="automation-fine">
              En complément de Zentra Gestion. Activation volontaire,
              résiliation à la prochaine échéance.
            </p>
          </header>
          <section
            className="automation-stage"
            aria-label="Exemple de suggestion"
          >
            <div className="automation-stage-copy">
              <p className="automation-eyebrow">
                UNE OPÉRATION. UN CHOIX PLUS SIMPLE.
              </p>
              <h2>Le classement est déjà préparé.</h2>
              <p>
                À l’arrivée d’une opération bancaire, une catégorie peut vous
                être proposée. Vérifiez-la, corrigez-la si besoin et poursuivez.
              </p>
            </div>
            <div className="automation-example">
              <span className="automation-example-caption">
                Exemple illustratif
              </span>
              <div className="automation-example-top">
                <div className="automation-icon">
                  <FileText />
                </div>
                <div>
                  <strong>Achat de fournitures</strong>
                  <span>Opération bancaire · CHF</span>
                </div>
                <strong>−240.00</strong>
              </div>
              <div className="automation-example-suggestion">
                <span>Suggestion Zentra</span>
                <strong>
                  Matériel et marchandises <Check size={18} />
                </strong>
              </div>
              <div className="automation-example-bottom">
                <span>Vous pouvez changer ce choix.</span>
                <span>À confirmer</span>
              </div>
            </div>
          </section>
          <section className="automation-benefits">
            <article>
              <FolderOpen />
              <h2>
                Chaque document
                <br />à sa place.
              </h2>
              <p>
                Une facture fournisseur, un reçu ou un relevé bancaire : partez
                du type de document pour retrouver le bon parcours, sans
                déplacer ni supprimer l’original.
              </p>
            </article>
            <article>
              <SlidersHorizontal />
              <h2>
                Vos règles.
                <br />
                Votre contrôle.
              </h2>
              <p>
                Choisissez les fonctions actives et le niveau de confiance.
                Commencez par observer les propositions avant de les afficher
                dans vos tâches quotidiennes.
              </p>
            </article>
          </section>
          <section className="automation-panel automation-price-panel">
            <div>
              <p className="automation-eyebrow">
                UNE OPTION POUR TOUTE L’ENTREPRISE
              </p>
              <h2>Zentra Automation</h2>
              <p>
                Un abonnement d’entreprise. Les accès suivent votre formule
                Zentra Gestion. Aucune clé technique à fournir.
              </p>
              <a href="/automation/conditions">Voir les conditions</a>
            </div>
            <div>
              <div className="automation-price">
                15 CHF <small>/ mois</small>
              </div>
              <a className="automation-button" href="/compte/automation">
                Configurer mon option <ArrowRight size={17} />
              </a>
            </div>
          </section>
          <section className="automation-questions">
            <h2>
              Simple à activer.
              <br />
              Simple à comprendre.
            </h2>
            {[
              [
                'Est-ce obligatoire ?',
                'Non. Vous pouvez choisir l’option lors de la configuration ou plus tard dans votre compte. Refuser l’option ne bloque pas les fonctions habituelles de Zentra Gestion.',
              ],
              [
                'Une suggestion peut-elle modifier ma comptabilité ?',
                'Une catégorie ou un parcours vous est proposé. Les paiements, validations comptables et autres opérations sensibles conservent leurs contrôles et votre confirmation.',
              ],
              [
                'Que se passe-t-il si la connexion est coupée ?',
                'Les suggestions en ligne sont indisponibles. Les fonctions locales et le classement manuel de Zentra restent utilisables.',
              ],
              [
                'Est-ce le même produit que Zentra Support ?',
                'Non. Automation accompagne la gestion de votre entreprise. Zentra Support est un produit indépendant pour le tri et le routage des tickets de votre service client.',
              ],
            ].map(([title, body]) => (
              <details key={title}>
                <summary>{title}</summary>
                <p>{body}</p>
              </details>
            ))}
          </section>
          <section className="automation-referral-teaser">
            <p className="automation-eyebrow">LE BON CONSEIL SE PARTAGE</p>
            <h2>
              Invitez une entreprise.
              <br />
              Économisez à deux.
            </h2>
            <p>
              −50 % sur son premier mois de Zentra Gestion. −25 % sur votre
              prochaine mensualité, après son premier paiement.
            </p>
            <a className="automation-button" href="/compte/automation">
              Mon code de parrainage <ArrowRight size={17} />
            </a>
            <a href="/parrainage/conditions">Voir les conditions</a>
          </section>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
