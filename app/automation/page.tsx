import {
  ArrowRight,
  Check,
  FileText,
  FolderOpen,
  Landmark,
  ShoppingBag,
  TableProperties,
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
              Zentra Automation propose un classement pour vos opérations
              bancaires, vous aide à traiter vos documents et prépare les
              choix de vos achats. Directement dans Zentra Gestion : vous
              vérifiez, vous corrigez si besoin, puis vous validez.
            </p>
            <div className="automation-actions">
              <a className="automation-button" href="/compte/automation">
                Configurer Zentra Automation <ArrowRight size={17} />
              </a>
              <span>15 CHF / mois par entreprise</span>
            </div>
            <p className="automation-fine">
              En complément de Zentra Gestion. Activation volontaire,
              résiliation à la prochaine échéance.
            </p>
            <a className="automation-how-link" href="#utilisation">
              Voir comment l’activer dans l’application
            </a>
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
          <section className="automation-use-cases" aria-labelledby="automation-use-cases-title">
            <p className="automation-eyebrow">CONCRÈTEMENT, DANS VOTRE APPLICATION</p>
            <h2 id="automation-use-cases-title">Moins de choix à refaire chaque jour.</h2>
            <div className="automation-use-cases-grid">
              {[
                { icon: Landmark, title: 'Classer les opérations bancaires', text: 'Une catégorie est proposée à partir du libellé de l’opération. Confirmez-la ou choisissez une autre catégorie.', example: 'Achat de fournitures → Matériel et marchandises' },
                { icon: FolderOpen, title: 'Trouver le bon écran pour un document', text: 'Un extrait du document permet de reconnaître son type et de vous orienter vers le parcours adapté.', example: 'Facture fournisseur → Achats' },
                { icon: ShoppingBag, title: 'Préparer une facture fournisseur', text: 'Le fournisseur, le projet et la catégorie peuvent être proposés parmi les données de votre entreprise. Vous complétez et enregistrez le brouillon.', example: 'Vos fournisseurs et vos projets existants' },
                { icon: TableProperties, title: 'Importer un catalogue plus simplement', text: 'Zentra propose les correspondances entre les colonnes de votre fichier CSV ou Excel et votre catalogue. Vérifiez l’aperçu avant l’import.', example: 'Désignation, référence, prix…' },
              ].map(({ icon: Icon, title, text, example }) => (
                <article key={title}>
                  <Icon aria-hidden="true" size={26} />
                  <h3>{title}</h3>
                  <p>{text}</p>
                  <span>{example}</span>
                </article>
              ))}
            </div>
            <p className="automation-control-note">
              Vous gardez la validation des paiements, des factures et des
              écritures comptables. Une suggestion ne déclenche pas ces actions.
            </p>
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
          <section className="automation-start" id="utilisation" aria-labelledby="automation-start-title">
            <div>
              <p className="automation-eyebrow">PRÊT DANS VOS PARAMÈTRES</p>
              <h2 id="automation-start-title">Activez l’option à votre rythme.</h2>
              <p>Sur Windows, Mac, iPhone et Android, ouvrez <strong>Paramètres → Zentra Automation</strong>. L’option est aussi proposée lors de la première configuration.</p>
              <a href="/download">Télécharger la dernière version de Zentra</a>
            </div>
            <ol>
              <li><strong>Ouvrez « Découvrir et activer ».</strong><p>Votre compte s’ouvre dans le navigateur. Sélectionnez l’entreprise concernée ; ouvrir cette page ne déclenche aucun paiement.</p></li>
              <li><strong>Confirmez l’option à 15 CHF/mois.</strong><p>Le titulaire de l’entreprise autorise le traitement des extraits nécessaires et confirme l’abonnement. Un abonnement Zentra Gestion actif est requis.</p></li>
              <li><strong>Choisissez vos suggestions.</strong><p>Activez les fonctions utiles et le mode Suggestions, puis revenez dans l’application. Vous pouvez modifier ces réglages depuis les paramètres.</p></li>
            </ol>
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
