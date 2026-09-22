import { SupportMarketingHeader } from '@/components/support/marketing-header';
import { SupportMarketingFooter } from '@/components/support/marketing-shell';
import { LegalPage, OperatorContact } from '@/components/legal-page';
import { SUPPORT_PLANS } from '@/lib/support/plans';
export const metadata = {
  title: 'Conditions Zentra Support',
  alternates: { canonical: '/support/conditions' },
};
export default function SupportTerms() {
  return (
    <LegalPage
      header={
        <div className="support-presentation">
          <SupportMarketingHeader />
        </div>
      }
      footer={
        <div className="support-presentation">
          <SupportMarketingFooter />
        </div>
      }
      title="Conditions de Zentra Support"
      versionDate="22 septembre 2026"
      intro="Offre pour les entreprises et indépendants — version du 22 septembre 2026."
      sections={[
        {
          id: 'service',
          title: '1. Prestataire et service',
          content: (
            <>
              <OperatorContact />
              <p>
                Zentra Support est un abonnement distinct du logiciel de gestion
                Zentra. Il permet de recevoir et de traiter manuellement les demandes en équipe. Avec l’option Automation active pour cet espace, il analyse le texte des tickets transmis par un logiciel
                de support connecté ou une boîte Infomaniak, propose une
                catégorie et une priorité et applique les affectations prévues
                lorsque les conditions configurées sont remplies. Les cas
                incertains restent à vérifier. Il ne répond pas aux clients et
                ne procède pas à des remboursements.
              </p>
              <p>
                Pour Infomaniak, les nouveaux messages de la boîte de réception
                sont récupérés périodiquement depuis la date de connexion. Le
                classement se fait dans Zentra Support ; les messages ne sont ni
                déplacés, ni supprimés, ni marqués comme lus chez Infomaniak.
                Avec Automation active et une entreprise Gestion reliée, les justificatifs PDF, PNG et JPEG admissibles sont conservés dans sa boîte fournisseurs et les PDF lisibles sont analysés pour le préremplissage. Une analyse de document compte dans le volume de votre formule. La comptabilisation automatique nécessite son activation explicite et les contrôles de Gestion ; elle ne déclenche aucun paiement. Sans Automation, la réception et le traitement manuel des messages restent disponibles, sans extraction ni transfert automatique vers Gestion. La réception
                automatique vise un intervalle de cinq minutes, sans garantie de
                traitement instantané ; une récupération manuelle est
                disponible.
              </p>
            </>
          ),
        },
        {
          id: 'prix',
          title: '2. Formules et paiement',
          content: (
            <>
              <ul>
                {SUPPORT_PLANS.map((p) => (
                  <li key={p.id}>
                    {p.name} : {p.priceChfCents / 100} CHF par mois pour{' '}
                    un plafond de {p.analyses.toLocaleString('fr-CH')} analyses avec l’option Automation.
                  </li>
                ))}
              </ul>
              <p>
                Le prix s’applique à un espace d’entreprise, équipe incluse sans
                frais par collaborateur. L’éditeur n’est pas assujetti à la TVA
                suisse. Le logiciel de support connecté et ses frais restent à
                la charge du client. Le compte et la préparation des connexions
                sont gratuits. La réception et le traitement manuel nécessitent une période Support payée. Les analyses, extractions et routages automatiques nécessitent en plus Automation, facturée 15 CHF par mois et par espace, partagée par les membres autorisés. Aucun essai payant automatique n’est inclus.
              </p>
              <p>
                Le titulaire habilité choisit une formule, accepte ces
                conditions puis vérifie et confirme la commande dans Stripe.
                L’accès s’active après confirmation du paiement. Les factures et
                le moyen de paiement sont disponibles dans la gestion de
                l’abonnement.
              </p>
            </>
          ),
        },
        {
          id: 'volume',
          title: '3. Volume et renouvellement',
          content: (
            <>
              <p>
                Une analyse IA terminée consomme une unité, même si une
                validation humaine est ensuite requise. Une nouvelle analyse
                d’un ticket modifié ou relancée manuellement consomme une autre
                unité. Les erreurs techniques avant résultat et les validations
                humaines ne consomment pas d’unité. Le volume est partagé par
                l’équipe, renouvelé à chaque période payée et non reportable.
              </p>
              <p>
                Aucun dépassement n’est facturé automatiquement. Lorsque le
                volume est atteint ou la période payée expirée, le traitement
                est suspendu. Les tickets restent dans le logiciel source ; les
                tickets non reçus pendant la suspension via webhook nécessitent
                une reprise par le client. Pour Infomaniak, la récupération
                reprend après réactivation pour les messages toujours présents
                dans la boîte de réception depuis sa connexion.
              </p>
            </>
          ),
        },
        {
          id: 'resiliation',
          title: '4. Résiliation et changement de formule',
          content: (
            <p>
              L’abonnement se renouvelle mensuellement jusqu’à résiliation. Le
              titulaire peut arrêter le renouvellement dans « Gérer mon
              abonnement » avant l’échéance suivante ; l’accès reste disponible
              jusqu’à la fin de la période payée, sous réserve du volume
              restant. Pour changer de formule, contactez info@zentraapp.ch
              avant le renouvellement. La période commencée reste due, sauf
              droit impératif ou accord de remboursement. La résiliation ne
              constitue pas une demande d’effacement des données.
            </p>
          ),
        },
        {
          id: 'connexion',
          title: '5. Connexions et décisions',
          content: (
            <p>
              Le client autorise la lecture des tickets, équipes et agents ainsi
              que la modification des affectations et priorités selon ses
              règles. Il dispose des droits administrateur et des options API
              nécessaires dans son logiciel. Il vérifie les destinations, les
              automatisations existantes et les résultats. L’IA peut se tromper,
              y compris avec une confiance élevée ; aucun taux de réussite,
              délai continu ou gain de temps n’est garanti. Les abonnements
              n’incluent pas de prestation d’intégration sur mesure.
            </p>
          ),
        },
        {
          id: 'donnees',
          title: '6. Données et responsabilité',
          content: (
            <>
              <p>
                Les tickets transmis sont traités côté serveur. Lorsque Automation est active, les extraits nécessaires sont confiés à un prestataire d’analyse IA. Le client informe les
                personnes concernées et transmet uniquement les données
                nécessaires. La{' '}
                <a href="/confidentialite">politique de confidentialité</a> et
                l’<a href="/sous-traitance">annexe de traitement des données</a>{' '}
                décrivent les prestataires et modalités applicables. Les clés
                des connexions sont stockées chiffrées.
              </p>
              <p>
                Les dispositions communes des{' '}
                <a href="/conditions">conditions Zentra</a> relatives aux
                données, à l’assistance, à la maintenance, à la responsabilité
                et au droit applicable s’appliquent. Ces conditions
                particulières prévalent pour l’offre Support en cas de
                différence. Les obligations légales impératives restent
                réservées.
              </p>
            </>
          ),
        },
      ]}
    />
  );
}
