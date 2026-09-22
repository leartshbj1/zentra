import { ArrowRight } from 'lucide-react';
import { SupportPrices } from '@/components/support/billing-panel';
import {
  SupportCallToAction,
  SupportMarketingShell,
  SupportPageIntro,
} from '@/components/support/marketing-shell';
import { supportMetadata } from '@/lib/support/marketing';

export const metadata = supportMetadata(
  'Tarifs — dès 29 CHF par mois',
  'Les abonnements Zentra Support : Starter 29 CHF, Équipe 49 CHF et Business 99 CHF par mois, sans frais par collaborateur.',
  '/support/tarifs',
);

export default function SupportPricing() {
  return (
    <SupportMarketingShell>
      <SupportPageIntro
        eyebrow="TARIFS"
        title={
          <>
            Le volume qui vous convient.
            <br />
            <em>L’équipe entière incluse.</em>
          </>
        }
        description="Un abonnement propre à Zentra Support. Choisissez votre volume d’analyses, sans ajouter de frais pour chaque collaborateur."
      />
      <section className="sp-wrap sp-section sp-section-first">
        <div className="sp-pricing-notice">
          <p>
            <strong>Commencez par vérifier votre connexion.</strong> Le compte
            et la préparation sont gratuits. L’analyse et le routage démarrent
            avec un abonnement payé.
          </p>
          <a href="/support/connexions" className="sp-text-link">
            Vérifier mon logiciel <ArrowRight size={16} />
          </a>
        </div>
        <SupportPrices />
        <p className="sp-caption">
          Prix par espace d’entreprise et par mois, en CHF. L’éditeur n’est pas
          assujetti à la TVA suisse. L’abonnement à votre logiciel de support
          reste séparé.
        </p>
        <a href="/support/conditions" className="sp-text-link">
          Lire les conditions de Zentra Support <ArrowRight size={16} />
        </a>
      </section>
      <section className="sp-section sp-soft">
        <div className="sp-wrap sp-faq">
          <div>
            <p className="sp-kicker">AVANT DE CHOISIR</p>
            <h2>
              Les réponses
              <br />
              <span>aux bonnes questions.</span>
            </h2>
          </div>
          <div>
            {[
              [
                'Qu’est-ce qu’une analyse ?',
                'Une analyse terminée d’un ticket consomme une unité, même si une validation humaine est ensuite nécessaire. Une nouvelle analyse consomme une autre unité. Les erreurs avant résultat et la validation humaine ne consomment pas d’unité.',
              ],
              [
                'Que se passe-t-il à la limite du forfait ?',
                'Le traitement est suspendu, sans dépassement facturé automatiquement. Vos tickets restent dans le logiciel source. Les tickets non reçus pendant cette pause ne sont pas importés rétroactivement de façon automatique.',
              ],
              [
                'Zentra Gestion est-il nécessaire ?',
                'Non. Zentra Support possède son propre espace et son propre abonnement. Vous pouvez l’utiliser sans être client du logiciel de gestion.',
              ],
              [
                'Comment arrêter ou changer de formule ?',
                'Arrêtez le renouvellement dans la gestion de votre abonnement avant la prochaine échéance. L’accès reste disponible jusqu’à la fin de la période payée, dans la limite du volume restant. Pour changer de formule, contactez info@zentraapp.ch avant le renouvellement.',
              ],
              [
                'Puis-je découvrir le produit sans payer ?',
                'La démo est accessible sans compte. Vous pouvez aussi créer votre espace et préparer une connexion gratuitement. L’analyse de vos tickets et leur routage nécessitent un abonnement actif.',
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
        </div>
      </section>
      <SupportCallToAction />
    </SupportMarketingShell>
  );
}
