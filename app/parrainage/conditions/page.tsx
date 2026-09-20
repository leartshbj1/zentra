import { LegalPage, OperatorContact } from '@/components/legal-page';
export const metadata = {
  title: 'Conditions du parrainage Zentra',
  alternates: { canonical: '/parrainage/conditions' },
};
export default function Page() {
  return (
    <LegalPage
      title="Parrainage entre entreprises"
      versionDate="20 septembre 2026"
      intro="Une nouvelle entreprise découvre Zentra Gestion. Vous profitez chacun d’une remise."
      sections={[
        {
          id: 'organisateur',
          title: '1. Organisateur',
          content: <OperatorContact />,
        },
        {
          id: 'avantages',
          title: '2. Les deux remises',
          content: (
            <>
              <p>
                La nouvelle entreprise cliente saisit le code du parrain avant
                son premier paiement. Elle bénéficie de 50 % sur sa première
                mensualité Zentra Gestion, puis du tarif mensuel habituel de sa
                formule. Après confirmation de ce premier paiement, l’entreprise
                qui l’a parrainée reçoit une remise de 25 % sur sa prochaine
                mensualité Zentra Gestion disponible.
              </p>
              <p>
                Ces remises concernent uniquement Solo, Start et Pro de Zentra
                Gestion. L’option Automation, Zentra Support et les services
                tiers sont exclus. Il n’y a ni rémunération en espèces ni frais
                supplémentaires de parrainage.
              </p>
            </>
          ),
        },
        {
          id: 'eligibilite',
          title: '3. Conditions d’éligibilité',
          content: (
            <>
              <p>
                Le parrain dispose d’un abonnement Gestion actif. Le filleul est
                une nouvelle entreprise cliente, avec un compte distinct qui ne
                possède pas déjà d’accès à une entreprise Zentra. Un seul
                parrainage est accepté par compte et par nouvelle entreprise.
                L’auto-parrainage et les comptes créés artificiellement pour
                obtenir des remises sont exclus.
              </p>
              <p>
                La remise doit être demandée avant le paiement avec un code
                valide ; elle n’est pas appliquée rétroactivement. Le montant
                final, la remise et le renouvellement sont affichés dans Stripe
                avant confirmation de la commande.
              </p>
            </>
          ),
        },
        {
          id: 'attribution',
          title: '4. Attribution et suivi',
          content: (
            <>
              <p>
                Un paiement en attente ou refusé ne déclenche pas la récompense
                du parrain. Une remise s’applique à une seule mensualité et ne
                se cumule pas avec une autre remise sur cette facture. Si
                plusieurs parrainages sont confirmés, leurs récompenses sont
                reportées dans l’ordre sur les mensualités suivantes
                disponibles. Un abonnement résilié ou sans prochaine échéance
                conserve la récompense en attente tant qu’elle n’est pas
                utilisée.
              </p>
              <p>
                Le compte affiche le code, les parrainages confirmés et les
                remises prévues. Les coordonnées et données de gestion de
                l’entreprise invitée ne sont pas communiquées au parrain.
                Contactez info@zentraapp.ch en cas d’erreur ou pour signaler un
                abus.
              </p>
            </>
          ),
        },
        {
          id: 'usage',
          title: '5. Partage du code',
          content: (
            <>
              <p>
                Partagez votre code avec des entreprises qui souhaitent
                découvrir Zentra. N’envoyez pas de messages non sollicités en
                masse et ne présentez pas la remise comme une offre permanente
                ou un remboursement en espèces. L’offre peut évoluer pour les
                nouveaux parrainages ; les remises déjà acquises restent
                honorées selon les présentes conditions.
              </p>
            </>
          ),
        },
      ]}
    />
  );
}
