import { LegalPage, OperatorContact } from '@/components/legal-page';
export const metadata = {
  title: 'Conditions Zentra Automation',
  alternates: { canonical: '/automation/conditions' },
};
export default function Page() {
  return (
    <LegalPage
      title="Conditions de Zentra Automation"
      versionDate="22 septembre 2026"
      intro="Option mensuelle destinée aux entreprises utilisant Zentra Gestion."
      sections={[
        {
          id: 'service',
          title: '1. Service',
          content: (
            <>
              <OperatorContact />
              <p>
                Zentra Automation propose des catégories et des parcours à
                partir d’extraits limités d’opérations, de documents, de
                demandes et d’en-têtes d’import. Le résultat peut être corrigé.
                Une suggestion ne vaut ni conseil fiscal, ni validation
                comptable, ni preuve de fraude. Les calculs et contrôles métier
                de Zentra restent prioritaires.
              </p>
              <p>
                L’option ne remplace pas l’assistant local et n’autorise pas
                l’exécution libre d’actions. Les paiements, écritures,
                suppressions et changements d’accès suivent les confirmations et
                permissions habituelles. Les fonctions disponibles dépendent de
                la version installée et de leur activation dans les réglages.
              </p>
            </>
          ),
        },
        {
          id: 'prix',
          title: '2. Prix et activation',
          content: (
            <>
              <p>
                15 CHF par mois et par entreprise, en complément d’un abonnement
                Zentra Gestion actif. Les personnes autorisées suivent les
                limites de cette formule. L’option est propre à l’entreprise choisie et partagée selon les droits de ses membres, sans frais Automation par collaborateur. Elle n’est incluse ni dans Gestion ni dans Support. Pour automatiser Support, son espace doit être relié à cette entreprise et disposer de son propre abonnement Support.
                L’éditeur n’est pas assujetti à la TVA suisse.
              </p>
              <p>
                Le titulaire accepte les présentes conditions, autorise le
                traitement nécessaire, puis vérifie et confirme la commande dans
                Stripe. La sélection de l’option dans la configuration ne
                déclenche aucun prélèvement à elle seule. L’accès payant débute
                après confirmation du paiement. Les réglages peuvent ensuite
                activer ou désactiver les suggestions.
              </p>
            </>
          ),
        },
        {
          id: 'renouvellement',
          title: '3. Renouvellement et résiliation',
          content: (
            <>
              <p>
                L’option se renouvelle mensuellement. Le portail d’abonnement
                permet de consulter les factures, modifier le moyen de paiement
                et résilier pour la prochaine échéance. Désactiver les
                suggestions n’annule pas l’abonnement : utilisez « Gérer mon
                abonnement » pour résilier. La résiliation prend effet à la fin
                de la période payée.
              </p>
              <p>Une échéance échouée ne prolonge pas la période déjà payée. Un impayé confirmé, une expiration ou le remboursement intégral de la période en cours arrête les traitements automatiques. Les réglages et les données sont conservés. Un paiement ultérieur confirmé rétablit l’accès au même espace ; les fonctions manuelles des produits restent soumises à leurs abonnements respectifs.</p>
            </>
          ),
        },
        {
          id: 'donnees',
          title: '4. Données nécessaires',
          content: (
            <>
              <p>
                Le traitement en ligne utilise des extraits limités, des
                catégories et, pour le rapprochement, les noms des fournisseurs
                ou projets de l’entreprise. Zentra masque certains identifiants,
                coordonnées et secrets connus avant l’envoi. Ce filtrage ne
                garantit pas l’anonymisation de tout texte libre : ne
                transmettez que les informations nécessaires et évitez les
                données sensibles non utiles à la tâche.
              </p>
              <p>
                Le prestataire d’analyse est TypeSafe, sous-traitant technique
                de Zentra. Aucun compte ni clé personnelle auprès de ce
                prestataire n’est demandé au client. Les extraits quittent
                l’appareil ; une localisation exclusive en Suisse et une absence
                totale de conservation par les prestataires ne sont pas
                garanties. Les conditions de traitement sont précisées dans la{' '}
                <a href="/confidentialite">politique de confidentialité</a>, l’
                <a href="/sous-traitance">annexe de traitement</a> et les{' '}
                <a
                  href="https://docs.typesafe.ai/legal"
                  target="_blank"
                  rel="noreferrer"
                >
                  documents de TypeSafe
                </a>
                .
              </p>
              <p>
                Le journal conserve les références de l’entreprise et de
                l’utilisateur, le type de suggestion, les choix disponibles, le
                résultat, la confiance, la latence et le choix final. Il ne
                conserve pas le texte complet analysé. Pour exercer les droits
                d’accès ou de suppression, contactez info@zentraapp.ch.
              </p>
            </>
          ),
        },
        {
          id: 'controle',
          title: '5. Contrôle et disponibilité',
          content: (
            <>
              <p>
                Le mode Observation enregistre une proposition pour la comparer
                au choix réel sans la préappliquer. Le mode Suggestions affiche
                les propositions exploitables. Un résultat incertain, une
                absence de connexion ou une panne laisse le parcours manuel
                disponible. Les délais et gains de temps dépendent des données
                et des usages ; aucun résultat chiffré n’est garanti.
              </p>
              <p>
                Les <a href="/conditions">conditions générales de Zentra</a>{' '}
                s’appliquent pour les autres dispositions, dans la mesure où
                elles sont compatibles avec la présente option.
              </p>
            </>
          ),
        },
      ]}
    />
  );
}
