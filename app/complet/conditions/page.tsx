import { LegalPage, OperatorContact } from '@/components/legal-page';
export const metadata = {
  title: 'Conditions du pack Zentra Complet',
  alternates: { canonical: '/complet/conditions' },
};
export default function Page() {
  return (
    <LegalPage
      title="Conditions du pack Zentra Complet"
      versionDate="23 septembre 2026"
      intro="Gestion, Support et Automation réunis dans un abonnement mensuel, pour une entreprise."
      sections={[
        {
          id: 'service',
          title: '1. Produits réunis',
          content: (
            <>
              <OperatorContact />
              <p>
                Le pack réunit Zentra Gestion, Zentra Support et Zentra
                Automation. Les <a href="/conditions">conditions Gestion</a>,{' '}
                <a href="/support/conditions">conditions Support</a>,{' '}
                <a href="/automation/conditions">conditions Automation</a> et l’
                <a href="/sous-traitance">
                  accord de traitement des données
                </a>{' '}
                s’appliquent à leurs services respectifs. Pour les achats d’un
                pack, les présentes conditions remplacent uniquement les
                dispositions relatives aux prix séparés, à leur facturation et à
                leur activation commerciale.
              </p>
            </>
          ),
        },
        {
          id: 'prix',
          title: '2. Prix et limites',
          content: (
            <>
              <p>
                Solo : 79 CHF par mois, Gestion Solo pour 1 personne et Support
                Starter avec 2 000 analyses. Équipe : 99 CHF par mois, Gestion
                Start pour 3 personnes et Support Équipe avec 5 000 analyses.
                Pro : 169 CHF par mois, Gestion Pro pour 10 personnes et Support
                Business avec 15 000 analyses. Automation est incluse dans
                chaque pack. Le titulaire compte dans la limite des personnes de
                Gestion. Les volumes d’analyses Support se renouvellent à chaque
                période mensuelle payée ; les unités inutilisées ne se reportent
                pas.
              </p>
              <p>
                L’éditeur n’est pas assujetti à la TVA suisse. Aucun dépassement
                n’est facturé automatiquement. Les analyses au-delà du volume
                inclus sont suspendues jusqu’au renouvellement. Les abonnements
                éventuels aux services tiers restent à votre charge. Les
                réductions des packs ne se cumulent pas avec les offres de
                parrainage.
              </p>
            </>
          ),
        },
        {
          id: 'activation',
          title: '3. Activation et entreprise',
          content: (
            <>
              <p>
                Le paiement confirmé ouvre les trois accès pour la même
                entreprise. L’espace d’essai Gestion du titulaire est conservé
                s’il existe. Les connexions et les automatismes doivent ensuite
                être configurés et autorisés dans les réglages. L’achat
                n’autorise pas à lui seul l’exécution d’actions automatiques ni
                l’envoi de données à un service tiers.
              </p>
              <p>
                Le parcours d’achat est destiné aux comptes sans abonnement
                payant existant. Si vous êtes déjà abonné, contactez
                info@zentraapp.ch pour préparer le passage au pack. Aucun
                abonnement existant n’est annulé ou remplacé automatiquement.
              </p>
            </>
          ),
        },
        {
          id: 'renouvellement',
          title: '4. Renouvellement et fin du pack',
          content: (
            <>
              <p>
                Le pack se renouvelle chaque mois au prix convenu. Le titulaire
                peut consulter ses factures, changer son moyen de paiement et
                résilier depuis le portail d’abonnement de son compte. La
                résiliation prend effet à la fin de la période payée et concerne
                les trois accès du pack. Désactiver un automatisme ne résilie
                pas l’abonnement.
              </p>
              <p>
                Une échéance échouée ne prolonge pas la période payée.
                L’expiration ou le remboursement intégral de la période en cours
                retire les accès payants correspondants. Vos données suivent les
                règles de conservation et d’export prévues dans les conditions
                des produits et la politique de confidentialité.
              </p>
            </>
          ),
        },
        {
          id: 'controle',
          title: '5. Vos réglages et vos vérifications',
          content: (
            <p>
              Les traitements dépendent de la disponibilité des connexions, de
              la qualité des documents et des règles activées. Les cas
              incertains demandent une vérification. Automation ne garantit ni
              un classement parfait ni un gain de temps chiffré. Les limites et
              contrôles métier de chaque produit restent applicables.
            </p>
          ),
        },
      ]}
    />
  );
}
