import { ArrowRight, ScanText, Route, ListChecks } from 'lucide-react';
import {
  SupportCallToAction,
  SupportMarketingShell,
  SupportPageIntro,
} from '@/components/support/marketing-shell';
import {
  RoutingExample,
  TimeEstimator,
} from '@/components/support/presentation';
import { supportMetadata } from '@/lib/support/marketing';

export const metadata = supportMetadata(
  'Du ticket à son équipe',
  'Découvrez la classification, la priorité, les règles de routage et la validation humaine de Zentra Support.',
  '/support/fonctionnalites',
);

export default function SupportFeatures() {
  return (
    <SupportMarketingShell>
      <SupportPageIntro
        eyebrow="FONCTIONNALITÉS"
        title={
          <>
            Le tri en moins.
            <br />
            <em>La maîtrise en plus.</em>
          </>
        }
        description="De la réception à l’affectation, un parcours clair. Zentra Support prépare chaque demande pour la bonne équipe, selon vos règles."
      />
      <section className="sp-wrap sp-control sp-section sp-section-first">
        <div>
          <p className="sp-kicker">01 / COMPRENDRE</p>
          <h2>
            Lire entre les lignes.
            <br />
            <span>Mettre de l’ordre.</span>
          </h2>
          <p>
            Le texte et l’objet sont analysés pour proposer une catégorie et une
            priorité. La langue, l’insatisfaction exprimée et une demande
            d’intervention humaine apportent du contexte.
          </p>
          <ul className="sp-check-list">
            <li>
              Sept catégories : bug, facturation, produit, remboursement,
              livraison, compte et autre.
            </li>
            <li>
              Une priorité et un score de confiance visibles pour chaque
              décision.
            </li>
            <li>
              Le texte du ticket est analysé ; les pièces jointes ne le sont
              pas.
            </li>
          </ul>
        </div>
        <RoutingExample />
      </section>
      <section className="sp-section sp-soft">
        <div className="sp-wrap sp-control">
          <div>
            <p className="sp-kicker">02 / ORIENTER</p>
            <h2>
              Vos équipes.
              <br />
              <span>Vos règles du jeu.</span>
            </h2>
            <p>
              Associez chaque catégorie à une équipe, et si nécessaire à une
              personne. Le mode automatique applique les décisions au-dessus du
              seuil configuré, lorsque les autres contrôles sont satisfaits.
            </p>
            <a className="sp-text-link" href="/support/connexions">
              Voir les outils compatibles <ArrowRight size={16} />
            </a>
          </div>
          <div className="sp-control-card">
            <h3>Exemple de règle de routage</h3>
            <dl>
              <div>
                <dt>Demande</dt>
                <dd>Facturation</dd>
              </div>
              <div>
                <dt>Destination</dt>
                <dd>Comptabilité</dd>
              </div>
              <div>
                <dt>Seuil de confiance</dt>
                <dd>85 %</dd>
              </div>
            </dl>
            <div className="sp-control-track">
              <span />
            </div>
            <p>
              Catégorie et priorité doivent atteindre le seuil. Une destination
              valide et un abonnement actif sont également nécessaires.
            </p>
            <small>
              Le score de confiance n’est pas un taux de réussite garanti.
            </small>
          </div>
        </div>
      </section>
      <section className="sp-section sp-wrap">
        <div className="sp-section-title">
          <p className="sp-kicker">03 / GARDER LA MAIN</p>
          <h2>
            Les exceptions
            <br />
            <span>restent compréhensibles.</span>
          </h2>
        </div>
        <div className="sp-steps">
          <article>
            <div className="sp-step-top">
              <ScanText size={24} />
              <span>À VÉRIFIER</span>
            </div>
            <h3>Une décision à relire</h3>
            <p>
              Corrigez la catégorie, la priorité ou la destination avant
              d’appliquer une proposition incertaine.
            </p>
          </article>
          <article>
            <div className="sp-step-top">
              <Route size={24} />
              <span>À REPRENDRE</span>
            </div>
            <h3>Une erreur visible</h3>
            <p>
              Une connexion interrompue ou un échec d’affectation reste
              identifiable dans votre espace.
            </p>
          </article>
          <article>
            <div className="sp-step-top">
              <ListChecks size={24} />
              <span>HISTORIQUE</span>
            </div>
            <h3>Une action traçable</h3>
            <p>
              Retrouvez les décisions et affectations. Les protections évitent
              de réaffecter aveuglément un ticket déjà pris en charge.
            </p>
          </article>
        </div>
      </section>
      <section className="sp-section sp-dark">
        <div className="sp-wrap sp-time">
          <div>
            <p className="sp-kicker">VOTRE TEMPS COMPTE</p>
            <h2>
              Que représente
              <br />
              le tri aujourd’hui ?
            </h2>
            <p>
              Ajustez les hypothèses à votre activité pour estimer le temps
              consacré au tri manuel.
            </p>
            <p className="sp-time-note">
              Simulation indicative, sans gain garanti. Mesurez les résultats
              sur vos propres tickets.
            </p>
          </div>
          <TimeEstimator />
        </div>
      </section>
      <section className="sp-section sp-wrap sp-faq">
        <div>
          <p className="sp-kicker">BON À SAVOIR</p>
          <h2>
            Un rôle précis.
            <br />
            <span>Des attentes claires.</span>
          </h2>
        </div>
        <div>
          {[
            [
              'Est-ce que Zentra répond aux clients ?',
              'Zentra Support classe et oriente les demandes. Votre équipe conserve les réponses, les remboursements et la résolution des problèmes.',
            ],
            [
              'Le navigateur doit-il rester ouvert ?',
              'Le traitement des tickets reçus par une connexion active fonctionne côté serveur, même lorsque votre espace est fermé.',
            ],
            [
              'Puis-je vérifier avant d’automatiser ?',
              'Oui. Vous pouvez utiliser la validation manuelle pour contrôler les propositions, puis activer le mode automatique dans vos règles de routage.',
            ],
          ].map(([title, text]) => (
            <details key={title}>
              <summary>
                {title}
                <span aria-hidden="true">+</span>
              </summary>
              <p>{text}</p>
            </details>
          ))}
        </div>
      </section>
      <SupportCallToAction />
    </SupportMarketingShell>
  );
}
