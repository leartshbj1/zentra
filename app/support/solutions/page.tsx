import { ArrowRight } from 'lucide-react';
import {
  SupportCallToAction,
  SupportMarketingShell,
  SupportPageIntro,
} from '@/components/support/marketing-shell';
import { supportMetadata } from '@/lib/support/marketing';

export const metadata = supportMetadata(
  'Pour les équipes qui répondent aux clients',
  'E-commerce, SaaS et agences : découvrez comment organiser le tri et le routage de vos tickets avec Zentra Support.',
  '/support/solutions',
);

const cases = [
  {
    id: 'ecommerce',
    label: 'E-COMMERCE',
    title: 'Du suivi de commande au remboursement.',
    description:
      'Les demandes commerciales et logistiques arrivent ensemble. Orientez-les dès la réception vers les équipes qui savent y répondre.',
    examples: [
      ['Où en est ma commande ?', 'Livraison', 'Logistique'],
      ['Je souhaite retourner un article.', 'Remboursement', 'Retours'],
      ['Il me manque la facture.', 'Facturation', 'Comptabilité'],
    ],
    note: 'Zentra oriente la demande. Votre équipe vérifie la commande et décide du remboursement.',
  },
  {
    id: 'saas',
    label: 'LOGICIELS & SAAS',
    title: 'Le bon relais entre produit et support.',
    description:
      'Distinguez les incidents, les questions d’utilisation et les sujets de compte. Vos spécialistes reçoivent les demandes qui les concernent.',
    examples: [
      ['L’export échoue à chaque tentative.', 'Bug', 'Support technique'],
      [
        'Comment créer un tableau partagé ?',
        'Question produit',
        'Équipe produit',
      ],
      ['Mon accès est bloqué.', 'Compte', 'Assistance'],
    ],
    note: 'La priorité dépend du contexte. Un ticket peu clair reste à vérifier au lieu de partir vers une équipe au hasard.',
  },
  {
    id: 'agences',
    label: 'AGENCES & SERVICES',
    title: 'Une réception commune. Des interlocuteurs clairs.',
    description:
      'Organisez vos demandes entre administration, assistance technique et équipe client. Les tickets restent dans l’outil que vous utilisez déjà.',
    examples: [
      [
        'Pouvez-vous expliquer cette facture ?',
        'Facturation',
        'Administration',
      ],
      ['Le formulaire du site ne fonctionne plus.', 'Bug', 'Équipe technique'],
      [
        'J’ai besoin de parler à une personne.',
        'Intervention humaine',
        'À vérifier',
      ],
    ],
    note: 'Ces exemples illustrent des règles à configurer selon vos équipes. Ils ne constituent pas une organisation imposée.',
  },
];
export default function SupportSolutions() {
  return (
    <SupportMarketingShell>
      <SupportPageIntro
        eyebrow="CAS D’USAGE"
        title={
          <>
            Votre métier change.
            <br />
            <em>Le besoin de clarté reste.</em>
          </>
        }
        description="Un outil pour les entreprises qui reçoivent des demandes clients, avec des règles adaptées à leur propre organisation."
      />
      {cases.map((item, index) => (
        <section
          id={item.id}
          key={item.id}
          className={`sp-section ${index % 2 === 0 ? 'sp-soft' : ''}`}
        >
          <div className="sp-wrap sp-control">
            <div>
              <p className="sp-kicker">{item.label}</p>
              <h2>{item.title}</h2>
              <p>{item.description}</p>
              <a href="/support/connexions" className="sp-text-link">
                Vérifier mon logiciel <ArrowRight size={16} />
              </a>
            </div>
            <div className="sp-scenario">
              <p className="sp-kicker">EXEMPLES DE DEMANDES</p>
              {item.examples.map(([message, category, team]) => (
                <div key={message}>
                  <p>« {message} »</p>
                  <span>
                    {category} <ArrowRight size={14} aria-hidden="true" />{' '}
                    <strong>{team}</strong>
                  </span>
                </div>
              ))}
              <small>{item.note}</small>
            </div>
          </div>
        </section>
      ))}
      <SupportCallToAction />
    </SupportMarketingShell>
  );
}
